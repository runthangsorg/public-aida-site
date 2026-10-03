// Audio in and out of the conversation, as numbers. Pure: no Web Audio here,
// so every step is tested in Node.
//
// The model hears 16 kHz and speaks 24 kHz, both as 16-bit little-endian mono
// PCM, base64 in a JSON frame. A wrong rate does not fail loudly: it plays at
// the wrong pitch, or the model hears a chipmunk and transcribes nonsense. So
// the rates live here, once, and a microphone that runs at any other rate is
// resampled rather than mislabelled.

export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;

/**
 * 1600 samples at 16 kHz is 100 ms, the top of the 20–100 ms the server
 * wants (3.2 KB of PCM per frame). Larger frames mean fewer messages: on a
 * weak laptop each message costs the page more than its bytes do, at the
 * price of up to 36 ms more before the model hears the end of a sentence.
 */
export const FRAME_SAMPLES = 1600;

/** Float samples (-1..1) to 16-bit integers, clamped so a hot microphone clips instead of wrapping. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** 16-bit integers back to floats in -1..1. */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x8000;
  return out;
}

// Base64 runs 16 times a second for the microphone and as often again for
// her voice, so it is done the cheap way: the platform's own Uint8Array
// base64 where it exists, otherwise a lookup table written straight into
// bytes (no string built a character at a time, no spread of 2,048 arguments).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENCODE = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const PAD = 61; // "="
const ascii = new TextDecoder("latin1");

type WithBase64 = Uint8Array & { toBase64?: () => string };
type FromBase64 = typeof Uint8Array & { fromBase64?: (text: string) => Uint8Array };

/** Base64 by table, for platforms without `Uint8Array.prototype.toBase64`. */
export function base64ByTable(bytes: Uint8Array): string {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  const at = (k: number): number => bytes[k] ?? 0;
  const put = (v: number): void => {
    out[o++] = ENCODE[v & 63] ?? PAD;
  };
  for (; i + 2 < n; i += 3) {
    const v = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    put(v >> 18);
    put(v >> 12);
    put(v >> 6);
    put(v);
  }
  if (i < n) {
    const two = i + 1 < n;
    const v = (at(i) << 16) | (two ? at(i + 1) << 8 : 0);
    put(v >> 18);
    put(v >> 12);
    if (two) put(v >> 6);
    else out[o++] = PAD;
    out[o++] = PAD;
  }
  return ascii.decode(out);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as WithBase64).toBase64;
  return typeof native === "function" ? native.call(bytes) : base64ByTable(bytes);
}

export function base64ToBytes(base64: string): Uint8Array {
  try {
    const native = (Uint8Array as FromBase64).fromBase64;
    if (typeof native === "function") return native(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0); // a malformed frame plays as nothing, not as an exception in the audio path
  }
}

/** PCM16 as base64, little-endian whatever the machine's own byte order. */
export function encodePcm16(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);
  return bytesToBase64(bytes);
}

/** Base64 little-endian PCM16 to samples. A stray odd byte is dropped rather than thrown on. */
export function decodePcm16(base64: string): Int16Array {
  const bytes = base64ToBytes(base64);
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * Little-endian PCM16 bytes straight into floats, in one pass and without an
 * intermediate array: this runs for every chunk of her voice. Returns the
 * number of samples written (a stray odd byte is ignored).
 */
export function pcm16BytesToFloat(bytes: Uint8Array, out: Float32Array): number {
  const n = Math.min(bytes.length >> 1, out.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return n;
}

/** The sample rate a `audio/pcm;rate=N` MIME type declares, or the output rate when it says nothing. */
export function rateOf(mimeType: string | undefined): number {
  const match = /rate=(\d+)/.exec(mimeType ?? "");
  const rate = match ? Number(match[1]) : OUTPUT_RATE;
  return rate >= 8000 && rate <= 96_000 ? rate : OUTPUT_RATE;
}

/**
 * A streaming linear resampler. It keeps its place between frames, so the
 * seams between capture frames are as smooth as the middle of one (resampling
 * each frame on its own would click 15 times a second at 48 kHz).
 * Linear interpolation rather than dropping samples: plain decimation aliases,
 * and aliasing is what wrecks recognition on a noisy phone.
 */
export class Resampler {
  private readonly step: number;
  /** Position of the next output sample, in input samples, relative to the start of the next frame. */
  private pos = 0;
  /** The last sample of the previous frame, for interpolating across the seam (index -1). */
  private last = 0;
  private primed = false;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this.step = from / to;
  }

  push(frame: Float32Array): Float32Array {
    if (this.from === this.to) return frame;
    if (frame.length === 0) return new Float32Array(0);
    if (!this.primed) {
      // The very first output sample is the very first input sample.
      this.primed = true;
      this.last = frame[0] ?? 0;
      this.pos = 0;
    }
    // Interpolate between index floor(pos) and floor(pos)+1, both of which
    // must already be known: the last usable position is frame.length - 1.
    const end = frame.length - 1;
    const count = this.pos <= end ? Math.floor((end - this.pos) / this.step) + 1 : 0;
    const out = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const pos = this.pos + k * this.step;
      const lo = Math.floor(pos);
      const t = pos - lo;
      const a = lo < 0 ? this.last : (frame[lo] ?? 0);
      const b = frame[lo + 1] ?? 0;
      out[k] = a * (1 - t) + b * t;
    }
    this.pos += count * this.step - frame.length;
    this.last = frame[end] ?? 0;
    return out;
  }
}

/**
 * Collects resampled audio into fixed frames of PCM16. `push` returns the
 * frames completed by this input (often none, sometimes several).
 */
export class FrameChunker {
  private readonly buffer: Float32Array;
  private filled = 0;

  constructor(readonly size: number = FRAME_SAMPLES) {
    this.buffer = new Float32Array(size);
  }

  push(samples: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.size - this.filled, samples.length - i);
      this.buffer.set(samples.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.size) {
        frames.push(floatToPcm16(this.buffer));
        this.filled = 0;
      }
    }
    return frames;
  }

  /** Forget anything half-collected: audio from before the room was ready, or from before a mute. */
  clear(): void {
    this.filled = 0;
  }
}

/** Loudness of a frame, 0..1, for the little level meter on the microphone button. */
export function rms(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0;
  const scale = samples instanceof Int16Array ? 0x8000 : 1;
  let sum = 0;
  for (const s of samples) sum += (s / scale) ** 2;
  return Math.sqrt(sum / samples.length);
}
