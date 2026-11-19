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
 *                                                                     3 reconnect, 4 busy card, 5 round 3,
 *                                                                     6 round 4, 7 layout, 8 strategy,
 *                                                                     9 review round 3; 9.<id> runs one)
 *
 * Needs a build (`npm run build`), Google Chrome and the `playwright` package (PLAYWRIGHT_MODULE if not importable).
 */
/* global window, document, getComputedStyle, history, innerHeight, innerWidth, location, matchMedia */
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
  // Everything under /strategy/ is the one page: production rewrites it that way.
  if (url.pathname.startsWith('/strategy/')) p = '/strategy/index.html';
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
async function open(browser, { size, perms = [], init = '', ws = 'ok', me = { known: false }, goto = '/talk/', routes = {}, hasTouch = false }) {
  const ctx = await browser.newContext({ viewport: size, permissions: perms, ...(hasTouch ? { hasTouch: true } : {}) });
  // Nothing leaves this machine: a request for any other host (the person check's script) is refused.
  await ctx.route((url) => url.host !== new URL(base).host, (r) => r.abort());
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
  /**
   * Opens a live call, drops its line, answers /continue with `replies` in turn (the last repeats). A reply is a
   * status (with the server's usual error code for it) or [status, error code].
   */
  async function dropped(tag, size, replies, { clock = false, mute = false } = {}) {
    const asked = [];
    const { ctx, page, errors } = await open(browser, {
      size,
      perms: ['microphone'],
      goto: `/talk/?go=${GO}`,
      routes: {
        '**/api/talk/continue': async (r) => {
          const reply = replies[Math.min(asked.length, replies.length - 1)];
          const [status, code] = Array.isArray(reply) ? reply : [reply];
          asked.push(status);
          const error = code ?? (status === 409 ? 'busy' : status === 401 ? 'no_session' : 'nothing_to_continue');
          await r.fulfill(status === 200 ? json(resumedBody) : json({ error }, status));
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
    const endState = (page) =>
      page.evaluate(() => ({
        title: document.querySelector('#end-title').textContent,
        lede: document.querySelector('#end-lede').textContent,
        choices: document.querySelector('#choices').hidden,
        actions: !document.querySelector('#end-actions').hidden,
        cont: !document.querySelector('#end-continue').hidden,
        label: document.querySelector('#end-continue .label').textContent,
        newConversation: document.querySelector('#end-new').hidden ? null : document.querySelector('#end-new').getAttribute('href'),
      }));
    if (tag === 'phone') {
      // 404: the server holds nothing to continue from, so the screen must not promise "your place is saved"
      // (UI review, 19 Nov): it says so and offers a new conversation instead of a Continue that would fail.
      const { ctx, page, asked } = await dropped(tag, size, [404]);
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      const end = await endState(page);
      check(`[${tag}] 404: the line-dropped end screen says nothing is saved and offers a new conversation, no Continue (asked ${asked.length} time)`, asked.length === 1 && end.title === 'The line dropped' && !/place is saved/.test(end.lede) && /nothing saved/.test(end.lede) && end.actions && !end.cont && end.newConversation === '/talk/' && end.choices, JSON.stringify(end));
      await page.screenshot({ path: `${shots}/review-end-dropped-${tag}.png`, fullPage: true });
      await ctx.close();
    }
    if (tag === 'phone') {
      // 404 for another reason (conversations switched off for now: { error: 'closed' }) says nothing about the
      // saved call: the line-dropped end screen keeps "your place is saved" and Continue (review, 19 Nov).
      const { ctx, page, asked } = await dropped(tag, size, [[404, 'closed']]);
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      const end = await endState(page);
      check(`[${tag}] 404 closed: the line-dropped end screen still says the place is saved, with Continue (asked ${asked.length} time)`, asked.length === 1 && end.title === 'The line dropped' && /place is saved/.test(end.lede) && end.cont && end.newConversation === null, JSON.stringify(end));
      await ctx.close();
    }
    if (tag === 'phone') {
      // 401: no cookie, but the call may well be saved: the line-dropped end screen with Continue, as before.
      const { ctx, page, asked } = await dropped(tag, size, [401]);
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      const end = await endState(page);
      check(`[${tag}] 401: the line-dropped end screen, with Continue (asked ${asked.length} time)`, asked.length === 1 && end.title === 'The line dropped' && /place is saved/.test(end.lede) && end.actions && end.cont && end.label === 'Continue' && end.newConversation === null && end.choices, JSON.stringify(end));
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
  // The smallest phone, light and dark (review, 19 Nov): beside her portrait "Start a new conversation" ran 21 px
  // past the edge of a 320 px screen. The page must not scroll sideways, and both buttons stay inside the gutters.
  for (const scheme of ['light', 'dark']) {
    for (const [w, h] of [[320, 568], [360, 740]]) {
      const { ctx, page } = await dropped('small', { width: w, height: h }, [404]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForSelector('#end-new:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
        buttons: [...document.querySelectorAll('#end-screen .btn')].filter((b) => b.checkVisibility()).map((b) => [Math.round(b.getBoundingClientRect().left), Math.round(b.getBoundingClientRect().right)]),
      }));
      check(`[${w} ${scheme}] nothing saved: no sideways scroll, "Start a new conversation" inside the screen`, m.scroll === m.width && m.buttons.length >= 1 && m.buttons.every(([l, r]) => l >= 15 && r <= m.width - 15), JSON.stringify(m));
      if (w === 320) await page.screenshot({ path: `${shots}/review-end-nothing-saved-320-${scheme}.png`, fullPage: true });
      await ctx.close();
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
  // Continue on the welcome-back card answered 404 (review, 19 Nov): only nothing_to_continue means nothing is
  // saved and hides it. A 404 for another reason (conversations switched off for now) keeps Continue and says
  // to try again, as the end screen does.
  for (const [code, kept] of [['closed', true], ['nothing_to_continue', false]]) {
    const { ctx, page } = await open(browser, {
      size: { width: 390, height: 844 },
      me: { known: true, name: 'Sam', canContinue: true, minutesSoFar: 3, canStartNew: true },
      routes: { '**/api/talk/continue': (r) => r.fulfill(json({ error: code }, 404)) },
    });
    await page.waitForSelector('#known-card:not([hidden])');
    await page.click('#known-continue');
    await page.waitForFunction(() => document.querySelector('#app').dataset.screen === 'intro' && !document.querySelector('#known-continue').disabled, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({ cont: !document.querySelector('#known-continue').hidden, start: !document.querySelector('#known-new').hidden, status: document.querySelector('#known-status').textContent }));
    const ok = kept ? m.cont && m.start && m.status === 'We could not open it just now. Please try again in a moment.' : !m.cont && m.start && m.status === 'There is nothing to continue. Start a new conversation.';
    check(`welcome-back Continue answered 404 ${code}: ${kept ? 'Continue stays, with "try again in a moment"' : 'Continue goes and says why, Start a new conversation stays'}`, ok, JSON.stringify(m));
    await ctx.close();
  }
  // At today's limit the card offers neither Continue nor Start, so the note on what video costs goes with them
  // (review, 19 Nov: it was left under no button at all). Beside a Continue it stays.
  for (const [me, noted] of [
    [{ known: true, name: 'Sam', canContinue: true, minutesSoFar: 6, canStartNew: false, reasonIfNot: 'daily_limit' }, false],
    [{ known: true, name: 'Sam', canContinue: true, minutesSoFar: 6, canStartNew: true }, true],
  ]) {
    const { ctx, page } = await open(browser, { size: { width: 390, height: 844 }, me });
    await page.waitForSelector('#known-card:not([hidden])');
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const note = document.querySelector('#known-card [data-note]');
      return { cont: !document.querySelector('#known-continue').hidden, start: !document.querySelector('#known-new').hidden, note: note.checkVisibility(), text: note.textContent };
    });
    const ok = noted ? m.cont && m.note && /MB a minute/.test(m.text) : !m.cont && !m.start && !m.note;
    check(`welcome-back card ${noted ? 'with Continue: the video data note is shown' : "at today's limit: no Continue, no Start, and no video data note"}`, ok, JSON.stringify(m));
    if (!noted) await page.screenshot({ path: `${shots}/review-welcome-limit-phone.png` });
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

// ---------- 6. round 4: transcription markers, the note highlight, the tabs ----------
if (want('6')) {
  const browser = await chrome(FAKE_MIC);
  const phone = { width: 390, height: 844 };
  const desk = { width: 1280, height: 800 };
  const intoRoom = async (page, avatar = false) => {
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await page.evaluate(([s, a]) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: a } }), [sections, avatar]);
    await page.waitForTimeout(300);
  };
  for (const [size, tag] of [[phone, 'phone'], [desk, 'desktop']]) {
    // A marker, unclosed, and split across two fragments: none may reach a caption, the transcript or the live region.
    {
      const { ctx, page, errors } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await intoRoom(page);
      await page.evaluate(() => {
        const send = (o) => window.__ws.push({ serverContent: o });
        send({ outputTranscription: { text: 'Tell me about the week.' } });
        send({ turnComplete: true });
        send({ outputTranscription: { text: '<no' } });
        send({ outputTranscription: { text: ' speech>' } });
        send({ turnComplete: true });
        send({ inputTranscription: { text: '<noise> We use a kiosk' } });
        send({ turnComplete: true });
      });
      await page.waitForTimeout(500);
      const seen = await page.evaluate(() => ({
        caption: document.querySelector('#said-aida').textContent,
        you: document.querySelector('#said-you').textContent,
        announce: document.querySelector('#announce').textContent,
        lines: [...document.querySelectorAll('#transcript li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      }));
      check(
        `[${tag}] transcription markers never reach a caption, the transcript or the live region (${seen.lines.length} transcript lines)`,
        seen.caption === 'Tell me about the week.' && seen.you === 'We use a kiosk' && seen.lines.length === 2 && !seen.lines.some((l) => l.includes('<')) && !seen.announce.includes('<'),
        JSON.stringify(seen),
      );
      check(`[${tag}] no page errors while the markers are filtered`, errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    // A fresh note's highlight is its own text span, covering every line and nothing else.
    {
      const note = 'Supervisors check every timesheet by hand on Friday afternoons before payroll, and missed clock-outs are the worst';
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}` });
      await intoRoom(page);
      await page.evaluate((text) => window.__ws.push({ aida: { type: 'note', section: 'workflows', text } }), note);
      await page.waitForTimeout(250);
      const hl = await page.evaluate(() => {
        const li = document.querySelector('#nb-groups li.fresh');
        const span = li?.querySelector('.note-text');
        const stamp = li?.querySelector('.note-time');
        if (!li || !span || !stamp) return { found: false };
        const lr = li.getBoundingClientRect();
        const cs = getComputedStyle(li);
        const lines = [...span.getClientRects()];
        const range = document.createRange();
        range.selectNodeContents(span);
        const text = [...range.getClientRects()];
        return {
          found: true,
          after: getComputedStyle(li, '::after').content,
          lines: lines.length,
          firstTop: lines[0].top,
          lastBottom: lines.at(-1).bottom,
          textTop: text[0].top,
          textBottom: text.at(-1).bottom,
          left: lines[0].left,
          stampRight: stamp.getBoundingClientRect().right,
          topGap: lines[0].top - (lr.top + parseFloat(cs.paddingTop)),
          bottomGap: lr.bottom - parseFloat(cs.paddingBottom) - lines.at(-1).bottom,
        };
      });
      const ok =
        hl.found &&
        hl.after === 'none' &&
        Math.abs(hl.firstTop - hl.textTop) < 1 &&
        Math.abs(hl.lastBottom - hl.textBottom) < 1 &&
        hl.left >= hl.stampRight - 1 &&
        hl.topGap < 12 &&
        hl.bottomGap < 12;
      check(`[${tag}] a fresh note's highlight is its text span (${hl.lines} line${hl.lines === 1 ? '' : 's'}), not a box below it`, ok, JSON.stringify(hl));
      await page.screenshot({ path: `${shots}/r4-note-fresh-${tag}.png` });
      await ctx.close();
    }
    // A fingertip: both tabs at least 44 px, on a coarse pointer at either width.
    {
      const { ctx, page } = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}`, hasTouch: true });
      await intoRoom(page);
      const tabs = await page.evaluate(() => {
        const h = (id) => document.querySelector(id).getBoundingClientRect().height;
        return { coarse: matchMedia('(pointer: coarse)').matches, notes: h('#tab-notes'), transcript: h('#tab-transcript') };
      });
      check(
        `[${tag} touch] Notes and Transcript are at least 44 px tall (${Math.round(tabs.notes)} / ${Math.round(tabs.transcript)} px)`,
        tabs.coarse && tabs.notes >= 44 && tabs.transcript >= 44 && tabs.notes <= 46 && tabs.transcript <= 46,
        JSON.stringify(tabs),
      );
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 7. layout: the room and the end screen on the screens people use (review, 19 Nov) ----------
if (want('7')) {
  const browser = await chrome(FAKE_MIC);
  /** A live call a few minutes in: her question, the person's answer, three notes. */
  const liveRoom = async (size, { routes = {}, colorScheme } = {}) => {
    const opened = await open(browser, { size, perms: ['microphone'], goto: `/talk/?go=${GO}`, routes });
    const { page } = opened;
    if (colorScheme) await page.emulateMedia({ colorScheme });
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await page.evaluate((s) => {
      const ws = window.__ws;
      ws.push({ aida: { type: 'ready', targetMinutes: 20, sections: s, avatar: false } });
      ws.push({ serverContent: { outputTranscription: { text: 'Walk me through a normal week, from the rota to people being paid. What goes wrong most often?' } } });
      ws.push({ serverContent: { turnComplete: true } });
      ws.push({ serverContent: { inputTranscription: { text: 'Hours come out of the app, I check them against the rota, then type them into payroll.' } } });
      const notes = [['org', 'Office cleaning, about forty staff across two sites'], ['tools', 'Rotas kept in spreadsheets, one per site'], ['workflows', 'Hours are re-typed into payroll every week']];
      for (const [section, text] of notes) ws.push({ aida: { type: 'note', section, text } });
    }, sections);
    await page.waitForTimeout(800);
    return opened;
  };
  // Every font size (and line height) on the page doubled: how a phone's text scaling at 200% lays the page out.
  const DOUBLE = () => {
    const els = [...document.querySelectorAll('body *')];
    const sizes = els.map((e) => [parseFloat(getComputedStyle(e).fontSize), getComputedStyle(e).lineHeight]);
    els.forEach((e, i) => {
      const [fs, lh] = sizes[i];
      e.style.fontSize = `${fs * 2}px`;
      if (lh.endsWith('px')) e.style.lineHeight = `${parseFloat(lh) * 2}px`;
    });
  };

  // A caption that gives way shows whole lines (QA, 18 Oct; review, 19 Nov): at its newest words its top line
  // was cut through its letters under the label (2.57 lines of hers at 1024 x 576). Up to 15% of a line hidden is
  // only the space above the letters.
  const WHOLE_LINES = (id) => {
    const e = document.getElementById(id);
    const lh = parseFloat(getComputedStyle(e).lineHeight);
    const part = e.getBoundingClientRect().height % lh;
    return e.scrollHeight - e.clientHeight <= 1 || part <= 1 || lh - part <= 0.15 * lh;
  };

  // Text at 200% on a narrow phone: the room's four buttons were wider than the screen and the room's overflow cut
  // "Mute" and "End" in half; the end screen scrolled sideways by 22 px. The notes stay within reach (review,
  // 19 Nov): on a tall phone the open notebook went to 0 px with no strip, its tabs "whole" inside a box of nothing.
  // Either the open notebook shows 90 px of notes, or the strip is offered and opens them as a sheet.
  const notesInReach = () => {
    const nb = document.getElementById('notebook').getBoundingClientRect();
    const notes = document.getElementById('nb-notes').getBoundingClientRect();
    return {
      notes: Math.round(Math.max(0, Math.min(notes.bottom, nb.bottom, innerHeight) - Math.max(notes.top, nb.top, 0))),
      strip: document.getElementById('nb-toggle').checkVisibility(),
    };
  };
  for (const [w, h] of [[320, 740], [360, 740], [390, 844]]) {
    {
      const { ctx, page } = await liveRoom({ width: w, height: h });
      await page.evaluate(DOUBLE);
      await page.waitForTimeout(300);
      const m = await page.evaluate((reach) => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
        cut: [...document.querySelectorAll('.controls .ctl, .nb-tab')].filter((e) => e.checkVisibility()).filter((e) => e.getBoundingClientRect().left < -0.5 || e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.id),
        ...new Function(`return (${reach})`)()(),
      }), notesInReach.toString());
      let sheet = null;
      if (m.strip) {
        await page.click('#nb-toggle');
        await page.waitForTimeout(600);
        sheet = await page.evaluate(() => {
          const notes = document.getElementById('nb-notes').getBoundingClientRect();
          const tabs = [...document.querySelectorAll('.nb-tab')].map((e) => e.getBoundingClientRect());
          return { notes: Math.round(Math.min(notes.bottom, innerHeight) - Math.max(notes.top, 0)), tabs: tabs.every((t) => t.top >= 0 && t.bottom <= innerHeight && t.left >= -0.5 && t.right <= innerWidth + 0.5) };
        });
      }
      const reach = m.strip ? sheet.notes >= 90 && sheet.tabs : m.notes >= 90;
      check(`[${w}x${h}, text x2] the call's buttons and the notebook's tabs are whole on screen, no sideways scroll, and the notes within reach (90 px open, or the strip and its sheet)`, m.cut.length === 0 && m.scroll === m.width && reach, JSON.stringify({ ...m, sheet }));
      await page.screenshot({ path: `${shots}/layout-room-text2x-${w}${sheet ? '-sheet' : ''}.png` });
      await ctx.close();
    }
    {
      const { ctx, page } = await liveRoom({ width: w, height: h });
      await page.evaluate(() => window.__ws.push({ aida: { type: 'ended', reason: 'complete', minutes: 3 } }));
      await page.waitForSelector('#end-screen:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(400);
      await page.evaluate(DOUBLE);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
      check(`[${w}, text x2] the end screen does not scroll sideways`, m.scroll === m.width, JSON.stringify(m));
      await ctx.close();
    }
  }

  // At normal text size the four buttons share one row on every phone width (integration, 19 Nov): with the row
  // free to wrap, End went to a row of its own from 320 to 346 px and took 80 px from the captions; under 320 px
  // (a folding phone's 280 px cover screen) too (review, 19 Nov). Muted as well ("Unmute" is the longest label),
  // with no button over the next and no label wider than its button.
  const ctlRow = () => {
    const btns = [...document.querySelectorAll('.controls .ctl')].filter((e) => e.checkVisibility());
    const boxes = btns.map((e) => e.getBoundingClientRect());
    return {
      rows: new Set(boxes.map((b) => Math.round(b.top))).size,
      buttons: btns.length,
      cut: btns.filter((e) => e.getBoundingClientRect().left < -0.5 || e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.id),
      overlap: boxes.some((b, i) => i > 0 && Math.round(b.top) === Math.round(boxes[i - 1].top) && b.left < boxes[i - 1].right - 0.5),
      spill: btns.filter((e) => {
        const label = e.querySelector('.ctl-label');
        const l = label.getBoundingClientRect();
        const b = e.getBoundingClientRect();
        return label.scrollWidth > label.clientWidth + 1 || l.left < b.left - 0.5 || l.right > b.right + 0.5;
      }).map((e) => e.id),
      scroll: document.documentElement.scrollWidth - innerWidth,
    };
  };
  for (const w of [280, 300, 320, 340, 346, 360, 375, 390, 414, 480, 540]) {
    const { ctx, page } = await liveRoom({ width: w, height: 640 });
    const m = await page.evaluate(ctlRow);
    await page.click('#mute');
    await page.waitForTimeout(150);
    const muted = await page.evaluate(ctlRow);
    const fits = (r) => r.buttons === 4 && r.rows === 1 && r.cut.length === 0 && !r.overlap && r.spill.length === 0 && r.scroll <= 0;
    check(`[${w}x640] at normal text size Mute (and Unmute), Type, Continue later and End share one row, all on screen, none over the next`, fits(m) && fits(muted), JSON.stringify({ m, muted }));
    if (w === 320 || w === 280) await page.screenshot({ path: `${shots}/layout-room-row-${w}.png` });
    await ctx.close();
  }

  // "Still there?" on a desk (review, 19 Nov): someone slowly typing a long answer sends nothing, so the idle card
  // comes. In the typing box's row it covered the focused box and its Send; over the captions it cut the person's
  // words. It has a row of its own: no overlap with the typing box or the person's caption, End in view.
  for (const [w, h] of [[1000, 700], [1280, 800], [1440, 900]]) {
    for (const typing of [true, false]) {
      const { ctx, page } = await liveRoom({ width: w, height: h });
      if (typing) {
        await page.click('#type');
        await page.keyboard.type('We use three spreadsheets and');
      }
      await page.evaluate(() => window.__ws.push({ aida: { type: 'idle_warning', secondsLeft: 30 } }));
      await page.waitForSelector('#idle:not([hidden])');
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const meets = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const idle = box('idle');
        const typer = document.getElementById('typer');
        const send = typer.querySelector('button').getBoundingClientRect();
        const onTop = document.elementFromPoint(send.x + send.width / 2, send.y + send.height / 2);
        const end = box('end');
        return {
          overTyper: !typer.hidden && meets(idle, typer.getBoundingClientRect()),
          overYou: document.getElementById('said-you').checkVisibility() && meets(idle, box('said-you')),
          sendClear: typer.hidden || typer.querySelector('button').contains(onTop),
          focus: document.activeElement?.id ?? '',
          inView: idle.top >= 0 && idle.bottom <= innerHeight && end.bottom <= innerHeight,
        };
      });
      const ok = !m.overTyper && !m.overYou && m.sendClear && m.inView && (!typing || m.focus === 'typed');
      check(`[${w}x${h}${typing ? ', typing' : ''}] the idle card covers neither the typing box (nor its Send) nor the person's words; End in view`, ok, JSON.stringify(m));
      if (w === 1280 && typing) await page.screenshot({ path: `${shots}/layout-idle-typing-${w}.png` });
      await ctx.close();
    }
  }

  // A short desk window (review, 19 Nov): at 1024 x 576 (1280 x 720 at 125%) her window was 70-88 px with
  // "Listening" cut to "Liste" across her face, and next to nothing with the typing box open. Her window keeps
  // 120 px, her status tag is whole and inside it, both captions end inside their box, and End is in view.
  for (const [w, h] of [[1000, 560], [1024, 576], [1366, 657], [1280, 690]]) {
    for (const state of ['voice', 'typing', 'typing+idle']) {
      const { ctx, page } = await liveRoom({ width: w, height: h });
      if (state !== 'voice') await page.click('#type');
      if (state === 'typing+idle') {
        await page.evaluate(() => window.__ws.push({ aida: { type: 'idle_warning', secondsLeft: 30 } }));
        await page.waitForSelector('#idle:not([hidden])');
      }
      await page.waitForTimeout(400);
      const m = await page.evaluate((wholeLines) => {
        const whole = new Function(`return (${wholeLines})`)();
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const stage = box('stage');
        const tag = box('status');
        const text = document.getElementById('status-text');
        const captions = box('captions');
        const lines = ['line-aida', 'line-you'].filter((id) => document.getElementById(id).checkVisibility());
        return {
          stage: Math.round(stage.width),
          tag: text.textContent,
          tagWhole: tag.right <= stage.right - 2 && tag.bottom <= stage.bottom && text.scrollWidth <= text.clientWidth + 1,
          captionsWhole: lines.length > 0 && lines.every((id) => box(id).bottom <= captions.bottom + 1),
          wholeLines: ['said-aida', 'said-you'].filter((id) => document.getElementById(id).checkVisibility()).every(whole),
          endInView: box('end').bottom <= innerHeight,
          scroll: document.documentElement.scrollWidth - innerWidth,
        };
      }, WHOLE_LINES.toString());
      check(`[${w}x${h}, ${state}] her window ${m.stage} px (at least 120), "${m.tag}" whole inside it, the captions not cut and in whole lines, End in view`, m.stage >= 120 && m.tagWhole && m.captionsWhole && m.wholeLines && m.endInView && m.scroll === 0, JSON.stringify(m));
      if (w === 1024) await page.screenshot({ path: `${shots}/layout-short-${w}x${h}-${state.replace('+', '-')}.png` });
      await ctx.close();
    }
  }

  // Long captions on every kind of screen (QA, 18 Nov): the person's caption was cut under the controls at
  // 1280 x 800. Both end inside the captions box, theirs at least a line tall, each showing its newest words.
  const LONG_YOU = ' Mostly it is the Friday check, because I have to look at every timesheet myself and then type it all in again.';
  const LONG_HER = 'Let me read back what I have so far, and you tell me if I have any of it wrong. You run office cleaning with about forty people on two sites, the leads build the rotas, and everything waits for you on Friday, which means that when you are away, nobody gets paid on time.';
  for (const [w, h, typing] of [[1280, 800], [1366, 768], [1440, 900], [1000, 700], [1280, 800, true], [1024, 576, true], [390, 844], [844, 390], [640, 400], [640, 400, true], [320, 568], [320, 568, true]]) {
    const { ctx, page } = await liveRoom({ width: w, height: h });
    if (typing) await page.click('#type');
    await page.evaluate(([you, her]) => {
      const ws = window.__ws;
      ws.push({ serverContent: { inputTranscription: { text: you } } });
      ws.push({ serverContent: { turnComplete: true } });
      for (const word of her.split(' ')) ws.push({ serverContent: { outputTranscription: { text: ` ${word}` } } });
    }, [LONG_YOU, LONG_HER]);
    await page.waitForTimeout(900);
    const m = await page.evaluate((wholeLines) => {
      const whole = new Function(`return (${wholeLines})`)();
      const captions = document.getElementById('captions').getBoundingClientRect();
      const tail = (e) => Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) <= 2;
      const you = document.getElementById('said-you');
      const her = document.getElementById('said-aida');
      return {
        youInside: document.getElementById('line-you').getBoundingClientRect().bottom <= captions.bottom + 1,
        youLine: you.getBoundingClientRect().height >= parseFloat(getComputedStyle(you).lineHeight) - 1,
        newest: tail(you) && tail(her),
        wholeLines: whole('said-aida') && whole('said-you'),
        endInView: document.getElementById('end').getBoundingClientRect().bottom <= innerHeight,
      };
    }, WHOLE_LINES.toString());
    check(`[${w}x${h}${typing ? ', typing' : ''}] long captions: theirs ends inside the captions box, a line or more tall, both showing their newest words in whole lines`, m.youInside && m.youLine && m.newest && m.wholeLines && m.endInView, JSON.stringify(m));
    await ctx.close();
  }

  // A caption's focus ring (review, 19 Nov): the captions box clips its paint, and on a phone the ring round "Your
  // words" lost its bottom edge (on a desk, its sides too). Each caption, focused from the keyboard, has its whole
  // ring inside the box.
  for (const [w, h, idleTyping] of [[390, 844], [320, 568], [280, 640], [1280, 800], [1366, 768], [1024, 576, true], [844, 390]]) {
    const { ctx, page } = await liveRoom({ width: w, height: h });
    if (idleTyping) {
      await page.click('#type');
      await page.evaluate(() => window.__ws.push({ aida: { type: 'idle_warning', secondsLeft: 30 } }));
      await page.waitForSelector('#idle:not([hidden])');
    }
    await page.waitForTimeout(300);
    for (const id of ['said-aida', 'said-you']) {
      await page.focus(`#${id}`);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const m = await page.evaluate(() => {
        const e = document.activeElement;
        const cs = getComputedStyle(e);
        const grow = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
        const r = e.getBoundingClientRect();
        const c = document.getElementById('captions').getBoundingClientRect();
        const ring = { top: r.top - grow, bottom: r.bottom + grow, left: r.left - grow, right: r.right + grow };
        const out = Object.fromEntries(Object.entries({ top: c.top - ring.top, bottom: ring.bottom - c.bottom, left: c.left - ring.left, right: ring.right - c.right }).filter(([, v]) => v > 0.5).map(([k, v]) => [k, Math.round(v * 10) / 10]));
        return { focus: e.id, ring: e.matches(':focus-visible') && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2, cut: out };
      });
      check(`[${w}x${h}${idleTyping ? ', typing, idle card' : ''}] ${id} focused from the keyboard: its whole focus ring is inside the captions box`, m.focus === id && m.ring && Object.keys(m.cut).length === 0, JSON.stringify(m));
      if (id === 'said-you' && w === 390) await page.screenshot({ path: `${shots}/layout-caption-focus-${w}.png` });
    }
    await ctx.close();
  }

  // A phone on its side, or a laptop at 200% (QA, 18 Nov): the room was held at 560 px and Mute and End sat below
  // the fold. Both are on screen without scrolling.
  for (const [w, h] of [[844, 390], [667, 375], [740, 360], [640, 400]]) {
    const { ctx, page } = await liveRoom({ width: w, height: h });
    const m = await page.evaluate(() => ({ mute: document.getElementById('mute').getBoundingClientRect().bottom, end: document.getElementById('end').getBoundingClientRect().bottom, height: innerHeight }));
    check(`[${w}x${h}] Mute and End are on screen without scrolling`, m.mute <= m.height && m.end <= m.height, JSON.stringify(m));
    await ctx.close();
  }

  // Small phones (QA, 18 Nov): at 320 x 568 and 360 x 640 the open notebook was a 12-52 px sliver. A short phone
  // keeps the strip that opens the notes; a phone with the height keeps the open notebook. End is on screen and
  // the stage count ("4 of 7") whole either way.
  for (const [w, h] of [[320, 568], [360, 640], [375, 667], [390, 844]]) {
    const { ctx, page } = await liveRoom({ width: w, height: h });
    const m = await page.evaluate(() => {
      const count = document.getElementById('stage-count');
      return {
        notes: Math.round(document.getElementById('nb-notes').getBoundingClientRect().height),
        strip: document.getElementById('nb-toggle').checkVisibility(),
        endInView: document.getElementById('end').getBoundingClientRect().bottom <= innerHeight,
        countWhole: count.getBoundingClientRect().right <= count.parentElement.getBoundingClientRect().right + 0.5,
      };
    });
    const ok = h < 661 ? (m.strip || m.notes >= 100) && m.endInView && m.countWhole : !m.strip && m.notes >= 90 && m.endInView && m.countWhole;
    check(`[${w}x${h}] ${h < 661 ? 'the notes strip (or notes of 100 px or more)' : 'the open notebook'}, End on screen, the stage count whole`, ok, JSON.stringify(m));
    await ctx.close();
  }

  // The details form's one message (QA, 18 Nov): on a phone it sat a screen above Continue, and focus fell to the
  // page while the button was disabled. A 429, a 500 and a dropped connection bring it into view and focus it; a
  // refusal about one field leaves focus on that field.
  const NO_TURNSTILE = "window.turnstile = { render: (c, o) => { window.__o = o; return 'w'; }, execute: () => setTimeout(() => window.__o.callback('t'), 20), reset: () => {} };";
  const refusals = {
    429: (r) => r.fulfill(json({ error: 'too_many', retryAfter: 300 }, 429)),
    500: (r) => r.fulfill(json({ error: 'unavailable' }, 500)),
    'a dropped connection': (r) => r.abort('connectionreset'),
    '422 on the email': (r) => r.fulfill(json({ error: 'work_email', field: 'email' }, 422)),
  };
  for (const [name, reply] of Object.entries(refusals)) {
    for (const [w, h] of [[390, 844], [360, 740]]) {
      const { ctx, page } = await open(browser, { size: { width: w, height: h }, init: NO_TURNSTILE, routes: { '**/api/talk/start': reply } });
      await page.click('.check .box');
      await page.click('#start-top');
      await page.waitForSelector('#details:not([hidden])');
      for (const [id, value] of [['#f-name', 'Sam Example'], ['#f-role', 'Owner'], ['#f-company', 'Acme Cleaning'], ['#f-industry', 'Commercial cleaning'], ['#f-email', ['sam', 'acme.example'].join('@')]]) await page.fill(id, value);
      await page.click('#team-sizes label:nth-child(3)');
      await page.locator('#details-go').scrollIntoViewIfNeeded();
      await page.click('#details-go');
      await page.waitForTimeout(1000);
      const m = await page.evaluate(() => {
        const alert = document.getElementById('form-alert');
        const box = alert.getBoundingClientRect();
        return { inView: !alert.hidden && box.top >= 0 && box.bottom <= innerHeight, focus: document.activeElement?.id ?? '' };
      });
      const ok = name.startsWith('422') ? m.focus === 'f-email' : m.inView && m.focus === 'form-alert';
      check(`[${w}x${h}] details form, ${name}: ${name.startsWith('422') ? 'focus on the email field' : 'the message is in view and focused'}`, ok, JSON.stringify(m));
      await ctx.close();
    }
  }
  await browser.close();
}

// ---------- 8. the strategy page: signing out (review, 19 Nov) ----------
if (want('8')) {
  const browser = await chrome();
  const view = {
    company: 'Acme Cleaning (fictional)',
    firstName: 'Sam',
    publishedAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    contact: ['sam', 'acme.example'].join('@'),
    deck: {
      title: 'AI and automation strategy for Acme Cleaning (fictional)',
      company: 'Acme Cleaning (fictional)',
      dateLabel: '20 October 2026',
      heard: { business: 'Acme Cleaning (fictional) cleans forty offices.', today: ['Two supervisors check every timesheet by hand.'], crux: 'Every approval waits on two supervisors.' },
      swot: { strengths: ['A loyal team'], weaknesses: ['Rotas in three spreadsheets'], opportunities: ['Automate the approval list'], threats: ['Rising wages'] },
      plays: [{ name: 'Friday approvals on one screen', whatWeWouldBuild: 'One approval list.', whatChangesForYou: 'Payroll starts on Friday.', firstStep: 'Map the spreadsheets.', evidence: 'Every approval waits on two supervisors.' }],
      roadmap: [{ when: 'First 30 days', items: ['Map the spreadsheets'] }],
      nextStep: 'Reply with a time next week.',
      speaker: 'Aida',
    },
  };
  // Signing out leaves the sign-in screen as a fresh visit would: the page's own title, the strategy gone from the
  // page (not only hidden), and focus on the sign-in heading, so a screen reader hears where it is.
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    let signedOut = false;
    const { ctx, page } = await open(browser, {
      size: { width: w, height: h },
      goto: `/strategy/${'a'.repeat(43)}`,
      routes: {
        '**/api/strategy/view**': (r) => r.fulfill(signedOut ? json({ need: 'email', hint: 's***@acme.example' }, 401) : json(view)),
        '**/api/strategy/signout**': (r) => {
          signedOut = true;
          return r.fulfill(json({ ok: true }));
        },
      },
    });
    await page.waitForSelector('#view:not([hidden])', { timeout: 10000 });
    const before = await page.evaluate(() => document.getElementById('strategy').children.length);
    await page.click('#signout');
    await page.waitForSelector('#sign-in:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({ title: document.title, strategy: document.getElementById('strategy').children.length, focus: document.activeElement?.id ?? '' }));
    check(`[${w}x${h}] strategy sign out: the base title, the strategy emptied (${before} parts before), focus on the sign-in heading`, before > 0 && m.title === 'Your AI and automation strategy — Aida' && m.strategy === 0 && m.focus === 'signin-title', JSON.stringify(m));
    await ctx.close();
  }
  await browser.close();
}

// ---------- 9. review round 3 (19 Nov): her voice after the switch, End mid-move, Back and Forward ----------
// `--only 9` runs them all; `--only 9.<finding>` (9.01, 9.20, ...) runs one.
const want9 = (id) => want('9') || want(`9.${id}`);
const PHONE = { width: 390, height: 844 };
const NO_MIC = "navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));";
/** Counts the chunks of her voice the page starts playing. */
const COUNT_VOICE = 'const s = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function (...a) { window.__starts = (window.__starts ?? 0) + 1; return s.apply(this, a); };';
/** 100 ms of her (silent) voice, as the server sends it. */
const VOICE_FRAME = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] } } };
const continued = { id: 's1', targetMinutes: 5, sections, name: 'Sam', resumed: { minutesSoFar: 1, stage: 'org', hasSummary: false, notes: [] } };
const ready = (page, avatar, resumed) => page.evaluate(([s, a, r]) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: a, ...(r ? { resumed: r } : {}) } }), [sections, avatar, resumed ?? null]);

if (want9('01')) {
  // The voice-only switch closed both audio contexts; a person typing their answers never tapped again, so her
  // voice on the new line was dropped.
  const browser = await chrome();
  const { ctx, page, errors } = await open(browser, { size: PHONE, goto: `/talk/?go=${GO}`, init: NO_MIC + COUNT_VOICE, routes: { '**/api/talk/continue': (r) => r.fulfill(json(continued)) } });
  await page.click('#go-go');
  await page.waitForSelector('#mic-actions:not([hidden])');
  await page.click('#mic-type');
  await page.waitForFunction(() => window.__ws);
  await ready(page, true);
  await page.waitForSelector('#voice-only:not([hidden])');
  await page.click('#voice-only');
  await page.waitForFunction(() => (window.__sockets ?? 0) >= 2, null, { timeout: 10000 });
  await ready(page, false, continued.resumed);
  await page.evaluate((f) => window.__ws.push(f), VOICE_FRAME);
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => ({ starts: window.__starts ?? 0, screen: document.querySelector('#app').dataset.screen }));
  check('typing, then Switch to voice only: her voice on the new line plays without another tap', m.starts > 0 && m.screen === 'room', JSON.stringify(m));
  check('...and no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
  await browser.close();
}

if (want9('20')) {
  // End pressed while there is no line to end. During the voice-only switch it waited 25 s on "Wrapping up"; while
  // the way back after a drop waited for the microphone, it was undone and a new line opened.
  const browser = await chrome(FAKE_MIC);
  {
    const { ctx, page } = await open(browser, {
      size: PHONE,
      goto: `/talk/?go=${GO}`,
      routes: { '**/api/talk/continue': async (r) => { await new Promise((d) => setTimeout(d, 3000)); await r.fulfill(json(continued)).catch(() => undefined); } },
    });
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await ready(page, true);
    await page.waitForSelector('#voice-only:not([hidden])');
    await page.click('#voice-only');
    await page.waitForTimeout(300);
    await page.click('#end');
    await page.click('#confirm-yes');
    const t0 = Date.now();
    const shown = await page.waitForSelector('#end-screen:not([hidden])', { timeout: 2500 }).then(() => Date.now() - t0, () => null);
    await page.waitForTimeout(3500); // past the delayed /continue
    const m = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, sockets: window.__sockets }));
    check('End during the voice-only switch: the end screen at once, and no new line after it', shown !== null && m.screen === 'end' && m.sockets === 1, JSON.stringify({ shownAfterMs: shown, ...m }));
    await ctx.close();
  }
  {
    // The second microphone question (the way back after the drop) takes 1.5 s to answer.
    const slowMic = 'const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); let n = 0; navigator.mediaDevices.getUserMedia = (c) => (++n === 1 ? g(c) : new Promise((d) => setTimeout(d, 1500)).then(() => g(c)));';
    let asked = 0;
    const { ctx, page } = await open(browser, {
      size: PHONE,
      perms: ['microphone'],
      goto: `/talk/?go=${GO}`,
      init: slowMic,
      routes: { '**/api/talk/continue': (r) => { asked++; return r.fulfill(json(continued)); } },
    });
    await page.click('#go-go');
    await page.waitForFunction(() => window.__ws);
    await ready(page, false);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__ws.drop());
    for (let i = 0; i < 40 && !asked; i++) await page.waitForTimeout(50);
    await page.waitForTimeout(200);
    await page.click('#end');
    await page.click('#confirm-yes');
    await page.waitForTimeout(3000);
    const m = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, sockets: window.__sockets, live: (window.__streams ?? []).filter((s) => s.getAudioTracks().some((t) => t.readyState === 'live')).length }));
    check(`End while the way back waits for the microphone: the end screen, no second line, the microphone off (asked ${asked})`, asked === 1 && m.screen === 'end' && m.sockets === 1 && m.live === 0, JSON.stringify(m));
    await ctx.close();
  }
  await browser.close();
}

