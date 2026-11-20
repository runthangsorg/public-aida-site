/**
 * The interview at /talk/ was retired on 20 Nov 2026 (the owner's decision, made with two advisers: it was last used on
 * 26 Oct, is not being extended, and its live voice was the last Google Cloud dependency). /talk/ now shows a short
 * "interviews are paused" page that the private site overlay serves. This repository keeps only the client strategy
 * page, and nothing it needs may still live under the interview's folders.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

describe("the retired interview", () => {
  it("has no files left: no page, no source, no assets, no tests and no tooling", () => {
    const left = tracked.filter(
      (path) =>
        path.startsWith("talk/") ||
        path.startsWith("src/talk/") ||
        path.startsWith("public/talk/") ||
        path.startsWith("tests/talk-") ||
        /^scripts\/(talk-|avatar-check)/.test(path) ||
        path === "tests/avatar-check.test.ts",
    );
    expect(left).toEqual([]);
  });

  it("is not a build input: the strategy page is the only one", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toMatch(/strategy:\s*resolve\(import\.meta\.dirname, "strategy\/index\.html"\)/);
    expect(config).not.toMatch(/talk/);
  });

  it("leaves the strategy page everything it uses: its human check and its paper background", () => {
    expect(existsSync("src/strategy/turnstile.ts")).toBe(true);
    const css = readFileSync("src/strategy/strategy.css", "utf8");
    const paper = /url\("(\/[^"]+\.webp)"\)/.exec(css)?.[1];
    expect(paper).toBe("/aida/paper.webp");
    expect(existsSync(`public${paper}`)).toBe(true);
    for (const file of ["src/strategy/main.ts", "src/strategy/state.ts", "src/strategy/render.ts"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\.\.\/talk\//);
    }
  });

  it("is not named in the package description", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { description: string };
    expect(pkg.description).not.toMatch(/interview|\/talk\//);
  });
});
