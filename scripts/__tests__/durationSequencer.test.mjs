// Duration-balanced shards (scripts/lib/duration-sequencer.mjs,
// scripts/lib/test-durations.mjs).
//
// These pin what the CI shards rely on: every file runs in exactly one shard,
// both shards of a run compute the same split whatever order vitest hands the
// files in, and the split follows the recorded durations, so one slow file no
// longer drags most of the other slow ones onto its shard.
import { describe, expect, it } from 'vitest';
import { DurationSequencer } from '../lib/duration-sequencer.mjs';
import {
  balanceShards,
  durationsFromVitestCache,
  median,
  mergeDurationReports,
  renderDurationsFile,
  updateDurations,
} from '../lib/test-durations.mjs';

const ROOT = '/repo';

// The slice of vitest's TestSpecification the sequencer reads.
function spec(file, project = 'integration') {
  return { moduleId: `${ROOT}/${file}`, project: { name: project }, pool: 'forks' };
}

function item(file, project = 'integration') {
  return { path: file, project };
}

// Deterministic shuffle (a fixed LCG), so a failure reproduces.
function shuffled(list, seed) {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function totals(shards, durations) {
  return shards.map((shard) =>
    shard.reduce((sum, it) => sum + (durations[it.project]?.[it.path] ?? 0), 0),
  );
}

const paths = (shards) => shards.map((shard) => shard.map((it) => it.path).sort());

// One 134 s file (the slowest integration file measured) and 60 small ones.
function skewed() {
  const integration = { 'src/slow/__tests__/huge.test.ts': 134_000 };
  for (let i = 0; i < 60; i++) {
    integration[`src/m${String(i).padStart(2, '0')}/__tests__/m.test.ts`] = 500 + ((i * 7919) % 9000);
  }
  return { integration };
}

describe('balanceShards', () => {
  it('puts every file in exactly one shard, for any shard count', () => {
    const durations = skewed();
    const items = Object.keys(durations.integration).map((f) => item(f));
    for (const count of [1, 2, 3, 4, 7]) {
      const shards = balanceShards(items, durations, count);
      expect(shards).toHaveLength(count);
      const all = shards.flat().map((it) => it.path);
      expect(all.sort()).toEqual(items.map((it) => it.path).sort());
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('gives the same split whatever order the files come in', () => {
    const durations = skewed();
    const items = Object.keys(durations.integration).map((f) => item(f));
    // Files with equal weight too: the tie-break must not depend on order.
    for (let i = 0; i < 10; i++) items.push(item(`src/tie${i}/__tests__/t.test.ts`));
    const expected = paths(balanceShards(items, durations, 3));
    for (const seed of [1, 2, 3, 42, 1000]) {
      expect(paths(balanceShards(shuffled(items, seed), durations, 3))).toEqual(expected);
    }
  });

  it('balances the totals around one very slow file', () => {
    const durations = skewed();
    const items = Object.keys(durations.integration).map((f) => item(f));
    const [a, b] = totals(balanceShards(items, durations, 2), durations);
    const sum = a + b;
    // Every small file is under 10 s, and LPT ends within one file of even.
    expect(Math.abs(a - b)).toBeLessThan(10_000);
    expect(Math.max(a, b)).toBeLessThan(sum / 2 + 10_000);
    // The slow file sits alone with fewer files, not with half of them.
    const shards = balanceShards(items, durations, 2);
    const slowShard = shards.find((s) => s.some((it) => it.path.includes('huge')));
    expect(slowShard.length).toBeLessThan(items.length / 2);
  });

  it('weighs a file with no recorded duration as the median of its project', () => {
    const durations = {
      integration: { 'a.test.ts': 1_000, 'b.test.ts': 2_000, 'c.test.ts': 6_000, 'd.test.ts': 7_000 },
      // Another project's numbers do not move this one's median.
      unit: { 'u.test.ts': 900_000 },
    };
    expect(median(Object.values(durations.integration))).toBe(4_000);
    const items = ['a', 'b', 'c', 'd', 'new'].map((f) => item(`${f}.test.ts`));
    // `new` weighs 4 s: d (7) | c (6) + new (4) | b (2) and a (1) on the d side.
    // Weighed as 0 it would go last, onto the d side, and b would join c.
    expect(paths(balanceShards(items, durations, 2))).toEqual([
      ['a.test.ts', 'b.test.ts', 'd.test.ts'],
      ['c.test.ts', 'new.test.ts'],
    ]);
  });

  it('splits by file count when nothing is recorded', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => item(`${f}.test.ts`, 'unit'));
    expect(balanceShards(items, {}, 2).map((s) => s.length)).toEqual([4, 3]);
    expect(balanceShards(items, {}, 3).map((s) => s.length)).toEqual([3, 2, 2]);
  });

  it('breaks a tie on the total by file count, so zero-cost files do not pile onto shard 1', () => {
    const durations = { unit: { 'z1.test.ts': 0, 'z2.test.ts': 0, 'z3.test.ts': 0, 'z4.test.ts': 0 } };
    const items = Object.keys(durations.unit).map((f) => item(f, 'unit'));
    expect(paths(balanceShards(items, durations, 2))).toEqual([
      ['z1.test.ts', 'z3.test.ts'],
      ['z2.test.ts', 'z4.test.ts'],
    ]);
  });

  it('balances each project on its own and gives every shard a share of both', () => {
    const durations = {
      unit: { 'u1.test.ts': 4_000, 'u2.test.ts': 4_000, 'u3.test.ts': 1_000, 'u4.test.ts': 1_000 },
      integration: { 'i1.test.ts': 60_000, 'i2.test.ts': 30_000, 'i3.test.ts': 30_000 },
    };
    const items = [
      ...Object.keys(durations.unit).map((f) => item(f, 'unit')),
      ...Object.keys(durations.integration).map((f) => item(f, 'integration')),
    ];
    const shards = balanceShards(shuffled(items, 7), durations, 2);
    for (const shard of shards) {
      expect(shard.some((it) => it.project === 'unit')).toBe(true);
      expect(shard.some((it) => it.project === 'integration')).toBe(true);
    }
    const perProject = (project) =>
      totals(
        shards.map((s) => s.filter((it) => it.project === project)),
        durations,
      );
    expect(perProject('integration')).toEqual([60_000, 60_000]);
    expect(perProject('unit')).toEqual([5_000, 5_000]);
    // Pooled together instead, the 60 s file would take a shard to itself and
    // leave every unit file to the other one.
  });
});

describe('DurationSequencer', () => {
  function sequencer(index, count, durations) {
    const s = new DurationSequencer({ config: { root: ROOT, shard: { index, count } } });
    s.loadDurations = () => durations;
    return s;
  }

  it('returns the 1-based shard of vitest.durations.json\'s split, covering every spec once', async () => {
    const durations = skewed();
    const specs = Object.keys(durations.integration).map((f) => spec(f));
    const first = await sequencer(1, 2, durations).shard(shuffled(specs, 3));
    const second = await sequencer(2, 2, durations).shard(specs);
    expect(first.length + second.length).toBe(specs.length);
    expect(new Set([...first, ...second]).size).toBe(specs.length);
    expect(first.map((s) => s.moduleId)).toContain(`${ROOT}/src/slow/__tests__/huge.test.ts`);
  });
});

describe('vitest.durations.json', () => {
  it('renders sorted, rounded up to 10 ms, with a trailing newline', () => {
    const text = renderDurationsFile({
      unit: { 'b.test.ts': 141.9, 'a.test.ts': 2_000, 'c.test.ts': 0 },
      integration: { 'z.test.ts': 0.2 },
    });
    // A file that cost anything is never written down as 0 ms.
    expect(text).toBe(
      '{\n  "integration": {\n    "z.test.ts": 10\n  },\n  "unit": {\n    "a.test.ts": 2000,\n    "b.test.ts": 150,\n    "c.test.ts": 0\n  }\n}\n',
    );
  });

  it('takes the median of each file across runs, for the lanes asked for only', () => {
    const report = (project, files) => ({ version: 1, project, shard: '1/2', platform: 'linux', files });
    const merged = mergeDurationReports(
      [
        report('unit', { 'a.test.ts': 100, 'b.test.ts': 900 }),
        report('unit', { 'a.test.ts': 300 }),
        report('unit', { 'a.test.ts': 5_000, 'gone.test.ts': 1 }),
        report('runtime', { 'r.runtime.test.ts': 1 }),
      ],
      { projects: ['unit', 'integration'], testFiles: new Set(['a.test.ts', 'b.test.ts']) },
    );
    expect(merged).toEqual({ unit: { 'a.test.ts': 300, 'b.test.ts': 900 } });
  });

  it('seeds from the vitest results cache, filing unnamed keys by the lane their name gives', () => {
    const cache = {
      version: '5.0.0',
      results: [
        [':src/a/__tests__/spawn.os.test.ts', { duration: 12_000, failed: false }],
        [':src\\b\\__tests__\\pure.test.ts', { duration: 40, failed: false }],
        ['unit:src/c/__tests__/named.test.ts', { duration: 700, failed: true }],
        [':src/deleted/__tests__/old.test.ts', { duration: 1, failed: false }],
      ],
    };
    const testFiles = new Set([
      'src/a/__tests__/spawn.os.test.ts',
      'src/b/__tests__/pure.test.ts',
      'src/c/__tests__/named.test.ts',
    ]);
    const expected = {
      integration: { 'src/a/__tests__/spawn.os.test.ts': 12_000 },
      unit: { 'src/b/__tests__/pure.test.ts': 40, 'src/c/__tests__/named.test.ts': 700 },
    };
    expect(durationsFromVitestCache(cache, { testFiles })).toEqual(expected);
    // The object form of `results` reads the same.
    const asObject = { version: '5.0.0', results: Object.fromEntries(cache.results) };
    expect(durationsFromVitestCache(asObject, { testFiles })).toEqual(expected);
  });

  it('leaves a lane the input has no file for as it was', () => {
    const current = {
      integration: { 'src/a/__tests__/spawn.os.test.ts': 30_000 },
      unit: { 'src/b/__tests__/pure.test.ts': 900 },
    };
    const testFiles = new Set(['src/a/__tests__/spawn.os.test.ts', 'src/b/__tests__/pure.test.ts']);
    // A cache that ran the unit lane only.
    const unitOnly = durationsFromVitestCache(
      { version: '5.0.0', results: [['unit:src/b/__tests__/pure.test.ts', { duration: 400, failed: false }]] },
      { testFiles },
    );
    expect(Object.keys(unitOnly)).toEqual(['unit']);
    expect(updateDurations(current, unitOnly, ['unit', 'integration'])).toEqual({
      unit: { 'src/b/__tests__/pure.test.ts': 400 },
      integration: { 'src/a/__tests__/spawn.os.test.ts': 30_000 },
    });
    // CI reports whose integration files were all deleted since: same.
    const report = (project, files) => ({ version: 1, project, shard: null, platform: 'linux', files });
    const merged = mergeDurationReports(
      [report('unit', { 'src/b/__tests__/pure.test.ts': 700 }), report('integration', { 'src/gone.test.ts': 5 })],
      { projects: ['unit', 'integration'], testFiles },
    );
    expect(updateDurations(current, merged, ['unit', 'integration']).integration).toEqual(current.integration);
  });
});
