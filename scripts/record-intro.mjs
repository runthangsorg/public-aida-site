#!/usr/bin/env node
// Records Aida's spoken introduction ONCE with Gemini text-to-speech on
// Vertex AI, then encodes it for the web. This runs on a developer machine;
// nothing here runs at build time or when someone visits the page, so the
// site never spends tokens or waits on a model.
//
//   node scripts/record-intro.mjs
//
// Project id:  GOOGLE_CLOUD_PROJECT, else `gcloud config get-value project`.
// Credentials: GOOGLE_OAUTH_ACCESS_TOKEN, else application-default credentials
//              via `gcloud auth application-default print-access-token`.
// Neither the project id nor the token is written to disk or printed.
//
// Output (committed):   public/audio/intro.webm (Opus), public/audio/intro.mp3
// Working file (kept):  .tmp/intro.wav, for scripts/lipsync.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = resolve(ROOT, ".tmp");
const OUT = resolve(ROOT, "public", "audio");

// gemini-3.8-flash-tts is not published on Vertex AI for every project (it
// returned 404 in both global and us-central1 on 2026-09-28); the 2.5 TTS
// model carries the same prebuilt voices.
const MODEL = process.env.AIDA_TTS_MODEL ?? "gemini-2.5-flash-tts";
const VOICE = "Sulafat"; // the prebuilt "Warm" voice
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";

/** The spoken line: one short, printable sentence from src/intro.json, nothing else. */
function introLine() {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, "src", "intro.json"), "utf8"));
  const text = typeof parsed.line === "string" ? parsed.line.trim() : "";
  // Printable characters only (no control codes), and short enough for one take.
  const printable = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,240}$/u;
  if (!printable.test(text)) {
    throw new Error("src/intro.json `line` must be 1–240 printable characters.");
  }
  return text;
}
const line = introLine();

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

function project() {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  const fromGcloud = sh("gcloud", ["config", "get-value", "project"]);
  if (!fromGcloud || fromGcloud === "(unset)") {
    throw new Error("No project: set GOOGLE_CLOUD_PROJECT or `gcloud config set project`.");
  }
  return fromGcloud;
}

function accessToken() {
  const fromEnv = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return sh("gcloud", ["auth", "application-default", "print-access-token"]);
}

/** Wraps raw 16-bit PCM in a RIFF header; a no-op when the data is already WAV. */
function toWav(bytes, sampleRate = 24000, channels = 1) {
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF") return bytes;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

async function synthesise() {
  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project()}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: line }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  };

  console.log(`Synthesising with ${MODEL} / ${VOICE} (${LOCATION})…`);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vertex AI returned ${response.status}: ${text.slice(0, 1200)}`);
  }
  const json = await response.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const audio = parts.find((part) => typeof part.inlineData?.data === "string");
  if (!audio) throw new Error(`No audio in response: ${JSON.stringify(json).slice(0, 600)}`);
  const mime = String(audio.inlineData.mimeType ?? "");
  if (!/^audio\/(L16|wav|x-wav)\b/i.test(mime)) throw new Error(`Unexpected audio type: ${mime}`);
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  if (!(rate >= 8000 && rate <= 48000)) throw new Error(`Unexpected sample rate in ${mime}`);
  console.log(`Received ${mime}`);
  return toWav(Buffer.from(audio.inlineData.data, "base64"), rate);
}

/** Only ever write a bounded, well-formed WAV under .tmp/. */
function checkedWav(bytes) {
  const MAX = 16 * 1024 * 1024; // a few minutes of 24 kHz mono, far above one line
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 + 2400 || bytes.length > MAX) {
    throw new Error(`Audio payload is ${bytes.length} bytes; expected a short WAV.`);
  }
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Audio payload is not a WAV container.");
  }
  return bytes;
}

function encode(rawWav) {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const wav = resolve(TMP, "intro.wav");

  // Trim leading/trailing silence and normalise loudness. The raw take is
  // piped straight into ffmpeg and never written to disk; Rhubarb reads the
  // trimmed file, so mouth cues and audio share one timeline.
  const trim =
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.12," +
    "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3,areverse," +
    "loudnorm=I=-16:TP=-1.5:LRA=11";
  sh(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-af", trim, "-ar", "24000", "-ac", "1", wav],
    { input: checkedWav(rawWav), stdio: ["pipe", "pipe", "inherit"] },
  );

  const webm = resolve(OUT, "intro.webm");
  const mp3 = resolve(OUT, "intro.mp3");
  sh("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "40k", "-vbr", "on", "-ar", "48000", webm]);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "24000", mp3]);

  const duration = sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]);
  console.log(`Duration ${Number(duration).toFixed(2)} s`);
  for (const file of [webm, mp3]) console.log(`${file.replace(ROOT + "/", "")}  ${statSync(file).size} bytes`);
  if (Number(duration) > 8) console.warn("Warning: the line runs longer than 8 seconds.");
}

if (!existsSync(resolve(ROOT, "package.json"))) throw new Error("Run from the repository.");
encode(await synthesise());