if (want9('02')) {
  // After one reconnect that worked, a later call on the same page whose line never opened was taken for a drop:
  // silent /continue requests and "The line dropped", not "The line did not open" with Try again.
  const browser = await chrome(FAKE_MIC);
  const { ctx, page } = await open(browser, { size: PHONE, perms: ['microphone'], goto: `/talk/?go=${GO}`, routes: { '**/api/talk/continue': (r) => r.fulfill(json(continued)) } });
  await page.click('#go-go');
  await page.waitForFunction(() => window.__ws);
  await ready(page, false);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ws.drop());
  await page.waitForFunction(() => window.__sockets >= 2, null, { timeout: 10000 });
  await ready(page, false, continued.resumed);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ws.push({ aida: { type: 'ended', reason: 'idle', minutes: 2, resumable: true } }));
  await page.waitForSelector('#end-continue:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.click('#end-continue');
  await page.waitForFunction(() => window.__sockets >= 3, null, { timeout: 10000 });
  await page.evaluate(() => window.__ws.drop()); // closes before `ready`
  await page.waitForTimeout(2000);
  const m = await page.evaluate(() => ({ screen: document.querySelector('#app').dataset.screen, title: document.querySelector('#mic-title').textContent, sockets: window.__sockets }));
  check('a later call whose line never opens, after a reconnect earlier on the page: "The line did not open", not a drop', m.screen === 'mic' && m.title === 'The line did not open' && m.sockets === 3, JSON.stringify(m));
  await ctx.close();
  await browser.close();
}

