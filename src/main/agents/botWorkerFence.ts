// ─── The worker fence on a bot's worker launch ─────────────────────────────
//
// What main does to put an unattended bot worker inside the worker fence
// (workerFence.ts) when it launches it (botWorkerMergeGuard.ts):
//
//   - which launches are fenced: a claude line in `bypassPermissions` or
//     `auto` mode, unless the owner turned the fence off for the bot's
//     workspace (workerFencePolicy.ts) and the session did not start fenced;
//   - how strong: on a platform whose OS sandbox claude can run (macOS;
//     Linux with bwrap and socat; claude at or above
//     BOT_EXEC_MIN_CLAUDE_VERSION, probeBotExecSupport) the full fence, once a
//     self-test proved it (below). Elsewhere (Windows, Linux without
//     bubblewrap) the weaker fence: the hook and the permission denies, and a
//     "weaker fence" line in the pane's status line. A WSL pane gets the
//     permission denies only (its claude runs inside the distro, where this
//     build's hook runtime does not), and says so the same way;
//   - the facts the fence is built from: the worktree's git layout, read from
//     its files (and checked against the task ledger's), its own temp folder,
//     and the credential paths;
//   - what refuses the launch: a worktree whose `.claude`, `.claude/settings*`
//     or `.mcp.json` is a link out of the worktree, project settings that
//     would loosen the fence, and every refusal of workerFenceLaunch.
//
// The self-test (one per app session, platform and claude binary): claude
// runs one Bash command, scripted by a local stand-in for the Messages API,
// inside a fence built the same way, and that command tries to write a file
// outside the fence's writable folders. It passes only when the command ran
// and the file was not written. A claude that fails it starts its workers
// with no tools (every call refused), and the pane's status line says why.
// On macOS a second run tries the worktree patterns
// (workerFenceWorktreeComplement) at their most, in a linked worktree's
// layout: its command writes the git common dir (proving claude opened it),
// its own worktree's git folder (which must work), and another worktree's of
// each kind of pattern and a new one (which must not). Launches add the
// patterns only after that held; if it did not, they keep to the snapshot
// of other worktrees, and the workers keep their tools. Refs and objects stay
// as before: a branch made after launch, and the objects every worktree
// shares, are open to the worker's commands.
// No model and no sign-in are used: the stand-in answers on 127.0.0.1, and
// claude runs with a home and config folder of its own.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tokenize, type PermissionMode } from '../../shared/agentResume';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import { contentFileName } from '../../shared/botWorkerMcp';
import { WORKER_TEMP_NAME, isClaudeLauncher, isFencedMode, linePermissionMode, namesClaude, readJsonObject, settingsDefaultMode, workerFenceFolderRefusal, workerTempRoot } from '../../shared/botWorkerGuard';
import { claudeProjectFolder } from '../../shared/claudeProjectFolder';
import { agentExecEnv } from '../../shared/execEnv';
import { shellQuote } from '../../shared/resumeShell';
import { getWmuxDir } from '../../daemon/config';
import { getAccountStore } from '../account/accountStore';
import { resolveClaudeExecutable } from '../claude/resolveClaudeExecutable';
import { botExecPlatformRefusal, probeBotExecSupport } from '../factory/botExecSandbox';
import {
  buildWorkerFence,
  workerFenceCredentialPaths,
  workerFenceHookCommand,
  workerFenceHookScript,
  isWithin,
  workerFenceGitWrites,
  workerFencePermissionDenies,
  workerFenceWorktreeComplement,
  WORKER_FENCE_DENY_WRITE_MAX_BYTES,
  WORKER_FENCE_REFUSED_WMUX_TOOLS,
} from './workerFence';

// ── Which launches ───────────────────────────────────────────────────────────

// The pure parts are shared (the daemon's phone launch reads them too).
export { isFencedMode, linePermissionMode, settingsDefaultMode, workerFenceFolderRefusal };

/** The user settings a fenced worker still needs although it loads none
 *  (`--setting-sources project`): how it reaches its model (`env`, `model`,
 *  `apiKeyHelper`, the AWS helpers), from the owner's own file, which no
 *  worker can write. Variables that would move the fence's temp folder or
 *  touch the sandbox are left out. */
export const WORKER_FENCE_CARRIED_USER_KEYS: readonly string[] = ['env', 'model', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];

export function carriedUserSettings(configDir: string, fenceEnv: Readonly<Record<string, string>>): Record<string, unknown> {
  const user = readJsonObject(path.join(configDir, 'settings.json'));
  if (!user) return {};
  const out: Record<string, unknown> = {};
  for (const k of WORKER_FENCE_CARRIED_USER_KEYS) {
    const v = user[k];
    if (v === undefined) continue;
    if (k === 'env') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
        if (typeof value !== 'string' || name in fenceEnv || /SANDBOX|TMPDIR/i.test(name)) continue;
        env[name] = value;
      }
      if (Object.keys(env).length > 0) out.env = env;
    } else if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

/** Every account's Claude config folder (accountStore), [] when unknown. */
function accountConfigDirsDefault(): string[] {
  try {
    return getAccountStore().listAccounts().map((a) => a.configDir).filter((d): d is string => typeof d === 'string' && path.isAbsolute(d));
  } catch {
    return [];
  }
}

// ── Platform support and the self-test ──────────────────────────────────────

/** `transient`: the self-test did not finish (it timed out or could not
 *  start), which says nothing about the sandbox: the launch is refused, not
 *  started without tools. */
export type WorkerFenceSelfTest =
  /** `worktreePatterns`: the fence also held with the worktree patterns
   *  (macOS), so a launch may add them. `patternsRetry`: their run did not
   *  finish, so it is tried again after WORKER_FENCE_SELF_TEST_RETRY_MS. */
  | { ok: true; worktreePatterns?: true; patternsRetry?: true }
  | { ok: false; reason: string; transient?: true };

