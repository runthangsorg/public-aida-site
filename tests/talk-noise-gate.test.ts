import { describe, expect, it } from "vitest";
import {
  HOLD_MS,
  MIN_LEVEL,
  OPEN_MS,
  PREROLL_MS,
  TAIL_MS,
  startGate,
  stepGate,
  thresholdFor,
  type Gate,
} from "../src/talk/noise";

// The microphone worklet posts 100 ms of audio at a time with its loudness (RMS, 0..1): one frame here is one
// such post. The items are the frame numbers, so a test can see exactly which frames would reach the socket.
const FRAME_MS = 100;

/** A seeded wobble (no Math.random: a failing run must fail the same way twice). */
function wobble(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296 - 0.5; // -0.5..0.5
  };
}

/** `ms` of a level, with a little wobble of `spread` either side. */
function steady(level: number, ms: number, spread = 0, seed = 7): number[] {
  const next = wobble(seed);
  return Array.from({ length: Math.round(ms / FRAME_MS) }, () => Math.max(0, level + next() * 2 * spread));
}

/** Speech, roughly: loud syllables and softer joins, with a short breath between phrases. */
function speech(ms: number): number[] {
  const out: number[] = [];
  for (let i = 0; out.length * FRAME_MS < ms; i++) {
    const beat = i % 20;
    out.push(beat >= 17 ? 0.004 : beat % 3 === 2 ? 0.04 : 0.15);
  }
  return out;
}

interface Run {
  gate: Gate<number>;
  /** Every frame number sent, in the order sent. */
  sent: number[];
  /** What each step sent. */
  steps: number[][];
  /** Whether the gate heard a voice after each step. */
  open: boolean[];
}

