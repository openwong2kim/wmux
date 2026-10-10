import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';
import { pl } from '../locales/pl';

const keys = ['moa.settings.fleetFastPath', 'moa.settings.fleetFastPathDesc'] as const;

describe('Fleet fast path setting locale coverage', () => {
  for (const [name, messages] of Object.entries({ en, ko, zh, pl })) {
    it(`${name} has its own label and description`, () => {
      const table = messages as Record<string, string>;
      for (const key of keys) {
        expect(table[key], key).toBeTruthy();
        if (name !== 'en') expect(table[key], key).not.toBe(en[key]);
      }
    });
  }
});
