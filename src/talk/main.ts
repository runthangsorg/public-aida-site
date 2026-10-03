import "./talk.css";
import type { Mouth } from "../lipsync";
import { FIELDS, MAX_LENGTH, TEAM_SIZES, checkDetails, refusal, startBody, type Field } from "./details";
import { mouthFor, type MouthShape } from "./mouth";
import { NOTE_SECTIONS, noteLabel, type NoteSection, type Stage } from "./protocol";
import {
  formatClock,
  groupNotes,
  initialState,
  latestTurns,
  progress,
  reduce,
  stageStatus,
  turnText,
  type TalkEvent,
  type TalkState,
} from "./state";
import { renderNotes, renderSummary } from "./swot";
import { MicError, Voice, type MicProblem } from "./voice";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

// A weak machine gets a still face and a plain "speaking" light instead of a
// moving mouth: four cores or fewer, 4 GB of memory or less, or a visitor who
// asked for less motion.
const nav = navigator as Navigator & { deviceMemory?: number };
const lowPower =
  still ||
  (nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) ||
  (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4);
document.documentElement.classList.toggle("low-power", lowPower);

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing #${id}`);
  return el;
}

const app = byId("app", HTMLDivElement);
const screens = {
  intro: byId("intro", HTMLElement),
  details: byId("details", HTMLElement),
  mic: byId("mic", HTMLElement),
  room: byId("room", HTMLElement),
  end: byId("end-screen", HTMLElement),
};
type Screen = keyof typeof screens;

function show(name: Screen, focus = true): void {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  app.dataset.screen = name;
  window.scrollTo(0, 0);
  if (!focus) return;
  const heading = screens[name].querySelector<HTMLElement>("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

// ---------- her face, wherever the page shows her ----------

const template = byId("face", HTMLTemplateElement);
const heads: HTMLElement[] = [];
for (const host of document.querySelectorAll<HTMLElement>("[data-face]")) {
  const face = template.content.firstElementChild?.cloneNode(true);
  if (!(face instanceof HTMLElement)) continue;
  // Only the room's face speaks; the others keep just her portrait and the blink.
  if (host.id !== "stage") for (const m of face.querySelectorAll(".mouth")) m.remove();
  host.append(face);
  heads.push(face);
}
const roomHead = byId("stage", HTMLDivElement).querySelector<HTMLElement>(".head");

// She blinks every few seconds: one class on the faces of the screen in view,
// nothing measured, nothing running in between.
function blinkLater(): void {
  setTimeout(
    () => {
      if (!document.hidden) {
        const name = app.dataset.screen as Screen | undefined;
        const visible = name ? Array.from(screens[name].querySelectorAll<HTMLElement>(".head")) : [];
        for (const h of visible) h.classList.add("is-blinking");
        setTimeout(() => {
          for (const h of visible) h.classList.remove("is-blinking");
        }, 120);
      }
      blinkLater();
    },
    2400 + Math.random() * 3400,
  );
}
if (!lowPower) blinkLater();

// ---------- 1. consent ----------

const consent = byId("consent", HTMLInputElement);
const consentError = byId("consent-error", HTMLParagraphElement);

function setError(el: HTMLElement, message: string | undefined): void {
  el.hidden = !message;
  el.textContent = message ?? "";
}

consent.addEventListener("change", () => {
  if (consent.checked) {
    setError(consentError, undefined);
    consent.removeAttribute("aria-invalid");
  }
});

byId("consent-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  if (!consent.checked) {
    setError(consentError, "Please tick the box to agree before you start.");
    consent.setAttribute("aria-invalid", "true");
    consent.focus();
    return;
  }
  show("details");
});

// ---------- 2. details ----------

const form = byId("details-form", HTMLFormElement);
const alertBox = byId("form-alert", HTMLDivElement);
const go = byId("details-go", HTMLButtonElement);
const goLabel = go.querySelector<HTMLElement>(".label");

const chips = byId("team-sizes", HTMLDivElement);
TEAM_SIZES.forEach((size, i) => {
  const label = document.createElement("label");
  label.className = "chip";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "teamSize";
  input.value = size;
  input.id = `f-teamSize-${i}`;
  label.append(input, document.createTextNode(size));
  chips.append(label);
});

function control(field: Field): HTMLElement | null {
  return field === "teamSize"
    ? chips.querySelector<HTMLInputElement>("input")
    : document.getElementById(`f-${field}`);
}

