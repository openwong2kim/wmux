#!/usr/bin/env node
/**
 * M3 acceptance harness — the served CSP, and the device→ticket→stream path.
 *
 * Sibling of scripts/approvals-dynamic.mjs and built on the same isolation: the
 * BUNDLED daemon (dist/daemon-bundle/index.js) in a temp USERPROFILE/HOME **and**
 * a fresh WMUX_DATA_SUFFIX, so even a failed home override cannot land on the
 * production ~/.wmux. No Electron main process exists at any point.
 *
 * Two things meet here that unit tests cannot reach.
 *
 * THE CSP. `securityHeaders()` used to send `frame-ancestors 'none'` alone, and
 * the security review called that LOW severity **because the web token died on
 * every restart**. M3 made credentials durable, which invalidates that rating:
 * an XSS on this page now steals something that works until it is revoked. The
 * header is now derived from the bytes of `terminal.html` at load time, so the
 * failure mode this harness exists to catch is a header and a page that
 * disagree — which does not degrade the terminal, it blanks it. Every hash below
 * is recomputed by the HARNESS, from the body the server actually sent, with its
 * own extractor: importing the server's own module would only prove that module
 * agrees with itself. Three independent computations have to line up — the
 * harness's, the build's (`dist/daemon-web/csp.json`), and the server's header.
 *
 * THE TICKET PATH. A device credential is HEADER-ONLY on purpose: it is durable,
 * and a query string is the one place a secret is guaranteed to be written down.
 * `EventSource` cannot set headers, so a browser device trades its credential
 * for a short-lived `?ticket=`. That whole exchange — and the revocation that
 * has to invalidate outstanding tickets, not just future requests — only exists
 * across the real HTTP surface, and `src/daemon/web/frontend/app.js`'s
 * latch/renew logic on the browser side has no automated coverage at all.
 *
 * Scenarios:
 *
 *   S1  the CSP header names exactly the hashes of the blocks in the body the
 *       server just served, and nothing else. `script-src` carries no escape
 *       hatch (`unsafe-inline`, `unsafe-eval`, a host, a scheme, `*`), and the
 *       header equals the policy the build recorded in csp.json.
 *
 *   S2  browser-equivalent admission check, STATICALLY: every inline block in
 *       the body is admitted by the policy, and every sub-resource the page
 *       reaches for (manifest, icons, the service worker) has a directive that
 *       covers it. This is hash arithmetic, NOT a browser — see the note in the
 *       S2 evidence, and S6 for the real thing.
 *
 *   S3  the header is on EVERY response — page, manifest, sw.js, icon, JSON,
 *       both SSE routes, a 401 and a 404 — byte-identical each time. A policy
 *       that covers only the happy path is not a policy.
 *
 *   S4  pair a NAMED device, then use it: `?token=<device credential>` is 401 by
 *       design, the header form works, `POST /api/stream-ticket` mints a ticket
 *       the operator token cannot mint, and BOTH SSE routes open with `?ticket=`
 *       and deliver real frames. The ticket is reusable within its TTL.
 *
 *   S5  revoke device A: its two live streams get a clean EOF, its outstanding
 *       ticket stops working, its credential 401s with reason 'revoked', and
 *       device B — paired the same way, streaming at the same moment — keeps
 *       receiving pane bytes written AFTER the revoke.
 *
 *   S6  the same page in a REAL Chromium, asserting zero securitypolicyviolation
 *       events, that xterm's runtime <style> injections applied, and that the
 *       service worker registered. SKIPPED (not failed) where playwright-core or
 *       Chrome is absent; it is the only scenario that can see a directive
 *       FALLBACK, which is how `worker-src` and `manifest-src` earned their way
 *       into the policy in the first place.
 *
 *   S7  a REAL browser as a DEVICE, which is the only way to reach app.js's
 *       ticket latch and renew at all — S6's page holds the operator token, so
 *       it latches `ticketsUnavailable` on the first 403 and never touches a
 *       ticket again. Pairs by TYPING the code, checks the durable credential
 *       never appears in a URL, then bounces the web server (which drops every
 *       outstanding ticket) and asserts the page recovers ON ITS OWN: a fresh
 *       ticket, both channels rebuilt, the attention channel carrying
 *       `?since=<cursor>` (#600's replay), and a byte written AFTER the bounce
 *       arriving in the page's own terminal.
 *
 * Usage:  node scripts/m3-csp-device-stream-dynamic.mjs
 * Exit:   0 all pass, 1 a scenario failed, 2 preconditions unmet.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');
const WEB_DIR = path.join(REPO_ROOT, 'dist', 'daemon-web');
const WEB_ASSETS = path.join(WEB_DIR, 'terminal.html');
const CSP_MANIFEST = path.join(WEB_DIR, 'csp.json');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}
if (!fs.existsSync(WEB_ASSETS)) {
  console.error('Daemon web assets missing — run `node scripts/build-daemon-web.mjs` first');
  process.exit(2);
}

// === Isolation =============================================================

const RUN_TAG = randomUUID().slice(0, 8);
const DATA_SUFFIX = `-m3csp-${RUN_TAG}`;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-m3csp-'));
const WMUX_DIR = path.join(TEST_HOME, `.wmux${DATA_SUFFIX}`);
const PANE_CWD = path.join(TEST_HOME, 'pane');
fs.mkdirSync(WMUX_DIR, { recursive: true });
fs.mkdirSync(PANE_CWD, { recursive: true });

const PIPE_NAME =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-m3csp-${RUN_TAG}`
    : path.join(TEST_HOME, `.wmux-test-m3csp-${RUN_TAG}.sock`);
const AUTH_TOKEN = randomUUID();
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
// Away from 7681 so a real `wmux web` on this machine is never touched. Also
// away from the approvals harness's range so the two can run side by side.
const WEB_PORT = 19_800 + Math.floor(Math.random() * 600);
// LOOPBACK, and that is load-bearing: minting a durable device secret is
// REFUSED over a plaintext non-loopback bind, so a 0.0.0.0 harness could not
// pair at all without --allow-host.
const WEB_HOST = '127.0.0.1';

fs.writeFileSync(
  path.join(WMUX_DIR, 'config.json'),
  JSON.stringify({
    version: 1,
    daemon: { pipeName: PIPE_NAME, logLevel: 'info', autoStart: true },
    session: {
      defaultShell: SHELL,
      defaultCols: 120,
      defaultRows: 30,
      bufferSizeMb: 8,
      bufferMaxMb: 64,
      deadSessionTtlHours: 24,
      deadSessionDumpBuffer: false,
    },
  }, null, 2),
);
fs.writeFileSync(path.join(WMUX_DIR, 'daemon-auth-token'), AUTH_TOKEN, 'utf-8');
fs.writeFileSync(path.join(WMUX_DIR, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }));

const PIPE_HINT_FILE = path.join(WMUX_DIR, 'daemon-pipe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === Daemon lifecycle ======================================================

let daemon = null;
const daemonLog = [];

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: TEST_HOME,
      HOME: TEST_HOME,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
      WMUX_DATA_SUFFIX: DATA_SUFFIX,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { daemonLog.push(d.toString()); });
  child.stderr.on('data', (d) => { daemonLog.push(d.toString()); });
  return child;
}

async function waitForPipeFile(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(PIPE_HINT_FILE)) {
      const name = fs.readFileSync(PIPE_HINT_FILE, 'utf-8').trim();
      if (name) return name;
    }
    await sleep(100);
  }
  throw new Error('daemon-pipe hint file did not appear within timeout');
}

// === Control-pipe client ===================================================

class PipeClient {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'string' && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error ?? 'rpc error'));
        }
      }
    });
    socket.on('error', () => {});
  }

  static async connect(pipeName) {
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection(pipeName);
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, 8_000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return new PipeClient(socket);
  }

  rpc(method, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const id = `req-${Math.random().toString(36).slice(2, 12)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, token: AUTH_TOKEN }) + '\n');
    });
  }

  close() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.socket.destroy();
  }
}

// === HTTP client ===========================================================

let operatorToken = '';

/**
 * `auth` is spelled out per call rather than defaulted, because half of what
 * this harness asserts is WHICH credential was presented.
 */
