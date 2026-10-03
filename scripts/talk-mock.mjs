// A stand-in for the interview backend, for trying the /talk/ page without it.
// Not shipped: it serves the built site from dist/ and speaks the protocol
// (POST /api/talk/start, then a WebSocket at /api/talk) with canned frames:
// ready, stages, notes, captions in fragments, a little audio, a reconnect, a
// summary and the end. No dependencies: the WebSocket is a minimal RFC 6455
// server written out below.
//
//   npm run build && node scripts/talk-mock.mjs [--port 8790] [--scenario full|nosummary|drop|quiet]
//                                             [--voice] [--pace 1]
//
// --scenario  full: the scripted conversation, then waits for End (summary + ended)
//             nosummary: as full, but End brings `ended` with no summary
//             drop: the line drops halfway through
//             quiet: ready and nothing else (drive it with /mock/* below)
// --voice     a soft synthetic voice instead of silence, so her mouth moves
// --pace      multiplies every delay (0.3 runs the script three times faster)
//
// Control, for scripted screenshots and measurements:
//   POST /mock/send          body = one frame (JSON), sent to every open socket
//   POST /mock/speak?seconds=N   N seconds of her talking: audio in real time plus captions
//   POST /mock/end?summary=0|1   her closing line, the summary (unless 0), then `ended`
//   GET  /mock/log           what the page has sent: audio frames, typed text, end
//
// A company name of "closed", "busy" or "down" makes /api/talk/start answer
// 404, 429 or 503, to show those messages.

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const PORT = Number(opt("port", "8790"));
const DIR = resolve(opt("dir", "dist"));
const SCENARIO = opt("scenario", "full");
const VOICE = args.includes("--voice");
const PACE = Number(opt("pace", "1"));

const SECTIONS = [
  { id: "welcome", label: "Welcome" },
  { id: "org", label: "Your organisation" },
  { id: "tools", label: "Your tools" },
  { id: "workflows", label: "How work flows" },
  { id: "challenges", label: "Challenges" },
  { id: "needs", label: "Needs and wants" },
  { id: "summary", label: "Read-back" },
];

const SUMMARY = {
  type: "summary",
  strengths: ["A settled team that knows the work", "Customers who keep coming back", "Owners close to the day-to-day"],
  weaknesses: ["Hours are re-typed into payroll every week", "Approvals wait on one person", "Rotas live in three spreadsheets"],
  opportunities: ["Let the time-tracking app feed payroll directly", "Give site leads their own approvals"],
  threats: ["Late or wrong pay costs goodwill with staff", "A third site would double the admin"],
  crux: "Every week's pay depends on one person re-typing hours from three places, so growth multiplies the admin instead of the output.",
  needs: ["Hours flowing into payroll without re-typing", "Approvals that do not wait for one person"],
  wants: ["One screen that shows the week at a glance", "Fewer spreadsheets"],
  approach: { bespokeOrCommodity: "Ready-made tools, set up properly for us", kind: "Done with us, so the team learns it" },
};

// ---------- the script ----------

const said = (text) => ({ serverContent: { outputTranscription: { text } } });
const heard = (text) => ({ serverContent: { inputTranscription: { text } } });
const aida = (frame) => ({ aida: frame });
const note = (section, text) => aida({ type: "note", section, text });
const section = (id) => aida({ type: "section", id });
const done = { serverContent: { turnComplete: true } };

/** Her line as fragments that carry their own spacing, the way the model sends them. */
function line(text) {
  const words = text.split(" ");
  return words.map((w, i) => said(i === 0 ? w : ` ${w}`));
}
function reply(text) {
  return text.split(" ").map((w, i) => heard(i === 0 ? w : ` ${w}`));
}

