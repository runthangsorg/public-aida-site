# Aida — coming soon

A coming-soon page styled like a riso-printed broadcast, and an interview room at `/talk/`. A sunburst spins open, Aida pops up
and says hello, and big words stamp down as she speaks them, with the colours changing on every
phrase. She is drawn and she talks: her mouth follows the recording's lip-sync cues, and she
blinks and sways.

- Static site, no framework: Vite + TypeScript + plain CSS, the Web Animations API for the
  motion, a Web Audio analyser for the glow behind her. No sign-up, no form.
- She speaks as soon as the page lands. Browsers refuse sound until the visitor has tapped, so
  when they do, she says it anyway in captions, lips moving, and the first tap anywhere replays
  it out loud.
- No third-party requests: a self-hosted, subset Anton (SIL OFL, `licenses/OFL-Anton.txt`), system
  fonts for the rest, self-hosted audio and images, no analytics.
- Her voice is a recording made once, not generated on each visit. Word timings come from the
  caption start times in `src/intro.json` (`src/words.ts`); mouth shapes from Rhubarb Lip Sync
  cues (`src/lipsync.ts`); the big words from her own words (`src/beats.ts`). All tested.
- Full `prefers-reduced-motion` path: the finished composition, no movement, no autoplay; she
  still speaks when asked.
- Budget: 60 KB gzipped JS + CSS, enforced in CI; her images together stay under 300 KB (tested).

## Develop

```sh
npm ci
npm run dev        # local server
npm run check      # typecheck, lint, tests, build, bundle budget
```

## Talk to her: `/talk/`

A second page runs a spoken interview of about twenty minutes: a short consent screen, a
details form, the microphone, then a live room where she talks (Gemini Live audio through this
site's own `/api/talk` socket), captions both sides, fills a notebook grouped by section and
moves a stage bar; it ends on a SWOT read-back. The browser half lives in `src/talk/`; the
server half is not in this repository.

- Pure, tested modules: `pcm.ts` (PCM16 and resampling), `protocol.ts` and `state.ts` (frames
  into what the room shows), `swot.ts` (the read-back, escaped), `details.ts`, `mouth.ts`.
- Light on a weak laptop: nothing animates while the room is quiet; her mouth is read from the
  playback analyser about 15 times a second, only while she speaks; the microphone worklet posts
  every 64 ms, not every render quantum; the paper grain is a 2 KB tile. Four cores or fewer,
  4 GB of memory or less, or reduced motion: a still face and a "speaking" ring instead.

Try it without the backend, against a local stand-in that speaks the same protocol:

```sh
npm run build
node scripts/talk-mock.mjs --voice      # then open http://localhost:8790/talk/
```

`--scenario nosummary|drop|quiet` and `--pace` change the script; the file's header lists the
`/mock/*` controls used for scripted screenshots.

## Re-record her line

Only needed when the words in `src/intro.json` change. Requires `gcloud` with application-default
credentials, `ffmpeg`, and a Rhubarb Lip Sync release unpacked under `.tmp/` (gitignored).

```sh
node scripts/record-intro.mjs   # one Gemini TTS call on Vertex AI, then Opus + MP3 encodes
node scripts/lipsync.mjs        # Rhubarb -> src/intro-cues.json (duration), and prints the pauses
```

Then set the caption start times in `src/intro.json` from the printed pauses. The project id and
credentials are read at run time and never written to the repository.

## Redraw her

Her portrait and expressions were drawn once with FLUX.2 [klein] 4B (Apache-2.0) on Cloudflare
Workers AI: the portrait from `scripts/portrait/prompts/base.txt`, then each mouth and the blink as
an edit of that portrait, seed 23 throughout. `scripts/portrait/build.py` cuts her out (rembg,
`isnet-anime`) and cuts each expression into a feathered patch that sits over her face.

```sh
scripts/portrait/gen.sh base      # then small, mid, wide, round, pucker, blink
.tmp/venv/bin/python scripts/portrait/build.py   # writes public/aida/*.webp and a QA sheet
.tmp/venv/bin/python scripts/portrait/og.py public/aida/aida.webp <Anton .woff> public/og.png
```

Look at `.tmp/portrait/qa-frames.jpg` before shipping: every mouth, over her face, at display size.

## Repository policy

This repository is public. `tests/policy.test.ts` fails the build if any tracked file contains an
email address, a credential-shaped string or a forbidden word, if a workflow is not read-only and
SHA-pinned, or if a shipped file references a third-party host. Gitleaks runs in CI from a
checksum-verified release binary.