function httpRequest(method, pathname, { auth = null, body, headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: WEB_HOST,
        port: WEB_PORT,
        path: pathname,
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          ...(payload !== null
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, raw: buf, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * SSE reader that also records HOW it ended.
 *
 * `endedCleanly` is the assertion S5 turns on: a revoked device's stream must be
 * closed by the server with `res.end()` — a normal end-of-body — not left to rot
 * and not torn down as a socket error. `res.complete` is node's own answer to
 * "did this response finish properly".
 */
class SseClient {
  constructor(req, res, headers, status) {
    this.req = req;
    this.res = res;
    this.headers = headers;
    this.status = status;
    this.frames = [];
    this.ended = false;
    this.endedAt = 0;
    this.endedCleanly = null;
    this.errored = null;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const frame = { id: null, event: 'message', data: '' };
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data += line.slice(6);
        }
        if (frame.event === 'message' && !frame.data) continue;
        this.frames.push({ ...frame, at: Date.now() });
      }
    });
    res.on('end', () => {
      this.ended = true;
      this.endedAt = Date.now();
      this.endedCleanly = res.complete === true;
    });
    res.on('error', (e) => { this.errored = String(e); });
  }

  /** Open a stream. Resolves with the client even on a non-200, so the status is assertable. */
  static open(pathname, { auth = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: WEB_HOST,
          port: WEB_PORT,
          path: pathname,
          method: 'GET',
          headers: {
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
            Accept: 'text/event-stream',
            ...headers,
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
              let json = null;
              try { json = buf ? JSON.parse(buf) : null; } catch { /* not JSON */ }
              resolve({ status: res.statusCode, headers: res.headers, json, frames: [], closed: true });
            });
            return;
          }
          resolve(new SseClient(req, res, res.headers, res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  async waitFor(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (this.ended) return null;
      await sleep(25);
    }
    return null;
  }

  async waitForEnd(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ended) return true;
      await sleep(20);
    }
    return false;
  }

  close() {
    try { this.req.destroy(); } catch { /* ignore */ }
  }
}

// === CSP arithmetic (the harness's OWN implementation) =====================

/**
 * Deliberately NOT imported from src/daemon/web/webCsp.ts. An assertion that
 * the server agrees with the module the server uses is a tautology; this is a
 * second opinion, written from the spec, that has to arrive at the same answer.
 *
 * The newline rewrite is the part that is easy to get wrong and impossible to
 * notice: the HTML parser preprocesses its input stream, turning every CRLF and
 * lone CR into LF before the tokenizer runs, so the hash a browser computes is
 * over LF-normalized text no matter what the file holds. terminal.html mixes
 * both conventions (Windows-checkout frontend sources, LF xterm bundle).
 */
const normalizeForHash = (s) => s.replace(/\r\n?/g, '\n');
const cspHash = (s) => `'sha256-${createHash('sha256').update(normalizeForHash(s), 'utf8').digest('base64')}'`;

function inlineBlocks(html) {
  const re = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  const scripts = [];
  const styles = [];
  const external = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, tag, attrs, body] = m;
    if (tag.toLowerCase() === 'script') {
      if (/\bsrc\s*=/i.test(attrs)) external.push(`<script${attrs}>`);
      else scripts.push(body);
    } else {
      styles.push(body);
    }
  }
  for (const link of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/rel\s*=\s*["']?stylesheet/i.test(link)) external.push(link);
  }
  return { scripts, styles, external };
}

/** Parse a policy into `{directive: [sources]}`. */
function parseCsp(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    out[bits[0].toLowerCase()] = bits.slice(1);
  }
  return out;
}

// === Report ================================================================

const report = [];
function record(scenario, pass, evidence) {
  report.push({ scenario, pass, evidence });
  console.log(`[${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}] ${scenario}`);
}

// === Scenarios =============================================================

