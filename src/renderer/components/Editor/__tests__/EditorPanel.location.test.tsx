// @vitest-environment jsdom
//
// EditorPanel reads files through the surface's SessionLocation — on mount AND
// on Reload. `fs.readFile` refuses a call without a location (issue #21: a
// path is only meaningful inside the domain that produced it), so a Reload
// that dropped the location returned "Unable to read file" on every platform.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import EditorPanel from '../EditorPanel';
import type { SessionLocation } from '../../../../shared/sessionLocation';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST: SessionLocation = { domain: 'host', cwd: 'C:\\dev\\fmux', shell: 'pwsh.exe' };

let container: HTMLDivElement;
let root: Root;
let readFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  readFile = vi.fn(async (_path: string, location?: SessionLocation) =>
    (location ? 'file body' : null));
  (window as unknown as { electronAPI: unknown }).electronAPI = { fs: { readFile } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(location: SessionLocation | undefined) {
  await act(async () => {
    root.render(createElement(EditorPanel, {
      filePath: 'C:\\dev\\fmux\\README.md',
      isActive: true,
      surfaceId: 'surf-1',
      location,
    }));
  });
}

function reloadButton(): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')]
    .find((b) => b.textContent === 'Reload');
  if (!el) throw new Error('Reload button not found');
  return el as HTMLButtonElement;
}

describe('EditorPanel — the file read carries the surface location', () => {
  it('passes the location on mount', async () => {
    await mount(HOST);
    expect(readFile).toHaveBeenCalledWith('C:\\dev\\fmux\\README.md', HOST);
    expect(container.textContent).toContain('file body');
  });

  it('passes the same location on Reload', async () => {
    await mount(HOST);
    readFile.mockClear();

    await act(async () => { reloadButton().click(); });

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('C:\\dev\\fmux\\README.md', HOST);
    expect(container.textContent).not.toContain('Unable to read file');
    expect(container.textContent).toContain('file body');
  });

  it('reads nothing at all when the surface has no location', async () => {
    await mount(undefined);
    expect(readFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Unable to read file');
  });
});
