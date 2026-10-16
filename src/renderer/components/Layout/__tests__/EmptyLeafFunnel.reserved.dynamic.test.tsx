// @vitest-environment jsdom
//
// #2231 (Windows run 4) — a fan-out spawn adds its workspace (one empty leaf,
// active) and then awaits its worker's pty.create. The funnel must not start
// a plain shell in that leaf meanwhile: with WSL as the default shell that
// shell could land first and stay beside the worker as a stray home pane.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyLeafFunnel } from '../EmptyLeafFunnel';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import { isLeafReserved, reserveLeaf } from '../../../utils/reservedLeaves';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;

function emptyWorkspace(): string {
  const ws = createWorkspace('task');
  if (ws.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  ws.rootPane.surfaces = [];
  act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, paneGate: 'ready', projectPaneSeed: {} }));
  return ws.rootPane.id;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  create = vi.fn().mockReturnValue(new Promise(() => undefined));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn() } };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('EmptyLeafFunnel and a reserved leaf', () => {
  it('starts no shell in a leaf a spawn reserved', () => {
    const paneId = emptyWorkspace();
    const release = reserveLeaf(paneId);
    act(() => root.render(createElement(EmptyLeafFunnel)));
    expect(create).not.toHaveBeenCalled();
    // The spawn failed and could not remove the workspace: on release the
    // still-empty leaf gets its shell.
    act(() => release());
    expect(isLeafReserved(paneId)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('an unreserved empty leaf still gets its shell', () => {
    emptyWorkspace();
    act(() => root.render(createElement(EmptyLeafFunnel)));
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('where the spawns reserve the leaf (source shape)', () => {
  it('right before the awaited pty.create, released after any rollback', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // A Windows checkout has CRLF line ends.
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/hooks/useRpcBridge.ts'), 'utf8').replace(/\r\n/g, '\n');
    const at = [...src.matchAll(/const releaseLeaf = reserveLeaf\(paneId\);\n\s+let ptyId: string;\n\s+try \{\n\s+const created = await window\.electronAPI\.pty\.create\(/g)];
    expect(at).toHaveLength(2);
    // Every rollback releases after the workspace is gone.
    expect(src).not.toMatch(/releaseLeaf\(\);\s*(?:\/\/[^\n]*\n\s*)*(?:const rollback|try \{ await window\.electronAPI\.pty\.dispose)/);
  });
});
