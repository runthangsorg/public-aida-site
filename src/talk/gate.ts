// Getting in: the email-confirmation gate. Reading the two kinds of link, the
// start reply (a link was emailed, or this browser already holds a session),
// the confirm / continue / new replies, what the server remembers about a
// returning visitor, the resend countdown, and the words for each outcome.
// Pure (no page, no network), so every rule is tested in Node.
//
// Secrets: a link's token and the person's email live in memory only. They are
// never written to storage or logged, and the only place a token ever appears
// in an address is the link the server gave them, taken out of the address bar
// as soon as the page loads.

import { readMinutes, readResumed, readStages, type Resumed, type Stage } from "./protocol";
import { refusal, type StartRefusal } from "./details";

const TOKEN = /^[0-9a-f]{64}$/i;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const code = (v: unknown): string => (isBag(v) && typeof v.error === "string" ? v.error : "");

// ---------- the address bar ----------

/** Everything the address bar carried that this page acts on, and the address to leave in its place. */
export interface Landing {
  /** A well-formed `?go=` token (the confirmation link), or null. */
  go: string | null;
  /** A well-formed `?resume=` token (the continue link), or null. */
  resume: string | null;
  /** Either parameter was there at all, valid or not. */
  present: boolean;
  /** The same address without `go` and `resume`; everything else kept. */
  clean: string;
}

function token(raw: string | null): string | null {
  const t = raw === null ? "" : raw.trim();
  return TOKEN.test(t) ? t.toLowerCase() : null;
}

export function readLanding(loc: { pathname: string; search: string; hash: string }): Landing {
  const params = new URLSearchParams(loc.search);
  const present = params.has("go") || params.has("resume");
  const go = token(params.get("go"));
  const resume = token(params.get("resume"));
  params.delete("go");
  params.delete("resume");
  const rest = params.toString();
  return { go, resume, present, clean: `${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}` };
}

/** Read the links and take the tokens out of the address bar (and history) at once. */
export function takeLanding(
  loc: { pathname: string; search: string; hash: string },
  history: { replaceState(data: unknown, unused: string, url?: string): void },
): Landing {
  const landing = readLanding(loc);
  if (landing.present) history.replaceState(null, "", landing.clean);
  return landing;
}

/** What the first screen should do on load. */
export type Entry =
  | { kind: "go"; token: string }
  | { kind: "resume"; token: string }
  | { kind: "bad-link" }
  | { kind: "me" };

/**
 * `?go` wins over `?resume`, and either wins over the cookie (which is only asked about when the
 * address carried neither). A link that is present but malformed is an expired link, never a reason
 * to quietly show the visitor someone else's welcome-back card.
 */
export function entryFor(l: Landing): Entry {
  if (l.go) return { kind: "go", token: l.go };
  if (l.resume) return { kind: "resume", token: l.resume };
  if (l.present) return { kind: "bad-link" };
  return { kind: "me" };
}

// ---------- copy ----------

