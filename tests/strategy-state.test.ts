import { describe, expect, it } from "vitest";
import {
  BAD_EMAIL_COPY,
  BASE_TITLE,
  EXPIRED_CODE_COPY,
  LOAD_FAILED_COPY,
  SEND_FAILED_COPY,
  SIGNOUT_FAILED_COPY,
  keepCode,
  newLinkMailto,
  pageTitle,
  reduce,
  signOutDone,
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

  it("on a 404 carrying the team's address, offers it to ask for a new link (and only a plain address)", () => {
    const team = ["team", "aida.example"].join("@");
    expect(reduce(loading, { type: "view", status: 404, body: { error: "not_found", contact: team } })).toEqual({
      screen: "not-found",
      contact: team,
    });
    for (const odd of ["", "not an address", `${team},${team}`, `${team}?bcc=x`, 42]) {
      expect(reduce(loading, { type: "view", status: 404, body: { error: "not_found", contact: odd } }), String(odd)).toEqual({
        screen: "not-found",
      });
    }
    expect(newLinkMailto(team)).toBe(`mailto:${team}?subject=New%20link%20to%20my%20strategy`);
  });

  it("on a 429 says how long to wait, not to check the connection", () => {
    const next = reduce(loading, { type: "view", status: 429, body: { error: "rate_limited", retryAfter: 600 } });
    expect(next).toEqual({ screen: "trouble", notice: "Too many tries. Wait 10 minutes and try again." });
    expect(reduce(loading, { type: "view", status: 429, body: null })).toEqual({ screen: "trouble", notice: waitCopy(60) });
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
  // Review round 3 (public-site-30): a sign-out the server never confirmed fetched the strategy again and showed it
  // as if nothing had happened.
  it("is done only when the server says so (or says there was no session); anything else is reported", () => {
    for (const status of [200, 204, 401]) expect(signOutDone(status)).toBe(true);
    for (const status of [0, 403, 429, 500, 503]) expect(signOutDone(status)).toBe(false);
    expect(SIGNOUT_FAILED_COPY).toBe("We could not sign you out. Check your connection and try again.");
  });

  it("shows the loading screen while the view is fetched again", () => {
    expect(reduce({ screen: "view", view: sampleView() }, { type: "signout" })).toEqual({
      screen: "loading",
    });
  });

  it("the tab keeps the strategy's title only while the strategy is on screen", () => {
    const view = sampleView();
    expect(pageTitle({ screen: "view", view })).toBe(`${view.deck.title} — Aida`);
    const out = reduce({ screen: "view", view }, { type: "signout" });
    expect(pageTitle(out)).toBe(BASE_TITLE);
    expect(pageTitle(reduce(out, { type: "view", status: 401, body: { need: "email", hint: HINT } }))).toBe(BASE_TITLE);
    expect(pageTitle({ screen: "not-found" })).toBe(BASE_TITLE);
  });
});

describe("the one-time code in the address", () => {
  // Review round 3 (public-site-16): any answer but 401 dropped the code, so a dropped connection or a server fault on
  // the first request lost it, and Try again could only show the sign-in form.
  it("stays while the strategy request had no definitive answer", () => {
    for (const status of [0, 429, 500, 503]) expect(keepCode(status)).toBe(true);
  });

  it("goes once the strategy opened without it, or the link is closed", () => {
    for (const status of [200, 404]) expect(keepCode(status)).toBe(false);
  });

  it("stays while the code itself had no definitive answer, and goes once the server answered it", () => {
    for (const status of [0, 429, 500, 503]) expect(keepCode(401, status)).toBe(true);
    for (const status of [200, 400, 401, 404]) expect(keepCode(401, status)).toBe(false);
  });
});
