// The conversation's wire format: what the browser sends to /api/talk and what
// comes back. Pure. Nothing customer-specific lives in the browser: the stage
// labels come from the server, the note-section labels are the page's own
// generic words.

export interface Stage {
  id: string;
  label: string;
}

export interface Approach {
  bespokeOrCommodity: string;
  kind: string;
}

export interface Summary {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
  crux: string;
  needs: string[];
  wants: string[];
  approach: Approach;
}

export type EndReason = "complete" | "ceiling" | "user" | "error";

export type AidaFrame =
  | { type: "ready"; targetMinutes: number; sections: Stage[] }
  | { type: "section"; id: string }
  | { type: "note"; section: string; text: string; at?: number }
  | { type: "summary"; summary: Summary }
  | { type: "reconnecting" }
  | { type: "resumed" }
  | { type: "ended"; reason: EndReason; minutes: number }
  | { type: "error"; message: string };

export interface AudioPart {
  data: string;
  mimeType: string;
}

/** The model's own frame, forwarded as-is. Any subset of these per frame. */
export interface ServerContent {
  audio: AudioPart[];
  input?: string;
  output?: string;
  interrupted: boolean;
  turnComplete: boolean;
}

export type ServerFrame = { kind: "aida"; frame: AidaFrame } | { kind: "model"; content: ServerContent };

/** The stages, in order. The server sends their labels; these ids are the fallback order. */
export const STAGE_IDS = ["welcome", "org", "tools", "workflows", "challenges", "needs", "summary"] as const;

/** Where a note can be filed, in the order the notebook shows them, with the page's own labels. */
export const NOTE_SECTIONS = [
  ["org", "Your organisation"],
  ["tools", "The tools you use"],
  ["workflows", "How the work flows"],
  ["strengths", "Strengths"],
  ["weaknesses", "Weaknesses"],
  ["opportunities", "Opportunities"],
  ["threats", "Threats"],
  ["crux", "The crux"],
  ["needs", "What you need"],
  ["wants", "What you want"],
  ["preferences", "How you like to work"],
] as const;

export type NoteSection = (typeof NOTE_SECTIONS)[number][0] | "other";

const NOTE_IDS = new Set<string>(NOTE_SECTIONS.map(([id]) => id));

export function noteSection(id: string): NoteSection {
  return NOTE_IDS.has(id) ? (id as NoteSection) : "other";
}

export function noteLabel(section: NoteSection): string {
  return NOTE_SECTIONS.find(([id]) => id === section)?.[1] ?? "Other notes";
}

// ---------- reading frames ----------

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 600))
        .filter(Boolean)
        .slice(0, 12)
    : [];

function readStages(v: unknown): Stage[] {
  if (!Array.isArray(v)) return [];
  const out: Stage[] = [];
  for (const item of v) {
    if (!isBag(item)) continue;
    const id = str(item.id, 40).trim();
    const label = str(item.label, 60).trim();
    if (id) out.push({ id, label: label || id });
  }
  return out;
}

export function readSummary(a: Bag): Summary {
  const approach = isBag(a.approach) ? a.approach : {};
  return {
    strengths: list(a.strengths),
    weaknesses: list(a.weaknesses),
    opportunities: list(a.opportunities),
    threats: list(a.threats),
    crux: str(a.crux, 1200).trim(),
    needs: list(a.needs),
    wants: list(a.wants),
    approach: {
      bespokeOrCommodity: str(approach.bespokeOrCommodity, 200).trim(),
      kind: str(approach.kind, 300).trim(),
    },
  };
}

const END_REASONS = new Set<string>(["complete", "ceiling", "user", "error"]);

function readAida(a: Bag): AidaFrame | null {
  switch (a.type) {
    case "ready": {
      const minutes = Number(a.targetMinutes);
      return {
        type: "ready",
        targetMinutes: Number.isFinite(minutes) && minutes > 0 && minutes < 240 ? minutes : 20,
        sections: readStages(a.sections),
      };
    }
    case "section": {
      const id = str(a.id, 40).trim();
      return id ? { type: "section", id } : null;
    }
    case "note": {
      const text = str(a.text, 600).trim();
      return text ? { type: "note", section: str(a.section, 40).trim(), text } : null;
    }
    case "summary":
      return { type: "summary", summary: readSummary(a) };
    case "reconnecting":
      return { type: "reconnecting" };
    case "resumed":
      return { type: "resumed" };
    case "ended": {
      const reason = str(a.reason, 20);
      const minutes = Number(a.minutes);
      return {
        type: "ended",
        reason: END_REASONS.has(reason) ? (reason as EndReason) : "complete",
        minutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : 0,
      };
    }
    case "error":
      return { type: "error", message: str(a.message, 300).trim() || "Something went wrong." };
    default:
      return null;
  }
}

function readContent(c: Bag): ServerContent {
  const audio: AudioPart[] = [];
  const turn = isBag(c.modelTurn) ? c.modelTurn : {};
  if (Array.isArray(turn.parts)) {
    for (const part of turn.parts) {
      if (!isBag(part) || !isBag(part.inlineData)) continue;
      const data = str(part.inlineData.data, 4_000_000);
      const mimeType = str(part.inlineData.mimeType, 80);
      if (data && (mimeType === "" || mimeType.startsWith("audio/pcm"))) audio.push({ data, mimeType });
    }
  }
  const text = (v: unknown): string | undefined => {
    const t = isBag(v) ? str(v.text) : "";
    return t ? t : undefined;
  };
  const content: ServerContent = {
    audio,
    interrupted: c.interrupted === true,
    turnComplete: c.turnComplete === true,
  };
  const input = text(c.inputTranscription);
  const output = text(c.outputTranscription);
  if (input !== undefined) content.input = input;
  if (output !== undefined) content.output = output;
  return content;
}

/** One frame from the socket, or null for anything this page does not understand. */
export function parseFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isBag(data)) return null;
  if (isBag(data.aida)) {
    const frame = readAida(data.aida);
    return frame ? { kind: "aida", frame } : null;
  }
  if (isBag(data.serverContent)) return { kind: "model", content: readContent(data.serverContent) };
  return null;
}

// ---------- writing frames ----------

export function audioMessage(base64: string): string {
  return JSON.stringify({ realtimeInput: { audio: { data: base64, mimeType: "audio/pcm;rate=16000" } } });
}

export function textMessage(text: string): string {
  return JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
}

export function endMessage(): string {
  return JSON.stringify({ aida: { type: "end" } });
}

/** The live socket's address, on this same site. */
export function socketUrl(id: string, location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/talk?id=${encodeURIComponent(id)}`;
}
