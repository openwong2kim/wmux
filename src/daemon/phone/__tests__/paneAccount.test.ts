import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPhoneBridge } from '../DesktopPhoneBridge';
import { applyPaneAccount, handoffRowOf, resolvePaneAccount, storedHandoffOf, verifyHandoff } from '../paneAccount';
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
    expect(handoffRowOf({ sessionId: 'src', agentSessionId: 'conv-1', verified: true, at: 1 }, false)).toEqual({ handoffFrom: { sessionId: 'src', verified: true, at: 1 } });
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
