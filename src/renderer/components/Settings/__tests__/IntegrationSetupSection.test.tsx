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
  mcpRegistered,
  skippedReason,
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
  hooksPluginOwned: boolean;
  statuslineInstalled: boolean;
  mcpRegistered: boolean;
  hooksInstall: () => Promise<{ ok: boolean; error: string | null }>;
  statuslineInstall: () => Promise<{ ok: boolean; error: string | null; targets: Array<{ outcome: string }> }>;
  hooksStatusThrows: boolean;
  omit: 'hooks' | 'statusline' | 'mcp';
}> = {}): IntegrationSetupApi {
  // Probes re-run after a successful install, so the fakes read live flags.
  const flags = {
    hooks: over.hooksInstalled ?? false,
    statusline: over.statuslineInstalled ?? false,
    mcp: over.mcpRegistered ?? false,
  };
  const api: IntegrationSetupApi = {
    hooks: {
      status: async () => {
        if (over.hooksStatusThrows) throw new Error('ipc down');
        return {
          installed: flags.hooks,
          outcome: { pluginAlsoInstalled: over.hooksPluginOwned ?? false },
        };
      },
      install: over.hooksInstall ?? (async () => { flags.hooks = true; return { ok: true, error: null }; }),
    },
    statusline: {
      status: async () => ({ installed: flags.statusline }),
      install:
        over.statuslineInstall ??
        (async () => { flags.statusline = true; return { ok: true, error: null, targets: [{ outcome: 'installed' }] }; }),
    },
    mcp: {
      check: async () => ({ targets: [{ displayName: 'Claude Code', wmux: { registered: flags.mcp } }] }),
      reregister: async () => { flags.mcp = true; return { targets: [{ displayName: 'Claude Code', wmux: { registered: true } }] }; },
    },
  };
  if (over.omit) delete api[over.omit];
  return api;
}

const row = (c: HTMLElement, id: string) => c.querySelector(`[data-setup-row="${id}"]`) as HTMLElement;
const state = (c: HTMLElement, id: string) => row(c, id).getAttribute('data-setup-row-state');
const action = (c: HTMLElement, id: string) =>
  row(c, id).querySelector('[data-setup-row-action]') as HTMLButtonElement | null;

describe('IntegrationSetupSection', () => {
  it('reports each integration from its own probe', async () => {
    const { container, cleanup } = render(
      <IntegrationSetupSection api={fakeApi({ hooksInstalled: true, mcpRegistered: true })} />,
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

  // `verified` is a property of the TARGET (we have verified that client's MCP
  // wiring), true for Claude Code whether or not wmux is registered. Reading it
  // as install state made the row claim "installed" on an untouched config and
  // hid the Register button that would have fixed it.
  it('reads MCP registration from wmux.registered, not from verified', async () => {
    expect(mcpRegistered([{ displayName: 'Claude Code' }])).toBe(false);
    expect(mcpRegistered([{ displayName: 'Claude Code', wmux: { registered: false } }])).toBe(false);
    expect(mcpRegistered([{ displayName: 'Claude Code', wmux: { registered: true } }])).toBe(true);

    const { container, cleanup } = render(<IntegrationSetupSection api={fakeApi()} />);
    cleanups.push(cleanup);
    await flush();
    expect(state(container, 'mcp')).toBe('missing');
    expect(action(container, 'mcp')).not.toBeNull();
  });

  // The marketplace plugin owns the same four hook events, and an install
  // against it deliberately writes nothing. Reading settings.json alone left the
  // row at "not installed" forever while the signals actually flowed.
  it('counts plugin-owned hooks as installed', async () => {
    const { container, cleanup } = render(
      <IntegrationSetupSection api={fakeApi({ hooksPluginOwned: true })} />,
    );
    cleanups.push(cleanup);
    await flush();
    expect(state(container, 'hooks')).toBe('installed');
  });

  it('names the reason when an install succeeds but writes nothing', () => {
    expect(skippedReason([{ outcome: 'installed' }])).toBeNull();
    expect(skippedReason([{ outcome: 'skipped-foreign' }])).toBe('skipped-foreign');
    expect(skippedReason(undefined)).toBeNull();
  });

  // One absent bridge must not take the two REQUIRED rows down with it — the
  // disappearing surface is the bug this card exists to end.
  it('keeps the card when only some bridges are exposed', async () => {
    const { container, cleanup } = render(
      <IntegrationSetupSection api={fakeApi({ omit: 'statusline' })} />,
    );
    cleanups.push(cleanup);
    await flush();
    expect(container.querySelector('[data-integration-setup]')).not.toBeNull();
    expect(state(container, 'statusline')).toBe('unavailable');
    expect(action(container, 'statusline')).toBeNull();
    expect(state(container, 'hooks')).toBe('missing');
  });

  it('renders nothing only when no bridge is exposed at all', () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = { deck: {} };
    const { container, cleanup } = render(<IntegrationSetupSectionContainer />);
    cleanups.push(cleanup);
    expect(container.querySelector('[data-integration-setup]')).toBeNull();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
});
