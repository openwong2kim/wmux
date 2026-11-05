// @vitest-environment jsdom
//
// The work area's tab strip: browser / editor / diff tabs beside the terminal
// strip, with the expand toggle (#2140) that hides the terminal column.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkTabs, { workTabTitle } from '../WorkTabs';
import { useStore } from '../../../stores';
import type { Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const surfaces = [
  { id: 'b1', ptyId: '', title: 'Example Domain', shell: '', cwd: '', surfaceType: 'browser', browserUrl: 'https://example.com' },
  { id: 'e1', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'editor', editorFilePath: '/repo/src/app.tsx' },
] as Surface[];

function render(props: Partial<React.ComponentProps<typeof WorkTabs>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const merged = {
    surfaces,
    shownId: 'b1',
    paneActive: true,
    focused: true,
    expanded: false,
    readOnly: false,
    tailGap: 0,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onToggleExpanded: vi.fn(),
    workspaceId: 'ws-1',
    paneId: 'pane-1',
    ...props,
  };
  act(() => { root.render(React.createElement(WorkTabs, merged)); });
  return merged;
}

const expandButton = () => document.querySelector<HTMLButtonElement>('[data-work-expand]');

beforeEach(() => {
  act(() => { useStore.setState({ locale: 'en' }); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
});

describe('WorkTabs', () => {
  it('names an untitled editor tab by its file, and marks the shown tab', () => {
    render();
    const tabs = [...document.querySelectorAll('[data-work-tab-id]')];
    expect(tabs.map((t) => t.textContent?.replace('✕', '').trim())).toEqual(['Example Domain', 'app.tsx']);
    expect(document.querySelector('[data-work-tab-id="b1"]')?.getAttribute('data-active')).toBe('true');
    expect(document.querySelector('[data-work-tab-id="e1"]')?.getAttribute('data-active')).toBeNull();
  });

  it('takes the accent only while the pane focus is on a work tab', () => {
    render({ focused: false });
    expect(document.querySelector('[data-work-tabs]')?.getAttribute('data-pane-focused')).toBeNull();
  });

  it('the expand toggle says which way it goes', () => {
    const props = render();
    expect(expandButton()?.getAttribute('aria-label')).toBe('Expand');
    expect(expandButton()?.getAttribute('aria-pressed')).toBe('false');
    act(() => { expandButton()?.click(); });
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);

    act(() => { root.unmount(); });
    container.remove();
    render({ expanded: true });
    expect(expandButton()?.getAttribute('aria-label')).toBe('Show terminal');
    expect(expandButton()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a read-only pane gets no close or expand buttons', () => {
    render({ readOnly: true });
    expect(expandButton()).toBeNull();
    expect(document.querySelector('[data-work-tab-close]')).toBeNull();
  });

  it('double-click renames a work tab through the store', () => {
    const renameSurface = vi.fn();
    act(() => { useStore.setState({ renameSurface } as never); });
    render();
    const tab = document.querySelector<HTMLElement>('[data-work-tab-id="e1"]')!;
    act(() => { tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const input = document.querySelector<HTMLInputElement>('[data-work-tab-rename]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'config');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(renameSurface).toHaveBeenCalledWith('e1', 'config');
  });

  it('workTabTitle falls back to the browser label', () => {
    expect(workTabTitle({ title: '', surfaceType: 'browser' }, 'Browser')).toBe('Browser');
    expect(workTabTitle({ title: '', surfaceType: 'editor', editorFilePath: 'C:\\repo\\a.ts' }, 'Browser')).toBe('a.ts');
    expect(workTabTitle({ title: '', surfaceType: 'preview', previewFilePath: '/repo/out/plot.png' }, 'Browser')).toBe('plot.png');
  });
});
