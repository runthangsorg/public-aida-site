import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStartReply } from "../src/talk/gate";
import {
  CHALLENGE_TIMEOUT_MS,
  GATE_FAILED,
  HumanCheck,
  SCRIPT_SRC,
  SITE_KEY,
  TOKEN_HEADER,
  loadTurnstile,
  withToken,
  type RenderOptions,
  type ScriptHost,
  type TurnstileApi,
} from "../src/talk/turnstile";

/** A fake widget: remembers how it was drawn and lets the test play the vendor's callbacks. */
function fakeWidget() {
  const calls: string[] = [];
  let options: RenderOptions | null = null;
  const api: TurnstileApi = {
    render(_container, o) {
      calls.push("render");
      options = o;
      return "w1";
    },
    execute() {
      calls.push("execute");
    },
    reset(id) {
      calls.push(`reset:${id}`);
    },
  };
  return {
    api,
    calls,
    say: () => {
      if (!options) throw new Error("not rendered");
      return options;
    },
  };
}

/** A manual clock: nothing fires until the test says so. */
function fakeClock() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((t) => t.ms),
    fireAll: () => {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}

function setup(load?: () => Promise<TurnstileApi>) {
  const widget = fakeWidget();
  const clock = fakeClock();
  const loader = vi.fn(load ?? (() => Promise.resolve(widget.api)));
  const check = new HumanCheck({ load: loader, container: {}, ...clock });
  return { widget, clock, loader, check };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the script is not loaded until the details form is shown", () => {
  it("does nothing at all on construction", () => {
    const { loader } = setup();
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads once, when asked to prepare, and draws one widget with the site key", async () => {
    const { check, loader, widget } = setup();
    await check.prepare();
    await check.prepare();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(widget.calls).toEqual(["render"]);
    expect(widget.say()).toMatchObject({ sitekey: SITE_KEY, execution: "execute", appearance: "interaction-only" });
    expect(SITE_KEY).toBe("0x4AAAAAAFZTdtD16pKQUQq6");
  });

  it("the intro page itself carries no reference to the vendor", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../talk/index.html"), "utf8");
    expect(html).not.toMatch(/cloudflare/i);
    expect(html).not.toMatch(/turnstile/i);
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script type="module" src="/src/talk/main.ts">']);
  });

  it("the only caller of prepare on a screen change is the details form", () => {
    const main = readFileSync(resolve(import.meta.dirname, "../src/talk/main.ts"), "utf8");
    expect(main).toContain('if (name === "details") void check.prepare()');
    expect(main.match(/check\.prepare\(/g)).toHaveLength(1);
  });

  it("asks for the explicit-render script, and names the header the server reads", () => {
    expect(SCRIPT_SRC).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(TOKEN_HEADER).toBe("X-Aida-Turnstile");
    expect(CHALLENGE_TIMEOUT_MS).toBe(15_000);
  });
});

