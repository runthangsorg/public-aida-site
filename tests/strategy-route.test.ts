import { describe, expect, it } from "vitest";
import { CODE_RE, INCOMPLETE_COPY, NOT_FOUND_COPY, emailProblem, landing, readRoute } from "../src/strategy/state";
import { CODE, TOKEN } from "./strategy-fixture";

describe("the strategy address", () => {
  it("takes the 43-character token from /strategy/<token> and the code from ?c=", () => {
    expect(readRoute(`https://aida.example/strategy/${TOKEN}`)).toEqual({ token: TOKEN, code: null });
    expect(readRoute(`https://aida.example/strategy/${TOKEN}?c=${CODE}`)).toEqual({ token: TOKEN, code: CODE });
  });

  it("needs no host of its own to read an address", () => {
    expect(readRoute(`/strategy/${TOKEN}?c=${CODE}`)).toEqual({ token: TOKEN, code: CODE });
    expect(readRoute(`//aida.example/strategy/${TOKEN}`).token).toBeNull();
    expect(readRoute(`strategy/${TOKEN}`).token).toBe(TOKEN);
  });

  it("accepts a trailing slash and a relative address", () => {
    expect(readRoute(`/strategy/${TOKEN}/`).token).toBe(TOKEN);
    expect(readRoute(`/strategy/${TOKEN}?c=${CODE}&utm=x#top`).code).toBe(CODE);
  });

  it("refuses anything that is not one base64url segment after /strategy/", () => {
    const bad = [
      "/strategy/",
      "/strategy",
      `/strategy/${"a".repeat(42)}`,
      `/strategy/${"a".repeat(44)}`,
      `/strategy/${"a".repeat(42)}!`,
      `/strategy/${"a".repeat(43)}/extra`,
      `/other/${TOKEN}`,
      `/strategy/../${TOKEN}`,
    ];
    for (const path of bad) expect(readRoute(path).token, path).toBeNull();
  });

  it("a link cut short or mangled is an incomplete link, not an expired one (nothing was asked of the server)", () => {
    for (const path of [`/strategy/${TOKEN.slice(0, 40)}`, "/strategy/not-a-real-token", "/strategy/", `/strategy/${TOKEN})`]) {
      expect(landing(readRoute(path)), path).toEqual({ screen: "not-found", incomplete: true });
    }
    expect(landing(readRoute(`/strategy/${TOKEN}`))).toEqual({ screen: "loading" });
    expect(INCOMPLETE_COPY).not.toMatch(/expired|withdrawn/);
    expect(NOT_FOUND_COPY).toMatch(/expired or was withdrawn/);
  });

  it("refuses a malformed code but still reads the token", () => {
    expect(readRoute(`/strategy/${TOKEN}?c=short`)).toEqual({ token: TOKEN, code: null });
    expect(readRoute(`/strategy/${TOKEN}?c=${"!".repeat(43)}`)).toEqual({ token: TOKEN, code: null });
    expect(CODE_RE.test(TOKEN)).toBe(true);
  });
});

describe("the sign-in form", () => {
  it("asks for the address when the field is empty or only spaces", () => {
    expect(emailProblem("")).toBe("Enter the email you gave Aida.");
    expect(emailProblem("   ")).toBe("Enter the email you gave Aida.");
  });

  it("refuses what is not an email address", () => {
    for (const bad of ["sam", "sam@", "@acme.example", "sam@acme", "sam @acme.example", "sam@acme..example"]) {
      expect(emailProblem(bad), bad).toBe("Enter a valid email address.");
    }
  });

  it("accepts the address the client gave the team", () => {
    expect(emailProblem(["sam", "acme.example"].join("@"))).toBeNull();
    expect(emailProblem(` ${["sam", "acme.example"].join("@")} `)).toBeNull();
  });
});
