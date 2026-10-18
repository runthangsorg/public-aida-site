import "./talk.css";
import type { Mouth } from "../lipsync";
import { FIELDS, MAX_LENGTH, TEAM_SIZES, checkDetails, startBody, type Field } from "./details";
import { mouthFor, type MouthShape } from "./mouth";
import { NOTE_SECTIONS, noteLabel, type NoteSection, type Resumed, type Stage, setRelayOrigin } from "./protocol";
import {
  looksLikeEmail,
  pausedCopy,
  readResumeReply,
  relinkOutcome,
  resumeRefusal,
  savedCopy,
  RELINK_INVALID,
} from "./resume";
import {
  BUDGET_LEDE,
  DROPPED_LEDE,
  DROPPED_STILL_CLOSING,
  MIC_PROMPT_HELP_MS,
  MIC_STILL_WAITING,
  connectFailedText,
  DECLINED_CLOSING,
  EXPIRED_GO,
  IDLE_CLOSING,
  SWITCHING_CLOSING,
  VIDEO_STOPPED_CLOSING,
  NETWORK_TRY_AGAIN,
  confirmRefusal,
  entryFor,
  entryRefusal,
  idleSentence,
  knownCopy,
  readContinued,
  readMe,
  readOpened,
  readStartReply,
  resendLabel,
  resendOutcome,
  secondsLeft,
  takeLanding,
  type Opened,
} from "./gate";
import {
  formatClock,
  groupNotes,
  noteStamp,
  initialState,
  endView,
  latestTurns,
  progress,
  reduce,
  stageStatus,
  turnText,
  type TalkEvent,
  type TalkState,
} from "./state";
import { renderNotes, renderSummary } from "./swot";
import { DROPPED_STATUS, RECONNECT_RETRY_MS, reconnecting, startReconnect, stepReconnect, type Reconnect } from "./reconnect";
import {
  GATE_FAILED,
  HumanCheck,
  TOKEN_HEADER,
  loadTurnstile,
  withToken,
  type TurnstileApi,
} from "./turnstile";
import {
  AvatarPlayer,
  avatarParam,
  faceFor,
  nextFace,
  type Face,
  type FaceEvent,
  capabilityOf,
  dataNote,
  decideAvatar,
  rememberVoiceOnly,
  type AvatarAsk,
  type FailReason,
  type MseWindow,
} from "./avatar";
import { MicError, Voice, type MicProblem } from "./voice";


// Where the live call runs (the site's owner may move it off this host): read once, early. Absent or wrong
// means the call runs on this site, as before.
void fetch("/talk/relay.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((j: unknown) => {
    setRelayOrigin((j as { url?: unknown } | null)?.url, location.hostname);
  })
  .catch(() => undefined);

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
  check: byId("check", HTMLElement),
  mic: byId("mic", HTMLElement),
  room: byId("room", HTMLElement),
  end: byId("end-screen", HTMLElement),
};
type Screen = keyof typeof screens;

function show(name: Screen, focus = true): void {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  app.dataset.screen = name;
  // The person check's script is loaded the first time the details form is shown, never before.
  if (name === "details") void check.prepare().catch(() => undefined);
  window.scrollTo(0, 0);
  if (!focus) return;
  const heading = screens[name].querySelector<HTMLElement>("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

// ---------- her face, wherever the page shows her ----------

// Which face she wears is decided once, here, before anything is drawn, from the same decision as the
// video choice (Media Source, the codec, no data saver, not "voice only" chosen earlier): so there is no
// flash of the drawn face first. The drawn Aida, with her mouth and blink patches, is kept for the
// voice-only path only; the face changes only if the call turns out to be voice only.
const templates = { drawn: byId("face", HTMLTemplateElement), vera: byId("face-vera", HTMLTemplateElement) };
let face: Face = faceFor(decideAvatar(capabilityOf(window as unknown as MseWindow)));
let roomHead: HTMLElement | null = null;

function drawFaces(): void {
  for (const host of document.querySelectorAll<HTMLElement>("[data-face]")) {
    for (const old of host.querySelectorAll(".head, .vera-still")) old.remove();
    const el = templates[face].content.firstElementChild?.cloneNode(true);
    if (!(el instanceof HTMLElement)) continue;
    // Only the room's drawn face speaks; the others keep just her portrait and the blink.
    if (face === "drawn" && host.id !== "stage") for (const m of el.querySelectorAll(".mouth")) m.remove();
    host.dataset.faceKind = face;
    host.append(el);
  }
  roomHead = byId("stage", HTMLDivElement).querySelector<HTMLElement>(".head");
}
drawFaces();

/** Her face, if the call has turned out to be voice only. */
function faceChanged(e: FaceEvent): void {
  const next = nextFace(face, e);
  if (next === face) return;
  face = next;
  drawFaces();
  bindMouths();
}

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
  /** Present when this is a returning conversation. */
  resumed?: Resumed;
}

let session: Session | null = null;
const voice = new Voice(lowPower);

// The invisible person check. Its script is not requested until the details form is first shown.
const check = new HumanCheck({
  load: () =>
    loadTurnstile({
      find: () => (window as Window & { turnstile?: TurnstileApi }).turnstile,
      add: (src, onload, onerror) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = onload;
        script.onerror = onerror;
        document.head.append(script);
        return () => {
          script.remove();
        };
      },
    }),
  container: byId("person-check", HTMLDivElement),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id);
  },
});

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

const gateFail = byId("gate-fail", HTMLDivElement);

/** The person check could not pass: say so plainly, and offer to try again (nothing was sent). */
function showGateFailure(): void {
  alertBox.hidden = true;
  byId("gate-fail-text", HTMLParagraphElement).textContent = GATE_FAILED;
  gateFail.hidden = false;
  byId("gate-retry", HTMLButtonElement).focus();
}

byId("gate-retry", HTMLButtonElement).addEventListener("click", () => {
  gateFail.hidden = true;
  form.requestSubmit();
});

