#!/usr/bin/env node
// factory-smoke: agent-factory behaviour scenarios against an isolated
// instance of THIS checkout's build (unpackaged Electron), graded from an
// evidence snapshot the harness exports after the instance stops.
//
//   node scripts/factory-smoke.mjs --list
//   node scripts/factory-smoke.mjs --scenario reply-in-wake-thread[,other]
//   node scripts/factory-smoke.mjs --all [--layer regression|workflow] [--model stub|real] [--runs N]
//   node scripts/factory-smoke.mjs --grade <evidence.json>      (re-grade a saved snapshot)
//
// Needs a built checkout (`npm run package` or the dev build that fills
// .vite/build and dist/mcp-bundle). See scripts/factory-scenarios/README.md.
//
// One run of one scenario:
//   1. a temp dir with the run's stand-ins: a scripted GitHub (`gh` on the
//      instance's PATH only), a scripted fan-out worker (`claude` on the same
//      PATH, stub scenarios only), an ssh stand-in that serves the scratch
//      repo's fake GitHub remote from a local bare repo, and one ACP stub
//      script per bot;
//   2. `control-wmux launch` of a wrapper that exports those and runs
//      Electron on this checkout (isolated WMUX_DATA_SUFFIX);
//   3. the factory switched on and the scenario's bots created as the
//      operator, each on `BotEngine {kind:'acp'}` running scripts/acp-stub.mjs
//      with its own script (or the default engine for `model: real`);
//   4. the scenario's actions, each one recorded; waits are observation only
//      (files in the instance's data dir, polled);
//   5. `control-wmux stop`, then the evidence snapshot is read from the data
//      dir (the bots are gone by then, so nothing they do can change it), the
//      instance's data is removed, and the graders score the snapshot.
// A run whose snapshot is missing or incomplete is an ERROR (harness), not a
// FAIL (behaviour).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimOwnedBy, suffixRefusal, suffixedPaths } from './lib/control-wmux-lib.mjs';
import { lockGhState, writeGhStateFile } from './factory-e2e/gh-state-lock.mjs';
import {
  appLogExcerpt,
  buildSnapshot,
  conditionHolds,
  fillTemplate,
  loadScenarios,
  readLiveState,
  selectCard,
} from './lib/factory-smoke-lib.mjs';
import { gradeSnapshot, GRADERS } from './factory-graders/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = path.join(REPO_ROOT, 'scripts', 'control-wmux.mjs');
const STATE_FILE = path.join(REPO_ROOT, '.claude', 'skills', 'verify-wmux', '.run', 'state.json');
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.claude', 'skills', 'verify-wmux', 'evidence');
const CLAIM_DIR = path.join(os.homedir(), '.cache', 'wmux-cdp');
const STUB = path.join(REPO_ROOT, 'scripts', 'acp-stub.mjs');
const FAKE_GH = path.join(REPO_ROOT, 'scripts', 'factory-e2e', 'fake-gh.mjs');
const FAKE_CLAUDE = path.join(REPO_ROOT, 'scripts', 'factory-e2e', 'fake-claude.mjs');
const FAKE_CODEX = path.join(REPO_ROOT, 'scripts', 'factory-e2e', 'fake-codex.mjs');
const MCP_BUNDLE = path.join(REPO_ROOT, 'dist', 'mcp-bundle', 'index.js');
const ELECTRON = process.platform === 'darwin'
  ? path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron');
const NODE = process.execPath;

const REPO_KEY = 'github.com/acme/app';
const REPO_URL = 'ssh://git@github.com/acme/app.git';
const TRUSTED_AUTHOR = 'octo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HarnessError extends Error {}

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return opts;
}

// ── control-wmux ────────────────────────────────────────────────────────────

