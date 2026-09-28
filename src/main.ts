import "./styles.css";
import cueSheet from "./intro-cues.json";
import intro from "./intro.json";
import { createLipSync, parseCueSheet } from "./lipsync";
import { REST, renderMouth, type MouthElements } from "./mouth";

const root = document.documentElement;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const coarsePointer = matchMedia("(pointer: coarse)");

function byId<T extends Element>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing #${id}`);
  return el;
}

const portrait = document.querySelector<HTMLElement>(".portrait");
const eyes = Array.from(document.querySelectorAll<SVGGElement>(".avatar .eye"));

const mouth: MouthElements = {
  lips: byId("mouth-lips", SVGPathElement),
  inner: byId("mouth-inner", SVGPathElement),
  clip: byId("mouth-clip", SVGPathElement),
  teeth: byId("mouth-teeth", SVGRectElement),
  tongue: byId("mouth-tongue", SVGEllipseElement),
  shine: byId("mouth-shine", SVGEllipseElement),
};

renderMouth(mouth, REST);

// ---------- entrance ----------

const WAKE_AT_MS = 2450;
const SETTLED_AT_MS = 3800;

if (reducedMotion.matches) {
  root.classList.add("is-still", "is-awake");
} else {
  root.classList.add("is-intro");
  setTimeout(() => {
    root.classList.add("is-awake");
  }, WAKE_AT_MS);
}

// ---------- blinking ----------

function blinkOnce(): void {
  for (const eye of eyes) {
    eye.classList.remove("is-blinking");
    // Force a style flush so a second blink restarts the animation.
    void eye.getBoundingClientRect();
    eye.classList.add("is-blinking");
  }
}

for (const eye of eyes) {
  eye.addEventListener("animationend", () => {
    eye.classList.remove("is-blinking");
  });
}

function scheduleBlink(): void {
  const wait = 2600 + Math.random() * 4400;
  setTimeout(() => {
    if (!document.hidden) {
      blinkOnce();
      if (Math.random() < 0.2) {
        setTimeout(blinkOnce, 300);
      }
    }
    scheduleBlink();
  }, wait);
}

if (!reducedMotion.matches) {
  setTimeout(scheduleBlink, WAKE_AT_MS + 900);
}

// ---------- gaze ----------

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

if (!reducedMotion.matches && !coarsePointer.matches && portrait) {
  let px = 0;
  let py = 0;
  let raf = 0;

  const update = (): void => {
    raf = 0;
    const r = portrait.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.42;
    const gx = clamp((px - cx) / (window.innerWidth / 2), -1, 1);
    const gy = clamp((py - cy) / (window.innerHeight / 2), -1, 1);
    root.style.setProperty("--gx", `${(gx * 3.2).toFixed(2)}px`);
    root.style.setProperty("--gy", `${(gy * 2.2).toFixed(2)}px`);
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      px = event.clientX;
      py = event.clientY;
      if (!raf) raf = requestAnimationFrame(update);
    },
    { passive: true },
  );

  document.addEventListener("pointerleave", () => {
    root.style.setProperty("--gx", "0px");
    root.style.setProperty("--gy", "0px");
  });
}

// ---------- her voice ----------

const audio = byId("voice", HTMLAudioElement);
const button = byId("meet", HTMLButtonElement);
const label = byId("meet-label", HTMLSpanElement);
const captionEl = byId("caption", HTMLParagraphElement);

const speaker = createLipSync(audio, mouth, parseCueSheet(cueSheet), intro.captions, captionEl, root);

type State = "idle" | "playing" | "done";

const LABELS: Record<State, string> = {
  idle: "Tap to meet Aida",
  playing: "Stop",
  done: "Hear her again",
};

function setState(state: State): void {
  button.dataset.state = state;
  label.textContent = LABELS[state];
  root.classList.toggle("is-speaking", state === "playing");
}

button.addEventListener("click", () => {
  if (!audio.paused) {
    audio.pause();
    audio.currentTime = 0;
    speaker.stop();
    setState("done");
    return;
  }
  audio.currentTime = 0;
  audio.play().then(
    () => {
      setState("playing");
      speaker.start();
    },
    () => {
      // No audio available (or blocked): still let her say it.
      captionEl.textContent = intro.line;
      setState("done");
    },
  );
});

audio.addEventListener("ended", () => {
  setState("done");
});
audio.addEventListener("pause", () => {
  if (!audio.ended) speaker.stop();
});

// Fetch the recording only once the entrance has settled, so it never
// competes with first paint. It is a few tens of kilobytes.
setTimeout(
  () => {
    audio.preload = "auto";
    audio.load();
  },
  reducedMotion.matches ? 600 : SETTLED_AT_MS,
);
