# Aida

The browser half of two pages on Aida's site:

- **`/talk/`**: a spoken interview of up to twenty minutes. A short consent screen, a details form
  with an email check, the microphone, then a live room where she talks, captions both sides, fills
  a notebook grouped by section and moves a stage bar; it ends on a read-back.
- **`/strategy/<token>`**: a client's private strategy page, opened from a personal link; the
  client confirms their email and signs in with a one-time link.

The server half is not in this repository; both pages talk only to their own site's `/api/`.

- Static site, no framework: Vite + TypeScript + plain CSS. A self-hosted, subset Anton (SIL OFL,
  `licenses/OFL-Anton.txt`) for display type, system fonts for the rest. No analytics in the page and
  no third-party requests, except the invisible bot check on the details and sign-in forms.
- Pure, tested modules: `src/talk/pcm.ts` (PCM16 and resampling), `protocol.ts` and `state.ts`
  (frames into what the room shows), `swot.ts` (the read-back, escaped), `details.ts`, `gate.ts`,
  `resume.ts`, `reconnect.ts`, `noise.ts`, `avatar.ts`; `src/strategy/state.ts` and `render.ts`.
- Light on a weak laptop: nothing animates while the room is quiet; the microphone worklet and the
  socket move 100 ms frames, not one message per render quantum; the paper grain is a 2 KB tile.
  Four cores or fewer, 4 GB of memory or less, or reduced motion: a still face and a "speaking"
  ring instead.
- Budget: 60 KB gzipped JS + CSS, enforced in CI.

## Develop

```sh
npm ci
npm run dev        # local server: open /talk/ or /strategy/
npm run check      # typecheck, lint, tests, build, bundle budget
```

Try the interview without the backend, against a local stand-in that speaks the same protocol:

```sh
npm run build
node scripts/talk-mock.mjs --voice      # then open http://localhost:8790/talk/
```

`--scenario nosummary|drop|quiet` and `--pace` change the script; the file's header lists the
`/mock/*` controls used for scripted screenshots.

## Repository policy

This repository is public. `tests/policy.test.ts` fails the build if any tracked file contains an
email address, a credential-shaped string or a forbidden word, if a workflow is not read-only and
SHA-pinned, or if a shipped file references a third-party host. Gitleaks runs in CI from a
checksum-verified release binary.
