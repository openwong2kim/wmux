#!/usr/bin/env node
// P-5 — the LIVE half of the A/B harmlessness gate.
//
// The CI half (scripts/__tests__/hookHarmlessness.runtime.test.mjs) simulates
// the host: it drives the real hooks and applies each host's documented
// contract to what they emit. That catches #898 and every hang/orphan class of
// failure without an API key, and it runs on every PR.
//
// What it cannot do is prove the REAL host agrees with our reading of its
// contract. This driver does that: it runs the same task twice through the
// actual agent CLI — once with wmux's hooks installed, once without — and
// compares the outcomes. It is opt-in and NOT in CI, because it costs tokens
// and needs credentials.
//
//   node scripts/hook-ab-live.mjs --agent claude [--runs 1] [--json]
//
// SCOPE, measured not assumed: a headless `claude -p` run exercises every
// OBSERVATION hook (SessionStart/PostToolUse/Stop/SubagentStop) end to end,
// and NOT the PreToolUse permission gate — the gate defers unless
// CLAUDE_CODE_ENTRYPOINT names an interactive entrypoint, and the agent sets
// that variable itself when it spawns a hook, so the parent cannot present a
// headless run as interactive. Verified: a bridge with #898 reintroduced
// passes this driver. The gate path is covered by the CI half instead, which
// proves it by mutating the real bridge on every run.
//
// The three pass criteria (plan §6), and which agents can actually report each
// (from the P-3 hook-insertion survey):
//
//   1. Approval/denial set identical.
//      claude   — `--output-format json` carries `permission_denials`.
//      copilot  — has a `permissionRequest` event; equivalent measurement.
//      kiro     — NO approval-specific event. Not measurable; criterion 2 is
//                 the primary judgment there.
//      gemini   — no approval event either, AND its docs say a hook "must not
//                 print any plain text to stdout other than the final JSON",
//                 so an empty stdout may be a parse failure rather than the
//                 neutral we rely on everywhere else. That is the inverse of
//                 Claude's contract and the exact shape of #898, which is why
//                 gemini stays unsupported here until measured.
//   2. Task completed, and duration within ±50%.  All agents.
//   3. No hook process outlives the agent.        All agents.
//
// Agents are listed as `unsupported` rather than quietly omitted: a missing
// row is a measurement nobody has taken, not a pass.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startFakeDaemon, fakeDaemonAddress } from './lib/hookHarmlessness.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// An isolated wmux instance for the run: the owner's live daemon never sees a
// fake pane signal, and the run gets a bridge.log nobody else writes to.
//
// It is a FURNISHED instance, not an empty one — auth token plus a stand-in
// daemon on the other end. Without those the hooks bail at `no-auth-token` in
// milliseconds and the A/B measures hooks that immediately give up rather than
// hooks doing their work. (Review: Grok, P1.)
const ABLIVE_SUFFIX = `-ablive-${process.pid}`;
const ABLIVE_HOME = join(homedir(), `.wmux${ABLIVE_SUFFIX}`);
const ABLIVE_LOG = join(ABLIVE_HOME, 'bridge.log');
// The agent itself gets no bound here (a model turn is as long as it is), but
// a hung CLI must not hang the driver forever.
const AGENT_TIMEOUT_MS = 300_000;

// The task. Deliberately dull and single-step: we are measuring the hooks, not
// the model. It must touch the filesystem so "completed" is checkable from the
// outside rather than from the agent's own say-so.
const TASK = 'Create a file named done.txt in the current directory containing exactly the word ready. Then stop.';
const COMPLETION_FILE = 'done.txt';

