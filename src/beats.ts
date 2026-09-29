// The big words. One per phrase, stamped on screen as she says the phrase's
// first word; the times come from the word timing, so they follow the voice.

import type { TimedWord } from "./words";

export interface Beat {
  at: number;
  text: string;
}

export const BEAT_WORDS: readonly { anchor: string; text: string }[] = [
  { anchor: "hello", text: "Hello." },
  { anchor: "i'm", text: "I’m Aida." },
  { anchor: "not", text: "Not quite ready" },
  { anchor: "very", text: "Very soon" },
];

const bare = (word: string): string =>
  word
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}']/gu, "");

export function beatsFrom(words: readonly TimedWord[]): Beat[] {
  let from = 0;
  return BEAT_WORDS.map(({ anchor, text }) => {
    const index = words.findIndex((w, i) => i >= from && bare(w.word) === anchor);
    const word = words[index];
    if (!word) throw new Error(`Her line has no "${anchor}" after word ${from}`);
    from = index + 1;
    return { at: word.at, text };
  });
}

/** Which beat is on screen at `t`: the last one that has started, or -1 before the first. */
export function beatAt(beats: readonly Beat[], t: number): number {
  let current = -1;
  beats.forEach((beat, i) => {
    if (beat.at <= t) current = i;
  });
  return current;
}
