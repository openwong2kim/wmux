import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPhoneBridge } from '../DesktopPhoneBridge';
import { applyPaneAccount, assertPaneAccountUsable, handoffRowOf, paneAccountFailure, resolvePaneAccount, storedHandoffOf, verifyHandoff } from '../paneAccount';
import { dropMissingAccountDirs, pinAccountEnv } from '../paneAccountSpawn';
import { RunHistoryStore } from '../../history/RunHistoryStore';
import { StateWriter } from '../../StateWriter';
import { DESKTOP_ACCOUNT_ENV_COMMAND } from '../../../shared/phonePaneAccount';
import type { HookAgentEventData } from '../../hooks/HookIngest';

/** A bridge whose desktop answers every request with `answer` (or fails it). */
function desktop(answer: (command: string) => { ok: boolean; result?: unknown }, commands?: string[]) {
  const seen: string[] = [];
  const bridge: DesktopPhoneBridge = new DesktopPhoneBridge((_owner, raw) => {
    const data = (raw as { data: { requestId: string; command: string } }).data;
    seen.push(data.command);
    queueMicrotask(() => bridge.complete('main', { requestId: data.requestId, ...answer(data.command) }));
    return true;
  });
  bridge.register('main', commands);
  return { bridge, seen };
}

describe('per-pane account resolution fails closed', () => {
  it('an old desktop that announced nothing is refused without being asked', async () => {
    const { bridge, seen } = desktop(() => ({ ok: true, result: { ok: true, vendor: 'claude', env: { CLAUDE_CONFIG_DIR: '/acct' } } }));
    expect(bridge.supports(DESKTOP_ACCOUNT_ENV_COMMAND)).toBe(false);
    expect(await resolvePaneAccount(bridge, 'ws-1', 'a2')).toEqual({ ok: false, refusal: { status: 503, body: { error: 'desktop-unavailable', effect: 'none' } } });
    expect(seen).toEqual([]);
  });

  it('an announced command that fails in the desktop (unknown command, throw) is refused', async () => {
    const { bridge } = desktop(() => ({ ok: false }), [DESKTOP_ACCOUNT_ENV_COMMAND]);
    expect((await resolvePaneAccount(bridge, 'ws-1', 'a2'))).toMatchObject({ ok: false, refusal: { status: 503 } });
  });

  it('forgets the announcement when the desktop detaches', () => {
    const { bridge } = desktop(() => ({ ok: true }), [DESKTOP_ACCOUNT_ENV_COMMAND]);
    expect(bridge.supports(DESKTOP_ACCOUNT_ENV_COMMAND)).toBe(true);
    bridge.disconnect('main');
    expect(bridge.supports(DESKTOP_ACCOUNT_ENV_COMMAND)).toBe(false);
    bridge.register('main');
    expect(bridge.supports(DESKTOP_ACCOUNT_ENV_COMMAND)).toBe(false);
  });

  it('maps the desktop refusals and rejects every malformed answer', async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ ok: false, error: 'unknown-account' }, 400, 'unknown-account'],
      [{ ok: false, error: 'account-directory-missing' }, 409, 'account-directory-missing'],
      [{ ok: false, error: 'something-else' }, 503, 'desktop-unavailable'],
      [{ ok: true, vendor: 'claude', env: { CODEX_HOME: '/acct' } }, 503, 'desktop-unavailable'],
      [{ ok: true, vendor: 'claude', env: { CLAUDE_CONFIG_DIR: 'relative' } }, 503, 'desktop-unavailable'],
      [{ ok: true, vendor: 'claude', env: { CLAUDE_CONFIG_DIR: '/a', CODEX_HOME: '/b' } }, 503, 'desktop-unavailable'],
      [{ ok: true, vendor: 'gemini', env: { CLAUDE_CONFIG_DIR: '/a' } }, 503, 'desktop-unavailable'],
      [{ CLAUDE_CONFIG_DIR: '/a' }, 503, 'desktop-unavailable'],
    ];
    for (const [result, status, error] of cases) {
      const { bridge } = desktop(() => ({ ok: true, result }), [DESKTOP_ACCOUNT_ENV_COMMAND]);
      expect(await resolvePaneAccount(bridge, 'ws-1', 'a2')).toEqual({ ok: false, refusal: { status, body: { error, effect: 'none' } } });
    }
  });

  it('resolves a well-formed answer and overrides only that vendor key', async () => {
    const { bridge, seen } = desktop(() => ({ ok: true, result: { ok: true, vendor: 'codex', env: { CODEX_HOME: '/acct/b' } } }), [DESKTOP_ACCOUNT_ENV_COMMAND]);
    const resolved = await resolvePaneAccount(bridge, 'ws-1', 'a2');
    expect(resolved).toEqual({ ok: true, account: { vendor: 'codex', dir: '/acct/b' } });
    expect(seen).toEqual([DESKTOP_ACCOUNT_ENV_COMMAND]);
    const env = applyPaneAccount({ CLAUDE_CONFIG_DIR: '/ws/claude', CODEX_HOME: '/ws/codex', PATH: '/bin' }, { vendor: 'codex', dir: '/acct/b' });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/ws/claude', CODEX_HOME: '/acct/b', PATH: '/bin' });
  });
});