export type WorkerFenceSupport =
  /** `transient`: the platform has the sandbox, but this launch cannot use
   *  it now (no claude found, or it did not answer `--version`): no launch,
   *  not a weaker one, and the next launch checks again. */
  | { capable: false; reason: string; transient?: true }
  | { capable: true; exe: string; version: string; selfTest: WorkerFenceSelfTest };

export interface WorkerFenceSupportDeps {
  /** The claude binary workers run (default: resolveClaudeExecutable). */
  exe?: () => string | null;
  probe?: typeof probeBotExecSupport;
  platformRefusal?: typeof botExecPlatformRefusal;
  selfTest?: (exe: string, opts?: { patternsOnly?: boolean }) => Promise<WorkerFenceSelfTest>;
  platform?: NodeJS.Platform;
}

let lastSupport: WorkerFenceSupport | null = null;
/** Self-test answers by platform, binary and version: a pass for the app
 *  session, a failure for WORKER_FENCE_SELF_TEST_RETRY_MS (each fenced
 *  launch would otherwise wait for another run). */
const answers = new Map<string, { result: WorkerFenceSelfTest; at: number }>();
const running = new Map<string, Promise<WorkerFenceSelfTest>>();

/** How long a failed self-test stands before a launch runs it again. */
export const WORKER_FENCE_SELF_TEST_RETRY_MS = 5 * 60_000;

/**
 * Whether this computer runs the full fence, and with which claude: the
 * platform and version check bots' commands use, then the self-test (a pass
 * is kept for the app session, per platform, binary and version; a failure
 * for a few minutes). Never throws.
 */
export async function workerFenceSupport(deps: WorkerFenceSupportDeps = {}): Promise<WorkerFenceSupport> {
  const platform = deps.platform ?? process.platform;
  let exe: string | null = null;
  try {
    exe = (deps.exe ?? resolveClaudeExecutable)();
  } catch {
    exe = null;
  }
  const support = await (deps.probe ?? probeBotExecSupport)(exe, { platform });
  if (!support.ok || !exe) {
    const reason = support.ok ? 'no claude executable' : support.reason;
    // Not capable: the platform has no sandbox, or claude is too old for it.
    // Anything else on a platform that has one (no claude found, claude did
    // not answer) is not a reason to weaken: the launch is refused, and the
    // next one checks again.
    const capableHere = (deps.platformRefusal ?? botExecPlatformRefusal)({ platform }) === null;
    // botExecVersionRefusal's sentence for a claude below the minimum.
    const tooOld = !support.ok && /^Claude Code \S+ is older than /.test(support.reason);
    lastSupport = capableHere && !tooOld ? { capable: false, reason, transient: true } : { capable: false, reason };
    return lastSupport;
  }
  const key = `${platform}\0${exe}\0${support.version}`;
  const known = answers.get(key);
  let selfTest: WorkerFenceSelfTest;
  if (known && ((known.result.ok && !known.result.patternsRetry) || Date.now() - known.at < WORKER_FENCE_SELF_TEST_RETRY_MS)) {
    selfTest = known.result;
  } else {
    let run = running.get(key);
    if (!run) {
      // A pass whose pattern run did not finish tries that run alone: the
      // plain run passed, and a flake in it now must not refuse launches.
      const patternsOnly = known?.result.ok === true && known.result.patternsRetry === true;
      const once = (): Promise<WorkerFenceSelfTest> => (deps.selfTest ?? ((e: string, o?: { patternsOnly?: boolean }) => runWorkerFenceSelfTest(e, o)))(exe, { patternsOnly })
        .catch((err) => ({ ok: false as const, reason: `the self-test could not run: ${String(err)}`, transient: true as const }));
      // A run that did not finish is tried once more right away; a second
      // one is not kept (the next launch tries again).
      run = once()
        .then((first) => (!first.ok && first.transient ? once() : first))
        .then((result) => {
          if (result.ok || !result.transient) answers.set(key, { result, at: Date.now() });
          running.delete(key);
          return result;
        });
      running.set(key, run);
    }
    selfTest = await run;
  }
  lastSupport = { capable: true, exe, version: support.version, selfTest };
  return lastSupport;
}

/** The fence support a launch of `line` in a bot's worker pane needs: a
 *  claude line that runs unattended (its flags, else its settings in `cwd`
 *  and the user's) asks; any other line does not. One rule for every caller
 *  of the guard, the same one attachWorkerFence applies. */
export async function workerFenceSupportFor(line: string, cwd?: string, deps: WorkerFenceSupportDeps = {}): Promise<WorkerFenceSupport | undefined> {
  if (!namesClaude(line)) return undefined;
  const home = os.homedir();
  const mode = linePermissionMode(line) ?? settingsDefaultMode(cwd, userConfigDirs(home, process.env, accountConfigDirsDefault()));
  return isFencedMode(mode) ? workerFenceSupport(deps) : undefined;
}

/** Every user settings folder a pane may run claude with. */
function userConfigDirs(home: string, env: Readonly<Record<string, string | undefined>>, accountDirs: readonly string[]): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
  return [...new Set([configDir, path.join(home, '.claude'), ...accountDirs])];
}

/** The last answer of workerFenceSupport (null before the first). */
export function lastWorkerFenceSupport(): WorkerFenceSupport | null {
  return lastSupport;
}

/** Test-only. */
export function __resetWorkerFenceSupportForTesting(): void {
  lastSupport = null;
  answers.clear();
  running.clear();
}

