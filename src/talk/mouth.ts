// Her mouth in a live conversation. There is no lip-sync track for words the
// model has only just generated, so the mouth follows the sound itself, read
// from the playback analyser's waveform: how loud she is says how open
// (root-mean-square level), and how often the wave crosses zero says what
// shape. Vowels are slow, smooth waves that cross rarely; "s", "f" and "ee"
// are full of high frequencies and cross often. (The analyser's byte
// spectrum was tried first: it is in decibels and smoothed, so a loud voice
// reads as wide open all the time and the mouth stuck on one drawing.)
//
// The gains and the thresholds that pick one of the six drawn mouths are a
// heuristic, tuned by eye, not fitted to speech.

import type { Mouth } from "../lipsync";

export interface MouthShape {
  /** 0 closed, 1 fully open. */
  open: number;
  /** 0 rounded ("oo"), 1 spread ("ee", "s"); 0.5 neutral. */
  spread: number;
}

/** Samples the analyser hands over per read (about 11 ms at 24 kHz). */
export const FFT_SIZE = 256;

const OPEN_GAIN = 4.5;
const SILENCE = 0.012;
const ZCR_FLOOR = 0.03;
const ZCR_SPAN = 0.12;

/**
 * Fill `out` from a waveform (`AnalyserNode.getFloatTimeDomainData`). Writes
 * into the caller's object, so the timer allocates nothing. Silence gives a
 * closed, neutral mouth.
 */
export function shapeFromWaveform(samples: ArrayLike<number>, out: MouthShape): MouthShape {
  out.open = 0;
  out.spread = 0.5;
  const n = samples.length;
  if (n < 2) return out;
  let sum = 0;
  let crossings = 0;
  let prev = samples[0] ?? 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
    if ((v >= 0) !== (prev >= 0)) crossings++;
    prev = v;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < SILENCE) return out;
  out.open = Math.min(1, rms * OPEN_GAIN);
  out.spread = Math.min(1, Math.max(0, (crossings / (n - 1) - ZCR_FLOOR) / ZCR_SPAN));
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