describe('handoff lineage', () => {
  const deps = (over: Partial<Parameters<typeof verifyHandoff>[1]> = {}) => ({
    readable: (id: string) => id === 'src', allowTranscript: true,
    currentConversation: vi.fn(async () => 'conv-1' as string | undefined), now: () => 42, ...over,
  });

  it('verifies only a readable source whose conversation matches', async () => {
    expect(await verifyHandoff({ sessionId: 'src' }, deps())).toEqual({ sessionId: 'src', verified: true, at: 42 });
    expect(await verifyHandoff({ sessionId: 'src', agentSessionId: 'conv-1' }, deps())).toMatchObject({ verified: true });
    expect(await verifyHandoff({ sessionId: 'src', agentSessionId: 'conv-2' }, deps())).toMatchObject({ verified: false });
    expect(await verifyHandoff({ sessionId: 'hidden', agentSessionId: 'conv-1' }, deps())).toEqual({ sessionId: 'hidden', agentSessionId: 'conv-1', verified: false, at: 42 });
  });

  it('never compares a conversation id without the transcript grant', async () => {
    const d = deps({ allowTranscript: false });
    expect(await verifyHandoff({ sessionId: 'src', agentSessionId: 'conv-1' }, d)).toMatchObject({ verified: false });
    expect(d.currentConversation).not.toHaveBeenCalled();
    expect(handoffRowOf({ sessionId: 'src', agentSessionId: 'conv-1', verified: true, at: 1 }, false, () => true)).toEqual({ handoffFrom: { sessionId: 'src', verified: true, at: 1 } });
  });

  it('puts the source id on a row only for a reader who may attach that pane', () => {
    const stored = { sessionId: 'src', agentSessionId: 'conv-1', verified: true, at: 1 };
    expect(handoffRowOf(stored, true, () => true)).toEqual({ handoffFrom: stored });
    expect(handoffRowOf(stored, true, () => false)).toEqual({ handoffFrom: { verified: true, at: 1 } });
    expect(handoffRowOf(undefined, true, () => true)).toEqual({});
  });

  it('a failed conversation read is "not proven", never an error', async () => {
    expect(await verifyHandoff({ sessionId: 'src', agentSessionId: 'c' }, deps({ currentConversation: async () => { throw new Error('x'); } }))).toMatchObject({ verified: false });
  });

  it('rejects malformed stored records', () => {
    expect(storedHandoffOf({ sessionId: 'a b', verified: true, at: 1 })).toBeUndefined();
    expect(storedHandoffOf({ sessionId: 'a', verified: 'yes', at: 1 })).toBeUndefined();
    expect(storedHandoffOf({ sessionId: 'a', verified: false, at: 1, extra: 1 })).toEqual({ sessionId: 'a', verified: false, at: 1 });
  });
});

