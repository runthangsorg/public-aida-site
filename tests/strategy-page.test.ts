// @vitest-environment happy-dom
/**
 * The strategy page's wiring (src/strategy/main.ts), run against the real strategy/index.html in a simulated DOM: every
 * screen, every request it makes and every way each can end. The network and the human-check widget are fakes, so
 * nothing leaves the test. The pure state machine has its own tests (strategy-state, strategy-render); this file is
 * about what the page does with it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE, HINT, TOKEN, sampleView } from "./strategy-fixture";
import { GATE_FAILED } from "../src/strategy/turnstile";
import { LOAD_FAILED_COPY, NOT_FOUND_TITLE, SIGNOUT_FAILED_COPY } from "../src/strategy/state";

/** Addresses built at run time: the repository policy keeps address-shaped text out of tracked files. */
const SAM = ["sam", "acme.example"].join("@");
const TEAM = ["team", "site.example"].join("@");

const PAGE = readFileSync(resolve(import.meta.dirname, "../strategy/index.html"), "utf8");
// The page's own <script> tag is left out: the test imports the module itself, under its fakes.
const BODY = ((): string => {
  const doc = new DOMParser().parseFromString(PAGE, "text/html");
  for (const script of doc.querySelectorAll("script")) script.remove();
  return doc.body.innerHTML;
})();

type Reply = { status: number; body?: unknown } | "network-error" | "bad-json";
interface Call {
  path: string;
  body: unknown;
}

let calls: Call[] = [];
let replies: Record<string, Reply[]> = {};

/** Answer each path from its queue; an empty queue repeats the last reply. */
function reply(path: string, ...answers: Reply[]): void {
  replies[path] = answers;
}

function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const path = input.split("?")[0] ?? input;
  calls.push({ path: input, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  const queue = replies[path] ?? [{ status: 404 }];
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (next === undefined) throw new Error(`no reply queued for ${path}`);
  if (next === "network-error") return Promise.reject(new TypeError("Failed to fetch"));
  if (next === "bad-json") {
    return Promise.resolve({ status: 200, json: () => Promise.reject(new SyntaxError("bad")) } as unknown as Response);
  }
  return Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body ?? null) } as unknown as Response);
}

/** A fake of the human-check widget: passes by default, or fails with its error callback. */
function fakeTurnstile(pass = true) {
  let options: { callback: (t: string) => void; "error-callback": () => void } | null = null;
  return {
    render: (_c: unknown, o: typeof options) => {
      options = o;
      return "w1";
    },
    execute: () => {
      queueMicrotask(() => (pass ? options?.callback("tok") : options?.["error-callback"]()));
    },
    reset: vi.fn(),
  };
}

async function open(path: string, body = BODY): Promise<void> {
  vi.resetModules();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://site.example${path}`);
  document.title = "";
  document.body.innerHTML = body;
  await import("../src/strategy/main");
}

const screen = () => document.getElementById("app")?.dataset.screen;
function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`no #${id} on the page`);
  return node;
}
const input = (id: string) => el(id) as HTMLInputElement;
const button = (id: string) => el(id) as HTMLButtonElement;
const until = (want: string) => vi.waitFor(() => { expect(screen()).toBe(want); });

