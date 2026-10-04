import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyMcpParent,
  codexThreadIdFromExtra,
  isSharedServerArgv,
  matchOwnerToLiveAnchor,
  readCodexThreadOwner,
  tokenizeCommandLine,
} from '../codexThreadIdentity';

// #1778 — A2A identity for an MCP server spawned by a shared Codex app-server.

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const T1 = '019a0000-0000-7000-8000-000000000001';
const T2 = '019a0000-0000-7000-8000-000000000002';
const T3 = '019a0000-0000-7000-8000-000000000003';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-owners-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** Writes a v1 owner record exactly like recordThreadOwner (wmux-codex-thread.mjs). */
function recordOwner(id: string, ptyId: string, workspaceId: string, suffix = ''): void {
  const dir = path.join(home, 'wmux-thread-owners');
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    WMUX_PTY_ID: ptyId, WMUX_WORKSPACE_ID: workspaceId, WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
    WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
  };
  const nonce = randomUUID();
  fs.writeFileSync(path.join(dir, `thread-${digest(id)}.json`), JSON.stringify({ version: 1, id, env, nonce }));
  fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, ptyId]))}.json`), JSON.stringify({ id, nonce }));
}

const SHARED_SERVER = ['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe', 'app-server', '--listen', 'unix://', '--managed-daemon'];
const MCP_ENTRY = ['node', 'C:\\Users\\u\\.wmux\\mcp\\index.js'];

describe('codexThreadIdFromExtra', () => {
  it('reads _meta.threadId from the tools/call extra', () => {
    expect(codexThreadIdFromExtra({ _meta: { threadId: T1, sessionId: T1 } })).toBe(T1);
  });
  it('ignores absent, non-object and malformed values', () => {
    expect(codexThreadIdFromExtra(undefined)).toBe('');
    expect(codexThreadIdFromExtra({ signal: {} })).toBe('');
    expect(codexThreadIdFromExtra({ _meta: { threadId: '../../etc' } })).toBe('');
    expect(codexThreadIdFromExtra({ _meta: { threadId: 42 } })).toBe('');
  });
});

describe('classifyMcpParent — who may vouch for a threadId', () => {
  it('accepts a shared Codex app-server as the direct parent', () => {
    expect(classifyMcpParent([SHARED_SERVER])).toBe('shared-server');
  });
  it('skips this server\'s own launcher wrappers (cmd /c, shim)', () => {
    const cmdWrapper = ['cmd.exe', '/c', 'node', 'C:\\Users\\u\\.wmux\\mcp\\index.js'];
    expect(classifyMcpParent([cmdWrapper, SHARED_SERVER])).toBe('shared-server');
    expect(classifyMcpParent([['node', '/opt/wmux/mcp-bundle/shim.js'], SHARED_SERVER])).toBe('shared-server');
  });
  it('rejects a per-pane Codex (--no-daemon / stdio app-server)', () => {
    expect(classifyMcpParent([['codex', '--no-daemon']])).toBe('other');
    expect(classifyMcpParent([['codex', 'app-server', '--listen', 'stdio://']])).toBe('other');
  });
  it('rejects a script or shell that merely runs UNDER the shared server (spoof attempt)', () => {
    // e.g. a command run by Codex's shell tool that starts its own MCP client
    // and sends someone else's threadId: its parent is that script, not the server.
    expect(classifyMcpParent([['node', 'C:\\tmp\\evil.js'], SHARED_SERVER])).toBe('other');
    expect(classifyMcpParent([['pwsh.exe', '-c', 'x'], SHARED_SERVER])).toBe('other');
    // …even when it passes the MCP entry path along to look like a launcher.
    expect(classifyMcpParent([['node', 'evil.js', './.wmux/mcp/index.js'], ['pwsh', '-c', 'node evil.js ./.wmux/mcp/index.js'], SHARED_SERVER])).toBe('other');
    expect(classifyMcpParent([['node', 'C:\\Users\\u\\.wmux\\mcp\\index.js', '--extra'], SHARED_SERVER])).toBe('other');
  });
  it('rejects an unknown or unreadable parent', () => {
    expect(classifyMcpParent([])).toBe('other');
    expect(classifyMcpParent([[]])).toBe('other');
    expect(classifyMcpParent([MCP_ENTRY])).toBe('other');
  });
  it('parses the Windows command line of the real daemon', () => {
    const argv = tokenizeCommandLine('"C:\\Program Files\\codex\\codex.exe" app-server --listen unix:// --managed-daemon');
    expect(isSharedServerArgv(argv)).toBe(true);
  });
});

describe('readCodexThreadOwner — v1 owner index', () => {
  it('returns the recorded owner pane', () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    expect(readCodexThreadOwner(T1, home)).toEqual({ ptyId: 'pty-a', workspaceId: 'ws-1', dataSuffix: '' });
  });
  it('drops a superseded record (/new or another resume in the same pane)', () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    recordOwner(T2, 'pty-a', 'ws-1'); // pane pointer now names T2
    expect(readCodexThreadOwner(T1, home)).toBeUndefined();
    expect(readCodexThreadOwner(T2, home)?.ptyId).toBe('pty-a');
  });
  it('drops a record whose pane pointer was removed (pane closed)', () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    fs.unlinkSync(path.join(home, 'wmux-thread-owners', `pane-${digest(JSON.stringify(['', 'pty-a']))}.json`));
    expect(readCodexThreadOwner(T1, home)).toBeUndefined();
  });
  it('drops a forged thread record without the matching nonce', () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    const file = path.join(home, 'wmux-thread-owners', `thread-${digest(T1)}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, nonce: randomUUID() }));
    expect(readCodexThreadOwner(T1, home)).toBeUndefined();
  });
  it('returns undefined for an unknown thread or a malformed id', () => {
    expect(readCodexThreadOwner(T1, home)).toBeUndefined();
    expect(readCodexThreadOwner('not-a-uuid', home)).toBeUndefined();
  });
});

