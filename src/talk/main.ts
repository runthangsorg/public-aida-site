import "./talk.css";
import type { Mouth } from "../lipsync";
import { FIELDS, MAX_LENGTH, TEAM_SIZES, checkDetails, limitHint, startBody, type Field } from "./details";
import { mouthFor, type MouthShape } from "./mouth";
import { NOTE_SECTIONS, noteLabel, type NoteSection, type Resumed, type ServerFrame, type Stage, setRelayOrigin } from "./protocol";
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
  chipFor,
  chipWakeAt,
  formatClock,
  groupNotes,
  noteStamp,
  initialState,
  endView,
  latestTurns,
  progress,
  reduce,
  stageStatus,
  startChip,
  stepChip,
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
  type Face,
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
  // In-app history per screen (QA round 2 E): the browser's Back button walks the person back through
  // the pages they have been on instead of leaving the site.
  const hs = history.state as { screen?: string } | null | undefined;
  if (hs?.screen !== name) history.pushState({ screen: name }, "");
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

// Back out of the room asks before hanging up; anywhere else Back simply goes to the previous screen.
window.addEventListener("popstate", () => {
  // Back from the end screen stays on it: the room behind it is over (QA 18 Oct: Back led to a dead "Finished"
  // room). Its own buttons and the home-page link are the ways on.
  if (app.dataset.screen === "end") {
    history.pushState({ screen: "end" }, "");
    return;
  }
  if (app.dataset.screen === "room" && state.phase === "ended") {
    // Finished, her last words still playing: the end screen is a moment away. Nothing to hang up.
    history.pushState({ screen: "room" }, "");
    return;
  }
  if (app.dataset.screen === "room") {
    // Stay in the room's history entry, so a second Back asks again instead of leaving the site.
    history.pushState({ screen: "room" }, "");
    controls.hidden = true;
    confirmBox.hidden = false;
    byId("confirm-no", HTMLButtonElement).focus();
    return;
  }
  const st = history.state as { screen?: string } | null | undefined;
  const target = typeof st?.screen === "string" ? (st.screen as Screen) : "intro";
  if (target !== app.dataset.screen) show(target, false);
});

// ---------- her face, wherever the page shows her ----------

// Which face she wears is decided once, here, before anything is drawn: Vera's still everywhere, voice-only
// calls included (owner, 18 Oct: never the drawn character). faceFor is the single decision point.
const templates = { drawn: byId("face", HTMLTemplateElement), vera: byId("face-vera", HTMLTemplateElement) };
const face: Face = faceFor();
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

/** One field's error line and its aria-invalid, shown or cleared. */
function markField(field: Field, message: string | undefined): void {
  const el = document.getElementById(`e-${field}`);
  if (el) setError(el, message);
  const input = control(field);
  const targets = field === "teamSize" ? Array.from(chips.querySelectorAll("input")) : input ? [input] : [];
  for (const t of targets) {
    if (message) t.setAttribute("aria-invalid", "true");
    else t.removeAttribute("aria-invalid");
  }
}

function showFieldErrors(errors: Partial<Record<Field | "consent", string>>): void {
  let first: HTMLElement | null = null;
  for (const field of FIELDS) {
    const message = errors[field];
    markField(field, message);
    if (message && !first) first = control(field);
  }
  first?.focus();
}

/**
 * A field's error goes as soon as the field is put right, not on the next submit (QA 18 Oct: team size and
 * email kept their errors after being fixed). Nothing new is said while they type: only a shown error clears.
 */
