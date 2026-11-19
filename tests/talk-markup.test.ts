// The talk page's markup, read as text: things a browser test would otherwise be the only guard for.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(import.meta.dirname, "../talk/index.html"), "utf8");

/** The opening tag of the element with this id. */
function tag(id: string): string {
  const m = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no #${id}`);
  return m[0];
}

describe("the captions", () => {
  it("each caption that scrolls inside itself can be reached and scrolled from the keyboard, and is named", () => {
    for (const id of ["said-aida", "said-you"]) {
      const t = tag(id);
      expect(t, id).toMatch(/\stabindex="0"/);
      expect(t, id).toMatch(/\srole="region"/);
      expect(t, id).toMatch(/\saria-label="[^"]+"/);
    }
  });
});

describe("her portrait", () => {
  /** The slot width `sizes` gives at a viewport width, for the (min-width: Npx) conditions this page uses. */
  function slot(sizes: string, viewport: number): number {
    for (const part of sizes.split(",").map((p) => p.trim())) {
      const m = /^\(min-width:\s*(\d+)px\)\s+(\d+)(px|vw)$/.exec(part);
      if (m) {
        if (viewport >= Number(m[1])) return m[3] === "vw" ? (Number(m[2]) * viewport) / 100 : Number(m[2]);
        continue;
      }
      const last = /^(\d+)(px|vw)$/.exec(part);
      if (last) return last[2] === "vw" ? (Number(last[1]) * viewport) / 100 : Number(last[1]);
    }
    throw new Error(`cannot read sizes "${sizes}"`);
  }

  it("asks for the width the first screen draws her at, so a tablet does not fetch the 1024 px file", () => {
    const sizes = /<img class="vera-still"[^>]*\ssizes="([^"]+)"/.exec(html)?.[1] ?? "";
    // Measured: 460 px wide from 560 to 999 px, 44vw (up to 640 px) from 1000 px.
    for (const w of [560, 600, 768, 899, 999]) expect(slot(sizes, w), `at ${w}`).toBeLessThanOrEqual(470);
    for (const w of [560, 768, 999]) expect(slot(sizes, w), `at ${w}`).toBeGreaterThanOrEqual(450);
    expect(slot(sizes, 1280)).toBeGreaterThanOrEqual(540);
  });
});
