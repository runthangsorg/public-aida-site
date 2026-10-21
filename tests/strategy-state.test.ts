import { describe, expect, it } from "vitest";
import {
  BAD_EMAIL_COPY,
  EXPIRED_CODE_COPY,
  LOAD_FAILED_COPY,
  SEND_FAILED_COPY,
  reduce,
  waitCopy,
  type ScreenState,
} from "../src/strategy/state";
import { GATE_FAILED } from "../src/talk/turnstile";
import { HINT, sampleView } from "./strategy-fixture";

const loading: ScreenState = { screen: "loading" };
const signIn: ScreenState = { screen: "sign-in", hint: HINT, notice: null };

describe("what the page shows for GET /api/strategy/view", () => {
  it("shows the strategy on 200", () => {
    const view = sampleView();
    const next = reduce(loading, { type: "view", status: 200, body: view });
    expect(next).toEqual({ screen: "view", view });
  });

  it("asks for the email on 401, with the server's hint", () => {
    expect(
      reduce(loading, { type: "view", status: 401, body: { need: "email", hint: HINT } }),
    ).toEqual({ screen: "sign-in", hint: HINT, notice: null });
  });

  it("falls back to a general hint if the 401 has none", () => {
    expect(reduce(loading, { type: "view", status: 401, body: { need: "email" } })).toEqual({
      screen: "sign-in",
      hint: "your email",
      notice: null,
    });
  });

  it("shows the expired-link screen on 404", () => {
    expect(reduce(loading, { type: "view", status: 404, body: { error: "not_found" } })).toEqual({
      screen: "not-found",
    });
  });

  it("shows a connection problem on a 500, a network failure, or a malformed 200", () => {
    expect(reduce(loading, { type: "view", status: 500, body: null })).toEqual({ screen: "trouble" });
    expect(reduce(loading, { type: "view", status: 0, body: null })).toEqual({ screen: "trouble" });
    const broken = sampleView();
    broken.deck.heard.today = "not a list" as unknown as string[];
    expect(reduce(loading, { type: "view", status: 200, body: broken })).toEqual({
      screen: "trouble",
    });
  });
});

describe("what the page shows for POST /api/strategy/signin", () => {
  it("says the link is on its way on 200, and keeps the hint", () => {
    expect(reduce(signIn, { type: "signin", status: 200, body: { sent: true } })).toEqual({
      screen: "sent",
      hint: HINT,
    });
  });

  it("returns to the form with the email error on 400 bad_request", () => {
    expect(
      reduce(signIn, { type: "signin", status: 400, body: { error: "bad_request" } }),
    ).toEqual({ screen: "sign-in", hint: HINT, notice: BAD_EMAIL_COPY });
  });

  it("returns to the form with the person-check error on 400 turnstile", () => {
    expect(
      reduce(signIn, { type: "signin", status: 400, body: { error: "turnstile" } }),
    ).toEqual({ screen: "sign-in", hint: HINT, notice: GATE_FAILED });
  });

  it("says how long to wait on 429", () => {
    expect(
      reduce(signIn, { type: "signin", status: 429, body: { error: "rate_limited", retryAfter: 30 } }),
    ).toEqual({ screen: "sign-in", hint: HINT, notice: "Too many tries. Wait 30 seconds and try again." });
    expect(
      reduce(signIn, { type: "signin", status: 429, body: { error: "rate_limited", retryAfter: 120 } }),
    ).toEqual({ screen: "sign-in", hint: HINT, notice: "Too many tries. Wait 2 minutes and try again." });
    expect(waitCopy(1)).toBe("Too many tries. Wait 1 second and try again.");
  });

  it("returns to the form with a connection message when nothing answered", () => {
    expect(reduce(signIn, { type: "signin", status: 0, body: null })).toEqual({
      screen: "sign-in",
      hint: HINT,
      notice: SEND_FAILED_COPY,
    });
  });
});

describe("what the page shows for POST /api/strategy/verify", () => {
  it("goes back to loading on 200, ready to read the strategy", () => {
    expect(reduce(signIn, { type: "verify", status: 200 })).toEqual({ screen: "loading" });
  });

  it("returns to the form with the expired-link message on 400", () => {
    expect(reduce(signIn, { type: "verify", status: 400 })).toEqual({
      screen: "sign-in",
      hint: HINT,
      notice: EXPIRED_CODE_COPY,
    });
  });

  it("says how long to wait when the server rate-limits the sign-in link", () => {
    expect(reduce(signIn, { type: "verify", status: 429, body: { error: "rate_limited", retryAfter: 125 } })).toEqual({
      screen: "sign-in",
      hint: HINT,
      notice: waitCopy(125),
    });
  });

  it("returns to the form with a connection message on anything else", () => {
    expect(reduce(signIn, { type: "verify", status: 0 })).toEqual({
      screen: "sign-in",
      hint: HINT,
      notice: LOAD_FAILED_COPY,
    });
  });
});

describe("signing out", () => {
  it("shows the loading screen while the view is fetched again", () => {
    expect(reduce({ screen: "view", view: sampleView() }, { type: "signout" })).toEqual({
      screen: "loading",
    });
  });
});
