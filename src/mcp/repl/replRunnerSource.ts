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

// inspect's maxStringLength and maxArrayLength bound individual strings and
// arrays, but NOT the number of keys on a plain object, so one
// Object.fromEntries over a million entries renders hundreds of megabytes. The
// parent truncates too, but only AFTER that string has crossed IPC and landed
// in the shared broker's heap, which is precisely the process that must not be
// asked to hold it. Cap here, at the only place the big string can be avoided.
const CHILD_RESULT_CAP = 64 * 1024;

function describe(value) {
  let rendered;
  try {
    rendered = util.inspect(value, {
      depth: 3,
      maxArrayLength: 200,
      maxStringLength: 8192,
      breakLength: 100,
      getters: false,
    });
  } catch (err) {
    // A Proxy with a throwing trap makes inspect itself throw. Without this the
    // reply never goes out and the parent can only end the session on its hard
    // deadline, reporting a hang for what is really an unprintable value.
    return '<value could not be inspected: ' + String(err && err.message || err) + '>';
  }
  if (rendered.length > CHILD_RESULT_CAP) {
    return rendered.slice(0, CHILD_RESULT_CAP) +
      '\n… value truncated in the REPL process (' + rendered.length + ' chars rendered) …';
  }
  return rendered;
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
    // Automatic semicolon insertion trap: a newline before one of these does
    // NOT end a statement, so "const a = await f()\n[0].join()" is ONE
    // expression. Splitting there yields two halves that each compile fine and
    // together mean something else entirely, which is the worst failure mode
    // available here - a silently different program and a wrong answer. Only
    // an explicit semicolon can precede such a tail.
    // 96 is a backtick (a tagged-template continuation); it cannot appear in
    // the literal below without ending this runner's own template.
    if (
      trimmed[at] !== ';' &&
      ('[(+-*/,.?:=<>&|'.indexOf(tail[0]) !== -1 || tail.charCodeAt(0) === 96)
    ) continue;
    // A trailing declaration or control statement must never be rewritten. Some
    // of them WOULD compile inside "return (...)" - a function or class
    // declaration becomes an expression - and the result is a wrong return
    // value plus a definition trapped in the wrapper scope instead of the
    // session. Compiling is not the same as meaning the same thing.
    if (/^(function|class|async|let|const|var|return|if|for|while|do|switch|try|throw|import|export)\b/.test(tail)) {
      continue;
    }
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

// Classify HERE, where the real Error object is, and ship the verdict as a
// field. The parent must not re-derive it by matching substrings against the
// error text: that text can be anything the caller's own code throws, so a
// script that throws "Script execution timed out" would make the tool report a
// watchdog stop that never happened.
function classify(error, timeoutMs) {
  const message = String(error && error.message || error);
  // V8's watchdog error carries this EXACT message and, because it is raised by
  // the engine rather than by the script, no frame inside the evaluated code.
  // A script that throws the same text still has its own wmux-repl frame, which
  // is what keeps it from impersonating the watchdog.
  if (
    message === 'Script execution timed out after ' + timeoutMs + 'ms' &&
    String(error && error.stack || '').indexOf('wmux-repl') === -1
  ) {
    return 'timeout';
  }
  if (error instanceof SyntaxError && message.indexOf('has already been declared') !== -1) {
    return 'redeclare';
  }
  return undefined;
}

function fail(id, error, timeoutMs) {
  send({ id: id, ok: false, error: trimStack(error), kind: classify(error, timeoutMs) });
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
        fail(id, retryErr, msg.timeoutMs);
        return;
      }
    } else {
      fail(id, err, msg.timeoutMs);
      return;
    }
  }
  // A returned promise is awaited so the caller sees the resolved value rather
  // than "Promise { <pending> }" — the whole point of a top-level-await REPL.
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).then(
      (resolved) => send({ id: id, ok: true, result: describe(resolved) }),
      (err) => fail(id, err, msg.timeoutMs),
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
