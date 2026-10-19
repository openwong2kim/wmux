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
  displayCommand,
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

  // Panel finding: one Replace click forces EVERY foreign target, so naming
  // only the first meant the other accounts' statuslines vanished unseen.
  it('names every command a single Replace would overwrite', () => {
    expect(
      foreignCommandSuffix([
        { label: 'a', state: 'foreign', foreignCommand: 'line-a.sh' },
        { label: 'b', state: 'foreign', foreignCommand: 'line-b.sh' },
      ]),
    ).toBe(' (line-a.sh, line-b.sh)');
  });

  // The command is arbitrary text from someone else's config. An unbounded or
  // multi-line one pushed the Replace button — the control the message points
  // at — off the row.
  it('flattens and caps a hostile command before showing it', () => {
    expect(displayCommand('foo\nbar\tbaz')).toBe('foo bar baz');
    const long = displayCommand('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith('…')).toBe(true);
  });

  // A refused replace is not the foreign skip: clicking Replace again cannot
  // fix it, so it must not read as the same situation.
  it('separates a backup failure from an ordinary foreign skip', async () => {
    const api = fakeApi({
      statuslineTargets: [{ label: 'default (~/.claude)', state: 'foreign', foreignCommand: 'bunx ccusage' }],
      statuslineInstall: async () => ({ ok: true, error: null, targets: [{ outcome: 'skipped-no-backup' }] }),
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();

    expect(skipReasonOf([{ outcome: 'skipped-no-backup' }])).toBe('no-backup');
    const text = row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent!;
    expect(text).toContain('~/.wmux/hooks');
    expect(text).not.toContain('Replace puts the wmux one');
  });

  // #1102's original symptom, reached through the exception path: a throw used
  // to wipe the foreign detail and take the Replace button with it.
  it('keeps the Replace affordance when the install throws', async () => {
    const api = fakeApi({
      statuslineTargets: [{ label: 'default (~/.claude)', state: 'foreign', foreignCommand: 'bunx ccusage' }],
      statuslineInstall: async () => { throw new Error('EACCES'); },
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();

    expect(state(container, 'statusline')).toBe('error');
    expect(row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent).toContain('EACCES');
    expect(row(container, 'statusline').querySelector('[data-setup-row-secondary]')).not.toBeNull();
  });

  // Review finding: the skip reason from the FIRST click survived into a
  // second click that threw, so the row explained a foreign skip while the
  // actual failure went unsaid. Only reachable on the second click, which is
  // why the single-throw test above did not catch it.
  it('does not explain a throw with the previous install\'s skip reason', async () => {
    let calls = 0;
    const api = fakeApi({
      statuslineTargets: [{ label: 'default (~/.claude)', state: 'foreign', foreignCommand: 'bunx ccusage' }],
      statuslineInstall: async () => {
        calls += 1;
        if (calls === 1) return { ok: true, error: null, targets: [{ outcome: 'skipped-foreign' }] };
        throw new Error('EACCES');
      },
    });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'statusline')!.click(); await Promise.resolve(); });
    await flush();
    expect(row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent)
      .toContain('Another tool already sets');

    const replace = row(container, 'statusline').querySelector('[data-setup-row-secondary]') as HTMLButtonElement;
    await act(async () => { replace.click(); await Promise.resolve(); });
    await flush();
    const text = row(container, 'statusline').querySelector('[data-setup-row-error]')!.textContent!;
    expect(text).toContain('EACCES');
    expect(text).not.toContain('Another tool already sets');
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

// ─── #2404 — an install older than this build's hook set ─────────────────────

describe('IntegrationSetupSection — hook set update', () => {
  /** A hooks api whose probe reports a pre-#2390 install until Update runs. */
  function driftedApi(withUpdate = true) {
    const calls: string[] = [];
    const flags = { current: false };
    const api = fakeApi({
      hooksInstalled: true,
      hooksInstall: async () => { calls.push('install'); return { ok: true, error: null }; },
    });
    api.hooks!.status = async () => ({
      installed: true,
      updateAvailable: !flags.current,
      outcome: {
        pluginAlsoInstalled: false,
        hooks: [
          { label: 'Stop', state: 'ok' },
          { label: 'Notification:permission_prompt', state: flags.current ? 'ok' : 'missing' },
        ],
      },
    });
    if (withUpdate) {
      api.hooks!.update = async () => { calls.push('update'); flags.current = true; return { ok: true, error: null }; };
    }
    return { api, calls };
  }

  it('offers Update, naming the missing hook, for an install from before #2390', async () => {
    const { api, calls } = driftedApi();
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    expect(state(container, 'hooks')).toBe('outdated');
    expect(action(container, 'hooks')!.textContent).toBe('Update');
    const note = row(container, 'hooks').querySelector('[data-setup-row-note]')!.textContent!;
    expect(note).toContain('Notification:permission_prompt');
    expect(note).not.toContain('Stop');

    await act(async () => { action(container, 'hooks')!.click(); await Promise.resolve(); });
    await flush();
    // The update path, never the clear-then-add install.
    expect(calls).toEqual(['update']);
    expect(state(container, 'hooks')).toBe('installed');
    expect(action(container, 'hooks')).toBeNull();
  });

  it('shows a current install as installed, with nothing to click', async () => {
    const { api, calls } = driftedApi();
    await api.hooks!.update!();
    calls.length = 0;
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(state(container, 'hooks')).toBe('installed');
    expect(action(container, 'hooks')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('writes nothing until the click', async () => {
    const { api, calls } = driftedApi();
    const { cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    await flush();
    expect(calls).toEqual([]);
  });

  it('keeps an older preload without Update on the installed row', async () => {
    const { api } = driftedApi(false);
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(state(container, 'hooks')).toBe('installed');
  });

  it('retries a failed Update as an Update', async () => {
    const { api, calls } = driftedApi();
    let fail = true;
    const update = api.hooks!.update!;
    api.hooks!.update = async () => {
      if (fail) { calls.push('update'); fail = false; return { ok: false, error: 'EACCES' }; }
      return update();
    };
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    await act(async () => { action(container, 'hooks')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks')).toBe('error');
    expect(action(container, 'hooks')!.textContent).toBe('Update');

    await act(async () => { action(container, 'hooks')!.click(); await Promise.resolve(); });
    await flush();
    expect(calls).toEqual(['update', 'update']);
    expect(state(container, 'hooks')).toBe('installed');
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

// ─── Account folders: each one's own copy of Claude settings ─────────────────

describe('IntegrationSetupSection — account folder hook update', () => {
  function accountsApi(withUpdateAccount = true) {
    const calls: string[] = [];
    const current = new Set<string>();
    const api = fakeApi({ hooksInstalled: true });
    api.hooks!.status = async () => ({
      installed: true,
      updateAvailable: false,
      outcome: { pluginAlsoInstalled: false, hooks: [{ label: 'Stop', state: 'ok' }] },
      accounts: [
        { accountId: 'a', name: 'Work', stale: ['StopFailure'] },
        { accountId: 'b', name: 'Home', stale: ['StopFailure', 'Notification:permission_prompt'] },
      ].filter((x) => !current.has(x.accountId)),
    });
    if (withUpdateAccount) {
      api.hooks!.updateAccount = async (id) => { calls.push(id); current.add(id); return { ok: true, error: null }; };
    }
    return { api, calls };
  }

  it('lists each drifted account folder with its missing hooks and writes only on its own click', async () => {
    const { api, calls } = accountsApi();
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();

    expect(state(container, 'hooks')).toBe('installed');
    expect(state(container, 'hooks-account-a')).toBe('outdated');
    expect(row(container, 'hooks-account-a').textContent).toContain('Work');
    expect(row(container, 'hooks-account-a').querySelector('[data-setup-row-note]')!.textContent).toContain('StopFailure');
    expect(calls).toEqual([]);

    await act(async () => { action(container, 'hooks-account-b')!.click(); await Promise.resolve(); });
    await flush();
    expect(calls).toEqual(['b']);
    // Brought up to date: its row goes; the other stays as it was.
    expect(container.querySelector('[data-setup-row="hooks-account-b"]')).toBeNull();
    expect(state(container, 'hooks-account-a')).toBe('outdated');
  });

  it('settles two overlapping account Updates on their own, and gives the first the primary', async () => {
    const { api } = accountsApi();
    const pending: Array<(v: { ok: boolean; error: string | null }) => void> = [];
    api.hooks!.updateAccount = () => new Promise((resolve) => { pending.push(resolve); });
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(action(container, 'hooks-account-a')!.className).toContain('ui-btn-primary');
    expect(action(container, 'hooks-account-b')!.className).not.toContain('ui-btn-primary');

    await act(async () => { action(container, 'hooks-account-a')!.click(); await Promise.resolve(); });
    await act(async () => { action(container, 'hooks-account-b')!.click(); await Promise.resolve(); });
    await act(async () => { pending[0]({ ok: false, error: 'EACCES' }); pending[1]({ ok: false, error: 'EPERM' }); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks-account-a')).toBe('error');
    expect(state(container, 'hooks-account-b')).toBe('error');
    expect(action(container, 'hooks-account-a')!.textContent).toBe('Update');
  });

  it('shows a successful account Update as done when the probe after it fails', async () => {
    const { api } = accountsApi();
    const status = api.hooks!.status;
    let failProbe = false;
    api.hooks!.status = async () => { if (failProbe) throw new Error('ipc'); return status(); };
    api.hooks!.updateAccount = async () => { failProbe = true; return { ok: true, error: null }; };
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    await act(async () => { action(container, 'hooks-account-a')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks-account-a')).toBe('installed');
    expect(state(container, 'hooks-account-b')).toBe('outdated');
  });

  it('settles a successful account Update even when its probe is discarded', async () => {
    const { api } = accountsApi();
    let holdProbe = false;
    const status = api.hooks!.status;
    api.hooks!.status = () => (holdProbe ? new Promise(() => undefined) : status());
    api.hooks!.updateAccount = async () => { holdProbe = true; return { ok: true, error: null }; };
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    await act(async () => { action(container, 'hooks-account-a')!.click(); await Promise.resolve(); });
    await flush();
    expect(state(container, 'hooks-account-a')).toBe('installed');
    expect(action(container, 'hooks-account-a')).toBeNull();
  });

  it('shows no account rows on a preload without the account Update', async () => {
    const { api } = accountsApi(false);
    const { container, cleanup } = render(<IntegrationSetupSection api={api} />);
    cleanups.push(cleanup);
    await flush();
    expect(container.querySelector('[data-setup-row^="hooks-account-"]')).toBeNull();
  });
});
