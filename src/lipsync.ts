// Her mouth, from the recording's mouth cues. The cues are Rhubarb Lip Sync's
// nine shapes (A–H, and X for rest); the portrait has six drawn mouths, so
// some cue shapes share a drawing.

export type Mouth = "closed" | "small" | "mid" | "wide" | "round" | "pucker";
export type Cue = readonly [at: number, shape: string];

export const MOUTHS: readonly Mouth[] = ["closed", "small", "mid", "wide", "round", "pucker"];

const DRAWN: Readonly<Record<string, Mouth>> = {
  X: "closed", // rest
  A: "closed", // M, B, P
  B: "small", // most consonants, teeth together
  G: "small", // F, V
  C: "mid", // EH, AE
  H: "mid", // L
  D: "wide", // AA
  E: "round", // AO, ER
  F: "pucker", // UW, OW, W
};

export function mouthFor(shape: string): Mouth {
  return DRAWN[shape] ?? "closed";
}

/** The cue list as JSON gives it back: pairs of [seconds, shape]. */
export function readCues(raw: readonly (readonly (string | number)[])[]): Cue[] {
  return raw.map(([at, shape]) => [Number(at), String(shape)] as const);
}

/** The mouth to show at `t` seconds: the shape of the last cue at or before `t`. */
export function mouthAt(cues: readonly Cue[], t: number): Mouth {
  let lo = 0;
  let hi = cues.length - 1;
  let found: Cue | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (cue && cue[0] <= t) {
      found = cue;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ? mouthFor(found[1]) : "closed";
}
