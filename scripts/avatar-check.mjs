#!/usr/bin/env node
/**
 * Plays a recorded avatar stream through the real talk page in real Chrome, at real-time pace, with no
 * API cost, and asserts what the spec promises: the first 0.4 s is never shown, the buffer stays under a
 * second, a second init segment (a connection swap) plays on, an `interrupted` frame jumps to the live
 * edge, and the teardown leaves no object URL and no element source. It takes screenshots too.
 *
 *   node scripts/avatar-check.mjs <source.mp4> [--shots .tmp/shots]
 *
 * Needs: a build (`npm run build`), ffmpeg, Google Chrome (Playwright's bundled Chromium has no H.264),
 * and the `playwright` package (set PLAYWRIGHT_MODULE to its path if it is not importable). The source is
 * any short MP4 of H.264 + AAC with a face in it; it is re-encoded to look like the real stream
 * (704x1280, 24 fps, Constrained Baseline 3.1, a key frame every 12 frames, AAC-LC 24 kHz mono,
 * one frame per fragment). Everything is written under .tmp/ (git-ignored).
 */
/* global window, document */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const shotsDir = resolve(args.includes('--shots') ? (args[args.indexOf('--shots') + 1] ?? '.tmp/shots') : '.tmp/shots');
if (!source) {
  console.error('usage: node scripts/avatar-check.mjs <source.mp4> [--shots dir]');
  process.exit(2);
}
const work = resolve('.tmp/avatar');
mkdirSync(work, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

// ---------- 1. a stream that looks like the real one ----------
const frag = `${work}/stream-frag.mp4`;
if (!existsSync(frag)) {
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', source, '-vf', 'scale=704:1280,fps=24', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '4M', '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '24000', '-ac', '1', '-b:a', '64k', '-movflags', 'empty_moov+default_base_moof+frag_every_frame', '-f', 'mp4', frag],
    { stdio: 'inherit' },
  );
}

// ---------- 2. cut it into messages, as the server sends them ----------
const mp4 = readFileSync(frag);
const boxes = [];
for (let o = 0; o + 8 <= mp4.length; ) {
  const size = mp4.readUInt32BE(o);
  boxes.push({ type: mp4.toString('latin1', o + 4, o + 8), o, size });
  o += size;
}
const init = mp4.subarray(0, boxes.find((b) => b.type === 'moov').o + boxes.find((b) => b.type === 'moov').size);
const frames = [];
for (let i = 0; i < boxes.length; i++) {
  if (boxes[i].type === 'moof' && boxes[i + 1]?.type === 'mdat') frames.push(Buffer.from(mp4.subarray(boxes[i].o, boxes[i + 1].o + boxes[i + 1].size)));
}
const rawFrames = frames.map((f) => Buffer.from(f)); // as ffmpeg wrote them: Chrome cannot buffer these (see below)
// ffmpeg's one-frame-per-fragment output differs from the real stream in two ways that Chrome punishes: the
// audio timeline has a one-packet hole at the start (0, 2048, 3072, ...), and the audio fragments declare a
// sample duration of 0 (the muxer cannot know the next packet's time). The real stream has continuous PTS and
// real durations (measured). Make the fixture match: audio frame n starts at n * 1024 and lasts 1024.
{
  const kids = (buf, s, e) => {
    const out = [];
    for (let o = s; o + 8 <= e; o += buf.readUInt32BE(o)) out.push({ type: buf.toString('latin1', o + 4, o + 8), o, size: buf.readUInt32BE(o) });
    return out;
  };
  const soundTrack = kids(init, kids(init, 0, init.length).find((b) => b.type === 'moov').o + 8, init.length)
    .filter((b) => b.type === 'trak')
    .map((t) => ({ t, id: init.readUInt32BE(kids(init, t.o + 8, t.o + t.size).find((b) => b.type === 'tkhd').o + 20) }))
    .find(({ t }) => init.subarray(t.o, t.o + t.size).includes('soun'))?.id;
  let n = 0;
  for (const f of frames) {
    const traf = kids(f, kids(f, 0, f.length).find((b) => b.type === 'moof').o + 8, f.length).find((b) => b.type === 'traf');
    const inTraf = kids(f, traf.o + 8, traf.o + traf.size);
    if (f.readUInt32BE(inTraf.find((b) => b.type === 'tfhd').o + 12) !== soundTrack) continue;
    const tfhd = inTraf.find((b) => b.type === 'tfhd');
    if (f.readUInt32BE(tfhd.o + 16) === 0) f.writeUInt32BE(1024, tfhd.o + 16); // default_sample_duration
    const tfdt = inTraf.find((b) => b.type === 'tfdt');
    if (f[tfdt.o + 8] === 0) f.writeUInt32BE(n * 1024, tfdt.o + 12);
    else f.writeBigUInt64BE(BigInt(n * 1024), tfdt.o + 12);
    n++;
  }
}
/** Google's envelope: pretty-printed, one base64 part, a trailing newline. */
const envelope = (bytes) =>
  Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') } }] } } }, null, 2) + '\n');