function showFieldErrors(errors: Partial<Record<Field | "consent", string>>): void {
  let first: HTMLElement | null = null;
  for (const field of FIELDS) {
    const message = errors[field];
    const el = document.getElementById(`e-${field}`);
    if (el) setError(el, message);
    const input = control(field);
    const targets = field === "teamSize" ? Array.from(chips.querySelectorAll("input")) : input ? [input] : [];
    for (const t of targets) {
      if (message) t.setAttribute("aria-invalid", "true");
      else t.removeAttribute("aria-invalid");
    }
    if (message && !first) first = input;
  }
  first?.focus();
}

function readForm(): Partial<Record<Field, string>> {
  const data = new FormData(form);
  const out: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    const v = data.get(f);
    out[f] = typeof v === "string" ? v.slice(0, MAX_LENGTH[f]) : "";
  }
  return out;
}

function busy(on: boolean): void {
  go.disabled = on;
  go.setAttribute("aria-busy", String(on));
  if (goLabel) goLabel.textContent = on ? "Starting…" : "Continue";
}

byId("details-back", HTMLButtonElement).addEventListener("click", () => {
  show("intro");
});

interface Session {
  id: string;
  sections: Stage[];
  targetMinutes: number;
  name: string;
}

let session: Session | null = null;
const voice = new Voice(lowPower);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  alertBox.hidden = true;
  const checked = checkDetails(readForm());
  if (!checked.ok) {
    showFieldErrors(checked.errors);
    return;
  }
  showFieldErrors({});
  // Inside the click: the only moment the browser lets her voice start later.
  voice.wake();
  busy(true);
  void start(checked.details.name, startBody(checked.details));
});

function readSections(v: unknown): Stage[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s: unknown) => {
    if (typeof s !== "object" || s === null) return [];
    const { id, label } = s as Record<string, unknown>;
    return typeof id === "string" && id ? [{ id, label: typeof label === "string" && label ? label : id }] : [];
  });
}

