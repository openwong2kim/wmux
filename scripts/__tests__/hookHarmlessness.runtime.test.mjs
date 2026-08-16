// P-5 — the A/B harmlessness gate, wired into CI.
//
// wmux installs hooks into other people's agents. #898 is what it costs when
// one of them says something the host reads as an instruction: the permission
// gate emitted `ask` on every "wmux has no opinion" path, `ask` is not
// neutral, and a bypassPermissions session started asking permission to run
// `Read` — with the documented escape hatch emitting `ask` too. The claim this
// file defends is narrow and testable:
//
//   installing a wmux hook is indistinguishable, to the host, from installing
//   a hook that provably has no opinion.
//
// Every case runs a CONTROL (a no-op hook) and a TREATMENT (the real hook,
// invoked the way the integration's own manifest invokes it) and compares what
// the host would observe. The measurement lives in
// scripts/lib/hookHarmlessness.mjs; the pass criteria live here.
//
// Two properties keep this from decaying into a green no-op:
//   - the matrix is DERIVED from hooks.json, so a hook added to a manifest is
//     covered the moment it is added;
//   - the gate is re-proven against the real bridge on every run, by putting
//     #898 back into a copy of it and requiring rejection.
// The second one is not theoretical: the first draft of this harness passed a
// bridge with #898 reintroduced, because its sandbox had no auth token and
// every bridge bailed before reaching the decision path at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  buildCases,
  discoverHookManifests,
  NON_MANIFEST_INTEGRATIONS,
  setupScenarios,
  makeSandbox,
  writeFixtureHooks,
  writeMutatedBridge,
  writeTranscriptFixture,
  isHarnessAddress,
  runHookCase,
  classifyDecision,
} from '../lib/hookHarmlessness.mjs';

// Kill budget. Well above any honest hook; a hang lands here.
const KILL_BUDGET_MS = 15_000;
// How much wall clock a wmux hook may add over the no-op control. This is the
// live A/B's "duration within ±50%" criterion expressed against a simulated
// host: there the baseline is the agent's task, here it is a hook that does
// nothing. The band sits deliberately BELOW the bridges' own 2s transport cap
// (HOOK_TIMEOUT_MS) — a hook that waits out a dead daemon on the host's thread
// is the stall this criterion forbids, so a budget above 2s could not fail it.
// Measured headroom: every hook lands within ~110ms of the control locally.
// (Review: Grok, P1.)
const MAX_ADDED_MS = 1_500;
// A descendant still holding the host's stdout/stderr this long after the hook
// exited is a survivor, not scheduling noise.
const MAX_SURVIVOR_GAP_MS = 500;

let sandbox;
let fixtures;
let scenarios;
let wedgedDaemonEnv;
let disposeScenarios;
let daemonRequests;
let daemonFurnishedScenarioIds;
let cases;

beforeAll(async () => {
  sandbox = makeSandbox();
  fixtures = writeFixtureHooks(sandbox.home);
  const transcriptPath = writeTranscriptFixture(sandbox.home);
  ({
    scenarios,
    wedgedDaemonEnv,
    daemonRequests,
    daemonFurnishedScenarioIds,
    dispose: disposeScenarios,
  } = await setupScenarios(sandbox));
  // Payloads name a transcript that EXISTS, so the tail-read + JSONL parse is
  // measured instead of returning at the bridges' `existsSync` guard.
  cases = buildCases({ transcriptPath, cwd: sandbox.home });
}, 60_000);

afterAll(async () => {
  await disposeScenarios?.();
  try {
    // Guarded: beforeAll can throw before the sandbox exists, and an
    // unguarded teardown would then bury the real failure. (Review: Grok, P3.)
    if (sandbox?.home) rmSync(sandbox.home, { recursive: true, force: true });
  } catch {
    // A temp dir the OS will reap anyway; never fail the suite on cleanup.
  }
});

