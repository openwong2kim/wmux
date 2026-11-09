/**
 * Source of the hang watchdog's Worker, kept as a string for the same reason as
 * src/mcp/browser-repl/workerSource.ts: the daemon ships as one bundled file
 * (`build:daemon` has one esbuild entry) with nothing beside it for a Worker to
 * load, and a separate entry that the bundle or a staged copy missed would only
 * show in a packaged build.
 *
 * The Worker spends its life asleep in Atomics.wait. Main's verdict on a daemon
 * that stopped answering reads the whole process's CPU time, and any rise counts
 * as progress (src/shared/daemon/daemonProgress.ts), so after a stall is seen
 * this thread uses no CPU until the heartbeat moves again. A timer loop here
 * would keep a wedged daemon alive for the 15 minutes of main's overall cap.
 *
 * Only the fields named below are read from a paused call frame. A frame also
 * carries `this` and its scope chain; those are never touched, and nothing here
 * asks the debugger for a value.
 */
export const HANG_WATCHDOG_WORKER_SOURCE = String.raw`
'use strict';
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');

const { cells, BEAT, NAP, pollMs, staleReads, timeboxMs, minGapMs, keptPerRun, logsDir, pid, version, homes } = workerData;
const shared = new Int32Array(cells);
const MAX_FRAMES = 64;
const MAX_NAME = 200;
const MAX_URL = 300;
const MAX_BYTES = 16 * 1024;

const written = [];
let lastDumpAt = -Infinity;

function clean(text, max) {
  return String(text).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, max);
}

// A home folder names the user; the rest of the path names the code.
function shortUrl(url) {
  let text = String(url).replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1');
  try { text = decodeURI(text); } catch { /* left as it was */ }
  for (const home of homes) {
    const homeDir = home.replace(/\\/g, '/');
    if (homeDir && text.toLowerCase().startsWith(homeDir.toLowerCase() + '/')) return '~' + text.slice(homeDir.length);
  }
  return text;
}

function frameLine(frame, urls) {
  const location = frame.location;
  const url = urls.get(location.scriptId) || frame.url || '(unknown)';
  const name = frame.functionName || '(anonymous)';
  return clean(name, MAX_NAME) + ' ' + clean(shortUrl(url), MAX_URL) + ':' + (location.lineNumber + 1) + ':' + (location.columnNumber + 1);
}

function write(lines) {
  const at = Date.now();
  const head = [
    'wmux daemon hang evidence',
    'pid: ' + pid,
    'version: ' + version,
    'written: ' + new Date(at).toISOString(),
    'main thread silent for: over ' + Math.round((pollMs * staleReads) / 1000) + 's',
  ];
  fs.mkdirSync(logsDir, { recursive: true });
  const body = (head.concat(lines).join('\n') + '\n').slice(0, MAX_BYTES);
  const file = path.join(logsDir, 'daemon-hang-' + pid + '-' + at + '.txt');
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  written.push(file);
  // This run's own files only: the folder is not walked while the daemon is stuck.
  if (written.length > keptPerRun) fs.unlinkSync(written.shift());
}

// Asks once, gives up at the time box, and always ends the session: a session
// that ends resumes the main thread if the debugger still holds it.
function dump(done) {
  const session = new inspector.Session();
  const urls = new Map();
  const cpuBefore = process.cpuUsage();
  const askedAt = Date.now();
  let settled = false;
  let box = null;
  const finish = (lines) => {
    if (settled) return;
    settled = true;
    clearTimeout(box);
    try { session.disconnect(); } catch { /* it is going away either way */ }
    try { write(lines); } catch { /* evidence must never be what breaks the daemon */ }
    setImmediate(done);
  };
  box = setTimeout(() => {
    const cpu = process.cpuUsage(cpuBefore);
    finish([
      'state: below JavaScript',
      'detail: no JavaScript frame was reachable in ' + timeboxMs + ' ms: the main thread is in a native call or a blocking system call, not a JavaScript loop',
      'process cpu in that wait: ' + Math.round((cpu.user + cpu.system) / 1000) + ' ms',
    ]);
  }, timeboxMs);
  try {
    session.connectToMainThread();
    session.on('Debugger.scriptParsed', (message) => { urls.set(message.params.scriptId, message.params.url); });
    session.on('Debugger.paused', (message) => {
      const frames = message.params.callFrames.slice(0, MAX_FRAMES).map((frame) => frameLine(frame, urls));
      session.post('Debugger.resume');
      finish(['state: JavaScript', 'detail: paused ' + (Date.now() - askedAt) + ' ms after asking', 'frames:'].concat(frames.map((f) => '  ' + f)));
    });
    session.post('Debugger.enable');
    session.post('Debugger.pause');
  } catch (err) {
    finish(['state: unknown', 'detail: the debugger could not be reached: ' + clean(err && err.name, MAX_NAME)]);
  }
}

// Sleeps on a cell nothing notifies. Counting reads rather than comparing clocks
// keeps a machine that slept from looking like a stall: its one late wake is one read.
function watch() {
  let seen = Atomics.load(shared, BEAT);
  let still = 0;
  for (;;) {
    Atomics.wait(shared, NAP, 0, pollMs);
    const beat = Atomics.load(shared, BEAT);
    if (beat !== seen) {
      seen = beat;
      still = 0;
    } else if (++still >= staleReads) {
      break;
    }
  }
  const quiet = () => {
    Atomics.wait(shared, BEAT, seen); // No timeout: no CPU until the main thread beats again.
    setImmediate(watch);
  };
  if (Date.now() - lastDumpAt < minGapMs) return quiet();
  lastDumpAt = Date.now();
  dump(quiet);
}

watch();
`;
