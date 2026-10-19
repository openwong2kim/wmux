import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../../shared/types';
import { ESCAPE_CSI_U, openClaudeRewind, type ClaudeRewindDeps } from '../openClaudeRewind';

const RULE = '─'.repeat(40);
const empty = ['● hi', '', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'];

function harness(opts: { status?: AgentStatus; slug?: string; screen?: string[] | null; approval?: boolean; title?: string; kitty?: boolean; readMs?: number; between?: (h: { type: () => void; set: (s: AgentStatus) => void }) => void } = {}) {
  const writes: string[] = [];
  let status: AgentStatus = opts.status ?? 'idle';
  let revision = 7;
  const ctl = { type: () => { revision += 1; }, set: (s: AgentStatus) => { status = s; } };
  let clock = 1_500;
  const deps: ClaudeRewindDeps = {
    hasOpenApproval: () => opts.approval ?? false,
    getAgentState: () => ({ slug: opts.slug ?? 'claude', status, inputRevision: revision }),
    readScreen: async () => { clock += opts.readMs ?? 0; return opts.screen === undefined ? empty : opts.screen; },
    readTitle: () => (opts.title ? { title: opts.title, at: 1_000 } : null),
    // Every write is a key: it moves the revision, as noteInput does.
    write: (data) => { writes.push(data); revision += 1; return true; },
    kitty: opts.kitty,
    delay: async () => { opts.between?.(ctl); },
    now: () => clock,
  };
  return { deps, writes };
}

describe('openClaudeRewind', () => {
  it('writes two separate ESCs to an idle Claude with an empty composer', async () => {
    const h = harness();
    expect(await openClaudeRewind(h.deps)).toBe('opened');
    expect(h.writes).toEqual(['\x1b', '\x1b']);
  });

  it('opens for a Claude whose turn ended and waits for input', async () => {
    const h = harness({ status: 'waiting' });
    expect(await openClaudeRewind(h.deps)).toBe('opened');
  });

  it('encodes ESC as CSI-u for a pane that negotiated kitty keys', async () => {
    const h = harness({ kitty: true });
    expect(await openClaudeRewind(h.deps)).toBe('opened');
    expect(h.writes).toEqual([ESCAPE_CSI_U, ESCAPE_CSI_U]);
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

  it('sends no second ESC when a slow screen read stretched the gap past a double-tap', async () => {
    const h = harness({ readMs: 500 });
    expect(await openClaudeRewind(h.deps)).toBe('retry');
    expect(h.writes).toEqual(['\x1b']);
  });

  it.each([
    ['a turn starts', (c: { set: (s: AgentStatus) => void }) => c.set('running')],
    ['someone types into the pane', (c: { type: () => void }) => c.type()],
  ])('stops after the first ESC when %s in the gap', async (_name, between) => {
    const h = harness({ between });
    expect(await openClaudeRewind(h.deps)).toBe('busy');
    expect(h.writes).toEqual(['\x1b']);
  });
});
