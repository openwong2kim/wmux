import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
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
