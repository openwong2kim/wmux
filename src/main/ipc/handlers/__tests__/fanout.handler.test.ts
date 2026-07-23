// normalizeRequest — titles·taskPrompts index alignment regression guard (3rd-party review: Codex).
//
// Old impl compressed non-string titles via .filter() but kept taskPrompts original indices via .map();
// when non-strings mixed into titles, compression shifted indices and misdelivered other tasks'
// prompts. Fixed by filtering after pairing; pin that regression here.

import { describe, it, expect } from 'vitest';
import { normalizeRequest } from '../fanout.handler';

function baseRaw(overrides?: Record<string, unknown>) {
  return {
    idempotencyKey: 'k1',
    prompt: '',
    repoPath: '/repo',
    agentCmd: 'claude',
    verifiedWorkspaceId: 'ws-1',
    ...overrides,
  };
}

describe('normalizeRequest — titles/taskPrompts index alignment (§7 review)', () => {
  it('taskPrompts pair with correct tasks even when titles contain non-strings', () => {
    const res = normalizeRequest(
      baseRaw({ titles: ['A', null, 'B'], taskPrompts: ['pa', 'ignored', 'pb'] }),
    );
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.titles).toEqual(['A', 'B']);
    // B must get 'pb' from original index 2 — not taskPrompts[1]='ignored' from slot-only match
    // to compressed titles[1] (misdelivery).
    expect(res.taskPrompts).toEqual(['pa', 'pb']);
  });

  it('normal input (no non-strings) preserves order', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'], taskPrompts: ['pa', 'pb'] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.titles).toEqual(['A', 'B']);
    expect(res.taskPrompts).toEqual(['pa', 'pb']);
  });

  it('missing taskPrompts is undefined (distinct from empty array)', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.taskPrompts).toBeUndefined();
  });

  it('explicit empty taskPrompts array passed through', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'], taskPrompts: [] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.taskPrompts).toEqual(['', '']);
  });

  it('rejects when repoPath missing', () => {
    const res = normalizeRequest({ titles: ['A'] });
    expect('error' in res).toBe(true);
  });
});