async function start(name: string, body: Record<string, string | boolean>): Promise<void> {
  let res: Response;
  let data: unknown;
  try {
    res = await fetch("/api/talk/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => null);
  } catch {
    busy(false);
    showAlert("We couldn’t reach Aida. Check your connection and try again.");
    return;
  }
  busy(false);
  const ok = data as { id?: unknown; targetMinutes?: unknown; sections?: unknown } | null;
  if (!res.ok || typeof ok?.id !== "string" || !ok.id) {
    const r = refusal(res.ok ? 500 : res.status, data);
    showAlert(r.message);
    if (r.field === "consent") {
      show("intro");
      setError(consentError, r.message);
    } else if (r.field) {
      showFieldErrors({ [r.field]: r.message });
    }
    return;
  }
  const minutes = Number(ok.targetMinutes);
  session = {
    id: ok.id,
    sections: readSections(ok.sections),
    targetMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 20,
    name: name.split(" ")[0] ?? "",
  };
  void askForMic();
}

function showAlert(message: string): void {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

// ---------- 3. the microphone ----------

const micText = byId("mic-text", HTMLParagraphElement);
const micWait = byId("mic-wait", HTMLParagraphElement);
const micActions = byId("mic-actions", HTMLDivElement);

const MIC_TROUBLE: Record<MicProblem, string> = {
  denied:
    "Your browser is blocking the microphone. Allow it from the icon beside the address bar, then try again, or type your answers instead.",
  missing: "We couldn’t find a microphone. Plug one in and try again, or type your answers instead.",
  insecure: "The microphone only works over a secure connection. You can still type your answers.",
  unsupported: "This browser can’t share a microphone with the page. You can still type your answers.",
  failed: "The microphone didn’t start. Try again, or type your answers instead.",
};

async function askForMic(): Promise<void> {
  show("mic");
  micText.textContent = "Your browser is asking to use your microphone. Choose Allow and the conversation starts.";
  micWait.hidden = false;
  micActions.hidden = true;
  try {
    await voice.openMic();
  } catch (err) {
    micWait.hidden = true;
    micActions.hidden = false;
    micText.textContent = MIC_TROUBLE[err instanceof MicError ? err.problem : "failed"];
    byId("mic-retry", HTMLButtonElement).hidden = err instanceof MicError && (err.problem === "insecure" || err.problem === "unsupported");
    return;
  }
  enterRoom(false);
}

byId("mic-retry", HTMLButtonElement).addEventListener("click", () => {
  voice.wake();
  void askForMic();
});
byId("mic-type", HTMLButtonElement).addEventListener("click", () => {
  voice.wake();
  enterRoom(true);
});

// ---------- 4. the room ----------

const stageEl = byId("stage", HTMLDivElement);
const stagesEl = byId("stages", HTMLOListElement);
const stageLabel = byId("stage-label", HTMLSpanElement);
const stageCount = byId("stage-count", HTMLSpanElement);
const clock = byId("clock", HTMLSpanElement);
const clockOf = byId("clock-of", HTMLSpanElement);
const statusEl = byId("status", HTMLParagraphElement);
const statusText = byId("status-text", HTMLSpanElement);
const linkStatus = byId("link-status", HTMLParagraphElement);
const captions = byId("captions", HTMLDivElement);
const lineAida = byId("line-aida", HTMLDivElement);
const lineYou = byId("line-you", HTMLDivElement);
const saidAida = byId("said-aida", HTMLParagraphElement);
const saidYou = byId("said-you", HTMLParagraphElement);
const whoYou = byId("who-you", HTMLParagraphElement);
const hint = byId("hint", HTMLParagraphElement);
const announce = byId("announce", HTMLParagraphElement);
const muteBtn = byId("mute", HTMLButtonElement);
const muteLabel = byId("mute-label", HTMLSpanElement);
const typeBtn = byId("type", HTMLButtonElement);
const typer = byId("typer", HTMLFormElement);
const typed = byId("typed", HTMLInputElement);
const endBtn = byId("end", HTMLButtonElement);
const controls = byId("controls", HTMLDivElement);
const confirmBox = byId("confirm", HTMLDivElement);
const notebook = byId("notebook", HTMLElement);
const nbToggle = byId("nb-toggle", HTMLButtonElement);
const nbCount = byId("nb-count", HTMLSpanElement);
const nbLatest = byId("nb-latest", HTMLSpanElement);
const nbEmpty = byId("nb-empty", HTMLParagraphElement);
const nbGroups = byId("nb-groups", HTMLDivElement);

let state: TalkState = initialState();
let textOnly = false;
let muted = false;
let startedAt = 0;
let clockTimer = 0;
let resumedAt = 0;
let endTimer = 0;
let leaving = false;
let stagesKey = "";
let lastLink = "";

// Frames can arrive dozens of times a second (captions come a word at a
// time); the page is drawn at most about seven times a second from the
// latest state, and only the parts whose state changed are touched.
let drawn: TalkState | null = null;
let finishedSince: TalkState["finished"] = [];
let drawTimer = 0;

function dispatch(event: TalkEvent): void {
  const prev = state;
  state = reduce(state, event);
  if (state === prev) return;
  if (state.finished.length) finishedSince = [...finishedSince, ...state.finished];
  drawTimer ||= window.setTimeout(draw, 150);
}

function draw(): void {
  drawTimer = 0;
  const finished = finishedSince;
  finishedSince = [];
  render(drawn, { ...state, finished });
  drawn = state;
}

function enterRoom(typing: boolean): void {
  if (!session) return;
  textOnly = typing || !voice.hasMic;
  state = initialState(session.sections, session.targetMinutes);
  show("room", false);
  render(null, state);
  drawn = state;
  muteBtn.disabled = textOnly;
  if (textOnly) {
    muteLabel.textContent = "No mic";
    openTyper(true);
  }
  voice.connect(session.id, {
    onFrame: (frame) => {
      dispatch(frame);
    },
    onClose: () => {
      onSocketClosed();
    },
    onSpeaking: (on) => {
      renderStatus();
      drive(on);
    },
  });
  if (!lowPower && !textOnly) {
    voice.onMicLevel = (level) => {
      showMicLevel(level);
    };
  }
}

function onSocketClosed(): void {
  if (state.phase === "connecting") {
    // Never became ready: nothing happened yet, so go back to the form and say so.
    voice.close();
    show("details");
    showAlert("We couldn’t connect you to Aida just now. Please try again in a moment.");
    return;
  }
  dispatch({ kind: "closed", minutes: elapsed() / 60 });
}

function elapsed(): number {
  return startedAt ? (performance.now() - startedAt) / 1000 : 0;
}

function tick(): void {
  clock.textContent = formatClock(elapsed());
}

function renderStages(s: TalkState): void {
  const key = s.stages.map((st) => `${st.id}:${st.label}`).join("|");
  if (key !== stagesKey) {
    stagesKey = key;
    stagesEl.replaceChildren(
      ...s.stages.map((st) => {
        const li = document.createElement("li");
        li.dataset.id = st.id;
        const label = document.createElement("span");
        label.className = "st-label";
        label.textContent = st.label;
        li.append(label);
        return li;
      }),
    );
  }
  const p = progress(s);
  Array.from(stagesEl.children).forEach((li, i) => {
    if (!(li instanceof HTMLElement)) return;
    const status = stageStatus(i, p);
    li.dataset.status = status;
    if (status === "current") li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  if (s.phase === "connecting") {
    stageLabel.textContent = "Getting ready";
    stageCount.textContent = "";
  } else if (p.index >= p.total) {
    stageLabel.textContent = "Finished";
    stageCount.textContent = "";
  } else {
    stageLabel.textContent = p.label || "Getting started";
    stageCount.textContent = p.index >= 0 ? `${p.index + 1} of ${p.total}` : "";
  }
}

function statusOf(s: TalkState): [string, string] {
  if (s.phase === "connecting") return ["connecting", "Connecting"];
  if (s.phase === "ending") return ["ending", "Wrapping up"];
  if (s.phase === "ended") return ["ended", "Finished"];
  if (s.link === "reconnecting") return ["reconnecting", "Reconnecting, one moment"];
  if (s.link === "resumed" && performance.now() - resumedAt < 4000) return ["resumed", "Back on the line"];
  if (voice.isSpeaking) return ["speaking", "Aida is speaking"];
  if (textOnly) return ["listening", "Type your answer"];
  if (muted) return ["muted", "You’re muted"];
  return ["listening", "Listening"];
}

function renderStatus(): void {
  const [key, text] = statusOf(state);
  if (statusEl.dataset.state !== key) {
    statusEl.dataset.state = key;
    stageEl.dataset.speaking = String(key === "speaking");
  }
  if (statusText.textContent !== text) statusText.textContent = text;
  // Only changes to the line itself are announced; speaking and listening are visible, not read aloud.
  const linkKey = ["connecting", "reconnecting", "resumed", "ending"].includes(key) ? key : "live";
  if (linkKey !== lastLink) {
    linkStatus.textContent = linkKey === "live" ? (lastLink ? "Connected." : "") : `${text}.`;
    lastLink = linkKey;
  }
}

function setSaid(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  el.textContent = text;
  // Keep her newest words, and so her question, in view. Only a caption that
  // overflows needs scrolling; one layout read per draw, not per word.
  const over = el.scrollHeight - el.clientHeight;
  if (over > 1) el.scrollTop = over;
  if (el.parentElement) el.parentElement.dataset.clipped = String(over > 1);
}

function renderCaptions(s: TalkState): void {
  const latest = latestTurns(s);
  lineAida.hidden = !latest.aida;
  lineYou.hidden = !latest.you;
  hint.hidden = Boolean(latest.aida ?? latest.you) && !s.error;
  if (s.error) hint.textContent = s.error;
  if (latest.aida) {
    setSaid(saidAida, turnText(latest.aida) + (latest.aida.interrupted ? " …" : ""));
    lineAida.dataset.open = String(latest.aida.open);
  }
  if (latest.you) {
    setSaid(saidYou, turnText(latest.you));
    whoYou.textContent = latest.you.typed ? "You, typed" : "You";
  }
  captions.dataset.last = latest.last ?? "";
}

const groupEls = new Map<NoteSection, HTMLUListElement>();

function noteGroup(section: NoteSection): HTMLUListElement {
  const existing = groupEls.get(section);
  if (existing) return existing;
  const order: NoteSection[] = [...NOTE_SECTIONS.map(([id]) => id), "other"];
  const wrap = document.createElement("section");
  wrap.className = "nb-group";
  wrap.dataset.section = section;
  const h = document.createElement("h3");
  h.textContent = noteLabel(section);
  const ul = document.createElement("ul");
  wrap.append(h, ul);
  // In the notebook's order, not the order she happened to file them.
  const after = Array.from(nbGroups.children).find((el) => {
    const other = (el as HTMLElement).dataset.section as NoteSection | undefined;
    return other !== undefined && order.indexOf(other) > order.indexOf(section);
  });
  nbGroups.insertBefore(wrap, after ?? null);
  groupEls.set(section, ul);
  return ul;
}

function renderNotesLive(prev: TalkState | null, s: TalkState): void {
  const known = new Set(prev?.notes.map((n) => n.id));
  for (const note of s.notes) {
    if (known.has(note.id)) continue;
    const li = document.createElement("li");
    li.textContent = note.text;
    if (prev) li.className = "fresh";
    noteGroup(note.section).append(li);
    if (prev) {
      setTimeout(() => {
        li.classList.remove("fresh");
      }, 2600);
    }
  }
  const count = s.notes.length;
  nbEmpty.hidden = count > 0;
  nbCount.textContent = count === 1 ? "1 note" : count ? `${count} notes` : "Notes";
  const last = s.notes[s.notes.length - 1];
  if (last && last.id !== prev?.notes[prev.notes.length - 1]?.id) {
    nbLatest.textContent = last.text;
    nbToggle.classList.remove("pulse");
    if (prev && !still) {
      requestAnimationFrame(() => {
        nbToggle.classList.add("pulse"); // a frame later, so the highlight restarts
      });
    }
  }
}

function render(prev: TalkState | null, s: TalkState): void {
  const changed = (...keys: (keyof TalkState)[]): boolean => !prev || keys.some((k) => prev[k] !== s[k]);
  if (changed("stages", "stage", "phase")) renderStages(s);
  if (changed("targetMinutes")) clockOf.textContent = `of about ${s.targetMinutes} min`;
  if (s.phase !== "connecting" && !startedAt) {
    startedAt = performance.now();
    clockTimer = window.setInterval(tick, 1000);
  }
  if (s.link === "resumed" && prev?.link !== "resumed") {
    resumedAt = performance.now();
    setTimeout(renderStatus, 4100);
  }
  if (changed("link", "phase")) renderStatus();
  if (changed("turns", "error")) renderCaptions(s);
  if (changed("notes")) renderNotesLive(prev, s);
  if (s.finished.length) announce.textContent = s.finished.map((t) => `${t.who === "aida" ? "Aida" : "You"}: ${turnText(t)}`).join(" ");
  if (!changed("phase")) return;
  const ending = s.phase === "ending" || s.phase === "ended";
  endBtn.disabled = ending;
  typeBtn.disabled = ending;
  muteBtn.disabled = ending || textOnly;
  if (ending) {
    closeConfirm(false);
    typer.hidden = true;
  }
  if (s.phase === "ended" && prev?.phase !== "ended") leave();
}

// Her mouth follows her voice: 12 times a second (drawn animation's "on
// twos"), read from the playback analyser, and only while she is actually
// speaking. When she stops, the timer stops; nothing runs while the room is
// quiet. A change touches the opacity of two small images, each on its own
// compositor layer, and nothing else. A low-power machine keeps a still face
// and a ring says she is speaking.
const shape: MouthShape = { open: 0, spread: 0.5 };
let mouth: Mouth = "closed";
let mouthTimer = 0;
const mouthImages = new Map<Mouth, HTMLElement>();
for (const m of ["small", "mid", "wide", "round", "pucker"] as const) {
  const img = roomHead?.querySelector<HTMLElement>(`.m-${m}`);
  if (img) mouthImages.set(m, img);
}

let mouthSince = 0;

function setMouth(next: Mouth, force = false): void {
  if (next === mouth) return;
  // Each drawing is held for 200 ms at least, so a syllable reads as a shape
  // and the page redraws five times a second at most; closing is immediate.
  const now = performance.now();
  if (!force && next !== "closed" && now - mouthSince < 200) return;
  mouthSince = now;
  const before = mouthImages.get(mouth);
  if (before) before.style.opacity = "0";
  const after = mouthImages.get(next);
  if (after) after.style.opacity = "1";
  mouth = next;
}

function stepMouth(): void {
  if (document.hidden) return;
  setMouth(mouthFor(voice.readMouth(shape)));
}

function drive(speaking: boolean): void {
  if (lowPower) return;
  if (speaking && !mouthTimer) {
    mouthTimer = window.setInterval(stepMouth, 83);
  } else if (!speaking && mouthTimer) {
    window.clearInterval(mouthTimer);
    mouthTimer = 0;
    setMouth("closed", true);
  }
}

// The ring on the microphone button lights while she can hear you. It is a
// state, not a meter: it lights when your voice rises above one level and
// goes out only after 700 ms below a lower one, so a sentence costs two
// style changes, not ten a second.
let hearing = false;
let lastLoud = 0;
function showMicLevel(level: number): void {
  const now = performance.now();
  if (level > 0.05) lastLoud = now;
  const next = muted ? false : hearing ? now - lastLoud < 700 : level > 0.1;
  if (next === hearing) return;
  hearing = next;
  muteBtn.dataset.hearing = String(next);
}

muteBtn.addEventListener("click", () => {
  muted = !muted;
  voice.setMuted(muted);
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteLabel.textContent = muted ? "Unmute" : "Mute";
  showMicLevel(0);
  renderStatus();
});

function openTyper(open: boolean): void {
  typer.hidden = !open;
  typeBtn.setAttribute("aria-expanded", String(open));
  if (open) typed.focus();
}

typeBtn.addEventListener("click", () => {
  openTyper(typer.hidden);
});

typer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = typed.value.trim();
  if (!text || state.phase !== "live") return;
  voice.sendText(text);
  dispatch({ kind: "typed", text });
  typed.value = "";
});

typed.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !textOnly) {
    openTyper(false);
    typeBtn.focus();
  }
});