/** S1 + S2 — the header against the body it was served with. */
async function scenarioCspHeader() {
  const page = await httpRequest('GET', '/', {});
  const header = page.headers['content-security-policy'];
  const csp = parseCsp(header);
  const blocks = inlineBlocks(page.raw);
  const scriptHashes = blocks.scripts.map(cspHash);
  const styleHashes = blocks.styles.map(cspHash);

  const built = fs.existsSync(CSP_MANIFEST) ? JSON.parse(fs.readFileSync(CSP_MANIFEST, 'utf8')) : null;

  const scriptSrc = csp['script-src'] ?? [];
  // Anything in script-src that is not one of OUR hashes is an escape hatch,
  // whatever it is spelled — 'self', 'unsafe-inline', a host, a scheme, '*'.
  const foreignScriptSources = scriptSrc.filter((s) => !scriptHashes.includes(s));
  const missingHashes = scriptHashes.filter((h) => !scriptSrc.includes(h));

  const s1Evidence = {
    pageStatus: page.status,
    pageBytes: page.raw.length,
    header,
    inlineBlockCounts: { script: blocks.scripts.length, style: blocks.styles.length },
    harnessScriptHashes: scriptHashes,
    harnessStyleHashes: styleHashes,
    servedScriptSrc: scriptSrc,
    foreignScriptSources,
    missingHashes,
    buildRecordedPolicy: built?.policy ?? null,
    headerEqualsBuildRecord: built ? built.policy === header : null,
    buildRecordedScriptHashes: built?.scriptHashes ?? null,
    otherSecurityHeaders: {
      'x-frame-options': page.headers['x-frame-options'],
      'x-content-type-options': page.headers['x-content-type-options'],
      'referrer-policy': page.headers['referrer-policy'],
    },
  };
  const s1Pass =
    page.status === 200 &&
    blocks.scripts.length === 3 &&
    blocks.styles.length === 1 &&
    missingHashes.length === 0 &&
    foreignScriptSources.length === 0 &&
    scriptSrc.length === scriptHashes.length &&
    (csp['default-src'] ?? []).join(' ') === "'none'" &&
    (csp['connect-src'] ?? []).join(' ') === "'self'" &&
    (csp['img-src'] ?? []).join(' ') === "'self' data:" &&
    (csp['worker-src'] ?? []).join(' ') === "'self'" &&
    (csp['manifest-src'] ?? []).join(' ') === "'self'" &&
    (csp['frame-ancestors'] ?? []).join(' ') === "'none'" &&
    (csp['base-uri'] ?? []).join(' ') === "'none'" &&
    (csp['form-action'] ?? []).join(' ') === "'none'" &&
    built !== null &&
    built.policy === header &&
    JSON.stringify(built.scriptHashes) === JSON.stringify(scriptHashes) &&
    page.headers['x-frame-options'] === 'DENY' &&
    page.headers['x-content-type-options'] === 'nosniff' &&
    page.headers['referrer-policy'] === 'no-referrer';
  record('S1 csp-header-matches-served-page', s1Pass, s1Evidence);

  // --- S2: would any block be blocked?
  const styleSrc = csp['style-src'] ?? [];
  // Per CSP3 a hash or nonce in a directive makes 'unsafe-inline' be IGNORED.
  // So `style-src 'unsafe-inline' 'sha256-…'` is the BROKEN spelling, and the
  // check has to be "unsafe-inline AND no hash", not "unsafe-inline".
  const styleHashPresent = styleSrc.some((s) => s.startsWith("'sha256-") || s.startsWith("'nonce-"));
  const stylesAdmitted = styleSrc.includes("'unsafe-inline'") && !styleHashPresent;
  const scriptsAdmitted = blocks.scripts.every((b) => scriptSrc.includes(cspHash(b)));

  // The sub-resources the page reaches for, and the directive each needs.
  const subResources = [
    { what: '/manifest.webmanifest', via: '<link rel="manifest">', directive: 'manifest-src', ok: (csp['manifest-src'] ?? []).includes("'self'") },
    { what: '/icon-192.png', via: '<link rel="apple-touch-icon">', directive: 'img-src', ok: (csp['img-src'] ?? []).includes("'self'") },
    { what: '/sw.js', via: "navigator.serviceWorker.register('/sw.js')", directive: 'worker-src', ok: (csp['worker-src'] ?? []).includes("'self'") },
    { what: '/api/* fetch + EventSource', via: 'app.js', directive: 'connect-src', ok: (csp['connect-src'] ?? []).includes("'self'") },
  ];
  const registersSw = page.raw.includes("serviceWorker.register('/sw.js')");

  const s2Evidence = {
    METHOD:
      'STATIC hash arithmetic against the served body — no browser is involved in this scenario. ' +
      'It cannot observe a directive FALLBACK (worker-src→script-src, manifest-src→default-src), ' +
      'which is exactly the class of bug S6 exists for.',
    scriptsAdmitted,
    stylesAdmitted,
    styleSrc,
    styleHashPresentWouldNullifyUnsafeInline: styleHashPresent,
    styleHashRecordedButUnused: styleHashes,
    styleSrcNote:
      "style-src is NOT hash-pinned: xterm 6.0.0 injects <style> elements whose content is computed " +
      'at runtime from the measured font, so no build-time hash can name them. See webCsp.ts.',
    externalRefsInPage: blocks.external,
    subResources,
    pageRegistersServiceWorker: registersSw,
  };
  const s2Pass =
    scriptsAdmitted &&
    stylesAdmitted &&
    blocks.external.length === 0 &&
    registersSw &&
    subResources.every((r) => r.ok);
  record('S2 no-inline-block-would-be-blocked', s2Pass, s2Evidence);

  return header;
}

/** S3 — one header, every response. */
async function scenarioHeaderEverywhere(sessionId, expected) {
  const probes = [];
  const add = (label, res) => probes.push({
    label,
    status: res.status,
    csp: (res.headers ?? {})['content-security-policy'],
    xfo: (res.headers ?? {})['x-frame-options'],
  });

  add('GET / (html)', await httpRequest('GET', '/', {}));
  add('GET /manifest.webmanifest', await httpRequest('GET', '/manifest.webmanifest', {}));
  add('GET /sw.js', await httpRequest('GET', '/sw.js', {}));
  add('GET /icon-512.png', await httpRequest('GET', '/icon-512.png', {}));
  add('GET /api/config (operator)', await httpRequest('GET', '/api/config', { auth: operatorToken }));
  add('GET /api/sessions (operator)', await httpRequest('GET', '/api/sessions', { auth: operatorToken }));
  add('GET /api/config (401)', await httpRequest('GET', '/api/config', { auth: 'not-a-token' }));
  add('GET /api/nope (404)', await httpRequest('GET', '/api/nope', { auth: operatorToken }));

  const paneSse = await SseClient.open(`/api/stream?session=${encodeURIComponent(sessionId)}&token=${operatorToken}`);
  add('SSE /api/stream', paneSse);
  const eventSse = await SseClient.open(`/api/events?token=${operatorToken}`);
  add('SSE /api/events', eventSse);
  paneSse.close?.();
  eventSse.close?.();

  // Placement, not blanket coverage. The full policy — hashes and all — rides
  // the HTML response, because that is the only thing that executes. Every
  // other response carries the baseline, so a response can never be POLICYLESS,
  // but it does not pay ~250 bytes of script hashes it has no use for; a phone
  // typing would pay that per keystroke. (This asserted "identical everywhere"
  // until the #612 merge, where main's narrower placement won on that cost.)
  const BASELINE = "frame-ancestors 'none'";
  const html = probes.find((x) => x.label === 'GET / (html)');
  const others = probes.filter((x) => x !== html);
  const htmlOk = !!html && html.csp === expected;
  const othersOk = others.every((x) => x.csp === BASELINE);
  const wrong = others.filter((x) => x.csp !== BASELINE);
  const evidence = {
    expectedHtmlHeader: expected,
    expectedElsewhere: BASELINE,
    htmlCarriesFullPolicy: htmlOk,
    probes,
    wrongElsewhere: wrong,
  };
  record('S3 csp-placement-html-full-baseline-elsewhere', htmlOk && othersOk && probes.length === 10, evidence);
}

