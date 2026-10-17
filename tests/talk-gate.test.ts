import { describe, expect, it, vi } from "vitest";
import { refusal } from "../src/talk/details";
import {
  BUDGET_LEDE,
  DAILY_LIMIT,
  DECLINED_CLOSING,
  EXPIRED_GO,
  IDLE_CLOSING,
  confirmRefusal,
  entryFor,
  entryRefusal,
  idleSentence,
  knownCopy,
  limitMessage,
  readContinued,
  readLanding,
  readMe,
  readOpened,
  readStartReply,
  resendLabel,
  resendOutcome,
  secondsLeft,
  takeLanding,
} from "../src/talk/gate";
import { hereMessage, parseFrame } from "../src/talk/protocol";
import { endView, initialState, reduce, type TalkState } from "../src/talk/state";

// Address-shaped text is forbidden in tracked files; the server's masked hint is built from parts.
const HINT = ["s***", "acme.example"].join("@");
const GO = "0f".repeat(32);
const RESUME = "a1b2c3d4".repeat(8);
const SECTIONS = [{ id: "welcome", label: "Hello" }];
const loc = (search: string, hash = "") => ({ pathname: "/talk/", search, hash });

const aida = (body: Record<string, unknown>) => ({ aida: body });
function feed(state: TalkState, ...frames: unknown[]): TalkState {
  return frames.reduce<TalkState>((s, f) => {
    const event = parseFrame(JSON.stringify(f));
    return event ? reduce(s, event) : s;
  }, state);
}
const live = () => feed(initialState(), aida({ type: "ready", targetMinutes: 20, sections: SECTIONS }));

describe("the confirmation link in the address bar", () => {
  it("takes the go token and leaves the rest of the address", () => {
    expect(readLanding(loc(`?go=${GO}&utm=x`, "#top"))).toEqual({
      go: GO,
      resume: null,
      present: true,
      clean: "/talk/?utm=x#top",
    });
  });

  it("removes both tokens from the address bar at once, replacing the history entry", () => {
    const replaceState = vi.fn();
    const l = takeLanding(loc(`?go=${GO}&resume=${RESUME}`), { replaceState });
    expect(l.go).toBe(GO);
    expect(l.resume).toBe(RESUME);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/talk/");
    const none = vi.fn();
    expect(takeLanding(loc(""), { replaceState: none }).present).toBe(false);
    expect(none).not.toHaveBeenCalled();
  });

  it("accepts upper-case hex and nothing that is not 64 hex characters", () => {
    expect(readLanding(loc(`?go=${GO.toUpperCase()}`)).go).toBe(GO);
    for (const bad of ["", "abc", GO.slice(1), `${GO}0`, "z".repeat(64)]) {
      const l = readLanding(loc(`?go=${encodeURIComponent(bad)}`));
      expect(l.go, bad).toBeNull();
      expect(l.present).toBe(true);
      expect(l.clean).toBe("/talk/");
    }
  });
});

describe("what the first screen does on load: go, resume, known, unknown", () => {
  const entry = (search: string) => entryFor(readLanding(loc(search)));

  it("a confirmation link shows the one-click card", () => {
    expect(entry(`?go=${GO}`)).toEqual({ kind: "go", token: GO });
  });

  it("a continue link shows the welcome-back card", () => {
    expect(entry(`?resume=${RESUME}`)).toEqual({ kind: "resume", token: RESUME });
  });

  it("go wins over resume, and either wins over the cookie", () => {
    expect(entry(`?resume=${RESUME}&go=${GO}`)).toEqual({ kind: "go", token: GO });
    // With a link in the address, the cookie is never asked about: the kind is never "me".
    expect(entry(`?go=${GO}`).kind).not.toBe("me");
    expect(entry(`?resume=${RESUME}`).kind).not.toBe("me");
  });

  it("a malformed link is an expired link, not a stranger or a returning visitor", () => {
    expect(entry("?go=nonsense")).toEqual({ kind: "bad-link" });
    expect(entry("?resume=nonsense")).toEqual({ kind: "bad-link" });
    // A good resume token beside a broken go token still gets in.
    expect(entry(`?go=nonsense&resume=${RESUME}`)).toEqual({ kind: "resume", token: RESUME });
  });

  it("no link at all asks the server who this is", () => {
    expect(entry("")).toEqual({ kind: "me" });
    expect(entry("?utm=x")).toEqual({ kind: "me" });
  });
});

