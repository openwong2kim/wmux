import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';
import { pl } from '../locales/pl';

/**
 * The cross-PC link screens (Settings › LAN pairing, the link dialog, the
 * Remote page's link rows and Needs you block) and the remote-workspace
 * pairing errors ship in every locale that carries them (ko, zh, pl), with
 * the English placeholders. ko once had only `remote.pairAgain` of the 14
 * `remote.pair*` keys, so a Korean user saw English exactly when pairing
 * failed.
 *
 * Scoped by prefix, not to every key: ko and zh still miss several hundred
 * keys elsewhere (an accepted gap, see plLocaleCoverage.test.ts), which a
 * whole-catalogue guard would have to allowlist wholesale.
 */
const PREFIXES = [
  /^settings\.a2aRemote/,
  /^settings\.a2aExposure/,
  /^a2aLink\./,
  /^a2aOffer\./,
  /^a2aShare\./,
  /^a2aDelivery\./,
  /^remote\.pair/,
  /^remotePage\.needs\./,
  /^remotePage\.discover\./,
  /^remotePage\.(moaLink|fingerprint|copyFingerprint)$/,
];

const KEYS = (Object.keys(en) as (keyof typeof en)[]).filter((k) => PREFIXES.some((re) => re.test(k)));

const placeholders = (v: string): string[] => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('cross-PC link and pairing strings', () => {
  it('finds keys under every prefix', () => {
    for (const re of PREFIXES) expect(KEYS.some((k) => re.test(k)), String(re)).toBe(true);
  });

  for (const [name, locale] of [['ko', ko], ['zh', zh], ['pl', pl]] as const) {
    it(`${name} carries every key with the English placeholders`, () => {
      const map = locale as Record<string, string | undefined>;
      const missing = KEYS.filter((k) => typeof map[k] !== 'string');
      expect(missing).toEqual([]);
      const drift = KEYS.filter((k) => placeholders(map[k] as string).join() !== placeholders(en[k]).join());
      expect(drift).toEqual([]);
    });
  }
});

/**
 * Moa was removed (2026-10-14) and its role is the Coordinator now
 * (`room.role.moa`). Only the wire alias `A2A_BRAIN_ALIAS` keeps the old
 * name, because other PCs and older builds depend on it; nothing a person
 * reads may say "Moa". Every locale file, including ones added later.
 */
const dir = path.resolve(__dirname, '../locales');

describe('no Moa on screen', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('finds every locale', () => expect(files.length).toBeGreaterThanOrEqual(23));

  it('no locale value names Moa', async () => {
    const hits: string[] = [];
    for (const file of files) {
      const mod = await import(path.join(dir, file)) as Record<string, unknown>;
      for (const map of Object.values(mod)) {
        if (!map || typeof map !== 'object') continue;
        for (const [key, value] of Object.entries(map)) {
          if (typeof value === 'string' && /\bMoas?\b/.test(value)) hits.push(`${file} ${key}: ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
