import { defineConfig, normalizePath, type Plugin } from 'vite';
import { build as esbuild } from 'esbuild';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import pkg from './package.json';
import { asciiOnlyBundle } from './scripts/lib/ascii-only-bundle.mjs';

// The PDF preview (#2150) runs pdf.js with its worker, CMaps (CJK text),
// standard fonts and WebAssembly decoders as plain same-origin files under
// `pdfjs/` next to the page: no blob: or inline worker, nothing the
// production CSP has to loosen for. Served from node_modules in dev, copied
// into the bundle on build.
const PDFJS_DIR = path.resolve(__dirname, 'node_modules/pdfjs-dist');
const PDFJS_FILES: Record<string, string> = {
  'build/pdf.worker.min.mjs': 'build/pdf.worker.min.mjs',
  cmaps: 'cmaps',
  standard_fonts: 'standard_fonts',
  wasm: 'wasm',
  iccs: 'iccs',
};

function pdfjsAssets(): Plugin {
  return {
    name: 'wmux-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const top = Object.keys(PDFJS_FILES).find((key) => rel === key || rel.startsWith(`${key}/`));
        const file = top ? path.join(PDFJS_DIR, rel) : '';
        if (!file || !file.startsWith(PDFJS_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript');
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      for (const [from, to] of Object.entries(PDFJS_FILES)) {
        fs.cpSync(path.join(PDFJS_DIR, from), path.join(options.dir, 'pdfjs', to), { recursive: true });
      }
    },
  };
}

// onnxruntime-web's .wasm reaches the dictation worker as bytes from main
// (it ships as an extra resource: main/dictation/dictation.handler.ts), and
// so do wongtty's two (Labs terminal switch: main/ipc/handlers/labs.handler.ts),
// so the copies Vite emits for the packages' own `new URL(…, import.meta.url)`
// are never read. Leaving them out keeps 15 MB out of the bundle.
function dropMainServedWasm(): Plugin {
  return {
    name: 'wmux-drop-main-served-wasm',
    generateBundle(_options, bundle) {
      for (const file of Object.keys(bundle)) {
        if (/(^|\/)(ort-wasm-simd-threaded|wongtty|xterm_web_bg)[^/]*\.wasm$/.test(file)) delete bundle[file];
      }
    },
  };
}

// The Labs wongtty switch (renderer/terminal/wongtty/load.ts) gives wongtty's
// memory back when it is turned off. An ES module can never be unloaded (the
// page's module map keeps it), and wongtty's bindings keep their WebAssembly
// instances, and every JS object handed to them, in module-level variables.
// So terminal/wongtty/factory.ts is built here as the whole package bundled
// into one function: each call evaluates it afresh with its own instances, and
// dropping what a call returned lets all of it be collected. Its exports come
// back as plain data properties: a bundler's getter-based exports object puts
// its getters in a hidden class V8 shares with unrelated module objects, which
// would keep the package alive for good.
//
// The module id Vite hands to `load` is the file's real path (symlinks
// resolved), with forward slashes and maybe a query, and on Windows its drive
// letter's case need not match __dirname's: both sides are compared that way.
function canonicalId(file: string): string {
  let real = file;
  try { real = fs.realpathSync.native(file); } catch { /* not on disk: compared as given */ }
  const id = normalizePath(real);
  return process.platform === 'win32' ? id.toLowerCase() : id;
}
const WONGTTY_FACTORY = canonicalId(path.resolve(__dirname, 'src/renderer/terminal/wongtty/factory.ts'));
export function wongttyFactory(): Plugin {
  return {
    name: 'wmux-wongtty-factory',
    async load(id) {
      const file = normalizePath(id.split('?')[0]);
      if (!file.endsWith('/wongtty/factory.ts') || canonicalId(file) !== WONGTTY_FACTORY) return null;
      const result = await esbuild({
        entryPoints: [path.resolve(__dirname, 'node_modules/wongtty/dist/xterm.js')],
        bundle: true, write: false, format: 'esm',
        platform: 'browser', target: 'es2022', charset: 'ascii', logLevel: 'warning',
      });
      // esbuild ends an ES module bundle with its one export statement.
      const code = result.outputFiles[0].text;
      const at = code.lastIndexOf('export {');
      const end = code.indexOf('};', at);
      if (at < 0 || end < 0 || code.slice(end + 2).trim() !== '' || /^export /m.test(code.slice(0, at))) {
        throw new Error('wongtty factory: the bundle does not end with its only export statement');
      }
      const exported = code.slice(at + 'export {'.length, end).split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
        const [local, name = local] = spec.split(/\s+as\s+/);
        return `${JSON.stringify(name)}: ${local}`;
      });
      return `export function createWongtty() {\n${code.slice(0, at)}\nreturn { ${exported.join(', ')} };\n}\n`;
    },
  };
}

