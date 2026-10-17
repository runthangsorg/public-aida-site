// Vera on video: her muxed fragmented MP4 (H.264 + AAC), played through Media Source
// Extensions at the live edge. What is known of the stream, and why the player is shaped
// like this, is in the aida repository's docs/research/2026-10-17/avatar-lab/INTEGRATION.md
// (measured: one frame per fragment, ~47 fragments a second, a fresh init segment and a
// timeline restarting at 0 after every connection swap, a squint in the first frame).
//
// Everything that can be a pure function is one (box walking and the codec sniff, frame
// decoding, the capability decision, the append batching, the live-edge maths, the health
// machine) and is unit-tested in Node. `AvatarPlayer` is the thin DOM class on top; it is
// exercised in real Chrome (H.264 needs the system browser), see scripts/avatar-check.mjs.
//
// Nothing here logs, stores or sends anything.

// ---------- tuning, from the spec ----------

/** The very first frame of every stream is a squint: it is never shown. */
export const SQUINT_SECONDS = 0.4;
/** Start playing once this much is buffered. */
export const START_BUFFER = 0.5;
/** More than this ahead of the playhead and we jump forward to the live edge. */
export const MAX_LEAD = 1.0;
/** ...landing this far behind the end of the buffer. */
export const EDGE_MARGIN = 0.15;
/** Media behind the playhead older than this is evicted. */
export const KEEP_BEHIND = 10;
/** Queued fragments are appended together this often. */
export const APPEND_EVERY_MS = 150;
/** No media for this long while video was promised: the video has failed. */
export const NO_MEDIA_MS = 6000;
/** ...but a connection swap leaves a gap of about 3.7 s, so allow more while one is under way. */
export const SWAP_NO_MEDIA_MS = 12_000;

/** The probe string used before connecting; the real one is read from the init segment. */
export const PROBE_MIME = 'video/mp4; codecs="avc1.42c01f,mp4a.40.2"';

// ---------- ISO BMFF: boxes and the codec sniff ----------

export interface Box {
  type: string;
  offset: number;
  size: number;
  header: number;
}

const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
const printable = (b: Uint8Array, o: number): boolean => {
  for (let i = 0; i < 4; i++) {
    const c = b[o + i] ?? 0;
    if (c < 0x20 || c >= 0x7f) return false;
  }
  return true;
};
const u32 = (b: Uint8Array, o: number): number => (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;

/** The boxes laid end to end in `buf[start, end)`. Stops at anything that is not a box. */
export function walkBoxes(buf: Uint8Array, start = 0, end = buf.length): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end && printable(buf, o + 4)) {
    let size = u32(buf, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = u32(buf, o + 8) * 2 ** 32 + u32(buf, o + 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header) break;
    out.push({ type: fourcc(buf, o + 4), offset: o, size, header });
    o += size;
  }
  return out;
}

const childOf = (buf: Uint8Array, box: Box, type: string, skip = 0): Box | undefined =>
  walkBoxes(buf, box.offset + box.header + skip, Math.min(box.offset + box.size, buf.length)).find((b) => b.type === type);

/** A fragment whose bytes 4 to 8 are `ftyp` is a new initialisation segment. */
export function isInitSegment(b: Uint8Array): boolean {
  return b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
}

