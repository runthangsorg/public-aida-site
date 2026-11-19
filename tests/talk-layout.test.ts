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
    // What the column keeps beside her window: the bar, 250 px of captions and the controls (490 px), and more
    // while the typing box (65 px) or the idle card (95 px) shows, so neither is paid for by her captions.
    const kept = (selector: string): number => {
      const value = rules(css, selector, "min-width: 1000px").map((b) => prop(b, "--beside-stage")).find(Boolean) ?? "";
      return Number(/^(\d+)px$/.exec(value)?.[1]);
    };
    const plain = kept(".screen-room");
    const typing = kept(".screen-room:has(.typer:not([hidden]))");
    const idle = kept(".screen-room:has(.idle:not([hidden]))");
    const both = kept(".screen-room:has(.typer:not([hidden])):has(.idle:not([hidden]))");
    expect(plain).toBeGreaterThanOrEqual(490);
    expect(typing - plain).toBeGreaterThanOrEqual(65);
    expect(idle - plain).toBeGreaterThanOrEqual(95);
    expect(both - plain).toBeGreaterThanOrEqual(65 + 95);
    for (const body of rules(css, ".stage", "min-width: 1000px")) {
      const width = prop(body, "width") ?? "";
      if (width.includes("svh")) expect(width).toContain("calc(100svh - var(--beside-stage))");
    }
  });

  it("on a short desk window her window keeps 120 px, the room draws tighter, and her status tag takes the phone's size", () => {
    // 1024 x 576 (1280 x 720 at 125%): her window was 70-88 px, and nothing with the typing box open.
    const widths = rules(css, ".stage", "min-width: 1000px").map((b) => prop(b, "width") ?? "").filter((w) => w.includes("svh"));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toContain("max(120px, calc(100svh - var(--beside-stage)))");
    const short = "max-height: 700px";
    const keptShort = rules(css, ".screen-room", short).map((b) => prop(b, "--beside-stage")).find(Boolean) ?? "";
    const keptDesk = rules(css, ".screen-room", "min-width: 1000px").map((b) => prop(b, "--beside-stage")).find(Boolean) ?? "";
    expect(parseFloat(keptShort)).toBeLessThan(parseFloat(keptDesk));
    for (const sel of [".bar", ".controls", ".ctl-ic", ".idle"]) expect(rules(css, sel, short).length).toBe(1);
    // Under 160 px her "Listening" tag is the phone's size, so it stays whole and off her face.
    const [tag] = rules(css, ".status", "max-width: 159px");
    expect(prop(tag ?? "", "font-size")).toBe("13px");
  });

  it("on a desk the idle card has a row of its own, between the captions and the typing box, as wide as the captions", () => {
    const [idle] = rules(css, ".idle", "min-width: 1000px");
    expect(prop(idle ?? "", "grid-area")).toBe("idle");
    expect(prop(idle ?? "", "position")).toBe("relative");
    expect(prop(idle ?? "", "width")).toBe("min(100%, 720px)");
    // Its own row: never the typing box's (it covered the box and its Send while someone typed), never the captions'.
    const desk = rules(css, ".screen-room", "min-width: 1000px").map((b) => prop(b, "grid-template-areas")).find(Boolean) ?? "";
    expect(desk.replace(/\s+/g, " ")).toContain('"captions notes" "idle notes" "typer notes"');
    const rows = rules(css, ".screen-room", "min-width: 1000px").map((b) => prop(b, "grid-template-rows")).find(Boolean) ?? "";
    expect(rows.split(/\s+(?![^(]*\))/).length).toBe((desk.match(/"/g) ?? []).length / 2);
  });
});