const AGENTS = {
  claude: {
    bin: 'claude',
    measuresDenials: true,
    /** argv for one headless run against `settingsPath` in `cwd`. */
    argv: (settingsPath) => [
      '-p', TASK,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--settings', settingsPath,
    ],
    /** The settings file that installs (or omits) wmux's hooks. */
    settings: (withHooks) => {
      if (!withHooks) return { hooks: {} };
      const bridge = join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs').replace(/\\/g, '/');
      // Reuse the shipped manifest so this measures what users install, not
      // a restatement of it that can drift.
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, 'integrations', 'claude', 'hooks', 'hooks.json'), 'utf8'),
      );
      const substituted = JSON.parse(
        JSON.stringify(manifest).split('${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs').join(bridge),
      );
      return substituted;
    },
    parse: (stdout) => {
      try {
        const parsed = JSON.parse(stdout);
        return {
          // ABSENT is not EMPTY. A CLI that does not emit the field at all
          // (older builds) would otherwise compare `[]` against `[]` and read
          // as "criterion 1 measured, both arms clean" — a pass this run never
          // earned. `null` routes to the unmeasured path, same as unparseable
          // output does below.
          denials: parsed.permission_denials === undefined
            ? null
            : parsed.permission_denials.map((d) => d.tool_name ?? String(d)).sort(),
          agentReportedError: parsed.is_error === true,
        };
      } catch {
        return { denials: null, agentReportedError: null };
      }
    },
  },
  // Filled in when the adapter lands; see the P-3 survey for why this order.
  copilot: { unsupported: 'adapter not built yet — P-3 ranks it first' },
  kiro: { unsupported: 'adapter not built yet; no approval event, criterion 1 not measurable' },
  gemini: { unsupported: 'blocked: empty stdout may be a parse failure, not neutral (P-3 R2)' },
};

function parseArgs(argv) {
  const args = { agent: 'claude', runs: 1, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent') args.agent = argv[++i];
    else if (argv[i] === '--runs') {
      args.runs = Number(argv[++i]);
      if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer');
    }
    else if (argv[i] === '--json') args.json = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// Agent CLIs ship as `.cmd` shims on Windows, and Node refuses to spawn those
// without a shell. A shell then re-splits the argv on whitespace, which
// silently truncated the task prompt to its first word on the first run of
// this driver — both arms "completed" nothing and the comparison looked clean.
// Quote every argument so the agent receives what we meant to send.
function quoteForShell(arg) {
  const text = String(arg);
  if (process.platform !== 'win32') return text;
  // cmd.exe doubles an embedded quote; a backslash escape would split the
  // argv — the same class of bug that truncated the prompt above.
  return `"${text.replace(/"/g, '""')}"`;
}

function runAgent(profile, { cwd, settingsPath, env }) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const useShell = process.platform === 'win32';
    const argv = profile.argv(settingsPath);
    const child = spawn(profile.bin, useShell ? argv.map(quoteForShell) : argv, {
      cwd,
      env,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // With `shell: true` the child is cmd.exe and the agent is its GRANDchild,
      // so TerminateProcess on the child leaves the CLI running — still burning
      // tokens, still holding the inherited stdio that 'close' waits on. Kill
      // the tree. `taskkill` failing (already exited, race) is not actionable,
      // and the SIGKILL below still reaps the direct child either way.
      if (useShell && process.platform === 'win32' && child.pid) {
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // Fall through to the direct kill.
        }
      }
      child.kill('SIGKILL');
    }, AGENT_TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ spawnError: String(err), wallMs: Number(process.hrtime.bigint() - startedAt) / 1e6 });
    });
    // 'close', not 'exit' — the same survivor probe the CI half uses: a hook
    // process that outlives the agent while holding its stdio delays this.
    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ exitCode: code, stdout, stderr, wallMs, timedOut });
    });
  });
}

async function measure(profile, { withHooks, sandbox, label }) {
  const cwd = join(sandbox, label);
  mkdirSync(cwd, { recursive: true });
  const settingsPath = join(sandbox, `${label}-settings.json`);
  writeFileSync(settingsPath, JSON.stringify(profile.settings(withHooks), null, 2), 'utf8');

  const env = { ...process.env };
  // Both arms run against an isolated wmux instance. Two reasons, both
  // load-bearing: a live A/B must not inject fake pane signals into the
  // owner's running daemon, and an isolated instance gets its own bridge.log,
  // which is the only way to PROVE the hooks fired rather than assume it.
  env.WMUX_DATA_SUFFIX = ABLIVE_SUFFIX;
  // The hooks must believe they are inside a pane, or every decision path
  // short-circuits and the run measures nothing.
  if (withHooks) env.WMUX_PTY_ID = 'ab-live-pty';
  else delete env.WMUX_PTY_ID;

  const hookLinesBefore = countHookLines();
  const result = await runAgent(profile, { cwd, settingsPath, env });
  // Contents, not just existence: an empty file the agent touched and gave up
  // on is not a completed task. (Review: Grok, P3.)
  const donePath = join(cwd, COMPLETION_FILE);
  const completed = existsSync(donePath) && readFileSync(donePath, 'utf8').toLowerCase().includes('ready');
  return {
    ...result,
    ...(profile.parse?.(result.stdout ?? '') ?? {}),
    completed,
    cwd,
    hookInvocations: countHookLines() - hookLinesBefore,
  };
}

