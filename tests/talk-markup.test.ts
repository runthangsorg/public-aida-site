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
