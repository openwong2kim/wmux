/**
 * Read each Electron menu role's default accelerator out of the Electron build
 * that is actually installed, and print it as JSON.
 *
 * `src/main/menu/appMenu.ts` keeps a copy of this table (#818): a template walk
 * cannot see a role's accelerator — the item's own `accelerator` field is
 * undefined — so the collision test that keeps the application menu off wmux's
 * keymap has to know what each role installs. A hand-copied table goes stale
 * silently on an Electron upgrade, hence this probe plus the
 * PROBED_ELECTRON_MAJOR tripwire in appMenu.template.test.ts.
 *
 * Usage (from the repo root):
 *
 *   npx electron scripts/probe-menu-role-accelerators.js
 *
 * Then reconcile the output with ROLE_DEFAULT_ACCELERATORS and bump
 * PROBED_ELECTRON_MAJOR. Note that Electron reports platform-agnostic strings
 * (`CommandOrControl+W`), and that a few roles genuinely differ per platform —
 * run the probe on each OS you care about, or trust the per-platform keys
 * already recorded.
 */
const { app, Menu } = require('electron');

const ROLES = [
  'about', 'hide', 'hideOthers', 'unhide', 'quit', 'close', 'minimize', 'zoom', 'front',
  'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
  'reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut',
  'togglefullscreen',
];

const COMPOSITES = ['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu'];

app.whenReady().then(() => {
  const out = { platform: process.platform, electron: process.versions.electron, roles: {}, composites: {} };

  for (const role of ROLES) {
    try {
      const menu = Menu.buildFromTemplate([{ role }]);
      out.roles[role] = menu.items[0] ? menu.items[0].accelerator || null : 'ROLE_REJECTED';
    } catch (err) {
      out.roles[role] = `ERROR: ${err.message}`;
    }
  }

  for (const composite of COMPOSITES) {
    try {
      const menu = Menu.buildFromTemplate([{ role: composite }]);
      const sub = menu.items[0] && menu.items[0].submenu ? menu.items[0].submenu.items : [];
      out.composites[composite] = sub.map((i) => `${i.role || i.label || '(separator)'}=${i.accelerator || '-'}`);
    } catch (err) {
      out.composites[composite] = `ERROR: ${err.message}`;
    }
  }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
