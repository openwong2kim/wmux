// @vitest-environment jsdom
//
// EditorPanel reports unsaved Edit-mode text to the dirtyEditors registry that
// the close-tab confirm reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import EditorPanel from '../EditorPanel';
import { isEditorDirty } from '../dirtyEditors';
import { useStore } from '../../../stores';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).electronAPI;
});

async function open(text: string): Promise<void> {
  (window as any).electronAPI = { fs: { readFile: vi.fn().mockResolvedValue(text) } };
  await act(async () => {
    root.render(createElement(EditorPanel, { filePath: '/p/notes.txt', isActive: true, surfaceId: 's1' }));
  });
}

async function enterEditMode(): Promise<HTMLTextAreaElement> {
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => {
    tabs[1].click();
  });
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('EditorPanel dirty reporting', () => {
  it('is clean after opening and entering Edit mode', async () => {
    await open('hello');
    await enterEditMode();
    expect(isEditorDirty('s1')).toBe(false);
  });

  it('reports dirty once the Edit buffer differs from the file', async () => {
    await open('hello');
    const ta = await enterEditMode();
    await type(ta, 'hello world');
    expect(isEditorDirty('s1')).toBe(true);
  });

  it('clears when the typed text is reverted to the file content', async () => {
    await open('hello');
    const ta = await enterEditMode();
    await type(ta, 'hello world');
    await type(ta, 'hello');
    expect(isEditorDirty('s1')).toBe(false);
  });

  it('clears when the panel unmounts with unsaved text', async () => {
    await open('hello');
    const ta = await enterEditMode();
    await type(ta, 'changed');
    expect(isEditorDirty('s1')).toBe(true);
    act(() => root.render(null));
    expect(isEditorDirty('s1')).toBe(false);
  });

  it('keeps the scratch text across Edit -> View -> Edit and shows it in View', async () => {
    await open('hello');
    const ta = await enterEditMode();
    await type(ta, 'hello world');
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await act(async () => {
      tabs[0].click();
    });
    expect(container.querySelector('pre')?.textContent).toBe('hello world');
    expect(isEditorDirty('s1')).toBe(true);
    expect(container.querySelector('[data-testid="editor-scratch-chip"]')).not.toBeNull();
    const again = await enterEditMode();
    expect(again.value).toBe('hello world');
  });

  it('asks before Reload drops scratch edits; Keep editing keeps them', async () => {
    await open('hello');
    const ta = await enterEditMode();
    await type(ta, 'changed');
    const api = (window as any).electronAPI.fs.readFile as ReturnType<typeof vi.fn>;
    api.mockClear();
    const reload = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!;
    await act(async () => {
      reload().click();
    });
    expect(api).not.toHaveBeenCalled();
    const keep = document.querySelector<HTMLButtonElement>('[data-editor-keep-editing]')!;
    await act(async () => {
      keep.click();
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('changed');
    await act(async () => {
      reload().click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-editor-discard]')!.click();
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello');
    expect(isEditorDirty('s1')).toBe(false);
  });

  it('keeps the scratch text when the panel remounts while its tab stays open', async () => {
    const prev = useStore.getState().workspaces;
    useStore.setState({
      workspaces: [{ id: 'w1', rootPane: { type: 'leaf', id: 'p1', surfaces: [{ id: 's1' }] } }] as any,
    });
    try {
      await open('hello');
      const ta = await enterEditMode();
      await type(ta, 'kept');
      act(() => root.render(null));
      expect(isEditorDirty('s1')).toBe(true);
      await open('hello');
      expect(isEditorDirty('s1')).toBe(true);
      expect((await enterEditMode()).value).toBe('kept');
    } finally {
      useStore.setState({ workspaces: prev });
    }
  });

  it('keeps the scratch text when its pane is stashed out of the layout', async () => {
    const prev = useStore.getState().workspaces;
    useStore.setState({
      workspaces: [{ id: 'w1', rootPane: { type: 'leaf', id: 'p0', surfaces: [] },
        stashedPanes: [{ pane: { type: 'leaf', id: 'p1', surfaces: [{ id: 's1' }] } }] }] as any,
    });
    try {
      await open('hello');
      await type(await enterEditMode(), 'stashed');
      act(() => root.render(null));
      await open('hello');
      expect((await enterEditMode()).value).toBe('stashed');
    } finally {
      useStore.setState({ workspaces: prev });
    }
  });

  it('keeps parked scratch through an unmount before the read lands, and a stale read does not take it', async () => {
    const prev = useStore.getState().workspaces;
    useStore.setState({
      workspaces: [{ id: 'w1', rootPane: { type: 'leaf', id: 'p1', surfaces: [{ id: 's1' }] } }] as any,
    });
    try {
      await open('hello');
      await type(await enterEditMode(), 'parked');
      act(() => root.render(null));
      // Remount whose read is still pending, then unmount before it lands.
      let land!: (v: string) => void;
      (window as any).electronAPI = { fs: { readFile: vi.fn(() => new Promise<string>((r) => { land = r; })) } };
      await act(async () => {
        root.render(createElement(EditorPanel, { filePath: '/p/notes.txt', isActive: true, surfaceId: 's1' }));
      });
      act(() => root.render(null));
      await act(async () => land('hello'));
      expect(isEditorDirty('s1')).toBe(true);
      await open('hello');
      expect((await enterEditMode()).value).toBe('parked');
    } finally {
      useStore.setState({ workspaces: prev });
    }
  });

  it('reports dirty after a Reload that succeeds where the first read failed', async () => {
    const readFile = vi.fn().mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue('hello');
    (window as any).electronAPI = { fs: { readFile } };
    await act(async () => {
      root.render(createElement(EditorPanel, { filePath: '/p/notes.txt', isActive: true, surfaceId: 's1' }));
    });
    const reload = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!;
    await act(async () => reload.click());
    await type(await enterEditMode(), 'after reload');
    expect(isEditorDirty('s1')).toBe(true);
  });
});
