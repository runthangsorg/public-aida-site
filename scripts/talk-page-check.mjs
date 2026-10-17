#!/usr/bin/env node
/**
 * Drives the built talk page in real Chrome with the server stubbed, for two things:
 *
 *   1. Which face she wears: Vera's still wherever video is expected, the drawn Aida only on the voice-only
 *      path, decided once at load (no flash of the other face, and the other face's art is never fetched).
 *   2. The Start press is never a silent dead end: microphone denied, a microphone question nobody answers,
 *      a socket that throws or closes before `ready`, and a confirmed-but-never-started interview.
 *
 *   node scripts/talk-page-check.mjs [--shots .tmp/shots]
 *
 * Needs a build (`npm run build`), Google Chrome and the `playwright` package (PLAYWRIGHT_MODULE if not importable).
 */
/* global window, document */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const shots = resolve(args.includes('--shots') ? (args[args.indexOf('--shots') + 1] ?? '.tmp/shots') : '.tmp/shots');
mkdirSync(shots, { recursive: true });
const dist = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  if (!existsSync(`${dist}${p}`)) p = `${p}/index.html`;
  try {
    res.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(readFileSync(`${dist}${p}`));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const GO = '0f'.repeat(32);
const sections = ['welcome', 'org', 'tools', 'workflows', 'challenges', 'needs', 'summary'].map((id) => ({ id, label: id }));
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`);
  if (!ok) failures.push(name);
};

const chrome = (extra = []) =>
  chromium.launch({ channel: 'chrome', args: ['--disable-features=FontationsFontBackend', ...extra], ignoreDefaultArgs: ['--disable-dev-shm-usage'] });

/** A page with the stubbed server. `ws`: how the socket behaves ('ok' | 'throw' | 'close'). */
async function open(browser, { size, perms = [], init = '', ws = 'ok', me = { known: false }, goto = '/talk/', routes = {} }) {
  const ctx = await browser.newContext({ viewport: size, permissions: perms });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ([mode, extra]) => {
      new Function(extra)();
      class FakeWS {
        constructor(url) {
          if (mode === 'throw') throw new DOMException('blocked', 'SecurityError');
          this.url = url;
          this.readyState = 1;
          window.__ws = this;
          window.__sockets = (window.__sockets ?? 0) + 1;
          window.__sent = [];
          if (mode === 'close') setTimeout(() => this.onclose?.({ code: 1006 }), 200);
        }
        send(m) {
          if (typeof m === 'string') window.__sent.push(m);
        }
        close() {
          this.readyState = 3;
        }
        push(o) {
          this.onmessage?.({ data: JSON.stringify(o) });
        }
        /** The line dies under the call: a close with no `ended` (what the worker's death looked like). */
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
    },
    [ws, init],
  );
  await page.route('**/api/talk/me', (r) => r.fulfill(json(me)));
  await page.route('**/api/talk/confirm', (r) => r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam Example' })));
  await page.route('**/api/talk/new', (r) => r.fulfill(json({ id: 's2', targetMinutes: 5, sections, name: 'Sam' })));
  for (const [pattern, handler] of Object.entries(routes)) await page.route(pattern, handler);
  await page.goto(`${base}${goto}`);
  return { ctx, page, requests, errors };
}

const faceState = (page) =>
  page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-face]')];
    return {
      hosts: hosts.length,
      vera: hosts.filter((h) => h.querySelector('.vera-still')).length,
      drawn: hosts.filter((h) => h.querySelector('.head')).length,
      kinds: [...new Set(hosts.map((h) => h.dataset.faceKind))],
    };
  });
const artFetched = (requests, re) => requests.some((p) => re.test(p));
const VERA = /\/aida\/vera(-640)?\.webp$/;
const DRAWN = /\/aida\/(aida(-640)?|mouth-[a-z]+|blink)\.webp$/;

const FAKE_MIC = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

// ---------- 1. the face ----------
{
  const browser = await chrome();
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
    const size = { width: w, height: h };
    {
      const { ctx, page, requests, errors } = await open(browser, { size });
      const f = await faceState(page);
      check(`[${tag}] with video expected, every face on the page is Vera's still (${f.vera} of ${f.hosts})`, f.hosts >= 3 && f.vera === f.hosts && f.drawn === 0 && f.kinds.join() === 'vera', JSON.stringify(f));
      await page.waitForTimeout(900);
      check(`[${tag}] the drawn art is never fetched on that path`, !artFetched(requests, DRAWN), requests.filter((p) => DRAWN.test(p)).join());
      check(`[${tag}] her still is`, artFetched(requests, VERA));
      await page.screenshot({ path: `${shots}/face-intro-vera-${tag}.png`, fullPage: false });
      check(`[${tag}] no page errors`, errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    {
      const { ctx, page, requests } = await open(browser, { size, init: "localStorage.setItem('aida.talk.voice-only','1')" });
      const f = await faceState(page);
      check(`[${tag}] voice only chosen earlier: the drawn Aida, with no still fetched (${f.drawn} of ${f.hosts})`, f.drawn === f.hosts && f.vera === 0 && f.kinds.join() === 'drawn' && !artFetched(requests, VERA));
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${shots}/face-intro-drawn-voiceonly-${tag}.png`, fullPage: false });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, { size, init: 'delete window.MediaSource; delete window.ManagedMediaSource;' });
      const f = await faceState(page);
      check(`[${tag}] no Media Source: the drawn Aida`, f.drawn === f.hosts && f.vera === 0);
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 1b. the room, the pending and welcome-back screens ----------
{
  const browser = await chrome(FAKE_MIC);
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
    const size = { width: w, height: h };
    // welcome-back card with Vera
    {
      const { ctx, page } = await open(browser, { size, me: { known: true, name: 'Sam Example', canContinue: true, minutesSoFar: 3.4, canStartNew: true } });
      await page.waitForSelector('#known-card:not([hidden])');
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${shots}/face-welcomeback-vera-${tag}.png` });
      await ctx.close();
    }
    // the room: Vera's still is the poster under the video
    {
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await page.click('#go-go');
      await page.waitForFunction(() => window.__ws);
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);
      await page.waitForTimeout(900);
      const f = await page.evaluate(() => ({ kind: document.querySelector('#stage').dataset.faceKind, still: !!document.querySelector('#stage .vera-still'), video: !document.querySelector('#avatar-video').hidden }));
      check(`[${tag}] the room's poster under the video is Vera's still`, f.kind === 'vera' && f.still && f.video, JSON.stringify(f));
      await page.screenshot({ path: `${shots}/face-room-poster-vera-${tag}.png` });
      await ctx.close();
    }
    // the server says voice only: the drawn Aida, with her mouth working
    {
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await page.click('#go-go');
      await page.waitForFunction(() => window.__ws);
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: false } }), sections);
      await page.waitForTimeout(700);
      const f = await page.evaluate(() => ({ faces: [...document.querySelectorAll('[data-face]')].map((h) => h.dataset.faceKind), mouths: document.querySelectorAll('#stage .mouth').length, video: document.querySelector('#avatar-video').hidden }));
      check(`[${tag}] ready.avatar false: every face becomes the drawn Aida, with her mouth patches, and no video`, f.faces.every((k) => k === 'drawn') && f.mouths === 5 && f.video, JSON.stringify(f));
      await page.screenshot({ path: `${shots}/face-room-drawn-voiceonly-${tag}.png` });
      await ctx.close();
    }
    // video gives out: the end screen wears the drawn face
    {
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await page.click('#go-go');
      await page.waitForFunction(() => window.__ws);
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);
      await page.waitForTimeout(500);
      await page.click('#voice-only');
      await page.waitForTimeout(500);
      const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-face]')].map((h) => h.dataset.faceKind));
      check(`[${tag}] after Switch to voice only the drawn Aida is the face`, kinds.every((k) => k === 'drawn'), kinds.join());
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 2. the Start press ----------
{
  // microphone permission denied: no flag, no permission
  const denied = await chrome();
  {
    const { ctx, page } = await open(denied, { size: { width: 390, height: 844 }, goto: `/talk/?go=${GO}` });
    await page.click('#go-go');
    await page.waitForSelector('#mic:not([hidden])');
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, text: document.querySelector('#mic-text').textContent, retry: !document.querySelector('#mic-retry').hidden, type: !document.querySelector('#mic-type').hidden, actions: !document.querySelector('#mic-actions').hidden }));
    check('microphone denied: a plain message with Try again and Type instead (not the intro)', s.screen === 'mic' && /blocking the microphone/.test(s.text) && s.retry && s.type && s.actions, JSON.stringify(s));
    await page.screenshot({ path: `${shots}/start-mic-denied-phone.png` });
    await page.click('#mic-type');
    await page.waitForSelector('#room:not([hidden])', { timeout: 5000 });
    check('...and Type instead opens the room', (await page.evaluate(() => window.__sockets)) === 1);
    await ctx.close();
  }
  // no audio device at all
  {
    const { ctx, page } = await open(denied, { size: { width: 390, height: 844 }, perms: ['microphone'], goto: `/talk/?go=${GO}`, init: "navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));" });
    await page.click('#go-go');
    await page.waitForSelector('#mic:not([hidden])');
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => ({ text: document.querySelector('#mic-text').textContent, retry: !document.querySelector('#mic-retry').hidden, type: !document.querySelector('#mic-type').hidden }));
    check('no microphone: says so, with Try again and Type instead', /couldn’t find a microphone/.test(s.text) && s.retry && s.type, JSON.stringify(s));
    await page.screenshot({ path: `${shots}/start-mic-missing-phone.png` });
    await ctx.close();
  }
  // a question nobody answers
  {
    const { ctx, page } = await open(denied, { size: { width: 390, height: 844 }, goto: `/talk/?go=${GO}`, init: 'navigator.mediaDevices.getUserMedia = () => new Promise(() => {});' });
    await page.click('#go-go');
    await page.waitForSelector('#mic:not([hidden])');
    await page.waitForTimeout(2000);
    const early = await page.evaluate(() => !document.querySelector('#mic-actions').hidden);
    await page.waitForTimeout(7500);
    const late = await page.evaluate(() => ({ actions: !document.querySelector('#mic-actions').hidden, text: document.querySelector('#mic-text').textContent, type: !document.querySelector('#mic-type').hidden }));
    check('a microphone question nobody answers: waiting at first, then help and a way round after ~8 s', !early && late.actions && /Still waiting for your browser/.test(late.text) && late.type, JSON.stringify({ early, ...late }));
    await page.screenshot({ path: `${shots}/start-mic-unanswered-phone.png` });
    await page.click('#mic-type');
    await page.waitForSelector('#room:not([hidden])', { timeout: 5000 });
    check('...and Type instead then opens the room', (await page.evaluate(() => window.__sockets)) === 1);
    await ctx.close();
  }
  await denied.close();

  // the socket throws, or closes before ready: a message with a retry, never the form
  const mic = await chrome(FAKE_MIC);
  for (const mode of ['throw', 'close']) {
    const { ctx, page } = await open(mic, { size: { width: 390, height: 844 }, perms: ['microphone'], ws: mode, goto: `/talk/?go=${GO}` });
    await page.click('#go-go');
    await page.waitForFunction(() => document.querySelector('#app').dataset.screen === 'mic' && !document.querySelector('#mic-actions').hidden, null, { timeout: 8000 });
    const s = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, text: document.querySelector('#mic-text').textContent, retry: !document.querySelector('#mic-retry').hidden }));
    check(`the socket ${mode === 'throw' ? 'throws' : 'closes before ready'}: a plain message and Try again, on the same screen`, /couldn’t connect you to Aida/.test(s.text) && s.retry && s.screen === 'mic', JSON.stringify(s));
    if (mode === 'close') await page.screenshot({ path: `${shots}/start-connect-failed-phone.png` });
    await page.click('#mic-retry');
    await page.waitForFunction(() => /Still no connection/.test(document.querySelector('#mic-text').textContent), null, { timeout: 8000 });
    check(`...and the second failure says what to do next`, true);
    await ctx.close();
  }
  await mic.close();

  // a confirmed interview that was never started
  const browser = await chrome(FAKE_MIC);
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
    const posted = [];
    const { ctx, page } = await open(browser, {
      size: { width: w, height: h },
      perms: ['microphone'],
      me: { known: true, name: 'Sam Example', canContinue: false, canStartNew: true, startReady: true },
      routes: { '**/api/talk/new': async (r) => { posted.push(r.request().url()); await r.fulfill(json({ id: 's2', targetMinutes: 5, sections, name: 'Sam' })); } },
    });
    await page.waitForSelector('#known-card:not([hidden])');
    await page.waitForTimeout(900);
    const k = await page.evaluate(() => ({ label: document.querySelector('#known-new').textContent, primary: document.querySelector('#known-new').classList.contains('btn-go'), cont: document.querySelector('#known-continue').hidden, detail: document.querySelector('#known-detail').textContent }));
    check(`[${tag}] a confirmed, never-started interview: the card says Start (main button), with no Continue`, k.label === 'Start' && k.primary && k.cont, JSON.stringify(k));
    await page.screenshot({ path: `${shots}/start-ready-card-${tag}.png` });
    await page.click('#known-new');
    await page.waitForFunction(() => window.__ws, null, { timeout: 8000 });
    check(`[${tag}] pressing it uses the server's /new (which reuses the waiting interview) and opens the socket`, posted.length === 1);
    await ctx.close();
  }
  await browser.close();
}