async function start(name: string, body: Record<string, string | boolean>): Promise<void> {
  gateFail.hidden = true;
  const attempt = await withToken(check, async (token) => {
    try {
      const res = await fetch("/api/talk/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
        body: JSON.stringify(body),
      });
      return { res, data: (await res.json().catch(() => null)) as unknown };
    } catch {
      return null;
    }
  });
  busy(false);
  if (!attempt.ok) {
    // The check did not pass: nothing was submitted.
    showGateFailure();
    return;
  }
  if (!attempt.value) {
    showAlert("We couldn’t reach Aida. Check your connection and try again.");
    return;
  }
  const { res, data } = attempt.value;
  const reply = readStartReply(res.status, data);
  if (reply.kind === "refused") {
    const r = reply.refusal;
    if (r.gate) {
      showGateFailure();
      return;
    }
    showAlert(r.message);
    if (r.field === "consent") {
      show("intro");
      setError(consentError, r.message);
    } else if (r.field) {
      showFieldErrors({ [r.field]: r.message });
    }
    return;
  }
  if (reply.kind === "pending") {
    // A link has been emailed: wait for the click on it. No microphone yet.
    gateEmail = typeof body.email === "string" ? body.email : "";
    showCheck(reply.hint, reply.resendInSeconds);
    return;
  }
  // This browser already holds a session for the same address: straight to the microphone.
  openSession({ ...reply.opened, name: reply.opened.name || (name.split(" ")[0] ?? "") });
}

/** The one way into the microphone screen and the room, whichever door the person used. */
function openSession(opened: Opened): void {
  session = {
    id: opened.id,
    sections: opened.sections,
    targetMinutes: opened.targetMinutes,
    name: opened.name,
    ...(opened.resumed ? { resumed: opened.resumed } : {}),
  };
  gateEmail = "";
  void askForMic();
}

