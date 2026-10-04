/**
 * Pane identity for an MCP server spawned by a SHARED Codex app-server (#1778).
 *
 * Codex 0.157+ runs turns in one background server per account
 * (`codex app-server --managed-daemon`). Every MCP server it spawns is that
 * server's child, so the PID-map walk never reaches a pane shell, and the
 * inherited WMUX_* env belongs to whichever pane started the server — possibly
 * a closed pane, or another pane entirely. Trusting it would send A2A messages
 * under the wrong sender.
 *
 * Codex does name the conversation on every `tools/call`: `_meta.threadId`
 * (codex-rs core/src/mcp_tool_call.rs, `with_mcp_tool_call_ids_meta`). wmux
 * already records which pane owns a thread (#1523 / #1762) in
 * `$CODEX_HOME/wmux-thread-owners`, written only by the pane-side TUI relay or
 * a confirmed pane-side SessionStart. This module joins the two:
 *
 *   threadId (per call) → owner record → that pane's LIVE pid-map anchor.
 *
 * The threadId is only honoured when the MCP server's parent is positively a
 * shared Codex app-server; any other parent (a direct launch, an external MCP
 * client, a script run by Codex's shell tool) cannot claim a thread. The owner
 * record is read with the same v1 protocol as
 * integrations/codex/bin/wmux-codex-thread.mjs (readThreadOwner) and
 * src/daemon/web/codexThreadOwner.ts (writer): the thread record counts only
 * while the pane's pointer still names the same thread and nonce, so /new, a
 * different resume or a closed pane invalidates it.
 *
 * Pure helpers + small fs/process readers, no RPC — index.ts does the live
 * anchor check, so everything here is unit-testable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** `_meta.threadId` of a tools/call, from the SDK's per-request `extra`. */
