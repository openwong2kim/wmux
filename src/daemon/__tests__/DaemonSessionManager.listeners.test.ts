import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonSessionManager, SESSION_MANAGER_MAX_LISTENERS } from '../DaemonSessionManager';

// The daemon subscribes to its session manager once at boot, from
// src/daemon/index.ts and codexThreadOwner.ts. These counts pin that set:
// a new subscriber changes a count here and the list on
// SESSION_MANAGER_MAX_LISTENERS, so the limit is raised on purpose, not
// silenced for a per-session listener that would be a leak.
const daemonDir = path.join(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(daemonDir, file), 'utf8');
const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

function subscribers(event: string): number {
  const index = count(read('index.ts'), new RegExp(`sessionManager\\.on\\('${event}'`, 'g'));
  const codex = count(read(path.join('web', 'codexThreadOwner.ts')), new RegExp(`events\\.on\\('${event}'`, 'g'));
  return index + codex;
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

  it('does not warn with the daemon\'s subscriber count on one event', async () => {
    const manager = new DaemonSessionManager();
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => { if (w.name === 'MaxListenersExceededWarning') warnings.push(w); };
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < 14; i++) manager.on('session:destroyed', () => undefined);
      expect(manager.listenerCount('session:destroyed')).toBe(14);
      // Node raises the warning on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });
});
