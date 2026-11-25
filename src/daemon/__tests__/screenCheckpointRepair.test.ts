// One redraw for a pane whose rebuilt screen checkpoint left part of its composer unseen.
import { describe, expect, it } from 'vitest';
import { REPAIR_REST_POLLS, repairUnseenScreen, type ScreenRepairDeps } from '../screenCheckpointRepair';

function fake(overrides: Partial<ScreenRepairDeps> & { rest?: boolean[] } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const rest = overrides.rest;
  const deps: ScreenRepairDeps = {
    atRest: () => (rest ? rest[Math.min(polls, rest.length - 1)] : true),
    composerUnseen: async () => true,
    size: () => ({ cols: 80, rows: 24 }),
    resizePty: (cols, rows) => { calls.push(`resize ${cols}x${rows}`); },
    pause: (on) => { calls.push(on ? 'pause' : 'resume'); },
    refresh: async () => { calls.push('refresh'); return true; },
    delay: async (ms) => { if (ms >= 30_000) polls++; },
    noteNudge: () => { calls.push('count'); },
    log: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

describe('repairUnseenScreen', () => {
  it('a pane at rest is resized one column wider and back once, then a fresh checkpoint is taken', async () => {
    const { deps, calls } = fake();
    const lineage = { nudged: false };
    expect(await repairUnseenScreen(lineage, deps)).toBe('nudged');
    expect(calls).toEqual(['count', 'pause', 'resize 81x24', 'resize 80x24', 'resume', 'refresh']);
    expect(lineage.nudged).toBe(true);
    // The same chain is never redrawn twice.
    expect(await repairUnseenScreen(lineage, deps)).toBe('not-needed');
    expect(calls.filter((c) => c.startsWith('resize'))).toHaveLength(2);
  });

  it('no redraw while a turn runs: it waits for rest, then redraws once', async () => {
    const { deps, calls } = fake({ rest: [false, false, true] });
    expect(await repairUnseenScreen({ nudged: false }, deps)).toBe('nudged');
    expect(calls.filter((c) => c.startsWith('resize'))).toEqual(['resize 81x24', 'resize 80x24']);
  });

  it('a pane that never comes to rest is left alone', async () => {
    const { deps, calls } = fake({ rest: [false] });
    expect(await repairUnseenScreen({ nudged: false }, deps)).toBe('gave-up');
    expect(calls).toEqual([]);
    expect(REPAIR_REST_POLLS).toBeGreaterThan(1);
  });

  it('a composer the read sees whole needs no redraw', async () => {
    const { deps, calls } = fake({ composerUnseen: async () => false });
    expect(await repairUnseenScreen({ nudged: false }, deps)).toBe('not-needed');
    expect(calls).toEqual([]);
  });

  it('comes back to the size the daemon keeps now, if a person resized meanwhile', async () => {
    let size = { cols: 80, rows: 24 };
    const { deps, calls } = fake({ size: () => size, delay: async (ms) => { if (ms < 1000) size = { cols: 100, rows: 30 }; } });
    await repairUnseenScreen({ nudged: false }, deps);
    expect(calls.filter((c) => c.startsWith('resize'))).toEqual(['resize 81x24', 'resize 100x30']);
  });
});
