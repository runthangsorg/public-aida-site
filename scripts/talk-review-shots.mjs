#!/usr/bin/env node
/**
 * Screenshots of every screen of the talk page, at phone (390) and desktop (1280) width, with the server
 * stubbed, for a review by eye. Writes .tmp/review/<screen>-<width>.png (git-ignored). Prints nothing to
 * check: the point is to look at the pictures.
 *
 *   node scripts/talk-review-shots.mjs [--privacy <dir with privacy/index.html>]
 *
 * Needs a build (`npm run build`), Google Chrome and the `playwright` package (PLAYWRIGHT_MODULE if not importable).
 */
/* global window */
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const out = resolve('.tmp/review');
mkdirSync(out, { recursive: true });
const privacyRoot = args.includes('--privacy') ? resolve(args[args.indexOf('--privacy') + 1]) : null;
const dist = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.png': 'image/png' };
/** The file to serve: the privacy page from --privacy, everything else from dist/; a directory means its index.html. */
function fileFor(pathname) {
  const root = privacyRoot && pathname.startsWith('/privacy') ? privacyRoot : dist;
  for (const candidate of [`${root}${pathname}`, `${root}${pathname}/index.html`, `${root}${pathname}index.html`, `${dist}${pathname}`]) {
    try {
      return { body: readFileSync(candidate), type: types[candidate.slice(candidate.lastIndexOf('.'))] ?? 'application/octet-stream' };
    } catch {
      // try the next
    }
  }
  return null;
}
const server = createServer((req, res) => {
  const file = fileFor(new URL(req.url, 'http://x').pathname);
  if (file) res.writeHead(200, { 'content-type': file.type }).end(file.body);
  else res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const GO = '0f'.repeat(32);
// The labels the server sends (functions/api/_interview.ts STAGES), so the stage bar is reviewed as it ships.
const sections = [
  ['welcome', 'Welcome'],
  ['org', 'Your organisation'],
  ['tools', 'Your tools'],
  ['workflows', 'How the week runs'],
  ['challenges', 'Strengths, weaknesses and the crux'],
  ['needs', 'What you need'],
  ['timekeeping', 'Time tracking'],
  ['summary', 'Summary'],
].map(([id, label]) => ({ id, label }));
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
const summary = {
  strengths: ['A loyal team of forty cleaners', 'Clear pricing'],
  weaknesses: ['Rotas live in three spreadsheets'],
  opportunities: ['Automate Friday approvals'],
  threats: ['Rising wages'],
  crux: 'Every approval waits on two supervisors who are on the road.',
  needs: ['Payroll in a day, not a morning'],
  wants: ['One screen for the week'],
  approach: { bespokeOrCommodity: 'Ready-made, set up for us', kind: 'Done with us' },
};
/** An init segment whose codec no browser plays: video gives out on purpose. */
function badInit() {
  const enc = new TextEncoder();
  const be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type, ...parts) => {
    const body = parts.flat();
    return [...be(8 + body.length), ...enc.encode(type), ...body];
  };
  const z = (n) => new Array(n).fill(0);
  const avc1 = box('avc1', z(78), box('avcC', [1, 0xff, 0xff, 0xff, 0xff, 0xe1, 0, 0]));
  const trak = box('trak', box('tkhd', z(84)), box('mdia', box('mdhd', z(24)), box('minf', box('stbl', box('stsd', z(4), be(1), avc1)))));
  const bytes = [...box('ftyp', [...enc.encode('dash')], z(4)), ...box('moov', box('mvhd', z(100)), trak)];
  return Buffer.from(bytes).toString('base64');
}
const BAD_INIT = badInit();

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=FontationsFontBackend'],
  ignoreDefaultArgs: ['--disable-dev-shm-usage'],
});
const noMic = await chromium.launch({ channel: 'chrome', args: ['--disable-features=FontationsFontBackend'], ignoreDefaultArgs: ['--disable-dev-shm-usage'] });

async function page(b, size, { me = { known: false }, perms = ['microphone'], init = '', routes = {} } = {}) {
  const ctx = await b.newContext({ viewport: size, permissions: perms });
  const p = await ctx.newPage();
  await p.addInitScript((extra) => {
    new Function(extra)();
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        window.__ws = this;
        window.__sockets = (window.__sockets ?? 0) + 1;
      }
      send(m) {
        if (typeof m !== 'string') return;
        const type = /"type":"(\w+)"/.exec(m)?.[1];
        const reply = { pause: { reason: 'paused', emailed: true }, switch: { reason: 'switch', emailed: false }, end: { reason: 'user', emailed: false } }[type];
        if (reply) setTimeout(() => this.push({ aida: { type: 'ended', minutes: 3, resumable: true, ...reply } }), 150);
      }
      close() {
        this.readyState = 3;
      }
      push(o) {
        this.onmessage?.({ data: JSON.stringify(o) });
      }
      drop() {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
      }
    }
    FakeWS.OPEN = 1;
    FakeWS.CONNECTING = 0;
    FakeWS.CLOSING = 2;
    FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  }, init);
  await p.route('**/api/talk/me', (r) => r.fulfill(json(me)));
  await p.route('**/api/talk/confirm', (r) => r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam Example' })));
  await p.route('**/api/talk/start', (r) => r.fulfill(json({ pending: true, hint: ['s***', 'acme.example'].join('@'), resendInSeconds: 120 })));
  for (const [pattern, handler] of Object.entries(routes)) await p.route(pattern, handler);
  return { ctx, p };
}
const shot = async (p, name, w, full = true) => {
  await p.waitForTimeout(450);
  await p.screenshot({ path: `${out}/${name}-${w}.png`, fullPage: full });
};

