import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #818 — wmux owns its accelerator table.
 *
 * These lock the two things that can silently regress:
 *
 *   1. The template declares no accelerator that WMUX_KEYMAP reserves. The
 *      assertion runs through `keymapCollisions`, which resolves a `role` to
 *      the accelerator Electron attaches to it. Walking only the declared
 *      `accelerator` fields would pass vacuously — every role item has
 *      `accelerator: undefined`, and unattributed role accelerators are exactly
 *      what caused this bug.
 *   2. `installApplicationMenu()` actually calls `Menu.setApplicationMenu`. A
 *      perfectly-shaped template that is never installed leaves Electron's
 *      default menu in charge, i.e. the bug, with tests green.
 */

// vi.hoisted, not bare consts: the module under test is imported statically
// below, and vi.mock's factory is hoisted above plain const declarations.
const { setApplicationMenuMock, buildFromTemplateMock } = vi.hoisted(() => ({
  setApplicationMenuMock: vi.fn(),
  buildFromTemplateMock: vi.fn((t: unknown) => ({ __built: t })),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  Menu: {
    setApplicationMenu: setApplicationMenuMock,
    buildFromTemplate: buildFromTemplateMock,
  },
}));

import {
  PROBED_ELECTRON_MAJOR,
  buildAppMenuTemplate,
  effectiveAccelerators,
  installApplicationMenu,
  keymapCollisions,
} from '../menu/appMenu';
import { acceleratorsMatch } from '../../shared/keymap';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

/** Flatten a template to every item, submenus included. */
function allItems(
  template: readonly Electron.MenuItemConstructorOptions[],
): Electron.MenuItemConstructorOptions[] {
  return template.flatMap((item) => {
    const sub = Array.isArray(item.submenu)
      ? allItems(item.submenu as Electron.MenuItemConstructorOptions[])
      : [];
    return [item, ...sub];
  });
}

function roles(template: readonly Electron.MenuItemConstructorOptions[]): string[] {
  return allItems(template)
    .map((i) => i.role)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
}

function hasAccelerator(
  template: readonly Electron.MenuItemConstructorOptions[],
  platform: NodeJS.Platform,
  accelerator: string,
): boolean {
  return effectiveAccelerators(template, platform).some((a) =>
    acceleratorsMatch(a, accelerator, platform),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAppMenuTemplate — no accelerator wmux binds', () => {
  for (const platform of PLATFORMS) {
    for (const isDev of [false, true]) {
      it(`${platform}${isDev ? ' (dev)' : ''} declares zero keymap collisions`, () => {
        const template = buildAppMenuTemplate({ platform, isDev });
        expect(keymapCollisions(template, platform)).toEqual([]);
      });
    }
  }

  // The three combos named in the issue, asserted by name so a regression
  // reads as the symptom rather than as an opaque collision count.
  it('macOS: Cmd+Shift+R is not force-reload — it stays wmux rename-workspace', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', isDev: false });
    expect(hasAccelerator(template, 'darwin', 'Command+Shift+R')).toBe(false);
    expect(roles(template)).not.toContain('forceReload');
  });

  it('macOS: Cmd+W closes the surface, so the menu must not claim it', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', isDev: false });
    expect(hasAccelerator(template, 'darwin', 'Command+W')).toBe(false);
    expect(roles(template)).not.toContain('close');
  });

  it('macOS: window-close survives on Alt+Cmd+W', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', isDev: false });
    expect(hasAccelerator(template, 'darwin', 'Alt+Command+W')).toBe(true);
  });

  it('no platform declares the zoom roles — Cmd/Ctrl+0/=/- are terminal font zoom', () => {
    for (const platform of PLATFORMS) {
      const template = buildAppMenuTemplate({ platform, isDev: true });
      expect(roles(template)).not.toContain('resetZoom');
      expect(roles(template)).not.toContain('zoomIn');
      expect(roles(template)).not.toContain('zoomOut');
    }
  });

  it('Windows/Linux: Minimize does not claim Ctrl+M (the scrollback bookmark)', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const template = buildAppMenuTemplate({ platform, isDev: false });
      expect(hasAccelerator(template, platform, 'Control+M')).toBe(false);
    }
    // On macOS the bookmark stays on literal Ctrl+M, so the role's Cmd+M is free.
    const mac = buildAppMenuTemplate({ platform: 'darwin', isDev: false });
    expect(roles(mac)).toContain('minimize');
  });
});