function control(cmd, args = [], timeoutMs = 120_000) {
  const r = spawnSync(NODE, [CONTROL, cmd, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = { ok: false, error: `control-wmux ${cmd}: no JSON (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 500)}` };
  }
  return out;
}

/** One CDP connection to the launched instance's main window. */
class Driver {
  /** @param {string} suffix the suffix this run launched; the driver attaches to nothing else */
  constructor(suffix) {
    this.suffix = suffix;
    this.browser = null;
    this.page = null;
  }

  async connect() {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.suffix !== this.suffix) throw new HarnessError(`control-wmux state names ${state.suffix}, not this run's ${this.suffix}; refusing to attach`);
    if (!state.cdpPort || !claimOwnedBy(CLAIM_DIR, state.cdpPort, state.pid)) {
      throw new HarnessError(`CDP port of pid ${state.pid} is not claimed by it; refusing to attach`);
    }
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`, { timeout: 15_000 });
    for (let i = 0; i < 40 && !this.page; i++) {
      for (const ctx of this.browser.contexts()) {
        for (const p of ctx.pages()) {
          const url = p.url();
          if (/^file:/.test(url) && /\/index\.html$/.test(new URL(url).pathname)) this.page = p;
        }
      }
      if (!this.page) await sleep(250);
    }
    if (!this.page) throw new HarnessError('main window not found over CDP');
    // The preload bridge appears with the first render.
    for (let i = 0; i < 60; i++) {
      if (await this.page.evaluate(() => !!window.electronAPI?.rpc?.invoke && !!window.electronAPI?.factory)) return;
      await sleep(250);
    }
    throw new HarnessError('electronAPI bridge did not appear');
  }

  /** `window.electronAPI.<dotted>(...args)`. */
  async api(dotted, ...args) {
    return this.page.evaluate(async ({ dotted: d, args: a }) => {
      const parts = d.split('.');
      const fn = parts.reduce((o, k) => (o ? o[k] : undefined), window.electronAPI);
      if (typeof fn !== 'function') return { __harnessError: `electronAPI.${d} is not a function` };
      const r = await fn(...a);
      return JSON.parse(JSON.stringify(r ?? null));
    }, { dotted, args });
  }

  /** An operator RPC through the pipe router: the handler's result, or a
   *  `{ok:false, envelopeError}` when the router refused it. */
  async rpc(method, params = {}) {
    const env = await this.api('rpc.invoke', method, params);
    if (env && env.ok === true) return env.result;
    return { ok: false, envelopeError: env?.error ?? env?.__harnessError ?? 'no response' };
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }
}

// ── the run's stand-ins ─────────────────────────────────────────────────────

function sh(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function git(args, cwd, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new HarnessError(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

const GIT_ID = ['-c', 'user.name=factory-smoke', '-c', 'user.email=factory-smoke@example.invalid'];

/** A bare "GitHub" repo plus the bot's clone of it over the ssh stand-in. */
function makeRepo(ctx) {
  const origin = path.join(ctx.tmp, 'origin.git');
  const seed = path.join(ctx.tmp, 'seed');
  const work = path.join(ctx.tmp, 'app');
  git(['init', '-q', '--bare', '-b', 'main', origin], ctx.tmp);
  git(['init', '-q', '-b', 'main', seed], ctx.tmp);
  fs.writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({
    name: 'factory-smoke-app',
    version: '1.0.0',
    private: true,
    scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(seed, 'README.md'), '# factory smoke scratch repo\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  git(['add', '-A'], seed);
  git([...GIT_ID, 'commit', '-q', '-m', 'init'], seed);
  git(['push', '-q', origin, 'main'], seed);
  git(['clone', '-q', REPO_URL, work], ctx.tmp, { GIT_SSH_COMMAND: ctx.fakeSsh });
  ctx.repo = { origin, seed, work, key: REPO_KEY, url: REPO_URL };
}

function writeGhState(ctx, state) {
  writeGhStateFile(ctx.ghState, state);
}

function readGhState(ctx) {
  return JSON.parse(fs.readFileSync(ctx.ghState, 'utf8'));
}

function prepare(ctx) {
  const { sc } = ctx;
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-fsmoke-${sc.name.slice(0, 24)}-`));
  const bin = path.join(ctx.tmp, 'bin');
  const zdot = path.join(ctx.tmp, 'zdotdir');
  ctx.logDir = path.join(ctx.tmp, 'logs');
  for (const d of [bin, zdot, ctx.logDir, path.join(ctx.tmp, 'stub'), path.join(ctx.tmp, 'gh-config')]) fs.mkdirSync(d, { recursive: true });
  // Worker panes run zsh with this ZDOTDIR instead of the user's rc files;
  // its .zshrc runs after the login PATH setup, so the stand-ins come first.
  fs.writeFileSync(path.join(zdot, '.zshrc'), `export PATH="${bin}:$PATH"\n`);
  ctx.ghState = path.join(ctx.tmp, 'gh-state.json');
  ctx.ghLog = path.join(ctx.logDir, 'gh-calls.jsonl');
  ctx.workerLog = path.join(ctx.logDir, 'workers.jsonl');
  ctx.fakeSsh = path.join(ctx.tmp, 'fake-ssh');
  // The ssh stand-in: any git transport command for github.com/acme/app is
  // served from the local bare repo; everything else goes to the real ssh.
  sh(ctx.fakeSsh, [
    'for a; do last="$a"; done',
    'case "$last" in',
    `  git-upload-pack*acme/app*|git-receive-pack*acme/app*|git-upload-archive*acme/app*) exec "\${last%% *}" "${path.join(ctx.tmp, 'origin.git')}";;`,
    'esac',
    // Anything else is refused: the instance never reaches a real remote.
    'echo "factory-smoke ssh stand-in: refusing $*" >&2',
    'exit 128',
  ].join('\n'));
  sh(path.join(bin, 'gh'), `exec "${NODE}" "${FAKE_GH}" "$@"`);
  if ((sc.model ?? 'stub') !== 'real') {
    sh(path.join(bin, 'claude'), `exec "${NODE}" "${FAKE_CLAUDE}" "$@"`);
    sh(path.join(bin, 'codex'), `exec "${NODE}" "${FAKE_CODEX}" "$@"`);
  }
  if (sc.setup?.repo) makeRepo(ctx);
  ctx.vars = {
    repoKey: REPO_KEY,
    repoPath: ctx.repo?.work ?? null,
    trustedAuthor: TRUSTED_AUTHOR,
    now: new Date().toISOString(),
  };
  const gh = fillTemplate(sc.setup?.gh ?? {}, ctx.vars);
  writeGhState(ctx, {
    login: TRUSTED_AUTHOR,
    repos: { [REPO_KEY]: { prs: (gh.prs ?? []).map((p) => prDefaults(p)), issues: (gh.issues ?? []).map((i) => issueDefaults(i)) } },
  });
  const worker = sc.setup?.worker ?? {};
  ctx.wrapper = path.join(ctx.tmp, 'wmux-dev.sh');
  sh(ctx.wrapper, [
    '# factory-smoke: this checkout\'s unpackaged build with the run\'s stand-ins first on PATH.',
    `export PATH="${bin}:$PATH"`,
    `export ZDOTDIR="${zdot}"`,
    `export GIT_SSH_COMMAND="${ctx.fakeSsh}"`,
    // A real gh a worker pane might still find has no credentials here.
    `export GH_CONFIG_DIR="${path.join(ctx.tmp, 'gh-config')}"`,
    'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN',
    `export FACTORY_E2E_GH_STATE="${ctx.ghState}"`,
    `export FACTORY_E2E_GH_LOG="${ctx.ghLog}"`,
    `export FACTORY_E2E_WORKER_LOG="${ctx.workerLog}"`,
    `export FACTORY_E2E_MCP_BUNDLE="${MCP_BUNDLE}"`,
    `export FACTORY_E2E_NODE="${NODE}"`,
    `export FACTORY_E2E_WORKER_DELAY_MS="${Number(worker.delayMs ?? 1500)}"`,
    `export FACTORY_E2E_WORKER_STATUS="${worker.status ?? 'review_requested'}"`,
    `export FACTORY_E2E_WORKER_COMMIT="${worker.commit ? '1' : '0'}"`,
    // A scenario's test knobs (main honours them only on an isolated instance).
    ...Object.entries(sc.setup?.env ?? {})
      .filter(([k, v]) => /^WMUX_TEST_[A-Z0-9_]+$/.test(k) && /^[A-Za-z0-9_.:-]{0,200}$/.test(String(v)))
      .map(([k, v]) => `export ${k}="${String(v)}"`),
    `exec "${ELECTRON}" "${REPO_ROOT}" --use-mock-keychain`,
  ].join('\n'));
}