function closeConfirm(focusEnd: boolean): void {
  confirmBox.hidden = true;
  controls.hidden = false;
  if (focusEnd) endBtn.focus();
}

endBtn.addEventListener("click", () => {
  controls.hidden = true;
  confirmBox.hidden = false;
  byId("confirm-no", HTMLButtonElement).focus();
});
byId("confirm-no", HTMLButtonElement).addEventListener("click", () => {
  closeConfirm(true);
});
confirmBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeConfirm(true);
});
byId("confirm-yes", HTMLButtonElement).addEventListener("click", () => {
  if (state.phase !== "live" && state.phase !== "connecting") return;
  voice.end();
  dispatch({ kind: "end-pressed" });
  // The summary and the end should follow within seconds; never wait forever.
  endTimer = window.setTimeout(() => {
    voice.close();
    dispatch({ kind: "closed", minutes: elapsed() / 60 });
  }, 25_000);
});

function setNotebook(open: boolean): void {
  notebook.dataset.open = String(open);
  nbToggle.setAttribute("aria-expanded", String(open));
  if (open) byId("nb-close", HTMLButtonElement).focus();
}
nbToggle.addEventListener("click", () => {
  setNotebook(notebook.dataset.open !== "true");
});
byId("nb-close", HTMLButtonElement).addEventListener("click", () => {
  setNotebook(false);
  nbToggle.focus();
});
// A tap on the dimmed room behind the open sheet closes it.
notebook.addEventListener("click", (event) => {
  if (event.target === notebook && notebook.dataset.open === "true") {
    setNotebook(false);
    nbToggle.focus();
  }
});
notebook.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && notebook.dataset.open === "true") {
    setNotebook(false);
    nbToggle.focus();
  }
});

