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
  skipReasonOf,
  installTook,
  foreignTargets,
  foreignCommandSuffix,
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
  statuslineTargets: Array<{ label: string; state: string; foreignCommand?: string }>;
  mcpRegistered: boolean;
  hooksInstall: () => Promise<{ ok: boolean; error: string | null }>;
  statuslineInstall: (opts?: { force?: boolean }) => Promise<{ ok: boolean; error: string | null; targets: Array<{ outcome: string }> }>;
  hooksStatusThrows: boolean;
  promptSuppressed: boolean;
  promptPrefThrows: boolean;
  omitPromptPref: boolean;
  omit: 'hooks' | 'statusline' | 'mcp';
}> = {}): IntegrationSetupApi {
  // Probes re-run after a successful install, so the fakes read live flags.
  const flags = {
    hooks: over.hooksInstalled ?? false,
    statusline: over.statuslineInstalled ?? false,
    mcp: over.mcpRegistered ?? false,
    promptSuppressed: over.promptSuppressed ?? false,
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
      ...(over.omitPromptPref
        ? {}
        : {
            getPromptPreference: async () => {
              if (over.promptPrefThrows) throw new Error('ipc down');
              return { suppressed: flags.promptSuppressed };
            },
            setPromptPreference: async (suppressed: boolean) => {
              flags.promptSuppressed = suppressed;
              return { suppressed };
            },
          }),
    },
    statusline: {
      status: async () => ({
        installed: flags.statusline,
        outcome: over.statuslineTargets ? { targets: over.statuslineTargets } : undefined,
      }),
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

  // #1102: a foreign statusLine made Install report a bare "skipped-foreign"
  // with no way forward. The row now says what happened in words and offers
  // the one action that can fix it — a second, explicit click.
  it('offers Replace when a foreign statusLine blocked the install', async () => {
    const calls: Array<{ force?: boolean } | undefined> = [];
    const flags = { forced: false };
    const api = fakeApi({
      statuslineInstall: async (opts) => {
        calls.push(opts);
        if (opts?.force) {
          flags.forced = true;
          return { ok: true, error: null, targets: [{ outcome: 'replaced' }] };
        }
        return { ok: true, error: null, targets: [{ outcome: 'skipped-foreign' }] };
      },
    });
    // The re-probe after a forced install must see the new state.
    api.statusline!.status = async () => ({ installed: flags.forced });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'statusline')).toBe('error');
    const text = row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent!;
    expect(text).not.toContain('skipped-foreign');
    expect(text).toContain('Replace');

    const replace = row(container, 'statusline').querySelector('[data-setup-row-secondary]') as HTMLButtonElement;
    expect(replace).not.toBeNull();
    await act(async () => { replace.click(); await Promise.resolve(); });
    await flush();
    expect(calls).toEqual([undefined, { force: true }]);
    expect(state(container, 'statusline')).toBe('installed');
  });

  // #1102 eng review D2: consent to replace something you cannot see is not
  // consent. The probe carries the foreign command; the message must show it.
  it('names the statusline it would replace', async () => {
    const api = fakeApi({
      statuslineTargets: [{ label: 'default (~/.claude)', state: 'foreign', foreignCommand: 'bunx ccusage statusline' }],
      statuslineInstall: async () => ({ ok: true, error: null, targets: [{ outcome: 'skipped-foreign' }] }),
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();
    expect(row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent)
      .toContain('bunx ccusage statusline');
  });

  // #1102 eng review D3: one account taking the install used to turn the row
  // green while another account still ran someone else's statusline, with no
  // way to see it and no way to act on it.
  it('keeps the skip visible when only some accounts took the install', async () => {
    const api = fakeApi({
      statuslineInstalled: true,
      statuslineTargets: [
        { label: 'default (~/.claude)', state: 'wmux' },
        { label: 'work', state: 'foreign', foreignCommand: 'my-line.sh' },
      ],
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    expect(state(container, 'statusline')).toBe('installed');
    const note = row(container, 'statusline').querySelector('[data-setup-row-note]')!.textContent!;
    expect(note).toContain('work');
    expect(note).toContain('my-line.sh');
    // Installed, and still replaceable — the remaining account is reachable.
    expect(row(container, 'statusline').querySelector('[data-setup-row-secondary]')).not.toBeNull();
  });

  it('says nothing extra when every profile is ours', async () => {
    const api = fakeApi({
      statuslineInstalled: true,
      statuslineTargets: [{ label: 'default (~/.claude)', state: 'wmux' }],
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(row(container, 'statusline').querySelector('[data-setup-row-note]')).toBeNull();
    expect(row(container, 'statusline').querySelector('[data-setup-row-secondary]')).toBeNull();
  });

  it('picks the foreign targets and the command out of a probe', () => {
    const targets = [
      { label: 'a', state: 'wmux' },
      { label: 'b', state: 'foreign' },
      { label: 'c', state: 'foreign', foreignCommand: 'mine.sh' },
    ];
    expect(foreignTargets(targets).map((x) => x.label)).toEqual(['b', 'c']);
    expect(foreignTargets(undefined)).toEqual([]);
    // Skips the foreign target we could not read a command from.
    expect(foreignCommandSuffix(targets)).toBe(' (mine.sh)');
    expect(foreignCommandSuffix([{ label: 'b', state: 'foreign' }])).toBe('');
  });

  it('names the reason when an install succeeds but writes nothing', () => {
    expect(skippedReason([{ outcome: 'installed' }])).toBeNull();
    expect(skippedReason([{ outcome: 'skipped-foreign' }])).toBe('skipped-foreign');
    expect(skippedReason(undefined)).toBeNull();
  });

  it('names an all-skipped install by its actionable reason (#1102)', () => {
    expect(skipReasonOf([{ outcome: 'skipped-foreign' }])).toBe('foreign');
    expect(skipReasonOf([{ outcome: 'skipped-corrupt' }])).toBe('corrupt');
    // A single target that took the write is a success, not a skip.
    expect(skipReasonOf([{ outcome: 'installed' }, { outcome: 'skipped-foreign' }])).toBeNull();
    expect(skipReasonOf([{ outcome: 'replaced' }])).toBeNull();
    expect(skipReasonOf(undefined)).toBeNull();
    // `replaced` is a take: a forced install must not report failure.
    expect(installTook([{ outcome: 'replaced' }])).toBe(true);
    expect(installTook([{ outcome: 'skipped-foreign' }])).toBe(false);
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

// ─── The install prompt's durable refusal, surfaced here so it is reversible ──

describe('IntegrationSetupSection — hook prompt refusal', () => {
  const line = (c: HTMLElement) => c.querySelector('[data-hooks-prompt-suppressed]');
  const reenable = (c: HTMLElement) =>
    c.querySelector('[data-hooks-prompt-reenable]') as HTMLButtonElement | null;

  it('says nothing when the prompt has not been refused', async () => {
    const { container, cleanup } = render(<IntegrationSetupSection api={fakeApi()} />);
    cleanups.push(cleanup);
    await flush();
    expect(line(container)).toBeNull();
  });

  it('surfaces a stored refusal and clears it on request', async () => {
    const api = fakeApi({ promptSuppressed: true });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(line(container)).toBeTruthy();

    act(() => reenable(container)!.click());
    await flush();
    expect(line(container)).toBeNull();
  });

  it('keeps the line up when the clear fails — the refusal is still in force', async () => {
    const api = fakeApi({ promptSuppressed: true });
    api.hooks!.setPromptPreference = async () => { throw new Error('EACCES'); };
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    act(() => reenable(container)!.click());
    await flush();
    expect(line(container)).toBeTruthy();
  });

  it('a probe answering after "Ask again" cannot bring the line back', async () => {
    const api = fakeApi({ promptSuppressed: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    api.hooks!.getPromptPreference = async () => {
      if (first) { first = false; return { suppressed: true }; }
      // The probe the "Ask again" click races: it reads the pre-clear value and
      // resolves only after the clear has already painted.
      await gate;
      return { suppressed: true };
    };
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(line(container)).toBeTruthy();

    act(() => (container.querySelector('[data-setup-row="hooks"] [data-setup-row-action]') as HTMLButtonElement).click());
    await flush();
    act(() => reenable(container)!.click());
    await flush();
    expect(line(container)).toBeNull();

    act(() => release());
    await flush();
    expect(line(container)).toBeNull();
  });

  // The counter split's reason to exist: "Ask again" mid-install must not
  // invalidate the install's own commits. With one shared generation the
  // failure path stranded — the spinner stayed and the error text was thrown
  // away, on exactly the run where the user most needed to see it.
  it('"Ask again" during an in-flight install does not strand the row on working', async () => {
    const api = fakeApi({ promptSuppressed: true });
    let fail!: () => void;
    api.hooks!.install = () =>
      new Promise((_, reject) => { fail = () => reject(new Error('EACCES: settings.json')); });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    act(() => action(container, 'hooks')!.click());
    await flush();
    expect(state(container, 'hooks')).toBe('working');

    // The race: the refusal is cleared while the install is still running.
    act(() => reenable(container)!.click());
    await flush();
    expect(line(container)).toBeNull();

    act(() => fail());
    await flush();
    expect(state(container, 'hooks')).toBe('error');
    expect(row(container, 'hooks').querySelector('[data-setup-row-error]')!.textContent).toContain('EACCES');
  });

  it('shows nothing on an older preload, and nothing when the probe fails', async () => {
    const older = render(<IntegrationSetupSection api={fakeApi({ omitPromptPref: true })} />);
    cleanups.push(older.cleanup);
    await flush();
    expect(line(older.container)).toBeNull();

    const broken = render(
      <IntegrationSetupSection api={fakeApi({ promptSuppressed: true, promptPrefThrows: true })} />,
    );
    cleanups.push(broken.cleanup);
    await flush();
    expect(line(broken.container)).toBeNull();
  });
});
