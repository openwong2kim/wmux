// #3281 — the interrupted-turn row check runs in time linear in the row's
// length, and reads exactly what the anchored regex it replaces read.
import { describe, it, expect } from 'vitest';
import { INTERRUPTED_SENTENCE, isInterruptedRow } from '../AgentDetector';

const SKIP = '￿';

/** The pattern the walk replaces (as shipped in 4.15.0), kept here as the reference. */
const GAP = `[\\s${SKIP}]*?`;
const skippable = (phrase: string): string => phrase.split(' ')
  .map((word) => [...word].map((ch) => `[${ch.replace(/[\\\]^-]/g, '\\$&')}${SKIP}]`).join(''))
  .join(GAP);
const REFERENCE = new RegExp(`^[\\s${SKIP}]*[⎿${SKIP}]${GAP}(${skippable(INTERRUPTED_SENTENCE)})[\\s${SKIP}]*$`);
const drawn = (text: string): number => text.replace(/[\s￿]/g, '').length;
function reference(row: string): boolean {
  const m = REFERENCE.exec(row);
  return m !== null && drawn(INTERRUPTED_SENTENCE) - drawn(m[1]) <= 3;
}

/** A small seeded generator, so a failure names the same row on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('isInterruptedRow', () => {
  it('reads the row Claude Code draws, with its gutter drawn or skipped, and a few of its letters skipped', () => {
    expect(isInterruptedRow(`  ⎿  ${INTERRUPTED_SENTENCE}`)).toBe(true);
    expect(isInterruptedRow(`${SKIP.repeat(5)}${INTERRUPTED_SENTENCE}`)).toBe(true);
    expect(isInterruptedRow(`  ⎿  ${SKIP.repeat(3)}errupted · What should Claude do instead?`)).toBe(true);
    // Four letters missing is too many; nothing before the sentence is not the row.
    expect(isInterruptedRow(`  ⎿  ${SKIP.repeat(4)}rrupted · What should Claude do instead?`)).toBe(false);
    expect(isInterruptedRow(INTERRUPTED_SENTENCE)).toBe(false);
    expect(isInterruptedRow('⏺ Claude printed "Interrupted · What should Claude do instead?" there.')).toBe(false);
  });

  it("finishes at once on the reporter's long padded rows (the regex took seconds to minutes)", () => {
    for (const cells of [60, 70, 512, 5_000, 100_000]) {
      const row = `${SKIP.repeat(cells)} Claude will do this instead x`;
      const at = performance.now();
      expect(isInterruptedRow(row)).toBe(false);
      // Linear: a few ms per hundred thousand cells; the bound only catches a blow-up.
      expect(performance.now() - at).toBeLessThan(500);
    }
  });

  it('agrees with the regex it replaces on long padding around the real row and around near misses', () => {
    const rand = prng(3281);
    for (let i = 0; i < 300; i++) {
      const pad = (n: number) => Array.from({ length: n }, () => (rand() < 0.5 ? SKIP : ' ')).join('');
      // The sentence with up to five characters skipped and the gaps widened.
      const chars = [...INTERRUPTED_SENTENCE].map((c) => (c !== ' ' && rand() < 0.08 ? SKIP : c === ' ' ? pad(1 + Math.floor(rand() * 3)) : c));
      const gutter = rand() < 0.5 ? '⎿' : SKIP;
      const tail = rand() < 0.2 ? 'x' : pad(Math.floor(rand() * 40));
      const row = `${pad(Math.floor(rand() * 20))}${gutter}${pad(Math.floor(rand() * 4))}${chars.join('')}${tail}`;
      expect(isInterruptedRow(row), JSON.stringify(row)).toBe(reference(row));
    }
  });

  it('agrees with the regex it replaces on short random rows over its alphabet', () => {
    const rand = prng(42);
    const alphabet = [SKIP, SKIP, ' ', '⎿', '·', '?', 'x', ...new Set(INTERRUPTED_SENTENCE.replace(/ /g, ''))];
    for (let i = 0; i < 3_000; i++) {
      const row = Array.from({ length: Math.floor(rand() * 22) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      expect(isInterruptedRow(row), JSON.stringify(row)).toBe(reference(row));
    }
  });
});
