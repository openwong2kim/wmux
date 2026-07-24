// @vitest-environment jsdom
//
// P2-C — a pane seeded by a wmux.json layout and its role.
//
// Applying a layout REPLACES the workspace's pane tree with freshly generated
// pane ids. The paneRole mirror is keyed by pane id and fed by the daemon's
// metadata relay, so it is necessarily empty for a pane created a moment ago:
// before this, a project pane's seeded command launched with no role and no
// enforcement, while the Settings copy and the CHANGELOG both said the seeded
// launch was one of the three covered sites.
//
// The layout leaf now declares its role, and the funnel does two things with it
// — assigns it for real (same MetadataStore authority as the Fleet dropdown, so
// it persists and reaches the orchestrator) and enforces the role's binding on
// the command it is about to run. Both are asserted here against the real
// component and the real store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyLeafFunnel } from '../EmptyLeafFunnel';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;
let setRole: ReturnType<typeof vi.fn>;
let paneId: string;
let wsId: string;

/** Seed a workspace holding one EMPTY leaf — the shape the funnel acts on —
 *  with the given project seed pinned to it. */
function seedWorkspace(seed: Record<string, unknown>): void {
  const ws = createWorkspace('proj');
  const rootPane = ws.rootPane;
  if (rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  rootPane.surfaces = [];
  paneId = rootPane.id;
  wsId = ws.id;
  act(() =>
    useStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      paneGate: 'ready',
      paneRole: {},
      projectPaneSeed: { [paneId]: seed as never },
    }),
  );
}

const mount = () => act(() => root.render(createElement(EmptyLeafFunnel)));

/** The options object the funnel handed to pty.create. */
const createdWith = () => create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // A promise that never settles: we assert the REQUEST the funnel assembles
  // and never reach the adopt-the-pty continuation (not what this covers).
  create = vi.fn().mockReturnValue(new Promise(() => undefined));
  setRole = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { create, dispose: vi.fn() },
    metadata: { setRole },
  };
  act(() => useStore.setState({ orchestratorRoleBindings: {} }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState({ orchestratorRoleBindings: {}, projectPaneSeed: {}, paneRole: {} }));
});

describe('EmptyLeafFunnel — a project-seeded pane keeps its role', () => {
  it('assigns the layout’s role through the MetadataStore IPC', () => {
    seedWorkspace({ command: 'claude', cwd: 'd:\\proj', role: 'Reviewer' });
    mount();
    // Same authority and argument order as the Fleet dropdown, so the role
    // persists to metadata.json and relays to the orchestrator — rather than
    // existing only for the length of this one launch.
    expect(setRole).toHaveBeenCalledWith(paneId, wsId, 'Reviewer');
  });

  it('enforces the bound model on the seeded launch command', () => {
    act(() =>
      useStore.setState({ orchestratorRoleBindings: { Reviewer: { agent: 'codex', model: 'o3' } } }),
    );
    seedWorkspace({ command: 'codex', cwd: 'd:\\proj', role: 'Reviewer' });
    mount();
    expect(createdWith().initialCommand).toBe('codex --model o3');
  });

  it('enforces on a SUPERVISED leaf’s exec unit too', () => {
    // `role` + `restart` on the same leaf sends the funnel down the exec branch.
    // Leaving that uncovered would have made the combination silently inert.
    act(() =>
      useStore.setState({ orchestratorRoleBindings: { Builder: { agent: 'claude', model: 'haiku' } } }),
    );
    seedWorkspace({ command: 'claude /loop', cwd: 'd:\\proj', role: 'Builder', restart: 'on-failure' });
    mount();
    const options = createdWith();
    expect(options.exec).toBe('claude --model haiku /loop');
    expect(options.initialCommand).toBeUndefined();
  });

  it('leaves the command alone when the declared role is unbound', () => {
    seedWorkspace({ command: 'claude', cwd: 'd:\\proj', role: 'Planner' });
    mount();
    expect(createdWith().initialCommand).toBe('claude');
    // The role is still assigned — it is a routing hint even with no binding.
    expect(setRole).toHaveBeenCalledWith(paneId, wsId, 'Planner');
  });

  it('never touches a non-agent seed command', () => {
    act(() =>
      useStore.setState({ orchestratorRoleBindings: { Tester: { agent: 'claude', model: 'haiku', args: '--x' } } }),
    );
    seedWorkspace({ command: 'npm run dev', cwd: 'd:\\proj', role: 'Tester' });
    mount();
    expect(createdWith().initialCommand).toBe('npm run dev');
  });

  it('sets no role, and calls no IPC, for a seed that declares none', () => {
    seedWorkspace({ command: 'claude', cwd: 'd:\\proj' });
    mount();
    expect(setRole).not.toHaveBeenCalled();
    expect(createdWith().initialCommand).toBe('claude');
  });

  it('falls back to the paneRole mirror for a pane that already carried a role', () => {
    // The restored-pane case: no layout seed, but the daemon relayed a role.
    act(() =>
      useStore.setState({ orchestratorRoleBindings: { Reviewer: { agent: 'codex', model: 'o3' } } }),
    );
    seedWorkspace({ command: 'codex', cwd: 'd:\\proj' });
    act(() => useStore.setState({ paneRole: { [paneId]: 'Reviewer' } }));
    mount();
    expect(createdWith().initialCommand).toBe('codex --model o3');
    // Nothing to assign — the pane already has the role.
    expect(setRole).not.toHaveBeenCalled();
  });
});
