# Aida — coming soon

A lightweight, animated landing page: Aida introduces herself and says she is on her way.

- Static site, no framework: Vite + TypeScript + plain CSS, layered SVG, CSS animations.
- No third-party requests: system font stack, self-hosted audio, no analytics.
- Her voice is a recording made once, not generated on each visit. Mouth shapes are computed
  offline with Rhubarb Lip Sync and blended against the audio clock.
- Full `prefers-reduced-motion` path: the settled page, with only fades left.
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
node scripts/lipsync.mjs        # Rhubarb -> src/intro-cues.json, and prints the pauses
```

Then set the caption start times in `src/intro.json` from the printed pauses. The project id and
credentials are read at run time and never written to the repository.

## Repository policy

This repository is public. `tests/policy.test.ts` fails the build if any tracked file contains an
email address, a credential-shaped string or a forbidden word, if a workflow is not read-only and
SHA-pinned, or if a shipped file references a third-party host. Gitleaks runs in CI from a
checksum-verified release binary.
