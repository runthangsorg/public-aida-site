// When each word of her line is spoken, for the word-by-word captions.
// The recording has three caption start times (set from its pauses); within
// each, words are spread by length across the speaking part of the span.

export interface Caption {
  at: number;
  text: string;
}

export interface TimedWord {
  word: string;
  at: number;
  /** True for the first word of a caption, so the display can start a new line. */
  lead: boolean;
}

/** Share of each caption's span that is speech; the rest is the pause before the next. */
const SPEAKING = 0.86;

export function timeWords(captions: readonly Caption[], duration: number): TimedWord[] {
  const out: TimedWord[] = [];
  captions.forEach((caption, i) => {
    const next = captions[i + 1];
    const end = next ? next.at : duration;
    const span = Math.max(0, end - caption.at) * SPEAKING;
    const words = caption.text.split(/\s+/).filter(Boolean);
    const weight = words.reduce((n, w) => n + w.length + 1, 0);
    let t = caption.at;
    words.forEach((word, j) => {
      out.push({ word, at: Number(t.toFixed(3)), lead: j === 0 });
      t += weight ? (span * (word.length + 1)) / weight : 0;
    });
  });
  return out;
}

/** How many words have been spoken by time `t`. */
export function spokenCount(words: readonly TimedWord[], t: number): number {
  let n = 0;
  while (n < words.length && (words[n]?.at ?? Infinity) <= t) n++;
  return n;
}