function showAlert(message: string): void {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

// ---------- 2b. check your email ----------

const checkHint = byId("check-hint", HTMLElement);
const checkResend = byId("check-resend", HTMLButtonElement);
const checkResendLabel = checkResend.querySelector<HTMLElement>(".label");
const checkStatus = byId("check-status", HTMLParagraphElement);

// The address the person typed, kept in memory only, for "send it again".
let gateEmail = "";
let resendEnds = 0;
let resendTimer = 0;

function resendTick(): void {
  const left = secondsLeft(resendEnds, performance.now());
  if (checkResendLabel) checkResendLabel.textContent = resendLabel(left);
  if (left <= 0) {
    window.clearInterval(resendTimer);
    resendTimer = 0;
    checkResend.disabled = false;
  }
}

function startResendCountdown(seconds: number): void {
  window.clearInterval(resendTimer);
  resendEnds = performance.now() + seconds * 1000;
  checkResend.disabled = true;
  resendTick();
  if (secondsLeft(resendEnds, performance.now()) > 0) resendTimer = window.setInterval(resendTick, 1000);
}

function showCheck(hint: string, seconds: number): void {
  checkHint.textContent = hint || "your email";
  checkStatus.textContent = "";
  show("check");
  startResendCountdown(seconds);
}

checkResend.addEventListener("click", () => {
  if (checkResend.disabled || !gateEmail) return;
  checkResend.disabled = true;
  checkStatus.textContent = "Sending…";
  void post("/api/talk/resend", { email: gateEmail })
    .then((r) => (r ? resendOutcome(r.status, r.data) : resendOutcome(0, null)))
    .then((outcome) => {
      checkStatus.textContent = outcome.message;
      if (outcome.ok) startResendCountdown(outcome.resendInSeconds ?? 120);
      else {
        checkResend.disabled = false;
        resendTick();
      }
    });
});

byId("check-different", HTMLButtonElement).addEventListener("click", () => {
  window.clearInterval(resendTimer);
  resendTimer = 0;
  gateEmail = "";
  show("details", false);
  document.getElementById("f-email")?.focus();
});

// ---------- 3. the microphone ----------

const micText = byId("mic-text", HTMLParagraphElement);
const micTitle = byId("mic-title", HTMLHeadingElement);
/** The microphone screen also opens a conversation and reports a line that would not open: its heading says which. */
function micHeading(kind: "mic" | "opening" | "failed"): void {
  micTitle.textContent = kind === "opening" ? "One moment" : kind === "failed" ? "The line did not open" : "Can she hear you?";
}
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

// Each press owns the screen until the next one: a late answer from an earlier question is ignored.
let micAttempt = 0;
let connectFails = 0;
const micRetry = byId("mic-retry", HTMLButtonElement);

async function askForMic(): Promise<void> {
  const attempt = ++micAttempt;
  micHeading("mic");
  show("mic");
  micText.textContent = "Your browser is asking to use your microphone. Choose Allow and the conversation starts.";
  micWait.hidden = false;
  micActions.hidden = true;
  micRetry.hidden = false;
  // A question nobody answers (dismissed, hidden, an in-app browser that never shows it) must not be a dead
  // end: after a few seconds, say so and offer the way round.
  const help = window.setTimeout(() => {
    if (attempt !== micAttempt) return;
    micText.textContent = MIC_STILL_WAITING;
    micWait.hidden = true; // the sentence says it is still waiting; the spinner line would say it twice
    micActions.hidden = false;
  }, MIC_PROMPT_HELP_MS);
  try {
    await voice.openMic();
  } catch (err) {
    window.clearTimeout(help);
    if (attempt !== micAttempt) return;
    micWait.hidden = true;
    micActions.hidden = false;
    micText.textContent = MIC_TROUBLE[err instanceof MicError ? err.problem : "failed"];
    micRetry.hidden = err instanceof MicError && (err.problem === "insecure" || err.problem === "unsupported");
    return;
  }
  window.clearTimeout(help);
  if (attempt !== micAttempt) {
    voice.stopMic(); // the person went another way while the browser was asking
    return;
  }
  startRoom(false);
}

/** Open the room; if anything throws on the way (the socket itself, the page), say so with a way to retry. */
function startRoom(typing: boolean): void {
  try {
    enterRoom(typing);
  } catch {
    connectFailed();
  }
}

/** The line did not open: stay on a screen with a plain message and a retry, never a silent return. */
function connectFailed(): void {
  voice.close();
  stopAvatar();
  connectFails++;
  micAttempt++;
  micHeading("failed");
  show("mic");
  micWait.hidden = true;
  micActions.hidden = false;
  micRetry.hidden = false;
  micText.textContent = connectFailedText(connectFails);
}

micRetry.addEventListener("click", () => {
  voice.wake();
  void askForMic();
});
byId("mic-type", HTMLButtonElement).addEventListener("click", () => {
  voice.wake();
  micAttempt++;
  startRoom(true);
});

// ---------- 4. the room ----------

const stageEl = byId("stage", HTMLDivElement);

// ---------- her video ----------
// Decided before connecting (what this browser and link can carry), confirmed by `ready.avatar`, and
// given up gracefully: if video fails the call is paused (the place is saved) and the person can go on
// by voice with one button. The drawn portrait sits under the video the whole time.

const videoEl = byId("avatar-video", HTMLVideoElement);
const voiceOnlyBtn = byId("voice-only", HTMLButtonElement);
const soundBtn = byId("avatar-sound", HTMLButtonElement);
let player: AvatarPlayer | null = null;

function avatarAsk(): AvatarAsk {
  return decideAvatar(capabilityOf(window as unknown as MseWindow));
}

// Said once, where a person is about to start: what video costs in data.
for (const note of document.querySelectorAll<HTMLElement>("[data-note]")) {
  const text = dataNote(avatarAsk());
  note.textContent = text;
  note.hidden = !text;
}

function startAvatar(): void {
  stopAvatar();
  player = new AvatarPlayer(videoEl, {
    onVisible: (visible) => {
      stageEl.dataset.video = visible ? "on" : "off";
    },
    onFail: (reason) => {
      videoGaveOut(reason);
    },
    onMuted: () => {
      soundBtn.hidden = false;
    },
  });
  if (!player.start()) {
    player = null;
    videoGaveOut("error");
    return;
  }
  videoEl.hidden = false;
  voiceOnlyBtn.hidden = false;
  stageEl.dataset.avatar = "on";
}

/** Tear it all down: stream, object URL, element. Safe when there is no video. */
function stopAvatar(): void {
  player?.stop();
  player = null;
  videoEl.hidden = true;
  voiceOnlyBtn.hidden = true;
  soundBtn.hidden = true;
  delete stageEl.dataset.avatar;
  delete stageEl.dataset.video;
}

function onAvatarFrame(frame: Parameters<typeof reduce>[1]): void {
  if (frame.kind === "aida") {
    const f = frame.frame;
    if (f.type === "ready") {
      // The server's word is the truth: it falls back to voice when the avatar would not start.
      connectFails = 0;
      carriedStart = 0;
      faceChanged({ t: "ready", asked: avatarParamAsked, avatar: f.avatar === true });
      if (f.avatar && avatarParamAsked) startAvatar();
      else stopAvatar();
    } else if (f.type === "reconnecting") player?.setReconnecting(true);
    else if (f.type === "resumed") player?.setReconnecting(false);
  } else if (frame.kind === "model" && frame.content.interrupted) {
    player?.interrupt();
  }
}

/** Did this call ask for video at all? (A `ready.avatar` we did not ask for is not trusted.) */
let avatarParamAsked = false;

function videoGaveOut(_reason: FailReason, switching = false): void {
  if (state.phase !== "live") return;
  // Save the place (no email: the page reconnects at once), stop listening, and end this call on purpose.
  voice.switchAway();
  stopAvatar();
  faceChanged({ t: "video-stopped" });
  dispatch({ kind: "video-stopped", switching });
  awaitEnd();
}

voiceOnlyBtn.addEventListener("click", () => {
  rememberVoiceOnly(safeStorage());
  videoGaveOut("error", true);
});
soundBtn.addEventListener("click", () => {
  soundBtn.hidden = true;
  player?.unmute();
});

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// A page that goes away must not leave a download running.
window.addEventListener("pagehide", () => {
  stopReconnecting();
  stopAvatar();
  voice.close();
});
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
const laterBtn = byId("later", HTMLButtonElement);
const confirmLater = byId("confirm-later", HTMLDivElement);
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

const defaultHint = hint.textContent;

/** The room as the first call left it, put back: a second call (continue after a pause) starts clean. */
function resetRoom(): void {
  stopAvatar();
  leaving = false;
  // An automatic reconnect carries the clock on, ticking, rather than starting it again from the server's figure.
  if (!carriedStart) {
    startedAt = 0;
    window.clearInterval(clockTimer);
  }
  window.clearTimeout(endTimer);
  window.clearTimeout(drawTimer);
  drawTimer = 0;
  drawn = null;
  finishedSince = [];
  stagesKey = "";
  lastLink = "";
  // A person who muted stays muted through an automatic reconnect (17 Oct: the reconnected room opened the
  // microphone again and picked up the room). A new conversation starts unmuted.
  if (!carriedStart) muted = false;
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteLabel.textContent = muted ? "Unmute" : "Mute";
  muteBtn.dataset.hearing = "false";
  hearing = false;
  nbGroups.replaceChildren();
  groupEls.clear();
  nbToggle.classList.remove("pulse");
  nbLatest.textContent = "She writes here as you talk";
  setNotebook(false, false);
  saidAida.textContent = "";
  saidYou.textContent = "";
  hint.textContent = defaultHint;
  announce.textContent = "";
  typed.value = "";
  typer.hidden = true;
  typeBtn.setAttribute("aria-expanded", "false");
  closeConfirm();
  if (!carriedStart) clock.textContent = formatClock(0);
  delete app.dataset.ending;
  byId("choices", HTMLFormElement).reset();
  byId("choices-go", HTMLButtonElement).disabled = false;
  byId("choices-status", HTMLParagraphElement).textContent = "";
}

function enterRoom(typing: boolean): void {
  if (!session) return;
  rejoined = carriedStart !== 0;
  resetRoom();
  const ask = avatarAsk();
  avatarParamAsked = avatarParam(ask) !== undefined;
  textOnly = typing || !voice.hasMic;
  state = initialState(session.sections, session.targetMinutes, session.resumed);
  show("room", false);
  render(null, state);
  drawn = state;
  muteBtn.disabled = textOnly;
  if (textOnly) {
    muteLabel.textContent = "No mic";
    openTyper(true);
  }
  voice.connect(
    session.id,
    {
      onFrame: (frame) => {
        onAvatarFrame(frame);
        dispatch(frame.kind === "aida" && frame.frame.type === "note" ? { ...frame, frame: { ...frame.frame, at: elapsed() } } : frame);
      },
      onClose: () => {
        stopAvatar();
        onSocketClosed();
      },
      onSpeaking: (on) => {
        renderStatus();
        drive(on);
      },
      onMedia: (bytes) => {
        player?.push(bytes);
      },
    },
    avatarParam(ask),
  );
  if (!lowPower && !textOnly) {
    voice.onMicLevel = (level) => {
      showMicLevel(level);
    };
  }
}

function onSocketClosed(): void {
  // The socket of a reconnect that closes again before `ready` is another drop, not a first connect failing.
  const afterReconnect = rc.phase === "done" && state.phase === "connecting";
  if (state.phase === "connecting" && !afterReconnect) {
    // Never became ready: nothing happened yet. Say so where the person is, with a retry (a person who came
    // by a link never filled in the form, so sending them back to it would be a dead end).
    connectFailed();
    return;
  }
  // A live call whose line closed with no `ended` (and no Pause, End or switch) reconnects on its own.
  const step = stepReconnect(rc, { t: "dropped", now: performance.now(), live: state.phase === "live" || afterReconnect });
  rc = step.state;
  if (step.action.kind === "ask") {
    lineDropped();
    return;
  }
  dispatch({ kind: "closed", minutes: elapsed() / 60 });
}

// ---------- a dropped line reconnects on its own ----------

let rc: Reconnect = startReconnect();
let rcTimer = 0;
/** The clock's start, carried into the reconnected room (0 when not reconnecting). */
let carriedStart = 0;
/** This room came back by itself after a drop (it says "Back on the line", not "Welcome back"). */
let rejoined = false;

/** The room stays, quiet: "The line dropped. Reconnecting…", her face, the microphone off. */
function lineDropped(): void {
  window.clearTimeout(endTimer);
  // The clock keeps going: to the person it is one conversation.
  voice.onMicLevel = null;
  voice.stopMic();
  voice.flush();
  stopAvatar();
  drive(false);
  dispatch({ kind: "line-dropped" });
  void askToContinue();
}

async function askToContinue(): Promise<void> {
  const r = await post("/api/talk/continue", {});
  if (!reconnecting(rc)) return; // stopped (End pressed, page going) while the request was out
  const opened = r?.status === 200 ? readContinued(r.data) : null;
  const step = stepReconnect(rc, { t: "reply", now: performance.now(), status: r ? (r.status === 200 && !opened ? 500 : r.status) : 0 });
  rc = step.state;
  if (step.action.kind === "open" && opened) reopen(opened);
  else if (step.action.kind === "end") reconnectGaveUp();
  else rcTimer = window.setTimeout(reconnectTick, RECONNECT_RETRY_MS);
}

function reconnectTick(): void {
  const step = stepReconnect(rc, { t: "tick", now: performance.now() });
  rc = step.state;
  if (step.action.kind === "ask") void askToContinue();
  else if (reconnecting(rc)) rcTimer = window.setTimeout(reconnectTick, 500);
}

/** Back in the room with the continued call: notes, stage and clock carry on; nobody presses anything. */
function reopen(opened: Opened): void {
  const typing = textOnly;
  carriedStart = startedAt;
  session = {
    id: opened.id,
    sections: opened.sections,
    targetMinutes: opened.targetMinutes,
    name: opened.name || (session?.name ?? ""),
    ...(opened.resumed ? { resumed: opened.resumed } : {}),
  };
  if (typing) {
    startRoom(true);
    return;
  }
  // The microphone was allowed a minute ago, so this does not ask again; if it fails, the microphone screen says why.
  voice.openMic().then(
    () => {
      // The new microphone stream starts live: put the person's mute back before anything is sent.
      voice.setMuted(muted);
      startRoom(false);
    },
    () => {
      void askForMic();
    },
  );
}

/** Reconnecting did not bring it back: the line-dropped end screen, with Continue. */
function reconnectGaveUp(): void {
  window.clearTimeout(rcTimer);
  carriedStart = 0;
  voice.close();
  dispatch({ kind: "closed", minutes: elapsed() / 60 });
}

/** End pressed, or the page going away, while reconnecting: stop asking. */
function stopReconnecting(): void {
  window.clearTimeout(rcTimer);
  rc = stepReconnect(rc, { t: "stop" }).state;
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

/** On video there is no PCM queue to say she is speaking: her open caption is the signal. */
function herTurnIsOpen(s: TalkState): boolean {
  const last = s.turns[s.turns.length - 1];
  return last?.who === "aida" && last.open;
}

function statusOf(s: TalkState): [string, string] {
  // The socket of an automatic reconnect is opening: still the same quiet word.
  if (s.phase === "connecting" && carriedStart) return ["reconnecting", DROPPED_STATUS];
  if (s.phase === "connecting") return ["connecting", "Connecting"];
  if (s.phase === "ending") return ["ending", s.pausing ? "Saving your place" : "Wrapping up"];
  if (s.phase === "ended") return ["ended", "Finished"];
  if (s.link === "dropped") return ["reconnecting", DROPPED_STATUS];
  if (s.link === "reconnecting") return ["reconnecting", "Reconnecting, one moment"];
  if (s.link === "resumed" && performance.now() - resumedAt < 4000) return ["resumed", "Back on the line"];
  if (voice.isSpeaking || (s.avatar && herTurnIsOpen(s))) return ["speaking", "Aida is speaking"];
  // A returning conversation: say so until either of you has spoken.
  if (s.resumed && s.turns.length === 0) return ["resumed", rejoined ? "Back on the line" : "Welcome back"];
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
    const stamp = document.createElement("time");
    stamp.className = "note-time";
    stamp.textContent = noteStamp(note.at);
    li.append(stamp, note.text);
    const fresh = Boolean(prev) && !note.restored;
    if (fresh) li.className = "fresh";
    noteGroup(note.section).append(li);
    if (fresh) {
      setTimeout(() => {
        li.classList.remove("fresh");
      }, 2600);
      // Where the notebook is open in the room (desktop, tall phones), bring the
      // new note into view; a closed sheet is left alone.
      const body = li.closest<HTMLElement>(".nb-body");
      if (body && getComputedStyle(body).visibility !== "hidden") {
        li.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
      }
    }
  }
  const count = s.notes.length;
  nbEmpty.hidden = count > 0;
  nbCount.textContent = count === 1 ? "1 note" : count ? `${count} notes` : "Notes";
  const last = s.notes[s.notes.length - 1];
  if (last && last.id !== prev?.notes[prev.notes.length - 1]?.id) {
    nbLatest.textContent = last.text;
    nbToggle.classList.remove("pulse");
    if (prev && !last.restored && !still) {
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
    // A returning conversation keeps its clock: the minutes already spent count.
    startedAt = performance.now() - (s.resumed?.minutesSoFar ?? 0) * 60_000;
    clockTimer = window.setInterval(tick, 1000);
    tick();
  }
  if (s.link === "resumed" && prev?.link !== "resumed") {
    resumedAt = performance.now();
    setTimeout(renderStatus, 4100);
  }
  if (changed("link", "phase")) renderStatus();
  if (changed("turns", "error")) renderCaptions(s);
  if ((s.resumed || s.avatar) && changed("turns")) renderStatus();
  if (!prev && s.resumed) {
    hint.textContent = rejoined
      ? "Back on the line. She will carry on where you stopped."
      : "Welcome back. She will pick up where you stopped. Talk as you would on a call; you can interrupt her.";
  }
  if (changed("notes")) renderNotesLive(prev, s);
  if (changed("idleWarning")) renderIdle(s.idleWarning);
  if (s.finished.length) announce.textContent = s.finished.map((t) => `${t.who === "aida" ? "Aida" : "You"}: ${turnText(t)}`).join(" ");
  if (!changed("phase", "link")) return;
  const ending = s.phase === "ending" || s.phase === "ended";
  // While the line is down only End works: there is no socket to pause, type into or mute.
  const down = s.link === "dropped";
  endBtn.disabled = ending;
  laterBtn.disabled = s.phase !== "live" || down;
  typeBtn.disabled = ending || down;
  muteBtn.disabled = ending || textOnly || down;
  if (down) typer.hidden = true;
  if (ending) {
    closeConfirm();
    typer.hidden = true;
  }
  if (s.phase === "ended" && prev?.phase !== "ended") leave();
}

// "Still there?": the server says the line has gone quiet and will pause. The number counts down
// here from the seconds it gave; the sentence is not re-read every second (a separate, static alert
// does the announcing once). Speaking, typing or the button clears it.
const idleBox = byId("idle", HTMLDivElement);
const idleText = byId("idle-text", HTMLParagraphElement);
let idleEnds = 0;
let idleTimer = 0;

function idleTick(): void {
  idleText.textContent = idleSentence(secondsLeft(idleEnds, performance.now()));
}

function renderIdle(w: TalkState["idleWarning"]): void {
  window.clearInterval(idleTimer);
  idleTimer = 0;
  idleBox.hidden = !w;
  if (!w) return;
  idleEnds = performance.now() + w.secondsLeft * 1000;
  idleTick();
  idleTimer = window.setInterval(idleTick, 1000);
}

byId("idle-here", HTMLButtonElement).addEventListener("click", () => {
  voice.here();
  dispatch({ kind: "here-pressed" });
});

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
function bindMouths(): void {
  mouthImages.clear();
  mouth = "closed";
  for (const m of ["small", "mid", "wide", "round", "pucker"] as const) {
    const img = roomHead?.querySelector<HTMLElement>(`.m-${m}`);
    if (img) mouthImages.set(m, img);
  }
}
bindMouths();

let mouthSince = 0;

function setMouth(next: Mouth, force = false): void {
  if (next === mouth) return;
  // Each drawing is held for 110 ms at least: long enough to read as a shape,
  // short enough to follow syllables (200 ms lagged a word behind); closing is
  // immediate.
  const now = performance.now();
  if (!force && next !== "closed" && now - mouthSince < 110) return;
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

function closeConfirm(focus?: HTMLElement | false): void {
  confirmBox.hidden = true;
  confirmLater.hidden = true;
  controls.hidden = false;
  if (focus) focus.focus();
}

endBtn.addEventListener("click", () => {
  controls.hidden = true;
  confirmBox.hidden = false;
  byId("confirm-no", HTMLButtonElement).focus();
});
laterBtn.addEventListener("click", () => {
  controls.hidden = true;
  confirmLater.hidden = false;
  byId("later-no", HTMLButtonElement).focus();
});
byId("confirm-no", HTMLButtonElement).addEventListener("click", () => {
  closeConfirm(endBtn);
});
byId("later-no", HTMLButtonElement).addEventListener("click", () => {
  closeConfirm(laterBtn);
});
confirmBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeConfirm(endBtn);
});
confirmLater.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeConfirm(laterBtn);
});

