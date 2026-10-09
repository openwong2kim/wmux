import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';

const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
const scheduleKeys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => k.startsWith('schedules.'));

describe('scheduled runs locale coverage', () => {
  it('covers every run state, reason, mode and toast word the UI builds keys for', () => {
    const built = [
      ...['launching', 'running', 'awaiting', 'completed', 'failed', 'skipped', 'unknown'].map((s) => `schedules.state.${s}`),
      ...['overlap', 'missed', 'daemon_down', 'first_run_blocked', 'launch_failed', 'account_missing', 'await_timeout',
        'timeout', 'agent_error', 'process_exit', 'interrupted', 'cancelled', 'needs_regrant'].map((r) => `schedules.reason.${r}`),
      ...['approval', 'scoped', 'auto', 'bypass'].flatMap((m) => [`schedules.mode.${m}`, `schedules.modeDesc.${m}`]),
      ...['awaiting', 'failed', 'proposed', 'grantRaised', 'needsRegrant'].map((k) => `schedules.toast.${k}`),
    ];
    for (const key of built) expect(scheduleKeys).toContain(key);
  });

  for (const [name, messages] of Object.entries({ ko, pl })) {
    it(`${name} owns every schedules string with the same placeholders`, () => {
      const table = messages as Record<string, string>;
      for (const key of scheduleKeys) {
        expect(table[key], key).toBeTruthy();
        expect(placeholders(table[key]), key).toEqual(placeholders(en[key]));
      }
    });
  }
});