/** Back or Forward, and a moment for the page to answer it. */
const travel = async (page, way) => {
  await page.evaluate((w) => (w === 'back' ? history.back() : history.forward()), way);
  await page.waitForTimeout(500);
  return page.evaluate(() => document.querySelector('#app').dataset.screen);
};

if (want9('34')) {
  // The first screen had no history entry of its own: Back from the details form pushed a new one, wasting a press
  // and throwing Forward away.
  const browser = await chrome();
  const { ctx, page } = await open(browser, { size: PHONE });
  await page.click('.check .box');
  await page.click('#start-top');
  await page.waitForSelector('#details:not([hidden])');
  const back = await travel(page, 'back');
  const forward = await travel(page, 'forward');
  const length = await page.evaluate(() => history.length);
  check('consent, details, Back shows the first screen and Forward the details again', back === 'intro' && forward === 'details', JSON.stringify({ back, forward, length }));
  await ctx.close();
  await browser.close();
}

if (want9('35')) {
  // "The line did not open" sat on top of the room's history entry: Back led into a dead room with no line.
  const browser = await chrome(FAKE_MIC);
  const { ctx, page } = await open(browser, { size: PHONE, perms: ['microphone'], ws: 'close', goto: `/talk/?go=${GO}` });
  await page.click('#go-go');
  await page.waitForFunction(() => document.querySelector('#app').dataset.screen === 'mic' && !document.querySelector('#mic-actions').hidden, null, { timeout: 8000 });
  const back = await travel(page, 'back');
  const room = await page.evaluate(() => !document.querySelector('#room').hidden);
  check('the line did not open, then Back: not the dead room', back !== 'room' && !room, JSON.stringify({ back, room }));
  await ctx.close();
  await browser.close();
}