function prDefaults(p) {
  return {
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    labels: [],
    createdAt: new Date().toISOString(),
    checks: 'SUCCESS',
    requiredChecks: [],
    files: ['src/index.ts'],
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    author: TRUSTED_AUTHOR,
    ...p,
  };
}

function issueDefaults(i) {
  return { state: 'OPEN', labels: [], createdAt: new Date().toISOString(), author: 'reporter', body: '', ...i };
}

// ── launch / stop ───────────────────────────────────────────────────────────

async function launch(ctx) {
  const r = control('launch', ['--app', ctx.wrapper, '--suffix', ctx.suffix, '--timeout', '90000'], 150_000);
  ctx.launches.push({ ok: r.ok, runId: r.runId ?? null, evidenceDir: r.evidenceDir ?? null, error: r.ok ? undefined : r.error });
  // control-wmux records an instance it spawned even when it never got
  // ready; only a record that names this run's suffix is ours to stop.
  ctx.launched = readControlState()?.suffix === ctx.suffix;
  if (!r.ok) throw new HarnessError(`launch failed: ${r.error ?? JSON.stringify(r).slice(0, 300)}`);
  ctx.home = os.homedir();
  ctx.wmuxDir = path.join(ctx.home, `.wmux${ctx.suffix}`);
  ctx.driver = new Driver(ctx.suffix);
  await ctx.driver.connect();
}

