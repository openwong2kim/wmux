/**
 * The program that runs INSIDE each REPL child process.
 *
 * It is a string, not a module, on purpose: the MCP server ships as a single
 * esbuild bundle (`dist/mcp-bundle/index.js`), so a second entry point would
 * need its own build step, its own copy into the packaged app, and its own
 * "where is my file when relocated" resolution. An embedded string has none of
 * that and cannot drift from the parent that speaks its protocol.
 *
 * Topology and why each piece is where it is:
 *
 *     MCP server (broker or stdio child)
 *        │  ┌── ipc (fd 3) ───────────────┐   the eval protocol: {id,code,timeoutMs}
 *        │  │                             │   out, {id,ok,result|error} back
 *        └──┤  node -e <this, base64'd>   │
 *           │                             │
 *           └── stdout / stderr (pipes) ──┘   the USER CODE's own output
 *
 * Splitting the protocol onto the IPC channel is what lets stdout stay verbatim
 * user output. A single-stream design would have to frame and escape every
 * console.log, and any user code writing a frame-shaped line could forge a
 * protocol message.
 *
 * Evaluation uses `vm.runInThisContext`, NOT `vm.runInContext` on a fresh
 * sandbox. A fresh sandbox has no `setTimeout`, no `fetch`, no `TextEncoder` —
 * measured, not assumed — so it would need a hand-curated global list that goes
 * stale with every Node release and fails as `ReferenceError: fetch is not
 * defined`. Running in the child's real context gives the whole standard
 * library for free, and top-level `let`/`const` still persist between calls
 * because a Script's top-level lexical declarations live in the CONTEXT's
 * global lexical scope, which outlives the individual script. `require` is the
 * one thing missing (it is module-scoped, not global), so it is installed
 * explicitly.
 */

/**
 * Sentinel the parent matches to detect a top-level-await snippet, so the retry
 * fires on V8's actual message rather than on a guess about the user's code.
 */
export const TOP_LEVEL_AWAIT_MARKER = 'await is only valid in';

/** Sentinel for a `let`/`const` re-declared against a still-live session. */
export const ALREADY_DECLARED_MARKER = 'has already been declared';

/** V8's message when `vm`'s synchronous watchdog fires. */
export const SCRIPT_TIMEOUT_MARKER = 'Script execution timed out';

/**
 * Child program source. Kept dependency-free and small enough to travel as a
 * command-line argument on every platform (Windows caps a command line at
 * 32767 characters; this is well under 8 KB even base64-encoded).
 */
