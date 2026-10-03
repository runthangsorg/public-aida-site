// Her mouth in a live conversation. There is no lip-sync track for words the
// model has only just generated, so the mouth follows the sound itself: how
// loud she is says how open, and where the energy sits says what shape.
// Vowels put their energy low (the first formant, about 300–1,200 Hz);
// sibilants and fricatives put it high (about 3–8 kHz). So `open` comes from
// overall energy and `spread` from the high band's share of it.
//
// The band edges come from formant ranges, and the thresholds that pick one of
// the six drawn mouths are a heuristic, tuned by eye, not fitted to speech.

import type { Mouth } from "../lipsync";

export interface MouthShape {
  /** 0 closed, 1 fully open. */
  open: number;
  /** 0 rounded ("oo"), 1 spread ("ee", "s"); 0.5 neutral. */
  spread: number;
}

/** The analyser's FFT size. Bin width is the context's rate / FFT_SIZE. */
export const FFT_SIZE = 256;

const OPEN_GAIN = 3.2;
const SPREAD_FLOOR = 0.2;
const SPREAD_SPAN = 0.5;

function band(rate: number, lowHz: number, highHz: number): [number, number] {
  const bin = rate / FFT_SIZE;
  return [Math.round(lowHz / bin), Math.round(highHz / bin)];
}

/**
 * Fill `out` from a byte spectrum (`AnalyserNode.getByteFrequencyData`) taken
 * at `rate` Hz. Writes into the caller's object, so the 60 Hz loop allocates
 * nothing. Silence gives a closed, neutral mouth.
 */
export function shapeFromSpectrum(spectrum: ArrayLike<number>, rate: number, out: MouthShape): MouthShape {
  const n = spectrum.length;
  out.open = 0;
  out.spread = 0.5;
  if (n === 0) return out;
  const [lowA, lowB] = band(rate, 300, 1200);
  const [highA, highB] = band(rate, 3000, 8000);
  let sum = 0;
  let low = 0;
  let high = 0;
  for (let i = 0; i < n; i++) {
    const v = spectrum[i] ?? 0;
    sum += v;
    if (i >= lowA && i < lowB) low += v;
    else if (i >= highA && i < highB) high += v;
  }
  out.open = Math.min(1, (sum / n / 255) * OPEN_GAIN);
  const lowMean = low / Math.max(1, lowB - lowA);
  const highMean = high / Math.max(1, Math.min(highB, n) - highA);
  const total = lowMean + highMean;
  if (total < 1) return out; // nothing in either band to shape: stay neutral
  out.spread = Math.min(1, Math.max(0, (highMean / total - SPREAD_FLOOR) / SPREAD_SPAN));
  return out;
}

/** One of the six drawn mouths for a shape. */
export function mouthFor(shape: MouthShape): Mouth {
  const { open, spread } = shape;
  if (open < 0.1) return "closed";
  if (open < 0.28) return spread < 0.25 ? "pucker" : "small";
  if (open < 0.5) return spread < 0.3 ? "round" : "mid";
  return spread < 0.3 ? "round" : "wide";
}
