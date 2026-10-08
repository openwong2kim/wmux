/**
 * The daemon's copy of main's Moa pane fact: parsing a push, ordering by seq,
 * and the live check that keeps a push from pointing the gate anywhere but the
 * HQ's own brain pane.
 */
import { describe, it, expect } from 'vitest';
import { MoaPaneRpc, MoaPaneStore, parseMoaPane, resolveMoaPane, type MoaPaneFact } from '../moaPane';

const fact = (over: Partial<MoaPaneFact> = {}): MoaPaneFact => ({ sessionId: 'brain-abc', workspaceId: 'hq', ...over });
const brainEnv = (ws = 'hq') => ({ WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: ws });

describe('parseMoaPane', () => {
  it('accepts null and a brain pane, and keeps a well-formed claude binding', () => {
    expect(parseMoaPane(null)).toBeNull();
    const binding = { agent: 'claude', sessionId: 'conv-1', cwd: '/brains/hq', transcriptPath: '/h/.claude/projects/x/conv-1.jsonl', ts: 5 };
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', binding })).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', binding });
  });

  it('refuses an id that is not a brain id, or a missing workspace', () => {
    expect(parseMoaPane({ sessionId: 's1', workspaceId: 'hq' })).toBe('invalid');
    expect(parseMoaPane({ sessionId: 'brain-abc' })).toBe('invalid');
    expect(parseMoaPane({ sessionId: 'brain-' + 'x'.repeat(200), workspaceId: 'hq' })).toBe('invalid');
    expect(parseMoaPane('brain-abc')).toBe('invalid');
    expect(parseMoaPane([])).toBe('invalid');
  });

  it('drops a binding that is not claude or is malformed, and keeps the pane', () => {
    for (const binding of [
      { agent: 'codex', sessionId: 'c', cwd: '/x', ts: 1 },
      { agent: 'claude', sessionId: '', cwd: '/x', ts: 1 },
      { agent: 'claude', sessionId: 'c', cwd: '/x', ts: 'now' },
      { agent: 'claude', sessionId: 'c', cwd: '/x', transcriptPath: 7, ts: 1 },
    ]) {
      expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', binding })).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq' });
    }
  });

  it('keeps a dialog flag, and reads a malformed one as a dialog rather than none', () => {
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12' } }))
      .toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12' } });
    for (const dialog of [{}, { fingerprint: 'NOT HEX' }, null, 'up']) {
      expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog })).toMatchObject({ dialog: { fingerprint: 'unknown' } });
    }
  });

  it('keeps the dialog\'s hook evidence, dropping each malformed or oversized field on its own', () => {
    const evidence = { toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'toolu_1', hookSessionId: 'conv-1', promptId: 'p-1' };
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12', ...evidence, extra: 'x' } }))
      .toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12', ...evidence } });
    const parsed = parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: {
      fingerprint: 'ab12', toolName: 7, toolInput: { command: 'x'.repeat(9000) }, toolUseId: '', hookSessionId: 'conv-1', promptId: ['p'],
    } });
    expect(parsed).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12', hookSessionId: 'conv-1' } });
    // An array is not a tool input; a malformed fingerprint keeps no evidence.
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12', toolInput: ['ls'] } }))
      .toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'ab12' } });
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'NOT HEX', ...evidence } }))
      .toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', dialog: { fingerprint: 'unknown' } });
  });

  it('keeps a startup-screen flag apart from the dialog, and only when it is exactly true', () => {
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', blockedOnTui: true })).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', blockedOnTui: true });
    expect(parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', blockedOnTui: 'yes' })).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq' });
  });

  it('copies only the binding fields it knows', () => {
    const parsed = parseMoaPane({ sessionId: 'brain-abc', workspaceId: 'hq', extra: 'x',
      binding: { agent: 'claude', sessionId: 'c', cwd: '/x', ts: 1, permissionMode: 'bypassPermissions', token: 'secret' } });
    expect(parsed).toEqual({ sessionId: 'brain-abc', workspaceId: 'hq', binding: { agent: 'claude', sessionId: 'c', cwd: '/x', ts: 1 } });
  });
});

describe('MoaPaneStore', () => {
  it('replaces only with a newer seq, so a late older push cannot reopen a closed pane', () => {
    const store = new MoaPaneStore();
    expect(store.current()).toBeNull();
    expect(store.replace(fact(), 1)).toMatchObject({ applied: true });
    expect(store.replace(null, 3)).toMatchObject({ applied: true });
    expect(store.replace(fact(), 2)).toMatchObject({ applied: false, reason: 'stale' });
    expect(store.current()).toBeNull();
  });

  it('starts over after clear (a new publisher counts from 1 again)', () => {
    const store = new MoaPaneStore();
    store.replace(fact(), 9);
    store.clear();
    expect(store.current()).toBeNull();
    expect(store.replace(fact(), 1)).toMatchObject({ applied: true });
    expect(store.current()).toEqual(fact());
  });
});

