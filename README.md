# Aida

The browser half of one page on Aida's site:

- **`/strategy/<token>`**: a client's private strategy page, opened from a personal link; the
  client confirms their email and signs in with a one-time link.

The spoken interview that used to live here at `/talk/` was retired on 20 November 2026; its address
now shows a short "interviews are paused" page served by the private site.

The server half is not in this repository; the page talks only to its own site's `/api/`.

- Static site, no framework: Vite + TypeScript + plain CSS. A self-hosted, subset Anton (SIL OFL,
  `licenses/OFL-Anton.txt`; Latin with accents, rebuilt by `scripts/subset-anton.sh`) for display type, system
  fonts for the rest. No analytics in the page and no third-party requests, except the invisible bot check on
  the sign-in form.
- Tested to 100%: every line, branch and function in `src/` (`npm test` fails below that). `state.ts` and
  `render.ts` are pure; `main.ts` is tested against the real page markup in a simulated DOM
  (`tests/strategy-page.test.ts`), with the network and the bot check faked.
- Budget: 60 KB gzipped JS + CSS, enforced in CI.

## Develop

```sh
npm ci
npm run dev        # local server: open /strategy/<token>
npm run check      # typecheck, lint, tests with coverage, build, bundle budget
```

## Repository policy

`tests/policy.test.ts` fails the build if any tracked file contains an email address, a credential-shaped
string or a forbidden word, if a workflow is not read-only and SHA-pinned, or if a shipped file references a
third-party host. Gitleaks runs in CI from a checksum-verified release binary.