const DT = 19333 / frames.length; // ms between messages: the stream is real-time paced

const STREAM_S = 8;
const perStream = Math.min(frames.length, Math.floor((STREAM_S * 1000) / DT));
const BURST_AT = 5000;
const BURST = 350; // the stream runs 0.35 s ahead from 5 s: a lead the interrupt must remove
const GAP = 3700; // a swap: the new init segment follows about 3.7 s later
const blobs = [];
const schedule = [];
const addBin = (t, buf) => {
  schedule.push({ t, o: blobs.reduce((n, b) => n + b.length, 0), n: buf.length });
  blobs.push(buf);
};
addBin(0, envelope(init));
// From 5 s the stream runs 0.35 s ahead: the next 0.35 s arrive at once (in order), the rest 0.35 s early.
for (let i = 0; i < perStream; i++) addBin(i * DT >= BURST_AT ? Math.max(BURST_AT, i * DT - BURST) : i * DT, envelope(frames[i]));
const swapAt = perStream * DT - BURST;
schedule.push({ t: BURST_AT + 150, text: JSON.stringify({ serverContent: { interrupted: true } }) });
schedule.push({ t: swapAt, text: JSON.stringify({ aida: { type: 'reconnecting' } }) });
const at = swapAt + GAP;
schedule.push({ t: at - 100, text: JSON.stringify({ aida: { type: 'resumed' } }) });
addBin(at, envelope(init));
for (let i = 0; i < perStream; i++) addBin(at + 20 + i * DT, envelope(frames[i]));
const endAt = at + 20 + perStream * DT + 800;
schedule.push({ t: endAt, text: JSON.stringify({ aida: { type: 'ended', reason: 'complete', minutes: 1 } }) });
schedule.sort((a, b) => a.t - b.t);
const fixture = Buffer.concat(blobs);

writeFileSync(`${work}/stream-patched.mp4`, Buffer.concat([init, ...frames]));