/** Pair one named device and hand back its credential. */
async function pairDevice(control, name) {
  const started = await control.rpc('daemon.web.pairStart', { name });
  if (!started?.ok || !started.code) throw new Error(`pairStart failed: ${JSON.stringify(started)}`);
  const paired = await httpRequest('GET', `/api/pair?code=${encodeURIComponent(started.code)}`, {});
  if (paired.status !== 200 || !paired.json?.deviceId) {
    throw new Error(`pair failed: ${paired.status} ${paired.raw}`);
  }
  return {
    name,
    deviceId: paired.json.deviceId,
    secret: paired.json.deviceSecret,
    credential: `${paired.json.deviceId}.${paired.json.deviceSecret}`,
    pairResponseKeys: Object.keys(paired.json),
  };
}

/** S4 — device credential → ticket → both SSE routes. */
async function scenarioDeviceTicketStreams(control, sessionId, device) {
  // `deviceCredentials:false` means the roster failed to load and pairing
  // silently fell back to the SHARED token — every device would hold the same
  // secret and per-device revocation would not exist. It is exactly the kind of
  // degradation that passes every other assertion in this file, so it is
  // asserted rather than assumed.
  const status = await control.rpc('daemon.web.status', {});
  // Header-only, by design: a device credential in the query authenticates
  // nothing, on any route.
  const viaQuery = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(device.credential)}`,
  );
  const headerAuth = await httpRequest('GET', '/api/sessions', { auth: device.credential });

  const ticketRes = await httpRequest('POST', '/api/stream-ticket', { auth: device.credential, body: {} });
  const operatorTicket = await httpRequest('POST', '/api/stream-ticket', { auth: operatorToken, body: {} });
  const ticket = ticketRes.json?.ticket ?? '';
  const ttlMs = (ticketRes.json?.expiresAt ?? 0) - Date.now();

  const paneStream = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
  );
  const eventStream = await SseClient.open(`/api/events?ticket=${encodeURIComponent(ticket)}`);
  // The SAME ticket a second time: reusable within its TTL, deliberately — a
  // one-shot ticket would turn every ordinary reconnect into a re-pair.
  const reuseStream = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
  );

  const snapshot = paneStream.waitFor ? await paneStream.waitFor((f) => f.event === 'snapshot') : null;
  // Provoke a real frame on /api/events so "the stream opened" is not the whole
  // claim — an approval is the attention event this channel exists for.
  await control.rpc('daemon.hooks.signal', {
    kind: 'agent.awaiting_input',
    agent: 'claude',
    ptyId: sessionId,
    cwd: PANE_CWD,
    ts: Date.now(),
    payload: {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{
          question: 'Harness ticket probe?',
          header: 'Probe',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }],
        }],
      },
    },
  });
  const attention = eventStream.waitFor ? await eventStream.waitFor((f) => f.event === 'approval') : null;

  reuseStream.close?.();

  const evidence = {
    deviceCredentialsArmed: status?.deviceCredentials,
    deviceName: device.name,
    deviceId: device.deviceId,
    pairResponseKeys: device.pairResponseKeys,
    deviceCredentialInQueryStatus: viaQuery.status,
    deviceCredentialInHeaderStatus: headerAuth.status,
    sessionsSeenByDevice: (headerAuth.json?.sessions ?? []).map((s) => s.id),
    ticketStatus: ticketRes.status,
    ticketTtlMs: ttlMs,
    ticketPrefix: ticket ? `${ticket.slice(0, 8)}…(${ticket.length} chars)` : null,
    operatorTicketStatus: operatorTicket.status,
    operatorTicketError: operatorTicket.json?.error,
    paneStreamStatus: paneStream.status,
    paneSnapshotFrame: snapshot ? { event: snapshot.event, bytes: snapshot.data.length } : null,
    eventStreamStatus: eventStream.status,
    attentionFrame: attention ? { event: attention.event, id: attention.id } : null,
    ticketReusedStatus: reuseStream.status,
  };
  const pass =
    status?.deviceCredentials === true &&
    viaQuery.status === 401 &&
    headerAuth.status === 200 &&
    ticketRes.status === 200 &&
    ticket.length >= 40 &&
    // "About two minutes" — the claim is the ORDER of magnitude (not seconds,
    // not hours), so the window is loose on purpose. An exact `<= 120_000`
    // fails on a 1 ms clock-read skew between the daemon and this process.
    ttlMs > 110_000 && ttlMs <= 125_000 &&
    operatorTicket.status === 403 &&
    operatorTicket.json?.error === 'tickets-are-for-devices' &&
    paneStream.status === 200 &&
    snapshot !== null &&
    eventStream.status === 200 &&
    attention !== null &&
    reuseStream.status === 200;
  record('S4 device-credential-and-ticket-streams', pass, evidence);
  return { ticket, paneStream, eventStream };
}

/**
 * S8 — token rotation revokes EVERY paired device.
 *
 * `wmux web --new-token` has always advertised "revoking every device already
 * paired", and before per-device credentials that held for free: every phone
 * presented the operator's token, so rotating it locked all of them out. Once a
 * device authenticated on its own `deviceId.secret`, rotation stopped touching
 * them — the operator was told the phones were revoked while every one of them
 * kept working. Nothing in the unit tests could see it, because the promise
 * lives in the CLI help and the bug lived in the wiring between two components
 * that were each individually correct.
 *
 * Proved here against the real daemon: two live devices, one RPC, and then the
 * three things that have to be true at once — the roster says revoked, the
 * credential is refused, and the stream that was already open is cut. An
 * established SSE never re-authenticates, so the last one is the only proof
 * that matters to a phone already watching a pane.
 */
async function scenarioRotationRevokesDevices(control, sessionId) {
  const deviceC = await pairDevice(control, 'harness-phone-C-rotate');
  const deviceD = await pairDevice(control, 'harness-phone-D-rotate');

  const ticketC = (await httpRequest('POST', '/api/stream-ticket', { auth: deviceC.credential, body: {} })).json;
  const paneC = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticketC.ticket)}`,
  );
  await paneC.waitFor((f) => f.event === 'snapshot');

  const beforeC = await httpRequest('GET', '/api/sessions', { auth: deviceC.credential });
  const beforeD = await httpRequest('GET', '/api/sessions', { auth: deviceD.credential });
  const tokenBefore = operatorToken;

  const rotateAt = Date.now();
  const rotated = await control.rpc('daemon.web.start', {
    port: WEB_PORT,
    host: WEB_HOST,
    allowInput: true,
    newToken: true,
  });
  const paneCEnded = await paneC.waitForEnd(5_000);

  const afterC = await httpRequest('GET', '/api/sessions', { auth: deviceC.credential });
  const afterD = await httpRequest('GET', '/api/sessions', { auth: deviceD.credential });
  const roster = await control.rpc('daemon.web.deviceList', {});
  const rosterC = (roster?.devices ?? []).find((d) => d.deviceId === deviceC.deviceId);
  const rosterD = (roster?.devices ?? []).find((d) => d.deviceId === deviceD.deviceId);

  const evidence = {
    tokenRotated: typeof rotated?.token === 'string' && rotated.token !== tokenBefore,
    before: { c: beforeC.status, d: beforeD.status },
    after: { c: afterC.status, d: afterD.status },
    afterReasons: { c: afterC.json?.reason, d: afterD.json?.reason },
    rosterRevokedAt: { c: rosterC?.revokedAt ?? null, d: rosterD?.revokedAt ?? null },
    paneCEnded,
    teardownMs: paneC.endedAt ? paneC.endedAt - rotateAt : null,
  };

  const pass =
    evidence.tokenRotated &&
    beforeC.status === 200 && beforeD.status === 200 &&
    afterC.status === 401 && afterD.status === 401 &&
    afterC.json?.reason === 'revoked' && afterD.json?.reason === 'revoked' &&
    typeof rosterC?.revokedAt === 'number' && typeof rosterD?.revokedAt === 'number' &&
    paneCEnded === true;

  if (typeof rotated?.token === 'string') operatorToken = rotated.token;
  paneC.close?.();
  record('S8 rotation-revokes-every-paired-device', pass, evidence);
}

