// What the room shows, as a function of the frames that have arrived. Pure:
// `reduce(state, event)` returns the next state and never touches the page,
// so every rule here (notes grouped, captions grown fragment by fragment, the
// stage bar, the ending) is tested in Node.

import {
  NOTE_SECTIONS,
  STAGE_IDS,
  noteLabel,
  noteSection,
  type EndReason,
  type NoteSection,
  type Resumed,
  type ServerContent,
  type ServerFrame,
  type Stage,
  type Summary,
} from "./protocol";

export type Speaker = "aida" | "you";

export interface Turn {
  id: number;
  who: Speaker;
  text: string;
  /** Still being spoken: fragments grow it. */
  open: boolean;
  /** This turn's fragments carry their own spacing (one arrived with leading whitespace). */
  explicit: boolean;
  typed?: boolean;
  /** She was cut off mid-sentence. */
  interrupted?: boolean;
}

export interface Note {
  id: number;
  section: NoteSection;
  text: string;
  /** Seconds into the conversation when she wrote it. */
  at: number;
  /** Kept from an earlier part of this conversation: already there, so nothing to flash. */
  restored?: boolean;
}

/** 4:07 style stamp for a note. */
export function noteStamp(at: number): string {
  const s = Math.max(0, Math.round(at));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The socket's health, for the quiet status line. */
/** `dropped`: the page's own socket closed mid-call and the page is reconnecting it (see reconnect.ts). */
export type Link = "connecting" | "live" | "reconnecting" | "resumed" | "dropped" | "lost" | "closed";

export interface TalkState {
  phase: "connecting" | "live" | "ending" | "ended";
  link: Link;
  targetMinutes: number;
  stages: Stage[];
  stage: string | null;
  notes: Note[];
  turns: Turn[];
  summary: Summary | null;
  ended: Ended | null;
  /** The server says her video is on this call (ready.avatar); false means voice and the drawn portrait. */
  avatar: boolean;
  /** Video gave out (or the person switched it off): the call was paused so it can go on by voice. */
  videoStopped: { switching: boolean } | null;
  /** The person chose voice only: the page is moving the call to a new voice-only line, the room staying. */
  switching: boolean;
  /** The server warned the line has gone quiet and will pause; null when nothing is pending. */
  idleWarning: { secondsLeft: number } | null;
  /** The person asked to continue later; the server's `ended` (paused) is awaited. */
  pausing: boolean;
  /** A returning conversation: the minutes already spent, and whether a summary exists. */
  resumed: { minutesSoFar: number; hasSummary: boolean } | null;
  error: string | null;
  /** Turns that finished in this step, for the screen-reader announcement. Fresh on every step. */
  finished: Turn[];
  nextId: number;
}

export interface Ended {
  reason: EndReason | "lost";
  minutes: number;
  /** The server kept the conversation so it can be picked up again. */
  resumable?: boolean;
  /** The server emailed the person a link; absent when it never said. */
  emailed?: boolean;
  /** The line ended without the person pressing anything. */
  abandoned?: boolean;
}

export type TalkEvent =
  | ServerFrame
  | { kind: "typed"; text: string }
  | { kind: "end-pressed" }
  | { kind: "pause-pressed" }
  | { kind: "here-pressed" }
  | { kind: "line-dropped" }
  | { kind: "video-stopped"; switching: boolean }
  | { kind: "switching" }
  | { kind: "closed"; minutes: number };

const MAX_TURNS = 60;
const MAX_NOTES = 200;

const FALLBACK_STAGE_LABELS: Readonly<Record<string, string>> = {
  welcome: "Welcome",
  org: "Your organisation",
  tools: "Your tools",
  workflows: "Workflows",
  challenges: "Challenges",
  needs: "Needs",
  summary: "Summary",
};

export function fallbackStages(): Stage[] {
  return STAGE_IDS.map((id) => ({ id, label: FALLBACK_STAGE_LABELS[id] ?? id }));
}

export function initialState(stages: Stage[] = [], targetMinutes = 20, resumed?: Resumed): TalkState {
  const s: TalkState = {
    phase: "connecting",
    link: "connecting",
    targetMinutes,
    stages: stages.length ? stages : fallbackStages(),
    stage: null,
    notes: [],
    turns: [],
    summary: null,
    ended: null,
    pausing: false,
    idleWarning: null,
    avatar: false,
    videoStopped: null,
    switching: false,
    resumed: null,
    error: null,
    finished: [],
    nextId: 1,
  };
  if (resumed) restore(s, resumed);
  return s;
}

/** Take a returning conversation's notebook, place and clock. Replaces, never appends: safe to apply twice. */
function restore(s: TalkState, r: Resumed): void {
  s.resumed = { minutesSoFar: r.minutesSoFar, hasSummary: r.hasSummary };
  const notes = r.notes.slice(-MAX_NOTES).map((n, i) => ({
    id: i + 1,
    section: noteSection(n.section),
    text: n.text,
    at: n.at ?? 0,
    restored: true,
  }));
  s.notes = notes;
  s.nextId = Math.max(s.nextId, notes.length + 1);
  if (r.stage) s.stage = r.stage;
}

// ---------- captions ----------

const LEADING_SPACE = /^\s/;
/** Punctuation that attaches to the word before it. */
const ATTACHES = /^[,.!?;:%)\]}…]/;