// Any tap in the room may be what lets a suspended audio context run.
screens.room.addEventListener("pointerup", () => {
  voice.wake();
});

// ---------- 5. what she heard ----------

function leave(): void {
  if (leaving) return;
  leaving = true;
  window.clearTimeout(endTimer);
  window.clearInterval(clockTimer);
  tick();
  voice.onMicLevel = null;
  voice.stopMic();
  // Let her last words play out (up to a few seconds), then close the line.
  const wait = Math.min(8000, voice.queued * 1000 + 600);
  setTimeout(() => {
    drive(false);
    voice.close();
    showEnd();
  }, wait);
}

function showEnd(): void {
  const title = byId("end-title", HTMLHeadingElement);
  const lede = byId("end-lede", HTMLParagraphElement);
  const readback = byId("readback", HTMLDivElement);
  const name = session?.name ?? "";
  title.textContent = name ? `Thank you, ${name}` : "Thank you";
  const reason = state.ended?.reason;
  if (state.summary) {
    readback.innerHTML = `<h2 class="visually-hidden">What Aida heard</h2>${renderSummary(state.summary)}`;
    lede.textContent = "Here is what Aida heard. The Aida team will read it and be in touch soon.";
  } else {
    readback.innerHTML = `<h2 class="readback-title">Aida’s notes</h2><div class="nb-sheet">${renderNotes(groupNotes(state.notes))}</div>`;
    lede.textContent =
      reason === "lost"
        ? "The line dropped before the end. Here are the notes she took. The Aida team will be in touch soon."
        : "Here are the notes she took. The Aida team will read them and be in touch soon.";
  }
  const minutes = state.ended?.minutes ?? elapsed() / 60;
  const ceiling = reason === "ceiling" ? " She stopped at the time limit." : "";
  byId("end-meta", HTMLParagraphElement).textContent = `You talked for ${Math.max(1, Math.round(minutes))} min.${ceiling}`;
  app.dataset.ending = reason ?? "";
  show("end");
}
