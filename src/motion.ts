// The motion: an entrance, big words stamped letter by letter, a jolt when
// they land. All of it is the Web Animations API, and none of it runs when the
// visitor asks for reduced motion; the page is complete without it.

// An ease with an overshoot, so things land rather than stop.
const SPRING = "cubic-bezier(0.22, 1.5, 0.36, 1)";
const OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Wrap each character of `el` in its own span, so it can move on its own. */
export function splitLetters(el: HTMLElement): HTMLElement[] {
  const text = el.textContent;
  el.textContent = "";
  return Array.from(text).map((ch) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.textContent = ch === " " ? "\u00a0" : ch; // an inline-block space would collapse to nothing
    el.append(span);
    return span;
  });
}

interface Cast {
  burst: HTMLElement;
  aida: HTMLElement;
  labels: HTMLElement[];
  /** Called the moment everything has landed, before the entrance lets go. */
  settle: () => void;
}

/**
 * About 1.2 seconds: the sunburst spins open, she pops up from below, the
 * labels slap down. Every piece holds its pose until the last has landed;
 * then `settle` hands them to the stylesheet (whose pose is the same as the
 * last frame) and the animations are cancelled, in one step, so nothing blinks.
 */
export function entrance(c: Cast): Promise<void> {
  const runs: Animation[] = [
    c.burst.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.15) rotate(-70deg)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1) rotate(0deg)" },
      ],
      { duration: 1100, easing: OUT, fill: "both" },
    ),
    c.aida.animate(
      [
        { opacity: 0, transform: "translateY(45%) rotate(-7deg) scale(0.88)" },
        { opacity: 1, transform: "translateY(-3%) rotate(1.5deg) scale(1.02)", offset: 0.68 },
        { opacity: 1, transform: "none" },
      ],
      { duration: 900, delay: 180, easing: OUT, fill: "both" },
    ),
    ...c.labels.map((el, i) =>
      el.animate(
        [
          { opacity: 0, transform: "scale(1.9) rotate(-14deg)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 340, delay: 620 + i * 90, easing: SPRING, fill: "both" },
      ),
    ),
  ];
  return Promise.all(runs.map((a) => a.finished)).then(() => {
    c.settle();
    for (const a of runs) a.cancel();
  });
}

/** Size a big word to fill the width without crossing the edges. */
export function fit(el: HTMLElement): void {
  el.style.fontSize = "100px";
  const width = el.getBoundingClientRect().width || 1;
  const most = Math.min(innerHeight * 0.24, innerWidth * 0.3);
  const size = Math.min(most, (innerWidth * 0.92 * 100) / width);
  el.style.fontSize = `${size.toFixed(1)}px`;
}

/** Replace the big word: the old one blows away, the new one stamps down letter by letter. */
export function stamp(host: HTMLElement, text: string, still: boolean): void {
  for (const old of host.querySelectorAll<HTMLElement>(".bw")) {
    if (still) {
      old.remove();
      continue;
    }
    old.classList.add("bw-out");
    void old
      .animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "scale(1.12) translateY(-8%)" },
        ],
        { duration: 150, easing: "ease-in", fill: "forwards" },
      )
      .finished.then(() => {
        old.remove();
      });
  }
  const word = document.createElement("span");
  word.className = "bw";
  word.textContent = text;
  host.append(word);
  fit(word);
  if (still) return;
  splitLetters(word).forEach((ch, i) => {
    const tilt = (i % 2 ? 1 : -1) * (5 + ((i * 7) % 9));
    ch.animate(
      [
        { opacity: 0, transform: `translateY(-45%) scale(2) rotate(${tilt}deg)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, delay: 70 + i * 30, easing: SPRING, fill: "backwards" },
    );
  });
}

/** A short jolt, as if the word hit the paper. */
export function jolt(el: HTMLElement): void {
  el.animate(
    [
      { transform: "none" },
      { transform: "translate(-5px, 4px)" },
      { transform: "translate(4px, -3px)" },
      { transform: "translate(-2px, 1px)" },
      { transform: "none" },
    ],
    { duration: 240, delay: 90, easing: "linear" },
  );
}

/** A caption word popping in. */
export function popWord(el: HTMLElement): void {
  el.animate(
    [
      { opacity: 0, transform: "translateY(0.35em) scale(0.9)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 260, easing: SPRING },
  );
}

/** Count a number up, for the READY card. */
export function countUp(el: HTMLElement, to: number, ms: number, delay: number): void {
  const start = performance.now() + delay;
  const tick = (now: number): void => {
    const k = Math.min(1, Math.max(0, (now - start) / ms));
    el.textContent = `${Math.round(to * (1 - (1 - k) ** 3))}%`;
    if (k < 1) requestAnimationFrame(tick);
  };
  el.textContent = "0%";
  requestAnimationFrame(tick);
}
