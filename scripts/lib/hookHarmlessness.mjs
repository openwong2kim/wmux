// P-5 — the A/B harmlessness gate for wmux's agent hooks.
//
// wmux installs observation hooks into other people's agents. #898 is what
// happens when one of those hooks says something the host reads as an
// instruction: the Claude Code permission gate emitted `ask` on every
// "wmux has no opinion" path, and `ask` is not neutral — it forces a prompt
// and overrides the session's permission mode. A bypassPermissions session
// started asking for permission to run `Read`, and the documented escape
// hatch (`WMUX_GATE=0`) emitted `ask` too, so there was no way to turn it off.
//
// "Observation hooks are harmless" is a claim, not a fact. This harness
// MEASURES it. The claim being tested is precise:
//
//   Installing a wmux hook must be indistinguishable, to the host, from
//   installing a hook that provably has no opinion.
//
// So every case runs twice — a CONTROL (a no-op hook: drain stdin, exit 0,
// write nothing) and a TREATMENT (the real wmux hook, invoked byte-for-byte
// the way the host's own manifest invokes it) — and the two are compared.
//
// The three pass criteria from the plan (§6), and how each is measured here:
//
//   1. Approval/denial set identical.
//      The host's decision is a pure function of (exit code, stdout). Each
//      host's contract is pinned in HOST_CONTRACTS below with its source, and
//      classifyDecision() applies it. Control and treatment must classify the
//      same. For an observation hook that means `none` — and stdout must be
//      byte-empty, which is the direct #898 regression pin.
//
//   2. Completion and duration.
//      In a live A/B this is the agent's task duration (±50%). Here the host
//      is simulated, so the equivalent — and the thing that actually reaches
//      the agent — is the hook's own wall clock. A hook that hangs blows the
//      budget; a hook that never completes is caught by the same timeout.
//      The ±50% band is not applicable against a no-op baseline (a no-op is
//      pure node startup), so this layer asserts an ABSOLUTE per-hook budget
//      instead. The ±50% comparison lives in the live layer.
//
//   3. Hook process lifetime.
//      Measured without walking the process tree: the host holds the hook's
//      stdout/stderr pipes and waits on them. If any descendant outlives the
//      hook while holding those pipes, 'close' fires later than 'exit' — or
//      never. So closeMs - exitMs is the survivor signal, and it is exactly
//      the survivor that would matter to the host. stdin drain is measured by
//      writing a payload larger than the bridge's own cap and requiring the
//      write to settle (ok or EPIPE) rather than deadlock.
//
// Deliberately NOT tested here: whether the signal actually reached wmux.
// This harness runs with no daemon reachable on purpose — "wmux is not
// running" is the single most common state a plugin user is in, and it is the
// state #898 broke. Delivery is covered by the integration's own tests.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, unlinkSync, readdirSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');

// The no-op reference hook. This is the "provably has no opinion" control:
// it consumes stdin to the end (so the host's write always completes), writes
// nothing, and exits 0. Anything the real hook does beyond this is a
// difference the host can observe.
const NOOP_HOOK_SOURCE = [
  'process.stdin.resume();',
  "process.stdin.on('data', () => {});",
  "process.stdin.on('error', () => {});",
  "process.stdin.on('end', () => { process.exitCode = 0; });",
].join('\n');

// ----- Host contracts -----------------------------------------------------
//
// How each host turns (exit code, stdout) into a decision. These are the
// documented contracts, not guesses; a wrong entry here would make the whole
// harness lie, so each one carries its source.

