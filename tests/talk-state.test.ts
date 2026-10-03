import { describe, expect, it } from "vitest";
import { audioMessage, endMessage, parseFrame, socketUrl, textMessage } from "../src/talk/protocol";
import {
  formatClock,
  groupNotes,
  initialState,
  joinFragment,
  latestTurns,
  progress,
  reduce,
  stageStatus,
  turnText,
  type TalkState,
} from "../src/talk/state";

const SECTIONS = [
  { id: "welcome", label: "Hello" },
  { id: "org", label: "Your organisation" },
  { id: "tools", label: "Your tools" },
  { id: "workflows", label: "How work flows" },
  { id: "challenges", label: "Challenges" },
  { id: "needs", label: "Needs and wants" },
  { id: "summary", label: "Read-back" },
];

/** Feed raw socket frames through the parser and the reducer, as the page does. */
function feed(state: TalkState, ...frames: unknown[]): TalkState {
  return frames.reduce<TalkState>((s, f) => {
    const event = parseFrame(JSON.stringify(f));
    return event ? reduce(s, event) : s;
  }, state);
}

const aida = (body: Record<string, unknown>) => ({ aida: body });
const said = (text: string) => ({ serverContent: { outputTranscription: { text } } });
const heard = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const ready = aida({ type: "ready", targetMinutes: 20, sections: SECTIONS });

describe("reading frames", () => {
  it("ignores anything that is not a frame it knows", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify([1, 2]))).toBeNull();
    expect(parseFrame(JSON.stringify({ aida: { type: "mystery" } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ setupComplete: {} }))).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });

  it("collects her audio and both transcriptions from one model frame", () => {
    const frame = parseFrame(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }, { text: "ignored" }] },
          inputTranscription: { text: "hi" },
          outputTranscription: { text: " hello" },
          turnComplete: true,
        },
      }),
    );
    expect(frame).toEqual({
      kind: "model",
      content: {
        audio: [{ data: "AAAA", mimeType: "audio/pcm;rate=24000" }],
        input: "hi",
        output: " hello",
        interrupted: false,
        turnComplete: true,
      },
    });
  });

  it("writes the three messages the browser sends", () => {
    expect(JSON.parse(audioMessage("QUJD"))).toEqual({
      realtimeInput: { audio: { data: "QUJD", mimeType: "audio/pcm;rate=16000" } },
    });
    expect(JSON.parse(textMessage("We use spreadsheets"))).toEqual({
      clientContent: { turns: [{ role: "user", parts: [{ text: "We use spreadsheets" }] }], turnComplete: true },
    });
    expect(JSON.parse(endMessage())).toEqual({ aida: { type: "end" } });
  });

  it("opens the socket on this same site, secure when the page is", () => {
    expect(socketUrl("a b", { protocol: "https:", host: "example.test" })).toBe("wss://example.test/api/talk?id=a%20b");
    expect(socketUrl("x", { protocol: "http:", host: "localhost:8790" })).toBe("ws://localhost:8790/api/talk?id=x");
  });
});

