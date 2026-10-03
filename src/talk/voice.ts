// The live line to Aida: the microphone in, her voice out, one socket between.
//
//   mic → AudioContext (16 kHz if the browser allows it) → inline AudioWorklet
//       → Float32 → resample to 16 kHz → 64 ms PCM16 frames → base64 → socket
//   socket → base64 PCM16 at 24 kHz → AudioBuffer → a gapless playback queue
//          → an analyser (her mouth) → speakers
//
// Microphone audio is dropped, not buffered, until the server says `ready`:
// everything before that is the room (a radio, a colleague), and the model
// would answer it as though it were the first thing said. On `interrupted`
// the queue is flushed at once, so she stops when the person talks over her.

import { FFT_SIZE, SMOOTHING, shapeFromSpectrum, type MouthShape } from "./mouth";
import { FrameChunker, INPUT_RATE, OUTPUT_RATE, Resampler, base64ToBytes, encodePcm16, pcm16BytesToFloat, rateOf } from "./pcm";
import { audioMessage, endMessage, parseFrame, socketUrl, textMessage, type ServerFrame } from "./protocol";

// A Blob-URL module keeps the capture graph in this one file: no second
// asset to cache, and no deprecated ScriptProcessor on the main thread. It
// collects 100 ms before posting, so the page hears from it 10 times a
// second instead of once per 128-sample render quantum (375 times at 48 kHz):
// on a weak laptop the main thread has better things to do.
/**
 * The capture worklet ships as its own file (public/talk/capture-worklet.js), not a Blob URL: the
 * site's Content-Security-Policy allows scripts from 'self' only, and a blob: module would be refused.
 */
const CAPTURE_URL = "/talk/capture-worklet.js";

export type MicProblem = "insecure" | "unsupported" | "denied" | "missing" | "failed";

export class MicError extends Error {
  constructor(readonly problem: MicProblem) {
    super(problem);
  }
}

export interface VoiceHandlers {
  onFrame: (frame: ServerFrame) => void;
  onClose: (code: number) => void;
  onSpeaking?: (speaking: boolean) => void;
}

function newContext(rate: number): AudioContext {
  try {
    return new AudioContext({ sampleRate: rate });
  } catch {
    return new AudioContext(); // a rate is a request, not a promise; resample instead
  }
}

export class Voice {
  /** Low power: no analyser (no moving mouth to feed), her voice goes straight to the speakers. */
  constructor(private readonly lite = false) {}

  private input: AudioContext | null = null;
  private output: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private freq: Float32Array<ArrayBuffer> | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private resampler: Resampler | null = null;
  private readonly chunker = new FrameChunker();
  private socket: WebSocket | null = null;
  private handlers: VoiceHandlers | null = null;
  private streaming = false;
  /** Her queued chunks and when each ends; no `ended` event per chunk, so no message per chunk either. */
  private playing: { node: AudioBufferSourceNode; end: number }[] = [];
  private nextAt = 0;
  private speaking = false;
  private quietTimer = 0;
  /** Smoothed microphone loudness, 0..1, for the level meter. */
  micLevel = 0;
  /** Told the new level 10 times a second while the microphone is open. */
  onMicLevel: ((level: number) => void) | null = null;

