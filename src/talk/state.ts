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
}

/** The socket's health, for the quiet status line. */
export type Link = "connecting" | "live" | "reconnecting" | "resumed" | "lost" | "closed";

export interface TalkState {
  phase: "connecting" | "live" | "ending" | "ended";
  link: Link;
  targetMinutes: number;
  stages: Stage[];
  stage: string | null;
  notes: Note[];
  turns: Turn[];
  summary: Summary | null;
  ended: { reason: EndReason | "lost"; minutes: number } | null;
  error: string | null;
  /** Turns that finished in this step, for the screen-reader announcement. Fresh on every step. */
  finished: Turn[];
  nextId: number;
}

export type TalkEvent =
  | ServerFrame
  | { kind: "typed"; text: string }
  | { kind: "end-pressed" }
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

export function initialState(stages: Stage[] = [], targetMinutes = 20): TalkState {
  return {
    phase: "connecting",
    link: "connecting",
    targetMinutes,
    stages: stages.length ? stages : fallbackStages(),
    stage: null,
    notes: [],
    turns: [],
    summary: null,
    ended: null,
    error: null,
    finished: [],
    nextId: 1,
  };
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
  if (c.input) addFragment(s, "you", c.input);
  // Her voice or her words: either means the person's turn is over.
  if (c.audio.length || c.output) closeOpen(s, "aida");
  if (c.output) addFragment(s, "aida", c.output);
  if (c.turnComplete) closeOpen(s, "you");
}

// ---------- the reducer ----------

function finish(s: TalkState, reason: EndReason | "lost", minutes: number): void {
  closeOpen(s);
  s.phase = "ended";
  s.link = reason === "lost" ? "lost" : "closed";
  s.ended = { reason, minutes };
}

export function reduce(state: TalkState, event: TalkEvent): TalkState {
  const s: TalkState = { ...state, finished: [] };
  switch (event.kind) {
    case "typed": {
      const text = event.text.trim();
      if (!text) return state;
      closeOpen(s);
      pushTurn(s, { who: "you", text, open: false, explicit: true, typed: true });
      return s;
    }
    case "end-pressed":
      if (s.phase === "ended") return state;
      s.phase = "ending";
      return s;
    case "closed":
      // A socket that closes after the end changes nothing; one that closes
      // before it means the line dropped. Never leave the person in a dead room.
      if (s.phase === "ended") {
        s.link = s.link === "lost" ? "lost" : "closed";
        return s;
      }
      finish(s, s.phase === "ending" ? "user" : "lost", event.minutes);
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
      if (s.phase === "connecting") s.phase = "live";
      s.link = "live";
      s.stage ??= s.stages[0]?.id ?? null;
      return s;
    case "section":
      s.stage = f.id;
      return s;
    case "note": {
      const next = [...s.notes, { id: s.nextId++, section: noteSection(f.section), text: f.text }];
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
      finish(s, f.reason, f.minutes);
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
