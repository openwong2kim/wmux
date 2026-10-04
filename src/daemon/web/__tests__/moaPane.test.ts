/**
 * The daemon's copy of main's Moa pane fact: parsing a push, ordering by seq,
 * and the live check that keeps a push from pointing the gate anywhere but the
 * HQ's own brain pane.
 */
import { describe, it, expect } from 'vitest';
import { MoaPaneStore, parseMoaPane, resolveMoaPane, type MoaPaneFact } from '../moaPane';

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
  const panes = new Map<string, { meta: { env?: Record<string, string> } }>([
    ['brain-abc', { meta: { env: brainEnv('hq') } }],
    ['brain-other', { meta: { env: brainEnv('ws-2') } }],
    ['brain-unmarked', { meta: { env: { WMUX_WORKSPACE_ID: 'hq' } } }],
    ['s1', { meta: { env: brainEnv('hq') } }],
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
});