/** The server should answer within seconds; never wait forever. */
function awaitEnd(): void {
  endTimer = window.setTimeout(() => {
    voice.close();
    dispatch({ kind: "closed", minutes: elapsed() / 60 });
  }, 25_000);
}

byId("confirm-yes", HTMLButtonElement).addEventListener("click", () => {
  if (state.phase !== "live" && state.phase !== "connecting") return;
  if (reconnecting(rc)) {
    // No line to end: stop reconnecting and show the end screen now.
    stopReconnecting();
    dispatch({ kind: "end-pressed" });
    dispatch({ kind: "closed", minutes: elapsed() / 60 });
    return;
  }
  voice.end();
  dispatch({ kind: "end-pressed" });
  awaitEnd();
});
byId("later-yes", HTMLButtonElement).addEventListener("click", () => {
  if (state.phase !== "live") return;
  voice.pause();
  dispatch({ kind: "pause-pressed" });
  awaitEnd();
});

function setNotebook(open: boolean, focus = true): void {
  notebook.dataset.open = String(open);
  nbToggle.setAttribute("aria-expanded", String(open));
  if (open && focus) byId("nb-close", HTMLButtonElement).focus();
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
  player?.unmute();
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
  stopAvatar();
  // Let her last words play out (up to a few seconds), then close the line.
  const wait = Math.min(8000, voice.queued * 1000 + 600);
  setTimeout(() => {
    drive(false);
    voice.close();
    showEnd();
  }, wait);
}