if (want9('55')) {
  // "Opening your conversation…" kept its history entry after the request failed: Back showed the spinner with no
  // buttons at all.
  const browser = await chrome();
  for (const [how, opts, press] of [
    ['the email link (/confirm 500)', { goto: `/talk/?go=${GO}`, routes: { '**/api/talk/confirm': (r) => r.fulfill(json({ error: 'unavailable' }, 500)) } }, '#go-go'],
    ['Continue on the welcome-back card (/continue 500)', { me: { known: true, name: 'Sam', canContinue: true, minutesSoFar: 3, canStartNew: true }, routes: { '**/api/talk/continue': (r) => r.fulfill(json({ error: 'unavailable' }, 500)) } }, '#known-continue'],
  ]) {
    const { ctx, page } = await open(browser, { size: PHONE, ...opts });
    await page.waitForSelector(`${press}:not([hidden])`);
    await page.click(press);
    await page.waitForFunction((b) => document.querySelector('#app').dataset.screen === 'intro' && !document.querySelector(b).disabled, press, { timeout: 8000 });
    const back = await travel(page, 'back');
    check(`${how} failed, then Back: not the empty "Opening your conversation…" screen`, back !== 'mic', JSON.stringify({ back }));
    await ctx.close();
  }
  await browser.close();
}