/** The AudioSpecificConfig's first byte inside an `esds` payload (after its 4 version/flag bytes), or null. */
function audioObjectType(e: Uint8Array): number | null {
  let i = 0;
  while (i < e.length) {
    const tag = e[i++] ?? 0;
    let len = 0;
    for (let k = 0; k < 4; k++) {
      const byte = e[i++] ?? 0;
      len = (len << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (tag === 0x03) i += 3;
    else if (tag === 0x04) i += 13;
    else if (tag === 0x05) return (e[i] ?? 0) >> 3;
    else i += len;
  }
  return null;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/** The codec strings an init segment declares, in track order: `avc1.42c01f`, `mp4a.40.2`. */
export function sniffCodecs(init: Uint8Array): string[] {
  const moov = walkBoxes(init).find((b) => b.type === 'moov');
  if (!moov) return [];
  const codecs: string[] = [];
  for (const trak of walkBoxes(init, moov.offset + moov.header, moov.offset + moov.size).filter((b) => b.type === 'trak')) {
    const mdia = childOf(init, trak, 'mdia');
    const minf = mdia && childOf(init, mdia, 'minf');
    const stbl = minf && childOf(init, minf, 'stbl');
    const stsd = stbl && childOf(init, stbl, 'stsd');
    if (!stsd) continue;
    // stsd: 4 version/flags + 4 entry count, then the sample entries.
    const entry = walkBoxes(init, stsd.offset + stsd.header + 8, stsd.offset + stsd.size)[0];
    if (!entry) continue;
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      // A visual sample entry carries 78 bytes of fields before its child boxes.
      const avcC = childOf(init, entry, 'avcC', 78);
      if (avcC) {
        const p = avcC.offset + avcC.header;
        codecs.push(`${entry.type}.${hex2(init[p + 1] ?? 0)}${hex2(init[p + 2] ?? 0)}${hex2(init[p + 3] ?? 0)}`);
      }
    } else if (entry.type === 'mp4a') {
      // An audio sample entry carries 28 bytes before its child boxes.
      const esds = childOf(init, entry, 'esds', 28);
      const aot = esds ? audioObjectType(init.subarray(esds.offset + esds.header + 4, esds.offset + esds.size)) : null;
      codecs.push(`mp4a.40.${aot ?? 2}`);
    }
  }
  return codecs;
}

/** The MIME type for `addSourceBuffer` / `isTypeSupported`, or null when the init declares no codec. */
export function mimeFor(codecs: string[]): string | null {
  return codecs.length ? `video/mp4; codecs="${codecs.join(',')}"` : null;
}

// ---------- the frames: base64 media inside JSON ----------

const B64 = (() => {
  const t = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  t[0x2d] = 62; // '-' and '_': url-safe
  t[0x5f] = 63;
  return t;
})();

/** Base64 from the bytes of an ASCII range, up to the first character that is not base64 (a closing quote). */
export function decodeBase64Bytes(src: Uint8Array, start: number): Uint8Array {
  let end = start;
  while (end < src.length && (B64[src[end] ?? 0] ?? -1) >= 0) end++;
  const n = end - start;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = start; i < end; i++) {
    acc = (acc << 6) | (B64[src[i] ?? 0] ?? 0);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const latin1 = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
};

const HEAD_BYTES = 480;
const DATA_START = /"data"\s*:\s*"/;

function asBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** The media inside a JSON frame already parsed, or null if it carries none. */
function mediaFromParsed(frame: unknown): Uint8Array | null {
  const parts = (frame as { serverContent?: { modelTurn?: { parts?: unknown } } } | null)?.serverContent?.modelTurn?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts as { inlineData?: { mimeType?: unknown; data?: unknown } }[]) {
    const inline = part.inlineData;
    if (typeof inline?.mimeType === 'string' && inline.mimeType.startsWith('video/mp4') && typeof inline.data === 'string') {
      return decodeBase64Bytes(new TextEncoder().encode(inline.data), 0);
    }
  }
  return null;
}

/**
 * One fragment of her video from a socket message, or null when the message is something else (a
 * caption, a tool call, an event). The server sends fragments as binary messages whose bytes are
 * pretty-printed JSON; the fast path reads the base64 straight out of the bytes without making a string
 * the size of the frame. Any other layout, and a fragment that arrives as a text frame, takes the
 * ordinary JSON path.
 */
export function mediaFromMessage(data: unknown): Uint8Array | null {
  if (typeof data === 'string') {
    if (!data.includes('video/mp4')) return null;
    try {
      return mediaFromParsed(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;
  const bytes = asBytes(data);
  const head = latin1(bytes, 0, HEAD_BYTES);
  if (!head.includes('video/mp4')) return null;
  const m = DATA_START.exec(head);
  if (m) {
    const media = decodeBase64Bytes(bytes, m.index + m[0].length);
    if (media.length > 0) return media;
  }
  try {
    return mediaFromParsed(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** A binary message that was not media, as text: the server sends a frame it does not recognise this way. */
export function textFromBinary(data: unknown): string | null {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;
  return new TextDecoder().decode(asBytes(data));
}

// ---------- before connecting: what to ask for ----------

export type AvatarAsk = 'full' | 'lite' | 'off';

export interface Capability {
  /** MediaSource (or ManagedMediaSource) exists. */
  hasMse: boolean;
  /** isTypeSupported(PROBE_MIME). */
  supported: boolean;
  saveData: boolean;
  effectiveType?: string | undefined;
  downlink?: number | undefined;
  type?: string | undefined;
  /** The person chose "Continue without video" earlier. */
  voiceOnly: boolean;
}

/** Full quality, the lite stream for a weak link, or none (the voice call that always works). */
export function decideAvatar(c: Capability): AvatarAsk {
  if (c.voiceOnly || !c.hasMse || !c.supported || c.saveData) return 'off';
  const slow = c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
  const thin = typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 6;
  if (slow || thin || c.type === 'cellular') return 'lite';
  return 'full';
}

/** The socket URL's `avatar` parameter for a decision. */
export function avatarParam(ask: AvatarAsk): '1' | 'lite' | undefined {
  return ask === 'full' ? '1' : ask === 'lite' ? 'lite' : undefined;
}

/** What each choice costs a person, said once and plainly. */
export function dataNote(ask: AvatarAsk): string {
  if (ask === 'off') return '';
  const mb = ask === 'lite' ? 15 : 60;
  return `Video uses a lot of data (about ${mb} MB a minute). You can switch to voice only at any time.`;
}

interface NavigatorLike {
  connection?: { saveData?: boolean; effectiveType?: string; downlink?: number; type?: string };
}
export interface MseWindow {
  MediaSource?: { isTypeSupported(t: string): boolean };
  ManagedMediaSource?: { isTypeSupported(t: string): boolean };
  navigator: NavigatorLike;
  localStorage?: Storage;
}

export const VOICE_ONLY_KEY = 'aida.talk.voice-only';

/** The remembered "Continue without video", if the browser lets the page remember anything. */
export function readVoiceOnly(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(VOICE_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberVoiceOnly(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(VOICE_ONLY_KEY, '1');
  } catch {
    // private window, blocked storage: the choice lasts until the page closes
  }
}

/** The decision for this browser, read from the page. */
export function capabilityOf(win: MseWindow): Capability {
  const mse = win.MediaSource ?? win.ManagedMediaSource;
  const supported = ((): boolean => {
    try {
      return mse?.isTypeSupported(PROBE_MIME) ?? false;
    } catch {
      return false;
    }
  })();
  let stored: Storage | undefined;
  try {
    stored = win.localStorage;
  } catch {
    stored = undefined;
  }
  const c = win.navigator.connection;
  return {
    hasMse: mse !== undefined,
    supported,
    saveData: c?.saveData === true,
    effectiveType: c?.effectiveType,
    downlink: c?.downlink,
    type: c?.type,
    voiceOnly: readVoiceOnly(stored),
  };
}

// ---------- the append queue ----------

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] ?? new Uint8Array(0);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The next thing to append: whole fragments up to (not across) the next init segment, or an init segment
 * with the fragments that follow it. An init is never buried in the middle of a batch, so the player can
 * note where the new stream starts.
 */
export function takeBatch(queue: Uint8Array[]): { parts: Uint8Array[]; rest: Uint8Array[]; startsWithInit: boolean } {
  const first = queue[0];
  if (!first) return { parts: [], rest: [], startsWithInit: false };
  const startsWithInit = isInitSegment(first);
  let n = 1;
  while (n < queue.length && !isInitSegment(queue[n] ?? new Uint8Array(0))) n++;
  return { parts: queue.slice(0, n), rest: queue.slice(n), startsWithInit };
}

// ---------- the live edge ----------

export interface Range {
  start: number;
  end: number;
}

const TOLERANCE = 0.05;

export const rangeAt = (ranges: Range[], t: number): Range | undefined =>
  ranges.find((r) => t >= r.start - TOLERANCE && t <= r.end + TOLERANCE);

export type EdgeAction = { kind: 'none' } | { kind: 'seek'; to: number };

/**
 * Keep her at the live edge: if the playhead is more than a second behind the end of what is buffered,
 * jump to just short of the end; if it fell in a hole, step over it to the next media.
 */
export function edgeAction(currentTime: number, ranges: Range[]): EdgeAction {
  const here = rangeAt(ranges, currentTime);
  if (here) {
    return here.end - currentTime > MAX_LEAD ? { kind: 'seek', to: Math.max(here.start, here.end - EDGE_MARGIN) } : { kind: 'none' };
  }
  const next = ranges.find((r) => r.start > currentTime);
  return next ? { kind: 'seek', to: next.start + 0.01 } : { kind: 'none' };
}

/** She was interrupted: skip what the browser still holds of the answer she was giving. Never flush the buffer. */
export function interruptTarget(currentTime: number, ranges: Range[]): number | null {
  const last = ranges[ranges.length - 1];
  if (!last) return null;
  const to = last.end - EDGE_MARGIN;
  return to > currentTime ? to : null;
}

/** The span to evict (media more than 10 s behind the playhead), or null. */
export function evictRange(currentTime: number, ranges: Range[]): Range | null {
  const first = ranges[0];
  if (!first) return null;
  const to = currentTime - KEEP_BEHIND;
  return to > first.start + 1 ? { start: first.start, end: Math.min(to, first.end) } : null;
}

/** Enough buffered, from the playhead's own range, to start playing. */
export function canStart(ranges: Range[], currentTime: number): boolean {
  const r = rangeAt(ranges, currentTime) ?? ranges[0];
  return r !== undefined && r.end - Math.max(r.start, currentTime) >= START_BUFFER;
}

// ---------- what is on show ----------

/**
 * The squint hides: the first 0.4 s after every new stream starts (the very start, and after each
 * connection swap) are kept behind the drawn portrait while the sound carries on.
 */
export function hideRangeFor(boundary: number): Range {
  return { start: boundary, end: boundary + SQUINT_SECONDS };
}

export function isRevealed(currentTime: number, hidden: Range[], stalled: boolean): boolean {
  if (stalled) return false;
  return !hidden.some((r) => currentTime >= r.start - 0.001 && currentTime < r.end);
}

// ---------- health: when does video give up? ----------

export type FailReason = 'codec' | 'append' | 'error' | 'no-media';

export interface Health {
  phase: 'waiting' | 'live' | 'failed';
  lastMediaAt: number;
  appendErrors: number;
  reason?: FailReason;
}

export type HealthEvent =
  | { t: 'media'; now: number }
  | { t: 'append-ok' }
  | { t: 'append-error' }
  | { t: 'codec-unsupported' }
  | { t: 'player-error' }
  | { t: 'tick'; now: number; reconnecting: boolean };

export const startHealth = (now: number): Health => ({ phase: 'waiting', lastMediaAt: now, appendErrors: 0 });

/** A failure is final: the call goes on without video. */
export function nextHealth(h: Health, e: HealthEvent): Health {
  if (h.phase === 'failed') return h;
  switch (e.t) {
    case 'media':
      return { ...h, phase: 'live', lastMediaAt: e.now };
    case 'append-ok':
      return h.appendErrors ? { ...h, appendErrors: 0 } : h;
    case 'append-error':
      return h.appendErrors + 1 >= 2 ? { ...h, phase: 'failed', appendErrors: 2, reason: 'append' } : { ...h, appendErrors: h.appendErrors + 1 };
    case 'codec-unsupported':
      return { ...h, phase: 'failed', reason: 'codec' };
    case 'player-error':
      return { ...h, phase: 'failed', reason: 'error' };
    case 'tick':
      return e.now - h.lastMediaAt > (e.reconnecting ? SWAP_NO_MEDIA_MS : NO_MEDIA_MS) ? { ...h, phase: 'failed', reason: 'no-media' } : h;
  }
}

// ---------- the player ----------

export interface PlayerHooks {
  /** Video has failed for this reason; the player has already stopped itself. */
  onFail(reason: FailReason): void;
  /** The video should be on show (true) or the drawn portrait should (false). */
  onVisible(visible: boolean): void;
  /** The browser would not play her sound without a tap: it is playing muted. */
  onMuted?(): void;
}

interface MseApi {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
}

const bufferedRanges = (tr: TimeRanges): Range[] => {
  const out: Range[] = [];
  for (let i = 0; i < tr.length; i++) out.push({ start: tr.start(i), end: tr.end(i) });
  return out;
};

export class AvatarPlayer {
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly hooks: PlayerHooks,
  ) {}

  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private url: string | null = null;
  private mime: string | null = null;
  private queue: Uint8Array[] = [];
  private hidden: Range[] = [];
  private health: Health = startHealth(0);
  private timer = 0;
  private opened = false;
  private playing = false;
  private visible = false;
  private reconnecting = false;
  private done = true;
  private readonly onVideoError = (): void => {
    this.fail({ t: 'player-error' });
  };

  /** Open the Media Source and hand it to the video element. False when the browser has none. */
  start(): boolean {
    const w = window as unknown as { MediaSource?: MseApi; ManagedMediaSource?: MseApi };
    const Mse = w.MediaSource ?? w.ManagedMediaSource;
    if (!Mse) return false;
    this.stop();
    this.done = false;
    this.health = startHealth(performance.now());
    const ms = new Mse();
    this.ms = ms;
    ms.addEventListener('sourceopen', () => {
      this.opened = true;
      this.pump();
    });
    this.video.addEventListener('error', this.onVideoError);
    if (w.MediaSource) {
      this.url = URL.createObjectURL(ms);
      this.video.src = this.url;
    } else {
      // ManagedMediaSource (iOS 17.1+): handed over as an object, not a URL. Untested.
      this.video.disableRemotePlayback = true;
      this.video.srcObject = ms;
    }
    this.timer = window.setInterval(() => {
      this.tick();
    }, APPEND_EVERY_MS);
    return true;
  }

  /** One fragment, or an init segment, from the socket. */
  push(bytes: Uint8Array): void {
    if (this.done) return;
    this.health = nextHealth(this.health, { t: 'media', now: performance.now() });
    this.queue.push(bytes);
  }

  /** A connection swap is under way (or over): the gap before new media is expected. */
  setReconnecting(on: boolean): void {
    this.reconnecting = on;
  }

  /** She was interrupted: jump to the live edge. The buffer is never flushed (that only leaves a hole). */
  interrupt(): void {
    if (!this.sb) return;
    const to = interruptTarget(this.video.currentTime, bufferedRanges(this.video.buffered));
    if (to !== null) this.video.currentTime = to;
  }

  /** The room was tapped: if her sound was held back, try it again. */
  unmute(): void {
    if (this.done || !this.video.muted) return;
    this.video.muted = false;
    void this.video.play().catch(() => {
      this.video.muted = true;
    });
  }

  get muted(): boolean {
    return this.video.muted;
  }

  /** Apply an event to the health machine; true when it has just given up (and the player has stopped). */
  private fail(e: HealthEvent): boolean {
    if (this.done) return true;
    this.health = nextHealth(this.health, e);
    if (this.health.phase !== 'failed') return false;
    const reason = this.health.reason ?? 'error';
    this.stop();
    this.hooks.onFail(reason);
    return true;
  }

  private tick(): void {
    if (this.done) return;
    if (this.fail({ t: 'tick', now: performance.now(), reconnecting: this.reconnecting })) return;
    this.pump();
    this.maintain();
  }

  private pump(): void {
    const ms = this.ms;
    if (this.done || !ms || !this.opened || ms.readyState !== 'open' || this.sb?.updating) return;
    // Until the first init segment there is nothing to decode: late fragments are dropped.
    while (!this.sb && this.queue.length && !isInitSegment(this.queue[0] ?? new Uint8Array(0))) this.queue.shift();
    if (!this.queue.length) return;
    const batch = takeBatch(this.queue);
    const first = batch.parts[0];
    if (batch.startsWithInit && first) {
      const mime = mimeFor(sniffCodecs(first));
      const w = window as unknown as { MediaSource?: MseApi; ManagedMediaSource?: MseApi };
      const Mse = w.MediaSource ?? w.ManagedMediaSource;
      if (!mime || !Mse?.isTypeSupported(mime)) {
        this.fail({ t: 'codec-unsupported' });
        return;
      }
      try {
        if (!this.sb) {
          const sb = ms.addSourceBuffer(mime);
          sb.mode = 'sequence';
          sb.addEventListener('updateend', () => {
            this.fail({ t: 'append-ok' });
            this.pump();
            this.maintain();
          });
          sb.addEventListener('error', () => {
            this.fail({ t: 'player-error' });
          });
          this.sb = sb;
        } else if (mime !== this.mime) {
          this.sb.changeType(mime);
        }
        this.mime = mime;
      } catch {
        this.fail({ t: 'codec-unsupported' });
        return;
      }
      // Where the new stream starts in presentation time: its first 0.4 s are kept out of sight.
      const ranges = bufferedRanges(this.video.buffered);
      this.hidden.push(hideRangeFor(ranges[ranges.length - 1]?.end ?? 0));
    }
    this.queue = batch.rest;
    const sb = this.sb;
    if (!sb) return;
    try {
      sb.appendBuffer(concat(batch.parts) as Uint8Array<ArrayBuffer>);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        this.queue = [...batch.parts, ...this.queue]; // keep it; make room and try again
        this.evict(true);
      }
      this.fail({ t: 'append-error' });
    }
  }

  private evict(hard = false): void {
    const sb = this.sb;
    if (!sb || sb.updating) return;
    const ranges = bufferedRanges(this.video.buffered);
    const span = hard
      ? ranges[0] && this.video.currentTime - 1 > ranges[0].start
        ? { start: ranges[0].start, end: this.video.currentTime - 1 }
        : null
      : evictRange(this.video.currentTime, ranges);
    if (!span) return;
    try {
      sb.remove(span.start, span.end);
    } catch {
      // a range the buffer no longer holds
    }
  }

  private maintain(): void {
    if (this.done) return;
    const v = this.video;
    const ranges = bufferedRanges(v.buffered);
    if (!this.playing && canStart(ranges, v.currentTime)) {
      this.playing = true;
      void v.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          // Sound needs a tap here; picture and captions do not.
          v.muted = true;
          void v.play().catch(() => undefined);
          this.hooks.onMuted?.();
        }
      });
    }
    const action = edgeAction(v.currentTime, ranges);
    if (this.playing && action.kind === 'seek') v.currentTime = action.to;
    this.evict();
    const stalled = !this.playing || v.readyState < 3;
    const visible = isRevealed(v.currentTime, this.hidden, stalled);
    if (visible !== this.visible) {
      this.visible = visible;
      this.hooks.onVisible(visible);
    }
  }

  /** Close everything: the stream, the object URL, the element. Safe to call twice. */
  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.video.removeEventListener('error', this.onVideoError);
    const ms = this.ms;
    if (ms?.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        // an append in flight: the element is torn down below either way
      }
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.ms = null;
    this.sb = null;
    this.mime = null;
    this.queue = [];
    this.hidden = [];
    this.opened = false;
    this.playing = false;
    this.done = true;
    if (this.visible) {
      this.visible = false;
      this.hooks.onVisible(false);
    }
  }
}