const endActions = byId("end-actions", HTMLDivElement);
const endContinue = byId("end-continue", HTMLButtonElement);
const endContinueStatus = byId("end-continue-status", HTMLParagraphElement);
const endContinueLabel = endContinue.querySelector<HTMLElement>(".label");

function showEnd(): void {
  const title = byId("end-title", HTMLHeadingElement);
  const lede = byId("end-lede", HTMLParagraphElement);
  const readback = byId("readback", HTMLDivElement);
  const name = session?.name ?? "";
  title.textContent = name ? `Thank you, ${name}` : "Thank you";
  const reason = state.ended?.reason;
  const view = endView(state);
  const more = byId("end-more", HTMLParagraphElement);
  const choices = byId("choices", HTMLFormElement);
  const next = byId("next-steps", HTMLElement);
  more.hidden = true;
  endActions.hidden = true;
  endContinueStatus.textContent = "";
  next.hidden = view.kind !== "done" && view.kind !== "budget";
  choices.hidden = true;
  if (view.kind === "paused" || view.kind === "saved" || view.kind === "idle" || view.kind === "declined" || view.kind === "video") {
    // Not finished, or not for the record: no read-back, no follow-up form.
    let copy: { title: string; lede: string; more?: string };
    if (view.kind === "paused") copy = pausedCopy(view.emailed);
    else if (view.kind === "saved") copy = savedCopy(view.emailed);
    else if (view.kind === "video") copy = view.switching ? SWITCHING_CLOSING : VIDEO_STOPPED_CLOSING;
    else if (view.kind === "idle") copy = IDLE_CLOSING;
    else copy = DECLINED_CLOSING;
    title.textContent = copy.title;
    lede.textContent = copy.lede;
    more.textContent = copy.more ?? "";
    more.hidden = !copy.more;
    readback.replaceChildren();
    if (view.kind === "idle" || view.kind === "video") {
      // The cookie lets the server open the saved call again; the click is the gesture for her voice.
      endActions.hidden = false;
      endContinue.disabled = false;
      if (endContinueLabel) endContinueLabel.textContent = view.kind === "video" ? "Continue without video" : "Continue";
      // Switching on purpose carries straight on: the choice was already made, so no button is shown, only
      // "one moment" (the button comes back if continuing fails).
      if (view.kind === "video" && view.switching) {
        endActions.hidden = true;
        window.setTimeout(() => { endContinue.click(); }, 0);
      }
    }
    if (view.kind === "declined") byId("end-meta", HTMLParagraphElement).textContent = "";
    else
    byId("end-meta", HTMLParagraphElement).textContent = `You talked for ${Math.max(1, Math.round(state.ended?.minutes ?? elapsed() / 60))} min so far.`;
    app.dataset.ending = view.kind;
    show("end");
    return;
  }
  if (state.summary) {
    readback.innerHTML = `<h2 class="visually-hidden">What Aida heard</h2>${renderSummary(state.summary)}`;
    lede.textContent = "Here is what Aida heard. The Aida team will read it and build your AI and automation strategy.";
  } else {
    readback.innerHTML = `<h2 class="readback-title">Aida’s notes</h2><div class="nb-sheet">${renderNotes(groupNotes(state.notes))}</div>`;
    lede.textContent =
      reason === "lost" ? DROPPED_LEDE : "Here are the notes she took. The Aida team will read them and build your AI and automation strategy.";
  }
  if (view.kind === "dropped") {
    // The server keeps a dropped call: carry on from here (Continue). It is not over, so no follow-up form yet.
    title.textContent = "The line dropped";
    lede.textContent = DROPPED_LEDE;
    endActions.hidden = false;
    endContinue.disabled = false;
    if (endContinueLabel) endContinueLabel.textContent = "Continue";
  }
  if (view.kind === "budget") lede.textContent = BUDGET_LEDE;
  const minutes = state.ended?.minutes ?? elapsed() / 60;
  const ceiling = reason === "ceiling" ? " She stopped at the time limit." : "";
  byId("end-meta", HTMLParagraphElement).textContent = `You talked for ${Math.max(1, Math.round(minutes))} min.${ceiling}`;
  app.dataset.ending = reason ?? "";
  show("end");
  if (session && view.kind !== "dropped") choices.hidden = false;
}

