import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVENTS, eventBody, newVisitId } from "../src/track";

describe("the page's event log", () => {
  it("sends only named events, with the referrer cut to its origin", () => {
    const body: unknown = JSON.parse(eventBody("voice", "silent", "abc123def4", "/", "https://www.linkedin.com/feed/?utm=x#y"));
    expect(body).toEqual({ e: "voice", d: "silent", v: "abc123def4", p: "/", r: "https://www.linkedin.com" });
    expect(JSON.parse(eventBody("view", "motion", "abc123def4", "/", ""))).not.toHaveProperty("r");
    expect(JSON.parse(eventBody("view", "motion", "abc123def4", "/", "not a url"))).not.toHaveProperty("r");
  });

  it("makes a fresh short visit id and stores nothing in the browser", () => {
    expect(newVisitId()).toMatch(/^[a-z0-9]{10}$/);
    expect(newVisitId()).not.toBe(newVisitId());
    const source = readFileSync(resolve(import.meta.dirname, "../src/track.ts"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it("posts to this site only", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/track.ts"), "utf8");
    const targets = [...source.matchAll(/(?:sendBeacon|fetch)\("([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(targets)).toEqual(new Set(["/api/event"]));
  });

  it("uses the same event names and details the server accepts", () => {
    expect(EVENTS).toEqual({
      view: ["motion", "still"],
      voice: ["sound", "silent"],
      tap: ["sound"],
      complete: ["sound", "silent"],
      stop: ["sound"],
      replay: ["sound"],
    });
  });

  it("is wired into the page: view, voice, tap or replay, stop, complete", () => {
    const main = readFileSync(resolve(import.meta.dirname, "../src/main.ts"), "utf8");
    for (const call of ['track("view"', 'track("voice"', 'track(heard ? "replay" : "tap"', 'track("stop"', 'track("complete"']) {
      expect(main, call).toContain(call);
    }
  });
});
