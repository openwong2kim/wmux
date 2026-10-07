// Browser build of the renderer (wmux web `/app`).
//
// Mounts the desktop's own components (Sidebar, WorkspaceItem, MiniSidebar,
// PaneContainer/Pane/SurfaceTabs, theme and fonts) from src/renderer/web/main.tsx.
// scripts/build-daemon-web.mjs runs this build and inlines the result into the
// daemon's page, so the output shape is fixed: ONE classic script (iife, every
// dynamic import inlined) and ONE stylesheet, with fonts emitted as files the
// daemon serves same-origin under /app/assets/.
//
// Desktop-only modules are swapped for stand-ins HERE, by resolved path, so the
// desktop build (vite.renderer.config.ts) and every desktop render path stay
// exactly as they are.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import pkg from './package.json';

const root = __dirname;
// Vite hands plugins slash-form ids on every OS (`C:/x/y.tsx` on Windows),
// while path.join gives backslashes there. Every id this plugin compares goes
// through `slash` so the table matches on Windows too (#1846). Not Vite's
// normalizePath: it only converts backslashes when running on win32.
const slash = (p: string) => p.replace(/\\/g, '/');
const r = (p: string) => slash(path.join(root, p));
const NULL_STUB = r('src/renderer/web/stubs/NullComponent.tsx');
const WEB_TERMINAL = r('src/renderer/web/WebTerminal.tsx');

/** Resolved module → browser stand-in. */
export const WEB_STUBS: Record<string, string> = {
  // The real Terminal behind a live-stream slot and the desktop's fixed grid.
  [r('src/renderer/components/Terminal/Terminal.tsx')]: WEB_TERMINAL,
  [r('src/renderer/components/Browser/BrowserPanel.tsx')]: NULL_STUB,
  [r('src/renderer/components/Editor/EditorPanel.tsx')]: NULL_STUB,
  [r('src/renderer/components/Diff/DiffPanel.tsx')]: NULL_STUB,
  [r('src/renderer/components/Remote/RemotePaneSurface.tsx')]: NULL_STUB,
  [r('src/renderer/components/Remote/AddRemotePaneModal.tsx')]: NULL_STUB,
  [r('src/renderer/plugins/PluginPanels.tsx')]: NULL_STUB,
  [r('src/renderer/components/Sidebar/CompanyPanel.tsx')]: NULL_STUB,
  [r('src/renderer/components/Sidebar/PresetPicker.tsx')]: NULL_STUB,
  [r('src/renderer/components/Sidebar/WorkspaceAccountMenu.tsx')]: NULL_STUB,
  [r('src/renderer/components/Sidebar/WorkspaceChromeProfileMenu.tsx')]: NULL_STUB,
  // The chat view (SurfaceTabs prefetches it with a dynamic import) and the
  // desktop's own "start wmux web" toggle have nothing to do in the browser.
  [r('src/renderer/components/Chat/ChatView.tsx')]: NULL_STUB,
  [r('src/renderer/components/StatusBar/WebToggle.tsx')]: NULL_STUB,
};

export function webStubs(): Plugin {
  return {
    name: 'wmux-web-stubs',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      // The terminal stand-in wraps the real component: its own import of
      // Terminal.tsx must resolve to the file, not back to itself.
      if (slash(importer.split('?')[0]) === WEB_TERMINAL) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const stub = WEB_STUBS[slash(resolved.id.split('?')[0])];
      return stub ?? null;
    },
  };
}

export default defineConfig({
  root,
  base: '/app/',
  plugins: [webStubs(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The browser has no Node `process`; React and zustand read NODE_ENV.
    'process.env.NODE_ENV': JSON.stringify('production'),
    // Dogfood-only page hooks that read pane contents (main.tsx).
    __WMUX_WEB_DEBUG__: JSON.stringify(process.env.WMUX_WEB_DEBUG === '1'),
  },
  publicDir: false,
  build: {
    // Same target as the desktop renderer (see vite.renderer.config.ts for the
    // xterm logical-assignment miscompile below es2021). Browsers that cannot
    // parse es2022 are sent to the classic page by the es2017 boot script.
    target: 'es2022',
    outDir: r('dist/daemon-web-app'),
    emptyOutDir: true,
    assetsDir: 'assets',
    // Fonts must stay files: an inlined data: font would need `font-src data:`.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
    // One inlined script by design; the size is reported by build-daemon-web.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: r('src/renderer/web/main.tsx'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: (info) => (info.names?.[0]?.endsWith('.css') ? 'app.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