/** How long the self-test's claude may take, start to end. */
export const WORKER_FENCE_SELF_TEST_TIMEOUT_MS = 45_000;

/** The self-test's stand-in for the Messages API, for a live test that drives claude the same way. */
export const __startScriptedApiForTesting = (command: string): Promise<{ url: string; close: () => void }> => startScriptedApi(command);

/** A local stand-in for the Messages API: the first request that offers the
 *  Bash tool gets one Bash call running `command`; every other request gets
 *  a short text answer that ends the turn. */
function startScriptedApi(command: string): Promise<{ url: string; close: () => void }> {
  const event = (res: http.ServerResponse, type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let called = false;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      if (body.length < 8 * 1024 * 1024) body += d;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method !== 'POST' || !url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      let tools: Array<{ name?: unknown }> = [];
      try {
        const parsed = JSON.parse(body) as { tools?: unknown };
        if (Array.isArray(parsed.tools)) tools = parsed.tools as Array<{ name?: unknown }>;
      } catch {
        /* a text answer */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      n += 1;
      event(res, 'message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'wmux-fence-self-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      const callBash = !called && tools.some((t) => t.name === 'Bash');
      if (callBash) {
        called = true;
        event(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_wmux_fence', name: 'Bash', input: {} } });
        event(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'wmux fence self-test' }) } });
      } else {
        event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } });
      }
      event(res, 'content_block_stop', { index: 0 });
      event(res, 'message_delta', { delta: { stop_reason: callBash ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event(res, 'message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('the stand-in API did not get a port'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

export interface WorkerFenceSelfTestOptions {
  /** The pane's environment as main knows it (default: the login shell's
   *  PATH, agentExecEnv). */
  paneEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** The data folder the test's files go under (default: getWmuxDir()). */
  dir?: string;
  /** The hook's runtime (default: this process's). */
  runtime?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  /** Only the macOS pattern run: the plain run already passed. */
  patternsOnly?: boolean;
}

/** The self-test's own worktree on macOS: as long as a name the patterns
 *  take (WORKER_FENCE_COMPLEMENT_MAX of them), so a launch never adds more
 *  patterns than the self-test applied. */
export const WORKER_FENCE_SELF_TEST_WORKTREE = 'wmux-fence.self_test-0123456789abcdefghi';

/** The other worktrees the macOS run writes into, one per kind of pattern:
 *  names that differ at the first character and further in (by a letter, a
 *  digit, `.`, `_` or `-`), shorter ones ending in a letter, `-`, `.` or `_`
 *  (one in another case), and a longer one. */
function selfTestSiblings(own: string): string[] {
  return [
    'sibling', '.x', `${own.slice(0, 7)}Q`, `${own.slice(0, 22)}7`, `${own.slice(0, 4)}.x`, `${own.slice(0, 4)}_x`, `${own.slice(0, 10)}-x`,
    own.slice(0, 3), own.slice(0, 4).toUpperCase(), own.slice(0, 5), own.slice(0, 11), own.slice(0, 16), `${own}2`,
  ];
}

/**
 * The self-test (see the file header). Resolves with why it failed, never
 * rejects. On macOS a second run tries the worktree patterns; one that does
 * not hold only leaves them out (`worktreePatterns` unset, logged), so the
 * snapshot denies stand alone. Its files go under
 * `<dir>/factory/fence-self-test/` and are removed once it ends.
 */
export async function runWorkerFenceSelfTest(exe: string, opts: WorkerFenceSelfTestOptions = {}): Promise<WorkerFenceSelfTest> {
  // Side by side: each run has a folder of its own.
  const [plain, withPatterns] = await Promise.all([
    opts.patternsOnly ? { ok: true as const } : runFenceProbe(exe, opts, false),
    (opts.platform ?? process.platform) === 'darwin' ? runFenceProbe(exe, opts, true) : null,
  ]);
  if (!plain.ok || !withPatterns) return plain;
  if (withPatterns.ok) return { ok: true, worktreePatterns: true };
  (opts.log ?? ((l: string) => console.warn(l)))(`[worker fence] other worktrees are closed as of launch only: ${withPatterns.reason}`);
  return withPatterns.transient ? { ok: true, patternsRetry: true } : { ok: true };
}

async function runFenceProbe(exe: string, opts: WorkerFenceSelfTestOptions, linked: boolean): Promise<WorkerFenceSelfTest> {
  const dir = opts.dir ?? getWmuxDir();
  const base = path.join(dir, 'factory', 'fence-self-test');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'run-')));
  const sub = (name: string) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { mode: 0o700 });
    return p;
  };
  const wt = sub('wt');
  const tmp = sub('tmp');
  const home = sub('home');
  const config = sub('config');
  const ran = path.join(wt, 'ran');
  const canary = path.join(root, 'canary');
  // The macOS run: a linked worktree's files (claude then opens the whole
  // common dir to commands, which `control` shows), the patterns, and a
  // write into each other worktree and a new one, none of which may land.
  const git = linked ? path.join(root, 'repo', '.git') : sub('git');
  const own = WORKER_FENCE_SELF_TEST_WORKTREE;
  const worktrees = path.join(git, 'worktrees');
  const control = path.join(wt, 'control');
  const ownWrote = path.join(wt, 'own');
  const others = selfTestSiblings(own).map((n) => path.join(worktrees, n, 'probe'));
  const added = path.join(worktrees, 'added');
  let api: { url: string; close: () => void } | null = null;
  try {
    const script = writeWorkerFenceHookScript(dir);
    const hookCommand = workerFenceHookCommand(opts.runtime ?? process.execPath, script, [wt, tmp]);
    if (!hookCommand) return { ok: false, reason: 'the fence hook\'s command cannot be written for this runtime' };
    let patterns: string[] | null = null;
    if (linked) {
      patterns = workerFenceWorktreeComplement(git, own);
      if (!patterns) return { ok: false, reason: 'the self-test\'s folder cannot be named in a pattern' };
      const ownGit = path.join(worktrees, own);
      for (const d of [path.join(git, 'objects'), path.join(git, 'refs', 'heads'), ownGit, ...others.map((p) => path.dirname(p))]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(ownGit, 'HEAD'), `${'0'.repeat(40)}\n`);
      fs.writeFileSync(path.join(ownGit, 'commondir'), '../..\n');
      fs.writeFileSync(path.join(ownGit, 'gitdir'), `${path.join(wt, '.git')}\n`);
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${ownGit}\n`);
    }
    const build = (extra: readonly string[]) => buildWorkerFence({
      worktree: wt, workerTempDir: tmp, gitCommonDir: git, isLinkedWorktree: linked, ownWorktreeName: linked ? own : null, ownBranch: null,
      otherBranches: [], otherWorktrees: [], platformCapable: true, repoTestWritePaths: [], permissionMode: 'bypassPermissions',
      hookCommand, credentialPaths: [], home, extraDenyWrite: extra,
    });
    let fence = build(patterns ?? []);
    if (patterns) {
      // As many denied paths as a launch may carry with the patterns, so a
      // launch's profile is never larger than one that applied here.
      const pad: string[] = [];
      const one = (i: number) => path.join(root, 'pad', `${i}-${'x'.repeat(96)}`);
      for (let bytes = denyWriteBytes(fence.settings); bytes + Buffer.byteLength(JSON.stringify(one(pad.length))) + 1 <= WORKER_FENCE_DENY_WRITE_MAX_BYTES;) {
        bytes += Buffer.byteLength(JSON.stringify(one(pad.length))) + 1;
        pad.push(one(pad.length));
      }
      fence = build([...patterns, ...pad]);
    }
    const settingsFile = path.join(root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(fence.settings), { mode: 0o600 });
    const tries = linked
      ? [
        `touch ${shellQuote(path.join(git, 'control'))} && touch ${shellQuote(control)}`,
        `touch ${shellQuote(path.join(worktrees, own, 'probe'))} && touch ${shellQuote(ownWrote)}`,
        ...others.map((p) => `touch ${shellQuote(p)}`),
        `mkdir ${shellQuote(added)}`,
      ].map((c) => `; ${c}`).join('')
      : '';
    api = await startScriptedApi(`touch ${shellQuote(ran)}; touch ${shellQuote(canary)}${tries}`);
    // The login shell's PATH, as a pane has: a claude installed by npm needs
    // its node.
    const loginEnv = await (opts.paneEnv ?? (() => agentExecEnv(process.env)))();
    const env: Record<string, string> = {
      PATH: loginEnv.PATH ?? process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_TMPDIR: tmp,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'wmux-fence-self-test',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    const args = ['-p', 'wmux fence self-test', '--dangerously-skip-permissions', '--setting-sources', 'project', '--settings', settingsFile,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '2', '--output-format', 'json'];
    const exit = await new Promise<{ code: number | null; stderr: string; timedOut?: boolean }>((resolve) => {
      let stderr = '';
      let settled = false;
      let exitCode: number | null = null;
      const done = (code: number | null, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(drain);
        child.stderr?.destroy();
        resolve({ code, stderr: stderr + extra, timedOut: extra === 'timed out' });
      };
      let drain: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(exe, args, { cwd: wt, env, stdio: ['ignore', 'ignore', 'pipe'] });
      // Ends at its exit, or at the deadline whatever still holds its pipes.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null, 'timed out');
      }, opts.timeoutMs ?? WORKER_FENCE_SELF_TEST_TIMEOUT_MS);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        if (stderr.length < 4096) stderr += d;
      });
      child.on('error', (err) => done(null, String(err)));
      // Its last words are read to the end ('close'); a pipe something else
      // still holds ends the wait shortly after the exit.
      child.on('exit', (code) => {
        exitCode = code;
        drain = setTimeout(() => done(exitCode), 2_000);
      });
      child.on('close', () => done(exitCode));
    });
    if (fs.existsSync(canary)) return { ok: false, reason: 'a command wrote outside the fence\'s folders, so the OS sandbox is not holding' };
    if (!fs.existsSync(ran)) {
      const why = exit.stderr.trim().split('\n').pop()?.slice(0, 200) || `exit ${exit.code}`;
      return { ok: false, reason: `claude did not run a command inside the fence (${why})`, ...(exit.timedOut ? { transient: true as const } : {}) };
    }
    if (!linked) return { ok: true };
    if (exit.timedOut) return { ok: false, reason: 'the run with the patterns did not finish', transient: true };
    // Without it, the denies below would hold with no pattern at all.
    if (!fs.existsSync(control)) return { ok: false, reason: 'claude did not open the linked worktree\'s git folder, so the patterns were not tried' };
    if (others.some((p) => fs.existsSync(p)) || fs.existsSync(added)) return { ok: false, reason: 'a command wrote another worktree\'s git folder, so the patterns are not holding' };
    if (!fs.existsSync(ownWrote)) return { ok: false, reason: 'a command could not write its own worktree\'s git folder under the patterns' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `the self-test could not run: ${String(err)}`, transient: true };
  } finally {
    api?.close();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── Files main writes ────────────────────────────────────────────────────────

/** `content` under `folder` by its name (botWorkerMcp contentFileName,
 *  with `ext`), 0600 in a 0700 folder, written whole through a rename; an
 *  unchanged file is touched (in use again: the startup prune keeps it). */
export function writeContentFile(folder: string, content: string, ext = '.json'): string {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, contentFileName(content).replace(/\.json$/, ext));
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      try { fs.utimesSync(file, new Date(), new Date()); } catch { /* best effort */ }
      return file;
    }
  } catch {
    /* missing: write it */
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}

/** The hook script, content-named under `<dir>/factory/worker-hooks/`. */
export function writeWorkerFenceHookScript(dir: string): string {
  return writeContentFile(path.join(dir, 'factory', 'worker-hooks'), workerFenceHookScript(), '.cjs');
}

/**
 * The claude launcher the full fence's line names: `exe` itself when a
 * shell reads its path as one plain word, else a link to it named by its
 * path under `<dir>/factory/claude-bin/` (a path with a space, say). Null
 * when neither can be named plainly.
 */
export function fenceLauncher(dir: string, exe: string): string | null {
  const plain = (p: string) => /^\/[A-Za-z0-9._/-]+$/.test(p) && isClaudeLauncher(p);
  if (plain(exe)) return exe;
  const link = path.join(dir, 'factory', 'claude-bin', contentFileName(exe).replace(/\.json$/, ''), 'claude');
  if (!plain(link)) return null;
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  try {
    if (fs.readlinkSync(link) === exe) return link;
  } catch {
    /* missing: made below */
  }
  const tmp = `${link}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.symlinkSync(exe, tmp);
  fs.renameSync(tmp, link);
  return link;
}

/** The worker's own temp folder: the recorded one when it is still main's
 *  (a folder, not a link, directly under workerTempRoot), else a new one.
 *  `path` is what the session record keeps, `real` what the fence names. */
export function workerTempDir(dir: string, recorded?: string): { path: string; real: string } {
  const root = workerTempRoot(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (recorded && path.dirname(recorded) === root && WORKER_TEMP_NAME.test(path.basename(recorded))) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(recorded);
    } catch {
      fs.mkdirSync(recorded, { mode: 0o700 });
    }
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw fenceError('the worker\'s temp folder is not a folder of its own');
    return { path: recorded, real: fs.realpathSync(recorded) };
  }
  const made = path.join(root, crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(made, { mode: 0o700 });
  return { path: made, real: fs.realpathSync(made) };
}

// ── The worktree's git layout ────────────────────────────────────────────────

export interface WorktreeGitFacts {
  gitCommonDir: string;
  isLinkedWorktree: boolean;
  ownWorktreeName: string | null;
  ownBranch: string | null;
  otherBranches: string[];
  otherWorktrees: string[];
}

function fenceError(why: string): Error {
  return new Error(`worker fence: ${why}`);
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Every branch under `refs/heads` (loose files and packed-refs). */
function listBranches(common: string): string[] {
  const out = new Set<string>();
  const walk = (folder: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(folder, e.name), name);
      else if (e.isFile() && !e.name.endsWith('.lock')) out.add(name);
    }
  };
  walk(path.join(common, 'refs', 'heads'), '');
  for (const line of (readText(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const m = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * The worktree's git layout, from its files: its `.git` (a linked worktree's
 * pointer file or the main checkout's folder), the common dir, its branch,
 * every other branch and linked worktree. `expected`: the task ledger's
 * record of the common dir and the worktree's git dir, which must match. A
 * folder that is not a git worktree gets a common dir inside it that does
 * not exist (nothing to deny). Throws on a layout the fence cannot name.
 */
export function readWorktreeGitFacts(worktree: string, expected: { gitCommonDir?: string; gitWorktreeDir?: string } = {}): WorktreeGitFacts {
  const wt = fs.realpathSync(worktree);
  const dotGit = path.join(wt, '.git');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    if (expected.gitCommonDir) throw fenceError('the worktree has no .git, although its task was started in a repository');
    return { gitCommonDir: dotGit, isLinkedWorktree: false, ownWorktreeName: null, ownBranch: null, otherBranches: [], otherWorktrees: [] };
  }
  let gitDir: string;
  if (st.isDirectory()) {
    gitDir = fs.realpathSync(dotGit);
  } else if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
    if (!m) throw fenceError('the worktree\'s .git file does not name its git folder');
    gitDir = fs.realpathSync(path.resolve(wt, m[1]));
  } else {
    throw fenceError('the worktree\'s .git is neither a file nor a folder');
  }
  const commondir = readText(path.join(gitDir, 'commondir'));
  const common = commondir ? fs.realpathSync(path.resolve(gitDir, commondir.trim())) : gitDir;
  const same = (a: string, b: string) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };
  if (expected.gitCommonDir && !same(expected.gitCommonDir, common)) throw fenceError('the worktree\'s repository is not the one its task was started in');
  if (expected.gitWorktreeDir && !same(expected.gitWorktreeDir, gitDir)) throw fenceError('the worktree\'s git folder is not the one its task was started with');
  if (fs.existsSync(path.join(common, 'reftable'))) throw fenceError('the repository keeps its branches in a reftable, which the fence cannot close branch by branch');
  const linked = gitDir !== common;
  if (linked && path.dirname(gitDir) !== path.join(common, 'worktrees')) throw fenceError('the worktree\'s git folder is not under its repository\'s worktrees folder');
  const head = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readText(path.join(gitDir, 'HEAD')) ?? '');
  let worktrees: string[] = [];
  try {
    worktrees = fs.readdirSync(path.join(common, 'worktrees'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    worktrees = [];
  }
  return {
    gitCommonDir: common,
    isLinkedWorktree: linked,
    ownWorktreeName: linked ? path.basename(gitDir) : null,
    ownBranch: head ? head[1] : null,
    otherBranches: listBranches(common),
    otherWorktrees: worktrees,
  };
}

/**
 * Linux: each other branch in the ref folder the fence opens to the worker
 * (its branch's folder; all of `refs/heads` for the main checkout) that is
 * kept only in packed-refs gets a loose ref file of the same value, so the
 * sandbox has a file to keep its deny on (bubblewrap binds only paths that
 * exist). Written as git writes a ref: `<ref>.lock` made exclusively, the
 * value, then renamed over the ref. `git update-ref` and `git branch -f` skip
 * a write that changes nothing (measured, git 2.50), and a write that moves
 * the ref and back would leave two reflog entries. Throws when one cannot be
 * written, or git holds its lock. Returns the branches written.
 */
export function loosenPackedBranches(facts: Pick<WorktreeGitFacts, 'gitCommonDir' | 'isLinkedWorktree' | 'ownWorktreeName' | 'ownBranch'>): string[] {
  const heads = path.join(facts.gitCommonDir, 'refs', 'heads');
  let open: string;
  if (!facts.isLinkedWorktree) open = heads;
  else if (facts.ownBranch === null) return [];
  else open = workerFenceGitWrites(facts)[2];
  const written: string[] = [];
  for (const line of (readText(path.join(facts.gitCommonDir, 'packed-refs')) ?? '').split('\n')) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) refs\/heads\/(.+)$/.exec(line.trim());
    if (!m || m[2] === facts.ownBranch) continue;
    const [, oid, branch] = m;
    const parts = branch.split('/');
    if (parts.some((x) => x === '' || x === '.' || x === '..')) continue;
    const ref = path.join(heads, ...parts);
    if (!isWithin(ref, open) || ref === open || fs.existsSync(ref)) continue;
    const lock = `${ref}.lock`;
    try {
      fs.mkdirSync(path.dirname(ref), { recursive: true });
      const fd = fs.openSync(lock, 'wx', 0o644);
      try {
        fs.writeSync(fd, `${oid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(lock, ref);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        try { fs.unlinkSync(lock); } catch { /* not made */ }
      }
      throw fenceError(`branch ${branch}, kept only in packed-refs, could not be written as its own ref file before launch (${(err as Error).message})`);
    }
    written.push(branch);
  }
  return written;
}

// ── What else the fence closes ───────────────────────────────────────────────

/** Claude's own temp folder for this user (`/tmp/claude-<uid>`, with macOS's
 *  `/private` spelling): its sandbox lets every command write there whatever
 *  the settings say (measured on claude 2.1.311, CLAUDE_CODE_TMPDIR or not),
 *  and every claude session of the user keeps its project folder there. */
export function claudeTempRoots(platform: NodeJS.Platform = process.platform): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null || platform === 'win32') return [];
  const root = `/tmp/claude-${uid}`;
  return platform === 'darwin' ? [root, `/private${root}`] : [root];
}

/**
 * The other sessions' project folders in claude's temp folder, closed to the
 * worker's commands: on macOS every `-*` folder by one pattern (the
 * sandbox takes it; the worker's own session keeps its task output under
 * CLAUDE_CODE_TMPDIR, so its background commands still run, measured on
 * claude 2.1.311); elsewhere each such folder there at launch but the
 * worker's own (bubblewrap takes no pattern).
 */
export function claudeTempDenies(worktree: string, platform: NodeJS.Platform, roots: readonly string[] = claudeTempRoots(platform), listDir: (dir: string) => string[] = listDirSafe): string[] {
  if (platform === 'darwin') return roots.map((r) => path.join(r, '-*'));
  // Named as Claude names it: a long path is cut and given a hash (claudeProjectFolder).
  const own = claudeProjectFolder(worktree);
  return roots.flatMap((r) => listDir(r).filter((n) => n.startsWith('-') && n !== own).map((n) => path.join(r, n)));
}

const complementFallbacks = new Set<string>();

/**
 * macOS, a linked worktree: every other folder under the common dir's
 * `worktrees/` closed by pattern (workerFenceWorktreeComplement), one made
 * after launch included. Where it gives none, the snapshot denies stand
 * alone, and that is logged once per name.
 */
export function worktreeComplementDenies(git: Pick<WorktreeGitFacts, 'gitCommonDir' | 'isLinkedWorktree' | 'ownWorktreeName'>, platform: NodeJS.Platform, log: (line: string) => void = (l) => console.warn(l)): string[] {
  if (platform !== 'darwin' || !git.isLinkedWorktree || git.ownWorktreeName === null) return [];
  const denies = workerFenceWorktreeComplement(git.gitCommonDir, git.ownWorktreeName);
  if (denies) return denies;
  logComplementFallbackOnce(git, 'its name or the repository path cannot be a pattern', log);
  return [];
}

function logComplementFallbackOnce(git: Pick<WorktreeGitFacts, 'gitCommonDir' | 'ownWorktreeName'>, why: string, log: (line: string) => void = (l) => console.warn(l)): void {
  const key = `${git.gitCommonDir}\0${git.ownWorktreeName}\0${why}`;
  if (complementFallbacks.has(key)) return;
  // Once per name and reason, in a set that never grows past a few hundred.
  if (complementFallbacks.size >= 256) complementFallbacks.clear();
  complementFallbacks.add(key);
  log(`[worker fence] worktree ${JSON.stringify(git.ownWorktreeName)}: other worktrees are closed as of launch only (${why})`);
}

/** A settings document's denied write paths, as JSON, in bytes. */
function denyWriteBytes(settings: Record<string, unknown>): number {
  const sandbox = settings.sandbox as { filesystem?: { denyWrite?: string[] } } | undefined;
  return Buffer.byteLength(JSON.stringify(sandbox?.filesystem?.denyWrite ?? []), 'utf8');
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** What in wmux's data folder holds a secret, relative to it: the daemon's
 *  and the relay's tokens, the track-record signing key, the paired phones,
 *  the principals, the secret hook, the account folders, the cross-PC (A2A)
 *  keys and peers, the LAN link keys, the remote hosts, the bots' secret
 *  store, Claude API key and fan-out keys, the task push relay, and every
 *  worker's launch settings (they carry the owner's user env). */
export const WORKER_FENCE_DATA_DIR_SECRETS: readonly string[] = [
  'daemon-auth-token', 'relay-shared-secret.txt', 'track-record.key', 'devices.json', 'principals.json', 'secret-hook.json',
  'accounts', 'a2a', 'lanlink', 'remote-hosts.json',
  'factory/secrets.json', 'factory/claude-api-key.json', 'factory/bot-fanout-keys.json', 'factory/git-relay', 'factory/worker-settings',
];

/** The data folder's secret paths (WORKER_FENCE_DATA_DIR_SECRETS), each
 *  with the backups beside it (`<name>.bak`, `<name>.bak.<n>`). Absolute. */
export function workerFenceDataDirSecrets(dir: string, listDir: (dir: string) => string[] = listDirSafe): string[] {
  const out: string[] = [];
  for (const rel of WORKER_FENCE_DATA_DIR_SECRETS) {
    const p = path.join(dir, ...rel.split('/'));
    out.push(p);
    const base = path.basename(p);
    for (const n of listDir(path.dirname(p))) if (n.startsWith(`${base}.bak`)) out.push(path.join(path.dirname(p), n));
  }
  return out;
}

// ── The fence for one launch ─────────────────────────────────────────────────

/** How a launch is fenced, recorded with its session (a later launch of it
 *  never runs weaker than its first, botWorkerMergeGuard.ts). */
export type WorkerFenceStrength = 'full' | 'weaker' | 'off';

/** The status line a fenced worker's pane shows, or none. */
function statusLine(text: string): Record<string, unknown> {
  return { statusLine: { type: 'command', command: `echo ${shellQuote(`wmux: ${text}`)}`, padding: 0 } };
}

/** A hook that refuses every call, with `reason`. */
function refuseAllHook(reason: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `echo ${shellQuote(`wmux fence: ${reason}`)} >&2; exit 2` }] }] } };
}

export type WorkerFenceAttach =
  /** Not fenced: the launch is as before. */
  | { kind: 'none' }
  /** Fenced: merge `settings` into the worker's settings file. */
  | { kind: 'fence'; strength: WorkerFenceStrength; settings: Record<string, unknown>; tempDir?: string; launcher?: string; branch?: string | null };

/** The full fence's launcher (fenceLauncher), or the refusal. */
function fullLauncher(dir: string, exe: string): string {
  const launcher = fenceLauncher(dir, exe);
  if (!launcher) throw fenceError('the claude the fence was checked on cannot be named on the launch line');
  return launcher;
}

export interface WorkerFenceAttachInput {
  line: string;
  /** The worker's folder (absolute); none for a WSL pane. */
  cwd?: string;
  wsl: boolean;
  /** The data folder. */
  dir: string;
  /** The owner turned the fence off for the bot's workspace. */
  switchedOff: boolean;
  /** What the session's first launch recorded (a resume, a re-fire). */
  recorded?: { strength: WorkerFenceStrength; tempDir?: string; branch?: string | null };
  support: WorkerFenceSupport | null;
  /** The task ledger's git dirs for the worktree. */
  expectedGit?: { gitCommonDir?: string; gitWorktreeDir?: string };
  /** The hook's runtime (default: this process's). */
  runtime?: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  accountConfigDirs?: readonly string[];
  platform?: NodeJS.Platform;
  /** Claude's own temp folders (default: claudeTempRoots()). */
  claudeTempRoots?: readonly string[];
}

/**
 * The fence for one claude launch of a bot's worker. `none` for a line that
 * does not run unattended (manual, acceptEdits, plan, default). Throws (the
 * launch is refused) when the fence should be on but cannot be built: the
 * worktree's files or git layout refuse it, or the platform ran the full
 * fence for this session before and cannot now.
 */
export function attachWorkerFence(input: WorkerFenceAttachInput): WorkerFenceAttach {
  const home = input.home ?? os.homedir();
  const env = input.env ?? process.env;
  const accountDirs = input.accountConfigDirs ?? accountConfigDirsDefault();
  const userConfigDir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
  // A line with no mode flag starts in the mode its settings name.
  const mode = linePermissionMode(input.line) ?? settingsDefaultMode(input.cwd, userConfigDirs(home, env, accountDirs));
  if (!isFencedMode(mode)) return { kind: 'none' };
  const wanted = !input.switchedOff || (input.recorded !== undefined && input.recorded.strength !== 'off');
  if (!wanted) return { kind: 'fence', strength: 'off', settings: statusLine('the worker fence is off for this workspace') };
  const credentials = [
    ...workerFenceCredentialPaths({ botDir: input.cwd ?? input.dir, wmuxDir: input.dir, env, home, accountConfigDirs: accountDirs, ...(input.platform ? { platform: input.platform } : {}) }),
    ...workerFenceDataDirSecrets(input.dir),
  ];
  if (input.wsl) {
    // The distro's claude: the permission denies (rules by `~/`, its own
    // home) and the marker. The hook's runtime does not run there.
    if (input.recorded?.strength === 'full') throw fenceError('this worker started inside the full fence, which a WSL pane cannot run');
    const deny = [...workerFencePermissionDenies(credentials, [], home), ...WORKER_FENCE_REFUSED_WMUX_TOOLS];
    return { kind: 'fence', strength: 'weaker', settings: { permissions: { deny }, ...statusLine('weaker worker fence: a WSL pane has no file hook and no OS sandbox') } };
  }
  if (!input.cwd) throw fenceError('the worker has no folder to fence');
  const support = input.support;
  if (!support) throw fenceError('this computer\'s fence support was not checked yet; try again');
  if (!support.capable && support.transient) throw fenceError(`this computer has the OS sandbox, but the fence cannot start now (${support.reason}); try again`);
  if (!support.capable && input.recorded?.strength === 'full') throw fenceError(`this worker started inside the full fence, which cannot run now (${support.reason})`);
  const refusal = workerFenceFolderRefusal(input.cwd);
  if (refusal) throw fenceError(refusal);
  const worktree = fs.realpathSync(input.cwd);
  const temp = workerTempDir(input.dir, input.recorded?.tempDir);
  const tempDir = temp.path;
  const git = readWorktreeGitFacts(worktree, input.expectedGit);
  // The worker's branch is the one its first fenced launch ran on, never
  // what HEAD names at a later one.
  const recorded = input.recorded && input.recorded.strength !== 'off' ? input.recorded : null;
  if (recorded && recorded.branch === undefined) throw fenceError('the worker\'s branch was not recorded at its first launch; start the task again');
  if (recorded && recorded.branch !== git.ownBranch) {
    const was = recorded.branch === null ? 'a detached HEAD' : `branch ${recorded.branch}`;
    const now = git.ownBranch === null ? 'a detached HEAD' : `branch ${git.ownBranch}`;
    throw fenceError(`the worktree is on ${now}, not on ${was} it started on`);
  }
  const platform = input.platform ?? process.platform;
  if (git.isLinkedWorktree && git.ownBranch !== null) {
    // The folders the fence opens for the branch's ref and reflog, made
    // here: a branch kept only in packed-refs has neither yet, and the
    // worker's commands cannot make them.
    for (const p of workerFenceGitWrites(git).slice(2)) fs.mkdirSync(p, { recursive: true });
  }
  // Before the denies are listed: on Linux they name only files that exist.
  if (platform === 'linux' && support.capable) loosenPackedBranches(git);
  const script = writeWorkerFenceHookScript(input.dir);
  const hookCommand = workerFenceHookCommand(input.runtime ?? process.execPath, script, [worktree, temp.real], input.platform);
  if (!hookCommand) throw fenceError('the fence hook\'s command cannot be written for these paths');
  const build = (patterns: readonly string[]) => buildWorkerFence({
    worktree, workerTempDir: temp.real, ...git, platformCapable: support.capable, repoTestWritePaths: [],
    permissionMode: mode ?? 'bypassPermissions', hookCommand, credentialPaths: credentials, home,
    extraDenyWrite: [...claudeTempDenies(worktree, platform, input.claudeTempRoots), ...patterns],
    ...(platform === 'linux' ? { keepGitDeny: (p: string) => fs.existsSync(p) } : {}),
  });
  // The worktree patterns only where the self-test applied them, and only
  // while the denies stay as small as the profile the self-test applied.
  const patterns = support.capable && support.selfTest.ok && support.selfTest.worktreePatterns ? worktreeComplementDenies(git, platform) : [];
  const fence = build(patterns);
  if (patterns.length > 0 && denyWriteBytes(fence.settings) > WORKER_FENCE_DENY_WRITE_MAX_BYTES) {
    const filesystem = (fence.settings.sandbox as { filesystem: { denyWrite: string[] } }).filesystem;
    const drop = new Set(patterns);
    filesystem.denyWrite = filesystem.denyWrite.filter((p) => !drop.has(p));
    logComplementFallbackOnce(git, 'the denies would make the profile too large');
  }
  // How the worker reaches its model, from the owner's user settings it
  // no longer loads; the fence's own values win.
  const carried = carriedUserSettings(userConfigDir, fence.settings.env as Record<string, string>);
  fence.settings = { ...carried, ...fence.settings, env: { ...(carried.env as Record<string, string> | undefined), ...(fence.settings.env as Record<string, string>) } };
  if (!support.capable) {
    return { kind: 'fence', strength: 'weaker', tempDir, branch: git.ownBranch, settings: { ...fence.settings, ...statusLine(`weaker worker fence: no OS sandbox here (${support.reason})`) } };
  }
  if (!support.selfTest.ok && support.selfTest.transient) throw fenceError(`the fence's self-test did not finish (${support.selfTest.reason}); try again`);
  if (!support.selfTest.ok) {
    // The sandbox did not hold in the self-test: no tool runs.
    const why = `the fence failed its self-test, so this worker has no tools (${support.selfTest.reason})`;
    const merged = { ...fence.settings, ...statusLine(why) };
    const hooks = (merged.hooks as { PreToolUse: unknown[] }).PreToolUse;
    (merged.hooks as { PreToolUse: unknown[] }).PreToolUse = [...(refuseAllHook(why).hooks as { PreToolUse: unknown[] }).PreToolUse, ...hooks];
    return { kind: 'fence', strength: 'full', tempDir, branch: git.ownBranch, settings: merged, launcher: fullLauncher(input.dir, support.exe) };
  }
  return { kind: 'fence', strength: 'full', tempDir, branch: git.ownBranch, settings: fence.settings, launcher: fullLauncher(input.dir, support.exe) };
}

/** Startup: remove worker temp folders no session record names and that
 *  were not touched for a day. Best effort. */
export function pruneWorkerTempDirs(dir: string, named: ReadonlySet<string>, now: number = Date.now()): number {
  const root = workerTempRoot(dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const p = path.join(root, name);
    if (named.has(p) || !WORKER_TEMP_NAME.test(name)) continue;
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < 24 * 3600_000) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  return removed;
}