export const HOST_CONTRACTS = {
  // Claude Code (and openclaude, which reuses the same hook runner).
  // "Exit code 0 with no output means the hook has no decision to report, so
  // the tool call continues through the normal permission flow." Exit 2 is
  // "do not let this action proceed" and feeds stderr to the model. Any other
  // non-zero is a non-blocking error the host logs and moves past.
  // `ask` is a DECISION, not a default — measured in #898 (see PR #899).
  claudeCode(exitCode, stdout) {
    if (exitCode === 2) return 'block';
    if (exitCode !== 0) return 'nonblocking-error';
    // Byte-empty, not trim-empty. The neutral contract is "exit 0 with no
    // output"; a lone newline is output, and folding it into `none` would let
    // a hook that writes whitespace read as identical to a hook that writes
    // nothing. (Review: Grok, P2.)
    if (stdout === '') return 'none';
    const text = stdout.trim();
    if (text === '') return 'stdout-noise';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: the host surfaces it as transcript noise rather than a
      // decision. Still a difference from the control, so it gets its own
      // label instead of being folded into `none`.
      return 'stdout-noise';
    }
    const decision = parsed?.hookSpecificOutput?.permissionDecision;
    if (decision === 'allow' || decision === 'deny' || decision === 'ask') return decision;
    if (parsed?.decision === 'block') return 'block';
    return 'stdout-noise';
  },

  // Codex's `notify` program has no decision channel at all: Codex spawns it
  // and ignores both its exit code and its stdout. The only ways it can harm
  // a turn are latency and a surviving process, which criteria 2 and 3 cover.
  codexNotify(exitCode, stdout) {
    if (stdout !== '') return 'stdout-noise';
    if (exitCode !== 0) return 'nonzero-exit-ignored-by-host';
    return 'none';
  },
};

// ----- Case manifest ------------------------------------------------------
//
// Derived from the integrations' own manifests rather than restated here, so
// a hook added to hooks.json is covered by this gate the moment it is added.
// That is the same property §5 wants from the HookIngest filter: safety has
// to live at the single point every adapter passes through, or the next
// adapter is unprotected by default.

// Split a hooks.json command line into argv, honouring double quotes (the
// manifests quote the plugin-root path because it contains spaces on Windows).
function tokenizeCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

// Every integration directory that ships a Claude-Code-shaped hook manifest.
// DISCOVERED, not listed: a hardcoded list is exactly how the next adapter
// ends up outside the gate. `integrations/` is small and flat, so scanning it
// is both cheap and the honest source of truth.
export function discoverHookManifests() {
  const root = join(REPO_ROOT, 'integrations');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      agent: entry.name,
      pluginRoot: join(root, entry.name),
      manifestPath: join(root, entry.name, 'hooks', 'hooks.json'),
    }))
    .filter((candidate) => existsSync(candidate.manifestPath));
}

// Integrations that ship no hooks.json, with the reason. An integration that
// appears in neither this map nor the discovery above is an adapter nobody
// wired into the gate, and the coverage test says so rather than passing.
export const NON_MANIFEST_INTEGRATIONS = {
  codex: 'notify program registered in config.toml; payload arrives as argv, covered explicitly',
  opencode: 'in-process plugin, not a spawned hook; measured separately',
  shared: 'not an agent — shared type declarations',
};

function casesFromHooksJson({ agent, manifestPath, pluginRoot, contract }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cases = [];
  for (const [event, entries] of Object.entries(manifest.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== 'command') {
          throw new Error(`${agent}: unsupported hook type ${hook.type} for ${event}`);
        }
        // Substitute whatever plugin-root variable this host uses
        // (${CLAUDE_PLUGIN_ROOT}, ${OPENCLAUDE_PLUGIN_ROOT}, …) rather than
        // being told the name — one less thing a new adapter has to register.
        const command = hook.command.replace(/\$\{[A-Z0-9_]+\}/g, pluginRoot);
        const argv = tokenizeCommand(command);
        if (argv[0] !== 'node') {
          throw new Error(`${agent}: hook command does not start with node: ${hook.command}`);
        }
        cases.push({
          agent,
          contract,
          id: `${agent}:${event}${entry.matcher ? `[${entry.matcher}]` : ''}${
            argv.includes('--permission-gate') ? '+gate' : ''
          }`,
          event,
          matcher: entry.matcher ?? '',
          script: argv[1],
          args: argv.slice(2),
          stdin: 'json',
          payload: payloadFor(event, entry.matcher),
        });
      }
    }
  }
  return cases;
}

// Representative host payloads. Shape matters (the bridge reads tool_name,
// transcript_path, session_id); content does not.
function payloadFor(event, matcher) {
  const base = {
    session_id: 'harness-session',
    transcript_path: '/tmp/harness/harness-session.jsonl',
    cwd: '/tmp/harness',
    hook_event_name: event,
  };
  if (event === 'PreToolUse') {
    return { ...base, tool_name: matcher || 'Read', tool_input: { file_path: '/tmp/harness/x.txt' } };
  }
  if (event === 'PostToolUse') {
    return { ...base, tool_name: matcher || 'Read', tool_response: { ok: true } };
  }
  return base;
}