/**
 * Join one fragment onto a turn. A stream either carries its own spacing
 * (" dispatch", " process") or sends bare words ("dispatch", "process").
 * Adding a space to the first kind prints "dis patch" whenever a word is split
 * across fragments; adding none to the second prints "morningdispatch". So the
 * turn decides for itself: once a fragment arrives with leading whitespace,
 * the turn is joined verbatim; until then, bare fragments are whole words.
 */
export function joinFragment(prev: string, chunk: string, explicit: boolean): string {
  if (explicit) return prev ? prev + chunk : chunk.trimStart();
  const bare = chunk.trim();
  if (!bare) return prev;
  if (!prev) return bare;
  return ATTACHES.test(bare) ? prev + bare : `${prev} ${bare}`;
}

/** The text to show for a turn: whitespace runs collapsed. */
export function turnText(turn: Turn): string {
  return turn.text.replace(/\s+/g, " ").trim();
}

function closeOpen(s: TalkState, except?: Speaker, interrupted = false): void {
  const last = s.turns[s.turns.length - 1];
  if (!last?.open || last.who === except) return;
  const closed: Turn = { ...last, open: false };
  if (interrupted) closed.interrupted = true;
  s.turns = [...s.turns.slice(0, -1), closed];
  if (turnText(closed)) s.finished = [...s.finished, closed];
}

function pushTurn(s: TalkState, turn: Omit<Turn, "id">): void {
  const next = [...s.turns, { ...turn, id: s.nextId++ }];
  s.turns = next.length > MAX_TURNS ? next.slice(-MAX_TURNS) : next;
}

function addFragment(s: TalkState, who: Speaker, chunk: string): void {
  const last = s.turns[s.turns.length - 1];
  if (last?.open && last.who === who) {
    const explicit = last.explicit || LEADING_SPACE.test(chunk);
    s.turns = [...s.turns.slice(0, -1), { ...last, text: joinFragment(last.text, chunk, explicit), explicit }];
    return;
  }
  closeOpen(s, who);
  if (!chunk.trim()) return;
  pushTurn(s, { who, text: chunk.trim(), open: true, explicit: LEADING_SPACE.test(chunk) });
}

function applyContent(s: TalkState, c: ServerContent): void {
  if (c.interrupted) closeOpen(s, "you", true);
  if (c.input) {
    addFragment(s, "you", c.input);
    s.idleWarning = null; // speaking counts as being there
  }
  // Her voice or her words: either means the person's turn is over.
  if (c.audio.length || c.output) closeOpen(s, "aida");
  if (c.output) addFragment(s, "aida", c.output);
  if (c.turnComplete) closeOpen(s, "you");
}