/** Apply the three pass criteria; returns human-readable violations. */
function violations(id, result, decision, control) {
  const found = [];
  // Criterion 1 — the host's decision is the control's decision.
  if (decision !== 'none') found.push(`${id}: decision=${decision}`);
  // Stricter form of the same thing, and the precise #898 pin: an observation
  // hook writes zero bytes.
  if ((result.stdout ?? '') !== '') {
    found.push(`${id}: stdout=${JSON.stringify(result.stdout).slice(0, 160)}`);
  }
  // Exit 2 is Claude Code's "block this action". No observation hook may reach
  // it, however it fails internally.
  if (result.exitCode !== 0) found.push(`${id}: exit=${result.exitCode}`);
  // stderr counts too. Claude Code puts a hook's stderr in the transcript even
  // on exit 0, and the codex `notify` host logs it — so "an observation hook
  // writes zero bytes" is a claim about BOTH streams. Checking only stdout let
  // a hook narrate every invocation into the user's session and still pass.
  if ((result.stderr ?? '') !== '') {
    found.push(`${id}: stderr=${JSON.stringify(result.stderr).slice(0, 160)}`);
  }

  // Criterion 2 — completion and added latency.
  if (result.timedOut) found.push(`${id}: timed out`);
  if (control && result.wallMs > control.wallMs + MAX_ADDED_MS) {
    found.push(`${id}: +${Math.round(result.wallMs - control.wallMs)}ms over control (cap ${MAX_ADDED_MS})`);
  }

  // Criterion 3 — nothing outlives the hook holding the host's stdio. Fail
  // closed on a missing measurement: `?? 0` would let a refactor that stops
  // reporting the gap read as a clean pass. (Review: Grok, P3.)
  if (typeof result.survivorGapMs !== 'number') {
    found.push(`${id}: survivor gap not measured`);
  } else if (result.survivorGapMs > MAX_SURVIVOR_GAP_MS) {
    found.push(`${id}: survivor held host stdio for ${Math.round(result.survivorGapMs)}ms`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 0. The gate has to be able to fail.
// ---------------------------------------------------------------------------

describe('the gate detects the failures it exists to detect', () => {
  it('rejects a hook that emits `ask`', async () => {
    const result = await runHookCase({
      script: fixtures.opinionated,
      env: scenarios[0].env,
      payload: { hook_event_name: 'PreToolUse' },
      budgetMs: KILL_BUDGET_MS,
    });
    // `ask` looks neutral and is not: it forces a prompt and overrides the
    // session's permission mode. Measured on Claude Code 2.1.233 (PR #899).
    expect(classifyDecision('claudeCode', result)).toBe('ask');
  }, 60_000);

  it('rejects a hook that never returns', async () => {
    const result = await runHookCase({
      script: fixtures.hanging,
      env: scenarios[0].env,
      payload: {},
      budgetMs: 2_500,
    });
    expect(result.timedOut).toBe(true);
    expect(classifyDecision('claudeCode', result)).toBe('timeout');
  }, 60_000);

  it('rejects a hook that exits cleanly but leaves a process holding the host stdio', async () => {
    const result = await runHookCase({
      script: fixtures.orphan,
      env: scenarios[0].env,
      payload: {},
      budgetMs: KILL_BUDGET_MS,
    });
    // The tell is NOT the exit: this fixture exits 0, promptly, silently.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // It is the gap between exit and the host's pipes finally closing.
    expect(result.survivorGapMs).toBeGreaterThan(1_000);
  }, 60_000);

  it('accepts the no-op control', async () => {
    const result = await runHookCase({
      script: fixtures.noop,
      env: scenarios[0].env,
      payload: {},
      budgetMs: KILL_BUDGET_MS,
    });
    expect(classifyDecision('claudeCode', result)).toBe('none');
    // Asserted directly too: if the classifier ever softened, a dirty control
    // would bless every treatment compared against it. (Review: Grok, P3.)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.survivorGapMs).toBeLessThan(MAX_SURVIVOR_GAP_MS);
  }, 60_000);

  // The one that matters: not a fixture, the REAL bridge with #898 put back.
  // This is what proves the scenarios below actually reach the decision path.
  it('rejects the real bridge with #898 reintroduced', async () => {
    const mutant = writeMutatedBridge(sandbox.home);
    const gateCase = cases.find((c) => c.agent === 'claude' && c.args.includes('--permission-gate'));
    expect(gateCase, 'the permission gate is missing from the matrix').toBeTruthy();

    const decisions = {};
    for (const scenario of scenarios) {
      const result = await runHookCase({
        ...gateCase,
        script: mutant,
        env: scenario.env,
        budgetMs: KILL_BUDGET_MS,
      });
      decisions[scenario.id] = classifyDecision(gateCase.contract, result);
    }
    // The assertion is `ask`, NOT "some violation". A mutant that merely
    // crashes, times out, or exits non-zero also violates the criteria, and
    // accepting that would prove only that a broken file behaves badly —
    // exactly the kind of false proof this test exists to rule out.
    // (Review: Grok, P1.)
    //
    // Not every scenario reaches the gate's verdict path: a headless agent and
    // a disabled gate both return earlier, by design. What must hold is that
    // the states where #898 actually bit are caught, red-handed, emitting the
    // one value that looks neutral and is not.
    expect(decisions['installed-daemon-down']).toBe('ask');
    expect(decisions['installed-daemon-no-verdict']).toBe('ask');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 1. Coverage — every hook wmux ships as a subprocess is in the matrix.
// ---------------------------------------------------------------------------

describe('the matrix covers what wmux actually installs', () => {
  it('derives its cases from the shipped manifests', () => {
    const agents = new Set(cases.map((c) => c.agent));
    // opencode is absent by design: it is an in-process plugin, not a spawned
    // hook, so it gets its own measurement below rather than a silent skip.
    expect([...agents].sort()).toEqual(['claude', 'codex', 'openclaude']);
    for (const c of cases) expect(c.script).toMatch(/\.mjs$/);
    // The permission gate — the surface #898 lived on — must be in the matrix.
    expect(cases.some((c) => c.args.includes('--permission-gate'))).toBe(true);
  });

  // "Derived from hooks.json, so a new hook is covered the moment it is added"
  // is a claim about a count, and it is worth checking as one: a manifest
  // entry the derivation quietly drops would otherwise leave this file green
  // while that hook goes unmeasured. (Review: Grok, P2.)
  it('turns every manifest entry into a case', () => {
    for (const manifest of discoverHookManifests()) {
      const declared = Object.values(JSON.parse(readFileSync(manifest.manifestPath, 'utf8')).hooks ?? {})
        .flatMap((entries) => entries.flatMap((entry) => entry.hooks ?? []));
      const derived = cases.filter((c) => c.agent === manifest.agent);
      expect(derived.length, `${manifest.agent}: manifest entries not all turned into cases`)
        .toBe(declared.length);
    }
  });

  // Nothing in the sandbox may address a real endpoint.
  //
  // Furnishing the unsuffixed token layout (needed so the openclaude cases
  // reach a decision at all) also made every instance capable of CONNECTING,
  // and a bridge with no `daemon-pipe` hint derives its address — openclaude
  // derives `\\.\pipe\wmux-daemon-<username>`, which is the operator's live
  // daemon, not ours. Every instance therefore carries an explicit hint in the
  // harness namespace. This pins that: a run must never post harness
  // envelopes into a daemon someone is actually using.
  // The predicate the check below leans on, pinned against both platforms'
  // real spellings AND the derived names it exists to reject — otherwise a
  // regex that matched everything would make that check vacuous.
  it('recognises harness addresses on either platform and rejects real ones', () => {
    for (const ours of [
      '\\\\.\\pipe\\wmux-harness-1234-0-noverdict',
      '\\\\.\\pipe\\wmux-harness-1234-0-down-never-bound',
      '/var/folders/g3/abc/T/wmh-44488-0-notinstalled.sock-never-bound',
      '/tmp/wmh-1-0-silent.sock',
    ]) expect(isHarnessAddress(ours), ours).toBe(true);

    for (const theirs of [
      '\\\\.\\pipe\\wmux-daemon-rizz',
      '\\\\.\\pipe\\wmux-rizz',
      '/home/someone/.wmux/daemon.sock',
      '/Users/someone/.wmux/daemon.sock',
    ]) expect(isHarnessAddress(theirs), theirs).toBe(false);
  });

  it('points every instance at the harness namespace, never a real daemon', () => {
    const homes = new Set(scenarios.map((s) => s.env.HOME));
    expect(homes.size, 'scenarios share a home — they would see each other').toBe(
      new Set(scenarios.map((s) => s.env.WMUX_DATA_SUFFIX)).size,
    );

    for (const home of homes) {
      // Both layouts, because the two bridge families read different ones.
      // Directories only: the suffixed auth-token FILE shares the prefix.
      const suffixedDirs = readdirSync(home, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('.wmux-harness'))
        .map((e) => e.name);
      for (const dir of ['.wmux', ...suffixedDirs]) {
        const hint = join(home, dir, 'daemon-pipe');
        expect(existsSync(hint), `${dir}: no daemon-pipe hint — the bridge would derive one`).toBe(true);
        const address = readFileSync(hint, 'utf8').trim();
        expect(
          isHarnessAddress(address),
          `${dir}: hint escapes the harness namespace → ${address}`,
        ).toBe(true);
      }
    }
  });

  // The positive control. Everything else here is an assertion that nothing
  // happened, and a hook that never runs satisfies all of it: exit 0, no
  // output, fast, no survivor. This is the one check that fails when the
  // scenarios stop reaching the thing they claim to be testing against.
  //
  // It has already earned its place. Provisioning wrote only the SUFFIXED
  // token layout, and the openclaude bridge reads the unsuffixed one, so all
  // five of its cases returned at `no-auth-token` in all five scenarios —
  // 25 of the 70 cells measuring an early bail. Nothing in the suite went
  // red. This would have.
  it('actually reaches the daemon in the scenarios that furnish one', async () => {
    const before = daemonRequests();
    const scenario = scenarios.find((s) => daemonFurnishedScenarioIds.includes(s.id));
    expect(scenario, 'no daemon-furnished scenario in the matrix').toBeTruthy();

    // Keyed by INDEX, not by `testCase.id`: two manifest entries with the same
    // event + matcher produce the same id, and a Map keyed on it would drop
    // one of their counts — turning the only case that talks into a phantom
    // "this agent never reached the daemon" failure.
    const served = cases.map(() => 0);
    for (const [i, testCase] of cases.entries()) {
      const at = daemonRequests();
      await runHookCase({ ...testCase, env: scenario.env, budgetMs: KILL_BUDGET_MS });
      served[i] = daemonRequests() - at;
    }

    expect(
      daemonRequests() - before,
      `${scenario.id} served no daemon requests — the hooks bailed before the endpoint`,
    ).toBeGreaterThan(0);

    // Per AGENT, not per case: some events are deliberately dropped before any
    // RPC (the codex ignored-type case is one), so requiring every case to
    // talk would pin behaviour this file has no opinion about. Requiring every
    // agent to talk at least once is what rules out a whole bridge silently
    // sitting out the matrix.
    const byAgent = new Map();
    for (const [i, testCase] of cases.entries()) {
      byAgent.set(testCase.agent, (byAgent.get(testCase.agent) ?? 0) + served[i]);
    }
    const mute = [...byAgent].filter(([, n]) => n === 0).map(([agent]) => agent);
    expect(
      mute,
      'agent(s) whose every case bailed before the daemon — their cells measure an early '
      + 'return, not the hook. Check the token/pipe layout each bridge actually reads.',
    ).toEqual([]);
  }, 180_000);

  // The teeth. Adding integrations/<agent>/ without either a hook manifest or
  // an entry in NON_MANIFEST_INTEGRATIONS fails here, which is the only thing
  // stopping the next adapter from shipping outside this gate.
  it('accounts for every integration directory', () => {
    const integrations = readdirSync(join(REPO_ROOT, 'integrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const withManifests = new Set(discoverHookManifests().map((m) => m.agent));
    const unaccounted = integrations.filter(
      (name) => !withManifests.has(name) && !(name in NON_MANIFEST_INTEGRATIONS),
    );
    expect(
      unaccounted,
      'new integration(s) with no hook manifest and no stated reason — wire them into the '
      + 'harmlessness gate, or record why they need no hook, in NON_MANIFEST_INTEGRATIONS',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The gate itself: silent, prompt, and leaving nothing behind, in every
//    state a user is actually in.
// ---------------------------------------------------------------------------

describe('every installed hook is indistinguishable from a no-op', () => {
  for (const scenarioId of [
    'not-installed',
    'installed-daemon-down',
    'installed-daemon-no-verdict',
    'gate-disabled',
    'headless',
  ]) {
    it(`${scenarioId}: no hook has an opinion, adds latency, or survives`, async () => {
      const scenario = scenarios.find((s) => s.id === scenarioId);
      const control = await runHookCase({
        script: fixtures.noop,
        env: scenario.env,
        payload: { hook_event_name: 'Stop' },
        budgetMs: KILL_BUDGET_MS,
      });
      // Asserted on the raw observation rather than through one contract:
      // exit 0 with empty stdout is "no opinion" under every contract in the
      // table, so the control needs no per-agent interpretation to be a
      // control. (Review: Grok, P3.)
      expect(control.exitCode).toBe(0);
      expect(control.stdout).toBe('');

      const found = [];
      for (const testCase of cases) {
        const result = await runHookCase({ ...testCase, env: scenario.env, budgetMs: KILL_BUDGET_MS });
        found.push(...violations(testCase.id, result, classifyDecision(testCase.contract, result), control));
      }
      expect(found, `${scenarioId} — ${scenario.why}`).toEqual([]);
    }, 180_000);
  }
});

// ---------------------------------------------------------------------------
// 3. stdin drain.
//
// A hook that stops reading stdin leaves the host writing into a pipe with no
// reader. The bridges cap stdin at 1MB by design and drop the signal past it;
// that is a delivery choice, not a harmlessness one. What must hold is that
// the host's write SETTLES — errored is fine, wedged is not — and that the
// hook still exits 0 and silently.
// ---------------------------------------------------------------------------

describe('an oversized payload cannot wedge the host', () => {
  it('settles the write and still exits silently', async () => {
    const scenario = scenarios.find((s) => s.id === 'installed-daemon-down');
    const oversized = JSON.stringify({
      session_id: 'harness-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_response: { text: 'x'.repeat(3 * 1024 * 1024) },
    });
    // Every stdin-taking hook, not just PostToolUse — excluding the
    // permission gate would leave the one surface that already lied to a host
    // out of the deadlock test. (Review: Grok, P2.)
    const stdinCases = cases.filter((c) => c.stdin === 'json');
    expect(stdinCases.length).toBeGreaterThan(0);

    for (const testCase of stdinCases) {
      const result = await runHookCase({
        ...testCase,
        env: scenario.env,
        payload: oversized,
        budgetMs: KILL_BUDGET_MS,
      });
      // The 3MB really left this process; otherwise the pipe was never put
      // under pressure and the case is decorative. (Review: Grok, P1.)
      expect(result.stdinBytes, testCase.id).toBeGreaterThan(1024 * 1024);
      expect(result.timedOut, `${testCase.id} wedged the host`).toBe(false);
      // The write reached a terminal state — completed or errored — rather
      // than sitting in the pipe with nobody reading. That is the deadlock
      // this criterion is about. (Review: Grok, P1.)
      expect(result.stdinSettled, `${testCase.id} left the host's write pending`).toBe(true);
      expect(result.exitCode, testCase.id).toBe(0);
      expect(result.stdout, testCase.id).toBe('');
      expect(result.survivorGapMs, testCase.id).toBeLessThan(MAX_SURVIVOR_GAP_MS);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 4. opencode — the in-process case.
//
// opencode loads a JS plugin into its own process instead of spawning a hook,
// so "exit code" and "surviving process" do not apply. The equivalent harms
// are throwing into the host's event loop and blocking it. The plugin's own
// comment claims it detaches the pipe RPC from the event handler precisely so
// a wedged endpoint cannot add the 2s transport cap to the TUI's idle
// transition — that claim is what this measures.
// ---------------------------------------------------------------------------

describe('the opencode plugin does not block or throw into its host', () => {
  it('returns promptly with no decision, against a daemon that never answers', async () => {
    // A WEDGED endpoint, not an absent one. Against an absent pipe the RPC
    // fails instantly and a plugin that forgot to detach would still look
    // fast; here a non-detached handler sits on the 2s transport cap and this
    // test catches it.
    const keys = ['USERPROFILE', 'HOME', 'WMUX_DATA_SUFFIX', 'WMUX_PTY_ID'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) {
      const value = wedgedDaemonEnv[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
    try {
      const { WmuxBridge } = await import('../../integrations/opencode/plugins/wmux.js');
      const plugin = await WmuxBridge({ directory: sandbox.home, client: undefined });

      const events = [
        { type: 'session.idle', properties: { sessionID: 'harness-session' } },
        { type: 'permission.asked', properties: { id: 'perm-1', sessionID: 'harness-session', title: 'Run ls' } },
        { type: 'permission.replied', properties: { id: 'perm-1' } },
        { type: 'some.future.event', properties: {} },
        // Malformed shapes the host could hand it. Never throw upward.
        { type: 'session.idle' },
        {},
        null,
      ];
      for (const event of events) {
        const startedAt = process.hrtime.bigint();
        const returned = await plugin.event({ event });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // No decision channel: the handler's value must stay undefined.
        expect(returned, JSON.stringify(event)).toBeUndefined();
        // The detachment claim. Generous enough for a cold CI runner, still
        // well below the 2s transport cap this is there to keep off the loop —
        // and the daemon above is wedged, so a non-detached handler would sit
        // on that full cap and land outside this bound.
        expect(elapsedMs, `${JSON.stringify(event)} blocked the host loop`).toBeLessThan(1_000);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
