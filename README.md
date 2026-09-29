# Aida — coming soon

A coming-soon page styled like a riso-printed broadcast. A sunburst spins open, Aida pops up
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
