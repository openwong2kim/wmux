// @vitest-environment jsdom
//
// Settings → Claude integration → setup card: probes three integrations on
// mount, offers an install only for the ones that are actually missing, and
// never reports a success the install did not produce.

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  IntegrationSetupSection,
  IntegrationSetupSectionContainer,
  rowStateFromProbe,
  type IntegrationSetupApi,
} from '../IntegrationSetupSection';

function render(ui: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => { act(() => root.unmount()); container.remove(); },
  };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeApi(over: Partial<{
  hooksInstalled: boolean;
  statuslineInstalled: boolean;
  mcpVerified: boolean;
  hooksInstall: () => Promise<{ ok: boolean; error: string | null }>;
  statuslineInstall: () => Promise<{ ok: boolean; error: string | null; targets: Array<{ outcome: string }> }>;
  hooksStatusThrows: boolean;
}> = {}): IntegrationSetupApi {
  return {
    hooks: {
      status: async () => {
        if (over.hooksStatusThrows) throw new Error('ipc down');
        return { installed: over.hooksInstalled ?? false };
      },
      install: over.hooksInstall ?? (async () => ({ ok: true, error: null })),
    },
    statusline: {
      status: async () => ({ installed: over.statuslineInstalled ?? false }),
      install:
        over.statuslineInstall ??
        (async () => ({ ok: true, error: null, targets: [{ outcome: 'installed' }] })),
    },
    mcp: {
      check: async () => ({ targets: [{ displayName: 'Claude Code', verified: over.mcpVerified ?? false }] }),
      reregister: async () => ({ targets: [{ displayName: 'Claude Code', verified: true }] }),
    },
  };
}

const row = (c: HTMLElement, id: string) => c.querySelector(`[data-setup-row="${id}"]`) as HTMLElement;
const state = (c: HTMLElement, id: string) => row(c, id).getAttribute('data-setup-row-state');
const action = (c: HTMLElement, id: string) =>
  row(c, id).querySelector('[data-setup-row-action]') as HTMLButtonElement | null;

describe('IntegrationSetupSection', () => {
  it('reports each integration from its own probe', async () => {
    const { container, cleanup } = render(
      <IntegrationSetupSection api={fakeApi({ hooksInstalled: true, mcpVerified: true })} />,
    );
    cleanups.push(cleanup);
    await flush();

    expect(state(container, 'hooks')).toBe('installed');
    expect(state(container, 'mcp')).toBe('installed');
    expect(state(container, 'statusline')).toBe('missing');
    // No action offered for what is already there — the row is a receipt, not a
    // button that would rewrite a healthy config.
    expect(action(container, 'hooks')).toBeNull();
    expect(action(container, 'statusline')).not.toBeNull();
  });

  it('installs the missing one and flips its row', async () => {
    const { container, cleanup } = render(<IntegrationSetupSection api={fakeApi()} />);
    cleanups.push(cleanup);
    await flush();
    expect(state(container, 'hooks')).toBe('missing');

    await act(async () => { action(container, 'hooks')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks')).toBe('installed');
  });

  // `ok: true` with every target skipped means another tool owns those
  // settings files and nothing was written. Reporting "installed" there is a
  // receipt for something that did not happen.
  it('does not claim success when no target took the statusline install', async () => {
    const api = fakeApi({
      statuslineInstall: async () => ({ ok: true, error: null, targets: [{ outcome: 'skipped' }] }),
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'statusline')).toBe('error');
  });

  it('surfaces an install error with its detail', async () => {
    const api = fakeApi({ hooksInstall: async () => ({ ok: false, error: 'EACCES' }) });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'hooks')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks')).toBe('error');
    expect(row(container, 'hooks').querySelector('[data-setup-row-error]')!.textContent).toContain('EACCES');
  });

  // A probe that throws must not read as "not installed": the install button
  // would write to a config the user never asked us to touch.
  it('stays unknown (and offers nothing) when the probe fails', async () => {
    const { container, cleanup } = render(
      <IntegrationSetupSection api={fakeApi({ hooksStatusThrows: true })} />,
    );
    cleanups.push(cleanup);
    await flush();

    expect(state(container, 'hooks')).toBe('unknown');
    expect(action(container, 'hooks')).toBeNull();
  });

  it('maps a probe answer to a row state', () => {
    expect(rowStateFromProbe(true)).toBe('installed');
    expect(rowStateFromProbe(false)).toBe('missing');
  });

  it('renders nothing when a preload bridge is missing', () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = { deck: {} };
    const { container, cleanup } = render(<IntegrationSetupSectionContainer />);
    cleanups.push(cleanup);
    expect(container.querySelector('[data-integration-setup]')).toBeNull();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
});
