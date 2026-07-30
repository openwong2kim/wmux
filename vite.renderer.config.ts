import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
          ],
          'vendor-react': ['react', 'react-dom'],
        },
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
