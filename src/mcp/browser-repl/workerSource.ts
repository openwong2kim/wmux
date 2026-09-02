/**
 * Source of the `browser_repl` worker thread, kept as a string for the same
 * reason `replRunnerSource.ts` is: the MCP server ships as one bundled file
 * (`tsconfig.mcp.json`) with nothing on disk beside it for a Worker to load.
 * `new Worker(source, { eval: true })` runs it as a CommonJS module, so
 * `require` is module-scoped and invisible to the evaluated snippet — the
 * snippet sees exactly `browser`, `console`, `sleep`, and its own globals.
 *
 * Why a worker and not a vm context: every browser handler lives in the main
 * thread, so the snippet must call back into it. A vm context bridged with
 * host functions hands the snippet host-realm Promises and Errors, and any of
 * those reaches `process` through `.constructor.constructor`. A thread boundary
 * is structured clone — functions, Promises, and Errors cannot cross it at all,
 * and `worker.terminate()` stops a `while (true)` that no flag could.
 *
 * Not a sandbox claim. `repl_run` already gives the same caller an unrestricted
 * Node process; the worker exists for robustness (kill on timeout, no leaked
 * host objects), not for confinement.
 *
 * Protocol (main ⇄ worker, structured clone):
 *   main → worker  { type: 'init', tools: string[] }
 *   main → worker  { type: 'run', id, code }
 *   worker → main  { type: 'ready' }
 *   worker → main  { type: 'console', text }            captured console.*
 *   worker → main  { type: 'call', callId, name, args }  browser.<name>(args)
 *   main → worker  { type: 'callResult', callId, ok, value | error }
 *   worker → main  { type: 'result', id, ok, result | error }
 */
export const BROWSER_REPL_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort } = require('worker_threads');
const vm = require('vm');
const util = require('util');

const RESULT_CAP = 64 * 1024;

function describe(value) {
  if (typeof value === 'string') return value;
  let rendered;
  try {
    rendered = util.inspect(value, { depth: 4, maxArrayLength: 200, maxStringLength: 8192, breakLength: 100, getters: false });
  } catch (err) {
    return '<value could not be inspected: ' + String(err && err.message || err) + '>';
  }
  if (rendered.length > RESULT_CAP) {
    return rendered.slice(0, RESULT_CAP) + '\n… value truncated in the worker (' + rendered.length + ' chars rendered) …';
  }
  return rendered;
}

// Same last-expression rewrite as the Node REPL runner: an async IIFE with a
// block body has no completion value, so the trailing expression statement is
// turned into a return when — and only when — the rewrite still compiles.
function wrapAsync(code) {
  const trimmed = code.replace(/\s+$/, '').replace(/;+$/, '');
  const splits = [];
  for (let i = trimmed.length - 1; i >= 0 && splits.length < 40; i--) {
    const ch = trimmed[i];
    if (ch === '\n' || ch === ';') splits.push(i);
  }
  for (let s = 0; s < splits.length; s++) {
    const at = splits[s];
    const tail = trimmed.slice(at + 1).trim();
    if (tail === '') continue;
    if (trimmed[at] !== ';' && ('[(+-*/,.?:=<>&|'.indexOf(tail[0]) !== -1 || tail.charCodeAt(0) === 96)) continue;
    if (/^(function|class|async|let|const|var|return|if|for|while|do|switch|try|throw|import|export)\b/.test(tail)) continue;
    const rewritten = '(async () => {\n' + trimmed.slice(0, at + 1) + '\nreturn (' + tail + ');\n})()';
    try { new vm.Script(rewritten); return rewritten; } catch (_) { /* try an earlier split */ }
  }
  const whole = '(async () => {\nreturn (' + trimmed + ');\n})()';
  try { new vm.Script(whole); return whole; } catch (_) { /* statements, not an expression */ }
  return '(async () => {\n' + code + '\n})()';
}

const INTERNAL_FRAME = /^\s+at (Script\.runInThisContext|Object\.runInThisContext|MessagePort\.|process\.processTicksAndRejections|\[kOnMessage\]|node:internal)/;
function trimStack(error) {
  const raw = String(error && error.stack || error);
  const lines = raw.split('\n');
  const cut = lines.findIndex((line) => INTERNAL_FRAME.test(line));
  return cut === -1 ? raw : lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

// ── browser.* bridge ──────────────────────────────────────────────────────
let nextCallId = 1;
const pending = new Map();

function callTool(name, args) {
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return Promise.reject(new TypeError('browser.' + name + '(args): args must be a plain object'));
  }
  const callId = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject, name });
    parentPort.postMessage({ type: 'call', callId, name, args: args || {} });
  });
}

function installBrowser(tools) {
  const browser = {};
  for (const name of tools) {
    Object.defineProperty(browser, name, { value: (args) => callTool(name, args), enumerable: true });
  }
  Object.freeze(browser);
  Object.defineProperty(globalThis, 'browser', { value: browser, enumerable: true });
}

function emit(text) {
  parentPort.postMessage({ type: 'console', text: text + '\n' });
}
const captured = {};
for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir']) {
  captured[level] = (...args) => emit(util.format(...args));
}
captured.table = captured.log;
globalThis.console = captured;
globalThis.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (err) => emit('[browser_repl] uncaught exception in background code: ' + trimStack(err)));
process.on('unhandledRejection', (reason) => emit('[browser_repl] unhandled rejection in background code: ' + trimStack(reason)));

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    installBrowser(Array.isArray(msg.tools) ? msg.tools : []);
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'callResult') {
    const entry = pending.get(msg.callId);
    if (!entry) return;
    pending.delete(msg.callId);
    if (msg.ok) {
      entry.resolve(msg.value);
    } else {
      // Rebuilt in THIS realm from a string; the main thread's Error never crosses.
      const error = new Error(String(msg.error));
      error.name = 'BrowserToolError';
      error.tool = entry.name;
      entry.reject(error);
    }
    return;
  }
  if (msg.type === 'run' && typeof msg.code === 'string') {
    const id = msg.id;
    const options = { displayErrors: true, filename: 'browser_repl' };
    const fail = (error) => {
      let rendered = trimStack(error);
      // Top-level let/const survive between runs, so re-running a snippet that
      // declares one is a SyntaxError here — a surprise the agent would otherwise
      // read as a bug in its own code.
      if (error instanceof SyntaxError && /has already been declared/.test(String(error.message))) {
        rendered += '\n(hint: this runtime keeps top-level declarations between browser_repl calls — reuse the name without let/const, pick another, or assign to globalThis)';
      }
      parentPort.postMessage({ type: 'result', id, ok: false, error: rendered });
    };
    let value;
    try {
      value = vm.runInThisContext(msg.code, options);
    } catch (err) {
      const text = String(err && err.message || err);
      if (err instanceof SyntaxError && text.indexOf('await is only valid in') !== -1) {
        try { value = vm.runInThisContext(wrapAsync(msg.code), options); } catch (retryErr) { fail(retryErr); return; }
      } else { fail(err); return; }
    }
    Promise.resolve(value).then(
      (resolved) => parentPort.postMessage({ type: 'result', id, ok: true, result: describe(resolved) }),
      fail,
    );
  }
});
`;
