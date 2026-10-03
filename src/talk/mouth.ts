// Her mouth in a live conversation. There is no lip-sync track for words the
// model has only just generated, so the mouth follows the sound itself, read
// from the playback analyser while she speaks.
//
// What the drawings need is the shape of a vowel, and that is in the spectrum:
// - the first formant (F1, roughly 300-800 Hz) rises as the jaw opens: low for
//   "ee" and "oo", high for "ah";
// - the second formant (F2, roughly 800-2500 Hz) rises as the lips spread: low
//   for "oo" and "oh" (rounded), high for "ee" and "eh" (spread);
// - "s", "f" and "sh" are hiss, energy above 4 kHz, said through nearly closed
//   lips.
// So: loudness (normalised to her own recent peak, so any volume works) scales
// how open; the F1 band's centre says how far the jaw drops; the F2 band's
// centre says round or spread; hiss gives the small mouth. The earlier version
// used loudness and zero crossings over 11 ms, which cannot tell vowels apart:
// the mouth moved but the shapes were wrong (owner, 3 Oct). The band edges and
// gains are a heuristic from textbook formant ranges, not fitted to her voice.

import type { Mouth } from "../lipsync";

export interface MouthShape {
  /** 0 closed, 1 fully open. */
  open: number;
  /** 0 rounded ("oo"), 1 spread ("ee"); 0.5 neutral. */
  spread: number;
  /** Her recent loudest moment, decaying slowly: the scale for `open`. */
  peak?: number;
}

/** About 43 ms at 24 kHz: long enough to see formants, short enough to follow syllables. */
export const FFT_SIZE = 1024;
/** Light smoothing: the default (0.8) blurs one vowel into the next. */
export const SMOOTHING = 0.35;

const SILENCE = 0.01;
const PEAK_FLOOR = 0.04;
const PEAK_DECAY = 0.995;

function powerOf(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 10) : 0;
}

/**
 * Fill `out` from the analyser's frequency data (`getFloatFrequencyData`, dB per
 * bin) and waveform (`getFloatTimeDomainData`). Writes into the caller's object,
 * so the timer allocates nothing; `out.peak` carries the loudness scale between
 * calls. Silence gives a closed, neutral mouth.
 */
export function shapeFromSpectrum(freqDb: Float32Array, wave: Float32Array, sampleRate: number, out: MouthShape): MouthShape {
  let sum = 0;
  for (const v of wave) sum += v * v;
  const rms = wave.length ? Math.sqrt(sum / wave.length) : 0;
  out.peak = Math.max(rms, (out.peak ?? PEAK_FLOOR) * PEAK_DECAY, PEAK_FLOOR);
  out.open = 0;
  out.spread = 0.5;
  if (rms < SILENCE || freqDb.length === 0) return out;

  const binHz = sampleRate / (2 * freqDb.length);
  // The spectral envelope: power averaged over about 160 Hz, so a single voice
  // harmonic does not read as a formant.
  const half = Math.max(1, Math.round(80 / binHz));
  const env = (i: number): number => {
    let acc = 0;
    let n = 0;
    for (let j = Math.max(1, i - half); j <= Math.min(freqDb.length - 1, i + half); j++) {
      acc += powerOf(freqDb[j] ?? -Infinity);
      n++;
    }
    return n ? acc / n : 0;
  };
  /** The frequency of the strongest envelope point in [lo, hi). Peaks, not centroids: a centroid is dragged by the neighbouring formant ("oo" read as "oh"). */
  const peakIn = (lo: number, hi: number): { hz: number; power: number } => {
    let best = { hz: (lo + hi) / 2, power: 0 };
    for (let i = Math.ceil(lo / binHz); i < Math.min(freqDb.length, hi / binHz); i++) {
      const pw = env(i);
      if (pw > best.power) best = { hz: i * binHz, power: pw };
    }
    return best;
  };
  let hiss = 0;
  let body = 0;
  for (let i = 1; i < freqDb.length; i++) {
    const hz = i * binHz;
    const p = powerOf(freqDb[i] ?? -Infinity);
    if (hz >= 200 && hz < 3000) body += p;
    else if (hz >= 4000 && hz < 8000) hiss += p;
  }
  const loud = Math.min(1, rms / (out.peak * 0.6));
  if (hiss > 1.5 * body) {
    out.open = Math.min(0.25, loud);
    out.spread = 0.6;
    return out;
  }
  const first = peakIn(200, 1000);
  const f1 = first.power > 0 ? first.hz : 500;
  const second = peakIn(Math.max(800, f1 + 150), 3000);
  const f2 = second.power > 0 ? second.hz : 1500;
  // 330 Hz, not 300: with 23 Hz bins a close vowel's F1 reads a little high.
  const jaw = Math.min(1, Math.max(0, (f1 - 330) / 420));
  out.open = loud * (0.2 + 0.8 * jaw);
  out.spread = Math.min(1, Math.max(0, (f2 - 850) / 900));
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
