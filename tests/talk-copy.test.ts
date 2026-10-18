import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(import.meta.dirname, "../talk/index.html"), "utf8");
// Our own page's visible text, for matching copy. Tags are dropped until none are left, then any stray angle
// bracket, so the result can never still hold the start of an element (CodeQL js/incomplete-multi-character-sanitization).
const text = (s: string): string => {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
};

describe("the page's promise, said once and short", () => {
  it("the intro leads with talking to Aida and the AI and automation strategy the team builds", () => {
    expect(text(html)).toContain(
      "Talk to Aida for up to twenty minutes about how your business really runs. The Aida team then builds you an AI and automation strategy that fits it.",
    );
    expect(text(html)).toContain(
      "Aida is an AI assistant. We bring decades of strategy and technology experience to what you tell her. We never sell your answers, and you choose what happens next.",
    );
  });

  it("the long version is gone", () => {
    expect(html).not.toMatch(/Rumelt|Mom Test|Jobs to Be Done/);
    expect(html).not.toMatch(/what it costs you, what you have tried/);
  });

  it("each of the four feature rows is one short line", () => {
    const rows = [...html.matchAll(/<ul class="steps">([\s\S]*?)<\/ul>/g)][0]?.[1] ?? "";
    const lines = [...rows.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? ""));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const words = line.split(" ").length;
      expect(words, line).toBeGreaterThanOrEqual(8);
      expect(words, line).toBeLessThanOrEqual(17);
    }
  });

  it("what happens next, in three steps, about the strategy", () => {
    const steps = [...(/<section class="next"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? ""));
    expect(steps).toEqual([
      "The Aida team reads your conversation.",
      "We build an AI and automation strategy for your business, using decades of strategy and technology experience.",
      "If you asked for a follow-up, we get in touch. We never sell your answers.",
    ]);
  });

  it("the description says the same in one line, and nothing shouts", () => {
    expect(html).toMatch(/<meta name="description" content="Talk to Aida for up to twenty minutes about how your business runs; the Aida team then builds you an AI and automation strategy that fits it\." \/>/);
    expect(text(html)).not.toMatch(/!/);
  });
});
