// @vitest-environment jsdom
//
// View mode draws .md files as markdown and every other file as raw text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import EditorPanel, { isMarkdownPath } from '../EditorPanel';

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

async function open(filePath: string, text: string): Promise<void> {
  (window as any).electronAPI = { fs: { readFile: vi.fn().mockResolvedValue(text) } };
  await act(async () => {
    root.render(createElement(EditorPanel, { filePath, isActive: true, surfaceId: 's1' }));
  });
}

describe('isMarkdownPath', () => {
  it('matches markdown extensions only', () => {
    expect(isMarkdownPath('/a/plan.md')).toBe(true);
    expect(isMarkdownPath('C:\\a\\README.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('/a/notes.txt')).toBe(false);
    expect(isMarkdownPath('/a/md')).toBe(false);
  });
});

describe('EditorPanel View mode', () => {
  it('renders a .md file as markdown', async () => {
    await open('/p/plan.md', '# Title\n\n- one\n- **two**\n');
    const md = container.querySelector('[data-testid="editor-markdown"]');
    expect(md).not.toBeNull();
    expect(md!.querySelector('[data-brain-md-heading]')?.textContent).toBe('Title');
    expect(md!.querySelector('strong')?.textContent).toBe('two');
    expect(md!.textContent).not.toContain('**');
  });

  it('keeps a non-markdown file as raw text', async () => {
    await open('/p/notes.txt', '# not a heading\n');
    expect(container.querySelector('[data-testid="editor-markdown"]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('# not a heading\n');
  });

  it('shows a markdown file too long to render whole as raw text, last line included', async () => {
    const text = Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join('\n\n');
    await open('/p/long.md', text);
    expect(container.querySelector('[data-testid="editor-markdown"]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('line 2001');
  });
});

describe('EditorPanel line target', () => {
  const text = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n');

  async function openAt(filePath: string, line: number, lineSeq?: number, isActive = true): Promise<void> {
    (window as any).electronAPI = { fs: { readFile: vi.fn().mockResolvedValue(text) } };
    await act(async () => {
      root.render(createElement(EditorPanel, { filePath, isActive, surfaceId: 's1', line, lineSeq }));
    });
  }
  const marked = () => container.querySelector('[data-editor-line-marked]');

  it('marks the requested line and keeps the file text intact', async () => {
    await openAt('/p/notes.txt', 42);
    expect(marked()?.getAttribute('data-editor-line')).toBe('42');
    expect(marked()?.textContent).toContain('row 42');
    expect(container.querySelector('pre')?.textContent).toBe(text);
  });

  it('shows a markdown file as source when a line is requested', async () => {
    await openAt('/p/notes.md', 3);
    expect(container.querySelector('[data-testid="editor-markdown"]')).toBeNull();
    expect(marked()?.getAttribute('data-editor-line')).toBe('3');
  });

  it('re-targets the open tab to another line, and to the same line again after a click', async () => {
    await openAt('/p/notes.txt', 10, 0);
    expect(marked()?.getAttribute('data-editor-line')).toBe('10');
    await openAt('/p/notes.txt', 30, 1);
    expect(marked()?.getAttribute('data-editor-line')).toBe('30');
    await act(async () => { container.querySelector<HTMLElement>('pre')!.click(); });
    expect(marked()).toBeNull();
    await openAt('/p/notes.txt', 30, 2);
    expect(marked()?.getAttribute('data-editor-line')).toBe('30');
  });

  it('drops the mark when the user leaves the tab', async () => {
    await openAt('/p/notes.txt', 7);
    expect(marked()).not.toBeNull();
    await openAt('/p/notes.txt', 7, undefined, false);
    expect(marked()).toBeNull();
  });
});