// A hooks.json manifest IS the Claude Code hook format, so anything shipping
// one speaks that contract. An agent that borrows the file shape with
// different semantics has to say so here — silence would make the harness
// grade it against the wrong rules.
const CONTRACT_OVERRIDES = {};

export function buildCases() {
  const cases = discoverHookManifests().flatMap((manifest) => casesFromHooksJson({
    ...manifest,
    contract: CONTRACT_OVERRIDES[manifest.agent] ?? 'claudeCode',
  }));
  // Codex takes its payload as the LAST argv token, not on stdin, and is
  // registered in config.toml rather than a hooks manifest — so it is spelled
  // out here instead of derived. Both official and legacy payload shapes are
  // exercised because the bridge routes on them.
  const codexScript = join(REPO_ROOT, 'integrations', 'codex', 'bin', 'wmux-codex-notify.mjs');
  for (const [label, payload] of [
    ['official', {
      type: 'agent-turn-complete',
      'thread-id': 'harness-thread',
      'turn-id': 'harness-turn',
      cwd: '/tmp/harness',
      'input-messages': ['hi'],
      'last-assistant-message': 'done',
    }],
    ['legacy', {
      session_id: 'harness-session',
      transcript_path: '/tmp/harness/harness-session.jsonl',
      cwd: '/tmp/harness',
      hook_event_name: 'Stop',
    }],
    // A type Codex emits that wmux deliberately ignores. "Ignored" must still
    // mean silent and fast, not a slow no-op.
    ['ignored-type', { type: 'some-future-codex-event', cwd: '/tmp/harness' }],
  ]) {
    cases.push({
      agent: 'codex',
      contract: 'codexNotify',
      id: `codex:notify[${label}]`,
      event: 'notify',
      matcher: label,
      script: codexScript,
      args: [],
      stdin: 'none',
      argvPayload: payload,
      payload,
    });
  }
  return cases;
}

// ----- Environment scenarios ----------------------------------------------
//
// The same hook has to be silent in all of these. They are the states a real
// user is actually in, and the middle one is where #898 lived: a hook that is
// installed, inside a pane, with nothing on the other end of the pipe.

// A sandbox home. Every endpoint the hooks resolve lands inside it, so nothing
// the harness runs can reach a real wmux; the per-run suffix also keeps the
// derived pipe names from colliding with a live daemon on a developer's box.
export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-harmless-'));
  return { home: dir, seq: 0 };
}

// One wmux "installation" inside the sandbox.
//
// `token` is the difference between "wmux was never installed" and "wmux is
// installed and the daemon is not answering" — and it MATTERS: with no token
// on disk the bridges bail at `no-auth-token` long before any decision path
// runs. A matrix built only on token-less homes never reaches the code #898
// lived in, so it would pass a bridge with #898 reintroduced. (Measured:
// the mutation check below fails without this.)
export function provisionInstance(sandbox, { token = false, daemonPipeName = null } = {}) {
  const suffix = `-harness-${process.pid}-${sandbox.seq++}`;
  const wmuxHome = join(sandbox.home, `.wmux${suffix}`);
  mkdirSync(wmuxHome, { recursive: true });
  if (token) {
    writeFileSync(join(wmuxHome, 'daemon-auth-token'), 'harness-daemon-token', 'utf8');
    writeFileSync(join(sandbox.home, `.wmux${suffix}-auth-token`), 'harness-main-token', 'utf8');
  }
  if (daemonPipeName) writeFileSync(join(wmuxHome, 'daemon-pipe'), daemonPipeName, 'utf8');
  return suffix;
}

export function fakeDaemonAddress(sandbox, label) {
  // The sandbox sequence is part of the name so a second setupScenarios() in
  // the same process cannot collide with a still-listening first one.
  const unique = `${process.pid}-${sandbox.seq}-${label}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-harness-${unique}`;
  // Directly under tmpdir, with a short name, NOT inside the sandbox: a unix
  // socket path is capped near 104 bytes on macOS, and the runners' tmpdir is
  // already long enough (/var/folders/ab/cdef…/T/) that another nested
  // mkdtemp segment would put us at the edge of it.
  return join(tmpdir(), `wmh-${unique}.sock`);
}