describe("the room's state", () => {
  it("waits for ready, then takes the stages and the time from it", () => {
    const start = initialState();
    expect(start.phase).toBe("connecting");
    expect(start.stages.map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id));
    const s = feed(start, ready);
    expect(s.phase).toBe("live");
    expect(s.link).toBe("live");
    expect(s.stages).toEqual(SECTIONS);
    expect(s.stage).toBe("welcome");
    expect(s.targetMinutes).toBe(20);
  });

  it("moves the stage bar as sections change", () => {
    let s = feed(initialState(), ready);
    expect(progress(s)).toEqual({ index: 0, total: 7, label: "Hello" });
    s = feed(s, aida({ type: "section", id: "tools" }));
    const p = progress(s);
    expect(p).toEqual({ index: 2, total: 7, label: "Your tools" });
    expect([0, 1, 2, 3].map((i) => stageStatus(i, p))).toEqual(["done", "done", "current", "todo"]);
    s = feed(s, aida({ type: "ended", reason: "complete", minutes: 19.5 }));
    expect(progress(s).index).toBe(7);
    expect(stageStatus(6, progress(s))).toBe("done");
  });

  it("groups notes by section in the notebook's order, unknown sections last", () => {
    const s = feed(
      initialState(),
      ready,
      aida({ type: "note", section: "tools", text: "Spreadsheets for rotas" }),
      aida({ type: "note", section: "org", text: "Forty staff on two sites" }),
      aida({ type: "note", section: "threats", text: "A competitor undercutting on price" }),
      aida({ type: "note", section: "tools", text: "A time-tracking app on phones" }),
      aida({ type: "note", section: "somewhere", text: "Keeps a paper diary too" }),
      aida({ type: "note", section: "org", text: "   " }),
    );
    const groups = groupNotes(s.notes);
    expect(groups.map((g) => g.section)).toEqual(["org", "tools", "threats", "other"]);
    expect(groups[1]?.label).toBe("The tools you use");
    expect(groups[1]?.notes.map((n) => n.text)).toEqual(["Spreadsheets for rotas", "A time-tracking app on phones"]);
    expect(groups[3]?.label).toBe("Other notes");
    expect(s.notes).toHaveLength(5);
  });

  it("grows one caption per turn from fragments that carry their own spacing", () => {
    // Once one fragment has shown its own space, a word split across
    // fragments (" dis", "patch") is joined without one.
    const s = feed(initialState(), ready, said("Hello"), said(" there,"), said(" who"), said(" does"), said(" dis"), said("patch?"));
    expect(s.turns).toHaveLength(1);
    expect(turnText(s.turns[0] ?? ({} as never))).toBe("Hello there, who does dispatch?");
  });

  it("spaces bare words, but not the punctuation after them", () => {
    expect(["morning", "dispatch", ",", "then", "payroll", "."].reduce((t, c) => joinFragment(t, c, false), "")).toBe(
      "morning dispatch, then payroll.",
    );
    const s = feed(initialState(), ready, heard("We"), heard("run"), heard("rotas"));
    expect(s.turns[0]?.text).toBe("We run rotas");
  });

  it("starts a new turn when the speaker changes, and closes the old one", () => {
    let s = feed(initialState(), ready, said("What does a week look like?"));
    s = feed(s, { serverContent: { turnComplete: true } });
    expect(s.finished.map((t) => t.who)).toEqual(["aida"]);
    s = feed(s, heard(" Busy"), heard(" mornings"));
    s = feed(s, said(" I see."));
    expect(s.finished.map((t) => [t.who, turnText(t)])).toEqual([["you", "Busy mornings"]]);
    const latest = latestTurns(s);
    expect(latest.last).toBe("aida");
    expect(latest.aida?.text).toBe("I see.");
    expect(latest.you?.text).toBe("Busy mornings");
    expect(s.turns.map((t) => t.open)).toEqual([false, false, true]);
  });

  it("closes her turn as interrupted when the person talks over her", () => {
    let s = feed(initialState(), ready, said(" So tell me about"));
    s = feed(s, { serverContent: { interrupted: true, inputTranscription: { text: " Sorry," } } });
    expect(s.turns[0]).toMatchObject({ who: "aida", open: false, interrupted: true });
    expect(s.turns[1]).toMatchObject({ who: "you", open: true, text: "Sorry," });
  });

  it("closes the person's turn when her voice starts, before her words arrive", () => {
    let s = feed(initialState(), ready, heard(" We use paper"));
    s = feed(s, { serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] } } });
    expect(s.turns[0]?.open).toBe(false);
    expect(s.turns).toHaveLength(1);
  });

  it("puts a typed answer in as the person's own closed turn", () => {
    let s = feed(initialState(), ready, said(" Which tools?"));
    s = reduce(s, { kind: "typed", text: "  A time-tracking app  " });
    expect(s.turns.map((t) => [t.who, t.text, t.open, t.typed ?? false])).toEqual([
      ["aida", "Which tools?", false, false],
      ["you", "A time-tracking app", false, true],
    ]);
    expect(reduce(s, { kind: "typed", text: "   " })).toBe(s);
  });

  it("shows reconnecting and resumed without leaving the room", () => {
    let s = feed(initialState(), ready, aida({ type: "reconnecting" }));
    expect(s.link).toBe("reconnecting");
    expect(s.phase).toBe("live");
    s = feed(s, aida({ type: "resumed" }));
    expect(s.link).toBe("resumed");
  });

  it("keeps the summary, then ends", () => {
    let s = feed(initialState(), ready, said(" Thanks"));
    s = feed(
      s,
      aida({
        type: "summary",
        strengths: ["Loyal team", 7],
        weaknesses: [],
        opportunities: ["Automate approvals"],
        threats: ["Rising costs"],
        crux: "Approvals wait on one person.",
        needs: ["Faster payroll"],
        wants: ["A dashboard"],
        approach: { bespokeOrCommodity: "Ready-made first", kind: "Done with us" },
      }),
    );
    expect(s.summary?.strengths).toEqual(["Loyal team"]);
    expect(s.summary?.approach.kind).toBe("Done with us");
    expect(s.phase).toBe("live");
    s = feed(s, aida({ type: "ended", reason: "complete", minutes: 21 }));
    expect(s.phase).toBe("ended");
    expect(s.ended).toEqual({ reason: "complete", minutes: 21 });
    expect(s.turns.every((t) => !t.open)).toBe(true);
    expect(feed(s, said(" late words"))).toBe(s);
  });

  it("ends with what it has when the line drops, and as the person's choice after End", () => {
    const live = feed(initialState(), ready, aida({ type: "note", section: "org", text: "Two sites" }));
    const dropped = reduce(live, { kind: "closed", minutes: 4 });
    expect(dropped.phase).toBe("ended");
    expect(dropped.ended).toEqual({ reason: "lost", minutes: 4 });
    expect(dropped.link).toBe("lost");
    expect(dropped.notes).toHaveLength(1);

    const ending = reduce(live, { kind: "end-pressed" });
    expect(ending.phase).toBe("ending");
    expect(reduce(ending, { kind: "closed", minutes: 5 }).ended?.reason).toBe("user");

    const done = feed(live, aida({ type: "ended", reason: "user", minutes: 6 }));
    const closedAfter = reduce(done, { kind: "closed", minutes: 6 });
    expect(closedAfter.ended?.reason).toBe("user");
    expect(closedAfter.link).toBe("closed");
  });

  it("keeps a server error to show, without ending", () => {
    const s = feed(initialState(), ready, aida({ type: "error", message: "Upstream hiccup" }));
    expect(s.error).toBe("Upstream hiccup");
    expect(s.phase).toBe("live");
  });

  it("formats the elapsed clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(372.9)).toBe("6:12");
    expect(formatClock(1200)).toBe("20:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});
