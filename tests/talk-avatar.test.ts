import { describe, expect, it } from "vitest";
import {
  APPEND_EVERY_MS,
  EDGE_MARGIN,
  KEEP_BEHIND,
  MAX_LEAD,
  NO_MEDIA_MS,
  PROBE_MIME,
  SQUINT_SECONDS,
  START_BUFFER,
  SWAP_NO_MEDIA_MS,
  VOICE_ONLY_KEY,
  avatarParam,
  canStart,
  capabilityOf,
  concat,
  dataNote,
  decideAvatar,
  decodeBase64Bytes,
  edgeAction,
  evictRange,
  faceFor,
  nextFace,
  hideRangeFor,
  interruptTarget,
  isInitSegment,
  isRevealed,
  mediaFromMessage,
  mimeFor,
  nextHealth,
  readVoiceOnly,
  rememberVoiceOnly,
  sniffCodecs,
  startHealth,
  takeBatch,
  textFromBinary,
  walkBoxes,
  type Capability,
  type Health,
  type MseWindow,
} from "../src/talk/avatar";
import { parseFrame, socketUrl } from "../src/talk/protocol";
import { endView, initialState, reduce, type TalkState } from "../src/talk/state";

// ---------- a tiny fragmented-MP4 init segment, built by hand ----------

const enc = new TextEncoder();
const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const bytes = (...parts: (Uint8Array | number[])[]): Uint8Array => concat(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
const box = (type: string, ...payload: (Uint8Array | number[])[]): Uint8Array => {
  const body = bytes(...payload);
  return bytes(be32(8 + body.length), enc.encode(type), body);
};
const zeros = (n: number): Uint8Array => new Uint8Array(n);

function track(entry: Uint8Array): Uint8Array {
  const stsd = box("stsd", zeros(4), be32(1), entry);
  return box("trak", box("tkhd", zeros(84)), box("mdia", box("mdhd", zeros(24)), box("minf", box("stbl", stsd))));
}
const avc1 = (profile: number, compat: number, level: number): Uint8Array =>
  box("avc1", zeros(78), box("avcC", [1, profile, compat, level, 0xff, 0xe1, 0, 0]));
const mp4a = (aot: number): Uint8Array =>
  box(
    "mp4a",
    zeros(28),
    box("esds", zeros(4), [0x03, 25, 0, 0, 0], [0x04, 17], zeros(13), [0x05, 2, (aot << 3) | 4, 0x10, 0x06, 1, 2]),
  );

function init(opts: { video?: Uint8Array; audio?: Uint8Array } = {}): Uint8Array {
  const ftyp = box("ftyp", enc.encode("dash"), zeros(4), enc.encode("iso6"));
  const moov = box("moov", box("mvhd", zeros(100)), track(opts.video ?? avc1(0x42, 0xc0, 0x1f)), track(opts.audio ?? mp4a(2)), box("mvex", box("trex", zeros(24))));
  return bytes(ftyp, moov);
}
const fragment = (n = 40): Uint8Array => bytes(box("moof", box("mfhd", zeros(8))), box("mdat", zeros(n)));

describe("reading the init segment", () => {
  it("finds boxes and names an init segment by its ftyp", () => {
    const i = init();
    expect(walkBoxes(i).map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(isInitSegment(i)).toBe(true);
    expect(isInitSegment(fragment())).toBe(false);
    expect(isInitSegment(new Uint8Array(4))).toBe(false);
  });

  it("reads the codec strings out of the init, not from a constant: video and audio, in track order", () => {
    expect(sniffCodecs(init())).toEqual(["avc1.42c01f", "mp4a.40.2"]);
    expect(mimeFor(sniffCodecs(init()))).toBe('video/mp4; codecs="avc1.42c01f,mp4a.40.2"');
    expect(mimeFor(sniffCodecs(init()))).toBe(PROBE_MIME);
  });

  it("follows what the stream declares: another level, another profile, another audio type", () => {
    expect(sniffCodecs(init({ video: avc1(0x42, 0xc0, 0x20) }))[0]).toBe("avc1.42c020");
    expect(sniffCodecs(init({ video: avc1(0x64, 0x00, 0x1f) }))[0]).toBe("avc1.64001f");
    expect(sniffCodecs(init({ audio: mp4a(5) }))[1]).toBe("mp4a.40.5");
  });

  it("an init with no codecs (or no moov) gives nothing to ask the browser about", () => {
    expect(sniffCodecs(box("ftyp", enc.encode("dash"), zeros(4)))).toEqual([]);
    expect(mimeFor([])).toBeNull();
    expect(sniffCodecs(new Uint8Array(0))).toEqual([]);
  });
});

// ---------- the frames ----------

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
/** Google's envelope: pretty-printed, a trailing newline. */
const envelope = (b: Uint8Array): string =>
  JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "video/mp4", data: b64(b) } }] } } }, null, 2) + "\n";