if (want9('52')) {
  // Back while "Continue later?" was open showed the End question beside it: two questions at once.
  const browser = await chrome(FAKE_MIC);
  const { ctx, page } = await open(browser, { size: PHONE, perms: ['microphone'], goto: `/talk/?go=${GO}` });
  await page.click('#go-go');
  await page.waitForFunction(() => window.__ws);
  await ready(page, false);
  await page.waitForTimeout(300);
  await page.click('#later');
  await page.waitForSelector('#confirm-later:not([hidden])');
  await travel(page, 'back');
  const m = await page.evaluate(() => ({ end: !document.querySelector('#confirm').hidden, later: !document.querySelector('#confirm-later').hidden, screen: document.querySelector('#app').dataset.screen }));
  check('"Continue later?" open, then Back: one question on screen, not two', m.screen === 'room' && m.end !== m.later, JSON.stringify(m));
  await ctx.close();
  await browser.close();
}

if (want9('43')) {
  // The team size was never kept for the trip to the privacy page: it was saved only if another field was typed in
  // afterwards, and never put back.
  const browser = await chrome();
  const { ctx, page } = await open(browser, { size: PHONE });
  await page.click('.check .box');
  await page.click('#start-top');
  await page.waitForSelector('#details:not([hidden])');
  await page.fill('#f-name', 'Sam Example');
  await page.click('#team-sizes label:nth-child(3)');
  await page.reload();
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => ({ size: document.querySelector('#team-sizes input:checked')?.id ?? null, name: document.querySelector('#f-name').value }));
  check('a team size picked, then the page reloaded (as after the privacy page): still picked', m.size === 'f-teamSize-2' && m.name === 'Sam Example', JSON.stringify(m));
  await ctx.close();
  await browser.close();
}

