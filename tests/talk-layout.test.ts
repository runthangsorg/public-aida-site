// Layout rules the talk page depends on, read from its stylesheet. A browser check covers the rendering; these
// keep the rule itself from quietly going away.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prop, rules } from "./css-rules";

const css = readFileSync(resolve(import.meta.dirname, "../src/talk/talk.css"), "utf8");
const strategyCss = readFileSync(resolve(import.meta.dirname, "../src/strategy/strategy.css"), "utf8");

describe("headings that wrap", () => {
  it("the form screens' headings leave room between lines (Anton's comma met the T of the next line at 0.94)", () => {
    const bodies = rules(css, ".sheet-head .display, .sheet-narrow .display");
    const heights = bodies.map((b) => prop(b, "line-height")).filter((v): v is string => v !== undefined);
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(Number(h)).toBeGreaterThanOrEqual(1);
  });
});

describe("nothing is cut off or runs into its neighbour (320 px phones, text enlarged to 200%)", () => {
  it("a read-back heading scales with its quadrant at 320 px and breaks inside it when it still cannot fit", () => {
    const [h3] = rules(css, ".q h3");
    expect(h3).toBeDefined();
    const size = /clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw/.exec(prop(h3 ?? "", "font-size") ?? "");
    // At 320 px the vw term must win over the floor, or "OPPORTUNITIES" is wider than its ~100 px quadrant.
    expect(Number(size?.[1])).toBeLessThanOrEqual(320 * Number(size?.[2]) / 100);
    expect(prop(h3 ?? "", "overflow-wrap")).toBe("anywhere");
    const [li] = rules(css, ".q li, .need li, .want li");
    expect(prop(li ?? "", "overflow-wrap")).toBe("anywhere");
  });

  it("a control's label wraps inside its own button: no fixed button width under it, never nowrap", () => {
    for (const body of rules(css, ".ctl")) expect(prop(body, "min-width")).toBeUndefined();
    const labels = rules(css, ".ctl-label");
    // Wraps between words; a word wider than the whole row may still break (break-word keeps the button at least
    // as wide as its longest word, so a normal label is never cut mid-word).
    expect(labels.some((b) => prop(b, "overflow-wrap") === "break-word")).toBe(true);
    for (const body of rules(css, ".ctl-later .ctl-label")) expect(prop(body, "white-space")).not.toBe("nowrap");
  });

  it("the call's buttons and the notebook's tabs wrap to a second row rather than run past the screen's edge", () => {
    // 320 px with the text at 200%: the room's overflow cut "Mute" and "End" in half, and "Transcript".
    expect(rules(css, ".controls").some((b) => prop(b, "flex-wrap") === "wrap")).toBe(true);
    for (const body of rules(css, ".controls")) expect(prop(body, "flex-wrap") ?? "wrap").toBe("wrap");
    expect(rules(css, ".nb-tabs").some((b) => prop(b, "flex-wrap") === "wrap")).toBe(true);
  });

  it("the end screen's words go under her portrait when the column beside it is too narrow, and its buttons stay inside it", () => {
    // 320 px: beside the 108 px portrait, "Start a new conversation" ran 21 px past the screen's edge.
    const [head] = rules(css, ".end-head");
    expect(prop(head ?? "", "flex-wrap")).toBe("wrap");
    const [words] = rules(css, ".end-head > :not(.avatar)");
    expect(prop(words ?? "", "flex")).toMatch(/^1 1 \d+(\.\d+)?rem$/);
    expect(prop(words ?? "", "max-width")).toBe("100%");
    expect(prop(words ?? "", "overflow-wrap")).toBe("break-word");
    // The actions' one column is never wider than the words above them, and a button never wider than that column.
    const [actions] = rules(css, ".end-actions");
    expect(prop(actions ?? "", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(prop(rules(css, ".end-actions .btn")[0] ?? "", "max-width")).toBe("100%");
    expect(prop(rules(css, ".end-actions .btn .label")[0] ?? "", "min-width")).toBe("0");
  });

  it("the strategy cards stay inside the screen: a one-column track that cannot grow, and words that can break", () => {
    const [narrow] = rules(strategyCss, ".screen-narrow");
    expect(prop(narrow ?? "", "grid-template-columns")).toBe("minmax(0, 1fr)");
    const [sheet] = rules(strategyCss, ".sheet");
    expect(prop(sheet ?? "", "overflow-wrap")).toBe("anywhere");
  });
});

describe("the call room fits the screen it is on", () => {
  it("a short screen (a phone on its side, a laptop at 200%) drops the 560 px floor and puts her window beside her captions", () => {
    const [room] = rules(css, ".screen-room", "max-height: 559px");
    expect(room).toBeDefined();
    expect(prop(room ?? "", "min-height")).toBe("0");
    expect(prop(room ?? "", "grid-template-areas")).toMatch(/"stage captions"[\s\S]*"notes controls"/);
  });

  it("a short phone keeps the notes strip: the open notebook is only for a phone with the height for it", () => {
    for (const body of rules(css, ".nb-peek, .nb-close")) expect(prop(body, "display")).toBe("none");
    const phoneOnly = rules(css, ".nb-peek, .nb-close", "max-width: 480px");
    expect(phoneOnly.length).toBe(1);
    expect(rules(css, ".nb-peek, .nb-close", "min-height: 661px")).toHaveLength(1);
    // The stage's name gives way, its count does not.
    expect(prop(rules(css, "#stage-label")[0] ?? "", "text-overflow")).toBe("ellipsis");
    expect(prop(rules(css, ".stage-now .count")[0] ?? "", "flex")).toBe("none");
  });

  it("a caption line scrolls inside itself rather than being cut: yours gives way first, to one line, hers to two", () => {
    const you = rules(css, ".captions .line-you")[0] ?? "";
    const her = rules(css, ".captions .line-aida")[0] ?? "";
    expect(Number(prop(you, "flex-shrink"))).toBeGreaterThan(Number(prop(her, "flex-shrink")));
    expect(prop(you, "min-height")).toMatch(/1\.42em/);
    expect(prop(her, "min-height")).toMatch(/2 \* 1\.36em/);
  });

  it("on a desk her window leaves her captions the 250 px that four lines of hers and two of yours need", () => {
    const desk = rules(css, ".stage", "min-width: 1000px").map((b) => prop(b, "width") ?? "");
    const reserved = desk.map((w) => /calc\(100svh - (\d+)px\)/.exec(w)?.[1]).filter(Boolean).map(Number);
    expect(reserved.length).toBeGreaterThan(0);
    for (const r of reserved) expect(r).toBeGreaterThanOrEqual(490);
  });

  it("on a desk the idle card sits in the room's flow above the controls, as wide as the captions", () => {
    const [idle] = rules(css, ".idle", "min-width: 1000px");
    expect(prop(idle ?? "", "grid-area")).toBe("typer");
    expect(prop(idle ?? "", "position")).toBe("relative");
    expect(prop(idle ?? "", "width")).toBe("min(100%, 720px)");
  });
});