describe("the media inside a message", () => {
  const payload = bytes(init(), fragment(300));

  it("decodes base64 from bytes", () => {
    expect([...decodeBase64Bytes(enc.encode("QUJDRA=="), 0)]).toEqual([65, 66, 67, 68]);
    expect([...decodeBase64Bytes(enc.encode('xxQUJD"rest'), 2)]).toEqual([65, 66, 67]);
    expect(decodeBase64Bytes(enc.encode(""), 0)).toHaveLength(0);
  });

  it("a binary message in the server's pretty-printed layout (the fast path)", () => {
    const wire = enc.encode(envelope(payload));
    const media = mediaFromMessage(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength));
    expect(media && [...media]).toEqual([...payload]);
    expect(mediaFromMessage(wire)).not.toBeNull(); // a typed-array view too
  });

  it("the same shape as a text frame, and in a layout nobody pretty-printed", () => {
    const text = JSON.stringify(JSON.parse(envelope(payload)));
    expect([...(mediaFromMessage(text) ?? [])]).toEqual([...payload]);
    const compact = enc.encode(text);
    expect([...(mediaFromMessage(compact.buffer.slice(0)) ?? [])]).toEqual([...payload]);
  });

  it("anything else is not media: captions, events, tool frames, garbage, her old PCM", () => {
    expect(mediaFromMessage(JSON.stringify({ aida: { type: "ready" } }))).toBeNull();
    expect(mediaFromMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "hello video/mp4" } } }))).toBeNull();
    expect(mediaFromMessage(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } }))).toBeNull();
    expect(mediaFromMessage("not json video/mp4")).toBeNull();
    expect(mediaFromMessage(enc.encode("{}").buffer)).toBeNull();
    expect(mediaFromMessage(42)).toBeNull();
  });

  it("a binary frame that is not media can still be read as text", () => {
    const wire = enc.encode(JSON.stringify({ aida: { type: "ready", avatar: true } }));
    expect(parseFrame(textFromBinary(wire.buffer.slice(0)))).toMatchObject({ kind: "aida", frame: { type: "ready", avatar: true } });
    expect(textFromBinary("already text")).toBeNull();
  });

  it("the video frames never reach the room's state as audio: they carry no PCM", () => {
    expect(parseFrame(JSON.stringify(JSON.parse(envelope(payload))))).toEqual({
      kind: "model",
      content: { audio: [], interrupted: false, turnComplete: false },
    });
  });
});

// ---------- before connecting ----------

const base: Capability = { hasMse: true, supported: true, saveData: false, voiceOnly: false };

