import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/talk/protocol";
import {
  DROPPED_STATUS,
  MAX_RECONNECTS,
  RECONNECT_RETRY_MS,
  RECONNECT_WINDOW_MS,
  reconnecting,
  startReconnect,
  stepReconnect,
  type Reconnect,
  type ReconnectEvent,
} from "../src/talk/reconnect";
import { endView, initialState, reduce, type TalkState } from "../src/talk/state";

/** Run events through the machine; the actions it asked for, in order. */
function run(events: ReconnectEvent[], from: Reconnect = startReconnect()): { state: Reconnect; actions: string[] } {
  let state = from;
  const actions: string[] = [];
  for (const e of events) {
    const step = stepReconnect(state, e);
    state = step.state;
    if (step.action.kind !== "none") actions.push(step.action.kind);
  }
  return { state, actions };
}

describe("a dropped line reconnects on its own", () => {
  it("a drop during a live call asks at once", () => {
    const { state, actions } = run([{ t: "dropped", now: 0, live: true }]);
    expect(actions).toEqual(["ask"]);
    expect(state.phase).toBe("asking");
    expect(reconnecting(state)).toBe(true);
    expect(DROPPED_STATUS).toBe("Reconnecting…");
  });

  it("200 after two 409s: retried every 5 s, then the room opens, with nothing pressed", () => {
    const { state, actions } = run([
      { t: "dropped", now: 0, live: true },
      { t: "reply", now: 300, status: 409 },
      { t: "tick", now: 2000 }, // too soon
      { t: "tick", now: 300 + RECONNECT_RETRY_MS },
      { t: "reply", now: 5600, status: 409 },
      { t: "tick", now: 5600 + RECONNECT_RETRY_MS },
      { t: "reply", now: 10_900, status: 200 },
    ]);
    expect(actions).toEqual(["ask", "ask", "ask", "open"]);
    expect(state).toMatchObject({ phase: "done", asks: 3, used: 1 });
  });

  it("404 (nothing to continue) or 401 (no cookie) stops at once: the line-dropped end screen", () => {
    expect(run([{ t: "dropped", now: 0, live: true }, { t: "reply", now: 200, status: 404 }]).actions).toEqual(["ask", "end"]);
    expect(run([{ t: "dropped", now: 0, live: true }, { t: "reply", now: 200, status: 401 }]).actions).toEqual(["ask", "end"]);
  });

  it("gives up after 75 s of 409s (or network failures, or server errors)", () => {
    for (const status of [409, 0, 503]) {
      const events: ReconnectEvent[] = [{ t: "dropped", now: 0, live: true }];
      let now = 0;
      for (let i = 0; i < 30; i++) {
        now += 200;
        events.push({ t: "reply", now, status });
        now += RECONNECT_RETRY_MS;
        events.push({ t: "tick", now });
      }
      const { state, actions } = run(events);
      expect(actions.at(-1), String(status)).toBe("end");
      expect(state.phase).toBe("gave-up");
      const asks = actions.filter((a) => a === "ask").length;
      expect(asks).toBeGreaterThanOrEqual(14); // every 5 s for 75 s
      expect(asks).toBeLessThanOrEqual(16);
    }
    expect(RECONNECT_WINDOW_MS).toBe(75_000);
  });

  it("never after ended, Pause, End or a voice-only switch: the close is not a drop", () => {
    const { state, actions } = run([{ t: "dropped", now: 0, live: false }]);
    expect(actions).toEqual([]);
    expect(state.phase).toBe("idle");
  });

  it("at most three automatic reconnects a page load, then the end screen", () => {
    let s = startReconnect();
    for (let i = 0; i < MAX_RECONNECTS; i++) {
      s = run([{ t: "dropped", now: i * 1000, live: true }, { t: "reply", now: i * 1000 + 100, status: 200 }], s).state;
    }
    expect(s.used).toBe(3);
    expect(run([{ t: "dropped", now: 9000, live: true }], s).actions).toEqual(["end"]);
  });

  it("End pressed, or the page going, stops it; a late reply then does nothing", () => {
    const { state, actions } = run([
      { t: "dropped", now: 0, live: true },
      { t: "stop" },
      { t: "reply", now: 400, status: 200 },
      { t: "tick", now: 99_999 },
    ]);
    expect(actions).toEqual(["ask"]);
    expect(state.phase).toBe("gave-up");
    expect(reconnecting(state)).toBe(false);
  });

  it("replies and ticks out of turn are ignored", () => {
    expect(run([{ t: "reply", now: 0, status: 200 }]).actions).toEqual([]);
    expect(run([{ t: "tick", now: 0 }]).actions).toEqual([]);
    expect(run([{ t: "stop" }]).state.phase).toBe("idle");
  });
});

// ---------- the room while it reconnects ----------

const aida = (body: Record<string, unknown>) => ({ aida: body });
function feed(state: TalkState, ...frames: unknown[]): TalkState {
  return frames.reduce<TalkState>((s, f) => {
    const event = parseFrame(JSON.stringify(f));
    return event ? reduce(s, event) : s;
  }, state);
}
const live = () => feed(initialState(), aida({ type: "ready", targetMinutes: 20, sections: [] }), { serverContent: { outputTranscription: { text: "Tell me about" } } });

describe("the room while the line is down", () => {
  it("stays live, closes her open caption, and says the line dropped", () => {
    const s = reduce(live(), { kind: "line-dropped" });
    expect(s.phase).toBe("live");
    expect(s.link).toBe("dropped");
    expect(s.turns.every((t) => !t.open)).toBe(true);
  });

  it("a drop is not taken after the call ended or while it was ending", () => {
    const ended = feed(live(), aida({ type: "ended", reason: "complete", minutes: 3 }));
    expect(reduce(ended, { kind: "line-dropped" })).toBe(ended);
    const pausing = reduce(live(), { kind: "pause-pressed" });
    expect(reduce(pausing, { kind: "line-dropped" })).toBe(pausing);
  });

  it("if reconnecting gives up, the end screen is the line-dropped one (with Continue)", () => {
    const down = reduce(live(), { kind: "line-dropped" });
    const ended = reduce(down, { kind: "closed", minutes: 2 });
    expect(ended.ended?.reason).toBe("lost");
    expect(endView(ended)).toEqual({ kind: "dropped" });
  });

  it("End pressed while down is the person's own ending", () => {
    const down = reduce(live(), { kind: "line-dropped" });
    const ended = reduce(reduce(down, { kind: "end-pressed" }), { kind: "closed", minutes: 2 });
    expect(ended.ended?.reason).toBe("user");
    expect(endView(ended)).toEqual({ kind: "done" });
  });
});
