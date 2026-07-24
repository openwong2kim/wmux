// @vitest-environment jsdom
//
// Dynamic tests for the Fleet roster's pane-role dropdown (#442, plan:
// plans/orchestrator-pane-role-presets-2026-07-13.md). Mounts the real
// <DeckFleet/> via react-dom/client against a seeded store, covering the two
// CRITICAL regressions the eng review flagged:
//   1. Row restructure — the jump <button> and the role <select> are SIBLINGS
//      (a <select> cannot nest inside a <button>); jump still fires on the
//      button, and interacting with the select does NOT jump.
//   2. Write path — selecting a role calls the METADATA_SET_ROLE IPC
//      (electronAPI.metadata.setRole), never a renderer-local set. A local
//      write would be invisible to the orchestrator, which reads MetadataStore.
// Plus: the dropdown reflects the current paneRole mirror, including a custom
// (out-of-vocabulary) role set via MCP.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DeckFleet from '../DeckFleet';
import { useStore } from '../../../stores';
import { ORCH_ROLES } from '../../../../shared/orchestratorRole';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';

// ─── Fixtures (mirrors selectors/__tests__/fleet.test.ts) ───────────────────

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return {
    id,
    name,
    rootPane,
    activePaneId,
    metadata: { agentName: 'Claude Code', agentStatus: 'idle' as AgentStatus },
  };
}

const w1 = workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1')]), 'p1');

let container: HTMLDivElement;
let root: Root;
let setRole: ReturnType<typeof vi.fn>;
let onJumpToPane: ReturnType<typeof vi.fn<(workspaceId: string, paneId: string) => void>>;

function seedStore(paneRole: Record<string, string> = {}): void {
  act(() =>
    useStore.setState({
      workspaces: [w1],
      activeWorkspaceId: 'ws-1',
      surfaceAgentStatus: {},
      surfaceActivity: {},
      paneLabel: {},
      paneRole,
    }),
  );
}

function mount(): void {
  act(() => {
    root.render(createElement(DeckFleet, { onJumpToPane }));
  });
}

const q = <T extends Element>(sel: string): T => {
  const el = container.querySelector(sel) as T | null;
  if (!el) throw new Error(`${sel} not rendered`);
  return el;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setRole = vi.fn().mockResolvedValue(undefined);
  onJumpToPane = vi.fn<(workspaceId: string, paneId: string) => void>();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    metadata: { setRole },
  };
  seedStore();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('DeckFleet role dropdown', () => {
  it('renders the jump button and the role <select> as SIBLINGS (never nested)', () => {
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    const button = row.querySelector('button');
    const select = row.querySelector('select');
    expect(button).not.toBeNull();
    expect(select).not.toBeNull();
    // The critical invalid-nesting regression: a <select> inside a <button>.
    expect(button!.querySelector('select')).toBeNull();
    expect(select!.parentElement).toBe(row);
  });

  // D2 — a bound role shows a muted `agent · model` chip; an unbound role
  // shows none.
  it('renders the enforced agent · model chip only when the role is bound', () => {
    seedStore({ p1: 'Reviewer' });
    act(() => useStore.setState({ orchestratorRoleBindings: { Reviewer: { agent: 'codex', model: 'o3' } } }));
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    expect(row.textContent).toContain('codex · o3');
  });

  it('shows no binding chip for an unbound role', () => {
    seedStore({ p1: 'Builder' });
    act(() => useStore.setState({ orchestratorRoleBindings: {} }));
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    expect(row.textContent).not.toContain('·');
  });

  // P2-B — the chip read the same for a binding that enforces nothing, so the
  // roster asserted a pinned model the launch path never applies. It must agree
  // with the pane badge: both gate on bindingEnforcesModel.
  it.each([
    ['a model with no agent', { model: 'haiku' }],
    ['an agent with no verified --model grammar', { agent: 'gemini', model: 'flash' }],
    ['an args-only binding (no model to show)', { agent: 'claude', args: '--verbose' }],
    ['an inert agent-only binding', { agent: 'claude' }],
  ])('shows no chip for %s', (_label, binding) => {
    seedStore({ p1: 'Reviewer' });
    act(() => useStore.setState({ orchestratorRoleBindings: { Reviewer: binding } }));
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    for (const shown of ['haiku', 'flash', 'gemini', '--verbose', '·']) {
      expect(row.textContent).not.toContain(shown);
    }
  });

  // DESIGN.md: rows are 26–30px and the type scale starts at 10px. A bound row
  // used to grow (min-h + a stacked 9px sub-label), breaking both.
  it('keeps the fixed row height and the 10px floor when the role is bound', () => {
    seedStore({ p1: 'Reviewer' });
    act(() => useStore.setState({ orchestratorRoleBindings: { Reviewer: { agent: 'codex', model: 'o3' } } }));
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    expect(row.className).toContain('h-[26px]');
    expect(row.className).not.toContain('min-h-[26px]');
    expect(row.innerHTML).not.toContain('text-[9px]');
  });

  it('jump button still jumps; the select does NOT trigger a jump', () => {
    mount();
    const row = q<HTMLDivElement>('[data-deck-fleet-row]');
    act(() => {
      row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onJumpToPane).toHaveBeenCalledWith('ws-1', 'p1');

    onJumpToPane.mockClear();
    const select = row.querySelector('select')!;
    act(() => {
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onJumpToPane).not.toHaveBeenCalled();
  });

  it('selecting a role calls the METADATA_SET_ROLE IPC (not a local set)', () => {
    mount();
    const select = q<HTMLSelectElement>('[data-deck-fleet-row] select');
    act(() => {
      select.value = 'Reviewer';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setRole).toHaveBeenCalledTimes(1);
    expect(setRole).toHaveBeenCalledWith('p1', 'ws-1', 'Reviewer');
    // The displayed value must come from the paneRole MIRROR (daemon-fed), not
    // an optimistic local write — until the relay lands, the select stays ''.
    expect(select.value).toBe('');
  });

  it('shows the current role from the paneRole mirror', () => {
    seedStore({ p1: 'Tester' });
    mount();
    expect(q<HTMLSelectElement>('[data-deck-fleet-row] select').value).toBe('Tester');
  });

  it('surfaces a custom (out-of-vocabulary) role set via MCP as a selectable option', () => {
    seedStore({ p1: 'Archivist' });
    mount();
    const select = q<HTMLSelectElement>('[data-deck-fleet-row] select');
    expect(select.value).toBe('Archivist');
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('Archivist');
    for (const r of ORCH_ROLES) expect(options).toContain(r);
  });

  it('clearing back to "role…" writes the empty-string unassigned sentinel', () => {
    seedStore({ p1: 'Builder' });
    mount();
    const select = q<HTMLSelectElement>('[data-deck-fleet-row] select');
    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setRole).toHaveBeenCalledWith('p1', 'ws-1', '');
  });
});
