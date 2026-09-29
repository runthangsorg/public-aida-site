import "./styles.css";
import cues from "./intro-cues.json";
import intro from "./intro.json";
import { beatAt, beatsFrom } from "./beats";
import { mouthAt, readCues, type Mouth } from "./lipsync";
import { countUp, entrance, fit, jolt, popWord, stamp } from "./motion";
import { spokenCount, timeWords } from "./words";

const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

function byId<T extends Element>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing #${id}`);
  return el;
}

const scene = byId("scene", HTMLDivElement);
const art = byId("art", HTMLDivElement);
const head = byId("head", HTMLDivElement);
const bigword = byId("bigword", HTMLDivElement);
const spoken = byId("spoken", HTMLParagraphElement);
const ready = byId("ready", HTMLSpanElement);
const audio = byId("voice", HTMLAudioElement);
const button = byId("meet", HTMLButtonElement);
const label = byId("meet-label", HTMLSpanElement);

const words = timeWords(intro.captions, cues.duration);
const beats = beatsFrom(words);
const mouthCues = readCues(cues.cues);

// Today, as the broadcast date on the ON AIR tape.
const now = new Date();
byId("date", HTMLSpanElement).textContent = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  .map((n) => String(n).padStart(2, "0"))
  .join(".");

// ---------- her face ----------

function setMouth(mouth: Mouth): void {
  if (head.dataset.mouth !== mouth) head.dataset.mouth = mouth;
}

// She blinks every few seconds, sometimes twice.
function blinkLater(): void {
  setTimeout(() => {
    if (!document.hidden) {
      head.classList.add("is-blinking");
      setTimeout(() => {
        head.classList.remove("is-blinking");
      }, 110);
      if (Math.random() < 0.2) {
        setTimeout(() => {
          head.classList.add("is-blinking");
        }, 260);
        setTimeout(() => {
          head.classList.remove("is-blinking");
        }, 370);
      }
    }
    blinkLater();
  }, 2200 + Math.random() * 3200);
}

// ---------- the performance ----------
// One loop drives mouth, captions and big words from a clock: the recording's
// own time when she is heard, a plain timer when the browser keeps her silent.

type Mode = "waiting" | "silent" | "sound" | "done";
type State = "waiting" | "muted" | "playing" | "done";
const LABELS: Record<State, string> = {
  waiting: "Tap to hear her",
  muted: "Tap to hear her",
  playing: "Stop",
  done: "Hear her again",
};

let mode: Mode = "waiting";
let clock = (): number => 0;
let heard = false;
let shown = 0;
let beat = -1;
let raf = 0;

function setState(state: State): void {
  button.dataset.state = state;
  label.textContent = LABELS[state];
}

function reset(): void {
  shown = 0;
  beat = -1;
  spoken.textContent = "";
}

function frame(): void {
  raf = 0;
  const t = clock();
  setMouth(mouthAt(mouthCues, t));
  if (analyser && samples) {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    level += (Math.min(1, Math.sqrt(sum / samples.length) * 4) - level) * 0.25;
    root.style.setProperty("--level", level.toFixed(3));
  }
  const due = spokenCount(words, t);
  while (shown < due) {
    const w = words[shown];
    if (!w) break;
    if (w.lead) spoken.textContent = "";
    spoken.querySelector(".now")?.classList.remove("now");
    const span = document.createElement("span");
    span.className = "w now";
    span.textContent = w.word;
    spoken.append(span, " ");
    if (!still) popWord(span);
    shown++;
  }
  const b = beatAt(beats, t);
  if (b !== beat && b >= 0) {
    beat = b;
    scene.dataset.tone = String(b);
    const next = beats[b];
    if (next) stamp(bigword, next.text, still);
    if (!still) jolt(art);
  }
  const over = mode === "sound" ? audio.ended : t >= cues.duration;
  if (over) {
    finish();
    return;
  }
  raf = requestAnimationFrame(frame);
}

function perform(next: Mode, from: () => number): void {
  if (raf) cancelAnimationFrame(raf);
  mode = next;
  clock = from;
  reset();
  scene.classList.add("is-talking");
  raf = requestAnimationFrame(frame);
}