export function codexThreadIdFromExtra(extra: unknown): string {
  if (!extra || typeof extra !== 'object') return '';
  const meta = (extra as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return '';
  const id = (meta as { threadId?: unknown }).threadId;
  return typeof id === 'string' && CODEX_THREAD_ID_RE.test(id) ? id : '';
}

// ── Parent classification ───────────────────────────────────────────────────

/**
 * Split a Windows CommandLine like CommandLineToArgvW. Same rules as
 * tokenizeCommandLine in integrations/codex/bin/wmux-codex-thread.mjs.
 */
export function tokenizeCommandLine(cmdline: string): string[] {
  const s = typeof cmdline === 'string' ? cmdline : '';
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      inToken = true;
    } else if (ch === '"') {
      if (quoted && s[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
      inToken = true;
    } else if ((ch === ' ' || ch === '\t') && !quoted) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

// Codex global options that take a value (mirrors CODEX_VALUE_OPTIONS in
// wmux-codex-thread.mjs).
const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
  '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);

function codexSubcommandIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return -1;
    if (CODEX_VALUE_OPTIONS.has(arg)) { i++; continue; }
    if (arg === '-i' || arg === '--image' || arg.startsWith('--image=') || /^-i./.test(arg)) return -1;
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/** A Codex app-server that serves more than its starter (isSharedServerArgv). */
export function isSharedServerArgv(argv: string[]): boolean {
  if (!Array.isArray(argv)) return false;
  if (argv.includes('--managed-daemon') && argv.includes('app-server')) return true;
  const sub = codexSubcommandIndex(argv);
  if (sub < 0 || argv[sub] !== 'app-server') return false;
  for (let i = sub + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--managed-daemon') return true;
    const listen = arg === '--listen' ? argv[i + 1] : arg.startsWith('--listen=') ? arg.slice('--listen='.length) : undefined;
    if (listen !== undefined && listen !== 'stdio://') return true;
  }
  return false;
}

const baseName = (token: string | undefined) =>
  String(token ?? '').replace(/["']/g, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
const isMcpEntry = (token: string | undefined) =>
  /(?:^|\/)(?:\.wmux\/mcp|mcp-bundle)\/(?:index|shim)\.js$/.test(String(token ?? '').replace(/["']/g, '').replace(/\\/g, '/').toLowerCase());

/**
 * A wrapper that re-runs this server's own entry and nothing else:
 * `node <entry>` or `cmd /c node <entry>`. Strict on shape, so a script that
 * merely passes the entry path as an argument (`node evil.js …/index.js`) or a
 * shell line is NOT skipped.
 */
function isOwnLauncher(argv: string[]): boolean {
  const isNode = (t: string | undefined) => /^node(?:\.exe)?$/.test(baseName(t));
  if (isNode(argv[0])) return argv.length === 2 && isMcpEntry(argv[1]);
  if (/^cmd(?:\.exe)?$/.test(baseName(argv[0])) && /^\/c$/i.test(argv[1] ?? '') && isNode(argv[2])) {
    return argv.length === 4 && isMcpEntry(argv[3]);
  }
  return false;
}

/**
 * Who spawned this MCP server, from the argv of its ancestors nearest first.
 * Wrappers that re-run this server's own entry (a `cmd /c node …index.js`, a
 * version-manager shim) are skipped; the first other ancestor decides. Only a
 * shared Codex app-server may vouch for a `_meta.threadId` — a shell, a script
 * or an unknown parent is 'other', even when one of ITS ancestors is a server.
 */
export function classifyMcpParent(chain: string[][]): 'shared-server' | 'other' {
  for (const argv of Array.isArray(chain) ? chain : []) {
    if (!Array.isArray(argv) || argv.length === 0) return 'other';
    if (isOwnLauncher(argv)) continue;
    return isSharedServerArgv(argv) ? 'shared-server' : 'other';
  }
  return 'other';
}

const MAX_PARENT_HOPS = 3;

/**
 * Command lines of `startPid` and up to two of its ancestors, nearest first
 * (classifyMcpParent decides which one counts). Never throws: a failed lookup
 * ends the chain (→ 'other').
 */
export async function readParentChain(startPid: number, timeoutMs = 5000): Promise<string[][]> {
  if (!Number.isInteger(startPid) || startPid <= 1) return [];
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    if (process.platform === 'win32') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
        `$p=${startPid};`,
        `for ($i=0; $i -lt ${MAX_PARENT_HOPS} -and $p -gt 0; $i++) {`,
        "$w=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if (-not $w) { break };",
        "$c=[string]$w.CommandLine -replace '[\\r\\n]',' '; 'L' + $c;",
        '$p=[int]$w.ParentProcessId }',
      ].join(' ');
      const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      return stdout.split(/\r?\n/).filter((l) => l.startsWith('L')).map((l) => tokenizeCommandLine(l.slice(1)));
    }
    const chain: string[][] = [];
    let pid = startPid;
    for (let hop = 0; hop < MAX_PARENT_HOPS && pid > 1; hop++) {
      const { stdout } = await run('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: timeoutMs });
      const m = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
      if (!m) break;
      const argv = m[2].split(/\s+/).filter(Boolean);
      chain.push(argv);
      pid = Number(m[1]);
    }
    return chain;
  } catch {
    return [];
  }
}

// ── Owner index (v1, shared with wmux-codex-thread.mjs) ─────────────────────

export interface CodexThreadOwner {
  ptyId: string;
  workspaceId: string;
  dataSuffix: string;
}

const OWNER_ENV_KEYS = [
  'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX',
  'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN',
] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function codexHome(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME;
  if (typeof home === 'string' && home.length > 0) return home;
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.codex');
}

/** The thread's recorded owner, or undefined when absent, torn or superseded. */
export function readCodexThreadOwner(threadId: string, home: string): CodexThreadOwner | undefined {
  if (!CODEX_THREAD_ID_RE.test(threadId)) return undefined;
  try {
    const dir = path.join(home, 'wmux-thread-owners');
    const owner = JSON.parse(fs.readFileSync(path.join(dir, `thread-${digest(threadId)}.json`), 'utf8'));
    if (owner?.version !== 1 || owner.id !== threadId || typeof owner.nonce !== 'string' || !owner.nonce
        || !owner.env || typeof owner.env.WMUX_PTY_ID !== 'string' || !owner.env.WMUX_PTY_ID
        || OWNER_ENV_KEYS.some((key) => typeof owner.env[key] !== 'string')) return undefined;
    const pointerName = `pane-${digest(JSON.stringify([owner.env.WMUX_DATA_SUFFIX || '', owner.env.WMUX_PTY_ID]))}.json`;
    const current = JSON.parse(fs.readFileSync(path.join(dir, pointerName), 'utf8'));
    if (current?.id !== threadId || current.nonce !== owner.nonce) return undefined;
    return {
      ptyId: owner.env.WMUX_PTY_ID,
      workspaceId: owner.env.WMUX_WORKSPACE_ID,
      dataSuffix: owner.env.WMUX_DATA_SUFFIX,
    };
  } catch {
    return undefined;
  }
}

export type CodexThreadResolution =
  | { status: 'hit'; wsId: string; ptyId: string }
  | { status: 'miss'; reason: string };

/**
 * Join a recorded owner with the LIVE pid-map anchors main returned. The pane
 * must still exist (a live anchor with that ptyId); its workspace is the one
 * main resolved now, never the id frozen in the record.
 */
export function matchOwnerToLiveAnchor(
  threadId: string,
  owner: CodexThreadOwner | undefined,
  entries: ReadonlyArray<{ ptyId: string; workspaceId: string }> | undefined,
  ownDataSuffix: string,
): CodexThreadResolution {
  if (!owner) {
    return { status: 'miss', reason: `no wmux pane owns Codex thread ${threadId} (start or resume it from a wmux pane)` };
  }
  if ((owner.dataSuffix || '') !== (ownDataSuffix || '')) {
    return { status: 'miss', reason: `Codex thread ${threadId} belongs to another wmux instance` };
  }
  const live = (entries ?? []).find((e) => e.ptyId === owner.ptyId && typeof e.workspaceId === 'string' && e.workspaceId);
  if (!live) {
    return { status: 'miss', reason: `the pane that owned Codex thread ${threadId} is closed` };
  }
  return { status: 'hit', wsId: live.workspaceId, ptyId: live.ptyId };
}