// How many times a wmux hook ran during a window. Without this the driver
// cannot tell "the hooks are harmless" from "the hooks never ran" — and a
// silently unwired treatment arm passes every criterion.
function countHookLines() {
  try {
    return readFileSync(ABLIVE_LOG, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function compare(a, b, profile) {
  const findings = [];
  // Criterion 0 — the arms have to be what they claim to be. This check found
  // a real flaw on its first run: `--settings` MERGES with the user's config,
  // so on a machine where the wmux plugin is already installed the "without
  // hooks" arm still fired three of them. Silently, the driver had been
  // comparing 3 hooks against 7 and calling it hooks-vs-no-hooks.
  if (b.hookInvocations <= a.hookInvocations) {
    findings.push({
      level: 'fail',
      text: `the injected hooks never fired (control=${a.hookInvocations}, treatment=${b.hookInvocations}) — nothing was measured`,
    });
  }
  if (a.hookInvocations > 0) {
    findings.push({
      level: 'unmeasured',
      text: `wmux hooks are installed globally on this machine, so the control arm ran ${a.hookInvocations} of them. `
        + 'This run measures the MARGINAL effect of the injected hooks, not hooks-vs-no-hooks. '
        + 'Isolating that would need CLAUDE_CONFIG_DIR, which drops the credentials with the config — '
        + 'so the absolute claim comes from the CI half, which needs no agent at all.',
    });
  }
  // Criterion 1 — the approval/denial set.
  if (a.denials === null || b.denials === null) {
    // For an agent whose profile says the denial list IS available, failing to
    // parse it means the run measured nothing — not that criterion 1 is
    // inapplicable. Only an agent with no denial channel gets `unmeasured`.
    // (Review: Grok, P2.)
    findings.push({
      level: profile.measuresDenials ? 'fail' : 'unmeasured',
      text: 'denial list not parseable from this agent output',
    });
  } else if (JSON.stringify(a.denials) !== JSON.stringify(b.denials)) {
    findings.push({
      level: 'fail',
      text: `denials differ: without=${JSON.stringify(a.denials)} with=${JSON.stringify(b.denials)}`,
    });
  }
  // The agent itself has to have run, in both arms and the same way.
  if (a.spawnError || b.spawnError) {
    findings.push({ level: 'fail', text: `agent failed to spawn: ${a.spawnError ?? b.spawnError}` });
  }
  if (a.timedOut || b.timedOut) {
    findings.push({ level: 'fail', text: 'an arm hit the agent timeout' });
  }
  if (a.exitCode !== b.exitCode) {
    findings.push({ level: 'fail', text: `exit codes differ: without=${a.exitCode} with=${b.exitCode}` });
  }
  if (a.agentReportedError !== b.agentReportedError) {
    findings.push({
      level: 'fail',
      text: `agent error flag differs: without=${a.agentReportedError} with=${b.agentReportedError}`,
    });
  }

  // Criterion 2 — completion, then duration.
  if (a.completed !== b.completed) {
    findings.push({ level: 'fail', text: `completion differs: without=${a.completed} with=${b.completed}` });
  } else if (!a.completed) {
    findings.push({ level: 'unmeasured', text: 'neither run completed the task — the A/B says nothing' });
  }
  // Duration says nothing when neither arm did the work. (Review: Grok, P3.)
  const ratio = b.wallMs / a.wallMs;
  if (a.completed && b.completed && (ratio > 1.5 || ratio < 0.5)) {
    findings.push({
      level: 'fail',
      text: `duration outside ±50%: without=${Math.round(a.wallMs)}ms with=${Math.round(b.wallMs)}ms (${ratio.toFixed(2)}x)`,
    });
  }
  return findings;
}

async function main() {
  const args = parseArgs(process.argv);
  const profile = AGENTS[args.agent];
  if (!profile) throw new Error(`unknown agent: ${args.agent}. known: ${Object.keys(AGENTS).join(', ')}`);
  if (profile.unsupported) {
    console.error(`${args.agent}: ${profile.unsupported}`);
    process.exitCode = 2;
    return;
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'wmux-ab-live-'));
  const rounds = [];
  let threw = false;

  // Furnish the isolated instance: a token the bridges will accept and a
  // stand-in daemon that answers. Both arms point at it, so the hooks under
  // test actually connect, send, and read a reply.
  mkdirSync(ABLIVE_HOME, { recursive: true });
  writeFileSync(join(ABLIVE_HOME, 'daemon-auth-token'), 'ab-live-token', 'utf8');
  writeFileSync(join(homedir(), `.wmux${ABLIVE_SUFFIX}-auth-token`), 'ab-live-token', 'utf8');
  const daemonAddress = fakeDaemonAddress({ seq: 'live' }, 'ablive');
  const daemon = await startFakeDaemon(daemonAddress, (request) => ({
    ok: true,
    result: { ok: true, received: request.method },
  }));
  writeFileSync(join(ABLIVE_HOME, 'daemon-pipe'), daemonAddress, 'utf8');

  try {
    for (let i = 0; i < args.runs; i++) {
      // Order matters less than isolation: each run gets its own cwd, so a
      // file left by one never makes the other look complete.
      const without = await measure(profile, { withHooks: false, sandbox, label: `r${i}-without` });
      const withHooks = await measure(profile, { withHooks: true, sandbox, label: `r${i}-with` });
      rounds.push({ run: i, without, with: withHooks, findings: compare(without, withHooks, profile) });
    }
  } catch (err) {
    // A throw mid-run is exactly when the transcripts are worth keeping — the
    // earlier version deleted them, because `rounds` was empty and therefore
    // "clean". (Review: Grok, P2.)
    threw = true;
    console.error(String(err));
  } finally {
    await daemon.close();
    rmSync(ABLIVE_HOME, { recursive: true, force: true });
    rmSync(join(homedir(), `.wmux${ABLIVE_SUFFIX}-auth-token`), { force: true });
    const failed = threw || rounds.some((r) => r.findings.some((f) => f.level === 'fail'));
    if (!failed) rmSync(sandbox, { recursive: true, force: true });
    else console.error(`sandbox kept for inspection: ${sandbox} (${readdirSync(sandbox).join(', ')})`);
  }

  if (args.json) {
    console.log(JSON.stringify({ agent: args.agent, rounds }, null, 2));
  } else {
    for (const round of rounds) {
      console.log(`--- run ${round.run} (${args.agent}) ---`);
      for (const [label, m] of [['without hooks', round.without], ['with hooks', round.with]]) {
        console.log(
          `  ${label.padEnd(14)} exit=${m.exitCode} ${Math.round(m.wallMs)}ms `
          + `completed=${m.completed} hooks=${m.hookInvocations} `
          + `denials=${m.denials === null ? 'unparsed' : JSON.stringify(m.denials)}`,
        );
      }
      if (round.findings.length === 0) console.log('  PASS — indistinguishable on all measured criteria');
      for (const f of round.findings) console.log(`  ${f.level.toUpperCase()} — ${f.text}`);
    }
  }

  // Three outcomes, not two. "Nothing was measured" must not read as a pass:
  // an unparseable result, a machine whose global hooks pollute the control,
  // or zero rounds all leave the claim unestablished. (Review: Grok, P1.)
  //   0 = every measured criterion matched
  //   1 = a criterion failed
  //   2 = the run did not establish the claim
  const anyFail = threw || rounds.some((r) => r.findings.some((f) => f.level === 'fail'));
  const anyUnmeasured = rounds.length === 0
    || rounds.some((r) => r.findings.some((f) => f.level === 'unmeasured'));
  if (anyFail) process.exitCode = 1;
  else if (anyUnmeasured) process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