// [delay in ms before this step, frames, seconds of her audio to send alongside]
const SCRIPT = [
  [400, [aida({ type: "ready", targetMinutes: 20, sections: SECTIONS })], 0],
  [300, [section("welcome")], 0],
  [200, line("Hello, I'm Aida. Thanks for making the time. Shall we start with what your business does, and for whom?"), 4],
  [300, [done], 0],
  [900, reply("We run cleaning crews for offices, about forty people across two sites."), 0],
  [200, [section("org")], 0],
  [300, [note("org", "Office cleaning, about forty staff across two sites")], 0],
  [200, line("Forty people on two sites. Who decides the rota each week?"), 3],
  [200, [done], 0],
  [900, reply("Each site lead, and then I approve everything on Friday."), 0],
  [300, [note("org", "Site leads build rotas; the owner approves them all on Friday")], 0],
  [200, [section("tools")], 0],
  [200, line("And which tools do you use for that today?"), 2],
  [200, [done], 0],
  [900, reply("A time-tracking app on their phones, spreadsheets for the rota, and a payroll package."), 0],
  [300, [note("tools", "A time-tracking app on staff phones for clocking in")], 0],
  [250, [note("tools", "Rotas kept in spreadsheets, one per site")], 0],
  [250, [note("tools", "A separate payroll package")], 0],
  [400, [aida({ type: "reconnecting" })], 0],
  [2600, [aida({ type: "resumed" })], 0],
  [200, [section("workflows")], 0],
  [200, line("Walk me through a normal week, from the rota to people being paid."), 3],
  [200, [done], 0],
  [900, reply("Hours come out of the app, I check them against the rota, then type them into payroll."), 0],
  [300, [note("workflows", "Hours are exported, checked against the rota by hand, then re-typed into payroll")], 0],
  [300, [section("challenges")], 0],
  [300, [note("strengths", "A settled team that knows the work")], 0],
  [250, [note("weaknesses", "Approvals all wait on one person")], 0],
  [250, [note("opportunities", "The app could feed payroll directly")], 0],
  [250, [note("threats", "A third site would double the admin")], 0],
  [250, [note("crux", "Pay depends on one person re-typing hours from three places")], 0],
  [200, line("So the real knot is that Friday, when everything waits on you. Is that fair?"), 3],
  [200, [done], 0],
];

// ---------- audio ----------

const RATE = 24_000;

/** `seconds` of her "voice": silence, or with --voice a soft buzz shaped like syllables. */
function voiceChunk(seconds, t0) {
  const n = Math.round(RATE * seconds);
  const buf = Buffer.alloc(n * 2);
  if (VOICE) {
    for (let i = 0; i < n; i++) {
      const t = t0 + i / RATE;
      const syllable = Math.max(0, Math.sin(2 * Math.PI * 4.2 * t)) ** 0.6;
      const vowel = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.9 * t);
      let s = 0;
      for (let h = 1; h <= 12; h++) {
        const f = 185 * h;
        const weight = f < 1200 ? 1 / h : (vowel * 0.6) / h;
        s += weight * Math.sin(2 * Math.PI * f * t);
      }
      const hiss = syllable < 0.25 ? (Math.random() * 2 - 1) * 0.08 * vowel : 0;
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (s * 0.22 + hiss) * syllable)) * 32767), i * 2);
    }
  }
  return {
    serverContent: { modelTurn: { parts: [{ inlineData: { data: buf.toString("base64"), mimeType: `audio/pcm;rate=${RATE}` } }] } },
  };
}

// ---------- a minimal WebSocket ----------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frameOf(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class Peer {
  constructor(socket, onText, onClose) {
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.read(onText);
    });
    const closed = () => {
      if (!this.open) return;
      this.open = false;
      onClose();
    };
    socket.on("close", closed);
    socket.on("error", closed);
  }

  read(onText) {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      const maskAt = at;
      if (masked) at += 4;
      if (b.length < at + len) return;
      const payload = Buffer.from(b.subarray(at, at + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskAt + (i % 4)];
      this.buffer = b.subarray(at + len);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) this.socket.write(frameOf(0xa, payload));
      if (opcode === 0x1 || opcode === 0x0) {
        this.parts.push(payload);
        if (fin) {
          onText(Buffer.concat(this.parts).toString("utf8"));
          this.parts = [];
        }
      }
    }
  }

  send(obj) {
    if (this.open) this.socket.write(frameOf(0x1, Buffer.from(JSON.stringify(obj))));
  }

  close() {
    if (!this.open) return;
    this.socket.write(frameOf(0x8, Buffer.from([0x03, 0xe8])));
    this.socket.end();
  }

  drop() {
    this.socket.destroy();
  }
}

// ---------- the conversation ----------

const peers = new Set();
const log = { audioFrames: 0, audioBytes: 0, texts: [], ended: false, sockets: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));