describe('resolveMoaPane', () => {
  const panes = new Map<string, { meta: { env?: Record<string, string>; state: string } }>([
    ['brain-abc', { meta: { env: brainEnv('hq'), state: 'attached' } }],
    ['brain-other', { meta: { env: brainEnv('ws-2'), state: 'detached' } }],
    ['brain-unmarked', { meta: { env: { WMUX_WORKSPACE_ID: 'hq' }, state: 'detached' } }],
    ['brain-dead', { meta: { env: brainEnv('hq'), state: 'dead' } }],
    ['brain-suspended', { meta: { env: brainEnv('hq'), state: 'suspended' } }],
    ['s1', { meta: { env: brainEnv('hq'), state: 'detached' } }],
  ]);
  const get = (id: string) => panes.get(id);

  it('answers the live HQ brain pane', () => {
    expect(resolveMoaPane(fact(), get)).toBe(panes.get('brain-abc'));
  });

  it('fails closed for no fact, a gone pane, another workspace\'s brain, a pane without the marker, or a non-brain id', () => {
    expect(resolveMoaPane(null, get)).toBeUndefined();
    expect(resolveMoaPane(fact({ sessionId: 'brain-gone' }), get)).toBeUndefined();
    expect(resolveMoaPane(fact({ sessionId: 'brain-other' }), get)).toBeUndefined();
    expect(resolveMoaPane(fact({ sessionId: 'brain-unmarked' }), get)).toBeUndefined();
    expect(resolveMoaPane(fact({ sessionId: 's1' }), get)).toBeUndefined();
    expect(resolveMoaPane(fact({ workspaceId: 'ws-2' }), get)).toBeUndefined();
  });

  it('fails closed for a session the manager still holds but that is dead or suspended', () => {
    expect(resolveMoaPane(fact({ sessionId: 'brain-dead' }), get)).toBeUndefined();
    expect(resolveMoaPane(fact({ sessionId: 'brain-suspended' }), get)).toBeUndefined();
  });
});

describe('MoaPaneRpc (daemon.moa.set)', () => {
  const pane = { meta: { env: brainEnv('hq'), state: 'attached' } };
  const make = () => {
    const changes: Array<[MoaPaneFact | null, MoaPaneFact | null, unknown]> = [];
    const firstParty = new Set(['main-1', 'main-2']);
    const rpc = new MoaPaneRpc({
      isFirstParty: (id) => firstParty.has(id),
      getSession: (id) => (id === 'brain-abc' ? pane : undefined),
      onChanged: (prev, next, p) => { changes.push([prev, next, p]); },
    });
    return { rpc, changes };
  };

  it('refuses a client that is not first-party, and changes nothing', () => {
    const { rpc, changes } = make();
    expect(rpc.handle({ pane: fact(), seq: 1 }, 'plugin')).toEqual({ ok: false, error: 'daemon.moa.set is first-party only' });
    expect(rpc.current()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('refuses a malformed push: no seq, a non-brain id', () => {
    const { rpc } = make();
    expect(rpc.handle({ pane: fact() }, 'main-1')).toMatchObject({ ok: false });
    expect(rpc.handle({ pane: { sessionId: 's1', workspaceId: 'hq' }, seq: 1 }, 'main-1')).toMatchObject({ ok: false });
    expect(rpc.current()).toBeNull();
  });

  it('refuses a second publisher while the first lives, and the second cannot clear it by leaving', () => {
    const { rpc } = make();
    expect(rpc.handle({ pane: fact(), seq: 1 }, 'main-1')).toMatchObject({ ok: true, applied: true });
    expect(rpc.handle({ pane: null, seq: 2 }, 'main-2')).toEqual({ ok: false, error: 'another client is already publishing the Moa pane' });
    rpc.onClientClose('main-2');
    expect(rpc.current()).toEqual(fact());
  });

  it('clears the fact when its publisher disconnects, and the next publisher starts from seq 1', () => {
    const { rpc, changes } = make();
    rpc.handle({ pane: fact(), seq: 5 }, 'main-1');
    rpc.onClientClose('main-1');
    expect(rpc.current()).toBeNull();
    expect(changes.at(-1)?.[1]).toBeNull();
    expect(rpc.handle({ pane: fact(), seq: 1 }, 'main-2')).toMatchObject({ ok: true, applied: true });
  });

  it('reports a change with the live pane it resolves to, and nothing for a stale push', () => {
    const { rpc, changes } = make();
    rpc.handle({ pane: fact(), seq: 2 }, 'main-1');
    expect(changes).toEqual([[null, fact(), pane]]);
    rpc.handle({ pane: null, seq: 1 }, 'main-1');
    expect(changes).toHaveLength(1);
    rpc.handle({ pane: fact({ sessionId: 'brain-gone' }), seq: 3 }, 'main-1');
    expect(changes.at(-1)).toEqual([fact(), fact({ sessionId: 'brain-gone' }), undefined]);
  });
});