export default defineConfig({
  // ASCII-only output: one character above one byte makes V8 keep the whole
  // script source as UTF-16 (scripts/lib/ascii-only-bundle.mjs).
  esbuild: { charset: 'ascii' },
  plugins: [react(), pdfjsAssets(), dropMainServedWasm(), wongttyFactory(), asciiOnlyBundle()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Voice dictation's speech engine (renderer/dictation/whisper.worker.ts)
  // is an ES module worker: onnxruntime-web is ESM.
  worker: {
    format: 'es',
    plugins: () => [dropMainServedWasm(), asciiOnlyBundle()],
  },
  build: {
    // The renderer only ever runs inside this app's own Chromium (Electron 41 →
    // Chrome 146), so Vite's default `modules` target (es2020) buys nothing and
    // actively MISCOMPILES a dependency: below es2021 esbuild lowers logical
    // assignment (`a ||= b`) to `a || (a = b)`, and for a binding it has proved
    // dead it then drops the `let a;` declaration while KEEPING the write. In
    // @xterm/xterm 6's `InputHandler.requestMode` (the DECRQM `CSI ? Ps $ p`
    // handler) that produced `void 0 || (i = {})` with no declaration for `i`,
    // which throws `ReferenceError: i is not defined` under ESM strict mode the
    // first time any TUI probes terminal modes. The throw escapes xterm's
    // WriteBuffer._innerWrite, so that pane's write buffer never advances again:
    // the pane freezes and every reader of it (input.readScreen / pane.search)
    // hangs on the parse barrier. Targeting es2022 keeps `||=` intact.
    target: 'es2022',
    rollupOptions: {
      // Two pages: the app, and the global quick-launch composer window
      // (main/quickLaunch), which loads none of the app.
      input: {
        main_window: path.resolve(__dirname, 'index.html'),
        launcher: path.resolve(__dirname, 'launcher.html'),
      },
      output: {
        // TASK-2: split heavy, stable vendor bundles out of the main chunk so
        // they cache independently and stay off the app's hot rebuild path.
        manualChunks: {
          'vendor-xterm': [
            '@xterm/xterm',
            '@xterm/addon-fit',
            '@xterm/addon-webgl',
            '@xterm/addon-search',
            '@xterm/addon-unicode11',
            '@xterm/addon-web-links',
            '@xterm/addon-serialize',
          ],
          'vendor-react': ['react', 'react-dom'],
        },
        // The lazy chunk of the Labs wongtty switch (wongttyFactory above) is
        // named after the package, so a listing of what loaded shows it.
        chunkFileNames: (chunk) => (chunk.moduleIds.includes(WONGTTY_FACTORY)
          ? 'assets/wongtty-[hash].js'
          : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    // Pin the dev server to IPv4 loopback. When Vite binds localhost to IPv6
    // ([::1]) only, Electron's loadURL('http://localhost:5173') can resolve to
    // IPv4 (127.0.0.1) first and hit ERR_CONNECTION_REFUSED — a blank window in
    // dev. Forcing 127.0.0.1 keeps the served URL and the loaded URL on the same
    // stack.
    host: '127.0.0.1',
  },
});