describe("the start reply", () => {
  it("pending: a link was emailed, with the masked address and the countdown", () => {
    expect(readStartReply(200, { pending: true, hint: HINT, resendInSeconds: 120 })).toEqual({
      kind: "pending",
      hint: HINT,
      resendInSeconds: 120,
    });
  });

  it("pending with no usable countdown falls back to two minutes, and a long hint is cut", () => {
    const r = readStartReply(200, { pending: true, hint: "x".repeat(500), resendInSeconds: "soon" });
    expect(r.kind === "pending" && r.resendInSeconds).toBe(120);
    expect(r.kind === "pending" && r.hint.length).toBe(160);
    expect(readStartReply(200, { pending: true }).kind).toBe("pending");
  });

  it("a session: this browser already holds one for the same address", () => {
    const r = readStartReply(200, { id: "abc", targetMinutes: 5, sections: SECTIONS });
    expect(r).toEqual({ kind: "session", opened: { id: "abc", targetMinutes: 5, sections: SECTIONS, name: "" } });
  });

  it("every refusal in words a person can act on", () => {
    const msg = (status: number, body: unknown) => {
      const r = readStartReply(status, body);
      return r.kind === "refused" ? r.refusal : null;
    };
    expect(msg(400, { error: "invalid", field: "email" })).toEqual({
      message: "We need a work email to send the team’s follow-up.",
      field: "email",
    });
    expect(msg(400, { error: "invalid" })?.message).toBe("Something in the form needs another look.");
    expect(msg(403, { error: "forbidden" })?.message).toMatch(/refused/);
    expect(msg(422, { error: "email_not_accepted" })).toEqual({ message: "Please use your work email.", field: "email" });
    expect(msg(429, { error: "too_many" })?.message).toBe("Too many tries; please wait a few minutes.");
    for (const error of ["email_failed", "busy", "unavailable"]) {
      expect(msg(503, { error })?.message).toBe("We couldn’t send the email just now. Please try again in a moment.");
    }
    expect(msg(200, { nothing: true })?.message).toMatch(/went wrong/);
    // The form's own refusal helper agrees with the gate's wording.
    expect(refusal(422, { error: "email_not_accepted" }).field).toBe("email");
  });
});

describe("the resend countdown", () => {
  it("counts whole seconds down to zero from a clock reading, so a sleeping tab catches up", () => {
    const ends = 1000 + 120_000;
    expect(secondsLeft(ends, 1000)).toBe(120);
    expect(secondsLeft(ends, 1000 + 119_001)).toBe(1);
    expect(secondsLeft(ends, 1000 + 120_000)).toBe(0);
    expect(secondsLeft(ends, 1000 + 999_999)).toBe(0);
  });

  it("labels the button with m:ss while it counts, and plainly once it is ready", () => {
    expect(resendLabel(120)).toBe("Send it again (2:00)");
    expect(resendLabel(61)).toBe("Send it again (1:01)");
    expect(resendLabel(9)).toBe("Send it again (0:09)");
    expect(resendLabel(0)).toBe("Send it again");
  });

  it("restarts on a 200 and never claims more than 'if we have your details'", () => {
    expect(resendOutcome(200, { ok: true, resendInSeconds: 90 })).toEqual({
      message: "Sent again if we have your details.",
      ok: true,
      resendInSeconds: 90,
    });
    expect(resendOutcome(200, {}).resendInSeconds).toBe(120);
    expect(resendOutcome(429, null)).toEqual({ message: "Please wait a few minutes.", ok: false });
    expect(resendOutcome(0, null).ok).toBe(false);
    expect(resendOutcome(500, null).message).toMatch(/couldn’t send/);
  });
});

