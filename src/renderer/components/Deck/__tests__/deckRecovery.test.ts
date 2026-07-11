// Unit tests for the fleet recovery greeting logic (Command Deck P3b).
// Pure — no store, no Electron.

import { describe, it, expect } from 'vitest';
import {
  buildRecoveryPanes,
  buildRecoveryPrompt,
  buildRecoveryContextLines,
} from '../deckRecovery';
import { createLeafPane, createSurface, type Workspace } from '../../../../shared/types';
import type { ResumeBinding } from '../../../../shared/agentResume';

function workspaceWith(ptyId: string, cwd: string): Workspace {
  const leaf = createLeafPane(createSurface(ptyId, 'pwsh', cwd), 1);
  return {
    id: 'ws-1',
    name: 'Backend',
    wsOrdinal: 1,
    nextPaneOrdinal: 2,
    rootPane: leaf,
    activePaneId: leaf.id,
  };
}

function binding(over: Partial<ResumeBinding> = {}): ResumeBinding {
  return { agent: 'claude', sessionId: 'sess-1', cwd: 'D:\\repo', ts: 1, ...over };
}

describe('buildRecoveryPanes', () => {
  it('builds the exact-session resume command when agent + cwd match', () => {
    const panes = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding() },
      workspaces: [workspaceWith('p1', 'D:/repo/')],
      paneLabel: {},
    });
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      ptyId: 'p1',
      agent: 'claude',
      command: 'claude --resume sess-1',
      exact: true,
      workspaceName: 'Backend',
    });
  });

  it('falls back to --continue on a cwd mismatch or an agent mismatch', () => {
    const cwdMismatch = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ cwd: 'D:\\other' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(cwdMismatch[0].command).toBe('claude --continue');
    expect(cwdMismatch[0].exact).toBe(false);

    const agentMismatch = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ agent: 'codex' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(agentMismatch[0].command).toBe('claude --continue');
  });

  it('uses the codex subcommand grammar', () => {
    const panes = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'codex' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ agent: 'codex', sessionId: 'cx-9' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(panes[0].command).toBe('codex resume cx-9');
  });

  it('restores the recorded permission mode on the exact-session form (one line, F6)', () => {
    const bypass = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ permissionMode: 'bypassPermissions' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(bypass[0].command).toBe('claude --dangerously-skip-permissions --resume sess-1');

    const plan = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ permissionMode: 'plan' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(plan[0].command).toBe('claude --permission-mode plan --resume sess-1');

    // No recorded mode → no flag.
    const none = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding() },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(none[0].command).toBe('claude --resume sess-1');
  });

  it('the fallback form never carries a permission flag (nothing trusted to restore)', () => {
    const panes = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: {
        p1: binding({ cwd: 'D:\\other', permissionMode: 'bypassPermissions' }),
      },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(panes[0].command).toBe('claude --continue');
  });

  it('excludes a pane whose recovered PTY is not writable yet (EI6 gate)', () => {
    const notReady = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: {},
      resumeBindingByPtyId: { p1: binding() },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(notReady).toEqual([]);
  });

  it('skips hints whose ptyId maps to no live pane, and empty hints entirely', () => {
    expect(
      buildRecoveryPanes({
        resumeHintByPtyId: { ghost: 'claude' },
        ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: {},
        workspaces: [workspaceWith('p1', 'D:/repo')],
        paneLabel: {},
      }),
    ).toEqual([]);
    expect(
      buildRecoveryPanes({
        resumeHintByPtyId: {},
        ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: {},
        workspaces: [workspaceWith('p1', 'D:/repo')],
        paneLabel: {},
      }),
    ).toEqual([]);
  });
});

describe('buildRecoveryPrompt / buildRecoveryContextLines', () => {
  const panes = buildRecoveryPanes({
    resumeHintByPtyId: { p1: 'claude' },
    ptyReadyByPtyId: { p1: true },
    resumeBindingByPtyId: { p1: binding() },
    workspaces: [workspaceWith('p1', 'D:/repo')],
    paneLabel: {},
  });

  it('prompt lists each pane with its ptyId and exact command', () => {
    const prompt = buildRecoveryPrompt(panes);
    expect(prompt).toContain('ptyId p1');
    expect(prompt).toContain('claude --resume sess-1');
    expect(prompt).toContain('terminal_send');
    expect(prompt).toContain('EXACTLY as');
  });

  it('context lines are empty with no panes, populated otherwise', () => {
    expect(buildRecoveryContextLines([])).toBe('');
    const lines = buildRecoveryContextLines(panes);
    expect(lines).toContain('Reboot recovery: 1 pane(s)');
    expect(lines).toContain('claude --resume sess-1');
  });
});
