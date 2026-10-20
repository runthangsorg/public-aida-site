#!/usr/bin/env node
/**
 * Drives the built talk page in real Chrome with the server stubbed, for two things:
 *
 *   1. Which face she wears: Vera's still everywhere, including voice-only calls (owner, 18 Oct: no drawn
 *      character), decided once at load and never fetched as the other art.
 *   2. The Start press is never a silent dead end: microphone denied, a microphone question nobody answers,
 *      a socket that throws or closes before `ready`, and a confirmed-but-never-started interview.
 *   5. Round 3 (20 Oct): the barge-in gate in a real browser (a synthetic microphone of known loudness: a quiet
 *      room and a cough are held back while she speaks, a voice is sent), the status chip's Listening,
 *      Transcribing…, Noted, the notebook open on a phone with its transcript, and the QA findings of 18 Oct.
 *
 *   node scripts/talk-page-check.mjs [--shots .tmp/shots] [--only 1,5]   (sections: 1 face, 1b room, 2 start,
 *                                                                     3 reconnect, 4 busy card, 5 round 3)
 *
 * Needs a build (`npm run build`), Google Chrome and the `playwright` package (PLAYWRIGHT_MODULE if not importable).
 */
/* global window, document, getComputedStyle, innerHeight, location */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const shots = resolve(args.includes('--shots') ? (args[args.indexOf('--shots') + 1] ?? '.tmp/shots') : '.tmp/shots');
mkdirSync(shots, { recursive: true });
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',') : null;
/** Run this section? All of them unless --only names some. */
const want = (section) => !only || only.includes(section);
const dist = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  if (!existsSync(`${dist}${p}`)) p = `${p}/index.html`;
  try {
    // Read first: writeHead before a read that throws would send the 404 headers on top of a 200 and crash the server.
    const body = readFileSync(`${dist}${p}`);
    res.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(body);
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
      // Keep every microphone stream the page opens, so a check can see whether its track is live.
      const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (gum) {
        navigator.mediaDevices.getUserMedia = async (c) => {
          const stream = await gum(c);
          (window.__streams ??= []).push(stream);
          return stream;
        };
      }
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
if (want('1')) {
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
      check(`[${tag}] voice only chosen earlier: Vera's still too, and the drawn art is never fetched (${f.vera} of ${f.hosts})`, f.vera === f.hosts && f.drawn === 0 && f.kinds.join() === 'vera' && artFetched(requests, VERA) && !artFetched(requests, DRAWN), JSON.stringify(f));
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${shots}/face-intro-voiceonly-vera-${tag}.png`, fullPage: false });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, { size, init: 'delete window.MediaSource; delete window.ManagedMediaSource;' });
      const f = await faceState(page);
      check(`[${tag}] no Media Source: still Vera's still`, f.vera === f.hosts && f.drawn === 0);
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 1b. the room, the pending and welcome-back screens ----------
if (want('1b')) {
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
    // the server says voice only: Vera's still stays the face, no video
    {
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await page.click('#go-go');
      await page.waitForFunction(() => window.__ws);
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: false } }), sections);
      await page.waitForTimeout(700);
      const f = await page.evaluate(() => ({ faces: [...document.querySelectorAll('[data-face]')].map((h) => h.dataset.faceKind), still: !!document.querySelector('#stage .vera-still'), video: document.querySelector('#avatar-video').hidden }));
      check(`[${tag}] ready.avatar false: every face stays Vera's still, and no video`, f.faces.every((k) => k === 'vera') && f.still && f.video, JSON.stringify(f));
      await page.screenshot({ path: `${shots}/face-room-voiceonly-vera-${tag}.png` });
      await ctx.close();
    }
    // Switch to voice only: the room stays, the clock runs, and the page moves the call itself
    {
      const { ctx, page } = await open(browser, {
        size,
        perms: ['microphone'],
        goto: `/talk/?go=${GO}`,
        routes: { '**/api/talk/continue': async (r) => { await r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam', resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [] } })); } },
      });
      await page.click('#go-go');
      await page.waitForFunction(() => window.__ws);
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);
      await page.waitForTimeout(500);
      await page.click('#voice-only');
      await page.waitForTimeout(300);
      const mid = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, status: document.querySelector('#status-text').textContent, face: document.querySelector('#stage').dataset.faceKind, video: document.querySelector('#avatar-video').hidden, saved: localStorage.getItem('aida.talk.voice-only') }));
      check(`[${tag}] Switch to voice only: the room stays saying "Switching to voice only…", Vera's still, no video, the choice remembered`, mid.screen === 'room' && mid.status === 'Switching to voice only…' && mid.face === 'vera' && mid.video && mid.saved === '1', JSON.stringify(mid));
      await page.waitForFunction(() => (window.__sockets ?? 0) >= 2, null, { timeout: 20000 });
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: false, resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [] } } }), sections);
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, status: document.querySelector('#status-text').textContent, face: document.querySelector('#stage').dataset.faceKind, video: document.querySelector('#avatar-video').hidden }));
      check(`[${tag}] ...then carries straight on in the room by voice, still Vera`, back.screen === 'room' && back.face === 'vera' && back.video && back.status === 'Back on the line', JSON.stringify(back));
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 2. the Start press ----------
if (want('2')) {
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
if (want('3')) {
  const browser = await chrome(FAKE_MIC);
  const resumedBody = { id: 's1', targetMinutes: 5, sections, name: 'Sam', resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [{ section: 'org', text: 'Forty staff on two sites', at: 40 }] } };
  let roomAt = 0;
  /** Opens a live call, drops its line, answers /continue with `replies` in turn (the last repeats). */
  async function dropped(tag, size, replies, { clock = false, mute = false } = {}) {
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
    if (mute) await page.click('#mute');
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
      // 17 Oct, production: the owner's muted call reconnected with the microphone live and picked up the room.
      const { ctx, page } = await dropped(tag, size, [200], { mute: true });
      await page.waitForFunction(() => (window.__sockets ?? 0) >= 2, null, { timeout: 20000 });
      await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true, resumed: { minutesSoFar: 2, stage: 'tools', hasSummary: false, notes: [] } } }), sections);
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => ({ pressed: document.querySelector('#mute').getAttribute('aria-pressed'), label: document.querySelector('#mute').textContent.trim(), live: (window.__streams ?? []).at(-1)?.getAudioTracks().some((t) => t.enabled) ?? null, streams: (window.__streams ?? []).length }));
      check(`[${tag}] muted before the drop: still muted after the reconnect, and the new microphone track is off`, m.pressed === 'true' && /Unmute/.test(m.label) && m.live === false && m.streams >= 2, JSON.stringify(m));
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
if (want('4')) {
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

// ---------- 5. round 3 (20 Oct) ----------
if (want('5')) {
  const browser = await chrome([...FAKE_MIC, '--autoplay-policy=no-user-gesture-required']);
  const phone = { width: 390, height: 844 };
  const desk = { width: 1280, height: 800 };
  // A microphone whose loudness the check sets: white noise (RMS 1) through a gain, window.__mic.gain.value.
  const SYNTH_MIC = `navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    await ctx.resume().catch(() => undefined);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sqrt(3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.004;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain).connect(dest);
    src.start();
    window.__mic = gain;
    window.__micCtx = ctx;
    return dest.stream;
  };`;
  const NO_TURNSTILE = "window.turnstile = { render: (c, o) => { window.__o = o; return 'w'; }, execute: () => setTimeout(() => window.__o.callback('t'), 20), reset: () => {} };";
  const status = (page) => page.evaluate(() => document.querySelector('#status-text').textContent);
  const intoRoom = async (page, avatar = false) => {
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await page.evaluate(([s, a]) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: a } }), [sections, avatar]);
    await page.waitForTimeout(300);
  };

  // The barge-in gate, end to end: worklet level -> gate -> socket.
  {
    const { ctx, page, errors } = await open(browser, { size: phone, perms: ['microphone'], goto: `/talk/?go=${GO}`, init: SYNTH_MIC });
    await intoRoom(page);
    const sent = () => page.evaluate(() => window.__sent.filter((m) => m.includes('realtimeInput')).length);
    const gain = (v) => page.evaluate((x) => { window.__mic.gain.value = x; }, v);
    await page.waitForTimeout(1500);
    const before = await sent();
    check('gate: while she is not speaking, the microphone is sent as before (a quiet room included)', before >= 8, before);
    // Her voice: 6 s of a soft tone on the PCM queue, and her words.
    await page.evaluate(() => {
      const n = 24000 * 6;
      const bytes = new Uint8Array(n * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((i / 24000) * 2 * Math.PI * 220) * 3000), true);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      window.__ws.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(bin) } }] } } });
      window.__ws.push({ serverContent: { outputTranscription: { text: 'Tell me about the hours your team works, and who checks them.' } } });
    });
    await page.waitForTimeout(300);
    const s0 = await sent();
    await page.waitForTimeout(1800);
    const s1 = await sent();
    const speaking = await status(page);
    check(`gate: while she speaks, a quiet room is held back (${s1 - s0} frames sent in 1.8 s; chip "${speaking}")`, s1 - s0 === 0 && speaking === 'Aida is speaking', s1 - s0);
    // A cough: exactly 150 ms, loud, timed on the microphone's own audio clock.
    await page.evaluate(() => {
      const t = window.__micCtx.currentTime + 0.05;
      window.__mic.gain.setValueAtTime(0.3, t);
      window.__mic.gain.setValueAtTime(0.004, t + 0.15);
    });
    await page.waitForTimeout(800);
    const s2 = await sent();
    check(`gate: a 150 ms cough while she speaks is held back too (${s2 - s1} frames)`, s2 - s1 === 0, s2 - s1);
    // Their voice: loud and lasting.
    await gain(0.12);
    await page.waitForTimeout(1000);
    const s3 = await sent();
    check(`gate: their voice over hers opens it: the held ~300 ms first, then everything (${s3 - s2} frames in 1 s)`, s3 - s2 >= 9, s3 - s2);
    await gain(0.004);
    await page.waitForTimeout(1300);
    const s4 = await sent();
    await page.waitForTimeout(400);
    const s5 = await sent();
    check(`gate: ...and shuts ~800 ms after they stop, while she is still speaking (${s5 - s4} frames in the last 0.4 s)`, s5 - s4 === 0, s5 - s4);
    // After her voice ends: the chip says Transcribing… (they spoke, she has not answered yet), then Noted.
    await page.waitForFunction(() => document.querySelector('#status-text').textContent !== 'Aida is speaking', null, { timeout: 5000 });
    const t1 = await status(page);
    check(`chip: once she stops, "${t1}" (they spoke; nothing from her yet)`, t1 === 'Transcribing…', t1);
    const pulsing = await page.evaluate(() => getComputedStyle(document.querySelector('#status-text')).animationName);
    check('chip: the word Transcribing… pulses', pulsing === 'pulse', pulsing);
    await page.screenshot({ path: `${shots}/r3-chip-transcribing-phone.png` });
    await page.evaluate(() => window.__ws.push({ aida: { type: 'note', section: 'workflows', text: 'Hours are checked by two supervisors every Friday afternoon' } }));
    await page.waitForTimeout(250);
    const t2 = await status(page);
    await page.screenshot({ path: `${shots}/r3-chip-noted-phone.png` });
    await page.waitForTimeout(1600);
    const t3 = await status(page);
    check(`chip: a note flashes "${t2}", then "${t3}"`, t2 === 'Noted' && t3 === 'Listening', `${t2} -> ${t3}`);
    await gain(0.12);
    await page.waitForTimeout(600);
    const t4 = await status(page);
    await gain(0.004);
    await page.waitForTimeout(1300);
    const t5 = await status(page);
    check(`chip: "${t4}" while they talk, "${t5}" once they stop`, t4 === 'Listening' && t5 === 'Transcribing…', `${t4} -> ${t5}`);
    check('gate: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // The notebook: open on a phone, the side page on a desk; Notes and Transcript.
  for (const [size, tag] of [[phone, 'phone'], [desk, 'desktop']]) {
    const { ctx, page, errors } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
    await intoRoom(page, true);
    await page.evaluate(() => {
      const her = (t) => window.__ws.push({ serverContent: { outputTranscription: { text: t } } });
      const you = (t) => window.__ws.push({ serverContent: { inputTranscription: { text: t } } });
      her('Which tools do you use to track the hours your cleaners work?');
      you('A phone app with GPS, and a kiosk at the depot.');
      window.__ws.push({ aida: { type: 'note', section: 'tools', text: 'A phone app with GPS, and a kiosk at the depot' } });
      her('Who checks them?');
    });
    await page.waitForTimeout(500);
    const nb = await page.evaluate(() => {
      const body = document.querySelector('#nb-body');
      const r = document.querySelector('#notebook').getBoundingClientRect();
      return {
        visible: getComputedStyle(body).visibility === 'visible' && r.height > 0,
        peek: getComputedStyle(document.querySelector('#nb-toggle')).display,
        share: r.height / innerHeight,
        why: document.querySelector('.nb-why').textContent,
        selected: document.querySelector('[role=tab][aria-selected=true]').id,
        oldLink: document.querySelector('#said-more'),
        note: document.querySelector('#nb-groups li')?.textContent ?? '',
      };
    });
    check(`[${tag}] the notebook is open without a tap (${Math.round(nb.share * 100)}% of the height), Notes first, the old "Show what she said" gone`, nb.visible && nb.peek === 'none' && nb.selected === 'tab-notes' && nb.oldLink === null && /kiosk at the depot/.test(nb.note) && (tag === 'desktop' || (nb.share > 0.3 && nb.share < 0.5)), JSON.stringify({ ...nb, why: undefined }));
    check(`[${tag}] its quiet line says what happens to what they say`, nb.why === 'Everything you say is analysed afterwards to build your AI and automation strategy and business plan.', nb.why);
    await page.click('#tab-transcript');
    await page.waitForTimeout(200);
    const lines = await page.evaluate(() => [...document.querySelectorAll('#transcript li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    check(`[${tag}] Transcript: the whole exchange in order, "Aida:" and "You:"`, lines.join(' | ') === 'Aida: Which tools do you use to track the hours your cleaners work? | You: A phone app with GPS, and a kiosk at the depot. | Aida: Who checks them?', lines.join(' | '));
    if (tag === 'phone') {
      // Many turns: it follows the newest; scrolled up, it stays where the person is reading.
      await page.evaluate(() => {
        for (let i = 0; i < 12; i++) {
          window.__ws.push({ serverContent: { outputTranscription: { text: `Question ${i}: and how does that part of the week go for your team?` } } });
          window.__ws.push({ serverContent: { inputTranscription: { text: `Answer ${i}: it mostly goes fine, apart from the Friday check.` } } });
        }
      });
      await page.waitForTimeout(500);
      const atEnd = await page.evaluate(() => { const p = document.querySelector('#nb-transcript'); return p.scrollHeight - p.scrollTop - p.clientHeight; });
      await page.screenshot({ path: `${shots}/r3-transcript-phone.png` });
      await page.waitForTimeout(900);
      await page.evaluate(() => { document.querySelector('#nb-transcript').scrollTop = 0; });
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__ws.push({ serverContent: { outputTranscription: { text: 'One more question for you.' } } }));
      await page.waitForTimeout(500);
      const kept = await page.evaluate(() => document.querySelector('#nb-transcript').scrollTop);
      check(`[${tag}] the transcript follows the newest line (${Math.round(atEnd)} px from the end), and stays put once they scroll up (${kept} px)`, atEnd < 24 && kept < 5, `${atEnd} / ${kept}`);
    }
    check(`[${tag}] no page errors in the notebook`, errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // A used or second-tab email link in a browser with a session: welcome back, not "One click to begin".
  {
    const known = { known: true, name: 'Sam Example', canContinue: true, minutesSoFar: 3, canStartNew: true };
    const { ctx, page } = await open(browser, { size: phone, goto: `/talk/?go=${GO}`, me: known });
    await page.waitForSelector('#known-card:not([hidden])');
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => ({ go: document.querySelector('#go-card').hidden, consent: document.querySelector('#consent-form').hidden, title: document.querySelector('#known-title').textContent, address: location.search }));
    check('?go= in a browser with a session: the welcome-back card, no "One click to begin", the token out of the address bar', s.go && s.consent && s.title === 'Welcome back, Sam' && s.address === '', JSON.stringify(s));
    await page.click('#known-forget');
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ go: !document.querySelector('#go-card').hidden, known: document.querySelector('#known-card').hidden }));
    check('...and "Not you?" then offers that link\'s own one-click card', after.go && after.known, JSON.stringify(after));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, { size: phone, goto: `/talk/?go=${GO}` });
    await page.waitForSelector('#go-card:not([hidden])', { timeout: 5000 });
    check('?go= with no session: "One click to begin", as before', await page.isVisible('#go-go'));
    await ctx.close();
  }

  // "Not you? Use a different email" clears what this tab kept.
  {
    const seed = `sessionStorage.setItem('aida:details', JSON.stringify({ name: 'Sam Example', role: 'Owner', company: 'Acme Cleaning', industry: 'Cleaning', email: '', phone: '', teamSize: '' })); sessionStorage.setItem('aida:consent', JSON.stringify({ consent: true }));`;
    const { ctx, page } = await open(browser, { size: phone, init: seed, me: { known: true, name: 'Sam Example', canContinue: true, canStartNew: true } });
    await page.waitForSelector('#known-card:not([hidden])');
    const was = await page.evaluate(() => ({ name: document.querySelector('#f-name').value, consent: document.querySelector('#consent').checked }));
    await page.click('#known-forget');
    await page.waitForTimeout(200);
    const now = await page.evaluate(() => ({ details: sessionStorage.getItem('aida:details'), consent: sessionStorage.getItem('aida:consent'), name: document.querySelector('#f-name').value, ticked: document.querySelector('#consent').checked, form: !document.querySelector('#consent-form').hidden }));
    check('"Not you?" clears the saved details and consent, and the form', was.name === 'Sam Example' && was.consent && now.details === null && now.consent === null && now.name === '' && !now.ticked && now.form, JSON.stringify({ was, now }));
    await ctx.close();
  }

  // The top Start without the tick, and field errors that clear when put right.
  for (const [size, tag] of [[phone, 'phone'], [desk, 'desktop']]) {
    const { ctx, page } = await open(browser, { size, init: NO_TURNSTILE });
    await page.click('#start-top');
    await page.waitForTimeout(300);
    const top = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, error: document.querySelector('#consent-error').hidden ? '' : document.querySelector('#consent-error').textContent }));
    check(`[${tag}] the top Start without the tick says what the bottom one says`, top.screen === 'intro' && top.error === 'Please tick the box to agree before you start.', JSON.stringify(top));
    await page.screenshot({ path: `${shots}/r3-top-start-${tag}.png` });
    await page.click('.check .box');
    await page.click('#start-top');
    await page.waitForSelector('#details:not([hidden])');
    check(`[${tag}] ...and with the tick, goes on to the form`, true);
    await page.click('#details-go');
    const shown = (f) => page.evaluate((x) => !document.querySelector(`#e-${x}`).hidden, f);
    const all = { team: await shown('teamSize'), email: await shown('email'), name: await shown('name') };
    await page.click('#team-sizes label:nth-child(2)');
    const team = await shown('teamSize');
    await page.fill('#f-email', 'sam@');
    const half = await shown('email');
    await page.fill('#f-email', ['sam', 'acme.example'].join('@'));
    const email = await shown('email');
    const name = await shown('name');
    check(`[${tag}] field errors clear as soon as the field is put right (team size, email), not before, and not the others`, all.team && all.email && all.name && !team && half && !email && name, JSON.stringify({ all, team, half, email, name }));
    await ctx.close();
  }

  // In the room: a double click on Type, and Back after the end screen.
  for (const [size, tag] of [[phone, 'phone'], [desk, 'desktop']]) {
    const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
    await intoRoom(page);
    await page.evaluate(() => window.__ws.push({ serverContent: { outputTranscription: { text: 'Hello, and thank you for your time.' } } }));
    await page.dblclick('#type');
    await page.waitForTimeout(250);
    const open1 = await page.evaluate(() => !document.querySelector('#typer').hidden);
    const width = await page.evaluate(() => ({ box: document.querySelector('#typed').getBoundingClientRect().width, column: document.querySelector('#captions').getBoundingClientRect().width }));
    await page.waitForTimeout(450);
    await page.click('#type');
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => document.querySelector('#typer').hidden);
    check(`[${tag}] a double click on Type opens the box and leaves it open; a later click closes it`, open1 && closed, JSON.stringify({ open1, closed }));
    check(`[${tag}] the answer box takes the caption column (${Math.round(width.box)} px of ${Math.round(width.column)} px)`, width.box > width.column * 0.75, JSON.stringify(width));
    await page.evaluate(() => window.__ws.push({ aida: { type: 'ended', reason: 'complete', minutes: 4 } }));
    await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
    await page.goBack();
    await page.waitForTimeout(500);
    const back1 = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, end: !document.querySelector('#end-screen').hidden }));
    await page.goBack();
    await page.waitForTimeout(500);
    const back2 = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, end: !document.querySelector('#end-screen').hidden, confirm: !document.querySelector('#confirm').hidden }));
    check(`[${tag}] Back after the end screen stays on the end screen, never a dead "Finished" room`, back1.screen === 'end' && back1.end && back2.screen === 'end' && back2.end && !back2.confirm, JSON.stringify({ back1, back2 }));
    await ctx.close();
  }
  await browser.close();
}

server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
