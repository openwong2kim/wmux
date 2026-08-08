import { app, BrowserWindow, Menu } from 'electron';
import { collidesWithKeymap } from '../../shared/keymap';

/**
 * wmux's application menu.
 *
 * Until #818, `Menu.setApplicationMenu()` was never called, so Electron
 * installed its default menu and that menu's roles owned the accelerator table.
 * On macOS those are NSMenu key equivalents: they are dispatched before the web
 * contents see the key, so a renderer `preventDefault()` cannot take them back.
 * wmux is a multiplexer with its own keymap, and it was building that keymap on
 * top of someone else's accelerators. Three consequences, one cause:
 *
 *   - `Cmd+Shift+R` was View ▸ Force Reload, not wmux's rename-workspace. The
 *     reload wipes the renderer store, and `remoteWorkspaces[]` is per-app-run
 *     state, so every attached remote workspace vanished.
 *   - `Cmd+W` was File ▸ Close, so "close the active surface" closed the whole
 *     window instead.
 *   - `Cmd+0` / `Cmd+=` / `Cmd+-` were the View zoom roles, so terminal font
 *     zoom hit webFrame zoom instead (and now fights the UI-scale control).
 *
 * The rule this module follows: **wmux declares every accelerator it keeps, and
 * declares none that `WMUX_KEYMAP` reserves.** A menu entry we want for
 * discoverability but not for its key gets a custom `click` item rather than a
 * `role`, because a role silently re-installs its default key equivalent.
 *
 * Dispatch differs by platform, which is why this matters more on macOS:
 *
 *   macOS      key ──▶ NSMenu key equivalent ──▶ (renderer never sees it)
 *   Win/Linux  key ──▶ renderer ──▶ preventDefault? ──▶ menu accelerator
 *
 * So on Windows/Linux every combo wmux binds already wins; the exposure there is
 * the combos wmux does NOT bind — `Ctrl+R` (Reload) fires whenever focus sits
 * outside a terminal, which is the same remote-workspace data loss.
 */

/**
 * Electron version these role accelerators were probed against. Bumping
 * Electron without re-probing is how this table silently goes wrong, so
 * `appMenu.template.test.ts` fails when package.json's major drifts from this.
 * Re-probe with `npx electron scripts/probe-menu-role-accelerators.js`.
 */
export const PROBED_ELECTRON_MAJOR = 41;

/**
 * Accelerators Electron attaches to a role when the template does not spell one
 * out. Kept here because a template walk sees `accelerator: undefined` on every
 * role item — a test that only reads declared accelerators passes vacuously,
 * which is precisely the blind spot that let the default menu own these keys in
 * the first place. Roles absent from this map have no default accelerator.
 *
 * `all` is the platform-agnostic string Electron itself reports (it hands back
 * `CommandOrControl+W`, not a resolved `Cmd+W`); per-platform keys are only for
 * the roles that genuinely differ. Not hand-copied from Electron's source —
 * read out of the running Electron 41 build by the probe script above, which is
 * how `quit` was caught: it has NO accelerator on Windows (Alt+F4 is the OS
 * gesture), only on Linux.
 */
type RoleAccelerator = { all?: string; darwin?: string; win32?: string; linux?: string };

export const ROLE_DEFAULT_ACCELERATORS: Readonly<Record<string, RoleAccelerator>> = {
  about: {},
  unhide: {},
  delete: {},
  zoom: {},
  front: {},
  // macOS-only roles.
  hide: { darwin: 'Command+H' },
  hideOthers: { darwin: 'Command+Alt+H' },
  quit: { darwin: 'Command+Q', linux: 'Control+Q' },
  close: { all: 'CommandOrControl+W' },
  minimize: { all: 'CommandOrControl+M' },
  undo: { all: 'CommandOrControl+Z' },
  redo: { darwin: 'Shift+Command+Z', win32: 'Control+Y', linux: 'Control+Y' },
  cut: { all: 'CommandOrControl+X' },
  copy: { all: 'CommandOrControl+C' },
  paste: { all: 'CommandOrControl+V' },
  pasteAndMatchStyle: { all: 'Shift+CommandOrControl+V' },
  selectAll: { all: 'CommandOrControl+A' },
  reload: { all: 'CmdOrCtrl+R' },
  forceReload: { all: 'Shift+CmdOrCtrl+R' },
  toggleDevTools: { darwin: 'Alt+Command+I', win32: 'Control+Shift+I', linux: 'Control+Shift+I' },
  resetZoom: { all: 'CommandOrControl+0' },
  zoomIn: { all: 'CommandOrControl+Plus' },
  zoomOut: { all: 'CommandOrControl+-' },
  togglefullscreen: { darwin: 'Control+Command+F', win32: 'F11', linux: 'F11' },
};

/** The accelerator a role installs on `platform`, or undefined for none. */
function roleAccelerator(role: string, platform: NodeJS.Platform): string | undefined {
  const entry = ROLE_DEFAULT_ACCELERATORS[role];
  if (!entry) return undefined;
  if (platform === 'darwin') return entry.darwin ?? entry.all;
  if (platform === 'win32') return entry.win32 ?? entry.all;
  return entry.linux ?? entry.all;
}

/**
 * Every accelerator a template actually installs: the ones it declares, plus
 * the ones its roles bring along. Recurses into submenus.
 *
 * Exported for `appMenu.template.test.ts`, which is the regression pin: a menu
 * item that steals a `WMUX_KEYMAP` combo fails CI instead of shipping as a dead
 * shortcut nobody notices for three releases.
 */
