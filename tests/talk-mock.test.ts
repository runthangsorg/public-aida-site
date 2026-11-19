// The local stand-in for the backend (scripts/talk-mock.mjs), run as it is run by hand.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

/** A port nothing is listening on just now. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        done(port);
      });
    });
  });
}

/** GET a raw path (not normalised by a URL parser on the way). */
function get(port: number, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => {
        done(res.statusCode ?? 0);
      });
    });
    req.once("error", fail);
    req.end();
  });
}

describe("the mock server", () => {
  it("answers a malformed address with 400 and keeps serving", async () => {
    // Review round 3 (public-site-18): GET /% threw a URIError outside any catch and the whole mock exited, so any
    // page open in the developer's browser could stop it with one request.
    const dir = mkdtempSync(join(tmpdir(), "talk-mock-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>mock</title>");
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/talk-mock.mjs", "--port", String(port), "--dir", dir], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((done, fail) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("mock: serving")) done();
        });
        child.once("exit", (code) => {
          fail(new Error(`mock exited early (${String(code)})`));
        });
      });
      const bad = await get(port, "/%").catch((err: unknown) => `failed: ${String(err)}`);
      expect(bad).toBe(400);
      expect(await get(port, "/")).toBe(200);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
