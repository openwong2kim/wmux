import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonSessionManager, SESSION_MANAGER_MAX_LISTENERS } from '../DaemonSessionManager';

// The daemon's subsystems subscribe to its session manager once at boot.
// This counts every subscription to an event in the daemon's non-test
// sources (any receiver, on/once/addListener/prependListener, either quote),
// so a new subscriber changes the count here and is weighed against the
// stated limit on purpose; a per-session listener would be a leak, not a
// reason to raise it.
const daemonDir = path.join(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sources(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

const all = sources(daemonDir).map((file) => fs.readFileSync(file, 'utf8')).join('\n');

function subscribers(event: string): number {
  const pattern = new RegExp(`\\.(?:on|once|addListener|prependListener)\\(\\s*['"\`]${event}['"\`]`, 'g');
  return all.match(pattern)?.length ?? 0;
}

describe('DaemonSessionManager listener limit', () => {
  it('is raised to the stated limit', () => {
    expect(new DaemonSessionManager().getMaxListeners()).toBe(SESSION_MANAGER_MAX_LISTENERS);
  });

  it('pins the boot-time subscribers of the busiest events, all below the limit', () => {
    expect(subscribers('session:died')).toBe(12);
    expect(subscribers('session:destroyed')).toBe(14);
    expect(Math.max(subscribers('session:died'), subscribers('session:destroyed'))).toBeLessThan(SESSION_MANAGER_MAX_LISTENERS);
  });

  it('does not warn with the daemon\'s subscriber count on its busiest event', async () => {
    const manager = new DaemonSessionManager();
    const busiest = Math.max(subscribers('session:died'), subscribers('session:destroyed'));
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => { if (w.name === 'MaxListenersExceededWarning') warnings.push(w); };
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < busiest; i++) manager.on('session:destroyed', () => undefined);
      expect(manager.listenerCount('session:destroyed')).toBe(busiest);
      // Node raises the warning on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });
});
