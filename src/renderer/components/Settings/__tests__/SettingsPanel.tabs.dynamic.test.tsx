// @vitest-environment jsdom
//
// The Settings screen as a whole: every tab in the nav renders, every
// searchable setting lands on a rendered row of the tab the catalog names,
// retired tab ids still resolve, and a setting changed on one tab is still
// set after visiting another.
//
// This mounts the REAL SettingsPanel against the REAL store. The preload is a
// stub: the handful of bridges whose answer decides whether a section renders
// at all (LanLink status, MCP targets, first-run status…) answer with a fixed
// shape; anything else is a no-op that resolves to nothing, and an `on*`
// subscription returns its unsubscribe.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SettingsPanel from '../SettingsPanel';
import { MCP_STATUS_CHANGED_EVENT } from '../IntegrationSetupSection';
import { useStore } from '../../../stores';
import { loadLocale } from '../../../i18n';
import {
  SETTINGS_CATALOG,
  SETTINGS_NAV_GROUPS,
  LEGACY_SETTINGS_TAB_ALIASES,
  resolveSettingsTab,
  type SettingsTabId,
} from '../../../settings/catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const resolved = <T,>(value: T) => () => Promise.resolve(value);
const echoEnabled = (enabled: boolean) => Promise.resolve({ enabled });

let mcpChecks = 0;
const MCP_STATUS = {
  targets: [{
    id: 'claude', displayName: 'Claude Code', format: 'json', configPath: '/tmp/claude.json',
    configExists: true, configModified: null, verified: true, wmux: { registered: true, path: null },
  }],
};

/** Main's side of Settings › Browser › Allow private network addresses: a
 *  main-owned value, read and written over IPC, never through the store. */
const mainPrivateNetwork = { value: false, sets: [] as boolean[], saves: true, envForced: false };

/** Explicit answers for the bridges that decide what renders. */
const EXPLICIT: Record<string, unknown> = {
  platform: 'darwin',
  pluginManagement: { list: resolved({ plugins: [], failures: [] }), onChanged: () => () => undefined },
  factory: { connectors: { list: resolved({ ok: true, connectors: [] }) } },
  shell: { list: resolved([{ name: 'zsh', path: '/bin/zsh' }]), wslDistros: resolved([]) },
  fonts: { list: resolved([]) },
  autostart: { get: resolved({ enabled: false }), set: echoEnabled },
  computerUse: {
    get: resolved({ enabled: false, helper: 'missing', stopKey: 'CommandOrControl+Alt+Shift+Escape' }),
    set: resolved({ enabled: false, helper: 'missing', stopKey: 'CommandOrControl+Alt+Shift+Escape' }),
  },
  updater: {
    onUpdateAvailable: () => () => undefined,
    onUpdateProgress: () => () => undefined,
    onUpdateNotAvailable: () => () => undefined,
    onUpdateError: () => () => undefined,
    getPendingInstall: resolved(null),
    checkForUpdates: resolved({ status: 'not-available' }),
  },
  deck: {
    autoWake: { get: resolved({ enabled: true }), set: echoEnabled },
    ledgerGate: { get: resolved({ enabled: false }), set: echoEnabled },
    briefing: {
      getConfig: resolved({ enabled: true, autoShow: true }),
      setConfig: (c: Record<string, boolean>) => Promise.resolve({ enabled: true, autoShow: true, ...c }),
    },
    hooksBridge: {
      status: resolved({ installed: false }),
      install: resolved({ ok: true, error: null }),
      getPromptPreference: resolved({ suppressed: false }),
      setPromptPreference: resolved({ suppressed: false }),
      allowWorkerTools: resolved({ ok: true, added: [] }),
    },
    statuslineBridge: { status: resolved({ installed: true }), install: resolved({ ok: true, error: null }) },
  },
  mcp: {
    check: () => { mcpChecks += 1; return Promise.resolve(MCP_STATUS); },
    reregister: () => Promise.resolve(MCP_STATUS),
    unregister: () => Promise.resolve(MCP_STATUS),
  },
  accounts: { list: resolved({ accounts: [] }), usageList: resolved([]), onUsageUpdate: () => () => undefined },
  lanlink: {
    status: resolved({
      enabled: true, nic: { name: 'en0', mac: 'aa:bb' },
      nics: [{ name: 'en0', mac: 'aa:bb', addresses: ['192.168.1.2'] }], effectivePort: 7777,
    }),
    peersList: resolved({ peers: [] }),
    pairStatus: resolved({ active: false, failCount: 0 }),
  },
  daemon: { onConnected: () => () => undefined },
  firstRun: { check: resolved({ status: { claudeFound: true, mcpRegistered: true } }) },
  quickCommands: { list: resolved({ revision: 'r1', commands: [] }) },
  fanout: { getWorkerPermissionMode: resolved('auto'), getRequireApproval: resolved(false) },
  web: { deviceList: resolved({ devices: [] }) },
  browser: {
    getAllowPrivateNetwork: () =>
      Promise.resolve({ allow: mainPrivateNetwork.value, envForced: mainPrivateNetwork.envForced }),
    // Main's rule: an unsaved opt-out still applies, an unsaved opt-in does not.
    setAllowPrivateNetwork: (allow: boolean) => {
      mainPrivateNetwork.sets.push(allow);
      mainPrivateNetwork.value = allow && mainPrivateNetwork.saves;
      return Promise.resolve({ allow: mainPrivateNetwork.value, saved: mainPrivateNetwork.saves });
    },
  },
};

