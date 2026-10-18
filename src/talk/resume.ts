// Continuing later: reading the link, talking to the two resume endpoints,
// and the words for each outcome. Pure (no page, no network), so the rules
// are tested in Node. The token is a secret: it is read once, taken out of
// the address bar, and only ever sent in the body of one POST.

import { readMinutes, readResumed, readStages, type Resumed, type Stage } from "./protocol";

const TOKEN = /^[0-9a-f]{64}$/i;

/** What the address bar held, and the address to leave in its place. */
export interface LinkRead {
  /** A well-formed token, or null (absent, or not 64 hex characters). */
  token: string | null;
  /** The parameter was there at all, valid or not. */
  present: boolean;
  /** The same address without `resume`; everything else kept. */
  clean: string;
}

export function readResumeLink(loc: { pathname: string; search: string; hash: string }): LinkRead {
  const params = new URLSearchParams(loc.search);
  const raw = params.get("resume");
  const present = params.has("resume");
  params.delete("resume");
  const rest = params.toString();
  const clean = `${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}`;
  const token = raw !== null && TOKEN.test(raw.trim()) ? raw.trim().toLowerCase() : null;
  return { token, present, clean };
}

/** Read the link and remove the token from the address bar (and so from history) at once. */
export function takeResumeToken(
  loc: { pathname: string; search: string; hash: string },
  history: { replaceState(data: unknown, unused: string, url?: string): void },
): LinkRead {
  const link = readResumeLink(loc);
  if (link.present) history.replaceState(null, "", link.clean);
  return link;
}

export interface ResumeSession {
  id: string;
  targetMinutes: number;
  sections: Stage[];
  /** First name only, for the end screen. */
  name: string;
  resumed: Resumed;
}

/** The 200 reply of /api/talk/resume, or null if it is not shaped as promised. */
export function readResumeReply(data: unknown): ResumeSession | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return null;
  const resumed = readResumed(d.resumed);
  if (!resumed) return null;
  const name = typeof d.name === "string" ? d.name.trim().split(/\s+/)[0] ?? "" : "";
  return {
    id: d.id,
    targetMinutes: readMinutes(d.targetMinutes),
    sections: readStages(d.sections),
    name: name.slice(0, 80),
    resumed,
  };
}

export const EXPIRED_LINK =
  "That link has expired or was already used. Enter your email below and we will send a new one.";
export const WAIT_A_FEW_MINUTES = "Please wait a few minutes and try again.";

export const NETWORK_TRY_AGAIN = "We couldn’t reach Aida. Check your connection and try again.";

export interface ResumeRefusal {
  message: string;
  /** Open the "send me a new link" form. */
  offerRelink: boolean;
  /** Keep the token in memory so the same button can try again; false means the link is spent or unknown. */
  retry: boolean;
}

/** What to say when the link could not be opened, and whether the same link is worth another try. */
export function resumeRefusal(status: number, data: unknown): ResumeRefusal {
  const error = typeof data === "object" && data !== null ? (data as Record<string, unknown>).error : undefined;
  if (status === 404 || status === 410 || error === "unknown" || error === "expired" || error === "used") {
    return { message: EXPIRED_LINK, offerRelink: true, retry: false };
  }
  if (status === 429 || error === "too_many") return { message: WAIT_A_FEW_MINUTES, offerRelink: false, retry: true };
  return { message: "We could not open that link just now. Please try again in a moment.", offerRelink: false, retry: true };
}

/** A well-formed address in the loose sense the server also uses: something, an @, something with a dot. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 160 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

export const RELINK_SENT =
  "If we have a conversation of yours waiting, we have emailed you a link. It can take up to a minute.";
export const RELINK_INVALID = "Please enter a valid email address.";

/** What /api/talk/relink's answer means for the person. */
export function relinkOutcome(status: number): { message: string; ok: boolean } {
  if (status === 200) return { message: RELINK_SENT, ok: true };
  if (status === 400) return { message: RELINK_INVALID, ok: false };
  if (status === 429) return { message: WAIT_A_FEW_MINUTES, ok: false };
  return { message: "That did not send. Please try again in a moment.", ok: false };
}

// ---------- the end screens that are not the summary ----------

export interface EndCopy {
  title: string;
  lede: string;
  /** A second, smaller line; empty when there is none. */
  more: string;
}

const CHECK_SPAM = "Didn’t get it? Check spam, or use Continue on the first screen.";
const START_AGAIN = "We could not email you. Start again from the first screen and use Continue.";

/** She was paused by the person. `emailed` undefined: the server never said. */
export function pausedCopy(emailed: boolean | undefined): EndCopy {
  if (emailed === true) {
    return { title: "Saved", lede: "We have emailed you a link to continue. It works for 14 days.", more: CHECK_SPAM };
  }
  if (emailed === false) return { title: "Saved", lede: START_AGAIN, more: "" };
  return {
    title: "Saved",
    lede: "We have asked for your conversation to be saved, but have not heard back yet.",
    more: "If no email arrives in a few minutes, start again from the first screen and use Continue.",
  };
}

/** The line went without the person ending it, and the server kept the conversation. */
export function savedCopy(emailed: boolean | undefined): EndCopy {
  if (emailed === true) {
    return { title: "Your conversation is saved", lede: "We have emailed you a link to continue.", more: CHECK_SPAM };
  }
  return { title: "Your conversation is saved", lede: START_AGAIN, more: "" };
}