describe("what to ask for before connecting", () => {
  it("full quality on a good link, with the codec probe passing", () => {
    expect(decideAvatar(base)).toBe("full");
    expect(decideAvatar({ ...base, effectiveType: "4g", downlink: 10, type: "wifi" })).toBe("full");
  });

  it("no video without Media Source, without the codec, on data saver, or by the person's own choice", () => {
    expect(decideAvatar({ ...base, hasMse: false })).toBe("off");
    expect(decideAvatar({ ...base, supported: false })).toBe("off");
    expect(decideAvatar({ ...base, saveData: true })).toBe("off");
    expect(decideAvatar({ ...base, voiceOnly: true })).toBe("off");
    expect(decideAvatar({ ...base, voiceOnly: true, downlink: 50 })).toBe("off");
  });

  it("the thin stream for a weak link: 2g, 3g, slow-2g, an estimate under 1 Mbit/s, or cellular", () => {
    for (const effectiveType of ["slow-2g", "2g", "3g"]) expect(decideAvatar({ ...base, effectiveType })).toBe("lite");
    expect(decideAvatar({ ...base, downlink: 0.9 })).toBe("lite");
    // Chrome's estimate comes from recent traffic and reads low on a quiet page (1.65 on a good laptop link, seen 17 Oct).
    expect(decideAvatar({ ...base, effectiveType: "4g", downlink: 1.65 })).toBe("full");
    expect(decideAvatar({ ...base, downlink: 6 })).toBe("full");
    expect(decideAvatar({ ...base, type: "cellular" })).toBe("lite");
    expect(decideAvatar({ ...base, effectiveType: "4g", downlink: 0 })).toBe("full"); // 0 means unknown
  });

  it("names the socket parameter, and puts it on the URL only when video is wanted", () => {
    expect(avatarParam("full")).toBe("1");
    expect(avatarParam("lite")).toBe("lite");
    expect(avatarParam("off")).toBeUndefined();
    const loc = { protocol: "https:", host: "example.test" };
    expect(socketUrl("abc", loc, "1")).toBe("wss://example.test/api/talk?id=abc&avatar=1");
    expect(socketUrl("abc", loc, "lite")).toBe("wss://example.test/api/talk?id=abc&avatar=lite");
    expect(socketUrl("abc", loc, avatarParam("off"))).toBe("wss://example.test/api/talk?id=abc");
  });

  it("says what video costs in data, once, and nothing when there is no video", () => {
    expect(dataNote("full")).toMatch(/30 MB a minute/);
    expect(dataNote("lite")).toMatch(/15 MB a minute/);
    expect(dataNote("full")).toMatch(/switch to voice only/i);
    expect(dataNote("off")).toBe("");
  });
});

describe("reading this browser", () => {
  const win = (over: Partial<MseWindow> = {}): MseWindow => ({
    MediaSource: { isTypeSupported: (t) => t === PROBE_MIME },
    navigator: { connection: { downlink: 10, effectiveType: "4g" } },
    ...over,
  });

  it("probes the codec the stream is expected to use", () => {
    expect(capabilityOf(win())).toMatchObject({ hasMse: true, supported: true, saveData: false, voiceOnly: false });
    expect(decideAvatar(capabilityOf(win()))).toBe("full");
  });

  it("no Media Source: off. ManagedMediaSource alone is accepted (untested on a phone)", () => {
    expect(decideAvatar(capabilityOf({ navigator: {} }))).toBe("off");
    const managed = win({ MediaSource: undefined as never, ManagedMediaSource: { isTypeSupported: () => true } });
    expect(capabilityOf(managed)).toMatchObject({ hasMse: true, supported: true });
  });

  it("a probe that throws is a no", () => {
    const w = win({
      MediaSource: {
        isTypeSupported: () => {
          throw new Error("no");
        },
      },
    });
    expect(capabilityOf(w).supported).toBe(false);
  });

  it("remembers 'Continue without video' when it can, and works when it cannot", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readVoiceOnly(storage)).toBe(false);
    rememberVoiceOnly(storage);
    expect(store.get(VOICE_ONLY_KEY)).toBe("1");
    expect(readVoiceOnly(storage)).toBe(true);
    expect(decideAvatar(capabilityOf(win({ localStorage: storage as unknown as Storage })))).toBe("off");
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readVoiceOnly(blocked)).toBe(false);
    expect(() => { rememberVoiceOnly(blocked); }).not.toThrow();
    expect(() => { rememberVoiceOnly(undefined); }).not.toThrow();
    expect(readVoiceOnly(undefined)).toBe(false);
  });
});

// ---------- the append queue ----------

describe("batching what is appended", () => {
  const f = (n: number): Uint8Array => fragment(n);
  const i1 = init();
  const i2 = init({ video: avc1(0x42, 0xc0, 0x1f) });

  it("takes everything queued up to the next init segment", () => {
    const q = [f(1), f(2), f(3)];
    const b = takeBatch(q);
    expect(b.parts).toHaveLength(3);
    expect(b.rest).toHaveLength(0);
    expect(b.startsWithInit).toBe(false);
  });

  it("an init segment starts a batch of its own, with the fragments after it", () => {
    const q = [i1, f(1), f(2)];
    const b = takeBatch(q);
    expect(b.startsWithInit).toBe(true);
    expect(b.parts).toHaveLength(3);
  });

  it("an init segment is never buried inside a batch: the swap's new stream is noted where it begins", () => {
    const q = [f(1), f(2), i2, f(3)];
    const first = takeBatch(q);
    expect(first.parts).toHaveLength(2);
    expect(first.startsWithInit).toBe(false);
    const second = takeBatch(first.rest);
    expect(second.startsWithInit).toBe(true);
    expect(second.parts).toHaveLength(2);
    expect(second.rest).toHaveLength(0);
  });

  it("an empty queue is an empty batch, and concat keeps the bytes in order", () => {
    expect(takeBatch([]).parts).toHaveLength(0);
    expect([...concat([new Uint8Array([1, 2]), new Uint8Array([3])])]).toEqual([1, 2, 3]);
    const one = new Uint8Array([9]);
    expect(concat([one])).toBe(one);
  });

  it("appends every 150 ms: about seven of the 47 fragments a second", () => {
    expect(APPEND_EVERY_MS).toBe(150);
  });
});