function readControlState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Stop the instance this run launched (never another one: the recorded
 *  suffix must be this run's). A stop that leaves a process behind is a
 *  harness error, and the run's data is then left in place. */
async function stop(ctx) {
  await ctx.driver?.close();
  ctx.driver = null;
  if (!ctx.launched) return;
  if (readControlState()?.suffix !== ctx.suffix) {
    ctx.errors.push(`control-wmux state no longer names ${ctx.suffix}; not stopping`);
    ctx.stopFailed = true;
    return;
  }
  const r = control('stop', [], 60_000);
  ctx.launched = false;
  ctx.stops.push({ ok: r.ok, steps: r.steps ?? [], leftover: r.leftover ?? [], error: r.ok ? undefined : r.error });
  if (!r.ok) {
    ctx.errors.push(`stop failed: ${r.error ?? `left ${JSON.stringify(r.leftover ?? [])} running`}`);
    ctx.stopFailed = true;
  }
}

/** Remove what the instance wrote under the user's home (only paths that
 *  carry this run's suffix, which control-wmux validated at launch). */
function purge(ctx) {
  if (suffixRefusal(ctx.suffix) || ctx.stopFailed) return;
  for (const p of suffixedPaths(os.homedir(), ctx.suffix)) {
    if (!path.basename(p).includes(ctx.suffix) || !fs.existsSync(p)) continue;
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// ── setup and actions ───────────────────────────────────────────────────────

async function firstWorkspaceId(driver) {
  for (let i = 0; i < 40; i++) {
    const r = await driver.rpc('workspace.list', {});
    const text = JSON.stringify(r ?? null);
    const m = /"(ws-[0-9a-f-]{8,})"/.exec(text);
    if (m) return m[1];
    await sleep(500);
  }
  throw new HarnessError('no workspace id from workspace.list');
}

function stubEngine(ctx, key, script) {
  const file = path.join(ctx.tmp, 'stub', `${key}.json`);
  const log = path.join(ctx.logDir, `stub-${key}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(script, null, 2)}\n`);
  ctx.stubLogs[key] = log;
  return { kind: 'acp', command: NODE, args: [STUB, '--script', file, '--log', log] };
}

async function setup(ctx) {
  const { sc, driver } = ctx;
  ctx.workspaceId = await firstWorkspaceId(driver);
  ctx.vars.ws = ctx.workspaceId;
  // The factory modules start a moment after the window: a null answer means
  // the settings store is not up yet.
  let settings = null;
  for (let i = 0; i < 60 && !settings; i++) {
    settings = await driver.api('factory.setSettings', {
      enabled: true,
      // The run stands in for the owner's "Bots run on your Claude plan" consent.
      planConsent: { version: 1, at: new Date().toISOString() },
      hqWorkspaceId: ctx.workspaceId,
      trustedAuthors: [TRUSTED_AUTHOR],
      ...(sc.setup?.settings ?? {}),
    });
    if (!settings) await sleep(500);
  }
  if (!settings || settings.enabled !== true) throw new HarnessError(`factory settings were not applied: ${JSON.stringify(settings)}`);
  ctx.vars.bot = {};
  for (const b of sc.setup?.bots ?? []) {
    const real = (sc.model ?? 'stub') === 'real' && !b.script;
    // A bot is a name, an optional template and job, and (legacy) a role tag;
    // main fills whichever of template / role is left out.
    const params = {
      workspaceId: ctx.workspaceId,
      ...(b.role ? { role: b.role } : {}),
      ...(b.template ? { template: b.template } : {}),
      ...(b.job ? { job: b.job } : {}),
      ...(b.greet === true ? { greet: true } : {}),
      ...(b.name ? { name: b.name } : {}),
      ...(real ? {} : { engine: stubEngine(ctx, b.key, fillTemplate(b.script ?? { turns: [{ steps: [] }] }, ctx.vars)) }),
      ...(b.repo && ctx.repo ? { repo: { repoKey: REPO_KEY, repoPath: ctx.repo.work } } : {}),
      ...(b.budget ? { budget: b.budget } : {}),
      ...(b.triggers ? { triggers: b.triggers } : {}),
    };
    const r = await driver.rpc('bot.create', params);
    if (!r || r.ok !== true) throw new HarnessError(`bot.create ${b.key} failed: ${JSON.stringify(r)}`);
    ctx.bots[b.key] = r.bot.id;
    ctx.vars.bot[b.key] = r.bot.id;
  }
  // Stub scripts that name another bot's id are written after every bot exists.
  for (const b of sc.setup?.bots ?? []) {
    if (b.script && JSON.stringify(b.script).includes('{{bot.')) {
      fs.writeFileSync(path.join(ctx.tmp, 'stub', `${b.key}.json`), `${JSON.stringify(fillTemplate(b.script, ctx.vars), null, 2)}\n`);
    }
  }
}

function live(ctx) {
  return readLiveState(ctx.wmuxDir, { stub: ctx.stubLogs, workers: ctx.workerLog, ghCalls: ctx.ghLog });
}

async function waitFor(ctx, cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const quietMs = cond.quietMs ?? 0;
  let heldSince = null;
  for (;;) {
    let holds = false;
    try {
      holds = conditionHolds(cond, live(ctx), ctx.bots);
    } catch {
      holds = false;
    }
    if (holds) {
      heldSince ??= Date.now();
      if (Date.now() - heldSince >= quietMs) return true;
    } else heldSince = null;
    if (Date.now() > deadline) {
      ctx.timeouts.push({ label: label ?? 'wait', cond });
      return false;
    }
    await sleep(500);
  }
}

function originBranch(ctx, prefix) {
  const out = git(['for-each-ref', `refs/heads/${prefix}`, '--format=%(refname:short) %(objectname)'], ctx.repo.origin);
  const rows = out.split('\n').filter(Boolean).map((l) => {
    const [name, sha] = l.split(' ');
    return { name, sha };
  });
  return rows[0] ?? null;
}

/** Scripted-GitHub edits (the PR/issue state the fake gh serves). */
function ghAction(ctx, a) {
  // The fake gh writes this file too (a merge, a PR it creates): the edit
  // holds the same lock from its read to its write.
  const release = lockGhState(ctx.ghState);
  if (!release) throw new HarnessError('the fake gh state lock was not released');
  try {
    ghEdit(ctx, a);
  } finally {
    release();
  }
}

function ghEdit(ctx, a) {
  const state = readGhState(ctx);
  const repo = state.repos[REPO_KEY];
  const now = new Date().toISOString();
  switch (a.op) {
    case 'addIssue':
      repo.issues.push(issueDefaults({ ...a.issue, createdAt: now }));
      break;
    case 'addPr': {
      const pr = prDefaults({ ...a.pr, createdAt: now });
      if (a.fromBranch) {
        const b = originBranch(ctx, a.fromBranch);
        if (!b) throw new HarnessError(`no origin branch under ${a.fromBranch}`);
        pr.headRefName = b.name;
        pr.headSha = b.sha;
      } else if (!pr.headSha) {
        pr.headSha = git(['rev-parse', 'HEAD'], ctx.repo.seed);
        pr.headRefName ??= 'feature';
      }
      // GitHub keeps every PR head at refs/pull/<n>/head.
      git(['update-ref', `refs/pull/${pr.number}/head`, pr.headSha], ctx.repo.origin);
      repo.prs.push(pr);
      ctx.saved[`pr${pr.number}Head`] = pr.headSha;
      ctx.saved[`pr${pr.number}Branch`] = pr.headRefName;
      break;
    }
    case 'setPr': {
      const pr = repo.prs.find((p) => p.number === a.number);
      if (!pr) throw new HarnessError(`no PR #${a.number}`);
      Object.assign(pr, a.patch);
      break;
    }
    case 'moveHead': {
      const pr = repo.prs.find((p) => p.number === a.number);
      if (!pr) throw new HarnessError(`no PR #${a.number}`);
      const tmp = path.join(ctx.tmp, `move-${a.number}-${Date.now()}`);
      git(['clone', '-q', '--branch', pr.headRefName, ctx.repo.origin, tmp], ctx.tmp);
      fs.writeFileSync(path.join(tmp, `moved-${Date.now()}.txt`), 'moved\n');
      git(['add', '-A'], tmp);
      git([...GIT_ID, 'commit', '-q', '-m', 'move head'], tmp);
      git(['push', '-q', 'origin', `HEAD:refs/heads/${pr.headRefName}`], tmp);
      pr.headSha = git(['rev-parse', 'HEAD'], tmp);
      git(['update-ref', `refs/pull/${pr.number}/head`, pr.headSha], ctx.repo.origin);
      ctx.saved[`pr${pr.number}Head`] = pr.headSha;
      break;
    }
    default:
      throw new HarnessError(`unknown gh op ${a.op}`);
  }
  writeGhState(ctx, state);
}

async function doAction(ctx, raw) {
  const a = fillTemplate(raw, { ...ctx.vars, saved: ctx.saved });
  const { driver } = ctx;
  const rec = { at: Date.now(), do: a.do, ...(a.label ? { label: a.label } : {}) };
  ctx.actions.push(rec);
  switch (a.do) {
    case 'sleep':
      await sleep(a.ms ?? 1000);
      break;
    case 'emit': {
      const r = await driver.rpc('fact.emit', { at: Date.now(), ...a.fact });
      rec.result = r;
      if (r?.ok) ctx.injected.push({ label: a.label ?? null, kind: 'fact', id: r.fact.id, factKind: r.fact.kind, at: rec.at });
      else if (!a.allowRefusal) throw new HarnessError(`fact.emit refused: ${JSON.stringify(r)}`);
      break;
    }
    case 'post': {
      const r = await driver.api('rooms.post', { workspaceId: ctx.workspaceId, ...a.post });
      rec.result = r;
      if (r?.ok && r.card) ctx.injected.push({ label: a.label ?? null, kind: 'card', id: r.card.id, threadId: r.card.threadId, at: rec.at });
      else if (!a.allowRefusal) throw new HarnessError(`rooms.post refused: ${JSON.stringify(r)}`);
      break;
    }
    case 'wake': {
      const botId = ctx.bots[a.bot];
      const r = await driver.rpc('bot.wake', { botId, ...(a.text ? { text: a.text } : {}), ...(a.threadId ? { threadId: a.threadId } : {}) });
      rec.result = r;
      if (r?.ok) ctx.injected.push({ label: a.label ?? null, kind: 'wake', id: r.wake.id, botKey: a.bot, at: rec.at });
      else if (!a.allowRefusal) throw new HarnessError(`bot.wake refused: ${JSON.stringify(r)}`);
      break;
    }
    case 'rpc': {
      const r = await driver.rpc(a.method, a.params ?? {});
      rec.result = r;
      if (a.save) for (const [k, p] of Object.entries(a.save)) ctx.saved[k] = p.split('.').reduce((o, x) => (o ? o[x] : undefined), r);
      break;
    }
    case 'api': {
      const r = await driver.api(a.fn, ...(a.args ?? []));
      rec.result = r;
      if (a.record) ctx.records.push({ label: a.label ?? a.fn, result: r });
      if (a.save) for (const [k, p] of Object.entries(a.save)) ctx.saved[k] = p.split('.').reduce((o, x) => (o ? o[x] : undefined), r);
      break;
    }
    case 'resolve': {
      const card = selectCard(live(ctx).cards, a.card, ctx.bots);
      if (!card) throw new HarnessError(`no card for ${JSON.stringify(a.card)}`);
      const r = await driver.api('rooms.resolve', { workspaceId: card.workspaceId, cardId: card.id, resolution: a.resolution });
      rec.result = r;
      rec.cardId = card.id;
      ctx.injected.push({ label: a.label ?? null, kind: 'resolution', id: card.id, at: rec.at });
      break;
    }
    case 'gh':
      ghAction(ctx, a);
      rec.op = a.op;
      break;
    case 'waitFor': {
      const ok = await waitFor(ctx, a.cond, a.timeoutMs ?? 60_000, a.label);
      rec.ok = ok;
      rec.doneAt = Date.now();
      if (!ok && a.required) throw new HarnessError(`wait "${a.label ?? 'waitFor'}" timed out`);
      break;
    }
    case 'restart':
      await stop(ctx);
      await launch(ctx);
      break;
    case 'snapshotRead': {
      // A read whose result the grader scores (paging, unread): recorded as is.
      const r = await driver.api(a.fn, ...(a.args ?? []));
      ctx.records.push({ label: a.label ?? a.fn, result: r });
      rec.result = { recorded: true };
      break;
    }
    case 'readPages': {
      // Page a room read by its cursor until hasMore is false; every page is recorded.
      const pages = [];
      let sinceSeq = a.params?.sinceSeq;
      for (let i = 0; i < (a.maxPages ?? 20); i++) {
        const r = await driver.api('rooms.read', { workspaceId: ctx.workspaceId, ...a.params, ...(sinceSeq !== undefined ? { sinceSeq } : {}) });
        pages.push(r);
        if (!r?.ok || !r.hasMore) break;
        sinceSeq = r.nextSinceSeq;
      }
      ctx.records.push({ label: a.label ?? 'pages', result: pages });
      rec.result = { pages: pages.length };
      break;
    }
    case 'markRead': {
      const r = await driver.api('rooms.read', { workspaceId: ctx.workspaceId, threadId: a.threadId, limit: 100 });
      const last = Array.isArray(r?.cards) && r.cards.length ? r.cards[r.cards.length - 1].seq : null;
      if (last === null) throw new HarnessError(`markRead: thread ${a.threadId} has no cards`);
      rec.result = await driver.api('rooms.read', { workspaceId: ctx.workspaceId, threadId: a.threadId, limit: 1, markThroughSeq: last });
      rec.throughSeq = last;
      break;
    }
    case 'loop': {
      for (let i = 0; i < (a.times ?? 1); i++) {
        for (const inner of a.actions ?? []) await doAction(ctx, fillTemplate(inner, { i, i1: i + 1 }));
      }
      break;
    }
    default:
      throw new HarnessError(`unknown action ${a.do}`);
  }
}

// ── one run ─────────────────────────────────────────────────────────────────

function collectAppLog(ctx) {
  const lines = [];
  for (const l of ctx.launches) {
    if (!l.evidenceDir) continue;
    try {
      lines.push(...appLogExcerpt(fs.readFileSync(path.join(l.evidenceDir, 'app.log'), 'utf8')));
    } catch {
      /* no log */
    }
  }
  return lines;
}

export async function runOnce(sc, run, outRoot) {
  const ctx = {
    sc,
    run,
    suffix: `-verify-f9${crypto.randomBytes(3).toString('hex')}`,
    bots: {},
    stubLogs: {},
    injected: [],
    actions: [],
    records: [],
    timeouts: [],
    errors: [],
    saved: {},
    launches: [],
    stops: [],
    driver: null,
  };
  const started = Date.now();
  let snapshot = null;
  try {
    prepare(ctx);
    await launch(ctx);
    await setup(ctx);
    for (const a of sc.actions ?? []) await doAction(ctx, a);
  } catch (err) {
    ctx.errors.push(err instanceof HarnessError ? err.message : String(err?.stack ?? err));
  } finally {
    try {
      await stop(ctx);
    } catch (err) {
      ctx.errors.push(`stop failed: ${String(err)}`);
    }
    if (ctx.wmuxDir) {
      snapshot = buildSnapshot({
        wmuxDir: ctx.wmuxDir,
        scenario: sc.name,
        run,
        logs: { stub: ctx.stubLogs, workers: ctx.workerLog, ghCalls: ctx.ghLog, ghState: ctx.ghState },
        injected: ctx.injected,
        actions: ctx.actions,
        errors: ctx.errors,
        bots: ctx.bots,
        workspaceId: ctx.workspaceId ?? null,
        extra: {
          records: ctx.records,
          timeouts: ctx.timeouts,
          saved: ctx.saved,
          launches: ctx.launches,
          stops: ctx.stops,
          appLog: collectAppLog(ctx),
          durationMs: Date.now() - started,
        },
      });
    }
    try {
      purge(ctx);
    } catch (err) {
      ctx.errors.push(`purge failed: ${String(err)}`);
    }
  }
  const dir = path.join(outRoot, `${sc.name}-r${run}`);
  fs.mkdirSync(dir, { recursive: true });
  if (snapshot) fs.writeFileSync(path.join(dir, 'evidence.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  const graded = gradeSnapshot(sc, snapshot);
  fs.writeFileSync(path.join(dir, 'grade.json'), `${JSON.stringify(graded, null, 2)}\n`);
  if (!process.env.FACTORY_SMOKE_KEEP_TMP && ctx.tmp) fs.rmSync(ctx.tmp, { recursive: true, force: true });
  return { scenario: sc.name, run, dir, ...graded, durationMs: Date.now() - started };
}

// ── main ────────────────────────────────────────────────────────────────────

function table(results) {
  const lines = ['| scenario | run | result | criteria | evidence |', '|---|---|---|---|---|'];
  for (const r of results) {
    const crit = r.criteria.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join('<br>');
    lines.push(`| ${r.scenario} | ${r.run} | ${r.status.toUpperCase()} | ${crit} | ${path.relative(REPO_ROOT, r.dir)} |`);
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.grade) {
    const snap = JSON.parse(fs.readFileSync(String(opts.grade), 'utf8'));
    const sc = loadScenarios().find((s) => s.name === snap.scenario);
    process.stdout.write(`${JSON.stringify(gradeSnapshot(sc, snap), null, 2)}\n`);
    return;
  }
  const all = loadScenarios();
  if (opts.list) {
    for (const s of all) process.stdout.write(`${s.name}\t${s.layer}\t${s.model ?? 'stub'}\truns=${s.runs ?? 1}\t${GRADERS[s.name] ? 'graded' : 'NO GRADER'}\n`);
    return;
  }
  const names = typeof opts.scenario === 'string' ? opts.scenario.split(',') : null;
  const model = typeof opts.model === 'string' ? opts.model : 'stub';
  const picked = all.filter((s) => (names ? names.includes(s.name) : opts.all === true)
    && (names || typeof opts.layer !== 'string' || s.layer === opts.layer)
    && (names || (s.model ?? 'stub') === model));
  if (picked.length === 0) {
    process.stderr.write('no scenario picked: pass --scenario <name> or --all (see --list)\n');
    process.exitCode = 1;
    return;
  }
  for (const s of picked) {
    if ((s.model ?? 'stub') === 'real' && !opts['allow-real']) {
      process.stderr.write(`${s.name} runs a real model; pass --allow-real to run it\n`);
      process.exitCode = 1;
      return;
    }
  }
  const outRoot = path.join(EVIDENCE_ROOT, `factory-smoke-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(outRoot, { recursive: true });
  const results = [];
  for (const sc of picked) {
    const runs = opts.runs !== undefined ? Number(opts.runs) : sc.runs ?? 1;
    for (let k = 1; k <= runs; k++) {
      process.stderr.write(`[factory-smoke] ${sc.name} run ${k}/${runs} …\n`);
      const r = await runOnce(sc, k, outRoot);
      results.push(r);
      process.stderr.write(`[factory-smoke] ${sc.name} run ${k}: ${r.status.toUpperCase()} (${Math.round(r.durationMs / 1000)}s)\n`);
      fs.writeFileSync(path.join(outRoot, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
      fs.writeFileSync(path.join(outRoot, 'results.md'), `${table(results)}\n`);
    }
  }
  process.stdout.write(`${table(results)}\n\nresults: ${path.relative(REPO_ROOT, outRoot)}\n`);
  if (results.some((r) => r.status !== 'pass')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