// ---------- 3. a dropped line reconnects on its own ----------
{
  const browser = await chrome(FAKE_MIC);
  const resumedBody = { id: 's1', targetMinutes: 5, sections, name: 'Sam', resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [{ section: 'org', text: 'Forty staff on two sites', at: 40 }] } };
  let roomAt = 0;
  /** Opens a live call, drops its line, answers /continue with `replies` in turn (the last repeats). */
  async function dropped(tag, size, replies, { clock = false } = {}) {
    const asked = [];
    const { ctx, page, errors } = await open(browser, {
      size,
      perms: ['microphone'],
      goto: `/talk/?go=${GO}`,
      routes: {
        '**/api/talk/continue': async (r) => {
          const status = replies[Math.min(asked.length, replies.length - 1)];
          asked.push(status);
          await r.fulfill(status === 200 ? json(resumedBody) : json({ error: status === 409 ? 'busy' : 'nothing_to_continue' }, status));
        },
      },
    });
    if (clock) await page.clock.install();
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);
    roomAt = await page.evaluate(() => Date.now());
    await page.evaluate(() => window.__ws.push({ aida: { type: 'note', section: 'org', text: 'Forty staff on two sites' } }));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__ws.drop());
    return { ctx, page, asked, errors };
  }
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
    const size = { width: w, height: h };
    {
      const { ctx, page, asked, errors } = await dropped(tag, size, [409, 409, 200]);
      await page.waitForTimeout(400);
      const down = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, status: document.querySelector('#status-text').textContent, face: document.querySelector('#stage').dataset.faceKind, mute: document.querySelector('#mute').disabled, later: document.querySelector('#later').disabled, end: document.querySelector('#end').disabled }));
      check(`[${tag}] the line drops: the room stays, says so, her still visible, only End works`, down.screen === 'room' && down.status === 'Reconnecting…' && down.face === 'vera' && down.mute && down.later && !down.end, JSON.stringify(down));
      await page.screenshot({ path: `${shots}/review-room-reconnecting-${tag}.png` });
      await page.waitForFunction(() => (window.__sockets ?? 0) >= 2, null, { timeout: 20000 });
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true, resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [{ section: 'org', text: 'Forty staff on two sites', at: 40 }] } } }), sections);
      await page.waitForTimeout(500);
      const back = await page.evaluate((t0) => { const c = document.querySelector('#clock').textContent; const [m, sec] = c.split(':').map(Number); return { screen: document.querySelector('#app').dataset.screen, notes: document.querySelectorAll('#nb-groups li').length, stage: document.querySelector('#stage-label').textContent, clock: c, clockS: m * 60 + sec, wallS: Math.floor((Date.now() - t0) / 1000), status: document.querySelector('#status-text').textContent }; }, roomAt);
      check(`[${tag}] 200 after two 409s: back in the room by itself, notes and stage carried on, the clock still running from before the drop, 'Back on the line' (asked ${asked.join(', ')})`, asked.join() === '409,409,200' && back.screen === 'room' && back.notes === 1 && back.stage === 'tools' && back.clockS >= back.wallS - 2 && back.status === 'Back on the line', JSON.stringify(back));
      check(`[${tag}] no page errors while reconnecting`, errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    if (tag === 'phone') {
      const { ctx, page, asked } = await dropped(tag, size, [404]);
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      const end = await page.evaluate(() => ({ title: document.querySelector('#end-title').textContent, lede: document.querySelector('#end-lede').textContent, choices: document.querySelector('#choices').hidden, cont: !document.querySelector('#end-actions').hidden, label: document.querySelector('#end-continue .label').textContent }));
      check(`[${tag}] 404: the line-dropped end screen, with Continue (asked ${asked.length} time)`, asked.length === 1 && end.title === 'The line dropped' && /place is saved/.test(end.lede) && end.cont && end.label === 'Continue' && end.choices, JSON.stringify(end));
      await page.screenshot({ path: `${shots}/review-end-dropped-${tag}.png`, fullPage: true });
      await ctx.close();
    }
    if (tag === 'phone') {
      const { ctx, page, asked } = await dropped(tag, size, [409], { clock: true });
      // Let each reply land before the next 5 s pass (the request itself is real, the clock is not).
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(150);
        await page.clock.runFor(5000);
      }
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      check(`[${tag}] 409 for ever: gives up after 75 s (asked ${asked.length} times) and shows the end screen`, asked.length >= 14 && asked.length <= 17);
      await ctx.close();
    }
    if (tag === 'phone') {
      // No reconnect after the call ended, or after Pause
      for (const how of ['ended', 'pause']) {
        const asked = [];
        const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}`, routes: { '**/api/talk/continue': async (r) => { asked.push(1); await r.fulfill(json({ error: 'x' }, 404)); } } });
        await page.click('#go-go');
        await page.waitForFunction(() => window.__ws);
        await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: false } }), sections);
        await page.waitForTimeout(400);
        if (how === 'ended') await page.evaluate(() => window.__ws.push({ aida: { type: 'ended', reason: 'complete', minutes: 1 } }));
        else {
          await page.click('#later');
          await page.click('#later-yes');
        }
        await page.waitForTimeout(200);
        await page.evaluate(() => window.__ws.drop());
        await page.waitForTimeout(1500);
        check(`[${tag}] no reconnect after ${how === 'ended' ? 'the call ended' : 'Pause'}`, asked.length === 0 && (await page.evaluate(() => window.__sockets)) === 1);
        await ctx.close();
      }
    }
  }
  await browser.close();
}

// ---------- 4. the busy card: never "already open" beside an active button ----------
{
  const browser = await chrome();
  for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
    let calls = 0;
    const { ctx, page } = await open(browser, {
      size: { width: w, height: h },
      routes: {
        '**/api/talk/me': async (r) => {
          calls++;
          await r.fulfill(json(calls === 1 ? { known: true, name: 'Sam', canContinue: true, minutesSoFar: 2, canStartNew: false, reasonIfNot: 'busy' } : { known: true, name: 'Sam', canContinue: true, minutesSoFar: 2, canStartNew: true }));
        },
      },
    });
    await page.waitForSelector('#known-card:not([hidden])');
    await page.waitForTimeout(700);
    const busy = await page.evaluate(() => ({ detail: document.querySelector('#known-detail').textContent, cont: document.querySelector('#known-continue').disabled, check: !document.querySelector('#known-check').hidden, again: document.querySelector('#again').hidden }));
    check(`[${tag}] busy: says so and how it clears, Continue disabled, Check again offered, no bottom Continue link`, /already open in another window/.test(busy.detail) && /clears within a minute/.test(busy.detail) && busy.cont && busy.check && busy.again, JSON.stringify(busy));
    await page.screenshot({ path: `${shots}/review-welcome-busy-${tag}.png` });
    await page.click('#known-check');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ cont: document.querySelector('#known-continue').disabled, check: !document.querySelector('#known-check').hidden, detail: document.querySelector('#known-detail').textContent }));
    check(`[${tag}] Check again re-reads /me: once it clears, Continue is live and the note goes`, !after.cont && !after.check && !/already open/.test(after.detail), JSON.stringify(after));
    await ctx.close();
  }
  // a stranger sees the bottom link; a known visitor does not
  for (const [me, want] of [[{ known: false }, false], [{ known: true, name: 'Sam', canContinue: true, canStartNew: true }, true]]) {
    const { ctx, page } = await open(browser, { size: { width: 390, height: 844 }, me });
    await page.waitForTimeout(700);
    const hidden = await page.evaluate(() => document.querySelector('#again').hidden);
    check(`"Already started? Continue where you left off" is ${want ? 'hidden for a known visitor' : 'shown to a stranger'}`, hidden === want);
    await ctx.close();
  }
  await browser.close();
}

server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