// ---------- the reducer ----------

function finish(s: TalkState, reason: EndReason | "lost", minutes: number, extra: Partial<Ended> = {}): void {
  closeOpen(s);
  const abandoned = s.phase !== "ending" && (reason === "user" || reason === "error");
  s.phase = "ended";
  s.idleWarning = null;
  s.link = reason === "lost" ? "lost" : "closed";
  s.ended = { reason, minutes, ...extra, ...(abandoned ? { abandoned: true } : {}) };
}

export function reduce(state: TalkState, event: TalkEvent): TalkState {
  const s: TalkState = { ...state, finished: [] };
  switch (event.kind) {
    case "typed": {
      const text = event.text.trim();
      if (!text) return state;
      s.idleWarning = null;
      closeOpen(s);
      pushTurn(s, { who: "you", text, open: false, explicit: true, typed: true });
      return s;
    }
    case "end-pressed":
      if (s.phase === "ended") return state;
      s.phase = "ending";
      s.idleWarning = null;
      return s;
    case "video-stopped":
      if (s.phase === "ended" || s.phase === "ending") return state;
      s.phase = "ending";
      s.pausing = true;
      s.idleWarning = null;
      s.videoStopped = { switching: event.switching };
      return s;
    case "switching":
      // The button, not a failure: the room stays, the clock runs, and the page moves the call itself
      // (18 Oct, mobile: the old path showed the whole end page for ~23 s and reset the clock). Allowed
      // while connecting too: re-entering the reopened room resets the state, and the move is still on.
      if (s.phase === "ending" || s.phase === "ended" || s.switching) return state;
      s.switching = true;
      s.idleWarning = null;
      return s;
    case "line-dropped":
      // The page reconnects on its own; until then the room stays, quiet, with what she said so far.
      if (s.phase !== "live") return state;
      closeOpen(s);
      s.link = "dropped";
      s.idleWarning = null;
      return s;
    case "here-pressed":
      if (!s.idleWarning) return state;
      s.idleWarning = null;
      return s;
    case "pause-pressed":
      if (s.phase === "ended") return state;
      s.phase = "ending";
      s.pausing = true;
      s.idleWarning = null;
      return s;
    case "closed":
      // A socket that closes after the end changes nothing; one that closes
      // before it means the line dropped. Never leave the person in a dead room.
      if (s.phase === "ended") {
        s.link = s.link === "lost" ? "lost" : "closed";
        return s;
      }
      finish(s, s.phase === "ending" ? (s.pausing ? "paused" : "user") : "lost", event.minutes);
      return s;
    case "model":
      if (s.phase === "ended") return state;
      applyContent(s, event.content);
      return s;
    case "aida":
      break;
  }

  const f = event.frame;
  switch (f.type) {
    case "ready":
      if (f.sections.length) s.stages = f.sections;
      s.targetMinutes = f.targetMinutes;
      // The resume reply already seeded these; applying them again replaces, so nothing doubles.
      if (f.resumed && s.phase === "connecting") restore(s, f.resumed);
      if (s.phase === "connecting") s.phase = "live";
      s.link = "live";
      // The opened line is up: if this was the voice-only switch, the move is done.
      s.switching = false;
      s.avatar = f.avatar === true;
      s.stage ??= s.stages[0]?.id ?? null;
      return s;
    case "budget":
      s.targetMinutes = f.minutes;
      return s;
    case "idle_warning":
      if (s.phase === "live") s.idleWarning = { secondsLeft: f.secondsLeft };
      return s;
    case "section":
      s.stage = f.id;
      return s;
    case "note": {
      const next = [...s.notes, { id: s.nextId++, section: noteSection(f.section), text: f.text, at: f.at ?? 0 }];
      s.notes = next.length > MAX_NOTES ? next.slice(-MAX_NOTES) : next;
      return s;
    }
    case "summary":
      s.summary = f.summary;
      return s;
    case "reconnecting":
      if (s.phase !== "ended") s.link = "reconnecting";
      return s;
    case "resumed":
      if (s.phase !== "ended") s.link = "resumed";
      return s;
    case "ended":
      // While the page is moving the call to voice only, an `ended` (switch) from the old socket is
      // expected, not an ending: the page's own /continue decides what happens next.
      if (s.switching) return state;
      finish(s, f.reason, f.minutes, {
        ...(f.resumable ? { resumable: true } : {}),
        ...(f.resumable || f.reason === "paused" ? { emailed: f.emailed } : {}),
      });
      return s;
    case "error":
      s.error = f.message;
      return s;
  }
}