function finish(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  mode = "done";
  setMouth("closed");
  scene.classList.remove("is-talking");
  scene.classList.add("is-done");
  level = 0;
  root.style.setProperty("--level", "0");
  spoken.querySelector(".now")?.classList.remove("now");
  setState(heard ? "done" : "muted");
}

// The glow behind her follows the loudness of her voice. The graph is built
// only inside a tap: routing the element through an AudioContext that the
// browser has not let start would silence her.
let analyser: AnalyserNode | null = null;
let samples: Uint8Array<ArrayBuffer> | null = null;
let level = 0;

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

/**
 * Play her line with sound. Resolves false if the browser will not allow it
 * yet. A later attempt (a tap while the first is still loading) supersedes an
 * earlier one, and only the newest may pause or start the performance.
 */
let generation = 0;
async function speak(fromTap: boolean): Promise<boolean> {
  if (fromTap) listen();
  const mine = ++generation;
  audio.currentTime = 0;
  let timer = 0;
  try {
    await Promise.race([
      audio.play(),
      new Promise((_, fail) => {
        timer = window.setTimeout(() => {
          fail(new Error("the voice took too long"));
        }, 4000);
      }),
    ]);
  } catch {
    if (mine === generation) audio.pause();
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (mine !== generation) return true;
  heard = true;
  setState("playing");
  perform("sound", () => audio.currentTime);
  return true;
}

/** No sound allowed yet: she says it anyway, in captions, and waits for a tap. */
function speakSilently(): void {
  setState("muted");
  const t0 = performance.now();
  perform("silent", () => (performance.now() - t0) / 1000);
}

/** Nothing has started her yet: no sound, no silent run. (A function, so it is read when called.) */
function untouched(): boolean {
  return !heard && mode === "waiting";
}

function stop(): void {
  audio.pause();
  finish();
}

button.addEventListener("click", () => {
  if (mode === "sound") {
    stop();
    return;
  }
  void speak(true).then((ok) => {
    if (!ok && mode !== "silent") speakSilently();
  });
});

// Any first tap or key press on the page is the permission the browser wants:
// she starts again, this time out loud. It has to be pointerup, not
// pointerdown: under the HTML spec's user-activation rules a finger's
// pointerdown grants nothing (only its pointerup or touchend does), so on a
// phone play() would still be refused. A mouse has activation from its press
// by the time it is released, so one listener covers both.
function firstTouch(event: Event): void {
  if (heard) return;
  if (event.target instanceof Node && button.contains(event.target)) return;
  if (event instanceof KeyboardEvent && ["Tab", "Shift", "Alt", "Control", "Meta", "Escape"].includes(event.key)) return;
  void speak(true);
}
document.addEventListener("pointerup", firstTouch);
document.addEventListener("keydown", firstTouch);

document.addEventListener("visibilitychange", () => {
  root.classList.toggle("is-hidden", document.hidden);
});

addEventListener("resize", () => {
  for (const w of bigword.querySelectorAll<HTMLElement>(".bw:not(.bw-out)")) fit(w);
});

// ---------- start ----------

if (still) {
  root.classList.add("is-still");
} else {
  root.classList.add("is-motion");
  spoken.textContent = ""; // her words arrive as she says them
}

async function start(): Promise<void> {
  await document.fonts.load("100px Anton").catch(() => undefined);
  if (still) {
    const first = beats[0];
    if (first) stamp(bigword, first.text, true);
    spoken.textContent = intro.line;
    setState("waiting");
    return;
  }
  blinkLater();
  countUp(ready, 97, 900, 700);
  await entrance({
    burst: byId("burst", HTMLDivElement),
    aida: byId("aida", HTMLDivElement),
    labels: Array.from(document.querySelectorAll<HTMLElement>("[data-slap]")),
    settle: () => {
      root.classList.add("is-settled");
    },
  });
  if (!untouched()) return; // a tap already started her
  const ok = await speak(false);
  if (!ok && untouched()) speakSilently();
}

void start();
