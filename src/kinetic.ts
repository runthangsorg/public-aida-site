// Kinetic typography for the entrance: letters split into spans, then played
// as one short timeline with the Web Animations API. Nothing here runs when
// the visitor asks for reduced motion; the page is complete without it.

/** Wrap each character of `el` in its own span, so it can move on its own. */
export function splitLetters(el: HTMLElement): HTMLElement[] {
  const text = el.textContent;
  el.textContent = "";
  return Array.from(text).map((ch, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.textContent = ch;
    span.style.setProperty("--i", String(i));
    el.append(span);
    return span;
  });
}

// An ease with a small overshoot, so letters land rather than stop.
const SPRING = "cubic-bezier(0.22, 1.35, 0.36, 1)";
const OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

interface Cast {
  glow: HTMLElement;
  rays: HTMLElement;
  hello: HTMLElement[];
  helloLine: HTMLElement;
  im: HTMLElement[];
  name: HTMLElement[];
  sweep: HTMLElement;
  soon: HTMLElement;
  controls: HTMLElement;
}

/** The entrance, about four seconds. Resolves when the last piece has landed. */
export function playEntrance(c: Cast): Promise<void> {
  const runs: Animation[] = [];
  const play = (el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation => {
    const a = el.animate(frames, { fill: "both", ...opts });
    runs.push(a);
    return a;
  };
  // Script animations sit above CSS ones, so a held end pose would block the
  // glow's breathing loop. Write the end pose inline, then let CSS take over.
  const handBack = (a: Animation): void => {
    void a.finished.then(() => {
      a.commitStyles();
      a.cancel();
    });
  };

  // 0.0 s — light gathers.
  const glowIn = play(c.glow, [{ opacity: 0, transform: "translate(-50%, -50%) scale(0.12)" }, { opacity: 1, transform: "translate(-50%, -50%) scale(1)" }], {
    duration: 1800,
    easing: OUT,
  });
  handBack(glowIn);
  const raysIn = play(c.rays, [{ opacity: 0, transform: "translate(-50%, -50%) rotate(-24deg) scale(0.6)" }, { opacity: 1, transform: "translate(-50%, -50%) rotate(0deg) scale(1)" }], {
    duration: 2600,
    delay: 300,
    easing: OUT,
  });
  handBack(raysIn);

  // 0.25 s — "Hello." rises out of a blur, letter by letter, big.
  c.hello.forEach((ch, i) => {
    play(ch, [
      { opacity: 0, transform: "translateY(0.6em) rotateX(-80deg)", filter: "blur(14px)" },
      { opacity: 1, transform: "translateY(0) rotateX(0deg)", filter: "blur(0px)" },
    ], { duration: 950, delay: 250 + i * 60, easing: SPRING });
  });
  play(c.helloLine, [{ transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: 1300, delay: 1150, easing: OUT });

  // 1.5 s — "I'm" slides in; "Aida." lands letter by letter.
  c.im.forEach((ch, i) => {
    play(ch, [{ opacity: 0, transform: "translateX(-0.4em)" }, { opacity: 1, transform: "translateX(0)" }], {
      duration: 600,
      delay: 1500 + i * 40,
      easing: OUT,
    });
  });
  c.name.forEach((ch, i) => {
    play(ch, [
      { opacity: 0, transform: "translateY(-0.45em) scale(1.35)", filter: "blur(10px)" },
      { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)" },
    ], { duration: 900, delay: 1750 + i * 85, easing: SPRING });
  });

  // 2.6 s — a bar of light crosses the words.
  play(c.sweep, [{ opacity: 0, transform: "translateX(-60%) skewX(-18deg)" }, { opacity: 1, offset: 0.2 }, { opacity: 0, transform: "translateX(160%) skewX(-18deg)" }], {
    duration: 1100,
    delay: 2600,
    easing: "cubic-bezier(0.45, 0, 0.2, 1)",
  });

  // 3.0 s — the small print and the button.
  play(c.soon, [{ opacity: 0, letterSpacing: "0.9em" }, { opacity: 1, letterSpacing: "0.32em" }], { duration: 1100, delay: 3000, easing: OUT });
  play(c.controls, [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "translateY(0)" }], {
    duration: 800,
    delay: 3350,
    easing: OUT,
  });

  return Promise.all(runs.map((a) => a.finished)).then(() => undefined);
}

/** One spoken word pops into place. */
export function popWord(el: HTMLElement): void {
  el.animate(
    [
      { opacity: 0, transform: "translateY(0.35em) scale(0.85)", filter: "blur(6px)" },
      { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)" },
    ],
    { duration: 420, easing: SPRING, fill: "both" },
  );
}
