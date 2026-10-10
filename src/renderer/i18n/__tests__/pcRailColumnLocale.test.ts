import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { en } from '../locales/en';

/**
 * The computer column's own strings and the pairing scope copy ship in every
 * locale, with the English placeholders.
 */
const KEYS = [
  'pcRail.notChecked',
  'pcRail.access.revokeHintUnknown',
  'remote.scope.read',
  'remote.scope.viewOnly',
  'remote.scope.input',
  'remotePage.connect.pasteScope',
] as const;

const dir = path.resolve(__dirname, '../locales');
const placeholders = (v: string): string[] => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('PC column strings', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('finds every locale', () => expect(files.length).toBeGreaterThanOrEqual(23));
  for (const file of files) {
    it(`${file} carries every key with the English placeholders`, async () => {
      const mod = await import(path.join(dir, file)) as Record<string, Record<string, string>>;
      const map = Object.values(mod).find((v) => v && typeof v === 'object')!;
      for (const k of KEYS) {
        expect(typeof map[k], `${file} ${k}`).toBe('string');
        expect(placeholders(map[k]), `${file} ${k}`).toEqual(placeholders(en[k]));
      }
    });
  }
});
