#!/usr/bin/env node
/**
 * The strategy page's four screens at phone (390x844) and desktop (1280x800) size, with the API stubbed and
 * nothing sent anywhere. Writes .tmp/strategy/<screen>-<width>.png (git-ignored); look at them by eye.
 *
 *   node scripts/strategy-shots.mjs
 *
 * Needs a build (`npm run build`), Google Chrome and the `playwright` package (PLAYWRIGHT_MODULE if not importable).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const out = resolve(".tmp/strategy");
mkdirSync(out, { recursive: true });
const dist = resolve("dist");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Everything under /strategy/ is the one page: production rewrites it that way, and so does this server. */
function fileFor(pathname) {
  const file = pathname === "/strategy" || pathname.startsWith("/strategy/") ? "/strategy/index.html" : pathname;
  for (const candidate of [`${dist}${file}`, `${dist}${file}/index.html`, `${dist}${file}index.html`]) {
    try {
      return {
        body: readFileSync(candidate),
        type: types[candidate.slice(candidate.lastIndexOf("."))] ?? "application/octet-stream",
      };
    } catch {
      // try the next
    }
  }
  return null;
}

const server = createServer((req, res) => {
  const file = fileFor(new URL(req.url, "http://x").pathname);
  if (file) res.writeHead(200, { "content-type": file.type }).end(file.body);
  else res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const TOKEN = "a".repeat(43);
const HINT = "s***@acme.example";
const CONTACT = ["sam", "acme.example"].join("@");
const view = {
  company: "Acme Cleaning (fictional)",
  firstName: "Sam",
  publishedAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  contact: CONTACT,
  deck: {
    title: "AI and automation strategy for Acme Cleaning (fictional)",
    company: "Acme Cleaning (fictional)",
    dateLabel: "20 October 2026",
    heard: {
      business:
        "Acme Cleaning (fictional) cleans forty offices with a team of thirty-five. The week runs on three spreadsheets, and every hour is checked by hand before it is paid.",
      today: [
        "Two supervisors check every timesheet by hand on Friday afternoon.",
        "Missed clock-outs are corrected one at a time, from memory.",
        "Payroll waits on both supervisors, and often slips to Monday.",
      ],
      crux: "Every approval waits on two supervisors who are on the road.",
    },
    swot: {
      strengths: ["A loyal team of thirty-five cleaners", "Clear, fixed pricing"],
      weaknesses: ["Rotas live in three spreadsheets", "The Friday check is manual"],
      opportunities: ["Automate the approval list", "Catch missed clock-outs the same night"],
      threats: ["Rising wages", "A supervisor leaving takes the process with them"],
    },
    plays: [
      {
        name: "Friday approvals on one screen",
        whatWeWouldBuild:
          "A single approval list that fills itself from the clock-in data, flags the missed clock-outs, and sends both supervisors one link.",
        whatChangesForYou:
          "The supervisors approve from their phones in ten minutes. Payroll starts on Friday, not Monday.",
        firstStep: "Map the three spreadsheets with the two supervisors, in one hour.",
        evidence: "Every approval waits on two supervisors who are on the road.",
      },
      {
        name: "The rota that writes itself",
        whatWeWouldBuild:
          "One rota built from the site list, the holiday calendar and each cleaner's usual hours.",
        whatChangesForYou: "The office stops rebuilding the same week in three places.",
        firstStep: "Agree the rules for cover and overtime.",
        evidence: "We spend more time fixing the rota than planning the work.",
      },
    ],
    roadmap: [
      {
        when: "First 30 days",
        items: ["Map the spreadsheets", "Agree the approval rules", "Pick the first two sites"],
      },
      { when: "30-60 days", items: ["Build the approval list", "Run it beside the old check", "Train the supervisors"] },
      { when: "60-90 days", items: ["Run payroll from it", "Retire the Friday spreadsheet", "Review the hours saved"] },
    ],
    nextStep: "Reply with a time next week and we will walk the two supervisors through it.",
    speaker: "Aida",
  },
};

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--disable-features=FontationsFontBackend"],
  ignoreDefaultArgs: ["--disable-dev-shm-usage"],
});

async function page(size, { viewStatus, signin = true }) {
  const ctx = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  p.on("pageerror", (err) => console.log(`page error: ${err.message}`));
  p.on("console", (msg) => {
    if (msg.type() === "error") console.log(`console error: ${msg.text()}`);
  });
  await p.addInitScript(() => {
    window.turnstile = {
      render: (container, options) => {
        window.__turnstile = options;
        return "widget";
      },
      execute: () => setTimeout(() => window.__turnstile?.callback("token"), 10),
      reset: () => {},
    };
  });
  await p.route("**/api/strategy/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/strategy/view") {
      if (viewStatus === 200) await route.fulfill(json(view));
      else if (viewStatus === 401) await route.fulfill(json({ need: "email", hint: HINT }, 401));
      else await route.fulfill(json({ error: "not_found" }, viewStatus));
      return;
    }
    if (path === "/api/strategy/signin") {
      await route.fulfill(signin ? json({ sent: true }) : json({ error: "bad_request" }, 400));
      return;
    }
    if (path === "/api/strategy/verify") {
      await route.fulfill(json({ error: "expired" }, 400));
      return;
    }
    await route.fulfill(json({ ok: true }));
  });
  return { ctx, p };
}

const sizes = [
  [390, 844],
  [1280, 800],
];

for (const [width, height] of sizes) {
  const size = { width, height };
  const shot = async (name, go, ready) => {
    const { ctx, p } = await page(size, go);
    try {
      await p.goto(`${base}/strategy/${TOKEN}`);
      await p.waitForSelector(ready, { timeout: 10000 });
      await p.waitForTimeout(500);
      await p.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
      console.log(`${name}-${width}.png`);
    } catch (e) {
      console.log(`${name}-${width}: ${e.message.split("\n")[0]}`);
    }
    await ctx.close();
  };

  await shot("sign-in", { viewStatus: 401, signin: true }, "#sign-in:not([hidden])");
  await shot("not-found", { viewStatus: 404, signin: true }, "#not-found:not([hidden])");
  await shot("strategy-view", { viewStatus: 200, signin: true }, "#view:not([hidden])");

  const { ctx, p } = await page(size, { viewStatus: 401, signin: true });
  try {
    await p.goto(`${base}/strategy/${TOKEN}`);
    await p.waitForSelector("#sign-in:not([hidden])");
    await p.fill("#email", CONTACT);
    await p.click("#signin-go");
    await p.waitForSelector("#sent:not([hidden])", { timeout: 10000 });
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/sent-${width}.png`, fullPage: true });
    console.log(`sent-${width}.png`);
  } catch (e) {
    console.log(`sent-${width}: ${e.message.split("\n")[0]}`);
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(`screenshots in ${out}`);
