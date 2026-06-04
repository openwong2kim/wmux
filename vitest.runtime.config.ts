import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.runtime.test.{ts,tsx}',
      'scripts/__tests__/**/*.runtime.test.mjs',
      'integrations/**/__tests__/**/*.runtime.test.{ts,tsx}',
    ],
    environment: 'node',
    fileParallelism: false,
  },
});
