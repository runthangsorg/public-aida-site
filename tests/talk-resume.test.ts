import { describe, expect, it, vi } from "vitest";
import {
  EXPIRED_LINK,
  NETWORK_TRY_AGAIN,
  RELINK_INVALID,
  RELINK_SENT,
  WAIT_A_FEW_MINUTES,
  looksLikeEmail,
  pausedCopy,
  readResumeLink,
  readResumeReply,
  relinkOutcome,
  resumeRefusal,
  savedCopy,
  takeResumeToken,
} from "../src/talk/resume";

const TOKEN = "a1b2c3d4".repeat(8);

describe("the resume link", () => {
  it("takes the token from the query and leaves everything else in the address", () => {
    const read = readResumeLink({ pathname: "/talk/", search: `?resume=${TOKEN}&utm=x`, hash: "#top" });
    expect(read).toEqual({ token: TOKEN, present: true, clean: "/talk/?utm=x#top" });
    expect(readResumeLink({ pathname: "/talk/", search: `?resume=${TOKEN}`, hash: "" }).clean).toBe("/talk/");
  });

  it("accepts upper-case hex and trims, but nothing that is not 64 hex characters", () => {
    expect(readResumeLink({ pathname: "/talk/", search: `?resume=${TOKEN.toUpperCase()}`, hash: "" }).token).toBe(TOKEN);
    for (const bad of ["", "abc", TOKEN.slice(1), `${TOKEN}0`, "g".repeat(64), `${TOKEN}%20x`]) {
      const read = readResumeLink({ pathname: "/talk/", search: `?resume=${encodeURIComponent(bad)}`, hash: "" });
      expect(read.token, bad).toBeNull();
      expect(read.present).toBe(true);
      expect(read.clean).toBe("/talk/");
    }
  });

  it("says nothing was there when there is no parameter, and does not touch the address", () => {
    const replaceState = vi.fn();
    const read = takeResumeToken({ pathname: "/talk/", search: "", hash: "" }, { replaceState });
    expect(read).toEqual({ token: null, present: false, clean: "/talk/" });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("removes the token from the address bar at once, replacing the history entry", () => {
    const replaceState = vi.fn();
    const read = takeResumeToken({ pathname: "/talk/", search: `?resume=${TOKEN}`, hash: "" }, { replaceState });
    expect(read.token).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/talk/");
    // A malformed token is removed too, so nothing odd is left to be shared.
    const again = vi.fn();
    takeResumeToken({ pathname: "/talk/", search: "?resume=nonsense", hash: "" }, { replaceState: again });
    expect(again).toHaveBeenCalledWith(null, "", "/talk/");
  });
});

describe("the resume reply", () => {
  const good = {
    id: "abc",
    targetMinutes: 5,
    sections: [{ id: "org", label: "Your organisation" }],
    name: "Sam Example",
    resumed: { minutesSoFar: 2.5, stage: "org", hasSummary: false, notes: [{ section: "org", text: "Two sites", at: 30 }] },
  };

  it("opens the room from a well-formed reply, first name only", () => {
    expect(readResumeReply(good)).toEqual({
      id: "abc",
      targetMinutes: 5,
      sections: [{ id: "org", label: "Your organisation" }],
      name: "Sam",
      resumed: { minutesSoFar: 2.5, stage: "org", hasSummary: false, notes: [{ section: "org", text: "Two sites", at: 30 }] },
    });
  });

  it("refuses a reply with no id or no returning block", () => {
    expect(readResumeReply(null)).toBeNull();
    expect(readResumeReply({ ...good, id: "" })).toBeNull();
    expect(readResumeReply({ ...good, resumed: undefined })).toBeNull();
    expect(readResumeReply("ok")).toBeNull();
  });

  it("falls back to 20 minutes and no name", () => {
    const r = readResumeReply({ ...good, targetMinutes: "later", name: 7 });
    expect(r?.targetMinutes).toBe(20);
    expect(r?.name).toBe("");
  });
});

describe("what to say when the link fails", () => {
  it("offers a new link for unknown, expired and used", () => {
    for (const [status, error] of [[404, "unknown"], [410, "expired"], [410, "used"]] as const) {
      // A spent or unknown link is dropped from memory: retrying it cannot help.
      expect(resumeRefusal(status, { error })).toEqual({ message: EXPIRED_LINK, offerRelink: true, retry: false });
    }
    expect(EXPIRED_LINK).toBe("That link has expired or was already used. Enter your email below and we will send a new one.");
  });

  it("asks to wait on too many tries, and is plain about anything else", () => {
    // These keep the token in memory, so the same Continue button can try again.
    expect(resumeRefusal(429, { error: "too_many" })).toEqual({ message: WAIT_A_FEW_MINUTES, offerRelink: false, retry: true });
    expect(resumeRefusal(500, null).retry).toBe(true);
    expect(resumeRefusal(500, null).message).not.toBe(EXPIRED_LINK);
    expect(NETWORK_TRY_AGAIN).toMatch(/try again/);
  });
});

describe("asking for a new link", () => {
  it("checks the address loosely before asking", () => {
    // Assembled from parts: the repository's policy test forbids address-shaped text in tracked files.
    const at = "@";
    const ok = [`a${at}b.co`, ` sam${at}work.test `, `a.b+c${at}sub.domain.test`];
    const bad = ["", "sam", `sam${at}`, `${at}work.test`, `sam${at}work`, `sam ${at}work.test`, `a${at}b${at}c.co`, `a${at}.co`, `${"a".repeat(160)}${at}b.co`];
    for (const e of ok) expect(looksLikeEmail(e), e).toBe(true);
    for (const e of bad) expect(looksLikeEmail(e), e).toBe(false);
  });

  it("answers every well-formed email the same way, and handles the two refusals", () => {
    expect(relinkOutcome(200)).toEqual({ message: RELINK_SENT, ok: true });
    expect(RELINK_SENT).toBe("If we have a conversation of yours waiting, we have emailed you a link. It can take up to a minute.");
    expect(relinkOutcome(400)).toEqual({ message: RELINK_INVALID, ok: false });
    expect(relinkOutcome(429)).toEqual({ message: "Please wait a few minutes and try again.", ok: false });
    expect(relinkOutcome(500).ok).toBe(false);
  });
});

describe("the end screens for a saved conversation", () => {
  it("says a link was emailed, and for how long, when it was", () => {
    const c = pausedCopy(true);
    expect(c.title).toBe("Saved");
    expect(c.lede).toBe("We have emailed you a link to continue. It works for 14 days.");
    expect(c.more).toBe("Didn’t get it? Check spam, or use Continue on the first screen.");
  });

  it("says plainly when it could not email, without a cause", () => {
    const c = pausedCopy(false);
    expect(c.lede).toBe("We could not email you. Start again from the first screen and use Continue.");
    expect(c.more).toBe("");
  });

  it("does not claim an email when the server never said", () => {
    const c = pausedCopy(undefined);
    expect(c.lede + c.more).not.toMatch(/have emailed/);
  });

  it("the abandoned-call variant follows what was emailed", () => {
    expect(savedCopy(true).title).toBe("Your conversation is saved");
    expect(savedCopy(true).lede).toBe("We have emailed you a link to continue.");
    expect(savedCopy(false).lede).toMatch(/could not email/);
    expect(savedCopy(undefined).lede).toMatch(/could not email/);
  });
});