// ---------- continuing later ----------

const again = byId("again", HTMLDetailsElement);
const againForm = byId("again-form", HTMLFormElement);
const againEmail = byId("again-email", HTMLInputElement);
const againGo = byId("again-go", HTMLButtonElement);
const againStatus = byId("again-status", HTMLParagraphElement);

function againSay(message: string, bad: boolean): void {
  againStatus.textContent = message;
  againStatus.dataset.bad = String(bad);
  if (bad) againEmail.setAttribute("aria-invalid", "true");
  else againEmail.removeAttribute("aria-invalid");
}

againForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (againGo.disabled) return;
  if (!looksLikeEmail(againEmail.value)) {
    againSay(RELINK_INVALID, true);
    againEmail.focus();
    return;
  }
  againGo.disabled = true;
  againSay("Sending…", false);
  fetch("/api/talk/relink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: againEmail.value.trim() }),
  })
    .then((r) => {
      const outcome = relinkOutcome(r.status);
      againSay(outcome.message, !outcome.ok);
    })
    .catch(() => {
      againSay("We couldn’t reach Aida. Check your connection and try again.", true);
    })
    .finally(() => {
      againGo.disabled = false;
    });
});

/** Back on the first screen with a plain reason, and the way to a new link open. */
function backToIntro(message: string, offerRelink: boolean): void {
  introFor("stranger");
  show("intro", false);
  againSay(message, true);
  againEmail.removeAttribute("aria-invalid");
  again.open = true;
  if (offerRelink) againEmail.focus({ preventScroll: true });
  again.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

// The token from the link lives here, in memory only, until the POST that spends it succeeds.
let pendingToken: string | null = null;
const welcomeBack = byId("welcome-back", HTMLElement);
const welcomeGo = byId("welcome-go", HTMLButtonElement);
const welcomeStatus = byId("welcome-status", HTMLParagraphElement);

function welcomeSay(message: string): void {
  welcomeStatus.textContent = message;
}

function dropToken(): void {
  pendingToken = null;
  welcomeBack.hidden = true;
}

/** Back on the first screen, the Welcome back card still there for another try. */
function retryLater(message: string): void {
  show("intro", false);
  welcomeSay(message);
  welcomeGo.disabled = false;
  welcomeGo.focus({ preventScroll: true });
  welcomeBack.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

async function resumeNow(): Promise<void> {
  const token = pendingToken;
  if (!token || welcomeGo.disabled) return;
  welcomeGo.disabled = true;
  welcomeSay("");
  micHeading("opening");
  show("mic");
  micText.textContent = "Opening your conversation…";
  micWait.hidden = false;
  micActions.hidden = true;
  let res: Response;
  let data: unknown;
  try {
    res = await fetch("/api/talk/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    data = await res.json().catch(() => null);
  } catch {
    retryLater(NETWORK_TRY_AGAIN);
    return;
  }
  const reply = res.ok ? readResumeReply(data) : null;
  if (!reply) {
    const refusal = resumeRefusal(res.ok ? 500 : res.status, data);
    if (refusal.retry) {
      retryLater(refusal.message);
    } else {
      dropToken();
      backToIntro(refusal.message, refusal.offerRelink);
    }
    return;
  }
  dropToken();
  session = {
    id: reply.id,
    sections: reply.sections,
    targetMinutes: reply.targetMinutes,
    name: reply.name,
    resumed: reply.resumed,
  };
  void askForMic();
}

// The click is the gesture that lets her voice play later, so the audio is woken inside it.
welcomeGo.addEventListener("click", () => {
  voice.wake();
  void resumeNow();
});

// ---------- the confirmation link, and a returning visitor ----------

const consentForm = byId("consent-form", HTMLFormElement);
const introNotice = byId("intro-notice", HTMLParagraphElement);
const goCard = byId("go-card", HTMLElement);
const goBtn = byId("go-go", HTMLButtonElement);
const goStatus = byId("go-status", HTMLParagraphElement);
const knownCard = byId("known-card", HTMLElement);
const knownContinue = byId("known-continue", HTMLButtonElement);
const knownNew = byId("known-new", HTMLButtonElement);
const knownStatus = byId("known-status", HTMLParagraphElement);

/**
 * Who the first screen is for. A stranger sees the consent box and Start; someone with a confirmation
 * link or a cookie has already agreed when they registered, so the consent box is not asked again.
 */
function introFor(mode: "stranger" | "go" | "known" | "resume"): void {
  consentForm.hidden = mode !== "stranger";
  // "Already started? Continue where you left off" is for a stranger only: a card above already offers it.
  again.hidden = mode !== "stranger";
}

function showNotice(message: string): void {
  show("intro", false);
  introNotice.textContent = message;
  introNotice.hidden = !message;
  introNotice.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

function showOpening(): void {
  micHeading("opening");
  show("mic");
  micText.textContent = "Opening your conversation…";
  micWait.hidden = false;
  micActions.hidden = true;
}

// The link in the confirmation email. Its token lives in memory only, until the POST that spends it succeeds.
let pendingGo: string | null = null;

function dropGo(): void {
  pendingGo = null;
  goCard.hidden = true;
}

async function confirmNow(): Promise<void> {
  const token = pendingGo;
  if (!token || goBtn.disabled) return;
  goBtn.disabled = true;
  goStatus.textContent = "";
  showOpening();
  let res: Response;
  let data: unknown;
  try {
    res = await fetch("/api/talk/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    data = await res.json().catch(() => null);
  } catch {
    retryGo(NETWORK_TRY_AGAIN);
    return;
  }
  const opened = res.ok ? readOpened(data) : null;
  if (!opened) {
    const refusal = confirmRefusal(res.ok ? 500 : res.status, data);
    if (refusal.outcome === "retry") {
      retryGo(refusal.message);
    } else {
      dropGo();
      introFor("stranger");
      if (refusal.outcome === "expired") backToIntro(refusal.message, true);
      else showNotice(refusal.message);
    }
    return;
  }
  dropGo();
  openSession(opened);
}

/** Back on the first screen, the one-click card still there for another try with the same token. */
function retryGo(message: string): void {
  show("intro", false);
  goStatus.textContent = message;
  goBtn.disabled = false;
  goBtn.focus({ preventScroll: true });
  goCard.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

// The click is what lets the browser play her voice, so the audio is woken inside it.
goBtn.addEventListener("click", () => {
  voice.wake();
  void confirmNow();
});

// Someone this browser knows (the server's own cookie; the page never reads it).
function showKnown(me: NonNullable<ReturnType<typeof readMe>>): void {
  const copy = knownCopy(me);
  byId("known-title", HTMLElement).textContent = copy.title;
  byId("known-detail", HTMLElement).textContent = copy.detail;
  byId("known-forget", HTMLButtonElement).textContent = copy.notYou;
  knownContinue.hidden = !me.canContinue;
  knownNew.hidden = !me.canStartNew;
  knownNew.textContent = copy.startLabel;
  // A confirmed interview waiting to be started is the one thing to do: Start is the main button.
  // With nothing to continue, Start is the one thing to do: the main button.
  const startOnly = !me.canContinue;
  knownNew.classList.toggle("btn-go", startOnly);
  knownNew.classList.toggle("btn-quiet", !startOnly);
  knownStatus.textContent = copy.limit;
  // "Already open in another window" never sits beside an active button: both are held until it clears.
  knownBlocked = copy.busy;
  knownBusy(false);
  knownCheck.hidden = !copy.busy;
  knownCard.hidden = false;
  introFor("known");
}

function hideKnown(): void {
  knownCard.hidden = true;
  introFor("stranger");
}

async function checkMe(): Promise<void> {
  let data: unknown;
  try {
    const res = await fetch("/api/talk/me", { headers: { Accept: "application/json" } });
    // Always read the body, even a refusal: an unread one leaves the request open from the browser's point of view.
    const body: unknown = await res.json().catch(() => null);
    data = res.ok ? body : null;
  } catch {
    return; // no answer: the ordinary first screen
  }
  const me = readMe(data);
  // A visitor who has already started typing their details is left alone.
  if (me && app.dataset.screen === "intro") showKnown(me);
}

async function post(url: string, body: unknown): Promise<{ status: number; data: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

let knownBlocked = false;
const knownCheck = byId("known-check", HTMLButtonElement);

function knownBusy(on: boolean): void {
  knownContinue.disabled = on || knownBlocked;
  knownNew.disabled = on || knownBlocked;
}

knownCheck.addEventListener("click", () => {
  knownCheck.disabled = true;
  knownStatus.textContent = "Checking…";
  void checkMe().finally(() => {
    knownCheck.disabled = false;
    if (knownStatus.textContent === "Checking…") knownStatus.textContent = "";
  });
});

async function enterAs(kind: "continue" | "new"): Promise<void> {
  if (knownContinue.disabled) return;
  knownBusy(true);
  knownStatus.textContent = "";
  showOpening();
  const r = await post(`/api/talk/${kind}`, {});
  const opened = r?.status === 200 ? (kind === "continue" ? readContinued(r.data) : readOpened(r.data)) : null;
  if (opened) {
    knownBusy(false);
    openSession(opened);
    return;
  }
  show("intro", false);
  knownBusy(false);
  if (!r) {
    knownStatus.textContent = NETWORK_TRY_AGAIN;
    return;
  }
  const refusal = entryRefusal(r.status === 200 ? 500 : r.status, r.data);
  if (refusal.outcome === "login") hideKnown();
  else if (refusal.outcome === "nothing") {
    knownContinue.hidden = true;
    knownStatus.textContent = "";
  } else {
    knownStatus.textContent = refusal.message;
  }
  knownCard.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

knownContinue.addEventListener("click", () => {
  voice.wake();
  void enterAs("continue");
});
knownNew.addEventListener("click", () => {
  voice.wake();
  void enterAs("new");
});
byId("known-forget", HTMLButtonElement).addEventListener("click", () => {
  void post("/api/talk/forget", {});
  hideKnown();
  consent.focus({ preventScroll: true });
});

// After an idle pause the cookie opens the saved call again.
endContinue.addEventListener("click", () => {
  if (endContinue.disabled) return;
  voice.wake();
  // "Continue without video" is a choice to remember: the next call starts without it too.
  if (endView(state).kind === "video") rememberVoiceOnly(safeStorage());
  endContinue.disabled = true;
  endContinueStatus.textContent = "";
  void post("/api/talk/continue", {}).then((r) => {
    const opened = r?.status === 200 ? readContinued(r.data) : null;
    if (opened) {
      openSession(opened);
      return;
    }
    endContinue.disabled = false;
    endActions.hidden = false;
    // After a dropped line, a 409 means the old call has not cleared yet, not another window.
    if (r?.status === 409 && endView(state).kind === "dropped") endContinueStatus.textContent = DROPPED_STILL_CLOSING;
    else endContinueStatus.textContent = r ? entryRefusal(r.status === 200 ? 500 : r.status, r.data).message : NETWORK_TRY_AGAIN;
  });
});

// A link opens here. Its token leaves the address bar before anything else happens, and nothing is asked
// of the server until the person presses the button: that click is what lets her voice play.
const entry = entryFor(takeLanding(location, history));
if (entry.kind === "go") {
  pendingGo = entry.token;
  goCard.hidden = false;
  introFor("go");
} else if (entry.kind === "resume") {
  pendingToken = entry.token;
  welcomeBack.hidden = false;
  introFor("resume");
} else if (entry.kind === "bad-link") {
  backToIntro(EXPIRED_GO, true);
} else {
  void checkMe();
}

byId("choices", HTMLFormElement).addEventListener("submit", (e) => {
  e.preventDefault();
  if (!session) return;
  const form = e.currentTarget as HTMLFormElement;
  const status = byId("choices-status", HTMLParagraphElement);
  const button = byId("choices-go", HTMLButtonElement);
  const choices = [...form.querySelectorAll<HTMLInputElement>("input[name=choice]:checked")].map((i) => i.value);
  const note = byId("choices-note", HTMLTextAreaElement).value;
  if (!choices.length && !note.trim()) {
    status.textContent = "Tick at least one, or write a note.";
    return;
  }
  button.disabled = true;
  status.textContent = "Sending…";
  fetch("/api/talk/choices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.id, choices, note }),
  })
    .then((r) => {
      status.textContent = r.ok ? "Sent. Thank you." : "That did not send. Please try again.";
      button.disabled = r.ok;
    })
    .catch(() => {
      status.textContent = "That did not send. Please try again.";
      button.disabled = false;
    });
});