describe('buildAppMenuTemplate — reload is dev-only and off the conflicting keys', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: a packaged build ships no reload path at all`, () => {
      const template = buildAppMenuTemplate({ platform, isDev: false });
      expect(roles(template)).not.toContain('reload');
      expect(roles(template)).not.toContain('forceReload');
      expect(hasAccelerator(template, platform, platform === 'darwin' ? 'Command+R' : 'Control+R')).toBe(false);
      expect(allItems(template).map((i) => i.label)).not.toContain('&Developer');
    });

    it(`${platform}: a dev build reloads on Alt, never on plain Cmd/Ctrl+R`, () => {
      const template = buildAppMenuTemplate({ platform, isDev: true });
      expect(allItems(template).map((i) => i.label)).toContain('&Developer');
      const plainReload = platform === 'darwin' ? 'Command+R' : 'Control+R';
      expect(hasAccelerator(template, platform, plainReload)).toBe(false);
      const altReload = platform === 'darwin' ? 'Alt+Command+R' : 'Control+Alt+R';
      expect(hasAccelerator(template, platform, altReload)).toBe(true);
    });
  }
});

describe('buildAppMenuTemplate — platform structure', () => {
  it('macOS gets the app menu (About / Services / Hide / Quit)', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', isDev: false });
    expect(roles(template)).toContain('appMenu');
  });

  it('Windows/Linux get Quit under File instead of an app menu', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const template = buildAppMenuTemplate({ platform, isDev: false });
      expect(roles(template)).not.toContain('appMenu');
      expect(roles(template)).toContain('quit');
    }
  });

  it('keeps the Edit roles intact — the useTerminal.ts:962 paste guard assumes them', () => {
    for (const platform of PLATFORMS) {
      const template = buildAppMenuTemplate({ platform, isDev: false });
      expect(roles(template)).toContain('editMenu');
      const paste = platform === 'darwin' ? 'Command+V' : 'Control+V';
      expect(hasAccelerator(template, platform, paste)).toBe(true);
    }
  });

  it('keeps fullscreen reachable', () => {
    for (const platform of PLATFORMS) {
      const template = buildAppMenuTemplate({ platform, isDev: false });
      expect(roles(template)).toContain('togglefullscreen');
    }
  });
});

describe('effectiveAccelerators', () => {
  it('resolves a role to the accelerator Electron attaches to it', () => {
    // The regression guard's own guard: if this ever returns [] for a role
    // item, every collision assertion above silently stops checking anything.
    // Compared normalized because Electron reports platform-agnostic strings
    // (`Shift+CmdOrCtrl+R`), which is what the probe recorded.
    const one = (t: Electron.MenuItemConstructorOptions[], p: NodeJS.Platform) => {
      const accels = effectiveAccelerators(t, p);
      expect(accels).toHaveLength(1);
      return accels[0];
    };
    expect(acceleratorsMatch(one([{ role: 'forceReload' }], 'darwin'), 'Command+Shift+R', 'darwin')).toBe(true);
    expect(acceleratorsMatch(one([{ role: 'close' }], 'darwin'), 'Command+W', 'darwin')).toBe(true);
    // Probed, not assumed: quit has no accelerator on Windows (Alt+F4 is the
    // OS gesture) but does on Linux.
    expect(effectiveAccelerators([{ role: 'quit' }], 'win32')).toEqual([]);
    expect(acceleratorsMatch(one([{ role: 'quit' }], 'linux'), 'Control+Q', 'linux')).toBe(true);
  });

  it('expands the editMenu composite to its members', () => {
    const accels = effectiveAccelerators([{ role: 'editMenu' }], 'darwin');
    expect(accels.some((a) => acceleratorsMatch(a, 'Command+V', 'darwin'))).toBe(true);
    expect(accels.some((a) => acceleratorsMatch(a, 'Command+A', 'darwin'))).toBe(true);
  });

  it('flags a template that re-adds the default View menu — the #818 regression', () => {
    // The exact mistake: someone adds back reload/forceReload/zoom "for
    // convenience". If this ever returns [], the suite above is decorative.
    const bad: Electron.MenuItemConstructorOptions[] = [
      { label: '&View', submenu: [{ role: 'forceReload' }, { role: 'resetZoom' }, { role: 'zoomIn' }] },
      { label: '&File', submenu: [{ role: 'close' }] },
    ];
    for (const platform of PLATFORMS) {
      const hits = keymapCollisions(bad, platform);
      const hit = (a: string) => hits.some((h) => acceleratorsMatch(h, a, platform));
      expect(hit('CommandOrControl+Shift+R')).toBe(true);
      expect(hit('CommandOrControl+0')).toBe(true);
      // zoomIn is spelled `Plus`; the reservation is `Ctrl+=`. If key-name
      // folding ever breaks, this is the assertion that notices.
      expect(hit('CommandOrControl+Plus')).toBe(true);
      expect(hit('CommandOrControl+W')).toBe(true);
    }
  });

  it('recurses into submenus', () => {
    const accels = effectiveAccelerators(
      [{ label: 'X', submenu: [{ label: 'Y', accelerator: 'Alt+Command+R' }] }],
      'darwin',
    );
    expect(accels).toEqual(['Alt+Command+R']);
  });
});

describe('ROLE_DEFAULT_ACCELERATORS staleness tripwire', () => {
  it('fails when Electron is upgraded past the version the role table was probed against', async () => {
    // The table is read out of a running Electron, not copied from its source
    // (that is how `quit` having no Windows accelerator was caught). An upgrade
    // can change a role default and every collision assertion above would keep
    // passing against a stale map, so make the upgrade loud instead.
    const pkg = (await import('../../../package.json')).default as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const spec = pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? '';
    const major = Number.parseInt(spec.replace(/^[^\d]*/, ''), 10);
    expect(
      major,
      `Electron ${major} != probed ${PROBED_ELECTRON_MAJOR}. Re-run ` +
        '`npx electron scripts/probe-menu-role-accelerators.js`, reconcile ' +
        'ROLE_DEFAULT_ACCELERATORS, then bump PROBED_ELECTRON_MAJOR.',
    ).toBe(PROBED_ELECTRON_MAJOR);
  });
});

describe('installApplicationMenu', () => {
  it('installs the built menu — a template nobody installs is the bug itself', () => {
    installApplicationMenu();
    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
    expect(setApplicationMenuMock).toHaveBeenCalledWith(buildFromTemplateMock.mock.results[0].value);
  });
});
