// Repository policy: this repository is public. Every tracked file is scanned
// for things that must never be published, and the CI workflow is held to a
// read-only, pinned, secret-free shape. The forbidden words are assembled
// from fragments so that this file does not itself contain them.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const BINARY =
  /\.(png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|webm|mp3|m4a|ogg|opus|wav|zip|gz)$/i;

const textFiles = tracked.filter((path) => !BINARY.test(path));
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

const forbiddenWords = [
  ["chow", "dhree"],
  ["jib", "ble"],
  ["proj", "ect-"],
].map((parts) => parts.join(""));

// Known-safe tokens that happen to contain a forbidden word. They are removed
// from the text before scanning, so they never mask anything around them.
const allowedTokens = ["proj" + "ect-service"];

const scrub = (text: string): string =>
  allowedTokens.reduce((acc, token) => acc.split(token).join(""), text);

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;

const keyShapes: [string, RegExp][] = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Google OAuth access token", /ya29\.[0-9A-Za-z_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/],
  ["sk- style secret key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /xox[abpr]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JSON web token", /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
  ["service-account JSON", /"private_key_id"\s*:/],
];

describe("tracked files", () => {
  it("exist and are text where scanned", () => {
    expect(tracked.length).toBeGreaterThan(0);
    for (const path of tracked) expect(existsSync(resolve(ROOT, path)), path).toBe(true);
  });

  it("never include scratch, build or environment files", () => {
    const banned = tracked.filter((path) =>
      /^(\.tmp\/|dist\/|node_modules\/|\.env)|\.(log|wav)$/.test(path),
    );
    expect(banned).toEqual([]);
  });

  it("contain no email addresses", () => {
    const hits = textFiles.filter((path) => EMAIL.test(read(path)));
    expect(hits).toEqual([]);
  });

  it("contain none of the forbidden words", () => {
    const hits: string[] = [];
    for (const path of textFiles) {
      const lower = scrub(read(path)).toLowerCase();
      for (const word of forbiddenWords) {
        if (lower.includes(word)) hits.push(`${path}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("contain nothing shaped like a credential", () => {
    const hits: string[] = [];
    for (const path of textFiles) {
      const text = read(path);
      for (const [label, shape] of keyShapes) {
        if (shape.test(text)) hits.push(`${path}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("the page", () => {
  const shipped = tracked.filter(
    (path) =>
      path === "index.html" ||
      path.startsWith("src/") ||
      (path.startsWith("public/") && /\.(svg|webmanifest|txt|json)$/.test(path)),
  );

  it("makes no third-party network requests", () => {
    // Only XML namespaces may look like URLs in shipped files.
    const external = /https?:\/\/(?!www\.w3\.org\/)/i;
    const hits = shipped.filter((path) => external.test(read(path)));
    expect(hits).toEqual([]);
  });
});

describe("continuous integration", () => {
  const workflows = tracked.filter((path) =>
    /^\.github\/workflows\/.*\.ya?ml$/.test(path),
  );

  it("has a CI workflow", () => {
    expect(workflows).toContain(".github/workflows/ci.yml");
  });

  it("is read-only, pinned and secret-free", () => {
    for (const path of workflows) {
      const text = read(path);
      expect(text, path).toContain("permissions:\n  contents: read");
      expect(text, path).not.toContain("contents: write");
      expect(text, path).not.toContain("pull_request_target");
      expect(text, path).not.toContain("secrets.");
      expect(text, path).not.toContain("upload-artifact");
      for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
        const [, ref] = match;
        expect(ref, `${path}: ${ref ?? ""}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
