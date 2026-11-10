// @vitest-environment jsdom
//
// "Continue on <account>" for a token account: a new pane beside the source
// one, created by the real funnel with the account named on the create, and
// the source pane left as it was.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyLeafFunnel } from '../../Layout/EmptyLeafFunnel';
import { openContinuePane } from '../usePaneContinueOnAccount';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import { getWorkspaceLeafPanes } from '../../../../shared/paneUtils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
let container: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  create = vi.fn().mockReturnValue(new Promise(() => undefined));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn() }, metadata: {} };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState({ workspaces: [], projectPaneSeed: {}, splitCwdSeed: {} }));
});

describe('continue on a token account in a new pane', () => {
  it('splits the source pane and creates the new one on the account, resuming the conversation in its folder', () => {
    const ws = createWorkspace('work');
    const leaf = ws.rootPane;
    if (leaf.type !== 'leaf') throw new Error('fixture expects a leaf root');
    leaf.surfaces = [{ id: 'surf-1', ptyId: 'pty-src', title: 'zsh', shell: 'zsh', cwd: '/elsewhere' } as never];
    leaf.activeSurfaceId = 'surf-1';
    act(() => useStore.setState({
      workspaces: [ws], activeWorkspaceId: ws.id, paneGate: 'ready', projectPaneSeed: {}, splitCwdSeed: {}, splitInheritsCwd: true,
    }));

    const command = `claude --resume ${SID}`;
    let opened = false;
    act(() => { opened = openContinuePane('pty-src', { accountId: 'acc-token', command, cwd: '/work/repo' }); });
    expect(opened).toBe(true);
    act(() => root.render(createElement(EmptyLeafFunnel)));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ workspaceId: ws.id, cwd: '/work/repo', initialCommand: command, accountId: 'acc-token' });
    const leaves = getWorkspaceLeafPanes(useStore.getState().workspaces[0]);
    expect(leaves).toHaveLength(2);
    // The source pane keeps its surface, untouched.
    expect(leaves.find((l) => l.id === leaf.id)?.surfaces.map((s) => s.ptyId)).toEqual(['pty-src']);
  });

  it('opens nothing for a pane no workspace holds', () => {
    act(() => useStore.setState({ workspaces: [], projectPaneSeed: {}, splitCwdSeed: {} }));
    expect(openContinuePane('pty-gone', { accountId: 'acc-token', command: 'claude', cwd: '/w' })).toBe(false);
    expect(useStore.getState().projectPaneSeed).toEqual({});
  });
});
