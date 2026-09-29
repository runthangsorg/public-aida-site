# Aida — coming soon

A lightweight landing page with a motion-graphics entrance: light gathers, "Hello." rises out
of a blur letter by letter, her name lands in chrome, a bar of light crosses it. Tap, and she says
hello: her words appear as she speaks them and the glow follows the loudness of her voice.

- Static site, no framework: Vite + TypeScript + plain CSS, the Web Animations API for the
  entrance, a Web Audio analyser for the glow. No sign-up, no form.
- No third-party requests: system font stack, self-hosted audio, no analytics.
- Her voice is a recording made once, not generated on each visit. Word timings come from the
  caption start times in `src/intro.json` (`src/words.ts`, tested).
- Full `prefers-reduced-motion` path: the finished composition, no movement; she still speaks.
- Budget: 60 KB gzipped JS + CSS, enforced in CI.

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

## Repository policy

This repository is public. `tests/policy.test.ts` fails the build if any tracked file contains an
email address, a credential-shaped string or a forbidden word, if a workflow is not read-only and
SHA-pinned, or if a shipped file references a third-party host. Gitleaks runs in CI from a
checksum-verified release binary.