async function intoRoom(p, avatar = true) {
  await p.goto(`${base}/talk/?go=${GO}`);
  await p.click('#go-go');
  await p.waitForFunction(() => window.__ws);
  await p.evaluate(([s, a]) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 20, sections: s, avatar: a } }), [sections, avatar]);
  await p.waitForTimeout(300);
}
async function talk(p) {
  await p.evaluate(() => {
    window.__ws.push({ aida: { type: 'section', id: 'tools' } });
    window.__ws.push({ serverContent: { outputTranscription: { text: 'Which tools do you use to track the hours your cleaners work, and who checks them?' } } });
    window.__ws.push({ aida: { type: 'note', section: 'org', text: 'Forty-five cleaners on thirty sites, mostly evenings' } });
    window.__ws.push({ aida: { type: 'note', section: 'tools', text: 'A phone app with GPS, and a kiosk at the depot' } });
  });
}
async function endWith(p, frame, avatar = false) {
  await intoRoom(p, avatar);
  await talk(p);
  if (frame.summary) await p.evaluate((s) => window.__ws.push({ aida: { type: 'summary', ...s } }), summary);
  await p.evaluate((f) => window.__ws.push({ aida: { type: 'ended', minutes: 7, ...f } }), frame);
  await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
}

for (const [w, h] of [[390, 844], [1280, 800]]) {
  const size = { width: w, height: h };
  const run = async (name, fn, opts = {}, b = browser) => {
    const { ctx, p } = await page(b, size, opts);
    try {
      await fn(p);
    } catch (e) {
      console.log(`${name}-${w}: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
  };
  await run('intro-stranger', async (p) => {
    await p.goto(`${base}/talk/`);
    await shot(p, 'intro-stranger', w);
  });
  await run('details', async (p) => {
    await p.goto(`${base}/talk/`);
    await p.click('.check .box');
    await p.click('#consent-form .btn-go');
    await shot(p, 'details-empty', w);
    await p.click('#details-go');
    await shot(p, 'details-errors', w);
    await p.fill('#f-name', 'Sam Example');
    await p.fill('#f-role', 'Owner');
    await p.fill('#f-company', 'Acme Cleaning');
    await p.fill('#f-industry', 'Commercial cleaning');
    await p.fill('#f-email', ['sam', 'acme.example'].join('@'));
    await p.click('#team-sizes label:nth-child(3)');
    await p.click('#details-go');
    await p.waitForSelector('#check:not([hidden])', { timeout: 20000 });
    await shot(p, 'check-email', w);
  }, { init: "window.turnstile = { render: (c, o) => { window.__o = o; return 'w'; }, execute: () => setTimeout(() => window.__o.callback('t'), 20), reset: () => {} };" });
  await run('go-card', async (p) => {
    await p.goto(`${base}/talk/?go=${GO}`);
    await shot(p, 'go-card', w);
  });
  const known = {
    'welcome-continue': { known: true, name: 'Sam Example', canContinue: true, minutesSoFar: 6.2, canStartNew: true },
    'welcome-startnew': { known: true, name: 'Sam Example', canContinue: false, canStartNew: true },
    'welcome-startready': { known: true, name: 'Sam Example', canContinue: false, canStartNew: true, startReady: true },
    'welcome-busy': { known: true, name: 'Sam Example', canContinue: true, minutesSoFar: 2, canStartNew: false, reasonIfNot: 'busy' },
    'welcome-limit': { known: true, name: 'Sam Example', canContinue: true, minutesSoFar: 2, canStartNew: false, reasonIfNot: 'daily_limit' },
  };
  for (const [name, me] of Object.entries(known)) {
    await run(name, async (p) => {
      await p.goto(`${base}/talk/`);
      await p.waitForSelector('#known-card:not([hidden])');
      await shot(p, name, w);
    }, { me });
  }
  await run('mic-unanswered', async (p) => {
    await p.goto(`${base}/talk/?go=${GO}`);
    await p.click('#go-go');
    await p.waitForTimeout(8800);
    await shot(p, 'mic-unanswered', w, false);
  }, { init: 'navigator.mediaDevices.getUserMedia = () => new Promise(() => {});' });
  await run('mic-denied', async (p) => {
    await p.goto(`${base}/talk/?go=${GO}`);
    await p.click('#go-go');
    await p.waitForSelector('#mic-actions:not([hidden])');
    await shot(p, 'mic-denied', w, false);
  }, { perms: [] }, noMic);
  await run('mic-missing', async (p) => {
    await p.goto(`${base}/talk/?go=${GO}`);
    await p.click('#go-go');
    await p.waitForSelector('#mic-actions:not([hidden])');
    await shot(p, 'mic-missing', w, false);
  }, { init: "navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));" });
  await run('connect-failed', async (p) => {
    await p.goto(`${base}/talk/?go=${GO}`);
    await p.click('#go-go');
    await p.waitForFunction(() => window.__ws);
    await p.evaluate(() => window.__ws.drop());
    await p.waitForSelector('#mic-actions:not([hidden])');
    await shot(p, 'connect-failed', w, false);
  });
  await run('room-video-poster', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await shot(p, 'room-video-poster', w, false);
  });
  await run('room-voice-only', async (p) => {
    await intoRoom(p, false);
    await talk(p);
    await shot(p, 'room-voice-only', w, false);
  });
  await run('room-typing', async (p) => {
    await intoRoom(p, false);
    await talk(p);
    await p.click('#type');
    await p.evaluate(() => window.__ws.push({ serverContent: { inputTranscription: { text: 'We use a phone app and a kiosk, and the supervisors check on Fridays.' } } }));
    await shot(p, 'room-typing', w, false);
  });
  await run('room-reconnecting', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.evaluate(() => window.__ws.drop());
    await shot(p, 'room-reconnecting', w, false);
  }, { routes: { '**/api/talk/continue': () => undefined } });
  await run('room-idle', async (p) => {
    await intoRoom(p, false);
    await talk(p);
    await p.evaluate(() => window.__ws.push({ aida: { type: 'idle_warning', secondsLeft: 30 } }));
    await shot(p, 'room-idle', w, false);
  });
  await run('end-complete', (p) => endWith(p, { reason: 'complete', summary: true }, true).then(() => shot(p, 'end-complete', w)));
  await run('end-complete-voiceonly', (p) => endWith(p, { reason: 'complete', summary: true }).then(() => shot(p, 'end-complete-voiceonly', w)));
  await run('end-paused', async (p) => {
    await intoRoom(p, false);
    await talk(p);
    await p.click('#later');
    await p.click('#later-yes');
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-paused', w);
  });
  await run('end-saved', (p) => endWith(p, { reason: 'user', resumable: true, emailed: true }).then(() => shot(p, 'end-saved', w)));
  await run('end-dropped', async (p) => {
    await intoRoom(p, false);
    await talk(p);
    await p.evaluate(() => window.__ws.drop());
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-dropped', w);
  }, { routes: { '**/api/talk/continue': (r) => r.fulfill(json({ error: 'nothing_to_continue' }, 404)) } });
  // The common real path is a video call: its dropped, paused and idle screens must keep Vera's face.
  await run('end-dropped-video', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.evaluate(() => window.__ws.drop());
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-dropped-video', w);
  }, { routes: { '**/api/talk/continue': (r) => r.fulfill(json({ error: 'nothing_to_continue' }, 404)) } });
  await run('end-paused-video', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.click('#later');
    await p.click('#later-yes');
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-paused-video', w);
  });
  await run('end-idle-video', (p) => endWith(p, { reason: 'idle', resumable: true }, true).then(() => shot(p, 'end-idle-video', w)));
  await run('room-typing-video', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.click('#type');
    await shot(p, 'room-typing-video', w, false);
  });
  await run('end-idle', (p) => endWith(p, { reason: 'idle', resumable: true }).then(() => shot(p, 'end-idle', w)));
  await run('end-declined', (p) => endWith(p, { reason: 'declined' }).then(() => shot(p, 'end-declined', w)));
  await run('end-budget', (p) => endWith(p, { reason: 'budget' }).then(() => shot(p, 'end-budget', w)));
  await run('end-video-stopped', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.evaluate((b64) => window.__ws.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'video/mp4', data: b64 } }] } } }), BAD_INIT);
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-video-stopped', w);
  });
  // The switch now moves the call in place; the end screen only appears when there is nothing to
  // carry on (server 404), so route it that way to shoot the screen a person would actually meet.
  await run('end-switching', async (p) => {
    await intoRoom(p, true);
    await talk(p);
    await p.click('#voice-only');
    await p.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await shot(p, 'end-switching', w);
  }, { routes: { '**/api/talk/continue': (r) => r.fulfill(json({ error: 'nothing_to_continue' }, 404)) } });
  if (privacyRoot) {
    await run('privacy', async (p) => {
      await p.goto(`${base}/privacy/`);
      await shot(p, 'privacy', w);
    });
  }
}
await browser.close();
await noMic.close();
server.close();
console.log(`screenshots in ${out}`);