export const REPL_RUNNER_SOURCE = String.raw`
'use strict';
const vm = require('vm');
const util = require('util');
const path = require('path');
const { createRequire } = require('module');

// Capture everything the runner needs BEFORE user code runs. User code shares
// this global context and may reassign process, console, or require; binding
// early means a script that clobbers a global breaks only itself.
const send = process.send.bind(process);
const stderrWrite = process.stderr.write.bind(process.stderr);

// require() is module-scoped, so a script evaluated in the global context does
// not see it. Bind one to the session cwd so require('./local') resolves the
// way it would in a file sitting there.
globalThis.require = createRequire(path.join(process.cwd(), '[wmux-repl]'));
globalThis.__wmuxRepl = { version: 1 };

// The parent's IPC channel closing is the ONLY reaping signal that survives the
// parent being SIGKILLed (a crashed broker cannot run cleanup). Without this a
// broker crash would orphan every REPL child on the machine, forever.
process.on('disconnect', () => process.exit(0));

// A stray timer from an earlier eval throwing must not take the session down
// with it — that would silently destroy state the caller believes it still has.
// Report to stderr instead, where it surfaces in the next run's output.
process.on('uncaughtException', (err) => {
  try { stderrWrite('[repl] uncaught exception in background code: ' + (err && err.stack || err) + '\n'); } catch (_) { /* stderr gone */ }
});
process.on('unhandledRejection', (reason) => {
  try { stderrWrite('[repl] unhandled rejection in background code: ' + (reason && reason.stack || reason) + '\n'); } catch (_) { /* stderr gone */ }
});

function describe(value) {
  return util.inspect(value, {
    depth: 3,
    maxArrayLength: 200,
    maxStringLength: 8192,
    breakLength: 100,
    getters: false,
  });
}

// Wrap a top-level-await snippet so it can run as a Script.
//
// The wrapper is an async IIFE, and an IIFE with a BLOCK body has no completion
// value: in "await f(); result" the wrapper evaluates result and throws it
// away, and that is exactly the value the caller asked for. Node's own REPL
// solves this with a full parse and rewrite; we have no parser and want no
// dependency, so we use the shape agents actually write: the last line is the
// expression they want back. Turn that line into a return, then COMPILE the
// result and fall back to the plain wrapper if the rewrite did not produce
// valid syntax. The
// compile check is what makes the heuristic safe — a last line that was really
// the tail of a multi-line expression, or a declaration, simply does not
// survive it, and the caller gets the un-rewritten behavior instead of a
// mangled program.
function wrapAsync(code) {
  const trimmed = code.replace(/\s+$/, '').replace(/;+$/, '');
  // Candidate split points, scanned from the end: statement separators are
  // newlines and semicolons, and a one-liner like "const x = await f(); x" only
  // has the latter. Bounded so a long script cannot turn this into a parse
  // storm; 40 trailing statements is far past anything a REPL call contains.
  const splits = [];
  for (let i = trimmed.length - 1; i >= 0 && splits.length < 40; i--) {
    const ch = trimmed[i];
    if (ch === '\n' || ch === ';') splits.push(i);
  }
  for (let s = 0; s < splits.length; s++) {
    const at = splits[s];
    const tail = trimmed.slice(at + 1).trim();
    if (tail === '') continue;
    const head = trimmed.slice(0, at + 1);
    const rewritten = '(async () => {\n' + head + '\nreturn (' + tail + ');\n})()';
    try {
      new vm.Script(rewritten);
      return rewritten;
    } catch (_) { /* that split did not yield valid syntax; try an earlier one */ }
  }
  // No split needed or none worked: the whole snippet may itself be one
  // expression, which the wrapper can return directly.
  const whole = '(async () => {\nreturn (' + trimmed + ');\n})()';
  try {
    new vm.Script(whole);
    return whole;
  } catch (_) { /* statements, not an expression */ }
  return '(async () => {\n' + code + '\n})()';
}

// Cut the runner's own frames off a stack.
//
// Every error otherwise ends in six frames of vm/IPC plumbing that describe how
// this file is built and nothing about what the caller wrote. They are pure
// noise, they are identical on every error, and in an agent surface they are
// paid for in context on every failure. Keep the message and the frames above
// the first internal one; when the error is entirely internal (a vm timeout)
// that leaves just the message, which is the whole story anyway.
const INTERNAL_FRAME = /^\s+at (Script\.runInThisContext|Object\.runInThisContext|process\.eval|process\.emit|emit \(node:internal|process\.processTicksAndRejections)/;

function trimStack(error) {
  const raw = String(error && error.stack || error);
  const lines = raw.split('\n');
  const cut = lines.findIndex((line) => INTERNAL_FRAME.test(line));
  return cut === -1 ? raw : lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

function fail(id, error) {
  send({ id: id, ok: false, error: trimStack(error) });
}

process.on('message', (msg) => {
  if (!msg || typeof msg.code !== 'string') return;
  const id = msg.id;
  // The vm timeout is a watchdog on SYNCHRONOUS execution only. It is the layer
  // that stops a runaway loop WITHOUT losing session state; the parent's hard
  // deadline is the separate layer that handles a promise that never settles.
  const options = { timeout: msg.timeoutMs, displayErrors: true, filename: 'wmux-repl' };
  let value;
  try {
    value = vm.runInThisContext(msg.code, options);
  } catch (err) {
    const text = String(err && err.message || err);
    if (err instanceof SyntaxError && text.indexOf('await is only valid in') !== -1) {
      // Top-level await: V8 will not parse it as a Script, so re-run wrapped.
      // Declarations inside the wrapper are function-scoped and do NOT persist;
      // the tool description tells callers to assign to a global instead.
      try {
        value = vm.runInThisContext(wrapAsync(msg.code), options);
      } catch (retryErr) {
        fail(id, retryErr);
        return;
      }
    } else {
      fail(id, err);
      return;
    }
  }
  // A returned promise is awaited so the caller sees the resolved value rather
  // than "Promise { <pending> }" — the whole point of a top-level-await REPL.
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).then(
      (resolved) => send({ id: id, ok: true, result: describe(resolved) }),
      (err) => fail(id, err),
    );
    return;
  }
  send({ id: id, ok: true, result: describe(value) });
});

send({ ready: true });
`;

/**
 * The `node -e` argument that boots the runner.
 *
 * Base64 rather than the raw source because the source travels as a single
 * command-line argument through three different escaping regimes (POSIX exec,
 * Windows CreateProcess, and Node's own argument quoting). Base64 is pure
 * ASCII with no quotes, newlines, or backslashes, so none of those regimes has
 * anything to mangle.
 */
export function buildRunnerBootstrap(): string {
  const encoded = Buffer.from(REPL_RUNNER_SOURCE, 'utf8').toString('base64');
  return `eval(Buffer.from("${encoded}","base64").toString("utf8"))`;
}