export const EXPIRED_GO = "That link has expired or was already used. Enter your email to get a new one.";
export const WAIT_FEW_MINUTES = "Please wait a few minutes.";
export const waitMessage = (retryAfter: unknown): string => {
  const n = Number(retryAfter);
  if (!Number.isFinite(n) || n <= 0) return WAIT_FEW_MINUTES;
  const minutes = Math.max(1, Math.ceil(n / 60));
  return `Please wait about ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
};
export const NETWORK_TRY_AGAIN = "We couldn’t reach Aida. Check your connection and try again.";
export const BUSY_OTHER_WINDOW = "You already have a conversation open in another window.";
export const DAILY_LIMIT = "You have reached today’s limit. Please come back tomorrow.";
export const USE_EMAILED_LINK = "Use the link we emailed you.";
export const EMAIL_FAILED = "We couldn’t send the email just now. Please try again in a moment.";
export const RESENT = "Sent again if we have your details.";

// ---------- the start reply ----------

export interface Opened {
  id: string;
  targetMinutes: number;
  sections: Stage[];
  /** First name, when the server gave one. */
  name: string;
  /** Present for a returning conversation. */
  resumed?: Resumed;
}

/** A session reply: `{ id, targetMinutes, sections, name?, resumed? }`. Null if it is not shaped as promised. */
export function readOpened(data: unknown): Opened | null {
  if (!isBag(data) || typeof data.id !== "string" || !data.id) return null;
  const name = typeof data.name === "string" ? (data.name.trim().split(/\s+/)[0] ?? "") : "";
  const opened: Opened = {
    id: data.id,
    targetMinutes: readMinutes(data.targetMinutes),
    sections: readStages(data.sections),
    name: name.slice(0, 80),
  };
  const resumed = readResumed(data.resumed);
  if (resumed) opened.resumed = resumed;
  return opened;
}

/** The reply of continue (and resume): a session that must carry what was kept. */
export function readContinued(data: unknown): Opened | null {
  const opened = readOpened(data);
  return opened?.resumed ? opened : null;
}

export const DEFAULT_RESEND_SECONDS = 120;

function readSeconds(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.ceil(n) : DEFAULT_RESEND_SECONDS;
}

export type StartReply =
  | { kind: "pending"; hint: string; resendInSeconds: number }
  | { kind: "session"; opened: Opened }
  | { kind: "refused"; refusal: StartRefusal };

/** What /api/talk/start answered. `hint` is the server's masked address, shown as text and nothing else. */
export function readStartReply(status: number, data: unknown): StartReply {
  if (status >= 200 && status < 300 && isBag(data)) {
    if (data.pending === true) {
      const hint = typeof data.hint === "string" ? data.hint.trim().slice(0, 160) : "";
      return { kind: "pending", hint, resendInSeconds: readSeconds(data.resendInSeconds) };
    }
    const opened = readOpened(data);
    if (opened) return { kind: "session", opened };
  }
  return { kind: "refused", refusal: refusal(status >= 200 && status < 300 ? 500 : status, data) };
}

// ---------- the check-your-email screen ----------

/** Whole seconds until `endsAt` (a monotonic clock reading, in ms), never below zero. Survives a sleeping tab. */
export function secondsLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

/** The resend button's label: counting down as m:ss, then plain. */
export function resendLabel(left: number): string {
  if (left <= 0) return "Send it again";
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return `Send it again (${m}:${s})`;
}

export interface ResendOutcome {
  message: string;
  ok: boolean;
  /** Restart the countdown from this many seconds (only when ok). */
  resendInSeconds?: number;
}

/** What /api/talk/resend answered. A 200 never claims more than "if we have your details". */
export function resendOutcome(status: number, data: unknown): ResendOutcome {
  if (status === 200) {
    return { message: RESENT, ok: true, resendInSeconds: readSeconds(isBag(data) ? data.resendInSeconds : undefined) };
  }
  if (status === 429) return { message: waitMessage(isBag(data) ? data.retryAfter : undefined), ok: false };
  return { message: EMAIL_FAILED, ok: false };
}

// ---------- the confirmation link ----------

/** What to do after /api/talk/confirm said no: try again with the same token, or let it go. */
export interface ConfirmRefusal {
  message: string;
  /**
   * `retry`: keep the card and the token, the same button tries again.
   * `expired`: the link is spent or unknown: drop it, offer a new one by email.
   * `stop`: nothing to retry today: drop it and say why.
   */
  outcome: "retry" | "expired" | "stop";
}

export function confirmRefusal(status: number, data: unknown): ConfirmRefusal {
  const c = code(data);
  if (status === 404 || status === 410 || c === "unknown" || c === "expired" || c === "used") {
    return { message: EXPIRED_GO, outcome: "expired" };
  }
  if (status === 409 || c === "busy") return { message: BUSY_OTHER_WINDOW, outcome: "retry" };
  if (c === "daily_limit") return { message: DAILY_LIMIT, outcome: "stop" };
  if (status === 429) return { message: waitMessage(isBag(data) ? data.retryAfter : undefined), outcome: "retry" };
  return { message: "We could not open that link just now. Please try again in a moment.", outcome: "retry" };
}

// ---------- a returning visitor ----------

export type LimitReason = "daily_limit" | "busy";

export interface Me {
  known: true;
  /** A confirmed interview that was never started is waiting: the card says Start and uses it. */
  startReady?: boolean;
  name: string;
  canContinue: boolean;
  minutesSoFar?: number;
  canStartNew: boolean;
  reasonIfNot?: LimitReason;
}

export function limitMessage(reason: LimitReason): string {
  return reason === "daily_limit" ? DAILY_LIMIT : "A conversation is already open in another window.";
}

/** The reply of GET /api/talk/me. Anything but a well-formed `known: true` is a stranger. */
export function readMe(data: unknown): Me | null {
  if (!isBag(data) || data.known !== true) return null;
  const name = typeof data.name === "string" ? (data.name.trim().split(/\s+/)[0] ?? "") : "";
  const me: Me = {
    known: true,
    name: name.slice(0, 80),
    canContinue: data.canContinue === true,
    canStartNew: data.canStartNew === true,
  };
  const minutes = Number(data.minutesSoFar);
  if (data.minutesSoFar !== undefined && data.minutesSoFar !== null && Number.isFinite(minutes) && minutes >= 0 && minutes < 240) {
    me.minutesSoFar = minutes;
  }
  if (data.reasonIfNot === "daily_limit" || data.reasonIfNot === "busy") me.reasonIfNot = data.reasonIfNot;
  if (data.startReady === true) me.startReady = true;
  return me;
}

export const BUSY_CARD = "A conversation is already open in another window.";
export const BUSY_CLEARS = "If you closed it, this clears within a minute.";

export interface KnownCopy {
  title: string;
  detail: string;
  notYou: string;
  /** A limit to say under the buttons (today's limit); empty when there is none. */
  limit: string;
  startLabel: string;
  /**
   * The server says a call is open elsewhere: the card says so, every button is disabled (never an active
   * Continue beside "already open"), and a quiet Check again re-reads /api/talk/me.
   */
  busy: boolean;
}

/** The welcome-back card's wording for a returning visitor. */
export function knownCopy(me: Me): KnownCopy {
  const who = me.name;
  const mins = me.minutesSoFar === undefined ? 0 : Math.round(me.minutesSoFar);
  const busy = me.reasonIfNot === "busy";
  const startOnly = me.startReady === true && !me.canContinue;
  const sofar = mins >= 1 ? `You have talked for ${mins} min so far. ` : "";
  let detail: string;
  if (busy) detail = `${BUSY_CARD} ${BUSY_CLEARS}`;
  else if (startOnly) detail = "Your email is confirmed. Start whenever you are ready.";
  else if (me.canContinue && me.canStartNew) detail = `${sofar}Pick it up where you stopped, or start afresh.`;
  else if (me.canContinue) detail = `${sofar}Pick it up where you stopped.`;
  else if (me.canStartNew) detail = "Start a new conversation whenever you are ready.";
  else detail = "";
  return {
    title: who ? `Welcome back, ${who}` : "Welcome back",
    startLabel: startOnly ? "Start" : "Start a new conversation",
    detail,
    notYou: who ? `Not ${who}? Use a different email` : "Not you? Use a different email",
    limit: !busy && !me.canStartNew && me.reasonIfNot ? limitMessage(me.reasonIfNot) : "",
    busy,
  };
}

/** What continue / new answered when it was not a session. */
export interface EntryRefusal {
  message: string;
  /**
   * `login`: the cookie is gone or not valid: show the normal intro.
   * `nothing`: nothing to continue: hide the Continue button.
   * `stop`: a limit: say so.
   * `retry`: say so; the buttons stay.
   */
  outcome: "login" | "nothing" | "stop" | "retry";
}

export function entryRefusal(status: number, data: unknown): EntryRefusal {
  const c = code(data);
  if (status === 401 || c === "no_session") return { message: USE_EMAILED_LINK, outcome: "login" };
  if (status === 404 || c === "nothing_to_continue") {
    return { message: "There is nothing to continue. Start a new conversation.", outcome: "nothing" };
  }
  if (c === "daily_limit") return { message: DAILY_LIMIT, outcome: "stop" };
  if (status === 409 || c === "busy") return { message: BUSY_OTHER_WINDOW, outcome: "stop" };
  if (status === 429) return { message: waitMessage(isBag(data) ? data.retryAfter : undefined), outcome: "retry" };
  return { message: "We could not open it just now. Please try again in a moment.", outcome: "retry" };
}

// ---------- the microphone and the connection: never a dead end ----------

/** After a few seconds with no answer from the browser's microphone question. */
export const MIC_STILL_WAITING =
  "Still waiting for your browser. If you do not see a question about the microphone, look beside the address bar, or type your answers instead.";
export const MIC_PROMPT_HELP_MS = 8000;

export const COULD_NOT_CONNECT = "We couldn’t connect you to Aida just now. Please try again, or type your answers instead.";
export const COULD_NOT_CONNECT_AGAIN =
  "Still no connection. Please try once more. If it keeps failing, close this page and open the link in your email again.";

/** What to say after the line failed to open, by how many times it has. */
export function connectFailedText(fails: number): string {
  return fails > 1 ? COULD_NOT_CONNECT_AGAIN : COULD_NOT_CONNECT;
}

// ---------- the idle warning ----------

/** The banner's visible sentence. */
export function idleSentence(left: number): string {
  return `Still there? We will pause in ${left} ${left === 1 ? "second" : "seconds"} and save your place.`;
}

// ---------- the end screens the server chooses ----------

export interface Closing {
  title: string;
  lede: string;
}

/** Under the heading "The line dropped": the heading already says what happened. */
export const DROPPED_LEDE = "Your place is saved, so you can carry on where you stopped.";
export const DROPPED_STILL_CLOSING = "Your last call is still closing. Please try again in a minute.";
export const IDLE_CLOSING: Closing = { title: "Paused", lede: "It went quiet. Your place is saved." };
export const VIDEO_STOPPED_CLOSING: Closing = {
  title: "The video stopped",
  lede: "We have saved your place. You can carry on by voice.",
};
export const SWITCHING_CLOSING: Closing = { title: "Switching to voice only", lede: "Saving your place, one moment." };
export const DECLINED_CLOSING: Closing = {
  title: "Thank you",
  lede: "This conversation is only for the interview, so we have stopped here. Thank you.",
};
export const BUDGET_LEDE = "We have reached the limit for one conversation. Thank you: the team has what you said.";
