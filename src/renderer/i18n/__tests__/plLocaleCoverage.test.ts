import { describe, it, expect } from 'vitest';
import { en } from '../locales/en';
import { pl } from '../locales/pl';

// Polish went from 26% key coverage (374/1464, the same stalled point every
// locale but ko/zh sits at — see #997's note that the maintainer won't
// machine-translate a language he can't verify) to full coverage in one pass.
// This locks the two things a translation pass can silently break without
// anyone noticing until a user hits the fallback or a runtime crash:
//   1. Coverage drift — a future en.ts addition landing with no pl string,
//      silently falling back to English in an otherwise Polish UI (exactly
//      how workspace.agentAwaitingInput was missing before #1000).
//   2. Placeholder drift — a typo'd or dropped {name} in the pl value, which
//      t()'s String.replace-based interpolation would leave un-substituted
//      in the UI rather than throwing, so nothing else would catch it.
// Scoped to pl only: the other 20 stalled locales are a known, accepted gap
// (untranslatable without a speaker to verify quality), not a regression to
// chase here.

function placeholdersOf(value: string): Set<string> {
  const out = new Set<string>();
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.add(m[1]);
  return out;
}

describe('pl locale coverage (#997 follow-up: en/ko/zh are the only verified-complete locales)', () => {
  const enKeys = Object.keys(en) as (keyof typeof en)[];
  const plKeys = Object.keys(pl);
  const plKeySet = new Set(plKeys);
  const enKeySet = new Set(enKeys as string[]);

  it('has a Polish string for every English key', () => {
    const missing = enKeys.filter((k) => !plKeySet.has(k));
    expect(missing).toEqual([]);
  });

  it('carries no orphan keys en.ts no longer has', () => {
    const orphans = plKeys.filter((k) => !enKeySet.has(k));
    expect(orphans).toEqual([]);
  });

  it('matches every {placeholder} set exactly against the English source', () => {
    const mismatches: string[] = [];
    for (const key of enKeys) {
      const enSet = placeholdersOf(en[key]);
      const plValue = pl[key as keyof typeof pl];
      const plSet = placeholdersOf(plValue);
      const enOnly = [...enSet].filter((p) => !plSet.has(p));
      const plOnly = [...plSet].filter((p) => !enSet.has(p));
      if (enOnly.length || plOnly.length) {
        mismatches.push(`${String(key)}: en-only=[${enOnly}] pl-only=[${plOnly}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('never returns an empty string for a real key', () => {
    const blank = plKeys.filter((k) => pl[k as keyof typeof pl].trim().length === 0);
    expect(blank).toEqual([]);
  });
});
