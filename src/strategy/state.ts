// The client's strategy page has one small state machine: loading, a link
// that is gone, the "confirm it's you" form, the sent note, the strategy
// itself, and a connection problem. Everything here is pure — the API's
// status and body go in, the screen comes out — so every response in the
// contract is tested in Node, away from the page.

import { GATE_FAILED } from "../talk/turnstile";

/** A link token and a sign-in code are both 43 characters of base64url. */
export const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export const NOT_FOUND_COPY =
  "This link has expired or was withdrawn. Ask the Aida team for a new one.";
export const EXPIRED_CODE_COPY =
  "That sign-in link has expired or was already used. Send a new one.";
export const SENT_COPY =
  "If that's the address we have, a sign-in link is on its way. It works once, for 30 minutes.";
export const BAD_EMAIL_COPY = "Check the email address and try again.";
export const SEND_FAILED_COPY =
  "We could not send the link. Check your connection and try again.";
export const LOAD_FAILED_COPY =
  "We could not load your strategy. Check your connection and try again.";

export interface Play {
  name: string;
  whatWeWouldBuild: string;
  whatChangesForYou: string;
  firstStep: string;
  evidence: string;
}

export interface RoadmapPhase {
  when: string;
  items: string[];
}

export interface Deck {
  title: string;
  company: string;
  dateLabel: string;
  heard: { business: string; today: string[]; crux: string };
  swot: {
    strengths: string[];
    weaknesses: string[];
    opportunities: string[];
    threats: string[];
  };
  plays: Play[];
  roadmap: RoadmapPhase[];
  nextStep: string;
  speaker: string;
}

export interface StrategyView {
  company: string;
  firstName: string;
  publishedAt: string;
  updatedAt: string;
  contact: string | null;
  deck: Deck;
}

export type ScreenState =
  | { screen: "loading" }
  | { screen: "not-found" }
  | { screen: "sign-in"; hint: string; notice: string | null }
  | { screen: "sent"; hint: string }
  | { screen: "view"; view: StrategyView }
  | { screen: "trouble" };

export type StrategyEvent =
  | { type: "view"; status: number; body: unknown }
  | { type: "signin"; status: number; body: unknown }
  | { type: "verify"; status: number }
  | { type: "signout" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);

function readHeard(value: unknown): Deck["heard"] | null {
  if (!isRecord(value) || !isText(value.business) || !isText(value.crux) || !isTextList(value.today)) {
    return null;
  }
  return { business: value.business, today: value.today, crux: value.crux };
}

function readSwot(value: unknown): Deck["swot"] | null {
  if (!isRecord(value)) return null;
  const keys = ["strengths", "weaknesses", "opportunities", "threats"] as const;
  const out: Partial<Deck["swot"]> = {};
  for (const key of keys) {
    const list = value[key];
    if (!isTextList(list)) return null;
    out[key] = list;
  }
  return out as Deck["swot"];
}

function readPlay(value: unknown): Play | null {
  if (
    !isRecord(value) ||
    !isText(value.name) ||
    !isText(value.whatWeWouldBuild) ||
    !isText(value.whatChangesForYou) ||
    !isText(value.firstStep) ||
    !isText(value.evidence)
  ) {
    return null;
  }
  return {
    name: value.name,
    whatWeWouldBuild: value.whatWeWouldBuild,
    whatChangesForYou: value.whatChangesForYou,
    firstStep: value.firstStep,
    evidence: value.evidence,
  };
}

function readRoadmap(value: unknown): RoadmapPhase[] | null {
  if (!Array.isArray(value)) return null;
  const phases: RoadmapPhase[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isText(entry.when) || !isTextList(entry.items)) return null;
    phases.push({ when: entry.when, items: entry.items });
  }
  return phases;
}

