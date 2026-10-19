import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { realProfileBrowserEnv } from '../realProfileBrowserEnv';

describe('realProfileBrowserEnv', () => {
  it.runIf(process.platform === 'win32')(
    'hands the browser the real USERPROFILE and keeps the rest of the environment',
    () => {
      const realHome = process.env.WMUX_TEST_REAL_HOME;
      expect(realHome).toBeDefined();
      // The vitest process itself stays isolated.
      expect(os.homedir()).not.toBe(realHome);

      const env = realProfileBrowserEnv();
      expect(env?.USERPROFILE).toBe(realHome);
      // Playwright replaces the child environment, so everything else must survive.
      expect(env?.PATH ?? env?.Path).toBe(process.env.PATH ?? process.env.Path);
      expect(env?.WMUX_DATA_SUFFIX).toBe(process.env.WMUX_DATA_SUFFIX);
      // The caller's environment is not mutated.
      expect(process.env.USERPROFILE).not.toBe(realHome);
    },
  );

  it.runIf(process.platform !== 'win32')('leaves the environment to Playwright off Windows', () => {
    expect(realProfileBrowserEnv()).toBeUndefined();
  });
});
