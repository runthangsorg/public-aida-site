// The live line (voice.ts) against stand-ins for the browser's audio, microphone and socket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Voice } from "../src/talk/voice";

class FakeTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
}

const contexts: FakeContext[] = [];

class FakeContext {
  readonly sampleRate: number;
  state = "running";
  currentTime = 0;
  readonly destination = {};
  readonly buffers: unknown[] = [];
  readonly audioWorklet = { addModule: () => Promise.resolve() };
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000;
    contexts.push(this);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createBuffer(_channels: number, length: number, rate: number): { duration: number; getChannelData(): Float32Array } {
    const buffer = { duration: length / rate, getChannelData: () => new Float32Array(length) };
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): { buffer: unknown; connect(): void; start(): void; stop(): void } {
    return { buffer: null, connect: () => undefined, start: () => undefined, stop: () => undefined };
  }
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  binaryType = "";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {
    // nothing listens
  }
  close(): void {
    this.readyState = 3;
  }
}

/** Each microphone question the page asks, waiting for the person's answer. */
let asks: ((stream: FakeStream) => void)[] = [];

beforeEach(() => {
  asks = [];
  contexts.length = 0;
  vi.stubGlobal("window", { isSecureContext: true, setTimeout, clearTimeout });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => new Promise<FakeStream>((resolve) => asks.push(resolve)) },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = { onmessage: null };
      disconnect(): void {
        // nothing connected
      }
    },
  );
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "aida.example", hostname: "aida.example" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the microphone", () => {
  it("two questions answered by one Allow leave one live track, which mute and close both reach", async () => {
    // Review round 3 (public-site-05): Try again while the first question was open, then one Allow answering both,
    // left the first stream recording where mute and the end of the call could not reach it.
    const voice = new Voice();
    const first = voice.openMic();
    const second = voice.openMic();
    await settle();
    const [s1, s2] = [new FakeStream(), new FakeStream()];
    asks[0]?.(s1);
    asks[1]?.(s2);
    await expect(first).rejects.toThrow("superseded");
    await second;
    expect(voice.hasMic).toBe(true);
    expect([s1, s2].map((s) => s.track.readyState)).toEqual(["ended", "live"]);
    voice.setMuted(true);
    expect(s2.track.enabled).toBe(false);
    voice.close();
    expect([s1, s2].map((s) => s.track.readyState)).toEqual(["ended", "ended"]);
  });

  it("a microphone released while its question is open is not left on when the answer comes", async () => {
    const voice = new Voice();
    const ask = voice.openMic();
    await settle();
    voice.stopMic();
    const stream = new FakeStream();
    asks[0]?.(stream);
    await expect(ask).rejects.toThrow("superseded");
    expect(stream.track.readyState).toBe("ended");
    expect(voice.hasMic).toBe(false);
  });
});