/**
 * A stand-in daemon that answers the bridges' RPC.
 *
 * `reply(request)` returns the object to send back, or null to stay silent.
 * Newline-delimited JSON in both directions, matching the real control pipe.
 */
export function startFakeDaemon(address, reply) {
  // A hook killed mid-request leaves a half-open connection, and `close()`
  // waits for every one of them — enough to hang the suite's teardown. Track
  // them so dispose can drop them. (Review: Grok, P2.)
  const sockets = new Set();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buffer = '';
    // A hook that drops the socket the moment it has its answer is normal;
    // an unhandled 'error' here would take the harness down with it.
    sock.on('error', () => { /* client hung up */ });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        const response = reply(request);
        if (response) sock.write(JSON.stringify({ id: request.id, ...response }) + '\n');
      }
    });
  });
  // A unix socket left behind by a killed run makes listen() fail with
  // EADDRINUSE; named pipes have no such file to clear.
  if (process.platform !== 'win32') {
    try {
      unlinkSync(address);
    } catch {
      // Nothing to clear — the normal case.
    }
  }
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(address, () => {
      // A pipe error AFTER listen must not reject an already-settled promise.
      server.off('error', reject);
      server.on('error', () => { /* post-listen transport noise */ });
      resolve({
        address,
        close: () => new Promise((done) => {
          for (const sock of sockets) sock.destroy();
          server.close(() => {
            if (process.platform !== 'win32') {
              try {
                unlinkSync(address);
              } catch {
                // Already gone; the socket outliving the run is what mattered.
              }
            }
            done();
          });
        }),
      });
    });
  });
}

// ----- Environment scenarios ----------------------------------------------
//
// The same hook has to be silent in all of these. They are the states a real
// user is actually in. The last two are where #898 lived — a hook that is
// installed, inside a pane, with a daemon that either is not there or has
// nothing to say about this tool call.
//
// Deliberately absent: a daemon that accepts the gate request and never
// answers. The permission gate blocks there on purpose (up to
// GATE_PERMISSION_TIMEOUT_MS, waiting for a remote approval), so it would fail
// the latency criterion for a reason that is the feature working. Bounding
// that wait is the gate's own contract, not this harness's.
export async function setupScenarios(sandbox) {
  const cleanups = [];

  const notInstalled = provisionInstance(sandbox, { token: false });
  const installedDown = provisionInstance(sandbox, { token: true });

  // A daemon that answers, successfully, with no verdict about this call —
  // a pre-gate daemon, a non-gated tool, or the broker deferring to the
  // session's own permission flow. Silence is the only faithful encoding.
  const noVerdictAddress = fakeDaemonAddress(sandbox, 'noverdict');
  const noVerdictServer = await startFakeDaemon(noVerdictAddress, (request) => ({
    ok: true,
    result: { ok: true, received: request.method },
  }));
  cleanups.push(() => noVerdictServer.close());
  const installedNoVerdict = provisionInstance(sandbox, {
    token: true,
    daemonPipeName: noVerdictAddress,
  });

  const env = (suffix, extra) => ({
    USERPROFILE: sandbox.home,
    HOME: sandbox.home,
    WMUX_DATA_SUFFIX: suffix,
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...extra,
  });

  const scenarios = [
    {
      id: 'not-installed',
      why: 'plugin present, wmux never set up, agent outside any pane',
      env: env(notInstalled, { WMUX_PTY_ID: undefined }),
    },
    {
      id: 'installed-daemon-down',
      why: 'wmux installed, inside a pane, daemon not answering — the #898 state',
      env: env(installedDown, { WMUX_PTY_ID: 'harness-pty-1' }),
    },
    {
      id: 'installed-daemon-no-verdict',
      why: 'daemon answers and has no opinion about this call',
      env: env(installedNoVerdict, { WMUX_PTY_ID: 'harness-pty-1' }),
    },
    {
      id: 'gate-disabled',
      why: 'operator turned the gate off; the escape hatch must be silent too',
      env: env(installedNoVerdict, { WMUX_PTY_ID: 'harness-pty-1', WMUX_GATE: '0' }),
    },
    {
      id: 'headless',
      why: '`claude -p` / CI / subagents read the same manifest',
      env: env(installedNoVerdict, { WMUX_PTY_ID: 'harness-pty-1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }),
    },
  ];

  // A daemon that accepts the connection and NEVER answers. Kept out of the
  // hook matrix on purpose — the permission gate blocks there by design,
  // waiting for a remote approval, so it would fail the latency criterion for
  // a reason that is the feature working.
  //
  // It is exactly what the in-process opencode plugin needs, though: that
  // plugin claims to detach its pipe RPC from the event handler so a wedged
  // endpoint cannot add the 2s transport cap to the TUI's idle transition.
  // Against an absent endpoint (instant ENOENT) a NON-detached handler would
  // look just as fast, and the claim would go untested. (Review: Grok, P2.)
  const silentAddress = fakeDaemonAddress(sandbox, 'silent');
  const silentServer = await startFakeDaemon(silentAddress, () => null);
  cleanups.push(() => silentServer.close());
  const installedSilent = provisionInstance(sandbox, { token: true, daemonPipeName: silentAddress });

  return {
    scenarios,
    wedgedDaemonEnv: env(installedSilent, { WMUX_PTY_ID: 'harness-pty-1' }),
    dispose: async () => { for (const fn of cleanups) await fn(); },
  };
}

// ----- Fixtures: hooks that are supposed to FAIL --------------------------
//
// A gate that cannot fail is not a gate. Each criterion gets a fixture hook
// that violates exactly that criterion, and the gate is required to reject
// each one. Without these, a broken classifyDecision() would quietly turn the
// whole harness into an always-pass, which is the failure mode R3 warns about
// — a test that pins nothing while looking green.

const FIXTURE_SOURCES = {
  // The control: provably no opinion.
  noop: NOOP_HOOK_SOURCE,

  // #898 in a bottle. `ask` reads as neutral and is not: it forces a prompt
  // and overrides bypassPermissions. If the gate lets this through, it would
  // have let #898 through.
  opinionated: [
    'process.stdin.resume();',
    "process.stdin.on('data', () => {});",
    "process.stdin.on('error', () => {});",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }) + '\\n');",
    '});',
  ].join('\n'),

  // Criterion 2: a hook that never returns. The host waits on it.
  hanging: [
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
  ].join('\n'),

  // Criterion 3: exits promptly and cleanly, but leaves a descendant holding
  // the host's stdout/stderr. `exit` looks perfect; `close` is the tell.
  orphan: [
    "import { spawn } from 'node:child_process';",
    'process.stdin.resume();',
    "process.stdin.on('error', () => {});",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit', detached: true }).unref();",
    'process.exitCode = 0;',
    "process.stdin.on('end', () => {});",
    'setTimeout(() => process.exit(0), 50);',
  ].join('\n'),
};