// ---------- the live edge ----------

describe("keeping her at the live edge", () => {
  it("does nothing while the playhead is within a second of the end of the buffer", () => {
    expect(edgeAction(10, [{ start: 0, end: 10.5 }])).toEqual({ kind: "none" });
    expect(edgeAction(10, [{ start: 0, end: 11 }])).toEqual({ kind: "none" });
  });

  it("jumps to 0.15 s short of the end when it is more than a second behind", () => {
    expect(edgeAction(10, [{ start: 0, end: 11.4 }])).toEqual({ kind: "seek", to: 11.4 - EDGE_MARGIN });
    expect(MAX_LEAD).toBe(1);
    expect(EDGE_MARGIN).toBe(0.15);
  });

  it("never seeks before the start of what it holds", () => {
    expect(edgeAction(0, [{ start: 0.5, end: 2.5 }])).toEqual({ kind: "seek", to: 0.51 });
    expect(edgeAction(1, [{ start: 0.5, end: 2.5 }])).toEqual({ kind: "seek", to: 2.5 - EDGE_MARGIN });
  });

  it("steps over a hole to the next media, and waits when there is none", () => {
    expect(edgeAction(5, [{ start: 0, end: 4 }, { start: 5.4, end: 6 }])).toEqual({ kind: "seek", to: 5.41 });
    expect(edgeAction(5, [{ start: 0, end: 4 }])).toEqual({ kind: "none" });
    expect(edgeAction(0, [])).toEqual({ kind: "none" });
  });

  it("an interruption jumps to the edge and flushes nothing", () => {
    expect(interruptTarget(3, [{ start: 0, end: 3.8 }])).toBeCloseTo(3.65);
    expect(interruptTarget(3.7, [{ start: 0, end: 3.8 }])).toBeNull(); // already there
    expect(interruptTarget(3, [])).toBeNull();
    // Of several ranges the last is the live one.
    expect(interruptTarget(1, [{ start: 0, end: 2 }, { start: 3, end: 4 }])).toBeCloseTo(3.85);
  });

  it("evicts what is more than ten seconds behind, and only then", () => {
    expect(KEEP_BEHIND).toBe(10);
    expect(evictRange(8, [{ start: 0, end: 9 }])).toBeNull();
    expect(evictRange(25, [{ start: 0, end: 26 }])).toEqual({ start: 0, end: 15 });
    expect(evictRange(25, [{ start: 14.5, end: 26 }])).toBeNull(); // not worth a remove() for half a second
    expect(evictRange(25, [])).toBeNull();
  });

  it("starts playing once half a second is buffered", () => {
    expect(START_BUFFER).toBe(0.5);
    expect(canStart([{ start: 0.085, end: 0.4 }], 0)).toBe(false);
    expect(canStart([{ start: 0.085, end: 0.7 }], 0)).toBe(true);
    expect(canStart([], 0)).toBe(false);
  });
});

describe("what is on show", () => {
  it("hides the first 0.4 s of every stream, behind the drawn portrait", () => {
    expect(SQUINT_SECONDS).toBe(0.4);
    const hidden = [hideRangeFor(0)];
    expect(isRevealed(0.1, hidden, false)).toBe(false);
    expect(isRevealed(0.399, hidden, false)).toBe(false);
    expect(isRevealed(0.4, hidden, false)).toBe(true);
    expect(isRevealed(30, hidden, false)).toBe(true);
  });

  it("hides again after a connection swap, where the new stream begins in presentation time", () => {
    const hidden = [hideRangeFor(0), hideRangeFor(540.2)];
    expect(isRevealed(540.0, hidden, false)).toBe(true);
    expect(isRevealed(540.3, hidden, false)).toBe(false);
    expect(isRevealed(540.7, hidden, false)).toBe(true);
  });

  it("the portrait covers a stall", () => {
    expect(isRevealed(30, [hideRangeFor(0)], true)).toBe(false);
  });
});

