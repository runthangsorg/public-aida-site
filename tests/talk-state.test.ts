import { describe, expect, it } from "vitest";
import { audioMessage, endMessage, parseFrame, pauseMessage, socketUrl, switchMessage, textMessage } from "../src/talk/protocol";
import {
  formatClock,
  endView,
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
  { id: "timekeeping", label: "Time tracking" },
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
    expect(JSON.parse(pauseMessage())).toEqual({ aida: { type: "pause" } });
    expect(JSON.parse(switchMessage())).toEqual({ aida: { type: "switch" } });
  });

  it("reads the budget frame, and ignores a nonsense one", () => {
    expect(parseFrame(JSON.stringify(aida({ type: "budget", minutes: 5 })))).toEqual({
      kind: "aida",
      frame: { type: "budget", minutes: 5 },
    });
    expect(parseFrame(JSON.stringify(aida({ type: "budget", minutes: "soon" })))).toBeNull();
    expect(parseFrame(JSON.stringify(aida({ type: "budget", minutes: 0 })))).toBeNull();
  });

  it("reads the returning-conversation block of a ready frame, and tolerates a damaged one", () => {
    const frame = parseFrame(
      JSON.stringify(
        aida({
          type: "ready",
          targetMinutes: 5,
          sections: SECTIONS,
          resumed: {
            minutesSoFar: 3.5,
            stage: "tools",
            hasSummary: false,
            notes: [{ section: "org", text: " Two sites ", at: 42 }, { section: "tools", text: "Spreadsheets" }, { text: "  " }, 7],
          },
        }),
      ),
    );
    expect(frame).toMatchObject({
      kind: "aida",
      frame: {
        type: "ready",
        targetMinutes: 5,
        resumed: {
          minutesSoFar: 3.5,
          stage: "tools",
          hasSummary: false,
          notes: [
            { section: "org", text: "Two sites", at: 42 },
            { section: "tools", text: "Spreadsheets" },
          ],
        },
      },
    });
    const plain = parseFrame(JSON.stringify(ready));
    expect(plain?.kind === "aida" && plain.frame.type === "ready" && "resumed" in plain.frame).toBe(false);
    const damaged = parseFrame(JSON.stringify(aida({ type: "ready", targetMinutes: 20, sections: [], resumed: "yes" })));
    expect(damaged?.kind === "aida" && damaged.frame.type === "ready" && damaged.frame.resumed).toBeFalsy();
  });

  it("reads paused, resumable and emailed from an ended frame; absent means no", () => {
    const f = (body: Record<string, unknown>) => parseFrame(JSON.stringify(aida({ type: "ended", minutes: 2, ...body })));
    expect(f({ reason: "paused", resumable: true, emailed: true })).toEqual({
      kind: "aida",
      frame: { type: "ended", reason: "paused", minutes: 2, resumable: true, emailed: true },
    });
    expect(f({ reason: "complete" })).toMatchObject({ frame: { reason: "complete", resumable: false, emailed: false } });
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
    expect(start.stages.map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id).filter((id) => id !== "timekeeping"));
    const s = feed(start, ready);
    expect(s.phase).toBe("live");
    expect(s.link).toBe("live");
    expect(s.stages).toEqual(SECTIONS);
    expect(s.stage).toBe("welcome");
    expect(s.targetMinutes).toBe(20);
  });

  it("takes however many stages the server names: eight here, between needs and the summary", () => {
    const s = feed(initialState(), ready);
    expect(s.stages.map((x) => x.id)).toEqual([
      "welcome",
      "org",
      "tools",
      "workflows",
      "challenges",
      "needs",
      "timekeeping",
      "summary",
    ]);
    // The page's own fallback is only for a server that sends none.
    expect(initialState().stages.length).toBeGreaterThan(0);
    const late = feed(s, aida({ type: "section", id: "timekeeping" }));
    expect(progress(late)).toEqual({ index: 6, total: 8, label: "Time tracking" });
  });

  it("moves the stage bar as sections change", () => {
    let s = feed(initialState(), ready);
    expect(progress(s)).toEqual({ index: 0, total: 8, label: "Hello" });
    s = feed(s, aida({ type: "section", id: "tools" }));
    const p = progress(s);
    expect(p).toEqual({ index: 2, total: 8, label: "Your tools" });
    expect([0, 1, 2, 3].map((i) => stageStatus(i, p))).toEqual(["done", "done", "current", "todo"]);
    s = feed(s, aida({ type: "ended", reason: "complete", minutes: 19.5 }));
    expect(progress(s).index).toBe(8);
    expect(stageStatus(7, progress(s))).toBe("done");
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

  it("follows the budget the server sends, wherever it comes in the call", () => {
    let s = feed(initialState(), ready);
    expect(s.targetMinutes).toBe(20);
    s = feed(s, aida({ type: "budget", minutes: 5 }));
    expect(s.targetMinutes).toBe(5);
    s = feed(s, aida({ type: "budget", minutes: 12 }));
    expect(s.targetMinutes).toBe(12);
    expect(feed(initialState(), aida({ type: "ready", targetMinutes: 5, sections: [] })).targetMinutes).toBe(5);
  });

  it("brings a returning conversation back: notes, place and clock", () => {
    const resumed = {
      minutesSoFar: 7.25,
      stage: "tools",
      hasSummary: false,
      notes: [
        { section: "org", text: "Forty staff on two sites", at: 61 },
        { section: "tools", text: "Spreadsheets for rotas" },
        { section: "mystery", text: "Paper diary" },
      ],
    };
    const s = feed(initialState(), aida({ type: "ready", targetMinutes: 5, sections: SECTIONS, resumed }));
    expect(s.phase).toBe("live");
    expect(s.stage).toBe("tools");
    expect(s.resumed).toEqual({ minutesSoFar: 7.25, hasSummary: false });
    expect(s.notes.map((n) => [n.section, n.text, n.at, n.restored])).toEqual([
      ["org", "Forty staff on two sites", 61, true],
      ["tools", "Spreadsheets for rotas", 0, true],
      ["other", "Paper diary", 0, true],
    ]);
    // New notes carry on after the old ones, and are not "restored".
    const more = feed(s, aida({ type: "note", section: "needs", text: "Faster payroll" }));
    expect(more.notes).toHaveLength(4);
    expect(more.notes[3]?.restored).toBeUndefined();
    expect(new Set(more.notes.map((n) => n.id)).size).toBe(4);
  });

  it("does not double the notebook when the resume reply and the ready frame both carry it", () => {
    const resumed = { minutesSoFar: 2, stage: "org", hasSummary: false, notes: [{ section: "org", text: "Two sites" }] };
    const seeded = initialState(SECTIONS, 5, resumed);
    expect(seeded.notes).toHaveLength(1);
    expect(seeded.stage).toBe("org");
    const after = feed(seeded, aida({ type: "ready", targetMinutes: 5, sections: SECTIONS, resumed }));
    expect(after.notes.map((n) => [n.id, n.text])).toEqual(seeded.notes.map((n) => [n.id, n.text]));
    expect(after.phase).toBe("live");
  });

  it("a fresh conversation has no returning state", () => {
    const s = feed(initialState(), ready);
    expect(s.resumed).toBeNull();
    expect(s.pausing).toBe(false);
  });

  it("ends as paused when the person asks to continue later, and keeps whether a link was emailed", () => {
    const live = feed(initialState(), ready, aida({ type: "note", section: "org", text: "Two sites" }));
    const pausing = reduce(live, { kind: "pause-pressed" });
    expect(pausing.phase).toBe("ending");
    expect(pausing.pausing).toBe(true);
    const done = feed(pausing, aida({ type: "ended", reason: "paused", minutes: 3, resumable: true, emailed: true }));
    expect(done.phase).toBe("ended");
    expect(done.ended).toEqual({ reason: "paused", minutes: 3, resumable: true, emailed: true });
    expect(endView(done)).toEqual({ kind: "paused", emailed: true });
    const notEmailed = feed(pausing, aida({ type: "ended", reason: "paused", minutes: 3, resumable: true, emailed: false }));
    expect(endView(notEmailed)).toEqual({ kind: "paused", emailed: false });
    // Silence from the server: still paused, and we do not claim an email.
    const silent = reduce(pausing, { kind: "closed", minutes: 3 });
    expect(silent.ended?.reason).toBe("paused");
    expect(endView(silent)).toEqual({ kind: "paused", emailed: undefined });
    expect(reduce(done, { kind: "pause-pressed" })).toBe(done);
  });

  it("shows the saved screen when the line ends without the person, and the server kept the call", () => {
    const live = feed(initialState(), ready);
    const left = feed(live, aida({ type: "ended", reason: "user", minutes: 4, resumable: true, emailed: true }));
    expect(left.ended).toEqual({ reason: "user", minutes: 4, resumable: true, emailed: true, abandoned: true });
    expect(endView(left)).toEqual({ kind: "saved", emailed: true });
    const broke = feed(live, aida({ type: "ended", reason: "error", minutes: 4, resumable: true, emailed: false }));
    expect(endView(broke)).toEqual({ kind: "saved", emailed: false });
    // Not resumable: the plain ending.
    expect(endView(feed(live, aida({ type: "ended", reason: "error", minutes: 4 })))).toEqual({ kind: "done" });
    // The person pressed End: that is theirs, however resumable the server calls it.
    const pressed = feed(reduce(live, { kind: "end-pressed" }), aida({ type: "ended", reason: "user", minutes: 6, resumable: true, emailed: true }));
    expect(endView(pressed)).toEqual({ kind: "done" });
    expect(endView(feed(live, aida({ type: "ended", reason: "complete", minutes: 20 })))).toEqual({ kind: "done" });
    expect(endView(reduce(live, { kind: "closed", minutes: 1 }))).toEqual({ kind: "dropped" });
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

describe("where the live call runs", () => {
  it("takes only a secure relay origin, or a local one for a local page, and falls back to this site", async () => {
    const { setRelayOrigin, socketUrl, validRelay } = await import("../src/talk/protocol");
    const page = { protocol: "https:", host: "aida.example.org" };
    expect(validRelay("wss://relay.example.run.app", "aida.example.org")).toBe("wss://relay.example.run.app");
    expect(validRelay("ws://relay.example.run.app", "aida.example.org")).toBeNull();
    expect(validRelay("wss://relay.example/run?x=1", "aida.example.org")).toBeNull();
    expect(validRelay("javascript:alert(1)", "aida.example.org")).toBeNull();
    expect(validRelay("ws://127.0.0.1:8080", "aida.example.org")).toBeNull();
    expect(validRelay("ws://127.0.0.1:8080", "127.0.0.1")).toBe("ws://127.0.0.1:8080");
    setRelayOrigin("wss://relay.example.run.app", "aida.example.org");
    expect(socketUrl("abc", page, "1")).toBe("wss://relay.example.run.app/api/talk?id=abc&avatar=1");
    setRelayOrigin(undefined, "aida.example.org");
    expect(socketUrl("abc", page)).toBe("wss://aida.example.org/api/talk?id=abc");
  });
});