function clearIfFixed(field: Field): void {
  const el = document.getElementById(`e-${field}`);
  if (!el || el.hidden) return;
  const checked = checkDetails(readForm());
  if (!checked.ok && checked.errors[field]) return;
  markField(field, undefined);
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

// The details form and the consent box survive a trip to the privacy page (QA round 2 E): both are kept
// in sessionStorage as they are typed, and put back when this tab returns.
const DETAILS_KEY = "aida:details";
const CONSENT_KEY = "aida:consent";
function loadSaved(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDetails(): void {
  try {
    sessionStorage.setItem(DETAILS_KEY, JSON.stringify(readForm()));
  } catch {
    /* storage can be off: the form still works, just not kept */
  }
}
function restoreDetails(): void {
  const saved = loadSaved(DETAILS_KEY) as Partial<Record<Field, string>> | null;
  if (!saved) return;
  for (const f of FIELDS) {
    const v = saved[f];
    const el = document.getElementById(`f-${f}`);
    if (typeof v === "string" && el instanceof HTMLInputElement) el.value = v.slice(0, MAX_LENGTH[f]);
  }
}
for (const f of FIELDS) {
  const el = document.getElementById(`f-${f}`);
  if (el instanceof HTMLInputElement) {
    el.addEventListener("input", () => {
      saveDetails();
      clearIfFixed(f);
    });
  }
}
chips.addEventListener("change", () => {
  clearIfFixed("teamSize");
});
consent.addEventListener("change", () => {
  try {
    sessionStorage.setItem(CONSENT_KEY, JSON.stringify({ consent: consent.checked }));
  } catch {
    /* ignore */
  }
});
/** "Not you?": the details and the tick this tab kept are someone else's. Clear them, and the form. */
function forgetSaved(): void {
  try {
    sessionStorage.removeItem(DETAILS_KEY);
    sessionStorage.removeItem(CONSENT_KEY);
  } catch {
    /* storage can be off: nothing was kept */
  }
  form.reset();
  for (const counter of form.querySelectorAll<HTMLElement>(".limit")) counter.hidden = true;
  showFieldErrors({});
  consent.checked = false;
  setError(consentError, undefined);
  consent.removeAttribute("aria-invalid");
}
const savedConsent = loadSaved(CONSENT_KEY) as { consent: boolean } | null;
if (savedConsent) consent.checked = savedConsent.consent;
restoreDetails();

function busy(on: boolean): void {
  go.disabled = on;
  go.setAttribute("aria-busy", String(on));
  // This button only sends the email: "Starting…" read as if the conversation had begun (impatient, 18 Oct).
  if (goLabel) goLabel.textContent = on ? "Sending your link…" : "Continue";
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
    // It is their own screen: show the full address, so a typo is visible before they chase the email (QA round 2 J).
    showCheck(gateEmail || reply.hint, reply.resendInSeconds);
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
// by voice with one button. Vera's still sits under the video the whole time.

const videoEl = byId("avatar-video", HTMLVideoElement);
const voiceOnlyBtn = byId("voice-only", HTMLButtonElement);
const soundBtn = byId("avatar-sound", HTMLButtonElement);
const slowOffer = byId("slow-offer", HTMLDivElement);
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
    // More than ~3 s behind live for 10 s: one line offers the in-place switch (once a call).
    onSlow: () => {
      if (state.phase === "live" && !state.switching) slowOffer.hidden = false;
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
  slowOffer.hidden = true;
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
  dispatch({ kind: "video-stopped", switching });
  awaitEnd();
}

// The person chose voice only mid-call: the room stays, the clock runs, and the page moves the call to a
// new voice-only line itself. (17-18 Oct: the old path paused the call, showed the whole end page and only
// then reconnected - ~23 s, a "Saving your place" frame in between, and the clock restarted at 0:00.)
const SWITCH_RETRY_MS = 2500;
const SWITCH_WINDOW_MS = 60_000;

/** Is the switch still the page's job? Read fresh each time: End or a new call may have moved the state on. */
function switchStillOn(): boolean {
  return state.phase === "live" && state.switching;
}

async function switchToVoiceOnly(): Promise<void> {
  // The entry guard, not switchStillOn(): the flag this reads is set below, on this path.
  if (state.phase !== "live" || state.switching) return;
  voice.switchAway(); // the server saves the place, no email; its `ended` is expected, not an ending
  voice.onMicLevel = null;
  voice.stopMic();
  voice.flush();
  stopAvatar();
  dispatch({ kind: "switching" });
  // The old socket is done with us; closing it locally must not look like a dropped line
  // (voice.close() takes its onclose off first).
  voice.close();
  const deadline = performance.now() + SWITCH_WINDOW_MS;
  for (;;) {
    const r = await post("/api/talk/continue", {});
    if (!switchStillOn()) return; // End pressed while the request was out
    const opened = r?.status === 200 ? readContinued(r.data) : null;
    if (opened) {
      reopen(opened);
      return;
    }
    if (r && (r.status === 401 || r.status === 404)) break; // nothing to carry on: the end screen
    if (performance.now() >= deadline) break; // or it never cleared: the end screen, with Continue
    await new Promise<void>((resolve) => window.setTimeout(resolve, SWITCH_RETRY_MS));
  }
  if (!switchStillOn()) return;
  dispatch({ kind: "video-stopped", switching: false });
  dispatch({ kind: "closed", minutes: elapsed() / 60 });
}

/** "Switch to voice only", from the pill on her video or the slow-link offer: the same in-place move. */
function chooseVoiceOnly(): void {
  slowOffer.hidden = true;
  if (state.switching) return;
  rememberVoiceOnly(safeStorage());
  void switchToVoiceOnly();
}
voiceOnlyBtn.addEventListener("click", chooseVoiceOnly);
byId("slow-switch", HTMLButtonElement).addEventListener("click", chooseVoiceOnly);
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

/** A quiet "voice only" start beside a Start/Continue button: the same action, the choice remembered first. */
function voiceStart(act: () => void): void {
  rememberVoiceOnly(safeStorage());
  voice.wake(); // the click is what lets her voice play
  act();
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
const typed = byId("typed", HTMLTextAreaElement);
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
const nbBody = byId("nb-body", HTMLDivElement);
const nbTabCount = byId("nb-tab-count", HTMLSpanElement);
const tabs = { notes: byId("tab-notes", HTMLButtonElement), transcript: byId("tab-transcript", HTMLButtonElement) };
const panels = { notes: byId("nb-notes", HTMLDivElement), transcript: byId("nb-transcript", HTMLDivElement) };
type Tab = keyof typeof tabs;
const transcriptEl = byId("transcript", HTMLOListElement);
const trEmpty = byId("tr-empty", HTMLParagraphElement);

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
/** The status chip's own clock: the person's voice, what is waiting on her, her latest note. */
let chip = startChip();
let chipTimer = 0;

// On a video call her voice comes with the video, not the PCM queue: her open caption says she is speaking,
// and the microphone's barge-in gate (noise.ts) holds back the room while it is.
voice.speakingElsewhere = () => state.avatar && herTurnIsOpen(state);
// The gate's voice detection drives "Listening" (they are talking) and "Transcribing…" (they have stopped).
voice.onVoice = (on) => {
  chip = stepChip(chip, { t: "voice", on, now: performance.now() });
  renderStatus();
};

/** What a frame from the server means for the chip: her note, her words, or theirs arriving as text. */
function chipFrame(frame: ServerFrame): void {
  const now = performance.now();
  if (frame.kind === "aida") {
    if (frame.frame.type === "note") chip = stepChip(chip, { t: "note", now });
    return;
  }
  const c = frame.content;
  if (c.output || c.audio.length) chip = stepChip(chip, { t: "her", now });
  else if (c.input && !herSpeaking(state)) chip = stepChip(chip, { t: "you", now });
}

// A small "78/80" once a capped field is within two characters of its limit — a silent cut is a bug
// to the person it happens to (QA round 2, breaker). Details fields, the typed answer and the note.
function wireLimit(el: HTMLInputElement | HTMLTextAreaElement, max: number): void {
  const counter = document.createElement("span");
  counter.className = "limit";
  counter.hidden = true;
  el.insertAdjacentElement("afterend", counter);
  const update = (): void => {
    const text = limitHint(el.value, max);
    counter.hidden = text === null;
    counter.textContent = text ?? "";
  };
  el.addEventListener("input", update);
  update();
}
for (const f of FIELDS) {
  const el = document.getElementById(`f-${f}`);
  if (el instanceof HTMLInputElement) wireLimit(el, MAX_LENGTH[f]);
}
wireLimit(typed, 2000);
wireLimit(byId("choices-note", HTMLTextAreaElement), 500);

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
  chip = startChip();
  window.clearTimeout(chipTimer);
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
  typed.style.height = "auto";
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
  // A continued conversation (a reconnect, the voice-only switch, Continue after a pause) keeps its transcript.
  if (session.resumed) trPart++;
  else clearTranscript();
  const ask = avatarAsk();
  avatarParamAsked = avatarParam(ask) !== undefined;
  textOnly = typing || !voice.hasMic;
  const switching = state.switching; // the voice-only switch re-enters the room: the move is still on
  state = initialState(session.sections, session.targetMinutes, session.resumed);
  if (switching) dispatch({ kind: "switching" });
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
        chipFrame(frame);
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

/** Her voice is playing now: the PCM queue on a voice call, her open caption on a video call. */
function herSpeaking(s: TalkState): boolean {
  return voice.isSpeaking || (s.avatar && herTurnIsOpen(s));
}

function statusOf(s: TalkState): [string, string] {
  if (s.phase === "ending") return ["ending", s.pausing ? "Saving your place" : "Wrapping up"];
  if (s.phase === "ended") return ["ended", "Finished"];
  // The person chose voice only: the room stays, and the page is moving the call to a new line. This
  // outranks connecting/reconnecting: the new socket opening is part of the switch, not a dropped line.
  if (s.switching) return ["switching", "Switching to voice only…"];
  // The socket of an automatic reconnect is opening: still the same quiet word.
  if (s.phase === "connecting" && carriedStart) return ["reconnecting", DROPPED_STATUS];
  if (s.phase === "connecting") return ["connecting", "Connecting"];
  if (s.link === "dropped") return ["reconnecting", DROPPED_STATUS];
  if (s.link === "reconnecting") return ["reconnecting", "Reconnecting, one moment"];
  if (s.link === "resumed" && performance.now() - resumedAt < 4000) return ["resumed", "Back on the line"];
  // Listening → Transcribing… → Noted → Aida is speaking (owner, 20 Oct): what she is doing with what you said.
  const now = chipFor(chip, herSpeaking(s), performance.now());
  if (now === "noted") return ["noted", "Noted"];
  if (now === "speaking") return ["speaking", "Aida is speaking"];
  // A returning conversation: say so until either of you has spoken.
  if (s.resumed && s.turns.length === 0) return ["resumed", rejoined ? "Back on the line" : "Welcome back"];
  // Before her first word the page must not invite anyone in (all three personas, 18 Oct: "Listening"
  // was read as an invitation, and the person talked over the welcome).
  if (!s.turns.some((t) => t.who === "aida")) return ["starting", "Aida is about to speak"];
  if (now === "transcribing") return ["transcribing", "Transcribing…"];
  if (textOnly) return ["listening", "Type your answer"];
  if (muted) return ["muted", "You’re muted"];
  return ["listening", "Listening"];
}

/** The hint line's truth: the state of the line, in the same words as the status. */
function hintFor(s: TalkState): string {
  if (s.switching) return "Switching to voice only…";
  // Never "Back on the line" while "Reconnecting…" is on screen (mobile, 18 Oct: both at once).
  if (s.link === "dropped" || (s.phase === "connecting" && carriedStart)) return DROPPED_STATUS;
  if (s.link === "reconnecting") return "Reconnecting, one moment…";
  if (s.link === "resumed") return rejoined ? "Back on the line. She will carry on where you stopped." : "Welcome back. She will pick up where you stopped.";
  if (s.resumed && s.turns.length === 0) {
    return rejoined
      ? "Back on the line. She will carry on where you stopped."
      : "Welcome back. She will pick up where you stopped. Talk as you would on a call; you can interrupt her.";
  }
  return s.error ?? defaultHint;
}

function renderStatus(): void {
  const [key, text] = statusOf(state);
  if (statusEl.dataset.state !== key) statusEl.dataset.state = key;
  // The speaking ring follows her voice, not the chip: a "Noted" flash while she talks must not put it out.
  const speaking = String(state.phase === "live" && herSpeaking(state));
  if (stageEl.dataset.speaking !== speaking) stageEl.dataset.speaking = speaking;
  if (statusText.textContent !== text) statusText.textContent = text;
  // "Noted" ends, and a "Transcribing…" with no answer gives up, by themselves: redraw then, and only then.
  window.clearTimeout(chipTimer);
  const now = performance.now();
  const wake = chipWakeAt(chip, now);
  chipTimer = wake === null ? 0 : window.setTimeout(renderStatus, wake - now + 20);
  // Only changes to the line itself are announced; speaking and listening are visible, not read aloud.
  const linkKey = ["connecting", "reconnecting", "resumed", "ending", "switching"].includes(key) ? key : "live";
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

/** One owner for the hint line, so a stale error or a welcome can never sit beside a newer line state. */
function renderHint(s: TalkState): void {
  const latest = latestTurns(s);
  hint.hidden = Boolean(latest.aida ?? latest.you) && !s.error;
  const text = hintFor(s);
  if (hint.textContent !== text) hint.textContent = text;
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
      // Where the notes are on show (a phone, a tablet, the desk's side page, an open sheet), bring the new
      // note into view, unless the person has scrolled up to read something else.
      if (inView("notes") && follow.notes) {
        autoScrollAt = performance.now();
        li.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
      }
    }
  }
  const count = s.notes.length;
  nbEmpty.hidden = count > 0;
  nbCount.textContent = count === 1 ? "1 note" : count ? `${count} notes` : "Notes";
  nbTabCount.textContent = count ? String(count) : "";
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

// ---------- the notebook's two tabs: her notes, and the whole exchange ----------

/** Each panel follows its newest line unless the person has scrolled up in it. */
const follow: Record<Tab, boolean> = { notes: true, transcript: true };
/** The page's own scrolling, which must not read as the person scrolling away. */
let autoScrollAt = 0;

const atBottom = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 24;

for (const tab of ["notes", "transcript"] as const) {
  panels[tab].addEventListener(
    "scroll",
    () => {
      if (performance.now() - autoScrollAt < 800) return;
      follow[tab] = atBottom(panels[tab]);
    },
    { passive: true },
  );
}

/** The panel is the open tab and the notebook is on screen (not a closed sheet). */
function inView(tab: Tab): boolean {
  return !panels[tab].hidden && getComputedStyle(nbBody).visibility !== "hidden";
}

function toBottom(tab: Tab): void {
  autoScrollAt = performance.now();
  panels[tab].scrollTop = panels[tab].scrollHeight;
}

function showTab(tab: Tab, focus = false): void {
  for (const t of ["notes", "transcript"] as const) {
    const on = t === tab;
    tabs[t].setAttribute("aria-selected", String(on));
    tabs[t].tabIndex = on ? 0 : -1;
    panels[t].hidden = !on;
  }
  if (focus) tabs[tab].focus();
  if (tab === "transcript" && follow.transcript) toBottom("transcript");
}

tabs.notes.addEventListener("click", () => {
  showTab("notes");
});
tabs.transcript.addEventListener("click", () => {
  showTab("transcript");
});
tabs.notes.parentElement?.addEventListener("keydown", (event) => {
  // Arrow keys move between the two tabs, as a tab list does.
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next: Tab = event.key === "Home" ? "notes" : event.key === "End" ? "transcript" : tabs.notes.tabIndex === 0 ? "transcript" : "notes";
  showTab(next, true);
});

// The transcript is drawn line by line and never redrawn whole: the open turn's text is updated as it grows.
// A reconnected, switched or continued call carries on the same list (its turns are numbered afresh, so each
// part of the call keys its own lines); only a new conversation starts it empty. The room's state keeps the
// last 60 turns for the captions; the list here keeps the whole exchange.
const trLines = new Map<string, HTMLLIElement>();
let trPart = 0;

function clearTranscript(): void {
  transcriptEl.replaceChildren();
  trLines.clear();
  trPart = 0;
  trEmpty.hidden = false;
  follow.notes = true;
  follow.transcript = true;
  showTab("notes");
}

function renderTranscript(s: TalkState): void {
  let grew = false;
  for (const t of s.turns) {
    const text = turnText(t) + (t.interrupted ? " …" : "");
    if (!text) continue;
    const key = `${trPart}:${t.id}`;
    let li = trLines.get(key);
    if (!li) {
      li = document.createElement("li");
      li.dataset.who = t.who;
      const who = document.createElement("span");
      who.className = "tr-who";
      who.textContent = t.who === "aida" ? "Aida:" : "You:";
      li.append(who, " ", document.createElement("span"));
      transcriptEl.append(li);
      trLines.set(key, li);
    }
    const said = li.lastElementChild;
    if (said && said.textContent !== text) {
      said.textContent = text;
      grew = true;
    }
    li.dataset.open = String(t.open);
  }
  trEmpty.hidden = trLines.size > 0;
  if (grew && follow.transcript && inView("transcript")) toBottom("transcript");
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
  if (changed("link", "phase", "switching")) renderStatus();
  if (changed("turns", "error")) renderCaptions(s);
  if (changed("turns")) renderTranscript(s);
  if (changed("turns", "error", "link", "phase", "resumed", "switching")) renderHint(s);
  // Her words, theirs and her notes all move the chip (Transcribing…, Noted, Aida is speaking).
  if (changed("turns", "notes")) renderStatus();
  if (changed("notes")) renderNotesLive(prev, s);
  if (changed("idleWarning")) renderIdle(s.idleWarning);
  if (s.finished.length) announce.textContent = s.finished.map((t) => `${t.who === "aida" ? "Aida" : "You"}: ${turnText(t)}`).join(" ");
  if (!changed("phase", "link", "switching")) return;
  const ending = s.phase === "ending" || s.phase === "ended";
  // While the line is down - or the call is moving to a voice-only line - only End works:
  // there is no socket to pause, type into or mute.
  const down = s.link === "dropped" || s.switching;
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

// A double click must not open the box and shut it again (QA 18 Oct): a second click within 400 ms is ignored.
let typeToggledAt = -Infinity;
typeBtn.addEventListener("click", () => {
  const now = performance.now();
  if (now - typeToggledAt < 400) return;
  typeToggledAt = now;
  openTyper(typer.hidden);
});

typer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = typed.value.trim();
  if (!text || state.phase !== "live") return;
  // A double Enter must not send twice (QA round 2, breaker): guard for 400ms.
  const now = performance.now();
  const last = (typed as HTMLTextAreaElement & { _last?: number })._last ?? 0;
  if (now - last < 400) return;
  (typed as HTMLTextAreaElement & { _last?: number })._last = now;
  voice.sendText(text);
  chip = stepChip(chip, { t: "you", now });
  dispatch({ kind: "typed", text });
  typed.value = "";
  typed.style.height = "auto";
});

typed.addEventListener("input", () => {
  typed.style.height = "auto";
  typed.style.height = String(Math.min(typed.scrollHeight, 6.5 * 16)) + "px";
});

typed.addEventListener("keydown", (event) => {
  // Enter sends, Shift+Enter starts a new line (the answer box grows to about four lines).
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    typed.form?.requestSubmit();
    return;
  }
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
    // Only promise what happens: the team gets the report; the person gets a copy only if they ask below.
    more.textContent = "Want a copy? Choose “Email me this summary” below.";
    more.hidden = false;
  } else {
    readback.innerHTML = `<h2 class="readback-title">Aida’s notes</h2><div class="nb-sheet">${renderNotes(groupNotes(state.notes))}</div>`;
    lede.textContent =
      reason === "lost"
        ? DROPPED_LEDE
        : "Here are the notes she took. The full summary (strengths, weaknesses, opportunities, threats and the crux) comes when a conversation reaches its end; the Aida team will read what you said and build your AI and automation strategy.";
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
byId("welcome-voice", HTMLButtonElement).addEventListener("click", () => {
  voiceStart(() => void resumeNow());
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
const knownVoice = byId("known-voice", HTMLButtonElement);
const knownStatus = byId("known-status", HTMLParagraphElement);

/**
 * Who the first screen is for. A stranger sees the consent box and Start; someone with a confirmation
 * link or a cookie has already agreed when they registered, so the consent box is not asked again.
 */
function introFor(mode: "stranger" | "go" | "known" | "resume"): void {
  consentForm.hidden = mode !== "stranger";
  // "Already started? Continue where you left off" is for a stranger only: a card above already offers it.
  again.hidden = mode !== "stranger";
  // The near-the-top Start is for the consent route only: the cards above carry their own buttons.
  startTop.hidden = mode !== "stranger";
}

// A clear Start near the top, for a viewport where the consent box is below the fold
// (impatient on a laptop, mobile, 18 Oct): it scrolls to the box and puts the cursor in it.
const startTop = byId("start-top", HTMLButtonElement);
startTop.addEventListener("click", () => {
  // The same press as the Start under the box: without the tick, the same "Please tick the box…" (QA 18 Oct).
  consentForm.requestSubmit();
  if (app.dataset.screen === "intro") consentForm.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
});

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
byId("go-voice", HTMLButtonElement).addEventListener("click", () => {
  voiceStart(() => void confirmNow());
});

// Someone this browser knows (the server's own cookie; the page never reads it).
function showKnown(me: NonNullable<ReturnType<typeof readMe>>): void {
  const copy = knownCopy(me);
  byId("known-title", HTMLElement).textContent = copy.title;
  byId("known-detail", HTMLElement).textContent = copy.detail;
  byId("known-forget", HTMLButtonElement).textContent = copy.notYou;
  knownContinue.hidden = !me.canContinue;
  knownNew.hidden = !me.canStartNew;
  knownVoice.hidden = !me.canContinue; // a voice-only Continue beside an ordinary one, or nothing
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

async function checkMe(): Promise<ReturnType<typeof readMe> | null> {
  let data: unknown;
  try {
    const res = await fetch("/api/talk/me", { headers: { Accept: "application/json" } });
    const body: unknown = await res.json().catch(() => null);
    data = res.ok ? body : null;
  } catch {
    return null;
  }
  const me = readMe(data);
  if (me && app.dataset.screen === "intro") showKnown(me);
  return me;
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
  knownVoice.disabled = on || knownBlocked;
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
knownVoice.addEventListener("click", () => {
  voiceStart(() => void enterAs("continue"));
});
byId("known-forget", HTMLButtonElement).addEventListener("click", () => {
  void post("/api/talk/forget", {});
  // Someone else's details and tick must not be waiting in the form (QA 18 Oct): forget what this tab kept.
  forgetSaved();
  knownCard.hidden = true;
  if (pendingGo) {
    // They came by a confirmation link while this browser knew someone: that link is theirs to use now.
    goCard.hidden = false;
    introFor("go");
    goBtn.focus({ preventScroll: true });
    return;
  }
  introFor("stranger");
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
  // A used link, or the same link opened in a second tab, in a browser that already holds a session: welcome
  // back, not "One click to begin" (QA 18 Oct). So /me is asked first; the card shows only for a stranger
  // (or when /me cannot be reached). The consent box is not asked again either way.
  introFor("go");
  void checkMe().then((me) => {
    if (!me && pendingGo && app.dataset.screen === "intro") goCard.hidden = false;
  });
} else if (entry.kind === "resume") {
  pendingToken = entry.token;
  welcomeBack.hidden = false;
  introFor("resume");
} else if (entry.kind === "bad-link") {
  // A used/expired link with a still-live session is not an error: show welcome-back instead (QA round 2, breaker H).
  void checkMe().then((me) => {
    if (!me?.known) backToIntro(EXPIRED_GO, true);
  });
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
    status.textContent = "Choose at least one, or write a note.";
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
