// @vitest-environment jsdom
//
// The welcome dialog end to end on the Dialog primitive: it is a labelled
// modal, focus starts on its close button, Escape dismisses through the
// firstRun bridge, and exactly one action is drawn as the primary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FirstRunWizard from '../FirstRunWizard';
import { useStore } from '../../stores';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let hooksInstall: ReturnType<typeof vi.fn>;

const checkResult = (mcpRegistered: boolean) => ({
  shown: false,
  status: { claudeFound: true, mcpRegistered, claudeJsonPath: '/tmp/.claude.json' },
});

function installBridge({ mcpRegistered, hooksInstalled }: { mcpRegistered: boolean; hooksInstalled: boolean }) {
  hooksInstall = vi.fn();
  bridge = {
    check: vi.fn().mockResolvedValue(checkResult(mcpRegistered)),
    reopen: vi.fn().mockResolvedValue(checkResult(mcpRegistered)),
    complete: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    registerMcp: vi.fn(),
    startSampleTask: vi.fn(),
    onSampleTaskReady: vi.fn(() => () => undefined),
    onSampleTaskTimeout: vi.fn(() => () => undefined),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun: bridge,
    deck: {
      hooksBridge: {
        status: vi.fn().mockResolvedValue({ installed: hooksInstalled }),
        install: hooksInstall,
      },
    },
  };
}

async function mount(onClose = vi.fn(), mode: 'firstRun' | 'reopen' = 'firstRun') {
  await act(async () => {
    root.render(createElement(FirstRunWizard, { mode, onClose }));
  });
  // Let the check() / hooks status() promises settle.
  await act(async () => {
    await Promise.resolve();
  });
  return onClose;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const primaries = () => Array.from(container.querySelectorAll('.ui-btn-primary')) as HTMLButtonElement[];

describe('FirstRunWizard dialog', () => {
  it('is a labelled modal and focuses the close button', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    await mount();
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Welcome to wmux');
    expect(document.activeElement).toBe(container.querySelector('[data-testid="first-run-wizard-close"]'));
  });

  it('Escape dismisses through the bridge', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    const onClose = await mount();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ready: the sample task is the single primary', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-try']);
  });

  it('hooks missing: installing hooks is the single primary, the sample task steps back', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: false });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-hooks-install']);
  });

  it('MCP unregistered: Register is the single primary', async () => {
    installBridge({ mcpRegistered: false, hooksInstalled: false });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-register']);
  });

  it('reopen mode with MCP unregistered: Register is the primary, the disabled Try is not', async () => {
    installBridge({ mcpRegistered: false, hooksInstalled: true });
    await mount(vi.fn(), 'reopen');
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-register']);
    expect(byId('first-run-wizard-try').disabled).toBe(true);
  });

  it('while registering, nothing is primary; afterwards focus stays in the dialog', async () => {
    installBridge({ mcpRegistered: false, hooksInstalled: true });
    let finish: (v: unknown) => void = () => undefined;
    bridge.registerMcp.mockReturnValue(new Promise((r) => { finish = r; }));
    await mount();
    const register = byId('first-run-wizard-register');
    register.focus();
    await act(async () => register.click());
    expect(byId('first-run-wizard-register').disabled).toBe(true);
    expect(primaries()).toEqual([]);

    // Registration succeeds; the refreshed check removes the focused button.
    bridge.check.mockResolvedValue(checkResult(true));
    await act(async () => { finish({ ok: true }); });
    await settle();
    expect(byId('first-run-wizard-register')).toBeNull();
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-try']);
  });

  it('while hooks install, the primary does not jump to Try sample task', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: false });
    hooksInstall.mockReturnValue(new Promise(() => undefined));
    await mount();
    await act(async () => byId('first-run-wizard-hooks-install').click());
    expect(byId('first-run-wizard-hooks-install').disabled).toBe(true);
    expect(primaries()).toEqual([]);
  });

  it('timeout fallback: Continue is the single primary', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    let onTimeout: () => void = () => undefined;
    bridge.onSampleTaskTimeout.mockImplementation((cb: () => void) => { onTimeout = cb; return () => undefined; });
    bridge.startSampleTask.mockResolvedValue(undefined);
    // A workspace whose top-left pane already has a pty, so the task starts at once.
    act(() => {
      useStore.setState({
        activeWorkspaceId: 'w1',
        workspaces: [{
          id: 'w1',
          rootPane: { id: 'l1', type: 'leaf', surfaces: [{ id: 's1', ptyId: 'p1' }], activeSurfaceId: 's1' },
        }],
        applyLayoutTemplate: () => undefined,
      } as never);
    });
    await mount();
    await act(async () => byId('first-run-wizard-try').click());
    await settle();
    expect(bridge.startSampleTask).toHaveBeenCalledWith({ ptyId: 'p1' });
    await act(async () => onTimeout());
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-fallback-continue']);
  });
});
