// @vitest-environment jsdom
//
// The protected-pane consent prompt: names the action, the site and the pane;
// answers Allow once / Always on this pane / Deny; "Always" is the only answer
// that carries remember.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { APPROVAL_ACTIVATION_DELAY_MS } from '../useActivationGuard';
import PermissionApprovalDialogContainer from '../PermissionApprovalDialogContainer';
import { selectApprovalInbox } from '../../../stores/selectors/approvalInbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const resolveMock = vi.fn();

const PROMPT = {
  promptId: 'p1',
  clientName: 'api',
  declaredCapabilities: [],
  kind: 'browser-action' as const,
  title: 'An agent wants to download a file from a.test',
  browserAction: { workspaceId: 'ws-1', paneId: 'pane-1', action: 'download' as const, host: 'a.test' },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { electronAPI: unknown }).electronAPI = { permissionPrompt: { resolve: resolveMock } };
  resolveMock.mockReset();
  act(() => useStore.setState({ mcpPrompts: { p1: PROMPT }, mcpPromptOrder: ['p1'] } as never));
  act(() => root.render(createElement(PermissionApprovalDialogContainer)));
  vi.setSystemTime(Date.now() + APPROVAL_ACTIVATION_DELAY_MS + 50);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ mcpPrompts: {}, mcpPromptOrder: [] } as never));
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});

const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

describe('browser-action prompt', () => {
  it('names the action and the site, with three answers', () => {
    expect(container.textContent).toContain('Download a file from a.test?');
    expect(button('Allow once')).toBeTruthy();
    expect(button('Always on this pane')).toBeTruthy();
    expect(button('Deny')).toBeTruthy();
    expect(button('Approve')).toBeUndefined();
  });

  it('Allow once resolves exactly as any prompt does (no remember)', () => {
    act(() => button('Allow once')!.click());
    expect(resolveMock).toHaveBeenCalledWith('p1', true);
    expect(resolveMock.mock.calls[0]).toHaveLength(2);
  });

  it('Always on this pane carries remember', () => {
    act(() => button('Always on this pane')!.click());
    expect(resolveMock).toHaveBeenCalledWith('p1', true, { remember: true });
  });

  it('a multi-line script opens to its whole text before approving', () => {
    const script = `${'x'.repeat(200)}\nreturn document.title;`;
    act(() => useStore.setState({
      mcpPrompts: { p1: { ...PROMPT, browserAction: { ...PROMPT.browserAction, action: 'evaluate' as never, detail: script } } },
      mcpPromptOrder: ['p1'],
    } as never));
    const details = container.querySelector('[data-browser-action-script]');
    expect(details).not.toBeNull();
    expect(details?.querySelector('pre')?.textContent).toBe(script);
    expect(details?.querySelector('summary')?.textContent).toContain('Show the whole script');
  });

  it('is critical in the inbox, so a stray Enter cannot approve it', () => {
    const items = selectApprovalInbox(useStore.getState() as never);
    expect(items[0]).toMatchObject({ source: 'mcp', kind: 'browser-action', isCritical: true, browserAction: PROMPT.browserAction });
  });
});
