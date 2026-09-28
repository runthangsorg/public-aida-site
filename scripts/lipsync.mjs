#!/usr/bin/env node
// Computes Aida's mouth shapes offline with Rhubarb Lip Sync, from the same
// trimmed WAV that was encoded for the page, and writes a compact cue list
// the page animates against `audio.currentTime`.
//
//   node scripts/lipsync.mjs
//
// Expects the Rhubarb release unpacked under .tmp/ (gitignored), for example
// .tmp/Rhubarb-Lip-Sync-1.14.0-Linux/rhubarb, or RHUBARB=/path/to/rhubarb.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = resolve(ROOT, ".tmp");
const WAV = resolve(TMP, "intro.wav");

function rhubarb() {
  if (process.env.RHUBARB) return process.env.RHUBARB;
  const dir = readdirSync(TMP).find((name) => /^Rhubarb-Lip-Sync-.*-Linux$/.test(name));
  if (!dir) throw new Error("Rhubarb not found under .tmp/; set RHUBARB=/path/to/rhubarb.");
  return resolve(TMP, dir, "rhubarb");
}

if (!existsSync(WAV)) throw new Error(`Missing ${WAV}; run scripts/record-intro.mjs first.`);

const { line } = JSON.parse(readFileSync(resolve(ROOT, "src", "intro.json"), "utf8"));
const dialog = resolve(TMP, "intro.txt");
writeFileSync(dialog, line + "\n");

const raw = resolve(TMP, "intro-rhubarb.json");
execFileSync(
  rhubarb(),
  ["-f", "json", "--extendedShapes", "GHX", "--dialogFile", dialog, "-o", raw, WAV],
  { stdio: ["ignore", "inherit", "inherit"] },
);

const result = JSON.parse(readFileSync(raw, "utf8"));
const cues = result.mouthCues.map((cue) => [Number(cue.start.toFixed(3)), cue.value]);
const duration = Number(result.metadata.duration.toFixed(3));

writeFileSync(
  resolve(ROOT, "src", "intro-cues.json"),
  JSON.stringify({ duration, cues }) + "\n",
);

console.log(`${cues.length} cues over ${duration} s -> src/intro-cues.json`);
const gaps = result.mouthCues.filter((cue) => cue.value === "X" && cue.end - cue.start > 0.18);
console.log("Pauses (for caption timing):");
for (const gap of gaps) console.log(`  ${gap.start.toFixed(2)} – ${gap.end.toFixed(2)} s`);
