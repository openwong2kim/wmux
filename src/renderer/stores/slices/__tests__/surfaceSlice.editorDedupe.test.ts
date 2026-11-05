import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../events/publisher', () => ({ publishPaneClosed: vi.fn() }));
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = { workspaces: Workspace[]; activeWorkspaceId: string };

function harness() {
  const active = createWorkspace('Active');
  const other = createWorkspace('Other');
  const state: TestState = { workspaces: [active, other], activeWorkspaceId: active.id };
  const set = (updater: (s: TestState) => void) => updater(state);
  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  const leaf = (ws: Workspace) => {
    if (ws.rootPane.type !== 'leaf') throw new Error('expected leaf');
    return ws.rootPane;
  };
  return { state, slice, leaf, active, other };
}

describe('surfaceSlice.addEditorSurface', () => {
  it('reuses one tab for spellings of the same Windows file', () => {
    const { slice, leaf, active } = harness();
    const paneId = leaf(active).id;
    slice.addEditorSurface(paneId, '\\\\wsl.localhost\\Ubuntu\\tmp\\x.md');
    slice.addEditorSurface(paneId, '//wsl$/Ubuntu/tmp/x.md');
    slice.addEditorSurface(paneId, 'c:/Users/me/a.md');
    slice.addEditorSurface(paneId, 'C:\\Users\\me\\a.md');
    const editors = leaf(active).surfaces.filter((s) => s.surfaceType === 'editor');
    expect(editors).toHaveLength(2);
    expect(editors[0].editorFilePath).toBe('\\\\wsl$\\Ubuntu\\tmp\\x.md');
    expect(editors[1].editorFilePath).toBe('C:\\Users\\me\\a.md');
  });

  it('keeps distinct POSIX paths distinct and activates the existing tab on repeat', () => {
    const { slice, leaf, active } = harness();
    const paneId = leaf(active).id;
    slice.addEditorSurface(paneId, '/tmp/a.md');
    slice.addEditorSurface(paneId, '/tmp/A.md');
    slice.addEditorSurface(paneId, '/tmp/a.md');
    const pane = leaf(active);
    expect(pane.surfaces).toHaveLength(2);
    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
  });

  it('records the line, and updates it when the tab is reused', () => {
    const { slice, leaf, active } = harness();
    const paneId = leaf(active).id;
    slice.addEditorSurface(paneId, '/tmp/a.md', { line: 12 });
    expect(leaf(active).surfaces[0].editorLine).toBe(12);
    slice.addEditorSurface(paneId, '/tmp/a.md', { line: 30 });
    expect(leaf(active).surfaces).toHaveLength(1);
    expect(leaf(active).surfaces[0].editorLine).toBe(30);
    slice.addEditorSurface(paneId, '/tmp/b.md', { line: 0 });
    expect(leaf(active).surfaces[1].editorLine).toBeUndefined();
  });

  it('bumps editorLineSeq on every re-target, even to the same line', () => {
    const { slice, leaf, active } = harness();
    const paneId = leaf(active).id;
    slice.addEditorSurface(paneId, '/tmp/a.md', { line: 5 });
    expect(leaf(active).surfaces[0].editorLineSeq).toBeUndefined();
    slice.addEditorSurface(paneId, '/tmp/a.md', { line: 5 });
    expect(leaf(active).surfaces[0].editorLineSeq).toBe(1);
    slice.addEditorSurface(paneId, '/tmp/a.md');
    expect(leaf(active).surfaces[0].editorLineSeq).toBe(1);
  });

  it('opens in the named workspace, not the active one', () => {
    const { slice, leaf, active, other } = harness();
    slice.addEditorSurface(leaf(other).id, '/tmp/a.md', { workspaceId: other.id });
    expect(leaf(other).surfaces).toHaveLength(1);
    expect(leaf(active).surfaces).toHaveLength(0);
  });

  it('refuses a shadow workspace', () => {
    const { slice, leaf, active } = harness();
    slice.addEditorSurface(leaf(active).id, '/tmp/a.md', { workspaceId: 'shadow:host:ws' });
    expect(leaf(active).surfaces).toHaveLength(0);
  });
});