/** Anything not listed: a namespace whose calls resolve to nothing. */
function fallback(path: string): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      if (key === 'then') return undefined; // never look like a promise
      if (/^on[A-Z]/.test(key)) return () => () => undefined;
      return fallback(`${path}.${key}`);
    },
  });
}

function withFallback(obj: Record<string, unknown>, path: string): unknown {
  return new Proxy(obj, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in target) {
        const v = target[key];
        return v && typeof v === 'object' && !Array.isArray(v)
          ? withFallback(v as Record<string, unknown>, `${path}.${key}`)
          : v;
      }
      if (/^on[A-Z]/.test(key)) return () => () => undefined;
      return fallback(`${path}.${key}`);
    },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // Vite defines this at build time; the test run has no define step.
  (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '0.0.0-test';
  (window as unknown as { electronAPI: unknown }).electronAPI = withFallback(EXPLICIT, 'electronAPI');
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { writeText: resolved(undefined) };
  // jsdom has no layout: jumpTo's scrollIntoView must exist to be called.
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout in jsdom */ };
});

/** Let the mount-time probes (promises) settle and re-render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function openTab(tab: SettingsTabId): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>(`[data-settings-tab="${tab}"]`);
  if (!btn) throw new Error(`no nav row for ${tab}`);
  await act(async () => { btn.click(); });
  await flush();
}

const page = (): HTMLElement => container.querySelector('[data-settings-page]') as HTMLElement;
const row = (id: string) => container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
const rowSwitch = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.getState().setSettingsPanelVisible(true));
  await act(async () => root.render(createElement(SettingsPanel)));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().setSettingsPanelVisible(false));
});

const ALL_TABS = SETTINGS_NAV_GROUPS.flatMap((g) => g.tabs);

describe('Settings tabs', () => {
  it('lists every tab once, in the owner-reviewed order', () => {
    expect(ALL_TABS).toEqual([
      'general', 'appearance', 'terminal', 'shortcuts', 'notifications', 'labs',
      'claude-integration', 'accounts', 'factory', 'roles', 'tokens', 'browser', 'computer-use',
      'remote', 'lanlink',
      'about',
    ]);
    const rendered = Array.from(container.querySelectorAll('[data-settings-tab]'))
      .map((el) => el.getAttribute('data-settings-tab'));
    expect(rendered).toEqual(ALL_TABS);
  });

  it.each(ALL_TABS)('renders the %s tab with its title and content', async (tab) => {
    await openTab(tab);
    expect(page().getAttribute('data-settings-page')).toBe(tab);
    expect(container.querySelector('[data-settings-tab][aria-current="page"]')?.getAttribute('data-settings-tab')).toBe(tab);
    expect(container.querySelector('[data-testid="settings-page-title"]')?.textContent).toBeTruthy();
    expect(page().children.length).toBeGreaterThan(0);
  });

  it.each(ALL_TABS)('renders a row for every catalog entry of the %s tab', async (tab) => {
    await openTab(tab);
    const missing = SETTINGS_CATALOG
      .filter((e) => e.tab === tab)
      .filter((e) => !page().querySelector(`[data-setting-id="${e.id}"]`))
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it('openSettingsTab lands on the asked-for tab, on mount and while open, and is consumed', async () => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => useStore.getState().setSettingsPanelVisible(false));
    act(() => useStore.getState().openSettingsTab('roles'));
    expect(useStore.getState().appRoute).toBe('settings');
    await act(async () => root.render(createElement(SettingsPanel)));
    await flush();
    expect(page().getAttribute('data-settings-page')).toBe('roles');
    expect(useStore.getState().settingsInitialTab).toBeNull();
    await openTab('general');
    act(() => useStore.getState().openSettingsTab('roles'));
    await flush();
    expect(page().getAttribute('data-settings-page')).toBe('roles');
  });

  it('puts no catalog entry on a tab the nav does not list', () => {
    const tabs = new Set<string>(ALL_TABS);
    expect(SETTINGS_CATALOG.filter((e) => !tabs.has(e.tab)).map((e) => e.id)).toEqual([]);
  });
});

describe('main-owned settings', () => {
  it('browser › browserprivatenet shows the value main holds, writes it to main, and reads it back after a trip', async () => {
    mainPrivateNetwork.value = true;
    mainPrivateNetwork.sets = [];
    await openTab('browser');
    expect(row('browserprivatenet')?.textContent).toContain('Allow private network addresses');
    const sw = rowSwitch('browserprivatenet');
    expect(sw, 'browserprivatenet switch').not.toBeNull();
    expect(sw!.getAttribute('aria-checked')).toBe('true');

    await act(async () => { sw!.click(); });
    await flush();
    expect(mainPrivateNetwork.sets).toEqual([false]);
    expect(rowSwitch('browserprivatenet')!.getAttribute('aria-checked')).toBe('false');

    await openTab('about');
    await openTab('browser');
    expect(rowSwitch('browserprivatenet')!.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[data-testid="browser-private-network-unsaved"]')).toBeNull();
    mainPrivateNetwork.value = false;
  });

  it('browser › browserprivatenet is on and locked, with the reason, while the environment variable forces it', async () => {
    mainPrivateNetwork.value = false;
    mainPrivateNetwork.envForced = true;
    mainPrivateNetwork.sets = [];
    try {
      await openTab('browser');
      const sw = rowSwitch('browserprivatenet')!;
      expect(sw.getAttribute('aria-checked')).toBe('true');
      expect(sw.disabled).toBe(true);
      expect(row('browserprivatenet')?.textContent).toContain(
        'On because WMUX_ALLOW_PRIVATE_NETWORK is set in the environment that launched wmux.',
      );
      await act(async () => { sw.click(); });
      await flush();
      // Nothing is written: the stored setting stays what it was.
      expect(mainPrivateNetwork.sets).toEqual([]);
    } finally {
      mainPrivateNetwork.envForced = false;
    }
  });

  it('browser › browserprivatenet shows the value in force and says so when main could not save', async () => {
    mainPrivateNetwork.value = true;
    mainPrivateNetwork.saves = false;
    try {
      await openTab('browser');
      const note = () => container.querySelector('[data-testid="browser-private-network-unsaved"]');

      // Off, unsaved: off now, back on after a restart.
      await act(async () => { rowSwitch('browserprivatenet')!.click(); });
      await flush();
      expect(rowSwitch('browserprivatenet')!.getAttribute('aria-checked')).toBe('false');
      expect(note()?.textContent).toBe(
        "Couldn't save this. Private network access will turn back on after wmux restarts.",
      );

      // On, unsaved: stays off.
      await act(async () => { rowSwitch('browserprivatenet')!.click(); });
      await flush();
      expect(rowSwitch('browserprivatenet')!.getAttribute('aria-checked')).toBe('false');
      expect(note()?.textContent).toBe("Couldn't save this setting, so private network access stays off.");

      // Saved again: the note goes.
      mainPrivateNetwork.saves = true;
      await act(async () => { rowSwitch('browserprivatenet')!.click(); });
      await flush();
      expect(rowSwitch('browserprivatenet')!.getAttribute('aria-checked')).toBe('true');
      expect(note()).toBeNull();
    } finally {
      mainPrivateNetwork.saves = true;
      mainPrivateNetwork.value = false;
    }
  });
});

describe('Settings search jump', () => {
  it('lands on the row of a moved setting (agent toolbar → Appearance)', async () => {
    const search = container.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'Agent inject chrome');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const hit = container.querySelector<HTMLButtonElement>('[data-jump="toolbar"]');
    expect(hit).not.toBeNull();
    await act(async () => { hit!.click(); });
    await flush();
    expect(page().getAttribute('data-settings-page')).toBe('appearance');
    expect(row('toolbar')).not.toBeNull();
  });
});

describe('retired tab ids', () => {
  it('resolves the split Agents tab and the retired Orchestrator and Moa tabs to Factory', () => {
    expect(LEGACY_SETTINGS_TAB_ALIASES.agents).toBe('factory');
    expect(resolveSettingsTab('agents')).toBe('factory');
    expect(LEGACY_SETTINGS_TAB_ALIASES.orchestrator).toBe('factory');
    expect(resolveSettingsTab('orchestrator')).toBe('factory');
    expect(resolveSettingsTab('moa')).toBe('factory');
  });

  it('keeps every surviving id as itself, and sends unknown ids to General', () => {
    for (const tab of ALL_TABS) expect(resolveSettingsTab(tab)).toBe(tab);
    expect(resolveSettingsTab('no-such-tab')).toBe('general');
    expect(resolveSettingsTab(undefined)).toBe('general');
  });

  it('maps every alias onto a tab the nav lists', () => {
    for (const target of Object.values(LEGACY_SETTINGS_TAB_ALIASES)) expect(ALL_TABS).toContain(target);
  });
});

describe('settings persist across tabs', () => {
  it.each([
    ['terminal', 'splitcwd', 'splitInheritsCwd'],
    ['terminal', 'inlineimages', 'inlineImagesEnabled'],
    ['terminal', 'plaindragselect', 'plainDragSelectEnabled'],
    ['appearance', 'sidebarpanecoordinates', 'sidebarShowPaneCoordinates'],
    ['roles', 'a2a', 'a2aAutoApproveExecute'],
    ['browser', 'sitememory', 'siteMemoryEnabled'],
  ] as const)('%s › %s survives a trip to another tab', async (tab, id, key) => {
    await openTab(tab);
    const before = useStore.getState()[key] as boolean;
    const sw = rowSwitch(id);
    expect(sw, `${id} switch`).not.toBeNull();
    expect(sw!.getAttribute('aria-checked')).toBe(String(before));
    await act(async () => { sw!.click(); });
    expect(useStore.getState()[key]).toBe(!before);

    await openTab('about');
    await openTab(tab);
    expect(rowSwitch(id)!.getAttribute('aria-checked')).toBe(String(!before));

    // Leave the store as we found it.
    await act(async () => { rowSwitch(id)!.click(); });
    expect(useStore.getState()[key]).toBe(before);
  });

  // #1481 — the sidebar order row is a three-way control now.
  it('appearance › sidebarattention sets the workspace order and survives a trip to another tab', async () => {
    const before = useStore.getState().sidebarSortMode;
    await openTab('appearance');
    const radios = () => [...(row('sidebarattention')?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    expect(radios().length).toBe(3);
    await act(async () => { radios()[2].click(); });
    expect(useStore.getState().sidebarSortMode).toBe('recent');
    expect(useStore.getState().sidebarAttentionFirst).toBe(false);
    await openTab('about');
    await openTab('appearance');
    expect(radios()[2].getAttribute('aria-checked')).toBe('true');
    await act(async () => { radios()[0].click(); });
    expect(useStore.getState().sidebarAttentionFirst).toBe(true);
    expect(useStore.getState().sidebarSortModeChosen).toBe(true);
    act(() => useStore.getState().setSidebarSortMode(before));
  });

  it('appearance › theme lists wmux\'s own looks first and every other theme under More themes', async () => {
    await openTab('appearance');
    const names = (group: string) => [...(row('theme')?.querySelectorAll<HTMLButtonElement>(
      `[data-theme-group="${group}"] [role="radio"]`,
    ) ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(names('looks')).toEqual(['Tint', 'Zinc', 'Graphite', 'Paper', 'Amber Line']);
    const more = names('more');
    expect(more[0]).toBe('Mono');
    expect(more.at(-1)).toBe('Custom');
    expect(more).not.toContain('Tint');
    // One radiogroup still holds every card, so one theme stays selected.
    expect(row('theme')?.querySelectorAll('[role="radiogroup"] [role="radio"]').length)
      .toBe(names('looks').length + more.length);
    const heading = row('theme')?.querySelector('.settings-theme-more');
    expect(heading?.textContent).toBe('More themes');
    expect(heading?.nextElementSibling?.getAttribute('data-theme-group')).toBe('more');
  });

  it('keeps the language picked on General', async () => {
    const before = useStore.getState().locale;
    // A table not loaded yet switches a moment later; loaded, the pick is instant.
    await loadLocale('ko');
    const select = row('language')!.querySelector('select')!;
    await act(async () => {
      select.value = 'ko';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useStore.getState().locale).toBe('ko');
    await openTab('terminal');
    await openTab('general');
    expect(row('language')!.querySelector('select')!.value).toBe('ko');
    act(() => useStore.getState().setLocale(before));
  });
});

describe('Escape with a dialog open over Settings', () => {
  const esc = async () => {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
  };

  it('closes the paired-devices dialog first, then Settings', async () => {
    await openTab('remote');
    await act(async () => { row('paireddevices')!.querySelector('button')!.click(); });
    await flush();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();

    await esc();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(useStore.getState().settingsPanelVisible).toBe(true);

    await esc();
    expect(useStore.getState().settingsPanelVisible).toBe(false);
  });
});

const key = async (init: KeyboardEventInit) => {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
  await flush();
};

describe('Settings keyboard ownership (review follow-up)', () => {
  it('still closes on Escape while a dialog Settings does not own is mounted but hidden', async () => {
    // The floating terminal stays mounted with display:none after first use.
    const floating = document.createElement('div');
    floating.setAttribute('role', 'dialog');
    floating.setAttribute('aria-modal', 'true');
    floating.style.display = 'none';
    document.body.appendChild(floating);
    try {
      await key({ key: 'Escape' });
      expect(useStore.getState().settingsPanelVisible).toBe(false);
    } finally {
      floating.remove();
    }
  });

  it('leaves Ctrl/Cmd+F to the paired-devices dialog while it is open', async () => {
    await openTab('remote');
    await act(async () => { row('paireddevices')!.querySelector('button')!.click(); });
    await flush();
    const search = container.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    await key({ key: 'f', ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
    await key({ key: 'Escape' });
    await key({ key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });
});

describe('opening on a tab id', () => {
  it.each([
    ['agents', 'factory'],
    ['orchestrator', 'factory'],
    ['moa', 'factory'],
    ['no-such-tab', 'general'],
    ['lanlink', 'lanlink'],
  ])('opens %s as %s', async (id, expected) => {
    // A fresh mount: the tab is chosen once, when Settings opens.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(SettingsPanel, { initialTab: id })));
    await flush();
    expect(page().getAttribute('data-settings-page')).toBe(expected);
    expect(container.querySelector('[data-testid="settings-page-title"]')?.textContent).toBeTruthy();
  });
});

describe('Settings › LAN after pairing moved to the Remote page', () => {
  it('keeps the listener switches, and the lanpair link lands on a way to the Remote page', async () => {
    await openTab('lanlink');
    expect(row('lanenable')).not.toBeNull();
    expect(row('lannic')).not.toBeNull();
    // No pairing form or peer list is left in Settings.
    expect(container.querySelector('[data-testid="lanlink-pairing-section"]')).toBeNull();
    expect(page().textContent).not.toContain('Generate PIN');
    const link = row('lanpair')!;
    expect(link.textContent).toContain('Manage connections on the Remote page');
    await act(async () => { link.querySelector<HTMLButtonElement>('[data-testid="lanlink-open-remote"]')!.click(); });
    expect(useStore.getState().appRoute).toBe('remote');
  });
});

describe('one MCP state on the Claude Code tab', () => {
  it('re-reads every MCP view when one of them changes registration', async () => {
    await openTab('claude-integration');
    const before = mcpChecks;
    await act(async () => { window.dispatchEvent(new CustomEvent(MCP_STATUS_CHANGED_EVENT)); });
    await flush();
    // The setup card and the MCP servers list each re-read.
    expect(mcpChecks - before).toBe(2);
  });
});