// ---------- 3. serve the built page and the fixture ----------
const dist = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.png': 'image/png', '.webm': 'video/webm' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__fx/fixture.bin') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fixture);
  if (url.pathname === '/__fx/schedule.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(schedule));
  let p = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  if (!existsSync(`${dist}${p}`)) p = `${p}/index.html`;
  try {
    const body = readFileSync(`${dist}${p}`);
    res.writeHead(200, { 'content-type': types[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- 4. real Chrome ----------
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const GO = '0f'.repeat(32);
const sections = ['welcome', 'org', 'tools', 'workflows', 'challenges', 'needs', 'summary'].map((id) => ({ id, label: id }));
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=FontationsFontBackend'],
  ignoreDefaultArgs: ['--disable-dev-shm-usage'],
});
console.log(`browser ${browser.version()}`);

async function run(label, viewport, shotAt) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    // Count the object URLs the page makes and gives back.
    const made = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o) => {
      const u = create(o);
      made.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      made.delete(u);
      revoke(u);
    };
    window.__liveUrls = () => made.size;
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.binaryType = 'blob';
        window.__ws = this;
        window.__sent = [];
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
      pushBinary(ab) {
        this.onmessage?.({ data: ab });
      }
    }
    FakeWS.OPEN = 1;
    FakeWS.CONNECTING = 0;
    FakeWS.CLOSING = 2;
    FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  });
  await page.route('**/api/talk/me', (r) => r.fulfill(json({ known: false })));
  await page.route('**/api/talk/confirm', (r) => r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam Example' })));
  await page.goto(`${base}/talk/?go=${GO}`);
  await page.waitForSelector('#go-go');
  await page.click('#go-go'); // the click is the gesture that lets her sound play
  await page.waitForFunction(() => window.__ws);
  const socketUrl = await page.evaluate(() => window.__ws.url);
  console.log(`[${label}] socket ${socketUrl.replace(/id=[^&]+/, 'id=…')}`);
  const asked = /avatar=(1|lite)/.exec(socketUrl)?.[1];
  check(`[${label}] asks for video in real Chrome`, asked !== undefined, asked);
  await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);

  // Replay the stream at real-time pace; sample the player ten times a second.
  await page.evaluate(async () => {
    const buf = await (await fetch('/__fx/fixture.bin')).arrayBuffer();
    const sched = await (await fetch('/__fx/schedule.json')).json();
    const v = document.querySelector('#avatar-video');
    const stage = document.querySelector('#stage');
    window.__samples = [];
    window.__msgs = 0;
    const t0 = performance.now();
    window.__t0 = t0;
    let i = 0;
    setInterval(() => {
      const el = performance.now() - t0;
      while (i < sched.length && sched[i].t <= el) {
        const e = sched[i++];
        if (e.text) window.__ws.push(JSON.parse(e.text));
        else {
          window.__msgs++;
          window.__ws.pushBinary(buf.slice(e.o, e.o + e.n));
        }
      }
    }, 4);
    setInterval(() => {
      let lead = null;
      for (let k = 0; k < v.buffered.length; k++) {
        if (v.currentTime >= v.buffered.start(k) - 0.05 && v.currentTime <= v.buffered.end(k) + 0.05) lead = v.buffered.end(k) - v.currentTime;
      }
      window.__samples.push({ t: (performance.now() - t0) / 1000, ct: v.currentTime, lead, rs: v.readyState, paused: v.paused, shown: stage.dataset.video === 'on', muted: v.muted, hasSrc: v.hasAttribute('src') });
    }, 100);
  });
  const endAtS = schedule[schedule.length - 1].t / 1000;
  const lastMediaS = Math.max(...schedule.filter((e) => e.n).map((e) => e.t)) / 1000;
  const taken = new Set();
  const started = Date.now();
  while ((Date.now() - started) / 1000 < endAtS + 2.5) {
    const now = (Date.now() - started) / 1000;
    for (const [name, s] of Object.entries(shotAt)) {
      if (!taken.has(name) && now >= s) {
        taken.add(name);
        await page.screenshot({ path: `${shotsDir}/avatar-${name}-${label}.png` });
      }
    }
    await page.waitForTimeout(50);
  }
  const samples = await page.evaluate(() => window.__samples);
  const state = await page.evaluate(() => ({
    urls: window.__liveUrls(),
    hasSrc: document.querySelector('#avatar-video').hasAttribute('src'),
    rs: document.querySelector('#avatar-video').readyState,
    hidden: document.querySelector('#avatar-video').hidden,
    screen: document.querySelector('#app').dataset.screen,
  }));

  // ---- assertions ----
  const firstShown = samples.find((s) => s.shown);
  check(`[${label}] never shows the first 0.4 s (first shown at media time ${firstShown?.ct.toFixed(2)}, ${firstShown?.t.toFixed(2)} s after the init segment)`, !!firstShown && firstShown.ct >= 0.4, firstShown?.ct.toFixed(2));
  const early = samples.filter((s) => s.t < (firstShown?.t ?? 0));
  check(`[${label}] the portrait is what shows until then`, early.every((s) => !s.shown));
  const leads = samples.filter((s) => s.lead !== null && !s.paused).map((s) => s.lead);
  const maxLead = Math.max(...leads);
  check(`[${label}] the buffer stays under 1 s ahead (max ${maxLead.toFixed(2)} s, mean ${(leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(2)} s)`, maxLead < 1.05, maxLead.toFixed(2));
  // The interrupt: a 0.35 s head start builds, the frame lands, the playhead jumps.
  const iAt = (BURST_AT + 150) / 1000;
  const before = samples.filter((s) => s.t > iAt - 0.4 && s.t < iAt - 0.05 && s.lead !== null).map((s) => s.lead);
  const after = samples.filter((s) => s.t > iAt + 0.1 && s.t < iAt + 0.5 && s.lead !== null).map((s) => s.lead);
  const lb = Math.max(...before);
  const la = Math.min(...after);
  check(`[${label}] an interrupt jumps to the live edge (lead ${lb.toFixed(2)} s before, ${la.toFixed(2)} s after)`, la <= 0.3 && lb - la >= 0.25, `${lb.toFixed(2)} -> ${la.toFixed(2)}`);
  // The swap: stalled while no new media exists (expected), then plays on once it does.
  const swapS = swapAt / 1000;
  const resumeS = (swapAt + GAP) / 1000;
  const stalls = [];
  let cur = null;
  for (const s of samples) {
    const stalled = s.rs < 3 && s.t > 1.5 && s.t < lastMediaS - 0.3; // after the last fragment the picture rightly stops
    if (stalled && !cur) cur = { from: s.t, to: s.t };
    if (stalled && cur) cur.to = s.t;
    if (!stalled && cur) {
      stalls.push(cur);
      cur = null;
    }
  }
  if (cur) stalls.push(cur);
  const blips = stalls.filter((x) => x.to - x.from < 0.25).length; // the seek of an interrupt costs one frame
  stalls.splice(0, stalls.length, ...stalls.filter((x) => x.to - x.from >= 0.25));
  console.log(`[${label}] momentary dips (under 0.25 s, the interrupt's seek): ${blips}`);
  const swapStall = stalls.find((s) => s.from > swapS - 1 && s.from < resumeS);
  console.log(`[${label}] stalls: ${stalls.map((s) => `${s.from.toFixed(1)}-${s.to.toFixed(1)} s`).join(', ') || 'none'}; swap at ${swapS.toFixed(1)} s, new init at ${resumeS.toFixed(1)} s`);
  check(`[${label}] the only stall is the swap gap, and it ends within 1.5 s of the new init segment`, stalls.length <= 1 && (stalls.length === 0 || (swapStall && swapStall.to < resumeS + 1.5)), stalls.length);
  const afterSwap = samples.filter((s) => s.t > resumeS + 2.5 && s.t < endAtS - 1);
  const advanced = afterSwap.length > 5 && afterSwap[afterSwap.length - 1].ct - afterSwap[0].ct > (afterSwap[afterSwap.length - 1].t - afterSwap[0].t) * 0.9;
  check(`[${label}] the stream after the swap plays on at normal speed (${afterSwap.length ? (afterSwap[afterSwap.length - 1].ct - afterSwap[0].ct).toFixed(1) : 0} s of media in ${afterSwap.length ? (afterSwap[afterSwap.length - 1].t - afterSwap[0].t).toFixed(1) : 0} s)`, advanced);
  const hidSwap = samples.some((s) => s.t > swapS + 1.5 && s.t < resumeS && !s.shown);
  check(`[${label}] the portrait covers the swap gap`, hidSwap);
  const reshown = samples.find((s) => s.t > resumeS && s.shown);
  check(`[${label}] the first 0.4 s of the new stream is not shown either (back on screen ${reshown ? (reshown.t - resumeS).toFixed(2) : '?'} s after its init)`, !!reshown && reshown.t - resumeS > 0.9, reshown ? (reshown.t - resumeS).toFixed(2) : undefined);
  check(`[${label}] she is audible: the video is not muted after a click`, samples.every((s) => !s.muted));
  // Teardown after the call ends.
  check(`[${label}] teardown: the call ended, the page left the room`, state.screen === 'end', state.screen);
  check(`[${label}] teardown: no object URL left`, state.urls === 0, state.urls);
  check(`[${label}] teardown: the element has no source and is hidden`, !state.hasSrc && state.rs === 0 && state.hidden, JSON.stringify(state));
  check(`[${label}] no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

/** A stream this browser cannot play (durations missing, as ffmpeg wrote it): video must give up, never leave a dead screen. */
async function runFailure(label, viewport, switching = false) {
  const source = switching ? frames : rawFrames; // switching: a good stream, and the person chooses voice
  const raw = Buffer.concat([envelope(init), ...source.slice(0, 400).map(envelope)]);
  const offsets = [];
  let o = 0;
  for (const b of [envelope(init), ...source.slice(0, 400).map(envelope)]) {
    offsets.push([o, b.length]);
    o += b.length;
  }
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const made = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (x) => {
      const u = create(x);
      made.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      made.delete(u);
      revoke(u);
    };
    window.__liveUrls = () => made.size;
    window.__sockets = [];
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        window.__ws = this;
        window.__sockets.push(url);
        window.__sent = [];
      }
      send(m) {
        if (typeof m !== 'string') return;
        window.__sent.push(m);
        if (m.includes('"switch"')) setTimeout(() => this.push({ aida: { type: 'ended', reason: 'switch', minutes: 1, resumable: true, emailed: false } }), 150);
      }
      close() {
        this.readyState = 3;
      }
      push(x) {
        this.onmessage?.({ data: JSON.stringify(x) });
      }
      pushBinary(ab) {
        this.onmessage?.({ data: ab });
      }
    }
    FakeWS.OPEN = 1;
    FakeWS.CONNECTING = 0;
    FakeWS.CLOSING = 2;
    FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  });
  await page.route('**/api/talk/me', (r) => r.fulfill(json({ known: false })));
  await page.route('**/api/talk/confirm', (r) => r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam Example' })));
  await page.route('**/api/talk/continue', (r) =>
    r.fulfill(json({ id: 's1', targetMinutes: 5, sections, name: 'Sam', resumed: { minutesSoFar: 1, stage: 'welcome', hasSummary: false, notes: [] } })),
  );
  await page.route('**/__fx/broken.bin', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: raw }));
  await page.goto(`${base}/talk/?go=${GO}`);
  await page.click('#go-go');
  await page.waitForFunction(() => window.__ws);
  await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: true } }), sections);
  await page.evaluate(
    async ([offs]) => {
      const buf = await (await fetch('/__fx/broken.bin')).arrayBuffer();
      let i = 0;
      const timer = setInterval(() => {
        // about 47 messages a second
        for (let k = 0; k < 1 && i < offs.length; k++, i++) window.__ws.pushBinary(buf.slice(offs[i][0], offs[i][0] + offs[i][1]));
        if (i >= offs.length) clearInterval(timer);
      }, 21);
    },
    [offsets],
  );
  const t0 = Date.now();
  await page.screenshot({ path: `${shotsDir}/avatar-broken-before-${label}.png` });
  if (switching) {
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${shotsDir}/avatar-switch-before-${label}.png` });
    await page.click('#voice-only');
    await page.waitForFunction(() => window.__sockets.length >= 2, null, { timeout: 15000 });
    const urls = await page.evaluate(() => window.__sockets);
    check(`[${label}] Switch to voice only carries the call to a new line without video, on its own`, !/avatar=/.test(urls[1]) && /avatar=/.test(urls[0]));
    check(`[${label}] and remembers it`, (await page.evaluate(() => localStorage.getItem('aida.talk.voice-only'))) === '1');
    await ctx.close();
    return;
  }
  await page.waitForSelector('#end-screen:not([hidden])', { timeout: 30000 });
  const gaveUpAfter = (Date.now() - t0) / 1000;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shotsDir}/avatar-broken-end-${label}.png`, fullPage: true });
  const info = await page.evaluate(() => ({
    title: document.querySelector('#end-title').textContent,
    label: document.querySelector('#end-continue .label').textContent,
    button: !document.querySelector('#end-actions').hidden,
    sent: window.__sent.filter((m) => m.includes('aida')),
    urls: window.__liveUrls(),
  }));
  check(`[${label}] a stream Chrome cannot play makes video give up (after ${gaveUpAfter.toFixed(1)} s), never a dead screen`, gaveUpAfter < 14, gaveUpAfter.toFixed(1));
  check(`[${label}] it asks the server to save the place (switch, no email)`, info.sent.some((m) => m.includes('"switch"')), info.sent.join(' '));
  check(`[${label}] and offers Continue without video`, info.title === 'The video stopped' && info.label === 'Continue without video' && info.button, `${info.title} / ${info.label}`);
  check(`[${label}] the object URL is revoked`, info.urls === 0, info.urls);
  await page.click('#end-continue');
  await page.waitForFunction(() => window.__sockets.length >= 2, null, { timeout: 15000 });
  const urls = await page.evaluate(() => window.__sockets);
  const remembered = await page.evaluate(() => localStorage.getItem('aida.talk.voice-only'));
  check(`[${label}] the next call connects without an avatar parameter (${urls[1].replace(/id=[^&]+/, 'id=…')})`, !/avatar=/.test(urls[1]) && /avatar=/.test(urls[0]));
  check(`[${label}] and the choice is remembered`, remembered === '1', remembered);
  await page.evaluate((s) => window.__ws.push({ aida: { type: 'ready', targetMinutes: 5, sections: s, avatar: false } }), sections);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotsDir}/avatar-voice-only-room-${label}.png` });
  const voiceOnly = await page.evaluate(() => ({ video: document.querySelector('#avatar-video').hidden, still: !!document.querySelector('#stage .vera-still'), pill: document.querySelector('#voice-only').hidden }));
  check(`[${label}] the room is back with Vera's still, no video and no switch link`, voiceOnly.video && voiceOnly.still && voiceOnly.pill);
  await ctx.close();
}

const SHOTS = { poster: 0.7, playing: 3.8, swapgap: 10.2, playing2: 15 };
await run('phone', { width: 390, height: 844 }, SHOTS);
await run('desktop', { width: 1280, height: 800 }, SHOTS);
await runFailure('phone', { width: 390, height: 844 });
await runFailure('switch', { width: 390, height: 844 }, true);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