if (want9('44')) {
  // Nothing to continue: Continue went, but its voice-only twin stayed (and repeated the same 404), and the reason
  // was never shown.
  const browser = await chrome();
  for (const press of ['#known-continue', '#known-voice']) {
    let asked = 0;
    const { ctx, page } = await open(browser, {
      size: PHONE,
      me: { known: true, name: 'Sam', canContinue: true, minutesSoFar: 3, canStartNew: true },
      routes: { '**/api/talk/continue': (r) => { asked++; return r.fulfill(json({ error: 'nothing_to_continue' }, 404)); } },
    });
    await page.waitForSelector(`${press}:not([hidden])`);
    await page.click(press);
    await page.waitForFunction(() => document.querySelector('#app').dataset.screen === 'intro' && !document.querySelector('#known-new').disabled, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({
      cont: !document.querySelector('#known-continue').hidden,
      voice: !document.querySelector('#known-voice').hidden,
      start: !document.querySelector('#known-new').hidden,
      startMain: document.querySelector('#known-new').classList.contains('btn-go'),
      status: document.querySelector('#known-status').textContent,
    }));
    check(`welcome-back ${press === '#known-voice' ? 'voice-only ' : ''}Continue, nothing to continue: both Continues go, the reason is shown, Start is the main button (asked ${asked})`, asked === 1 && !m.cont && !m.voice && m.start && m.startMain && m.status === 'There is nothing to continue. Start a new conversation.', JSON.stringify(m));
    await ctx.close();
  }
  await browser.close();
}

server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