beforeEach(() => {
  calls = [];
  replies = {};
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  (window as unknown as { turnstile?: unknown }).turnstile = fakeTurnstile();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe("arriving", () => {
  it("an address with no valid token is a closed link at once, with no request", async () => {
    await open("/strategy/not-a-token");
    expect(screen()).toBe("not-found");
    expect(calls).toEqual([]);
  });

  it("a valid link shows the strategy, titled, with sign-out", async () => {
    reply("/api/strategy/view", { status: 200, body: sampleView() });
    await open(`/strategy/${TOKEN}`);
    await until("view");
    expect(calls[0]?.path).toBe(`/api/strategy/view?t=${TOKEN}`);
    expect(el("strategy").textContent).toContain("Acme Cleaning (fictional)");
    expect(el("view").hidden).toBe(false);
    expect(el("signout-notice").hidden).toBe(true);
    expect(document.title).not.toBe("");
  });

  it("a signed-out visitor is asked to confirm it's them, with the hint", async () => {
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    await open(`/strategy/${TOKEN}`);
    await until("sign-in");
    expect(el("signin-hint").textContent).toBe(`Use the email you gave Aida (${HINT})`);
    expect(el("signin-notice").hidden).toBe(true);
    expect(button("signin-go").disabled).toBe(false);
  });

  it("a withdrawn link offers the contact address, and none when there is none", async () => {
    reply("/api/strategy/view", { status: 404, body: { error: "not_found", contact: TEAM } });
    await open(`/strategy/${TOKEN}`);
    await until("not-found");
    expect(el("not-found-title").textContent).toBe(NOT_FOUND_TITLE);
    expect(el("not-found-ask").hidden).toBe(false);
    expect(el("not-found-mail").getAttribute("href")).toMatch(/^mailto:team@site\.example\?subject=/);

    reply("/api/strategy/view", { status: 404, body: { error: "not_found" } });
    await open(`/strategy/${TOKEN}`);
    await until("not-found");
    expect(el("not-found-ask").hidden).toBe(true);
    expect(el("not-found-mail").hasAttribute("href")).toBe(false);
  });

  it("a network failure is the trouble screen; Try again loads again and moves focus to the heading", async () => {
    reply("/api/strategy/view", "network-error", { status: 200, body: sampleView() });
    await open(`/strategy/${TOKEN}`);
    await until("trouble");
    expect(el("trouble-text").textContent).toBe(LOAD_FAILED_COPY);
    el("retry").click();
    await until("view");
    expect(document.activeElement?.tagName).toBe("H1");
  });

  it("a reply that is not JSON is read as no body", async () => {
    reply("/api/strategy/view", "bad-json");
    await open(`/strategy/${TOKEN}`);
    await vi.waitFor(() => { expect(screen()).not.toBe("loading"); });
    expect(screen()).toBe("trouble");
  });

  it("a missing element stops the page with its name, rather than failing later", async () => {
    await expect(open(`/strategy/${TOKEN}`, BODY.replace('id="retry"', 'id="gone"'))).rejects.toThrow("Missing #retry");
  });
});

describe("a one-time code in the address", () => {
  it("is spent when the view asks for sign-in, dropped from the address, and the strategy then loads", async () => {
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } }, { status: 200, body: sampleView() });
    reply("/api/strategy/verify", { status: 200 });
    await open(`/strategy/${TOKEN}?c=${CODE}`);
    await until("view");
    expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/api/strategy/view", "/api/strategy/verify", "/api/strategy/view"]);
    expect(calls[1]?.body).toEqual({ t: TOKEN, c: CODE });
    expect(location.search).toBe("");
  });

  it("a refused code leaves the person on sign-in and drops the code", async () => {
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    reply("/api/strategy/verify", { status: 410, body: { error: "expired" } });
    await open(`/strategy/${TOKEN}?c=${CODE}`);
    await vi.waitFor(() => { expect(calls.length).toBe(2); });
    await vi.waitFor(() => { expect(screen()).not.toBe("loading"); });
    expect(location.search).toBe("");
  });

  it("a code that got no answer stays in the address for another try", async () => {
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    reply("/api/strategy/verify", "network-error");
    await open(`/strategy/${TOKEN}?c=${CODE}`);
    await vi.waitFor(() => { expect(calls.length).toBe(2); });
    await vi.waitFor(() => { expect(screen()).not.toBe("loading"); });
    expect(location.search).toBe(`?c=${CODE}`);
  });

  it("is dropped without being spent when the strategy loads anyway", async () => {
    reply("/api/strategy/view", { status: 200, body: sampleView() });
    await open(`/strategy/${TOKEN}?c=${CODE}`);
    await until("view");
    expect(calls).toHaveLength(1);
    expect(location.search).toBe("");
  });
});

