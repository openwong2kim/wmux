// Unit tests for the recovery re-entry chip builder — pure objects, no store.

import { describe, it, expect } from 'vitest';
import { buildQuickActions } from '../deckQuickActions';
import type { RecoveryPane } from '../deckRecovery';

const recoveryPane = (over: Partial<RecoveryPane> = {}): RecoveryPane => ({
  ptyId: 'pty-1',
  autoName: '1.1-claude',
  label: '1.1-claude',
  workspaceName: 'Backend',
  agent: 'claude',
  command: 'claude --resume sess-1',
  exact: true,
  ...over,
});

describe('buildQuickActions', () => {
  it('is empty without recoverable panes — no always-on canned-prompt chips', () => {
    // "Agent status" / "PR status" were removed (owner 2026-07-14): the bar is
    // for controls, not canned prompts. Nothing to recover ⇒ no chips.
    expect(buildQuickActions({ recoveryPanes: [] })).toEqual([]);
  });

  it('offers the recover chip only while recoverable panes exist', () => {
    const some = buildQuickActions({ recoveryPanes: [recoveryPane()] });
    expect(some.map((a) => a.id)).toEqual(['recover-fleet']);
    const recover = some[0];
    // The chip carries the same canned prompt the greeting card sends —
    // per-pane exact commands included.
    expect(recover.prompt).toContain('claude --resume sess-1');
    expect(recover.prompt).toContain('pty-1');
    expect(recover.label).toBe('Recover agents');
  });

  it('uses the translator for the recover label when it yields a value', () => {
    const t = (key: string): string => (key === 'deck.recoveryRun' ? 'Agent recovery' : '');
    const actions = buildQuickActions({ recoveryPanes: [recoveryPane()], t });
    expect(actions[0].label).toBe('Agent recovery');
  });
});
