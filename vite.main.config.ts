import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