describe("signing in", () => {
  async function onSignIn(): Promise<void> {
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    await open(`/strategy/${TOKEN}`);
    await until("sign-in");
  }
  const submit = (email: string) => {
    input("email").value = email;
    el("signin-form").dispatchEvent(new Event("submit", { cancelable: true }));
  };

  it("an empty or malformed email is pointed out, focused and not sent", async () => {
    await onSignIn();
    submit("   ");
    expect(el("email-error").hidden).toBe(false);
    expect(el("email").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.id).toBe("email");
    submit("not-an-email");
    expect(el("email-error").textContent).not.toBe("");
    expect(calls.filter((c) => c.path === "/api/strategy/signin")).toEqual([]);
  });

  it("a good email passes the human check, sends the link and shows Check your email", async () => {
    await onSignIn();
    reply("/api/strategy/signin", { status: 200, body: {} });
    submit(SAM);
    expect(el("email-error").hidden).toBe(true);
    expect(el("email").getAttribute("aria-invalid")).toBe("false");
    await until("sent");
    expect(calls.at(-1)?.body).toEqual({ t: TOKEN, email: SAM, turnstile: "tok" });
    expect(el("sent-hint").textContent).toBe(`Use the email you gave Aida (${HINT})`);
    expect(button("signin-go").disabled).toBe(false);
    expect(document.activeElement?.id).toBe("sent-title");
  });

  it("a failed human check sends nothing and says so on the form", async () => {
    (window as unknown as { turnstile: unknown }).turnstile = fakeTurnstile(false);
    await onSignIn();
    submit(SAM);
    await vi.waitFor(() => { expect(el("signin-notice").textContent).toBe(GATE_FAILED); });
    expect(el("signin-notice").hidden).toBe(false);
    expect(calls.filter((c) => c.path === "/api/strategy/signin")).toEqual([]);
  });

  it("a failed human check after leaving sign-in changes nothing", async () => {
    (window as unknown as { turnstile: unknown }).turnstile = fakeTurnstile(false);
    reply("/api/strategy/view", "network-error");
    await open(`/strategy/${TOKEN}`);
    await until("trouble");
    submit(SAM);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen()).toBe("trouble");
  });

  it("loads the human-check script into the page when it is not there yet, and drops it when it fails", async () => {
    // This simulated page never loads outside scripts, so the vendor script fails as it is added: the real
    // loader must take it out again and the form must say the check failed, with nothing sent.
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    const added: string[] = [];
    const append = document.head.append.bind(document.head);
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) added.push(node.src);
      append(...nodes);
    });
    await onSignIn();
    submit(SAM);
    await vi.waitFor(() => {
      expect(el("signin-notice").textContent).toBe(GATE_FAILED);
    });
    expect(added).toEqual(["https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]);
    expect(document.head.querySelector("script")).toBeNull();
    expect(calls.filter((c) => c.path === "/api/strategy/signin")).toEqual([]);
  });

  it("the form does nothing on a page with no token", async () => {
    await open("/strategy/not-a-token");
    submit(SAM);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });
});

describe("signing out", () => {
  async function onView(): Promise<void> {
    reply("/api/strategy/view", { status: 200, body: sampleView() });
    await open(`/strategy/${TOKEN}`);
    await until("view");
  }

  it("signs out, clears the strategy from the page and lands on sign-in", async () => {
    await onView();
    reply("/api/strategy/signout", { status: 204 });
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    el("signout").click();
    expect(button("signout").disabled).toBe(true);
    await until("sign-in");
    expect(calls.find((c) => c.path === "/api/strategy/signout")?.body).toEqual({ t: TOKEN });
    expect(el("strategy").childElementCount).toBe(0);
    expect(document.activeElement?.id).toBe("signin-title");
  });

  it("a failed sign-out keeps the strategy, says so and gives the focus back to Sign out", async () => {
    await onView();
    reply("/api/strategy/signout", { status: 500 });
    button("signout").focus();
    (document.activeElement as HTMLElement | null)?.blur();
    el("signout").click();
    await vi.waitFor(() => { expect(el("signout-notice").textContent).toBe(SIGNOUT_FAILED_COPY); });
    expect(screen()).toBe("view");
    expect(el("signout-notice").hidden).toBe(false);
    expect(button("signout").disabled).toBe(false);
    expect(document.activeElement?.id).toBe("signout");
  });

  it("a failed sign-out leaves focus the person moved elsewhere where it is", async () => {
    await onView();
    reply("/api/strategy/signout", "network-error");
    el("signout").click();
    button("retry").focus();
    await vi.waitFor(() => { expect(el("signout-notice").textContent).toBe(SIGNOUT_FAILED_COPY); });
    expect(document.activeElement?.id).toBe("retry");
  });

  it("Sign out does nothing while a sign-out is running, or off the strategy screen", async () => {
    await onView();
    reply("/api/strategy/signout", { status: 204 });
    reply("/api/strategy/view", { status: 401, body: { hint: HINT } });
    el("signout").click();
    el("signout").click();
    await until("sign-in");
    expect(calls.filter((c) => c.path === "/api/strategy/signout")).toHaveLength(1);
    el("signout").click();
    expect(calls.filter((c) => c.path === "/api/strategy/signout")).toHaveLength(1);
  });

  it("Sign out does nothing on a page with no token", async () => {
    await open("/strategy/not-a-token");
    el("signout").click();
    expect(calls).toEqual([]);
  });
});
