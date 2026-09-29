import { describe, expect, it } from "vitest";
import cues from "../src/intro-cues.json";
import intro from "../src/intro.json";
import { BEAT_WORDS, beatAt, beatsFrom } from "../src/beats";
import { timeWords } from "../src/words";

describe("the big words", () => {
  const words = timeWords(intro.captions, cues.duration);
  const beats = beatsFrom(words);

  it("has one beat per phrase, in order, inside the recording", () => {
    expect(beats.map((b) => b.text)).toEqual(BEAT_WORDS.map((b) => b.text));
    const times = beats.map((b) => b.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]).toBe(0);
    expect(Math.max(...times)).toBeLessThan(cues.duration);
  });

  it("stamps each word as she says it", () => {
    for (const [i, beat] of beats.entries()) {
      expect(beatAt(beats, beat.at), beat.text).toBe(i);
      expect(beatAt(beats, beat.at - 0.001), beat.text).toBe(i - 1);
    }
    expect(beatAt(beats, cues.duration)).toBe(beats.length - 1);
  });

  it("only uses words she actually says", () => {
    const line = intro.line.toLowerCase().replace(/’/g, "'");
    for (const { anchor } of BEAT_WORDS) expect(line).toContain(anchor);
  });

  it("fails loudly if her line changes and a big word no longer fits it", () => {
    expect(() => beatsFrom(timeWords([{ at: 0, text: "Goodbye." }], 1))).toThrow(/hello/);
  });
});
