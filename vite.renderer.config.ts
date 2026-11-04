import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
  // ASCII-only output: one character above one byte makes V8 keep the whole
  // script source as UTF-16 (scripts/lib/ascii-only-bundle.mjs).
  esbuild: { charset: 'ascii' },
  plugins: [react(), pdfjsAssets(), dropMainServedWasm(), asciiOnlyBundle()],
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
        // The lazy chunk of the Labs wongtty switch is named after its entry,
        // wongtty/dist/xterm.js, which reads as xterm.js in a listing of what
        // loaded. Name it after the package.
        chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => /[\\/]node_modules[\\/]wongtty[\\/]/.test(id))
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