describe("getting a token", () => {
  it("success: executes the widget and resolves with the callback's token", async () => {
    const { check, widget, clock } = setup();
    const pending = check.token();
    await settle();
    expect(widget.calls).toEqual(["render", "execute"]);
    expect(clock.pending()).toEqual([15_000]);
    widget.say().callback("tok-1");
    await expect(pending).resolves.toEqual({ ok: true, token: "tok-1" });
    expect(clock.pending()).toEqual([]);
  });

  it("an error callback is a failed challenge", async () => {
    const { check, widget } = setup();
    const pending = check.token();
    await settle();
    widget.say()["error-callback"]("300030");
    await expect(pending).resolves.toEqual({ ok: false, reason: "challenge" });
  });

  it("an expired token or the vendor's own timeout fails the attempt", async () => {
    const a = setup();
    const p1 = a.check.token();
    await settle();
    a.widget.say()["expired-callback"]();
    await expect(p1).resolves.toEqual({ ok: false, reason: "challenge" });
    const b = setup();
    const p2 = b.check.token();
    await settle();
    b.widget.say()["timeout-callback"]();
    await expect(p2).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("times out after 15 seconds, and a late token is ignored", async () => {
    const { check, widget, clock } = setup();
    const pending = check.token();
    await settle();
    clock.fireAll();
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    widget.say().callback("too-late"); // no attempt in flight: nothing happens, nothing throws
  });

  it("a script that fails to load fails the attempt, and the next attempt loads it again", async () => {
    let tries = 0;
    const widget = fakeWidget();
    const { check, loader } = setup(() => (++tries === 1 ? Promise.reject(new Error("blocked")) : Promise.resolve(widget.api)));
    await expect(check.token()).resolves.toEqual({ ok: false, reason: "script" });
    const pending = check.token();
    await settle();
    widget.say().callback("tok-2");
    await expect(pending).resolves.toEqual({ ok: true, token: "tok-2" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("times out when the script never answers", async () => {
    const { check, clock } = setup(() => new Promise<TurnstileApi>(() => undefined));
    const pending = check.token();
    clock.fireAll();
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
  });
});

describe("a token is single-use: the widget is reset after every attempt", () => {
  it("resets after a successful send, handing the token on", async () => {
    const { check, widget } = setup();
    const send = vi.fn(() => Promise.resolve("sent"));
    const run = withToken(check, send);
    await settle();
    widget.say().callback("tok-3");
    await expect(run).resolves.toEqual({ ok: true, value: "sent" });
    expect(send).toHaveBeenCalledWith("tok-3");
    expect(widget.calls).toEqual(["render", "execute", "reset:w1"]);
  });

  it("resets when the send itself blows up", async () => {
    const { check, widget } = setup();
    const run = withToken(check, () => Promise.reject(new Error("offline")));
    await settle();
    widget.say().callback("tok-4");
    await expect(run).rejects.toThrow("offline");
    expect(widget.calls.at(-1)).toBe("reset:w1");
  });

  it("does not send anything when the check fails, and still resets", async () => {
    const { check, widget } = setup();
    const send = vi.fn(() => Promise.resolve("sent"));
    const run = withToken(check, send);
    await settle();
    widget.say()["error-callback"]();
    await expect(run).resolves.toEqual({ ok: false, reason: "challenge" });
    expect(send).not.toHaveBeenCalled();
    expect(widget.calls.at(-1)).toBe("reset:w1");
  });

  it("does not send when the script was blocked", async () => {
    const { check } = setup(() => Promise.reject(new Error("blocked")));
    const send = vi.fn(() => Promise.resolve("sent"));
    await expect(withToken(check, send)).resolves.toEqual({ ok: false, reason: "script" });
    expect(send).not.toHaveBeenCalled();
    check.reset(); // nothing was drawn: a harmless no-op
  });

  it("each attempt executes again after the reset", async () => {
    const { check, widget } = setup();
    for (const tok of ["a", "b"]) {
      const run = withToken(check, () => Promise.resolve(tok));
      await settle();
      widget.say().callback(tok);
      await run;
    }
    expect(widget.calls).toEqual(["render", "execute", "reset:w1", "execute", "reset:w1"]);
  });
});

describe("a refusal from the server is shown the same way", () => {
  it("403 forbidden is the person-check failure, with Try again", () => {
    const r = readStartReply(403, { error: "forbidden" });
    expect(r).toEqual({ kind: "refused", refusal: { message: GATE_FAILED, gate: true } });
    expect(GATE_FAILED).toBe(
      "We could not check that you are a person. Switch off any blocker for this page, or try another browser.",
    );
  });

  it("other refusals are not the check's", () => {
    for (const status of [400, 422, 429, 503]) {
      const r = readStartReply(status, { error: "x" });
      expect(r.kind === "refused" && r.refusal.gate).toBeFalsy();
    }
  });
});

describe("the vendor script loader", () => {
  function host(opts: { present?: TurnstileApi; afterLoad?: TurnstileApi }) {
    const events: string[] = [];
    let present = opts.present;
    let handlers: { onload: () => void; onerror: () => void } | null = null;
    const h: ScriptHost = {
      find: () => present,
      add(src, onload, onerror) {
        events.push(`add:${src}`);
        handlers = { onload, onerror };
        return () => events.push("remove");
      },
    };
    return {
      h,
      events,
      load: () => {
        present = opts.afterLoad;
        handlers?.onload();
      },
      fail: () => handlers?.onerror(),
    };
  }
  const api = fakeWidget().api;

  it("adds nothing when the script has already run", async () => {
    const x = host({ present: api });
    await expect(loadTurnstile(x.h)).resolves.toBe(api);
    expect(x.events).toEqual([]);
  });

  it("adds the script once and resolves with its global", async () => {
    const x = host({ afterLoad: api });
    const p = loadTurnstile(x.h);
    expect(x.events).toEqual([`add:${SCRIPT_SRC}`]);
    x.load();
    await expect(p).resolves.toBe(api);
  });

  it("removes the script and rejects on a load error, so a retry starts clean", async () => {
    const x = host({});
    const p = loadTurnstile(x.h);
    x.fail();
    await expect(p).rejects.toThrow();
    expect(x.events).toEqual([`add:${SCRIPT_SRC}`, "remove"]);
  });

  it("rejects when the script ran but left no global", async () => {
    const x = host({});
    const p = loadTurnstile(x.h);
    x.load();
    await expect(p).rejects.toThrow();
    expect(x.events.at(-1)).toBe("remove");
  });
});
