import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Under the HTML spec, a touch pointerdown is not a user activation; its
// pointerup (or touchend) is. Listening on pointerdown made "tap anywhere to
// hear her" do nothing on phones.
describe("the first tap anywhere", () => {
  const main = readFileSync(resolve(import.meta.dirname, "..", "src", "main.ts"), "utf8");

  it("listens for the events that grant sound on touch screens", () => {
    expect(main).toContain('document.addEventListener("pointerup", firstTouch)');
    expect(main).toContain('document.addEventListener("keydown", firstTouch)');
  });

  it("never waits on pointerdown or touchstart, which grant nothing to a finger", () => {
    expect(main).not.toMatch(/addEventListener\("(pointerdown|touchstart)"/);
  });
});
