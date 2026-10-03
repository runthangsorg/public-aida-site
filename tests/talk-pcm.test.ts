import { describe, expect, it } from "vitest";
import {
  FRAME_SAMPLES,
  FrameChunker,
  INPUT_RATE,
  Resampler,
  base64ToBytes,
  bytesToBase64,
  decodePcm16,
  encodePcm16,
  floatToPcm16,
  pcm16ToFloat,
  rateOf,
  rms,
} from "../src/talk/pcm";

describe("PCM16 encoding", () => {
  it("maps floats to the full 16-bit range and clamps anything louder", () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768]);
  });

  it("decodes back to floats within one step", () => {
    const floats = Float32Array.from([0, 0.25, -0.25, 0.999, -1]);
    const back = pcm16ToFloat(floatToPcm16(floats));
    floats.forEach((f, i) => {
      expect(back[i]).toBeCloseTo(f, 4);
    });
  });

  it("writes little-endian bytes, whatever the machine", () => {
    const b64 = encodePcm16(Int16Array.from([1, -2, 0x1234]));
    expect(Array.from(base64ToBytes(b64))).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
  });

  it("round-trips through base64", () => {
    const samples = Int16Array.from({ length: 5000 }, (_, i) => ((i * 7919) % 65536) - 32768);
    expect(Array.from(decodePcm16(encodePcm16(samples)))).toEqual(Array.from(samples));
  });

  it("drops a stray odd byte and survives malformed base64", () => {
    const odd = bytesToBase64(Uint8Array.from([0x10, 0x00, 0x20]));
    expect(Array.from(decodePcm16(odd))).toEqual([16]);
    expect(decodePcm16("%%% not base64 %%%").length).toBe(0);
  });

  it("reads the sample rate from the MIME type, falling back to 24 kHz", () => {
    expect(rateOf("audio/pcm;rate=24000")).toBe(24000);
    expect(rateOf("audio/pcm;rate=16000")).toBe(16000);
    expect(rateOf("audio/pcm")).toBe(24000);
    expect(rateOf(undefined)).toBe(24000);
    expect(rateOf("audio/pcm;rate=5")).toBe(24000);
  });
});

describe("resampling to 16 kHz", () => {
  it("passes audio already at the right rate straight through", () => {
    const frame = Float32Array.from([0.1, 0.2]);
    expect(new Resampler(INPUT_RATE, INPUT_RATE).push(frame)).toBe(frame);
  });

  it("takes every third sample of a 48 kHz ramp", () => {
    const r = new Resampler(48_000, INPUT_RATE);
    const ramp = Float32Array.from({ length: 12 }, (_, i) => i / 100);
    const out = Array.from(r.push(ramp));
    expect(out.length).toBe(4);
    out.forEach((v, i) => {
      expect(v).toBeCloseTo((i * 3) / 100, 6);
    });
  });

  it("interpolates 44.1 kHz and keeps its place across frames", () => {
    const whole = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 20));
    const once = new Resampler(44_100, INPUT_RATE).push(whole);
    const r = new Resampler(44_100, INPUT_RATE);
    const parts: number[] = [];
    for (let i = 0; i < whole.length; i += 128) parts.push(...r.push(whole.subarray(i, i + 128)));
    expect(once.length).toBe(1600);
    expect(Math.abs(parts.length - once.length)).toBeLessThanOrEqual(1);
    for (let i = 0; i < Math.min(parts.length, once.length); i++) expect(parts[i]).toBeCloseTo(once[i] ?? 0, 5);
  });

  it("upsamples too", () => {
    const out = new Resampler(8000, INPUT_RATE).push(Float32Array.from([0, 1, 0]));
    expect(Array.from(out)).toEqual([0, 0.5, 1, 0.5, 0]);
  });
});

describe("framing", () => {
  it("emits fixed 64 ms frames and carries the remainder", () => {
    const c = new FrameChunker();
    expect(FRAME_SAMPLES).toBe(1024);
    expect(c.push(new Float32Array(1000))).toHaveLength(0);
    const frames = c.push(new Float32Array(2000).fill(0.5)); // 24 to finish the first, 1024, then 952 left over
    expect(frames).toHaveLength(2);
    expect(frames[0]?.length).toBe(1024);
    expect(frames[0]?.[0]).toBe(0);
    expect(frames[0]?.[1023]).toBe(16384);
    expect(c.push(new Float32Array(71))).toHaveLength(0);
    expect(c.push(new Float32Array(1))).toHaveLength(1);
  });

  it("forgets a half-collected frame when cleared", () => {
    const c = new FrameChunker(4);
    c.push(Float32Array.from([1, 1, 1]));
    c.clear();
    const [frame] = c.push(Float32Array.from([0, 0, 0, 0]));
    expect(Array.from(frame ?? [])).toEqual([0, 0, 0, 0]);
  });

  it("keeps each frame well under the 64 KB limit once encoded", () => {
    const [frame] = new FrameChunker().push(new Float32Array(1024).fill(-0.7));
    expect(encodePcm16(frame ?? new Int16Array()).length).toBeLessThan(64 * 1024);
  });

  it("measures loudness for the level meter", () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(new Float32Array(10).fill(0.5))).toBeCloseTo(0.5, 6);
    expect(rms(new Int16Array(4).fill(-16384))).toBeCloseTo(0.5, 6);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