describe('matchOwnerToLiveAnchor — repro of #1778 and the fixed routing', () => {
  // Three Codex sessions behind ONE daemon: two in ws-1, one in ws-2. The
  // daemon was started from pty-a, so every MCP child inherits pty-a/ws-1 env —
  // the pre-fix identity for all three.
  const live = [
    { ptyId: 'pty-a', workspaceId: 'ws-1' },
    { ptyId: 'pty-b', workspaceId: 'ws-1' },
    { ptyId: 'pty-c', workspaceId: 'ws-2' },
  ];

  it('gives each session its own pane, not the daemon starter\'s', () => {
    recordOwner(T1, 'pty-a', 'ws-1');
    recordOwner(T2, 'pty-b', 'ws-1');
    recordOwner(T3, 'pty-c', 'ws-2');
    const r = [T1, T2, T3].map((t) => matchOwnerToLiveAnchor(t, readCodexThreadOwner(t, home), live, ''));
    expect(r).toEqual([
      { status: 'hit', wsId: 'ws-1', ptyId: 'pty-a' },
      { status: 'hit', wsId: 'ws-1', ptyId: 'pty-b' },
      { status: 'hit', wsId: 'ws-2', ptyId: 'pty-c' },
    ]);
  });

  it('uses the workspace main resolves now, not the id frozen in the record', () => {
    recordOwner(T1, 'pty-a', 'ws-old');
    expect(matchOwnerToLiveAnchor(T1, readCodexThreadOwner(T1, home), live, '')).toEqual({ status: 'hit', wsId: 'ws-1', ptyId: 'pty-a' });
  });

  it('fails with a diagnostic, never a guess, when the owner pane is closed', () => {
    recordOwner(T1, 'pty-gone', 'ws-1');
    const r = matchOwnerToLiveAnchor(T1, readCodexThreadOwner(T1, home), live, '');
    expect(r).toEqual({ status: 'miss', reason: expect.stringContaining('closed') });
  });

  it('fails when no pane owns the thread', () => {
    expect(matchOwnerToLiveAnchor(T1, undefined, live, '')).toEqual({ status: 'miss', reason: expect.stringContaining('no wmux pane owns') });
  });

  it('refuses a thread owned by another wmux instance', () => {
    recordOwner(T1, 'pty-a', 'ws-1', '-dev');
    const r = matchOwnerToLiveAnchor(T1, readCodexThreadOwner(T1, home), live, '');
    expect(r).toEqual({ status: 'miss', reason: expect.stringContaining('another wmux instance') });
  });
});

describe('index.ts wiring (source-level invariant, #1778)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('wraps BOTH registration paths with the per-call scope', () => {
    expect(src).toMatch(/rest\[rest\.length - 1\]\s*=\s*withCodexCallScope\(wrapHandlerWithResultCap\(/);
    expect(src).toMatch(/\?\s*\(withCodexCallScope\(wrapHandlerWithResultCap\(cb/);
  });

  it('decides a shared-server call by its thread BEFORE either PID walk', () => {
    const lookup = src.slice(src.indexOf('async function lookupPidMapWorkspace'));
    const threadBranch = lookup.indexOf('resolveViaCodexThread(codexScope, entries)');
    expect(threadBranch).toBeGreaterThan(0);
    expect(threadBranch).toBeLessThan(lookup.indexOf('server-walk HIT'));
    expect(threadBranch).toBeLessThan(lookup.indexOf('walk HIT'));
  });

  it('never falls back to the cache or the daemon env hint for a shared-server call', () => {
    const resolve = src.slice(src.indexOf('async function resolveWorkspaceId'));
    const threadBranch = resolve.indexOf('isSharedCodexParent()');
    expect(threadBranch).toBeGreaterThan(0);
    expect(threadBranch).toBeLessThan(resolve.indexOf('workspaceResolved && MY_WORKSPACE_ID'));
    expect(threadBranch).toBeLessThan(resolve.indexOf('ENV_WORKSPACE_HINT'));
  });

  it('never writes a thread-resolved pane into the process-wide MY_PTY_ID', () => {
    const fn = src.slice(src.indexOf('function resolveViaCodexThread'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/MY_PTY_ID\s*=/);
  });

  it('does not freeze the computer caller identity for a shared-server thread', () => {
    const fn = src.slice(src.indexOf('function resolveComputerCallerIdentity'));
    expect(fn.indexOf('isSharedCodexParent()')).toBeLessThan(fn.indexOf('resolveFrozenComputerCallerIdentity()'));
  });

  it('does not cache a thread-resolved identity for terminal routing', () => {
    expect(src).toMatch(/cacheVerifiedWorkspaceId:\s*\(wsId: string\)\s*=>\s*\{\s*if\s*\(codexCallScope\.getStore\(\)\?\.viaThread\)\s*return;/);
  });
});