/** Feed levels through the gate; `speaking` says whether her voice was playing at each frame. */
function run(levels: number[], speaking: boolean | ((i: number) => boolean), from: Gate<number> = startGate()): Run {
  let gate = from;
  const sent: number[] = [];
  const steps: number[][] = [];
  const open: boolean[] = [];
  levels.forEach((level, i) => {
    const step = stepGate(gate, { item: i, level, ms: FRAME_MS }, typeof speaking === "function" ? speaking(i) : speaking);
    gate = step.gate;
    sent.push(...step.send);
    steps.push(step.send);
    open.push(gate.open);
  });
  return { gate, sent, steps, open };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

describe("the barge-in gate", () => {
  it("has the numbers the brief set: opens after 250 ms over max(floor x 3, 0.02), ~300 ms of pre-roll, 800 ms hold", () => {
    expect(OPEN_MS).toBe(250);
    expect(PREROLL_MS).toBe(300);
    expect(HOLD_MS).toBe(800);
    expect(MIN_LEVEL).toBe(0.02);
    expect(thresholdFor(0.001)).toBe(0.02);
    expect(thresholdFor(0.01)).toBeCloseTo(0.03, 10);
    expect(thresholdFor(null)).toBe(0.02);
  });

  it("while she is not speaking, sends every frame at once, as before: noise, bursts and speech alike", () => {
    const levels = [...steady(0.003, 1000), ...steady(0.3, 200), ...steady(0.06, 2000, 0.01), ...speech(2000)];
    const r = run(levels, false);
    expect(r.sent).toEqual(range(0, levels.length));
    expect(r.steps.every((s) => s.length === 1)).toBe(true);
  });

  it("steady noise never opens it, however long she speaks over it", () => {
    for (const level of [0.005, 0.03, 0.08]) {
      const r = run(steady(level, 30_000, level * 0.12), true);
      expect(r.sent, `steady noise at ${level}`).toEqual([]);
      expect(r.open.some(Boolean), `steady noise at ${level}`).toBe(false);
    }
  });

  it("a steady noise that started while she was quiet is learnt, and does not open it once she speaks", () => {
    // A quiet room, then a fan comes on (sent as usual: she is not speaking), then she talks for 20 s.
    const levels = [...steady(0.003, 3000, 0.001), ...steady(0.04, 15_000, 0.004, 3), ...steady(0.04, 20_000, 0.004, 5)];
    const speaksFrom = 180;
    const r = run(levels, (i) => i >= speaksFrom);
    expect(r.sent).toEqual(range(0, speaksFrom));
    expect(r.open.slice(speaksFrom).some(Boolean)).toBe(false);
  });

  it("a burst under 250 ms never opens it: a cough, a knock, a door", () => {
    const levels = [...steady(0.003, 2000, 0.001)];
    for (let i = 0; i < 6; i++) levels.push(0.4, 0.25, ...steady(0.003, 1500, 0.001, i + 11)); // 200 ms bursts
    const r = run(levels, true);
    expect(r.sent).toEqual([]);
    expect(r.open.some(Boolean)).toBe(false);
  });

  it("her own voice coming back at a modest, constant-ish level (the echo) does not open it, even with short peaks", () => {
    const echo = steady(0.015, 12_000, 0.003, 21);
    // Peaks of 200 ms over the 0.02 floor every second: louder words of hers that echo cancellation let through.
    for (let i = 7; i < echo.length; i += 10) {
      echo[i] = 0.026;
      if (i + 1 < echo.length) echo[i + 1] = 0.024;
    }
    const quiet = steady(0.003, 3000, 0.001);
    const r = run([...quiet, ...echo], (i) => i >= quiet.length);
    expect(r.sent).toEqual(range(0, quiet.length)); // before she spoke: everything, as before
    expect(r.open.slice(quiet.length).some(Boolean)).toBe(false);
    // ...and the floor has risen to sit under her echo, so the gate now asks for more than it did.
    expect(r.gate.floor ?? 0).toBeGreaterThan(0.005);
    expect(r.gate.floor ?? 1).toBeLessThan(0.02);
    expect(thresholdFor(r.gate.floor)).toBeGreaterThan(0.02);
  });

  it("speech opens it after ~250 ms: the last ~300 ms go first, once, then everything until 800 ms after they stop", () => {
    const quiet = steady(0.003, 2000, 0.001); // frames 0..19
    const talk = steady(0.12, 1500, 0.02, 9); // frames 20..34
    const after = steady(0.003, 2000, 0.001, 4); // frames 35..54
    const r = run([...quiet, ...talk, ...after], true);
    // The third loud frame (300 ms, the first whole frame past 250 ms) opens it, sending the three frames
    // before it - one quiet frame and the first two loud ones - and then itself.
    expect(r.steps[21]).toEqual([]);
    expect(r.steps[22]).toEqual([19, 20, 21, 22]);
    expect(r.open[21]).toBe(false);
    expect(r.open[22]).toBe(true);
    // Then frame by frame, nothing sent twice, until 800 ms of quiet have passed.
    expect(r.sent).toEqual(range(19, 35 + HOLD_MS / FRAME_MS));
    expect(new Set(r.sent).size).toBe(r.sent.length);
    expect(r.open.at(-1)).toBe(false);
  });

  it("speech over her echo opens it too", () => {
    const echo = steady(0.015, 5000, 0.003, 2); // frames 0..49: the floor learns her echo
    const talk = steady(0.12, 1000, 0.03, 8); // frames 50..59
    const r = run([...steady(0.003, 2000, 0.001), ...echo, ...talk], true);
    expect(r.open.at(-1)).toBe(true);
    expect(r.sent[0]).toBe(20 + 50 - 1); // the pre-roll starts one frame before their first word
  });

  it("stays open through a sentence with its short breaths; a long speech is never cut in the middle", () => {
    const quiet = steady(0.003, 2000, 0.001);
    const talk = speech(10_000);
    const r = run([...quiet, ...talk], true);
    const first = r.open.indexOf(true);
    expect(first).toBe(quiet.length + 2);
    expect(r.open.slice(first).every(Boolean)).toBe(true);
    expect(r.sent).toEqual(range(first - 3, quiet.length + talk.length));
  });

  it("when she stops (after a short tail for the video's lag), sends everything again; a word just begun is not lost", () => {
    const stopAt = 30;
    const tail = TAIL_MS / FRAME_MS;
    // A quiet room while she speaks, then she stops: nothing is sent until the tail has passed, then all.
    const quiet = run(steady(0.003, 6000, 0.001), (i) => i < stopAt);
    expect(quiet.sent).toEqual(range(stopAt + tail, 60));
    // They start talking 200 ms before the tail ends (too short to open it): those frames go, then the rest.
    const levels = [...steady(0.003, (stopAt + tail - 2) * FRAME_MS, 0.001), ...steady(0.12, 1000, 0.02)];
    const r = run(levels, (i) => i < stopAt);
    expect(r.sent[0]).toBe(stopAt + tail - 3);
    expect(r.sent).toEqual(range(stopAt + tail - 3, levels.length));
  });

  it("keeps hearing a voice while she is not speaking, for the status line, with the same rules", () => {
    const r = run([...steady(0.003, 2000, 0.001), ...steady(0.12, 1000, 0.02), ...steady(0.003, 2000, 0.001)], false);
    expect(r.open.indexOf(true)).toBe(22);
    expect(r.open.lastIndexOf(true)).toBe(30 + HOLD_MS / FRAME_MS - 1);
  });

  it("starting again keeps what it learnt of the room, and forgets anything it was holding", () => {
    const r = run(steady(0.003, 2000, 0.001), true);
    const fresh = startGate(r.gate.floor);
    expect(fresh.floor).toBe(r.gate.floor);
    expect(fresh.held).toEqual([]);
    expect(fresh.open).toBe(false);
    expect(r.gate.held.length).toBe(PREROLL_MS / FRAME_MS);
  });

  it("a muted microphone (silence) or a broken level never opens it", () => {
    expect(run(steady(0, 5000), true).sent).toEqual([]);
    expect(run([Number.NaN, Number.POSITIVE_INFINITY, -1, ...steady(0.003, 1000)], true).open.some(Boolean)).toBe(false);
  });
});
