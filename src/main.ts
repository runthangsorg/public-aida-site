import "./styles.css";
import cues from "./intro-cues.json";
import intro from "./intro.json";
import { playEntrance, popWord, splitLetters } from "./kinetic";
import { spokenCount, timeWords, type TimedWord } from "./words";

const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

function byId<T extends Element>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing #${id}`);
  return el;
}

function one(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return el;
}

// ---------- the entrance ----------

if (still) {
  root.classList.add("is-still");
} else {
  root.classList.add("is-motion");
  const split = (selector: string): HTMLElement[] => splitLetters(one(selector));
  void playEntrance({
    glow: one(".glow"),
    rays: one(".rays"),
    hello: split(".line-hello .word"),
    helloLine: one(".line-hello"),
    im: split(".line-name .im"),
    name: split(".line-name .name"),
    sweep: one(".sweep"),
    soon: one(".soon"),
    controls: one(".controls"),
  }).then(() => {
    root.classList.add("is-settled");
  });
}

// Pause the ambient loops while the tab is hidden.
document.addEventListener("visibilitychange", () => {
  root.classList.toggle("is-hidden", document.hidden);
});

// ---------- her voice ----------

const audio = byId("voice", HTMLAudioElement);
const button = byId("meet", HTMLButtonElement);
const label = byId("meet-label", HTMLSpanElement);
const spoken = byId("spoken", HTMLParagraphElement);

const words: TimedWord[] = timeWords(intro.captions, cues.duration);

type State = "idle" | "playing" | "done";
const LABELS: Record<State, string> = { idle: "Hear her say hello", playing: "Stop", done: "Hear her again" };

function setState(state: State): void {
  button.dataset.state = state;
  label.textContent = LABELS[state];
  root.classList.toggle("is-speaking", state === "playing");
}

// The glow follows the loudness of her voice. The audio graph is built on the
// first tap (browsers only allow sound after one) and only once: an element
// can feed a single MediaElementSource.
let analyser: AnalyserNode | null = null;
let samples: Uint8Array<ArrayBuffer> | null = null;

function listen(): void {
  if (analyser || still) return;
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    source.connect(analyser);
    analyser.connect(ctx.destination);
    void ctx.resume();
  } catch {
    analyser = null; // She still speaks; the glow just stays calm.
  }
}

let shown = 0;
let level = 0;
let raf = 0;

function frame(): void {
  raf = 0;
  if (analyser && samples) {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / samples.length);
    level += (Math.min(1, rms * 4) - level) * 0.25;
    root.style.setProperty("--level", level.toFixed(3));
  }
  const due = spokenCount(words, audio.currentTime);
  while (shown < due) {
    const w = words[shown];
    if (!w) break;
    if (w.lead) spoken.textContent = "";
    const span = document.createElement("span");
    span.className = "w";
    span.textContent = w.word;
    spoken.append(span, " ");
    if (!still) popWord(span);
    shown++;
  }
  if (!audio.paused) raf = requestAnimationFrame(frame);
}

function stopListening(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  level = 0;
  root.style.setProperty("--level", "0");
}

button.addEventListener("click", () => {
  if (!audio.paused) {
    audio.pause();
    audio.currentTime = 0;
    stopListening();
    setState("done");
    return;
  }
  listen();
  audio.currentTime = 0;
  shown = 0;
  spoken.textContent = "";
  audio.play().then(
    () => {
      setState("playing");
      raf = requestAnimationFrame(frame);
    },
    () => {
      // No audio (or it was blocked): she still says it, in words.
      spoken.textContent = intro.line;
      setState("done");
    },
  );
});

audio.addEventListener("ended", () => {
  stopListening();
  setState("done");
});

// Fetch the recording once the entrance has landed, so it never competes with
// first paint. It is a few tens of kilobytes.
setTimeout(
  () => {
    audio.preload = "auto";
    audio.load();
  },
  still ? 600 : 3600,
);
