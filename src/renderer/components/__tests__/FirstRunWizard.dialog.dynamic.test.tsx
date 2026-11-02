// @vitest-environment jsdom
//
// The welcome dialog end to end on the Dialog primitive: it is a labelled
// modal, focus starts on its close button, Escape dismisses through the
// firstRun bridge, exactly one action is drawn as the primary, and Open a
// folder is where a ready first run ends.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FirstRunWizard from '../FirstRunWizard';
import { useStore } from '../../stores';
import { resetAgentSetupForTests } from '../../utils/agentSetupRuns';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let hooksInstall: ReturnType<typeof vi.fn>;
let pickFolder: ReturnType<typeof vi.fn>;

const checkResult = (mcpRegistered: boolean) => ({
  shown: false,
  status: { claudeFound: true, mcpRegistered, claudeJsonPath: '/tmp/.claude.json' },
});

const claudeReady = {
  agent: 'claude', readiness: 'ready', executable: '/home/u/.local/bin/claude', version: '9.9.9',
  updateRecommended: false, loginKnown: true, candidates: [],
};

function installBridge({ mcpRegistered, hooksInstalled }: { mcpRegistered: boolean; hooksInstalled: boolean }) {
  hooksInstall = vi.fn();
  pickFolder = vi.fn().mockResolvedValue([]);
  bridge = {
    check: vi.fn().mockResolvedValue(checkResult(mcpRegistered)),
    reopen: vi.fn().mockResolvedValue(checkResult(mcpRegistered)),
    complete: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    registerMcp: vi.fn(),
    agentStatus: vi.fn().mockResolvedValue([claudeReady]),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun: bridge,
    dialog: { pickFolder },
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
  // Let the check(), agentStatus() and hooks status() promises settle.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  return onClose;
}

beforeEach(() => {
  resetAgentSetupForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentSetupForTests();
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

  it('ready: Open a folder is the single primary, and nothing else is offered', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-open-folder']);
    // One short screen: no sample task, no bot task, no statusline offer.
    expect(byId('first-run-wizard-try')).toBeNull();
    expect(byId('first-run-first-task')).toBeNull();
    expect(byId('first-run-wizard-statusline-offer')).toBeNull();
  });

  it('hooks missing: installing hooks is the single primary, Open a folder steps back', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: false });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-hooks-install']);
    expect(byId('first-run-wizard-open-folder').className).toContain('ui-btn-secondary');
  });

  it('MCP unregistered: Register is the single primary', async () => {
    installBridge({ mcpRegistered: false, hooksInstalled: false });
    await mount();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-register']);
  });

  it('reopen mode with MCP unregistered: Register is the primary, and the footer closes', async () => {
    installBridge({ mcpRegistered: false, hooksInstalled: true });
    await mount(vi.fn(), 'reopen');
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-register']);
    expect(byId('first-run-wizard-skip').textContent).toBe('Close');
    // Nothing claims an earlier first run was completed.
    expect(container.textContent).not.toMatch(/completed/i);
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
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-wizard-open-folder']);
  });

  it('while hooks install, the primary does not jump to Open a folder', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: false });
    hooksInstall.mockReturnValue(new Promise(() => undefined));
    await mount();
    await act(async () => byId('first-run-wizard-hooks-install').click());
    expect(byId('first-run-wizard-hooks-install').disabled).toBe(true);
    expect(primaries()).toEqual([]);
  });

  it('Open a folder opens a workspace on it, completes the first run and closes', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    pickFolder.mockResolvedValue(['/home/u/code/my-app']);
    const before = useStore.getState().workspaces.length;
    const onClose = await mount();
    await act(async () => byId('first-run-wizard-open-folder').click());
    await settle();
    const ws = useStore.getState().workspaces;
    expect(ws).toHaveLength(before + 1);
    expect(ws[ws.length - 1].name).toBe('my-app');
    expect(ws[ws.length - 1].profile?.startupCwd).toBe('/home/u/code/my-app');
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(bridge.complete).toHaveBeenCalledTimes(1);
    expect(bridge.dismiss).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelling the folder picker keeps the wizard open and records nothing', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    const onClose = await mount();
    await act(async () => byId('first-run-wizard-open-folder').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.complete).not.toHaveBeenCalled();
    expect(bridge.dismiss).not.toHaveBeenCalled();
  });

  it('Skip for now is a dismiss, not a completion', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    const onClose = await mount();
    expect(byId('first-run-wizard-skip').textContent).toBe('Skip for now');
    await act(async () => byId('first-run-wizard-skip').click());
    await settle();
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);
    expect(bridge.complete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FirstRunWizard auto-update row', () => {
  it('asks the update question as one switch row, on by default, writing the setting on change', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    const setAutoUpdateEnabled = vi.fn();
    (window as unknown as { electronAPI: { settings: unknown } }).electronAPI.settings = { setAutoUpdateEnabled };
    useStore.getState().setAutoUpdateEnabled(true);
    await mount();
    const sw = byId('first-run-wizard-auto-update-switch');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    expect(useStore.getState().autoUpdateEnabled).toBe(false);
    expect(setAutoUpdateEnabled).toHaveBeenCalledWith(false);
    expect(byId('first-run-wizard-auto-update-switch').getAttribute('aria-checked')).toBe('false');
    useStore.getState().setAutoUpdateEnabled(true);
  });

  it('is left to Settings when the wizard is reopened', async () => {
    installBridge({ mcpRegistered: true, hooksInstalled: true });
    await mount(vi.fn(), 'reopen');
    expect(byId('first-run-wizard-auto-update')).toBeNull();
  });
});