  /**
   * Make both audio contexts inside the click that started the interview:
   * a browser (Safari above all) lets a context play only if it was created
   * or resumed during a user gesture. Safe to call again on any later tap.
   */
  wake(): void {
    this.output ??= newContext(OUTPUT_RATE);
    if (!this.lite && !this.analyser) {
      const analyser = this.output.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      analyser.connect(this.output.destination);
      this.analyser = analyser;
      this.wave = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.freq = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));
    }
    this.input ??= newContext(INPUT_RATE);
    for (const ctx of [this.output, this.input]) {
      if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
    }
  }

  get hasMic(): boolean {
    return this.stream !== null;
  }

  /** Ask for the microphone and start capturing (sending waits for `ready`). */
  async openMic(): Promise<void> {
    if (!window.isSecureContext) throw new MicError("insecure");
    // Outside a secure context `navigator.mediaDevices` is missing altogether, whatever the types say.
    if (!("mediaDevices" in navigator) || typeof AudioWorkletNode === "undefined") {
      throw new MicError("unsupported");
    }
    this.wake();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Not optional: without echo cancellation she hears herself and
          // answers; without noise suppression a busy room is a second speaker.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("denied");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicError("missing");
      throw new MicError("failed");
    }
    try {
      await this.attach();
    } catch {
      this.stopMic();
      throw new MicError("failed");
    }
  }

  private async attach(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    let ctx = this.input ?? newContext(INPUT_RATE);
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Firefox will not connect a 48 kHz microphone to a 16 kHz context.
      // Run the context at the device's own rate and resample in here.
      void ctx.close().catch(() => undefined);
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
    }
    this.input = ctx;
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    await ctx.audioWorklet.addModule(CAPTURE_URL);
    const node = new AudioWorkletNode(ctx, "aida-capture");
    node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; level: number }>) => {
      this.capture(event.data.samples, event.data.level);
    };
    source.connect(node); // never to the speakers: that is a feedback loop
    this.source = source;
    this.node = node;
    this.resampler = new Resampler(ctx.sampleRate, INPUT_RATE);
  }

  private capture(raw: Float32Array, loudness: number): void {
    this.micLevel += (Math.min(1, loudness * 5) - this.micLevel) * 0.5;
    this.onMicLevel?.(this.micLevel);
    if (!this.streaming || !this.resampler) return;
    for (const frame of this.chunker.push(this.resampler.push(raw))) this.send(audioMessage(encodePcm16(frame)));
  }

  setMuted(muted: boolean): void {
    // A muted track sends silence, so the line stays open and her turn-taking still works.
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.micLevel = 0;
  }

  /** Release the microphone (the browser's recording light goes out). */
  stopMic(): void {
    this.streaming = false;
    this.chunker.clear();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.micLevel = 0;
  }

  // ---------- the socket ----------

  connect(id: string, handlers: VoiceHandlers): void {
    this.handlers = handlers;
    const socket = new WebSocket(socketUrl(id, location));
    this.socket = socket;
    socket.onmessage = (event: MessageEvent<unknown>) => {
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (frame.kind === "aida" && frame.frame.type === "ready") {
        // Only now does anything the microphone hears get sent.
        this.chunker.clear();
        this.streaming = true;
      }
      if (frame.kind === "model") {
        if (frame.content.interrupted) this.flush();
        for (const part of frame.content.audio) this.enqueue(part.data, rateOf(part.mimeType));
      }
      handlers.onFrame(frame);
    };
    socket.onclose = (event) => {
      this.streaming = false;
      if (this.socket === socket) this.socket = null;
      handlers.onClose(event.code);
    };
  }

  private send(message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
  }

  sendText(text: string): void {
    this.send(textMessage(text));
  }

  /** The person pressed End: tell the server, and stop listening at once. */
  end(): void {
    this.send(endMessage());
    this.stopMic();
  }

  // ---------- her voice ----------

  private setSpeaking(on: boolean): void {
    if (this.speaking === on) return;
    this.speaking = on;
    this.handlers?.onSpeaking?.(on);
  }

  private enqueue(base64: string, rate: number): void {
    const ctx = this.output;
    if (!ctx) return;
    const bytes = base64ToBytes(base64);
    if (bytes.length < 2) return;
    // Each chunk declares its own rate; the browser resamples to the context's.
    const buffer = ctx.createBuffer(1, bytes.length >> 1, rate);
    pcm16BytesToFloat(bytes, buffer.getChannelData(0));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.analyser ?? ctx.destination);
    const now = ctx.currentTime;
    this.playing = this.playing.filter((p) => p.end > now);
    // A new burst starts 100 ms ahead, so chunks that arrive a little late
    // still join the queue without a gap (a gap is a click, and a stutter).
    const at = this.playing.length ? Math.max(this.nextAt, now) : now + 0.1;
    this.nextAt = at + buffer.duration;
    this.playing.push({ node, end: this.nextAt });
    node.start(at);
    this.setSpeaking(true);
    this.quietAfter(this.nextAt - now);
  }

  /** She has stopped once the queue has played out and nothing more arrived for a moment. */
  private quietAfter(seconds: number): void {
    window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(
      () => {
        const left = this.queued;
        if (left > 0.01) this.quietAfter(left);
        else {
          this.playing = [];
          this.setSpeaking(false);
        }
      },
      seconds * 1000 + 300,
    );
  }

  /** Silence everything queued: she was interrupted. */
  flush(): void {
    for (const { node } of this.playing) {
      try {
        node.stop();
      } catch {
        // already finished
      }
    }
    this.playing = [];
    if (this.output) this.nextAt = this.output.currentTime;
    window.clearTimeout(this.quietTimer);
    this.setSpeaking(false);
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Seconds of her voice still queued. */
  get queued(): number {
    return this.output ? Math.max(0, this.nextAt - this.output.currentTime) : 0;
  }

  /** Her mouth right now, written into `out`. Closed when she is silent. */
  readMouth(out: MouthShape): MouthShape {
    if (!this.analyser || !this.wave || !this.freq || !this.output || this.queued <= 0) {
      out.open = 0;
      out.spread = 0.5;
      return out;
    }
    this.analyser.getFloatTimeDomainData(this.wave);
    this.analyser.getFloatFrequencyData(this.freq);
    return shapeFromSpectrum(this.freq, this.wave, this.output.sampleRate, out);
  }

  /** Close everything: socket, microphone, both contexts. */
  close(): void {
    this.flush();
    this.stopMic();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.onclose = null;
      socket.close(1000, "done");
    }
    for (const ctx of [this.input, this.output]) void ctx?.close().catch(() => undefined);
    this.input = null;
    this.output = null;
    this.analyser = null;
  }
}