function readDeck(value: unknown): Deck | null {
  if (!isRecord(value)) return null;
  const heard = readHeard(value.heard);
  const swot = readSwot(value.swot);
  const roadmap = readRoadmap(value.roadmap);
  if (
    !heard ||
    !swot ||
    !roadmap ||
    !isText(value.title) ||
    !isText(value.company) ||
    !isText(value.dateLabel) ||
    !isText(value.nextStep) ||
    !isText(value.speaker) ||
    !Array.isArray(value.plays)
  ) {
    return null;
  }
  const plays: Play[] = [];
  for (const entry of value.plays) {
    const play = readPlay(entry);
    if (!play) return null;
    plays.push(play);
  }
  return {
    title: value.title,
    company: value.company,
    dateLabel: value.dateLabel,
    heard,
    swot,
    plays,
    roadmap,
    nextStep: value.nextStep,
    speaker: value.speaker,
  };
}

/** The 200 body, if it is the shape the contract promises. */
export function readView(value: unknown): StrategyView | null {
  if (
    !isRecord(value) ||
    !isText(value.company) ||
    !isText(value.firstName) ||
    !isText(value.publishedAt) ||
    !isText(value.updatedAt) ||
    !(value.contact === null || value.contact === undefined || isText(value.contact))
  ) {
    return null;
  }
  const deck = readDeck(value.deck);
  if (!deck) return null;
  return {
    company: value.company,
    firstName: value.firstName,
    publishedAt: value.publishedAt,
    updatedAt: value.updatedAt,
    contact: value.contact ?? null,
    deck,
  };
}

/** The token and one-time code in the address bar, if they are well formed. */
export function readRoute(href: string): { token: string | null; code: string | null } {
  const url = new URL(href, "https://aida.invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  const raw = parts[0] === "strategy" && parts.length === 2 ? parts[1] : undefined;
  const token = raw && CODE_RE.test(raw) ? raw : null;
  const rawCode = url.searchParams.get("c");
  const code = rawCode && CODE_RE.test(rawCode) ? rawCode : null;
  return { token, code };
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function emailProblem(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter the email you gave Aida.";
  if (email.length > 160 || !EMAIL.test(email)) return "Enter a valid email address.";
  return null;
}

/** How long the sign-in form must wait, in the words the person reads. */
export function waitCopy(seconds: number): string {
  const wait = Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 60));
  if (wait < 60) return `Too many tries. Wait ${wait} second${wait === 1 ? "" : "s"} and try again.`;
  const minutes = Math.ceil(wait / 60);
  return `Too many tries. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

function hintFrom(body: unknown): string {
  return isRecord(body) && isText(body.hint) && body.hint.trim() ? body.hint : "your email";
}

function errorFrom(body: unknown): string | null {
  return isRecord(body) && isText(body.error) ? body.error : null;
}

function retryFrom(body: unknown): number {
  return isRecord(body) && typeof body.retryAfter === "number" ? body.retryAfter : 60;
}

/** The address the form was on, for the notice a 400 or a 429 leaves there. */
function signIn(hint: string, notice: string | null): ScreenState {
  return { screen: "sign-in", hint, notice };
}

export function reduce(state: ScreenState, event: StrategyEvent): ScreenState {
  switch (event.type) {
    case "view": {
      if (event.status === 200) {
        const view = readView(event.body);
        return view ? { screen: "view", view } : { screen: "trouble" };
      }
      if (event.status === 401) return signIn(hintFrom(event.body), null);
      if (event.status === 404) return { screen: "not-found" };
      return { screen: "trouble" };
    }
    case "signin": {
      const hint = state.screen === "sign-in" ? state.hint : "your email";
      if (event.status === 200) return { screen: "sent", hint };
      if (event.status === 400) {
        return signIn(hint, errorFrom(event.body) === "turnstile" ? GATE_FAILED : BAD_EMAIL_COPY);
      }
      if (event.status === 429) return signIn(hint, waitCopy(retryFrom(event.body)));
      return signIn(hint, SEND_FAILED_COPY);
    }
    case "verify": {
      if (event.status === 200) return { screen: "loading" };
      if (event.status === 400) {
        return signIn(state.screen === "sign-in" ? state.hint : "your email", EXPIRED_CODE_COPY);
      }
      return signIn(state.screen === "sign-in" ? state.hint : "your email", LOAD_FAILED_COPY);
    }
    case "signout":
      return { screen: "loading" };
  }
}
