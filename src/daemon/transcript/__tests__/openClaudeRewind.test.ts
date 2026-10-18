import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../../shared/types';
import { openClaudeRewind, type ClaudeRewindDeps } from '../openClaudeRewind';

const RULE = '─'.repeat(40);
const empty = ['● hi', '', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'];

function harness(opts: { status?: AgentStatus; slug?: string; screen?: string[] | null; approval?: boolean; title?: string; afterFirst?: () => void } = {}) {
  const writes: string[] = [];
  let status: AgentStatus = opts.status ?? 'idle';
  let approval = opts.approval ?? false;
  const deps: ClaudeRewindDeps = {
    hasOpenApproval: () => approval,
    getAgentState: () => ({ slug: opts.slug ?? 'claude', status }),
    readScreen: async () => (opts.screen === undefined ? empty : opts.screen),
    readTitle: () => (opts.title ? { title: opts.title, at: 1_000 } : null),
    write: (data) => { writes.push(data); return true; },
    delay: async () => { opts.afterFirst?.(); },
    now: () => 1_500,
  };
  return { deps, writes, set: (s: AgentStatus) => { status = s; }, approve: () => { approval = true; } };
}

describe('openClaudeRewind', () => {
  it('writes two separate ESCs to an idle Claude with an empty composer', async () => {
    const h = harness();
    expect(await openClaudeRewind(h.deps)).toBe('opened');
    expect(h.writes).toEqual(['\x1b', '\x1b']);
  });

  it.each([
    ['a running turn', { status: 'running' as const }, 'busy'],
    ['a running turn the hook missed', { title: '◐ Working' }, 'busy'],
    ['a draft in the composer', { screen: ['● hi', RULE, '❯ half-typed', RULE] }, 'draft'],
    ['an open approval', { approval: true }, 'blocked'],
    ['an unreadable screen', { screen: null }, 'blocked'],
    ['another agent', { slug: 'codex' }, 'unavailable'],
  ])('refuses %s without writing', async (_name, opts, verdict) => {
    const h = harness(opts);
    expect(await openClaudeRewind(h.deps)).toBe(verdict);
    expect(h.writes).toEqual([]);
  });

  it('stops after the first ESC when a turn starts in the gap', async () => {
    const h = harness({ afterFirst: () => h.set('running') });
    expect(await openClaudeRewind(h.deps)).toBe('busy');
    expect(h.writes).toEqual(['\x1b']);
  });
});