// ---------- health: when video gives up ----------

describe("when video fails", () => {
  const live = (now = 0): Health => nextHealth(startHealth(0), { t: "media", now });

  it("waits for media, then is live", () => {
    expect(startHealth(0).phase).toBe("waiting");
    expect(live(100).phase).toBe("live");
  });

  it("no media for 6 s while video was promised is a failure; 5.9 s is not", () => {
    expect(NO_MEDIA_MS).toBe(6000);
    expect(nextHealth(startHealth(0), { t: "tick", now: 5900, reconnecting: false }).phase).toBe("waiting");
    const failed = nextHealth(startHealth(0), { t: "tick", now: 6100, reconnecting: false });
    expect(failed).toMatchObject({ phase: "failed", reason: "no-media" });
  });

  it("each fragment resets the clock", () => {
    let h = startHealth(0);
    for (let t = 1000; t <= 20_000; t += 1000) {
      h = nextHealth(h, { t: "media", now: t });
      h = nextHealth(h, { t: "tick", now: t + 500, reconnecting: false });
    }
    expect(h.phase).toBe("live");
  });

  it("a connection swap is allowed its gap of about 3.7 s, and more, before it counts", () => {
    const h = live(1000);
    expect(nextHealth(h, { t: "tick", now: 1000 + 5000, reconnecting: true }).phase).toBe("live");
    expect(nextHealth(h, { t: "tick", now: 1000 + SWAP_NO_MEDIA_MS - 100, reconnecting: true }).phase).toBe("live");
    expect(nextHealth(h, { t: "tick", now: 1000 + SWAP_NO_MEDIA_MS + 100, reconnecting: true })).toMatchObject({ phase: "failed", reason: "no-media" });
    expect(nextHealth(h, { t: "tick", now: 1000 + 7000, reconnecting: false }).phase).toBe("failed");
  });

  it("media that keeps arriving while the picture never moves is a failure too, never a dead screen", () => {
    const h = live(1000);
    expect(nextHealth(h, { t: "tick", now: 2000, reconnecting: false, sinceProgress: 5000 }).phase).toBe("live");
    expect(nextHealth(h, { t: "tick", now: 2000, reconnecting: false, sinceProgress: 6100 })).toMatchObject({ phase: "failed", reason: "stalled" });
    // A swap's gap is not a stall until it outlasts the swap allowance.
    expect(nextHealth(h, { t: "tick", now: 2000, reconnecting: true, sinceProgress: 6100 }).phase).toBe("live");
    expect(nextHealth(h, { t: "tick", now: 2000, reconnecting: true, sinceProgress: SWAP_NO_MEDIA_MS + 1 })).toMatchObject({ reason: "stalled" });
    // Before any media there is nothing to stall: the no-media rule covers it.
    expect(nextHealth(startHealth(0), { t: "tick", now: 1000, reconnecting: false, sinceProgress: 9000 }).phase).toBe("waiting");
  });

  it("an append that throws twice in a row fails; one that recovers does not", () => {
    let h = live();
    h = nextHealth(h, { t: "append-error" });
    expect(h.phase).toBe("live");
    h = nextHealth(h, { t: "append-ok" });
    h = nextHealth(h, { t: "append-error" });
    expect(h.phase).toBe("live");
    h = nextHealth(h, { t: "append-error" });
    expect(h).toMatchObject({ phase: "failed", reason: "append" });
  });

  it("an unsupported codec and a player error fail at once", () => {
    expect(nextHealth(startHealth(0), { t: "codec-unsupported" })).toMatchObject({ phase: "failed", reason: "codec" });
    expect(nextHealth(live(), { t: "player-error" })).toMatchObject({ phase: "failed", reason: "error" });
  });

  it("a failure is final: nothing brings video back mid-call", () => {
    const failed = nextHealth(live(), { t: "player-error" });
    expect(nextHealth(failed, { t: "media", now: 10 })).toBe(failed);
    expect(nextHealth(failed, { t: "append-ok" })).toBe(failed);
  });
});

// ---------- which face she wears ----------

