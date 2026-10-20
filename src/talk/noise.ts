// The barge-in gate: what the microphone may send while Aida is speaking. Pure (levels and opaque frames in,
// frames to send out), so every rule is tested in Node; voice.ts runs it on each 100 ms microphone frame.
//
// Owner, 20 Oct: noise or someone else talking made her stop mid-sentence, as if she had lagged out. While she
// speaks, the server hears everything the microphone sends and takes any sound for the person cutting in. So,
// while her voice is playing, a frame is sent only when the person's own voice is plainly there:
//
//   - an adaptive noise floor, learnt all the time: falls fast to a quieter room, rises slowly to a steady sound
//     near it (a fan, her echo), and creeps very slowly towards a loud steady one, so a sound that never stops is
//     learnt in seconds while a sentence, with its breaths, barely moves it;
//   - the gate opens only after 250 ms continuously above max(floor x 3, 0.02 RMS): a cough, a knock or her
//     own echo never does;
//   - when it opens, the last ~300 ms it held back go first (the start of their words), then everything, until
//     800 ms after the level falls back.
//
// While she is not speaking, every frame goes at once, as before. The voice detection keeps running either way:
// the status line uses it to say "Listening" while the person talks.

/** Continuous time above the threshold before the gate opens. */
export const OPEN_MS = 250;
/** How much held-back audio goes first when it opens. */
export const PREROLL_MS = 300;
/** How long it stays open after the level falls back. */
export const HOLD_MS = 800;
/** She counts as speaking for this long after her voice stops (her video plays a little behind her words). */
export const TAIL_MS = 500;
/** The threshold is this many times the noise floor... */
export const FLOOR_TIMES = 3;
/** ...and never below this RMS (about -34 dBFS). */
export const MIN_LEVEL = 0.02;

/** Per 100 ms: how far the floor moves towards a quieter frame, a frame near it, and a loud frame. */
const FALL = 0.3;
const RISE = 0.05;
const CREEP = 0.005;
const FLOOR_MIN = 0.001;

export interface GateFrame<T> {
  /** The audio, untouched: the gate only decides whether and when it goes. */
  item: T;
  /** Its loudness, RMS 0..1. */
  level: number;
  /** Its length. */
  ms: number;
}

export interface Gate<T> {
  /** The room's noise floor (RMS); null until the first frame. */
  floor: number | null;
  /** How long the level has been above the threshold without a break. */
  hotMs: number;
  /** How long since it was last above. */
  coolMs: number;
  /** A voice is there: open after OPEN_MS above, closed HOLD_MS after it falls back. */
  open: boolean;
  /** Time left in which her voice still counts as playing. */
  tailMs: number;
  /** Frames not sent, the last ~PREROLL_MS of them: only while she speaks and the gate is shut. */
  held: GateFrame<T>[];
}

export interface GateStep<T> {
  gate: Gate<T>;
  /** Frames to send now, in order (often none while she speaks, several when the gate opens). */
  send: T[];
}

/** A fresh gate. Pass the old floor to keep what was learnt of the room (a new microphone stream, same room). */
export function startGate<T>(floor: number | null = null): Gate<T> {
  return { floor, hotMs: 0, coolMs: 0, open: false, tailMs: 0, held: [] };
}

/** The level a frame must pass to count as a voice. */
export function thresholdFor(floor: number | null): number {
  return Math.max((floor ?? 0) * FLOOR_TIMES, MIN_LEVEL);
}

/** A per-100 ms rate as the fraction to move over `ms`. */
const over = (perTenth: number, ms: number): number => 1 - (1 - perTenth) ** (ms / 100);

function nextFloor(floor: number | null, level: number, ms: number): number {
  // The first frame seeds it: a sound that is there from the start is the room, not a voice.
  if (floor === null) return Math.max(level, FLOOR_MIN);
  const rate = level <= floor ? FALL : level < floor * 2 ? RISE : CREEP;
  return Math.max(FLOOR_MIN, floor + (level - floor) * over(rate, ms));
}

/** Keep the newest frames that make up PREROLL_MS. */
function trim<T>(held: GateFrame<T>[]): GateFrame<T>[] {
  let total = held.reduce((n, f) => n + f.ms, 0);
  let drop = 0;
  while (drop < held.length - 1 && total - (held[drop]?.ms ?? 0) >= PREROLL_MS) {
    total -= held[drop]?.ms ?? 0;
    drop++;
  }
  return drop ? held.slice(drop) : held;
}

/**
 * One microphone frame through the gate. `herSpeaking`: her voice is playing now (the PCM queue on a voice
 * call, her open caption on a video call).
 */
export function stepGate<T>(g: Gate<T>, frame: GateFrame<T>, herSpeaking: boolean): GateStep<T> {
  const level = Number.isFinite(frame.level) ? Math.max(0, frame.level) : 0;
  const ms = Number.isFinite(frame.ms) ? Math.max(0, frame.ms) : 0;
  const hot = g.floor !== null && level > thresholdFor(g.floor);
  const hotMs = hot ? g.hotMs + ms : 0;
  const coolMs = hot ? 0 : g.coolMs + ms;
  const open = hotMs >= OPEN_MS || (g.open && coolMs <= HOLD_MS);
  const gating = herSpeaking || g.tailMs > 0;
  const next: Gate<T> = {
    floor: nextFloor(g.floor, level, ms),
    hotMs,
    coolMs,
    open,
    tailMs: herSpeaking ? TAIL_MS : Math.max(0, g.tailMs - ms),
    held: [],
  };
  const held = g.held.map((f) => f.item);
  // She is not speaking: everything goes, as before. Frames held while she spoke go first only if they are
  // the start of words still going on; otherwise they were her echo or the room, and are dropped.
  if (!gating) return { gate: next, send: hot ? [...held, frame.item] : [frame.item] };
  // A voice over hers: the held frames (only there on the frame that opens it) first, then this one.
  if (open) return { gate: next, send: [...held, frame.item] };
  next.held = trim([...g.held, { item: frame.item, level, ms }]);
  return { gate: next, send: [] };
}
