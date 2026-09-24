// @vitest-environment jsdom
//
// The permission prompt in a real DOM: every declared permission stays
// reachable however long the list is, the prompt never takes focus from the
// terminal, and the next queued prompt starts fresh.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useStore } from '../../../stores';
import { APPROVAL_ACTIVATION_DELAY_MS } from '../useActivationGuard';
import { PermissionApprovalDialogView } from '../PermissionApprovalDialog';
import PermissionApprovalDialogContainer from '../PermissionApprovalDialogContainer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real stylesheet, so computed styles reflect the shipped rules.
const uiCss = document.createElement('style');
uiCss.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/styles/ui.css'), 'utf8');
document.head.appendChild(uiCss);

let container: HTMLDivElement;
let root: Root;
let terminal: HTMLTextAreaElement;

const MANY = [
  'terminal.read',
  'terminal.send',
  'pane.read',
  'pane.create',
  'pane.search',
  'meta.read',
  'meta.write',
  'meta.write:custom.a.*',
  'meta.write:custom.b.*',
  'meta.write:custom.c.*',
  'meta.read:custom.d.*',
  'events.subscribe',
  'workspace.read',
  'workspace.claim',
  'browser.navigate',
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  terminal = document.createElement('textarea');
  document.body.appendChild(terminal);
  terminal.focus();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  terminal.remove();
  act(() => useStore.setState({ mcpPrompts: {}, mcpPromptOrder: [] } as never));
  vi.useRealTimers();
});

describe('PermissionApprovalDialogView', () => {
  it('keeps every declared permission inside the scrolling body', () => {
    act(() =>
      root.render(
        createElement(PermissionApprovalDialogView, {
          clientName: 'demo',
          declaredCapabilities: MANY,
          onApprove: () => undefined,
          onDeny: () => undefined,
        }),
      ),
    );
    const body = container.querySelector('.ui-dialog-body') as HTMLElement;
    expect(getComputedStyle(body).overflowY).toBe('auto');
    const group = body.querySelector('[data-permission-groups]') as HTMLElement;
    expect(group.parentElement).toBe(body);
    // The group keeps its full height (it does not shrink to fit and clip its
    // lower rows behind overflow:hidden); the body scrolls instead.
    expect(getComputedStyle(group).flexShrink).toBe('0');
    const shown = Array.from(group.querySelectorAll('li')).map((li) => li.textContent);
    for (const cap of MANY) expect(shown).toContain(cap);
  });

  it('leaves focus in the terminal when it appears', () => {
    const onApprove = vi.fn();
    act(() =>
      root.render(
        createElement(PermissionApprovalDialogView, {
          clientName: 'demo',
          declaredCapabilities: ['terminal.read'],
          onApprove,
          onDeny: () => undefined,
        }),
      ),
    );
    expect(document.activeElement).toBe(terminal);
    const approve = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve')!;
    act(() => approve.click());
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('PermissionApprovalDialogContainer', () => {
  it('mounts the next queued prompt fresh, so focus from the last one cannot answer it', () => {
    const resolveMock = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = { permissionPrompt: { resolve: resolveMock } };
    const prompt = (id: string, clientName: string) => ({ promptId: id, clientName, declaredCapabilities: ['pane.read'] });
    act(() =>
      useStore.setState({
        mcpPrompts: { p1: prompt('p1', 'first'), p2: prompt('p2', 'second') },
        mcpPromptOrder: ['p1', 'p2'],
      } as never),
    );
    act(() => root.render(createElement(PermissionApprovalDialogContainer)));
    vi.setSystemTime(Date.now() + APPROVAL_ACTIVATION_DELAY_MS + 50);
    const approve = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve')!;
    const first = approve();
    first.focus();
    act(() => first.click());
    expect(resolveMock).toHaveBeenCalledWith('p2', true);

    // p1 is now the one shown; the button that had focus went with p2.
    expect(container.textContent).toContain('first');
    expect(container.contains(document.activeElement)).toBe(false);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
});
