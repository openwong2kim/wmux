import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      // Operational scripts (migration tooling) keep their tests
      // alongside the source so the algorithm and the test fixture stay
      // in lockstep. Pure ESM (no TS / no Vite transform required).
      'scripts/__tests__/**/*.test.mjs',
      // Plugin integrations (Phase 1 wmux × Claude Code) live outside
      // src/ so they can be packaged as Claude Code marketplace plugins
      // without dragging the rest of the repo. Tests for the
      // shared/signal-types boundary live next to the source.
      'integrations/**/__tests__/**/*.test.{ts,tsx}',
      // The APNs push relay is a separate Cloudflare Worker deployment (see
      // relay/README.md) but its tests run with the rest of the suite so a
      // change to the shared push envelope cannot break it unnoticed.
      'relay/__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
});
