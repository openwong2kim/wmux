// @vitest-environment jsdom
//
// EditorPanel reports unsaved Edit-mode text to the dirtyEditors registry that
// the close-tab confirm reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import EditorPanel from '../EditorPanel';
import { isEditorDirty } from '../dirtyEditors';

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
});
