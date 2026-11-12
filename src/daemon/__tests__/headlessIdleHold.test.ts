import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level wiring check (as squirrelWiring.test.ts): a host in headless
// mode waits for other PCs with no client and no session of its own, so the
// idle shutdown must count headless mode as activity. The Watchdog side is
// tested in Watchdog.test.ts; this pins what index.ts feeds it.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

describe('idle shutdown and headless mode (index.ts wiring)', () => {
  it('the idle check reports headless mode as a hold', () => {
    const check = src.slice(src.indexOf('onIdleCheck: () => ({'), src.indexOf('onIdleShutdown:'));
    expect(check).toMatch(/remoteStarts: idleHoldForRemoteStarts\(\) \? 1 : 0/);
  });

  it('the hold is headless mode being in effect, off until the a2a stack sets it', () => {
    expect(src).toMatch(/let idleHoldForRemoteStarts: \(\) => boolean = \(\) => false;/);
    expect(src).toMatch(/idleHoldForRemoteStarts = \(\) => headlessMode\.active\(\);/);
  });
});