export function effectiveAccelerators(
  template: readonly Electron.MenuItemConstructorOptions[],
  platform: NodeJS.Platform,
): string[] {
  const out: string[] = [];
  const walk = (items: readonly Electron.MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.accelerator) {
        out.push(item.accelerator);
      } else if (item.role) {
        const fromRole = roleAccelerator(item.role, platform);
        if (fromRole) out.push(fromRole);
        // A composite role (appMenu / editMenu / windowMenu …) expands to a
        // submenu Electron builds itself, so its children are invisible here.
        // buildAppMenuTemplate never uses the composite View/File roles for
        // exactly that reason; editMenu is the one deliberate exception and its
        // members are enumerated below so the walk still sees them.
        if (item.role === 'editMenu') {
          for (const member of EDIT_MENU_MEMBERS) {
            const acc = roleAccelerator(member, platform);
            if (acc) out.push(acc);
          }
        }
      }
      const sub = item.submenu;
      if (Array.isArray(sub)) walk(sub as Electron.MenuItemConstructorOptions[]);
    }
  };
  walk(template);
  return out;
}

/**
 * Roles Electron's `editMenu` composite expands to. The probe shows non-mac
 * builds omit `pasteAndMatchStyle` (and mac adds a Speech submenu, which has no
 * accelerators); listing it on every platform only over-claims a reservation
 * candidate, which is the safe direction for a collision check.
 */
const EDIT_MENU_MEMBERS = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteAndMatchStyle',
  'delete',
  'selectAll',
] as const;

/**
 * Build the application menu template.
 *
 * Pure so the shape can be asserted without an Electron runtime — same split as
 * `tray.ts` / `tray.macTemplate.test.ts`.
 *
 * `isDev` gates the Developer submenu. Reload stays reachable while developing,
 * but on `Alt`-prefixed keys (never `Cmd+R` / `Cmd+Shift+R`) and never in a
 * packaged build, where a stray reload costs the user their attached remotes.
 */
export function buildAppMenuTemplate(opts: {
  platform: NodeJS.Platform;
  isDev: boolean;
}): Electron.MenuItemConstructorOptions[] {
  const isMac = opts.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    // appMenu carries About / Services / Hide (Cmd+H) / Quit (Cmd+Q). None of
    // those collide: wmux's flash-pane is Cmd+Shift+H and its close-pane is
    // Cmd+Shift+Q.
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: '&File',
    submenu: isMac
      ? [
          // NOT `role: 'close'` — that role's key equivalent is Cmd+W, which is
          // wmux's close-active-surface. iTerm2 / Terminal.app / VS Code all
          // read Cmd+W as "close the tab", so wmux keeps it and window-close
          // moves one modifier over. Shift+Cmd+W was unavailable: it is
          // already wmux's close-workspace.
          {
            label: 'Close Window',
            accelerator: 'Alt+Command+W',
            click: () => BrowserWindow.getFocusedWindow()?.close(),
          },
        ]
      : // Windows/Linux keep Ctrl+Q for quit (wmux binds nothing there, and
        // xterm swallows it under terminal focus). Window-close has no menu
        // entry here: Ctrl+W is wmux's close-surface and the native frame
        // already provides the button.
        [{ role: 'quit' }],
  });

  // Unchanged from Electron's default. The macOS Cmd+V race documented at
  // useTerminal.ts:962 is guarded against the assumption that this role exists;
  // re-evaluating that guard is deliberately a separate change (#818), so the
  // premise is kept intact here.
  template.push({ label: '&Edit', role: 'editMenu' });

  template.push({
    label: '&View',
    submenu: [
      // Reload and Force Reload are gone: Cmd+Shift+R was wmux's rename and
      // Cmd+R destroys attached remote workspaces. The three zoom roles are
      // gone too — Cmd+0/=/- are terminal font zoom.
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: '&Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [
          // `role: 'minimize'` would declare Ctrl+M, which is wmux's scrollback
          // bookmark on every OS. On macOS the role is safe because the
          // bookmark stays on literal Ctrl+M there while the role takes Cmd+M.
          {
            label: 'Minimize',
            click: () => BrowserWindow.getFocusedWindow()?.minimize(),
          },
          { role: 'zoom' },
        ],
  });

  if (opts.isDev) {
    template.push({
      label: '&Developer',
      submenu: [
        {
          label: 'Reload',
          accelerator: isMac ? 'Alt+Command+R' : 'Control+Alt+R',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
        },
        {
          label: 'Force Reload',
          accelerator: isMac ? 'Shift+Alt+Command+R' : 'Control+Shift+Alt+R',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
        },
        { role: 'toggleDevTools' },
      ],
    });
  }

  return template;
}

/**
 * Install the application menu. App-global and idempotent, so one call at
 * startup covers every window, including the one macOS's `activate` handler
 * re-creates after the last window closed.
 *
 * Call this BEFORE the first `createWindow()` so no window is ever briefly
 * governed by Electron's default accelerator table.
 */
export function installApplicationMenu(): void {
  const template = buildAppMenuTemplate({
    platform: process.platform,
    // Mirrors tray.ts: resolve via app.isPackaged, not NODE_ENV, which is not
    // reliably set and could ship the Developer submenu in a release build.
    isDev: !app.isPackaged,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Every accelerator in `template` that collides with wmux's renderer keymap.
 * Empty for a correct template; the test asserts on it, and it is exported so a
 * future menu change can be checked without re-deriving the role table.
 */
export function keymapCollisions(
  template: readonly Electron.MenuItemConstructorOptions[],
  platform: NodeJS.Platform,
): string[] {
  return effectiveAccelerators(template, platform).filter((a) => collidesWithKeymap(a, platform));
}