/** Her audio, sent in 100 ms chunks at real-time pace, for `seconds`. */
async function speak(peer, seconds, words = []) {
  const chunks = Math.max(1, Math.round(seconds * 10));
  let sent = 0;
  for (let i = 0; i < chunks && peer.open; i++) {
    peer.send(voiceChunk(0.1, i * 0.1));
    const due = Math.ceil(((i + 1) / chunks) * words.length);
    while (sent < due) peer.send(words[sent++]);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function finish(peer, withSummary) {
  if (!peer.open || peer.finishing) return;
  peer.finishing = true;
  const closing = line("Thank you, that was really helpful. I'll put together what I heard.");
  for (const f of closing) peer.send(f);
  await speak(peer, 2);
  peer.send(done);
  peer.send(section("summary"));
  await sleep(500);
  if (withSummary) peer.send(aida(SUMMARY));
  await sleep(200);
  peer.send(aida({ type: "ended", reason: "user", minutes: 18.4 }));
  await sleep(500);
  peer.close();
}

async function run(peer) {
  const steps = SCENARIO === "quiet" ? SCRIPT.slice(0, 1) : SCRIPT;
  for (let i = 0; i < steps.length && peer.open && !peer.finishing; i++) {
    const [delay, frames, audio] = steps[i];
    await sleep(delay);
    if (!peer.open || peer.finishing) return;
    if (SCENARIO === "drop" && i === Math.floor(steps.length / 2)) {
      console.log("mock: dropping the line");
      peer.drop();
      return;
    }
    if (audio) {
      // Words and audio together, the way she speaks: fragments spread over the audio.
      await speak(peer, audio * PACE, frames);
      continue;
    }
    for (const f of frames) {
      peer.send(f);
      if (frames.length > 1) await sleep(60);
    }
  }
}

function onText(peer, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.realtimeInput?.audio?.data) {
    log.audioFrames++;
    log.audioBytes += Buffer.from(msg.realtimeInput.audio.data, "base64").length;
    return;
  }
  const typed = msg.clientContent?.turns?.[0]?.parts?.[0]?.text;
  if (typeof typed === "string") {
    log.texts.push(typed);
    void (async () => {
      await sleep(400);
      peer.send(note("tools", typed.slice(0, 120)));
      for (const f of line("Thanks, I've noted that.")) peer.send(f);
      await speak(peer, 1.2);
      peer.send(done);
    })();
    return;
  }
  if (msg.aida?.type === "end") {
    log.ended = true;
    void finish(peer, SCENARIO !== "nosummary");
  }
}

// ---------- http ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".txt": "text/plain",
  ".json": "application/json",
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function start(req, res) {
  const b = await body(req);
  if (!b || typeof b !== "object") return json(res, 400, { error: "That request did not make sense." });
  if (b.consent !== true) return json(res, 400, { error: "Please agree before you start.", field: "consent" });
  const company = String(b.company ?? "").trim().toLowerCase();
  if (company === "closed") return json(res, 404, { error: "closed" });
  if (company === "busy") return json(res, 429, { error: "too many" });
  if (company === "down") return json(res, 503, { error: "unavailable" });
  for (const f of ["name", "company", "email"]) {
    if (!String(b[f] ?? "").trim()) return json(res, 400, { error: `Please fill in your ${f}.`, field: f });
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(b.email))) {
    return json(res, 400, { error: "The server could not read that email address.", field: "email" });
  }
  if (b.phone && !/^[+()\d\s.-]{6,40}$/.test(String(b.phone))) {
    return json(res, 400, { error: "The server could not read that phone number.", field: "phone" });
  }
  return json(res, 200, { id: randomUUID(), targetMinutes: 20, sections: SECTIONS });
}

async function serveFile(req, res) {
  const url = new URL(req.url ?? "/", "http://mock");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  let file = join(DIR, path);
  if (!file.startsWith(DIR)) return json(res, 403, { error: "forbidden" });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  if (req.method === "POST" && url.pathname === "/api/talk/start") return void start(req, res);
  if (req.method === "POST" && url.pathname === "/mock/send") {
    return void body(req).then((frame) => {
      for (const p of peers) p.send(frame);
      json(res, 200, { sent: peers.size });
    });
  }
  if (req.method === "POST" && url.pathname === "/mock/speak") {
    const seconds = Math.min(120, Number(url.searchParams.get("seconds") ?? "10"));
    const words = line(
      "Let me read back what I have so far, and you tell me if I have any of it wrong. You run office cleaning with about forty people on two sites, the leads build the rotas, and everything waits for you on Friday.",
    );
    for (const p of peers) void speak(p, seconds, words).then(() => p.send(done));
    return json(res, 200, { speaking: peers.size, seconds });
  }
  if (req.method === "POST" && url.pathname === "/mock/end") {
    const withSummary = url.searchParams.get("summary") !== "0";
    for (const p of peers) void finish(p, withSummary);
    return json(res, 200, { ending: peers.size });
  }
  if (req.method === "GET" && url.pathname === "/mock/log") return json(res, 200, log);
  if (req.method === "POST" && url.pathname === "/api/event") {
    res.writeHead(204); // the home page's own event beacon: accepted and ignored
    return void res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") return void serveFile(req, res);
  json(res, 405, { error: "method" });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/api/talk" || !url.searchParams.get("id") || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  log.sockets++;
  const peer = new Peer(
    socket,
    (text) => {
      onText(peer, text);
    },
    () => peers.delete(peer),
  );
  peers.add(peer);
  void run(peer);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock: serving ${DIR} on port ${PORT} (scenario ${SCENARIO}${VOICE ? ", voice" : ""})`);
});
