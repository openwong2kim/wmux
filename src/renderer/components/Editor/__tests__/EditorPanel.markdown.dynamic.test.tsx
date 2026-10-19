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
