// Contrast that the stylesheet itself decides: colour tokens read from talk.css and checked against WCAG,
// so a later change to a token or a rule cannot quietly fall below the line again.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/talk/talk.css"), "utf8");

type Rgba = [number, number, number, number];

/** A `--name: value;` token from the first :root block. */
function token(name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1];
  if (!value) throw new Error(`no --${name} in :root`);
  return value.trim();
}

/** #rrggbb or rgb(r g b / a). */
function colour(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (!rgb) throw new Error(`cannot read colour ${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
}

/** A colour with alpha (and an extra opacity) painted over an opaque background. */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba, opacity = 1): Rgba {
  const k = a * opacity;
  return [r * k + br * (1 - k), g * k + bg * (1 - k), b * k + bb * (1 - k), 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The declarations of every rule whose selector list matches `selector` exactly (whitespace-insensitive). */
function rules(selector: string): string[] {
  const want = selector.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (sel === want) out.push(m[2] ?? "");
  }
  return out;
}

const paper = colour(token("paper"));
const paperHi = colour(token("paper-hi"));

describe("form fields can be found (WCAG 1.4.11, 3:1)", () => {
  it("the field edge reaches 3:1 against the page and against the field's own fill", () => {
    const edge = over(colour(token("field-line")), paperHi);
    expect(ratio(edge, paper)).toBeGreaterThanOrEqual(3);
    expect(ratio(edge, paperHi)).toBeGreaterThanOrEqual(3);
  });

  it("text fields, the team-size chips and the note box use it at rest", () => {
    for (const selector of ['input[type="text"], input[type="email"], input[type="tel"]', ".chip", ".choices textarea"]) {
      const borders = rules(selector).flatMap((body) => [...body.matchAll(/(?:^|;|\s)border:\s*([^;]+);/g)].map((m) => m[1] ?? ""));
      expect(borders.length, selector).toBeGreaterThan(0);
      for (const border of borders) expect(border, selector).toMatch(/var\(--field-line\)/);
    }
  });
});