describe('lineage persists where older loaders still read it', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const hook = (kind: HookAgentEventData['signal']['kind'], status: HookAgentEventData['status'], ts: number): HookAgentEventData => ({
    source: 'hook', decision: 'emit', hookKind: kind, status, agent: 'Claude Code', message: 'done',
    signal: { kind, agent: 'claude', agentSessionId: 'agent-1', cwd: '/repo', payload: {}, ts },
  });
  const lineage = { sessionId: 'web-src', agentSessionId: 'conv-1', verified: true, at: 7 };

  it('stamps every history entry of the pane, across a restart and an interruption', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lineage-'));
    const store = new RunHistoryStore(root);
    store.ingest('web-new', {}, hook('agent.stop', 'complete', 100), lineage);
    store.ingest('web-new', {}, hook('agent.tool_started', 'running', 200), lineage);
    new RunHistoryStore(root).interrupted('web-new', 300);
    const entries = new RunHistoryStore(root).list().entries;
    expect(entries.map(e => [e.outcome, e.handoffFrom])).toEqual([['interrupted', lineage], ['completed', lineage]]);
    // The file keeps version 1 and the fields every older loader checks, so a
    // pre-lineage daemon still accepts every entry (it ignores the extra key).
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'phone-run-history.json'), 'utf8'));
    expect(raw.version).toBe(1);
    for (const e of raw.entries) {
      expect(typeof e.id === 'string' && typeof e.sessionId === 'string' && typeof e.workspace === 'string' &&
        typeof e.agent === 'string' && typeof e.summary === 'string' && Number.isFinite(e.at)).toBe(true);
    }
  });

  it('drops a malformed lineage on load but keeps the entry', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lineage-'));
    fs.writeFileSync(path.join(root, 'phone-run-history.json'), JSON.stringify({ version: 1, active: [], entries: [
      { id: 'e1', sessionId: 's', workspace: '', agent: 'a', outcome: 'completed', at: 1, summary: 'x', handoffFrom: { sessionId: 'bad id' } },
    ] }));
    expect(new RunHistoryStore(root).list().entries).toEqual([{ id: 'e1', sessionId: 's', workspace: '', agent: 'a', outcome: 'completed', at: 1, summary: 'x' }]);
  });

  it('a sessions.json written with lineage loads through the unchanged state loader', () => {
    // StateWriter.ts is not modified by this change: this is the loader every
    // earlier daemon runs. The file is written by hand, not by the new code.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lineage-'));
    const now = new Date().toISOString();
    const record = { id: 'web-new', state: 'detached', createdAt: now, lastActivity: now, pid: 1, cmd: '/bin/zsh', cwd: '/x',
      env: {}, cols: 80, rows: 24, deadTtlHours: 24, handoffFrom: lineage };
    fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({ version: 1, sessions: [record] }));
    const loaded = new StateWriter(root).load();
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0]).toMatchObject({ id: 'web-new', state: 'detached', handoffFrom: lineage });
  });

  it('survives a sessions.json round trip through the state loader', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lineage-'));
    const writer = new StateWriter(root);
    const now = new Date().toISOString();
    writer.saveImmediate({ version: 1, sessions: [{
      id: 'web-new', state: 'detached', createdAt: now, lastActivity: now, pid: 1, cmd: '/bin/zsh', cwd: '/x',
      env: {}, cols: 80, rows: 24, deadTtlHours: 24, handoffFrom: lineage,
    }] });
    expect(new StateWriter(root).load().sessions.map(s => [s.id, s.handoffFrom])).toEqual([['web-new', lineage]]);
  });
});

describe('the account a phone pane actually runs on', () => {
  const id = 'web-3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90';
  const env = { WMUX_WORKSPACE_ID: 'ws-1', CLAUDE_CONFIG_DIR: "/acct/it's b", CODEX_HOME: '/ws/codex' };

  it('re-exports the account keys after the login profile, quoted, for a POSIX wrapper shell only', () => {
    const pinned = pinAccountEnv(id, '/bin/zsh', 'claude --model opus', env);
    expect(pinned).toBe(`export CLAUDE_CONFIG_DIR='/acct/it'\\''s b' CODEX_HOME='/ws/codex'; claude --model opus`);
    expect(pinAccountEnv(id, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'claude', env)).toBe('claude');
    expect(pinAccountEnv(id, '/usr/bin/fish', 'claude', env)).toBe('claude');
    // Desktop panes and workspace-less phone panes spawn exactly as before.
    expect(pinAccountEnv('daemon-1', '/bin/zsh', 'claude', env)).toBe('claude');
    expect(pinAccountEnv(id, '/bin/zsh', 'claude', { CLAUDE_CONFIG_DIR: '/x' })).toBe('claude');
  });

  it('the pinned value survives a profile that exports another account', async () => {
    const { execFileSync } = await import('node:child_process');
    if (process.platform === 'win32') return;
    const out = execFileSync('/bin/sh', ['-c', `CLAUDE_CONFIG_DIR=/profile; ${pinAccountEnv(id, '/bin/sh', 'printf %s "$CLAUDE_CONFIG_DIR"', env)}`]).toString();
    expect(out).toBe("/acct/it's b");
  });

  it('drops a gone account directory before a respawn, with a warning', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acct-'));
    try {
      const next: Record<string, string> = { WMUX_WORKSPACE_ID: 'ws-1', CLAUDE_CONFIG_DIR: path.join(root, 'gone'), CODEX_HOME: root };
      const warn = vi.fn();
      dropMissingAccountDirs(id, next, warn);
      expect(next).toEqual({ WMUX_WORKSPACE_ID: 'ws-1', CODEX_HOME: root });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(() => assertPaneAccountUsable({ supports: () => true }, { vendor: 'codex', dir: root })).not.toThrow();
      const gone = (() => { try { assertPaneAccountUsable({ supports: () => true }, { vendor: 'claude', dir: path.join(root, 'gone') }); } catch (e) { return e; } })();
      expect(paneAccountFailure(gone)).toEqual({ status: 409, body: { error: 'account-directory-missing', effect: 'none' } });
      const detached = (() => { try { assertPaneAccountUsable({ supports: () => false }, { vendor: 'codex', dir: root }); } catch (e) { return e; } })();
      expect(paneAccountFailure(detached)).toEqual({ status: 503, body: { error: 'desktop-unavailable', effect: 'none' } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
