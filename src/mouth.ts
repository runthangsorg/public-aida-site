// Aida's mouth is a small parametric model rather than a set of fixed
// drawings: every viseme is a point in the same parameter space, so any two
// shapes can be blended and the lips always stay a valid closed curve.

export interface MouthShape {
  /** Half-width of the mouth, in avatar units. */
  w: number;
  /** How far the upper lip's inner edge rises above the seam. */
  top: number;
  /** How far the lower lip's inner edge drops below the seam. */
  bot: number;
  /** Upper lip thickness. */
  lipT: number;
  /** Lower lip thickness. */
  lipB: number;
  /** 0..1 how much of the upper teeth show. */
  teeth: number;
  /** 0..1 how far the tongue rises. */
  tongue: number;
  /** Corner lift: positive raises the corners into a smile. */
  smile: number;
}

/**
 * Rhubarb Lip Sync mouth shapes. A–F are the basic set, G/H are optional
 * extensions and X is the rest position.
 */
export const SHAPES: Record<string, MouthShape> = {
  X: { w: 27, top: 0.7, bot: 0.7, lipT: 5, lipB: 7, teeth: 0, tongue: 0, smile: 1.4 },
  A: { w: 26, top: 0.35, bot: 0.35, lipT: 4.6, lipB: 6.6, teeth: 0, tongue: 0, smile: 0.6 },
  B: { w: 28, top: 3, bot: 5, lipT: 4.4, lipB: 6.4, teeth: 1, tongue: 0, smile: 1 },
  C: { w: 28.5, top: 5, bot: 11, lipT: 4.4, lipB: 6.4, teeth: 0.7, tongue: 0.1, smile: 0.4 },
  D: { w: 29, top: 6, bot: 17, lipT: 4.4, lipB: 6.4, teeth: 0.6, tongue: 0.5, smile: 0 },
  E: { w: 22, top: 5, bot: 10, lipT: 5.4, lipB: 7.4, teeth: 0.3, tongue: 0.2, smile: -0.4 },
  F: { w: 16, top: 4, bot: 7, lipT: 6.6, lipB: 8.6, teeth: 0, tongue: 0, smile: -1 },
  G: { w: 28, top: 1.8, bot: 3.2, lipT: 4.4, lipB: 7.2, teeth: 1, tongue: 0, smile: 0.8 },
  H: { w: 27.5, top: 5, bot: 12, lipT: 4.6, lipB: 6.6, teeth: 0.5, tongue: 1, smile: 0.3 },
};

export const REST: MouthShape = SHAPES.X ?? {
  w: 27,
  top: 0.7,
  bot: 0.7,
  lipT: 5,
  lipB: 7,
  teeth: 0,
  tongue: 0,
  smile: 1.4,
};

const KEYS = Object.keys(REST) as (keyof MouthShape)[];

export function lerpShape(a: MouthShape, b: MouthShape, t: number): MouthShape {
  const out = { ...a };
  for (const key of KEYS) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

/** How open the mouth is, 0..1, used to drive the aura while she speaks. */
export function openness(shape: MouthShape): number {
  return Math.min(1, Math.max(0, (shape.top + shape.bot - 1.4) / 21));
}

const f = (n: number): string => n.toFixed(2);

export interface MouthPaths {
  lips: string;
  inner: string;
  teethY: number;
  teethH: number;
  tongueY: number;
  shineY: number;
}

export function mouthPaths(s: MouthShape): MouthPaths {
  const { w, top, bot, lipT, lipB, smile } = s;
  const c = -smile; // corner y; negative is up
  const peakY = -top - lipT * 1.15;
  const dipY = -top - lipT * 0.85;
  const lowY = bot + lipB;

  const lips =
    `M${f(-w)} ${f(c)}` +
    `C${f(-w * 0.55)} ${f(peakY + lipT * 0.1)} ${f(-w * 0.22)} ${f(peakY)} 0 ${f(dipY)}` +
    `C${f(w * 0.22)} ${f(peakY)} ${f(w * 0.55)} ${f(peakY + lipT * 0.1)} ${f(w)} ${f(c)}` +
    `C${f(w * 0.62)} ${f(lowY)} ${f(-w * 0.62)} ${f(lowY)} ${f(-w)} ${f(c)}Z`;

  const inner =
    `M${f(-w)} ${f(c)}` +
    `C${f(-w * 0.5)} ${f(-top)} ${f(w * 0.5)} ${f(-top)} ${f(w)} ${f(c)}` +
    `C${f(w * 0.5)} ${f(bot)} ${f(-w * 0.5)} ${f(bot)} ${f(-w)} ${f(c)}Z`;

  return {
    lips,
    inner,
    teethY: -top * 0.75 - 1.5,
    teethH: 3 + 6 * s.teeth,
    tongueY: bot * 0.75 + 5 - s.tongue * (bot * 0.55 + 2),
    shineY: bot + lipB * 0.55,
  };
}

export interface MouthElements {
  lips: SVGPathElement;
  inner: SVGPathElement;
  clip: SVGPathElement;
  teeth: SVGRectElement;
  tongue: SVGEllipseElement;
  shine: SVGEllipseElement;
}

export function renderMouth(el: MouthElements, shape: MouthShape): void {
  const p = mouthPaths(shape);
  el.lips.setAttribute("d", p.lips);
  el.inner.setAttribute("d", p.inner);
  el.clip.setAttribute("d", p.inner);
  el.teeth.setAttribute("y", f(p.teethY));
  el.teeth.setAttribute("height", f(p.teethH));
  el.tongue.setAttribute("cy", f(p.tongueY));
  el.shine.setAttribute("cy", f(p.shineY));
  el.shine.setAttribute("rx", f(shape.w * 0.3));
}
