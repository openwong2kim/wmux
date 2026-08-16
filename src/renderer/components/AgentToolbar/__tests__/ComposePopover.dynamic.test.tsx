// @vitest-environment jsdom
//
// Compose is the only typed send surface. Target switch writes to one pty vs
// every workspace terminal; All N requires a 4s in-popover arm; snippets
// insert into the draft and never send.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const injectText = vi.fn<(ptyId: string, text: string, submit: boolean) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock('../inject', () => ({
  injectText: (ptyId: string, text: string, submit: boolean) => injectText(ptyId, text, submit),
  attachFilesToPty: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import ComposeHost from '../ComposeHost';
import type { SessionData, Workspace } from '../../../../shared/types';

function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf-a',
      type: 'leaf',
      activeSurfaceId: 'sa1',
      surfaces: [
        { id: 'sa1', ptyId: 'pty-1', title: 'claude', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
        { id: 'sa2', ptyId: 'pty-2', title: 'shell', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  injectText.mockClear();
  injectText.mockImplementation(() => Promise.resolve());
  const data: SessionData = {
    workspaces: [seedWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => {
    useStore.getState().loadSession(data);
    useStore.setState({
      toolbarPopover: null,
      composeContext: null,
      composeTarget: 'pane',
      richDraftByPane: {},
      toolbarSnippets: [],
    });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => {
    useStore.getState().openCompose({ paneId: 'leaf-a', ptyId: 'pty-1' });
    root.render(createElement(ComposeHost));
  });
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

const type = (value: string): void => {
  const ta = q('[data-testid="compose-input"]') as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ComposePopover', () => {
  it('opens from the store and defaults the target to This pane', () => {
    mount();
    expect(q('[data-testid="compose-popover"]')).not.toBeNull();
    expect(q('[data-testid="compose-target-pane"]')?.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="compose-add-to-prompt"]')).not.toBeNull();
  });

  it('This pane Send injects only the focused pty and submits', async () => {
    mount();
    type('hello pane');
    act(() => {
      q('[data-testid="compose-send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(injectText).toHaveBeenCalledTimes(1);
    expect(injectText).toHaveBeenCalledWith('pty-1', 'hello pane', true);
    expect(q('[data-testid="compose-popover"]')).toBeNull();
  });

  it('Add to prompt injects without submitting', async () => {
    mount();
    type('draft');
    act(() => {
      q('[data-testid="compose-add-to-prompt"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(injectText).toHaveBeenCalledWith('pty-1', 'draft', false);
  });

  it('All N first click arms and does not send; second click writes every terminal', async () => {
    mount();
    type('hello fleet');
    act(() => {
      q('[data-testid="compose-target-all"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q('[data-testid="compose-add-to-prompt"]')).toBeNull();
    act(() => {
      q('[data-testid="compose-send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(injectText).not.toHaveBeenCalled();
    act(() => {
      q('[data-testid="compose-send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const ptyIds = injectText.mock.calls.map((c) => c[0]).sort();
    expect(ptyIds).toEqual(['pty-1', 'pty-2']);
    for (const call of injectText.mock.calls) {
      expect(call[1]).toBe('hello fleet');
      expect(call[2]).toBe(true);
    }
  });

  it('snippets insert into the draft and never send', () => {
    act(() => {
      useStore.getState().addSnippet('Fix', 'please fix this');
    });
    mount();
    act(() => {
      const chip = q('[data-testid="compose-snippets"] button');
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(injectText).not.toHaveBeenCalled();
    expect(useStore.getState().richDraftByPane['pty-1']).toBe('please fix this');
  });
});