describe("confirming the link", () => {
  const opened = { id: "s1", targetMinutes: 5, sections: SECTIONS, name: "Sam Example" };

  it("opens the room from a well-formed reply, first name only", () => {
    expect(readOpened(opened)).toEqual({ id: "s1", targetMinutes: 5, sections: SECTIONS, name: "Sam" });
    expect(readOpened({ ...opened, id: "" })).toBeNull();
    expect(readOpened(null)).toBeNull();
  });

  it("an unknown, expired or used link is dropped and a new one offered", () => {
    for (const [status, error] of [[404, "unknown"], [410, "expired"], [410, "used"]] as const) {
      expect(confirmRefusal(status, { error })).toEqual({ message: EXPIRED_GO, outcome: "expired" });
    }
    expect(EXPIRED_GO).toBe("That link has expired or was already used. Enter your email to get a new one.");
  });

  it("busy and rate limits keep the card and the token so the same button can try again", () => {
    expect(confirmRefusal(409, { error: "busy" })).toEqual({
      message: "You already have a conversation open in another window.",
      outcome: "retry",
    });
    expect(confirmRefusal(429, { error: "too_many" })).toEqual({ message: "Please wait a few minutes.", outcome: "retry" });
    expect(confirmRefusal(503, null).outcome).toBe("retry");
    expect(confirmRefusal(500, null).outcome).toBe("retry");
  });

  it("the daily limit lets the token go and says come back tomorrow", () => {
    expect(confirmRefusal(429, { error: "daily_limit" })).toEqual({ message: DAILY_LIMIT, outcome: "stop" });
    expect(DAILY_LIMIT).toBe("You have reached today’s limit. Please come back tomorrow.");
  });
});

describe("a returning visitor", () => {
  it("reads a stranger and anything malformed as unknown", () => {
    expect(readMe({ known: false })).toBeNull();
    expect(readMe(null)).toBeNull();
    expect(readMe("yes")).toBeNull();
    expect(readMe({ name: "Sam" })).toBeNull();
  });

  it("reads who they are, what they can do, and why not", () => {
    expect(readMe({ known: true, name: "Sam Example", canContinue: true, minutesSoFar: 3.4, canStartNew: true })).toEqual({
      known: true,
      name: "Sam",
      canContinue: true,
      minutesSoFar: 3.4,
      canStartNew: true,
    });
    const limited = readMe({ known: true, name: "Sam", canContinue: false, canStartNew: false, reasonIfNot: "daily_limit" });
    expect(limited).toMatchObject({ canContinue: false, canStartNew: false, reasonIfNot: "daily_limit" });
    expect(readMe({ known: true, name: "Sam", reasonIfNot: "nonsense" })?.reasonIfNot).toBeUndefined();
    expect(readMe({ known: true, name: "Sam" })).toMatchObject({ canContinue: false, canStartNew: false });
  });

  it("words the card, and the limit reasons", () => {
    const me = readMe({ known: true, name: "Sam", canContinue: true, minutesSoFar: 3.4, canStartNew: true });
    if (!me) throw new Error("expected a known visitor");
    const copy = knownCopy(me);
    expect(copy.title).toBe("Welcome back, Sam");
    expect(copy.detail).toMatch(/3 min so far/);
    expect(copy.notYou).toBe("Not Sam? Use a different email");
    expect(copy.limit).toBe("");
    expect(knownCopy({ ...me, canStartNew: false, reasonIfNot: "daily_limit" }).limit).toBe(DAILY_LIMIT);
    expect(knownCopy({ ...me, canStartNew: false, reasonIfNot: "busy" }).limit).toBe(
      "A conversation is already open in another window.",
    );
    expect(limitMessage("busy")).toMatch(/another window/);
  });

  it("continue must carry what was kept; new need not", () => {
    const body = { id: "s1", targetMinutes: 5, sections: SECTIONS, name: "Sam" };
    const resumed = { minutesSoFar: 2, stage: "org", hasSummary: false, notes: [{ section: "org", text: "Two sites" }] };
    expect(readContinued(body)).toBeNull();
    expect(readContinued({ ...body, resumed })?.resumed?.notes).toEqual([{ section: "org", text: "Two sites" }]);
    expect(readOpened(body)?.resumed).toBeUndefined();
  });

  it("answers the refusals: no session falls back, nothing to continue hides the button, limits are said", () => {
    expect(entryRefusal(401, { error: "no_session" }).outcome).toBe("login");
    expect(entryRefusal(401, { error: "no_session" }).message).toBe("Use the link we emailed you.");
    expect(entryRefusal(404, { error: "nothing_to_continue" }).outcome).toBe("nothing");
    expect(entryRefusal(429, { error: "daily_limit" })).toEqual({ message: DAILY_LIMIT, outcome: "stop" });
    expect(entryRefusal(409, { error: "busy" }).outcome).toBe("stop");
    expect(entryRefusal(429, { error: "too_many" }).outcome).toBe("retry");
    expect(entryRefusal(500, null).outcome).toBe("retry");
  });
});