describe("which face she wears", () => {
  it("Vera's still wherever video is expected, the drawn Aida only for voice only", () => {
    expect(faceFor("full")).toBe("vera");
    expect(faceFor("lite")).toBe("vera");
    expect(faceFor("off")).toBe("drawn");
  });

  it("follows the same decision as the video choice: no Media Source, no codec, data saver, or voice only chosen", () => {
    const face = (c: Partial<Capability>) => faceFor(decideAvatar({ ...base, ...c }));
    expect(face({})).toBe("vera");
    expect(face({ effectiveType: "3g" })).toBe("vera"); // a weak link still gets her still, and the lite stream
    expect(face({ hasMse: false })).toBe("drawn");
    expect(face({ supported: false })).toBe("drawn");
    expect(face({ saveData: true })).toBe("drawn");
    expect(face({ voiceOnly: true })).toBe("drawn");
  });

  it("changes only when the call turns out to be voice only, and never back", () => {
    expect(nextFace("vera", { t: "ready", asked: true, avatar: true })).toBe("vera");
    expect(nextFace("vera", { t: "ready", asked: true, avatar: false })).toBe("drawn");
    expect(nextFace("vera", { t: "ready", asked: false, avatar: false })).toBe("drawn");
    expect(nextFace("vera", { t: "video-stopped" })).toBe("drawn");
    expect(nextFace("drawn", { t: "ready", asked: true, avatar: true })).toBe("drawn");
    expect(nextFace("drawn", { t: "video-stopped" })).toBe("drawn");
  });
});

// ---------- the room's state on video ----------

const ready = (avatar?: boolean) => ({ aida: { type: "ready", targetMinutes: 5, sections: [], ...(avatar === undefined ? {} : { avatar }) } });
function feed(state: TalkState, ...frames: unknown[]): TalkState {
  return frames.reduce<TalkState>((s, f) => {
    const event = parseFrame(JSON.stringify(f));
    return event ? reduce(s, event) : s;
  }, state);
}

describe("ready.avatar is the truth", () => {
  it("reads it from the ready frame; absent or anything but true is a voice call", () => {
    expect(feed(initialState(), ready(true)).avatar).toBe(true);
    expect(feed(initialState(), ready(false)).avatar).toBe(false);
    expect(feed(initialState(), ready()).avatar).toBe(false);
    expect(feed(initialState(), { aida: { type: "ready", targetMinutes: 5, sections: [], avatar: "yes" } }).avatar).toBe(false);
  });
});

describe("video that stops, or is switched off, mid-call", () => {
  const live = () => feed(initialState(), ready(true));

  it("pauses the call (the place is saved) and is shown as its own ending, once the server says paused", () => {
    const s = reduce(live(), { kind: "video-stopped", switching: false });
    expect(s.phase).toBe("ending");
    expect(s.pausing).toBe(true);
    expect(s.videoStopped).toEqual({ switching: false });
    const done = feed(s, { aida: { type: "ended", reason: "paused", minutes: 2, resumable: true, emailed: true } });
    expect(done.phase).toBe("ended");
    expect(endView(done)).toEqual({ kind: "video", switching: false });
  });

  it("switching to voice on purpose is the same, marked so the page carries straight on", () => {
    const s = reduce(live(), { kind: "video-stopped", switching: true });
    const done = feed(s, { aida: { type: "ended", reason: "paused", minutes: 2, resumable: true, emailed: false } });
    expect(endView(done)).toEqual({ kind: "video", switching: true });
  });

  it("if the server never answers the pause, the closed socket still ends it as the video stopping", () => {
    const s = reduce(live(), { kind: "video-stopped", switching: false });
    expect(endView(reduce(s, { kind: "closed", minutes: 2 }))).toEqual({ kind: "video", switching: false });
  });

  it("an ordinary pause is still just a pause", () => {
    const s = reduce(live(), { kind: "pause-pressed" });
    expect(endView(feed(s, { aida: { type: "ended", reason: "paused", minutes: 2, resumable: true, emailed: true } }))).toEqual({ kind: "paused", emailed: true });
  });

  it("only a live call can have its video stop", () => {
    const ended = feed(live(), { aida: { type: "ended", reason: "complete", minutes: 5 } });
    expect(reduce(ended, { kind: "video-stopped", switching: false })).toBe(ended);
    const ending = reduce(live(), { kind: "end-pressed" });
    expect(reduce(ending, { kind: "video-stopped", switching: false })).toBe(ending);
  });
});
