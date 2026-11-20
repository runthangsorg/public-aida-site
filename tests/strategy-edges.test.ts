// @vitest-environment happy-dom
/**
 * The edges of the strategy page's pieces that the main tests do not reach: a strategy reply in every malformed shape
 * the reader must refuse, empty lists, the wait copy with no number, replies that arrive on another screen, and the
 * human check's rarer endings (an empty token, a widget that throws, a timeout before the script has loaded).
 */
import { describe, expect, it, vi } from "vitest";
import { renderStrategy } from "../src/strategy/render";
import { readView, reduce, waitCopy, type ScreenState } from "../src/strategy/state";
import { HumanCheck, loadTurnstile, type RenderOptions, type TurnstileApi } from "../src/strategy/turnstile";
import { sampleView } from "./strategy-fixture";

const deckWith = (patch: Record<string, unknown>) => ({ ...sampleView(), deck: { ...sampleView().deck, ...patch } });

/** A view the reader must accept: a fixture problem fails here, not as a null later. */
function mustRead(value: unknown) {
  const view = readView(value);
  if (view === null) throw new Error("the fixture is not a valid view");
  return view;
}

describe("the strategy reader refuses every malformed shape", () => {
  const cases: [string, unknown][] = [
    ["a deck that is not an object", { ...sampleView(), deck: "deck" }],
    ["a SWOT that is not an object", deckWith({ swot: [] })],
    ["a SWOT list with a non-text entry", deckWith({ swot: { ...sampleView().deck.swot, threats: [1] } })],
    ["a roadmap that is not a list", deckWith({ roadmap: {} })],
    ["a roadmap phase without its items", deckWith({ roadmap: [{ when: "Now" }] })],
    ["a play that is not an object", deckWith({ plays: ["play"] })],
    ["a play missing its evidence", deckWith({ plays: [{ ...sampleView().deck.plays[0], evidence: 1 }] })],
  ];
  for (const [what, value] of cases) {
    it(what, () => {
      expect(readView(value)).toBeNull();
    });
  }

  it("a view with no contact reads it as none", () => {
    const rest: Record<string, unknown> = { ...sampleView() };
    delete rest.contact;
    expect(readView(rest)?.contact).toBeNull();
  });
});

describe("rendering empty lists", () => {
  it("says Nothing noted for an empty list and an empty numbered list", () => {
    const view = deckWith({
      heard: { ...sampleView().deck.heard, today: [] },
      roadmap: [{ when: "Now", items: [] }],
    });
    const node = renderStrategy(document, mustRead(view));
    expect([...node.querySelectorAll("p.none")].map((p) => p.textContent)).toEqual(["Nothing noted.", "Nothing noted."]);
  });
});

describe("copy and replies off the sign-in screen", () => {
  it("a wait with no usable number reads as a minute", () => {
    expect(waitCopy(Number.NaN)).toBe("Too many tries. Wait 1 minute and try again.");
  });

  it("a refused send with no body is a bad address, and off the sign-in screen the hint is generic", () => {
    const view: ScreenState = { screen: "view", view: mustRead(sampleView()) };
    expect(reduce(view, { type: "signin", status: 400, body: null })).toMatchObject({ screen: "sign-in", hint: "your email" });
  });

  it("a refused code off the sign-in screen asks to sign in with the generic hint", () => {
    expect(reduce({ screen: "loading" }, { type: "verify", status: 400 })).toMatchObject({ screen: "sign-in", hint: "your email" });
  });
});

describe("the human check's rarer endings", () => {
  function check(api: Partial<TurnstileApi>, opts: { load?: () => Promise<TurnstileApi> } = {}) {
    let fire: (() => void) | null = null;
    const human = new HumanCheck({
      load: opts.load ?? (() => Promise.resolve(api as TurnstileApi)),
      container: {},
      setTimeout: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimeout: vi.fn(),
    });
    return { human, timeout: () => fire?.() };
  }

  it("an empty token from the widget is a failed challenge", async () => {
    let options: RenderOptions | null = null;
    const { human } = check({
      render: (_c, o) => {
        options = o;
        return "w";
      },
      execute: () => options?.callback(""),
      reset: vi.fn(),
    });
    await expect(human.token()).resolves.toEqual({ ok: false, reason: "challenge" });
  });

  it("a widget that throws when asked to run is a failed challenge", async () => {
    const { human } = check({
      render: () => "w",
      execute: () => {
        throw new Error("boom");
      },
      reset: vi.fn(),
    });
    await expect(human.token()).resolves.toEqual({ ok: false, reason: "challenge" });
  });

  it("a timeout before the script has loaded wins, and the late load runs nothing", async () => {
    let release: (api: TurnstileApi) => void = () => undefined;
    const execute = vi.fn();
    const { human, timeout } = check({}, { load: () => new Promise((r) => (release = r)) });
    const result = human.token();
    timeout();
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    release({ render: () => "w", execute, reset: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    expect(execute).not.toHaveBeenCalled();
  });

  it("a second ending after the first changes nothing", async () => {
    let options: RenderOptions | null = null;
    const { human, timeout } = check({
      render: (_c, o) => {
        options = o;
        return "w";
      },
      execute: () => {
        options?.callback("tok");
        options?.["error-callback"]();
      },
      reset: vi.fn(),
    });
    const result = human.token();
    await expect(result).resolves.toEqual({ ok: true, token: "tok" });
    timeout();
  });
});

describe("the script loader when the page fails or loads the script at once", () => {
  it("a script that fails while it is being added is still removed, and the load rejects", async () => {
    const remove = vi.fn();
    const host = {
      find: () => undefined,
      add: (_src: string, _onload: () => void, onerror: () => void) => {
        onerror();
        return remove;
      },
    };
    await expect(loadTurnstile(host)).rejects.toThrow("turnstile script failed");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("a script that runs at once but leaves no global is removed, and the load rejects", async () => {
    const remove = vi.fn();
    const host = {
      find: () => undefined,
      add: (_src: string, onload: () => void) => {
        onload();
        return remove;
      },
    };
    await expect(loadTurnstile(host)).rejects.toThrow("turnstile missing");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