// ---------- derived views ----------

export interface Progress {
  /** Index of the current stage; -1 before the first. */
  index: number;
  total: number;
  label: string;
}

export function progress(s: TalkState): Progress {
  const total = s.stages.length;
  if (s.phase === "ended") return { index: total, total, label: "Done" };
  const index = s.stages.findIndex((st) => st.id === s.stage);
  return { index, total, label: s.stages[index]?.label ?? "" };
}

export type StageStatus = "done" | "current" | "todo";

export function stageStatus(i: number, p: Progress): StageStatus {
  if (i < p.index) return "done";
  return i === p.index ? "current" : "todo";
}

export interface NoteGroup {
  section: NoteSection;
  label: string;
  notes: Note[];
}

/** Notes by section, in the notebook's order, empty sections left out. */
export function groupNotes(notes: readonly Note[]): NoteGroup[] {
  const order: NoteSection[] = [...NOTE_SECTIONS.map(([id]) => id), "other"];
  return order
    .map((section) => ({ section, label: noteLabel(section), notes: notes.filter((n) => n.section === section) }))
    .filter((g) => g.notes.length > 0);
}

/** Seconds as m:ss. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

/** The last turn of each speaker, for the two caption lines. */
export function latestTurns(s: TalkState): { aida?: Turn; you?: Turn; last?: Speaker } {
  const out: { aida?: Turn; you?: Turn; last?: Speaker } = {};
  for (let i = s.turns.length - 1; i >= 0 && !(out.aida && out.you); i--) {
    const t = s.turns[i];
    if (!t) continue;
    out.last ??= t.who;
    if (t.who === "aida") out.aida ??= t;
    else out.you ??= t;
  }
  return out;
}

// ---------- how it ended ----------

/**
 * Which end screen to show: paused by the person, saved after the line went, put on hold because it
 * went quiet, stopped by the server (declined, budget), or an ordinary finish.
 */
export type EndView =
  | { kind: "paused" | "saved"; emailed: boolean | undefined }
  | { kind: "video"; switching: boolean }
  | { kind: "idle" | "declined" | "budget" | "dropped" | "done" };

export function endView(s: TalkState): EndView {
  const e = s.ended;
  if (!e) return { kind: "done" };
  if ((e.reason === "paused" || e.reason === "switch") && s.videoStopped) return { kind: "video", switching: s.videoStopped.switching };
  if (e.reason === "paused") return { kind: "paused", emailed: e.emailed };
  if (e.reason === "idle") return { kind: "idle" };
  if (e.reason === "declined") return { kind: "declined" };
  if (e.reason === "budget") return { kind: "budget" };
  if (e.resumable && (e.abandoned || e.reason === "error")) return { kind: "saved", emailed: e.emailed };
  // The socket closed with no `ended` and reconnecting did not bring it back: the server keeps a dropped
  // call resumable, so this screen offers Continue as well as the notes.
  if (e.reason === "lost") return { kind: "dropped" };
  return { kind: "done" };
}
