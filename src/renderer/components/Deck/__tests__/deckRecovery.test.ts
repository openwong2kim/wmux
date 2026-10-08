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

  it('opens the session picker on a cwd mismatch or an agent mismatch (#1946)', () => {
    const cwdMismatch = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ cwd: 'D:\\other' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(cwdMismatch[0].command).toBe('claude --resume');
    expect(cwdMismatch[0].exact).toBe(false);

    const agentMismatch = buildRecoveryPanes({
      resumeHintByPtyId: { p1: 'claude' },
      ptyReadyByPtyId: { p1: true },
      resumeBindingByPtyId: { p1: binding({ agent: 'codex' }) },
      workspaces: [workspaceWith('p1', 'D:/repo')],
      paneLabel: {},
    });
    expect(agentMismatch[0].command).toBe('claude --resume');
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
    expect(panes[0].command).toBe('claude --resume');
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

  it('says nothing about pickers when every pane resumes an exact session', () => {
    expect(buildRecoveryPrompt(panes)).not.toContain('(pick)');
    expect(buildRecoveryContextLines(panes)).not.toContain('(pick)');
  });
});

// #1946 — recovered Codex panes sharing a folder all typed `codex resume
// --last` and reopened the same newest thread.
describe('fleet recovery of panes sharing a folder (#1946)', () => {
  const THREAD = '0199a1b2-0000-7000-8000-9f8e7d6c5b4a';
  function sharedFolderWorkspace(): Workspace {
    const ws = workspaceWith('p1', 'D:/repo');
    const leaf2 = createLeafPane(createSurface('p2', 'pwsh', 'D:/repo'), 2);
    const leaf3 = createLeafPane(createSurface('p3', 'pwsh', 'D:/repo'), 3);
    return {
      ...ws,
      nextPaneOrdinal: 4,
      rootPane: {
        id: 'split-1',
        type: 'branch',
        direction: 'horizontal',
        children: [ws.rootPane, { id: 'split-2', type: 'branch', direction: 'vertical', children: [leaf2, leaf3], sizes: [50, 50] }],
        sizes: [50, 50],
      },
    };
  }
  const recover = (bindings: Record<string, ResumeBinding>) => buildRecoveryPanes({
    resumeHintByPtyId: { p1: 'codex', p2: 'codex', p3: 'codex' },
    ptyReadyByPtyId: { p1: true, p2: true, p3: true },
    resumeBindingByPtyId: bindings,
    workspaces: [sharedFolderWorkspace()],
    paneLabel: {},
  });

  it('unbound panes open the picker; a bound pane keeps its own thread', () => {
    const panes = recover({ p2: binding({ agent: 'codex', sessionId: THREAD, cwd: 'D:/repo' }) });
    expect(panes.map((p) => [p.ptyId, p.command, p.exact])).toEqual([
      ['p1', 'codex resume', false],
      ['p2', `codex resume ${THREAD}`, true],
      ['p3', 'codex resume', false],
    ]);
    for (const p of panes) expect(p.command).not.toContain('--last');
  });

  it('tells the brain to leave a picker to the user, marking the pane before its command', () => {
    const panes = recover({});
    const prompt = buildRecoveryPrompt(panes);
    expect(prompt).toContain('Do not choose an entry or press any key in it');
    expect(prompt).toContain('ptyId p1 — (pick) run: codex resume');
    // The mark never trails the command, where "run it EXACTLY" would type it.
    expect(prompt).not.toMatch(/codex resume \(pick\)/);
    const lines = buildRecoveryContextLines(panes);
    expect(lines).toContain('Do not choose an entry');
    expect(lines).toContain('ptyId p3 — (pick) codex resume');
  });
});
