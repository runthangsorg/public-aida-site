// The avatar check (scripts/avatar-check.mjs) paces its stream by the source's audio. A source with no audio track
// gave it no length at all: every message went at once and the check failed without saying why (review, 19 Nov).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe("the avatar check's source", () => {
  it.skipIf(!hasFfmpeg)("a source with no audio track is refused, and the reason given", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-check-"));
    try {
      const source = join(dir, "no-audio.mp4");
      const made = spawnSync(
        "ffmpeg",
        ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=176x320:rate=24:duration=1", "-pix_fmt", "yuv420p", source],
        { stdio: "ignore" },
      );
      expect(made.status).toBe(0);
      // Run where it writes its own .tmp/; no browser is ever started (a missing module stops it before that).
      const run = spawnSync(process.execPath, [join(root, "scripts/avatar-check.mjs"), source], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_MODULE: join(dir, "no-such-module.mjs") },
        timeout: 60_000,
      });
      expect(run.stderr).toContain("the source needs an AAC audio track");
      expect(run.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
