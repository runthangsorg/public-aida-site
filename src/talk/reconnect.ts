// A dropped line reconnects on its own (owner, 17 Oct: "it suddenly ended the conversation ... its
// unstable"). When the socket closes during a live call with no `ended` frame, the page does not go to
// the end screen: it shows the room's reconnecting state and asks the server to continue the call
// (POST /api/talk/continue, by cookie). The server may still believe the old call is alive for a short
// while (its heartbeat clears a dead call within about 40 s), so `409 busy` is retried every 5 s for up
// to 75 s. `401` / `404` mean there is nothing to continue: the person gets the line-dropped end screen.
//
// Pure: the page feeds it events and does what it says. Never a reconnect after `ended`, Pause, End or a
// voice-only switch (the caller only reports a drop while the call is live), and at most three a page load.

export const RECONNECT_RETRY_MS = 5000;
export const RECONNECT_WINDOW_MS = 75_000;
export const MAX_RECONNECTS = 3;

export type ReconnectPhase = "idle" | "asking" | "waiting" | "done" | "gave-up";

export interface Reconnect {
  phase: ReconnectPhase;
  /** When this drop happened (ms, a monotonic clock). */
  since: number;
  /** When to ask again, in `waiting`. */
  nextAt: number;
  /** Asks made for this drop. */
  asks: number;
  /** Drops that started a reconnect on this page load. */
  used: number;
}

export const startReconnect = (): Reconnect => ({ phase: "idle", since: 0, nextAt: 0, asks: 0, used: 0 });

export type ReconnectEvent =
  /** The socket closed (or errored). `live`: the call was live, with no `ended`, Pause, End or switch before it. */
  | { t: "dropped"; now: number; live: boolean }
  /** The answer to POST /api/talk/continue; status 0 is a network failure. */
  | { t: "reply"; now: number; status: number }
  /** Time passing, while waiting to ask again. */
  | { t: "tick"; now: number }
  /** The person pressed End while it was reconnecting, or the page is going away. */
  | { t: "stop" };

/** What the page should do now. */
export type ReconnectAction =
  | { kind: "none" }
  /** Show the reconnecting state (first ask) and POST /api/talk/continue. */
  | { kind: "ask" }
  /** Open the room again with the continued call. */
  | { kind: "open" }
  /** Stop: show the line-dropped end screen with its continue options. */
  | { kind: "end" };

export interface ReconnectStep {
  state: Reconnect;
  action: ReconnectAction;
}

const none: ReconnectAction = { kind: "none" };

export function stepReconnect(s: Reconnect, e: ReconnectEvent): ReconnectStep {
  switch (e.t) {
    case "dropped": {
      // A close after the call had ended or was being ended is not a drop. A drop while already reconnecting
      // (the new socket closing before ready) counts as a new drop below.
      if (!e.live) return { state: s, action: none };
      if (s.used >= MAX_RECONNECTS) return { state: { ...s, phase: "gave-up" }, action: { kind: "end" } };
      return { state: { phase: "asking", since: e.now, nextAt: 0, asks: 1, used: s.used + 1 }, action: { kind: "ask" } };
    }
    case "reply": {
      if (s.phase !== "asking") return { state: s, action: none };
      if (e.status === 200) return { state: { ...s, phase: "done" }, action: { kind: "open" } };
      // Nothing to continue (no cookie, or no saved call): stop at once.
      if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 410) {
        return { state: { ...s, phase: "gave-up" }, action: { kind: "end" } };
      }
      // 409 (the old call not yet cleared), 429, 5xx, a network failure: ask again in 5 s, within 75 s.
      const nextAt = e.now + RECONNECT_RETRY_MS;
      if (nextAt - s.since > RECONNECT_WINDOW_MS) return { state: { ...s, phase: "gave-up" }, action: { kind: "end" } };
      return { state: { ...s, phase: "waiting", nextAt }, action: none };
    }
    case "tick": {
      if (s.phase !== "waiting" || e.now < s.nextAt) return { state: s, action: none };
      return { state: { ...s, phase: "asking", asks: s.asks + 1 }, action: { kind: "ask" } };
    }
    case "stop":
      if (s.phase === "asking" || s.phase === "waiting") return { state: { ...s, phase: "gave-up" }, action: none };
      return { state: s, action: none };
  }
}

/** Is a reconnect under way (the room shows "Reconnecting")? */
export const reconnecting = (s: Reconnect): boolean => s.phase === "asking" || s.phase === "waiting";

/** Said quietly: until the hosting limit is raised a video call drops every few minutes and comes straight back. */
export const DROPPED_STATUS = "Reconnecting…";
