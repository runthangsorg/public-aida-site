import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import cues from "../src/intro-cues.json";
import { MOUTHS, mouthAt, mouthFor, readCues } from "../src/lipsync";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

describe("her mouth", () => {
  const list = readCues(cues.cues);

  it("has a drawing for every cue shape in the recording", () => {
    const shapes = new Set(list.map(([, shape]) => shape));
    for (const shape of shapes) expect(MOUTHS, shape).toContain(mouthFor(shape));
    expect(mouthFor("?")).toBe("closed");
  });

  it("is closed before she starts, follows each cue, and closes at the end", () => {
    expect(mouthAt(list, -0.1)).toBe("closed");
    for (const [at, shape] of list) {
      expect(mouthAt(list, at), `${at}s ${shape}`).toBe(mouthFor(shape));
      expect(mouthAt(list, at + 0.001), `${at}s ${shape}`).toBe(mouthFor(shape));
    }
    expect(mouthAt(list, cues.duration + 1)).toBe("closed");
  });

  it("actually moves: she opens her mouth at least ten times", () => {
    const opens = list.filter(([, shape], i) => mouthFor(shape) !== "closed" && mouthFor(list[i - 1]?.[1] ?? "X") === "closed");
    const changes = list.filter(([, shape], i) => mouthFor(shape) !== mouthFor(list[i - 1]?.[1] ?? "X"));
    expect(opens.length + changes.length).toBeGreaterThan(10);
  });

  it("ships a drawn patch and a style rule for every open mouth, and a blink", () => {
    const html = read("index.html");
    const css = read("src/styles.css");
    for (const mouth of MOUTHS.filter((m) => m !== "closed")) {
      expect(html, mouth).toContain(`class="mouth m-${mouth}" src="/aida/mouth-${mouth}.webp"`);
      expect(css, mouth).toContain(`.head[data-mouth="${mouth}"] .m-${mouth}`);
      expect(statSync(resolve(ROOT, `public/aida/mouth-${mouth}.webp`)).size).toBeGreaterThan(1000);
    }
    expect(html).toContain('src="/aida/blink.webp"');
  });

  it("keeps the portrait light: every image of her together is under 300 KB", () => {
    const files = ["aida.webp", "aida-640.webp", "blink.webp", ...MOUTHS.filter((m) => m !== "closed").map((m) => `mouth-${m}.webp`)];
    const total = files.reduce((n, f) => n + statSync(resolve(ROOT, "public/aida", f)).size, 0);
    expect(total).toBeLessThan(300 * 1024);
  });
});