/** Write the control and the three violation fixtures; returns {name: path}. */
export function writeFixtureHooks(sandboxHome) {
  const paths = {};
  for (const [name, source] of Object.entries(FIXTURE_SOURCES)) {
    const path = join(sandboxHome, `fixture-${name}.mjs`);
    writeFileSync(path, source, 'utf8');
    paths[name] = path;
  }
  return paths;
}

export function writeNoopHook(sandboxHome) {
  return writeFixtureHooks(sandboxHome).noop;
}

// The fixtures above prove the CLASSIFIER works. They do not prove the matrix
// REACHES the code #898 lived in — and the first version of this harness did
// not: with no auth token in the sandbox every bridge bailed at
// `no-auth-token` long before any decision path ran, so a bridge with #898
// reintroduced sailed through. The scenarios were fixed; this keeps them
// fixed, by putting #898 back into a copy of the real bridge on every run and
// requiring the gate to reject it.
const MUTATION_ANCHOR = "  if (decision !== 'allow' && decision !== 'deny') return;";
const MUTATION_REPLACEMENT = "  if (decision !== 'allow' && decision !== 'deny') decision = 'ask';";

/**
 * Write a copy of the real Claude bridge with #898 put back: every "wmux has
 * no opinion" verdict becomes `ask`. Throws if the anchor is gone, which is
 * the point — a refactor that moves this logic must re-prove the gate rather
 * than silently leave it defending nothing.
 */
