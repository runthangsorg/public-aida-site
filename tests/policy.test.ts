// Repository policy: this repository is public. Every tracked file is scanned
// for things that must never be published, and the CI workflow is held to a
// read-only, pinned, secret-free shape. The forbidden words are listed only
// as SHA-256 hashes of whole lower-case words, so this file does not reveal them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// SHA-256 of each forbidden word (lower case). A file fails if any of its words,
// split on anything that is not a letter or digit, hashes to one of these.
const forbiddenWordHashes = new Set([
  "89279772ac128e05836725491f0c1f2787aa665b57aedf01085c94398930c36c",
  "cc4761dedafa7b29e0fc56f0345c5a456f51a13aaeaa89dd82d1b32c24355d55",
]);
const sha256 = (word: string): string => createHash("sha256").update(word).digest("hex");

// A cloud project id of the generated "project-<hex>-…" shape.
const PROJECT_ID = /\bproject-[0-9a-f]{8}-[0-9a-f]{4}/i;

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
      const text = read(path);
      const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      for (const word of words) {
        if (forbiddenWordHashes.has(sha256(word))) hits.push(`${path}: a forbidden word`);
      }
      if (PROJECT_ID.test(text)) hits.push(`${path}: a project id`);
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
      /^[a-z0-9-]+\/index\.html$/.test(path) || // every other page, such as talk/index.html
      path.startsWith("src/") ||
      (path.startsWith("public/") && /\.(svg|webmanifest|txt|json)$/.test(path)),
  );

  it("ships the strategy page, and no interview (retired 20 Nov 2026: /talk/ is a paused page in the private repo)", () => {
    expect(shipped).toContain("strategy/index.html");
    expect(shipped.filter((path) => path.startsWith("talk/") || path.startsWith("src/talk/"))).toEqual([]);
  });

  it("makes no third-party network requests", () => {
    // Only the XML namespace host may appear in shipped files, plus the one script the owner approved:
    // the invisible person check on the registration form (loaded only when that form is first shown;
    // see tests/strategy-turnstile.test.ts).
    const allowedHosts = new Set(["www.w3.org", "challenges.cloudflare.com"]);
    const hits: string[] = [];
    for (const path of shipped) {
      for (const match of read(path).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = (match[1] ?? "").toLowerCase();
        if (!allowedHosts.has(host)) hits.push(`${path}: ${host}`);
      }
    }
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
