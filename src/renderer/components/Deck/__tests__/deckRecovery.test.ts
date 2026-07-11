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
      resumeBindingByPtyId: { p1: binding({ cwd: 'D:\\other' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(cwdMismatch[0].command).toBe('claude --continue');
    expect(cwdMismatch[0].exact).toBe(false);

    const agentMismatch = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      resumeBindingByPtyId: { p1: binding({ agent: 'codex' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(agentMismatch[0].command).toBe('claude --continue');
  });

  it('uses the codex subcommand grammar', () => {
    const panes = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'codex' },
      resumeBindingByPtyId: { p1: binding({ agent: 'codex', sessionId: 'cx-9' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(panes[0].command).toBe('codex resume cx-9');
  });

  it('never emits permission flags even when the binding carries a mode (D6)', () => {
    const panes = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      resumeBindingByPtyId: { p1: binding({ permissionMode: 'bypassPermissions' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(panes[0].command).toBe('claude --resume sess-1');
    expect(panes[0].command).not.toContain('bypass');
  });

  it('skips hints whose ptyId maps to no live pane, and empty hints entirely', () => {
    expect(
      buildRecoveryPanes({
        resumeHintByPtyId: { ghost: 'claude' },
        resumeBindingByPtyId: {},
        workspaces: [workspaceWith('p1', 'D:/repo')],
        paneLabel: {},
      }),
    ).toEqual([]);
    expect(
      buildRecoveryPanes({
        resumeHintByPtyId: {},
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
    resumeBindingByPtyId: { p1: binding() },
    workspaces: [workspaceWith('p1', 'D:/repo')],
    paneLabel: {},
  });

  it('prompt lists each pane with its ptyId and exact command', () => {
    const prompt = buildRecoveryPrompt(panes);
    expect(prompt).toContain('ptyId p1');
    expect(prompt).toContain('claude --resume sess-1');
    expect(prompt).toContain('terminal_send');
    expect(prompt).toContain('Do not add any permission');
  });

  it('context lines are empty with no panes, populated otherwise', () => {
    expect(buildRecoveryContextLines([])).toBe('');
    const lines = buildRecoveryContextLines(panes);
    expect(lines).toContain('Reboot recovery: 1 pane(s)');
    expect(lines).toContain('claude --resume sess-1');
  });
});