/** S5 — revoke A; A dies everywhere, B does not notice. */
async function scenarioRevoke(control, sessionId, deviceA, streamsA, deviceB) {
  const ticketB = (await httpRequest('POST', '/api/stream-ticket', { auth: deviceB.credential, body: {} })).json;
  const paneB = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticketB.ticket)}`,
  );
  const eventsB = await SseClient.open(`/api/events?ticket=${encodeURIComponent(ticketB.ticket)}`);
  await paneB.waitFor((f) => f.event === 'snapshot');
  const bFramesBefore = paneB.frames.length;

  const openBeforeRevoke = {
    aPane: !streamsA.paneStream.ended,
    aEvents: !streamsA.eventStream.ended,
    bPane: !paneB.ended,
    bEvents: !eventsB.ended,
  };

  const revokeAt = Date.now();
  const revoke = await control.rpc('daemon.web.deviceRevoke', { deviceId: deviceA.deviceId });
  const aPaneEnded = await streamsA.paneStream.waitForEnd(3_000);
  const aEventsEnded = await streamsA.eventStream.waitForEnd(3_000);
  const teardownMs = {
    pane: streamsA.paneStream.endedAt ? streamsA.paneStream.endedAt - revokeAt : null,
    events: streamsA.eventStream.endedAt ? streamsA.eventStream.endedAt - revokeAt : null,
  };

  // The outstanding ticket must be dead too — closing the streams alone would
  // leave a revoked phone able to reopen one for up to the ticket TTL.
  const reuseAfterRevoke = await SseClient.open(
    `/api/stream?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(streamsA.ticket)}`,
  );
  const credentialAfterRevoke = await httpRequest('GET', '/api/sessions', { auth: deviceA.credential });
  const newTicketAfterRevoke = await httpRequest('POST', '/api/stream-ticket', { auth: deviceA.credential, body: {} });

  // B is not merely still connected — it still RECEIVES. Bytes written after
  // the revoke are the only proof that distinguishes "open socket" from "live
  // stream", and a teardown that took the wrong client with it would fail here.
  const marker = `M3-HARNESS-${RUN_TAG}`;
  await httpRequest('POST', `/api/input?session=${encodeURIComponent(sessionId)}`, {
    auth: operatorToken,
    body: `echo ${marker}\r`,
    headers: { 'Content-Type': 'text/plain' },
  });
  const bLiveFrame = await paneB.waitFor(
    (f) => f.event === 'data' && f.at > revokeAt && Buffer.from(f.data, 'base64').toString('utf8').includes(marker),
    8_000,
  );

  const roster = await control.rpc('daemon.web.deviceList', {});
  const rosterA = (roster?.devices ?? []).find((d) => d.deviceId === deviceA.deviceId) ?? null;
  const rosterB = (roster?.devices ?? []).find((d) => d.deviceId === deviceB.deviceId) ?? null;

  const evidence = {
    openBeforeRevoke,
    revokeResult: revoke,
    revokedDeviceStreams: {
      paneEnded: aPaneEnded,
      paneEndedCleanly: streamsA.paneStream.endedCleanly,
      paneSocketError: streamsA.paneStream.errored,
      eventsEnded: aEventsEnded,
      eventsEndedCleanly: streamsA.eventStream.endedCleanly,
      eventsSocketError: streamsA.eventStream.errored,
      msFromRevokeToEof: teardownMs,
    },
    outstandingTicketAfterRevoke: reuseAfterRevoke.status,
    credentialAfterRevoke: { status: credentialAfterRevoke.status, body: credentialAfterRevoke.json },
    newTicketAfterRevoke: { status: newTicketAfterRevoke.status, body: newTicketAfterRevoke.json },
    neighbour: {
      deviceId: deviceB.deviceId,
      paneStillOpen: !paneB.ended,
      eventsStillOpen: !eventsB.ended,
      framesBeforeRevoke: bFramesBefore,
      framesNow: paneB.frames.length,
      receivedPostRevokeMarker: bLiveFrame !== null,
      marker,
    },
    roster: { a: rosterA, b: rosterB },
  };
  const pass =
    revoke?.ok === true &&
    revoke?.closed === 2 &&
    aPaneEnded && aEventsEnded &&
    streamsA.paneStream.endedCleanly === true &&
    streamsA.eventStream.endedCleanly === true &&
    streamsA.paneStream.errored === null &&
    streamsA.eventStream.errored === null &&
    teardownMs.pane !== null && teardownMs.pane < 1_000 &&
    teardownMs.events !== null && teardownMs.events < 1_000 &&
    reuseAfterRevoke.status === 401 &&
    credentialAfterRevoke.status === 401 &&
    credentialAfterRevoke.json?.reason === 'revoked' &&
    newTicketAfterRevoke.status === 401 &&
    paneB.ended === false &&
    eventsB.ended === false &&
    bLiveFrame !== null &&
    rosterA?.revokedAt != null &&
    rosterB?.revokedAt == null;
  record('S5 revoke-cuts-streams-tickets-and-spares-the-neighbour', pass, evidence);

  paneB.close();
  eventsB.close();
  reuseAfterRevoke.close?.();
}

/**
 * S6 — the real browser. The only scenario that can see a directive fallback.
 *
 * Skipped rather than failed when playwright-core or a Chrome build is absent:
 * this harness has to be runnable on a machine that has neither, and a
 * "failure" that only means "no browser installed" trains people to ignore it.
 */
function resolveBrowser() {
  const chromePaths = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const executablePath = chromePaths.find((p) => fs.existsSync(p));
  let chromium = null;
  try {
    // Resolved through node's own lookup rather than a hardcoded
    // node_modules path: this repo's node_modules is a junction into the main
    // checkout, so a concurrent install elsewhere can make a literal file path
    // vanish for a moment and turn this into a phantom skip.
    ({ chromium } = createRequire(import.meta.url)('playwright-core'));
  } catch (err) {
    return { skipped: `playwright-core unavailable: ${String(err)}` };
  }
  if (!executablePath) return { skipped: 'no Chrome/Edge executable found' };
  return { chromium, executablePath };
}

async function scenarioRealBrowser(browserCtl) {
  if (!browserCtl) {
    record('S6 real-browser-zero-csp-violations', null, { skipped: 'browser unavailable' });
    return;
  }
  const { chromium, executablePath } = browserCtl;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const consoleErrors = [];
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective,
          blockedURI: e.blockedURI,
          line: e.lineNumber,
        });
      });
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    // Every non-2xx the PAGE asked for, so a console "403 (Forbidden)" is
    // attributable instead of guessed at. This is also the only look anything
    // has taken at app.js's ticket latch: the browser here holds an OPERATOR
    // token, so its `POST /api/stream-ticket` is refused by design and the
    // stream it opens afterwards proves the fallback path works.
    const failedResponses = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failedResponses.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
    });

    await page.goto(`http://${WEB_HOST}:${WEB_PORT}/?token=${operatorToken}`, { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    const probe = await page.evaluate(async () => {
      const out = {
        terminalConstructor: typeof window.Terminal,
        attentionFormatPublished: typeof window.wmuxAttentionFormat,
        keyBarButtons: document.querySelectorAll('#kb-keys button').length,
        fleetStripPresent: !!document.getElementById('fleet'),
        connectionLabel: document.getElementById('conn-label')?.textContent ?? null,
      };
      // A real xterm forces the runtime <style> injections a hash-only
      // style-src would refuse. `sheet === null` is what a blocked one looks
      // like; a live one reports its rule count.
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;width:640px;height:320px';
      document.body.appendChild(host);
      const term = new window.Terminal({ fontSize: 13, rows: 8, cols: 40 });
      term.open(host);
      term.write('csp harness probe\r\n');
      await new Promise((r) => setTimeout(r, 700));
      out.styleElements = Array.from(document.querySelectorAll('style')).map((s) => {
        try { return s.sheet ? s.sheet.cssRules.length : null; } catch { return 'cross-origin'; }
      });
      out.terminalRenderedText = (host.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        out.serviceWorkerRegistered = !!reg;
        out.serviceWorkerState = reg?.active?.state ?? reg?.installing?.state ?? null;
      } catch (e) { out.serviceWorkerRegistered = `error: ${String(e)}`; }
      return out;
    });
    const violations = await page.evaluate(() => window.__cspViolations);

    const evidence = {
      METHOD: 'REAL Chromium, securitypolicyviolation events collected from the live daemon page.',
      executablePath,
      violations,
      probe,
      nonSuccessResponses: failedResponses,
      consoleErrors: consoleErrors.slice(0, 10),
    };
    const pass =
      violations.length === 0 &&
      probe.terminalConstructor === 'function' &&
      probe.attentionFormatPublished === 'object' &&
      probe.keyBarButtons > 0 &&
      probe.fleetStripPresent === true &&
      // Every style element applied: none of them is a blocked (null-sheet) one.
      Array.isArray(probe.styleElements) &&
      probe.styleElements.length >= 4 &&
      probe.styleElements.every((n) => typeof n === 'number' && n >= 0) &&
      probe.terminalRenderedText.includes('csp harness probe') &&
      probe.serviceWorkerRegistered === true;
    record('S6 real-browser-zero-csp-violations', pass, evidence);
  } catch (err) {
    record('S6 real-browser-zero-csp-violations', false, { error: String(err?.stack ?? err) });
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

/**
 * S7 — the browser as a DEVICE, and the ticket renew nobody has ever executed.
 *
 * S6 loads the page with the OPERATOR token, so app.js latches
 * `ticketsUnavailable` on the first 403 and never touches the ticket path
 * again. Everything interesting therefore lives here: a browser that paired by
 * typing a code, holds a device credential, and must trade it for a ticket to
 * open any stream at all.
 *
 * The renew is forced the way it really happens rather than by waiting out the
 * 120s TTL: `daemon.web.stop` drops the in-memory ticket table, so when the
 * server comes back the browser's outstanding `?ticket=` is refused, its
 * EventSource lands in readyState CLOSED (which never retries on its own), and
 * `renewStreams()` has to take a fresh ticket and rebuild both channels. The
 * attention channel must come back carrying `?since=<cursor>` — that is #600's
 * replay, and without it every renew silently drops whatever arrived meanwhile.
 *
 * The claim is settled by a marker echoed into the pane AFTER the restart and
 * read back out of the browser's own terminal: HTTP chatter proves a request
 * was made, a visible byte proves the stream is alive.
 */
async function scenarioBrowserRenew(control, sessionId, browserCtl) {
  if (!browserCtl) {
    record('S7 browser-device-ticket-renew', null, { skipped: 'no browser available (see S6)' });
    return;
  }
  const { chromium, executablePath } = browserCtl;
  let browser = null;
  try {
    const started = await control.rpc('daemon.web.pairStart', { name: 'harness-browser-C' });
    if (!started?.ok || !started.code) throw new Error(`pairStart failed: ${JSON.stringify(started)}`);

    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const apiRequests = [];
    const violations = [];
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI });
      });
    });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/')) {
        apiRequests.push({ method: r.method(), path: u.pathname, query: u.search, at: Date.now() });
      }
    });

    // --- pair by typing the code, exactly as a phone does
    await page.goto(`http://${WEB_HOST}:${WEB_PORT}/pair`, { waitUntil: 'load' });
    await page.waitForSelector('#ov-code', { state: 'visible', timeout: 10_000 });
    await page.fill('#ov-code', started.code);
    await page.click('#ov-pair-go');
    await page.waitForFunction(() => window.location.pathname === '/', null, { timeout: 15_000 });
    await page.waitForTimeout(2_500);

    const roster = await control.rpc('daemon.web.deviceList', {});
    const deviceC = (roster?.devices ?? []).find((d) => d.name === 'harness-browser-C') ?? null;
    // localStorage is where the credential lives now — see app.js for why (the
    // manifest start_url carries no token, so a home-screen launch must find it
    // without a URL). sessionStorage is read only as the migration fallback the
    // page itself implements.
    const storedCredential = await page.evaluate(
      () => localStorage.getItem('wmux-web-token')
        ?? sessionStorage.getItem('wmux-web-token')
        ?? '');
    const paired = !!deviceC && storedCredential.startsWith(`${deviceC.deviceId}.`);

    const ticketReqsBefore = apiRequests.filter((r) => r.path === '/api/stream-ticket').length;
    const streamsBefore = apiRequests.filter((r) => r.path === '/api/stream' || r.path === '/api/events');
    const ticketOf = (q) => new URLSearchParams(q).get('ticket') ?? '';
    const firstTicket = ticketOf(streamsBefore.find((r) => ticketOf(r.query))?.query ?? '');
    // A device browser must NEVER put its durable credential in a URL.
    const credentialLeakedToUrl = apiRequests.some((r) => r.query.includes(storedCredential.split('.')[1] ?? ' '));

    // --- give the page an attention cursor to resume from
    //
    // It has to be a REAL pane notification, not a hook signal. `notify` and
    // `critical` are parsed by DaemonPTYBridge out of the pane's OUTPUT (OSC
    // 9/777/99); `daemon.hooks.signal` can only raise an `approval`, and
    // app.js's attention stream listens for `critical` and `notify` only — see
    // the finding in the report. So the pane emits an OSC 9 itself, via a
    // PowerShell one-liner typed into the cmd pane (the wire stays pure ASCII;
    // only PowerShell's own output carries the ESC byte, which is what the
    // bridge parses).
    // node, by ABSOLUTE path (process.execPath): the pane's cmd.exe inherits the
    // daemon's environment, which is not guaranteed to have powershell — or
    // anything else — on PATH. This is the one interpreter the harness knows
    // exists, because it is the one running the harness.
    const OSC_SEED = 'wmux harness attention seed';
    const oscCommand =
      `"${process.execPath}" -e "process.stdout.write(String.fromCharCode(27)+']9;${OSC_SEED}'+String.fromCharCode(7))"`;
    await httpRequest('POST', `/api/input?session=${encodeURIComponent(sessionId)}`, {
      auth: operatorToken,
      body: `${oscCommand}\r`,
      headers: { 'Content-Type': 'text/plain' },
    });
    // `wmux-web-attn-cursor` is app.js's CURSOR_KEY — the cursor that survives a
    // reload and goes back out as `?since=`.
    const cursorArrived = await page.waitForFunction(
      () => !!sessionStorage.getItem('wmux-web-attn-cursor'),
      null,
      { timeout: 20_000 },
    ).then(() => true, () => false);
    const cursorStored = await page.evaluate(() =>
      Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])));
    // Decisive discriminator if the cursor never lands: did the DAEMON record a
    // notify event at all? Server-side yes + browser-side no is a frontend bug;
    // server-side no means the pane never emitted and the harness is at fault.
    const backlog = await httpRequest('GET', '/api/events', { auth: operatorToken });
    const notifyEvents = (backlog.json?.events ?? []).filter((e) => e.kind === 'notify');

    // --- force the renew: bounce the server, which drops every outstanding ticket
    const restartAt = Date.now();
    await control.rpc('daemon.web.stop', {});
    await sleep(600);
    const restarted = await control.rpc('daemon.web.start', {
      port: WEB_PORT, host: WEB_HOST, allowInput: true,
    });
    operatorToken = restarted?.token ?? operatorToken;

    // The browser has to notice, take a NEW ticket, and rebuild both streams.
    const renewed = await page.waitForFunction(
      () => document.getElementById('conn-label')?.textContent === 'live',
      null,
      { timeout: 30_000 },
    ).then(() => true, () => false);
    await page.waitForTimeout(1_500);

    const afterRestart = apiRequests.filter((r) => r.at > restartAt);
    const ticketReqsAfter = afterRestart.filter((r) => r.path === '/api/stream-ticket').length;
    const streamsAfter = afterRestart.filter((r) => r.path === '/api/stream' || r.path === '/api/events');
    // NOT the first post-restart stream: EventSource retries on its own during
    // the down window, and those attempts still carry the STALE ticket. The
    // renew is proven by a stream opened with a ticket that is not the old one.
    const ticketsAfter = streamsAfter.map((r) => ticketOf(r.query)).filter(Boolean);
    const secondTicket = ticketsAfter.find((t) => t !== firstTicket) ?? '';
    const eventsWithSince = afterRestart.filter(
      (r) => r.path === '/api/events' && new URLSearchParams(r.query).get('since'),
    );

    // --- the settling claim: a byte written AFTER the restart reaches the page
    const marker = `RENEW-${RUN_TAG}`;
    await httpRequest('POST', `/api/input?session=${encodeURIComponent(sessionId)}`, {
      auth: operatorToken,
      body: `echo ${marker}\r`,
      headers: { 'Content-Type': 'text/plain' },
    });
    const markerVisible = await page.waitForFunction(
      (m) => (document.getElementById('term')?.innerText ?? '').includes(m),
      marker,
      { timeout: 15_000 },
    ).then(() => true, () => false);

    const pageViolations = await page.evaluate(() => window.__cspViolations);
    violations.push(...pageViolations);

    const evidence = {
      METHOD: 'REAL Chromium paired by typing a code — the first execution of app.js ticket latch + renew.',
      pairedByTypingCode: paired,
      deviceId: deviceC?.deviceId ?? null,
      storedCredentialShape: storedCredential
        ? `${storedCredential.split('.')[0]}.<secret ${(storedCredential.split('.')[1] ?? '').length} chars>`
        : null,
      credentialLeakedToUrl,
      beforeRestart: {
        ticketRequests: ticketReqsBefore,
        firstTicketPrefix: firstTicket ? `${firstTicket.slice(0, 8)}…` : null,
        streamsOpenedWithTicket: streamsBefore.filter((r) => ticketOf(r.query)).map((r) => r.path),
        streamsOpenedWithToken: streamsBefore.filter((r) => r.query.includes('token=')).map((r) => r.path),
      },
      attentionCursor: {
        seededBy: `OSC 9 emitted by the pane ("${OSC_SEED}")`,
        daemonRecordedNotifyEvents: notifyEvents.length,
        arrived: cursorArrived,
        sessionStorage: cursorStored,
      },
      restart: { stoppedAndRestarted: restarted?.running === true, reconnectedLive: renewed },
      afterRestart: {
        ticketRequests: ticketReqsAfter,
        ticketsSeenAfterRestart: ticketsAfter.map((t) => `${t.slice(0, 8)}…${t === firstTicket ? ' (stale, EventSource self-retry)' : ' (renewed)'}`),
        ticketActuallyRotated: !!secondTicket,
        eventsReopenedWithSince: eventsWithSince.map((r) => r.query),
        streamPaths: streamsAfter.map((r) => r.path + r.query.replace(/ticket=[^&]+/, 'ticket=…')),
      },
      postRenewMarkerVisibleInTerminal: markerVisible,
      marker,
      cspViolations: violations,
    };
    const pass =
      paired &&
      credentialLeakedToUrl === false &&
      ticketReqsBefore >= 1 &&
      !!firstTicket &&
      renewed &&
      ticketReqsAfter >= 1 &&
      cursorArrived &&
      !!secondTicket &&
      eventsWithSince.length >= 1 &&
      markerVisible &&
      violations.length === 0;
    record('S7 browser-device-ticket-renew', pass, evidence);
  } catch (err) {
    record('S7 browser-device-ticket-renew', false, { error: String(err?.stack ?? err) });
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

// === Main ==================================================================

let control = null;
let exitCode = 2;
const liveSessions = new Set();

try {
  console.log(`[setup] TEST_HOME=${TEST_HOME}`);
  console.log(`[setup] WMUX_DATA_SUFFIX=${DATA_SUFFIX} (data dir ${WMUX_DIR})`);
  console.log(`[setup] daemon bundle mtime=${fs.statSync(DAEMON_BUNDLE).mtime.toISOString()}`);
  console.log(`[setup] terminal.html mtime=${fs.statSync(WEB_ASSETS).mtime.toISOString()}`);
  console.log(`[setup] web ${WEB_HOST}:${WEB_PORT}`);

  daemon = spawnDaemon();
  const pipeName = await waitForPipeFile();
  console.log(`[setup] daemon pid=${daemon.pid} listening on ${pipeName}`);

  control = await PipeClient.connect(pipeName);
  const ping = await control.rpc('daemon.ping', {});
  if (ping?.status !== 'ok') throw new Error(`daemon.ping unhealthy: ${JSON.stringify(ping)}`);

  // allowInput so S5 can write a marker into the pane and prove the surviving
  // device's stream is still LIVE, not merely still connected.
  const webInfo = await control.rpc('daemon.web.start', {
    port: WEB_PORT,
    host: WEB_HOST,
    allowInput: true,
  });
  if (!webInfo?.running || !webInfo.token) throw new Error(`web start failed: ${JSON.stringify(webInfo)}`);
  operatorToken = webInfo.token;
  console.log(`[setup] web server ${webInfo.host}:${webInfo.port} allowInput=${webInfo.allowInput}`);

  const sessionId = `m3-csp-${RUN_TAG}`;
  await control.rpc('daemon.createSession', {
    id: sessionId, cmd: SHELL, cwd: PANE_CWD, cols: 120, rows: 30,
  });
  liveSessions.add(sessionId);
  await control.rpc('daemon.attachSession', { id: sessionId }).catch(() => {});
  await sleep(1_200);

  const header = await scenarioCspHeader();
  await scenarioHeaderEverywhere(sessionId, header);

  const deviceA = await pairDevice(control, 'harness-phone-A');
  const deviceB = await pairDevice(control, 'harness-phone-B');
  console.log(`[setup] paired A=${deviceA.deviceId} B=${deviceB.deviceId}`);

  const streamsA = await scenarioDeviceTicketStreams(control, sessionId, deviceA);
  await scenarioRevoke(control, sessionId, deviceA, streamsA, deviceB);
  streamsA.paneStream.close?.();
  streamsA.eventStream.close?.();

  const browserCtl = resolveBrowser();
  if (browserCtl.skipped) {
    record('S6 real-browser-zero-csp-violations', null, { skipped: browserCtl.skipped });
    record('S7 browser-device-ticket-renew', null, { skipped: browserCtl.skipped });
  } else {
    await scenarioRealBrowser(browserCtl);
    // LAST, deliberately: it bounces the web server, which rotates the operator
    // token and drops every ticket the earlier scenarios were holding.
    await scenarioBrowserRenew(control, sessionId, browserCtl);
  }

  // LAST: rotation invalidates every device and the operator token, so any
  // scenario after this one would be running against credentials it no
  // longer holds.
  await scenarioRotationRevokesDevices(control, sessionId);

  const failures = report.filter((r) => r.pass === false);
  const skipped = report.filter((r) => r.pass === null);
  exitCode = failures.length === 0 ? 0 : 1;

  console.log('\n=== Evidence ===');
  for (const r of report) console.log(JSON.stringify(r, null, 2));
  console.log('\n=== Summary ===');
  for (const r of report) console.log(`${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}`);
  console.log(`\n${report.length - failures.length - skipped.length} pass, ${failures.length} fail, ${skipped.length} skipped`);
} catch (err) {
  console.error('[fatal]', err?.stack ?? err);
  console.error('--- daemon output tail ---');
  console.error(daemonLog.join('').slice(-6000));
  exitCode = report.length > 0 ? 1 : 2;
} finally {
  try {
    if (control) {
      for (const id of liveSessions) await control.rpc('daemon.destroySession', { id }).catch(() => {});
    }
  } catch { /* ignore */ }
  try { control?.close(); } catch { /* ignore */ }
  if (daemon && !daemon.killed) {
    try { daemon.kill('SIGKILL'); } catch { /* ignore */ }
  }
  await sleep(500);
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(exitCode);