export function writeMutatedBridge(sandboxHome) {
  const source = join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');
  const text = readFileSync(source, 'utf8');
  if (!text.includes(MUTATION_ANCHOR)) {
    throw new Error(
      'hookHarmlessness: the #898 mutation anchor is gone from wmux-bridge.mjs. '
      + 'The neutral-decision guard moved or changed shape, so this gate is no longer '
      + 'proven to catch #898. Re-derive MUTATION_ANCHOR against the current bridge.',
    );
  }
  const path = join(sandboxHome, 'mutant-wmux-bridge.mjs');
  writeFileSync(path, text.replace(MUTATION_ANCHOR, MUTATION_REPLACEMENT), 'utf8');
  return path;
}

// ----- The measurement ----------------------------------------------------

export const DEFAULT_BUDGET_MS = 6000;

/**
 * Run one hook invocation the way its host would, and report what the host
 * would have observed.
 *
 * Resolves rather than rejects on every failure mode — a timeout is a
 * measurement ('timedOut: true'), not an exception, so one hanging hook still
 * produces a comparable row instead of collapsing the run.
 */
export function runHookCase({ script, args = [], env = {}, payload, stdin = 'json', argvPayload, budgetMs = DEFAULT_BUDGET_MS }) {
  return new Promise((resolve) => {
    // Seal the environment before applying the scenario. The harness itself is
    // often run from inside a wmux pane under a wmux-integrated agent, so the
    // parent process carries WMUX_* and CLAUDE_* variables that change what
    // the hooks do — WMUX_HOOKS_TO_MAIN alone reroutes every signal. Leaving
    // them in would make each scenario mean "whatever this developer's box is
    // doing". (Review: Grok, P2.)
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('WMUX_') || key.startsWith('CLAUDE_')) delete childEnv[key];
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    const argv = [script, ...args];
    if (argvPayload !== undefined) argv.push(JSON.stringify(argvPayload));

    const startedAt = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

    const child = spawn(process.execPath, argv, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let signal = null;
    let exitMs = null;
    let stdinError = null;
    let stdinSettled = stdin === 'json' ? false : true;
    let stdinBytes = 0;
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const closeMs = ms();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        exitMs,
        closeMs,
        wallMs: closeMs,
        // Positive when something outlived the hook while still holding the
        // host's stdio. Zero-ish on a clean hook.
        survivorGapMs: exitMs === null ? null : Math.max(0, closeMs - exitMs),
        stdinError,
        stdinSettled,
        stdinBytes,
        timedOut,
        ...extra,
      });
    };

    let graceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // Killing the direct child does NOT reap a descendant that inherited its
      // stdout/stderr — which is precisely the criterion-3 failure. Waiting on
      // 'close' alone would then never settle, and an unbounded survivor would
      // hang the suite for the whole test timeout instead of being REPORTED as
      // one. Give 'close' a short grace period, then let go of our ends of the
      // pipes and report what we have. (Review: Grok, P1.)
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ survivorOutlivedProbe: true });
      }, 300);
    }, budgetMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (settled) return;
      settled = true;
      resolve({ spawnError: String(err), wallMs: ms() });
    });

    child.on('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
      exitMs = ms();
    });

    // 'close' — not 'exit'. This is the survivor probe: it fires only once
    // every handle on the child's stdout/stderr is gone, which includes any
    // descendant that inherited them. A hook that leaves a process behind
    // holding the host's pipes shows up here as a gap, or as a timeout.
    child.on('close', () => finish());

    if (stdin === 'json') {
      // A string payload is written RAW; anything else is encoded. The
      // oversized-stdin case relies on that, so the byte count is reported
      // rather than inferred from the caller's intent. (Review: Grok, P1.)
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
      stdinBytes = Buffer.byteLength(body, 'utf8');
      // A hook that destroys stdin mid-write EPIPEs the host. That is allowed
      // (the host tolerates it); deadlocking is not — so what gets recorded is
      // whether the write SETTLED, either way. A write still pending when the
      // budget fires is the deadlock this criterion exists to catch.
      child.stdin.on('error', (err) => { stdinError = String(err); stdinSettled = true; });
      child.stdin.end(body, () => { stdinSettled = true; });
    } else {
      child.stdin.end();
    }
  });
}

export function classifyDecision(contract, result) {
  if (!result || result.spawnError) return 'spawn-error';
  if (result.timedOut) return 'timeout';
  return HOST_CONTRACTS[contract](result.exitCode, result.stdout ?? '');
}
