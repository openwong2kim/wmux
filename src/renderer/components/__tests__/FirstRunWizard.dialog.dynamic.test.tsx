// @vitest-environment jsdom
//
// The welcome dialog end to end on the Dialog primitive: it is a labelled
// modal, focus starts on its close button, Escape dismisses through the
// firstRun bridge, and exactly one action is drawn as the primary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FirstRunWizard from '../FirstRunWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let bridge: Record<string, ReturnType<typeof vi.fn>>;

function installBridge({ mcpRegistered, hooksInstalled }: { mcpRegistered: boolean; hooksInstalled: boolean }) {
  bridge = {
    check: vi.fn().mockResolvedValue({
      shown: false,
      status: { claudeFound: true, mcpRegistered, claudeJsonPath: '/tmp/.claude.json' },
    }),
    reopen: vi.fn(),
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
        install: vi.fn(),
      },
    },
  };
}

async function mount(onClose = vi.fn()) {
  await act(async () => {
    root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose }));
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
});