describe("the idle warning", () => {
  it("reads idle_warning, and the here message the page sends back", () => {
    expect(parseFrame(JSON.stringify(aida({ type: "idle_warning", secondsLeft: 30 })))).toEqual({
      kind: "aida",
      frame: { type: "idle_warning", secondsLeft: 30 },
    });
    expect(parseFrame(JSON.stringify(aida({ type: "idle_warning", secondsLeft: 0 })))).toBeNull();
    expect(parseFrame(JSON.stringify(aida({ type: "idle_warning", secondsLeft: "soon" })))).toBeNull();
    expect(JSON.parse(hereMessage())).toEqual({ aida: { type: "here" } });
  });

  it("shows the banner from the warning, and the sentence counts plainly", () => {
    const s = feed(live(), aida({ type: "idle_warning", secondsLeft: 30 }));
    expect(s.idleWarning).toEqual({ secondsLeft: 30 });
    expect(idleSentence(30)).toBe("Still there? We will pause in 30 seconds and save your place.");
    expect(idleSentence(1)).toBe("Still there? We will pause in 1 second and save your place.");
  });

  it("clears on the button, on speaking, on typing, and when the call ends", () => {
    const warned = feed(live(), aida({ type: "idle_warning", secondsLeft: 20 }));
    expect(reduce(warned, { kind: "here-pressed" }).idleWarning).toBeNull();
    expect(feed(warned, { serverContent: { inputTranscription: { text: "hello" } } }).idleWarning).toBeNull();
    expect(reduce(warned, { kind: "typed", text: "still here" }).idleWarning).toBeNull();
    expect(feed(warned, aida({ type: "ended", reason: "idle", minutes: 4, resumable: true, emailed: false })).idleWarning).toBeNull();
    // Her own voice does not count as the person being there.
    const hers = feed(warned, { serverContent: { outputTranscription: { text: "Hello?" } } });
    expect(hers.idleWarning).toEqual({ secondsLeft: 20 });
    // Nothing to clear: the same state back.
    const quiet = live();
    expect(reduce(quiet, { kind: "here-pressed" })).toBe(quiet);
  });

  it("ignores a warning that arrives after the call is over", () => {
    const done = feed(live(), aida({ type: "ended", reason: "complete", minutes: 5 }));
    expect(feed(done, aida({ type: "idle_warning", secondsLeft: 10 })).idleWarning).toBeNull();
  });
});

describe("the new ways a call ends", () => {
  const ended = (reason: string, extra: Record<string, unknown> = {}) =>
    feed(live(), aida({ type: "ended", reason, minutes: 4, ...extra }));

  it("reads idle, declined and budget as reasons of their own", () => {
    for (const reason of ["idle", "declined", "budget"]) {
      expect(parseFrame(JSON.stringify(aida({ type: "ended", reason, minutes: 1 })))).toMatchObject({
        frame: { reason },
      });
    }
  });

  it("idle: paused, saved, with the Continue button", () => {
    const s = ended("idle", { resumable: true });
    expect(s.ended).toMatchObject({ reason: "idle", resumable: true });
    expect(endView(s)).toEqual({ kind: "idle" });
    expect(IDLE_CLOSING).toEqual({ title: "Paused", lede: "It went quiet. Your place is saved." });
  });

  it("declined: only for the interview, no continue", () => {
    expect(endView(ended("declined"))).toEqual({ kind: "declined" });
    expect(DECLINED_CLOSING.lede).toBe("This conversation is only for the interview, so we have stopped here. Thank you.");
  });

  it("budget: the limit for one conversation", () => {
    expect(endView(ended("budget"))).toEqual({ kind: "budget" });
    expect(BUDGET_LEDE).toBe("We have reached the limit for one conversation. Thank you: the team has what you said.");
  });

  it("an idle end the server did not mark resumable is still the idle screen", () => {
    expect(endView(ended("idle"))).toEqual({ kind: "idle" });
  });
});
