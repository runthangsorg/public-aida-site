import { describe, expect, it } from "vitest";
import intro from "../src/intro.json";
import cues from "../src/intro-cues.json";
import { spokenCount, timeWords } from "../src/words";

describe("word timing for her line", () => {
  const words = timeWords(intro.captions, cues.duration);

  it("covers every word of the line, in order", () => {
    expect(words.map((w) => w.word).join(" ")).toBe(intro.captions.map((c) => c.text).join(" "));
  });

  it("starts each caption's first word at the caption's own time, and marks it", () => {
    for (const caption of intro.captions) {
      const first = words.find((w) => w.at === caption.at && w.lead);
      expect(first?.word, caption.text).toBe(caption.text.split(/\s+/)[0]);
    }
  });

  it("never goes backwards and ends before the recording does", () => {
    const times = words.map((w) => w.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThan(cues.duration);
  });

  it("keeps each caption's words inside its own span", () => {
    intro.captions.forEach((caption, i) => {
      const end = intro.captions[i + 1]?.at ?? cues.duration;
      const own = words.filter((w) => w.at >= caption.at && w.at < end);
      expect(own.length, caption.text).toBe(caption.text.split(/\s+/).length);
    });
  });

  it("counts the words spoken by a given moment", () => {
    expect(spokenCount(words, -1)).toBe(0);
    expect(spokenCount(words, 0)).toBe(1);
    expect(spokenCount(words, cues.duration)).toBe(words.length);
  });
});
