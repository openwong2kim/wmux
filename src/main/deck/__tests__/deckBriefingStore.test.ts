// Unit tests for the briefing config + snapshot store: default-on config,
// partial-merge saves that preserve snapshots (and vice-versa), snapshot
// round-trip, SERIALIZED read-modify-write (no lost updates), snapshot pruning,
// torn-file → defaults (never throws), and suffix isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRIEFED_SNAPSHOT_TTL_MS,
  DEFAULT_BRIEFING,
  loadDeckBriefingConfig,
  saveDeckBriefingConfig,
  loadBriefedSnapshot,
  saveBriefedSnapshot,
  readBriefedSnapshot,
  readDeckBriefingConfig,
  getDeckBriefingPath,
} from '../deckBriefingStore';
import type { BriefedSnapshot } from '../deckBriefing';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-briefing-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fixed once per run: `at` must be a realistic clock reading, because every
// snapshot save prunes entries older than BRIEFED_SNAPSHOT_TTL_MS and a toy
// timestamp reads as a month-old snapshot.
const NOW = Date.now();

const snap = (over: Partial<BriefedSnapshot> = {}): BriefedSnapshot => ({
  panes: [{ ptyId: 'p1', agentStatus: 'running' }],
  decisionId: null,
  at: NOW,
  ...over,
});

describe('deckBriefingStore — config', () => {
  it('missing file resolves to the default (enabled + autoShow on)', () => {
    expect(DEFAULT_BRIEFING).toEqual({ enabled: true, autoShow: true });
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: true, autoShow: true });
  });

  it('round-trips a full config through the file', async () => {
    const saved = await saveDeckBriefingConfig({ enabled: false, autoShow: false }, dir);
    expect(saved).toEqual({ enabled: false, autoShow: false });
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: false });
  });

  it('a partial save preserves the other field', async () => {
    await saveDeckBriefingConfig({ enabled: false }, dir);
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: true });
    await saveDeckBriefingConfig({ autoShow: false }, dir);
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: false });
  });

  it('a config save preserves stored snapshots', async () => {
    await saveBriefedSnapshot('ws-1', snap(), dir);
    await saveDeckBriefingConfig({ enabled: false }, dir);
    expect(loadBriefedSnapshot('ws-1', dir)).toEqual(snap());
  });
});

describe('deckBriefingStore — snapshots', () => {
  it('round-trips a per-workspace snapshot', async () => {
    await saveBriefedSnapshot('ws-1', snap({ decisionId: 'dec-1', at: 9 }), dir);
    expect(loadBriefedSnapshot('ws-1', dir)).toEqual(snap({ decisionId: 'dec-1', at: 9 }));
    expect(loadBriefedSnapshot('ws-2', dir)).toBeNull();
  });

  it('a snapshot save preserves config + other workspaces', async () => {
    await saveDeckBriefingConfig({ enabled: false }, dir);
    await saveBriefedSnapshot('ws-1', snap(), dir);
    await saveBriefedSnapshot('ws-2', snap({ decisionId: 'x' }), dir);
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: true });
    expect(loadBriefedSnapshot('ws-1', dir)).toEqual(snap());
    expect(loadBriefedSnapshot('ws-2', dir)).toEqual(snap({ decisionId: 'x' }));
  });

  it('drops panes with an invalid status on load (sanitized)', async () => {
    fs.writeFileSync(
      getDeckBriefingPath(dir),
      JSON.stringify({
        config: DEFAULT_BRIEFING,
        snapshots: { 'ws-1': { panes: [{ ptyId: 'ok', agentStatus: 'running' }, { ptyId: 'bad', agentStatus: 'nonsense' }], decisionId: null, at: 1 } },
      }),
      'utf8',
    );
    expect(loadBriefedSnapshot('ws-1', dir)?.panes).toEqual([{ ptyId: 'ok', agentStatus: 'running' }]);
  });
});

describe('deckBriefingStore — an equivalent acknowledge costs no IO', () => {
  // The card now acknowledges EVERY briefing it genuinely shows (a no-delta one
  // included, or the baseline never advances past a stale block). The "don't
  // hammer the disk" property therefore lives here.
  it('re-saving the same observed state does not write', async () => {
    expect(await saveBriefedSnapshot('ws-1', snap(), dir)).toBe(true);
    const before = fs.statSync(getDeckBriefingPath(dir)).mtimeMs;
    expect(await saveBriefedSnapshot('ws-1', snap({ at: NOW + 5000 }), dir)).toBe(false);
    expect(fs.statSync(getDeckBriefingPath(dir)).mtimeMs).toBe(before);
    // `at` is the write clock, not part of what was seen — the stored one stands.
    expect(loadBriefedSnapshot('ws-1', dir)?.at).toBe(NOW);
  });

  it('a changed status, a changed decision, or a new pane all still write', async () => {
    await saveBriefedSnapshot('ws-1', snap(), dir);
    expect(
      await saveBriefedSnapshot('ws-1', snap({ panes: [{ ptyId: 'p1', agentStatus: 'complete' }] }), dir),
    ).toBe(true);
    expect(await saveBriefedSnapshot('ws-1', snap({ decisionId: 'dec-1' }), dir)).toBe(true);
    expect(
      await saveBriefedSnapshot(
        'ws-1',
        snap({
          decisionId: 'dec-1',
          panes: [
            { ptyId: 'p1', agentStatus: 'running' },
            { ptyId: 'p2', agentStatus: 'running' },
          ],
        }),
        dir,
      ),
    ).toBe(true);
  });

  it('pane ORDER alone is not a change (the baseline is a status map)', async () => {
    const panes = [
      { ptyId: 'p1', agentStatus: 'running' as const },
      { ptyId: 'p2', agentStatus: 'complete' as const },
    ];
    await saveBriefedSnapshot('ws-1', snap({ panes }), dir);
    expect(await saveBriefedSnapshot('ws-1', snap({ panes: [...panes].reverse() }), dir)).toBe(false);
  });

  it('the first save for a workspace always writes (no baseline to match)', async () => {
    expect(await saveBriefedSnapshot('ws-new', snap(), dir)).toBe(true);
  });
});

describe('deckBriefingStore — chain-ordered reads', () => {
  it('a read issued while a write is queued sees the POST-write state', async () => {
    await saveBriefedSnapshot('ws-1', snap(), dir);
    // Do not await the save: the read must queue behind it, not race it.
    const write = saveBriefedSnapshot(
      'ws-1',
      snap({ panes: [{ ptyId: 'p1', agentStatus: 'complete' }] }),
      dir,
    );
    const read = readBriefedSnapshot('ws-1', dir);
    expect((await read)?.panes).toEqual([{ ptyId: 'p1', agentStatus: 'complete' }]);
    await write;
  });

  it('a config read queued behind a toggle sees the toggle', async () => {
    const write = saveDeckBriefingConfig({ enabled: false }, dir);
    expect(await readDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: true });
    await write;
  });

  it('the async readers fail open exactly like the sync ones', async () => {
    fs.writeFileSync(getDeckBriefingPath(dir), 'CORRUPT{', 'utf8');
    expect(await readDeckBriefingConfig(dir)).toEqual(DEFAULT_BRIEFING);
    expect(await readBriefedSnapshot('ws-1', dir)).toBeNull();
  });
});

describe('deckBriefingStore — serialized read-modify-write (no lost updates)', () => {
  it('two concurrent snapshot saves both survive', async () => {
    await Promise.all([
      saveBriefedSnapshot('ws-1', snap({ decisionId: 'a' }), dir),
      saveBriefedSnapshot('ws-2', snap({ decisionId: 'b' }), dir),
    ]);
    expect(loadBriefedSnapshot('ws-1', dir)?.decisionId).toBe('a');
    expect(loadBriefedSnapshot('ws-2', dir)?.decisionId).toBe('b');
  });

  it('a snapshot save concurrent with a config toggle cannot revert the toggle', async () => {
    // The regression: the snapshot save reads the file (config still enabled),
    // the Settings toggle writes enabled:false, then the snapshot save writes its
    // stale copy back — silently re-enabling a briefing the operator turned off.
    await Promise.all([
      saveBriefedSnapshot('ws-1', snap(), dir),
      saveDeckBriefingConfig({ enabled: false }, dir),
      saveBriefedSnapshot('ws-2', snap(), dir),
    ]);
    expect(loadDeckBriefingConfig(dir).enabled).toBe(false);
    expect(loadBriefedSnapshot('ws-1', dir)).not.toBeNull();
    expect(loadBriefedSnapshot('ws-2', dir)).not.toBeNull();
  });

  it('concurrent config patches to different fields both land', async () => {
    await Promise.all([
      saveDeckBriefingConfig({ enabled: false }, dir),
      saveDeckBriefingConfig({ autoShow: false }, dir),
    ]);
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: false, autoShow: false });
  });
});

describe('deckBriefingStore — snapshot pruning', () => {
  it('drops workspaces absent from the live list, keeps the ones present', async () => {
    await saveBriefedSnapshot('ws-gone', snap(), dir);
    await saveBriefedSnapshot('ws-keep', snap(), dir);
    await saveBriefedSnapshot('ws-new', snap(), dir, { liveWorkspaceIds: ['ws-keep', 'ws-new'] });
    expect(loadBriefedSnapshot('ws-gone', dir)).toBeNull();
    expect(loadBriefedSnapshot('ws-keep', dir)).not.toBeNull();
    expect(loadBriefedSnapshot('ws-new', dir)).not.toBeNull();
  });

  it('an EMPTY live list prunes nothing (an unpopulated mirror is not "all deleted")', async () => {
    await saveBriefedSnapshot('ws-1', snap(), dir);
    await saveBriefedSnapshot('ws-2', snap(), dir, { liveWorkspaceIds: [] });
    expect(loadBriefedSnapshot('ws-1', dir)).not.toBeNull();
  });

  it('drops snapshots older than the TTL even when still live', async () => {
    const now = 10_000_000_000;
    await saveBriefedSnapshot('ws-old', snap({ at: now - BRIEFED_SNAPSHOT_TTL_MS - 1 }), dir);
    await saveBriefedSnapshot('ws-fresh', snap({ at: now }), dir, { now });
    expect(loadBriefedSnapshot('ws-old', dir)).toBeNull();
    expect(loadBriefedSnapshot('ws-fresh', dir)).not.toBeNull();
  });
});

describe('deckBriefingStore — fail-open', () => {
  it('corrupt / wrong-shape file resolves to defaults (never throws)', () => {
    fs.writeFileSync(getDeckBriefingPath(dir), 'CORRUPT{', 'utf8');
    expect(loadDeckBriefingConfig(dir)).toEqual(DEFAULT_BRIEFING);
    expect(loadBriefedSnapshot('ws-1', dir)).toBeNull();
    fs.writeFileSync(getDeckBriefingPath(dir), JSON.stringify([1, 2]), 'utf8');
    expect(loadDeckBriefingConfig(dir)).toEqual(DEFAULT_BRIEFING);
  });

  it('non-boolean config fields fall back per-field', () => {
    fs.writeFileSync(
      getDeckBriefingPath(dir),
      JSON.stringify({ config: { enabled: 'yes', autoShow: false }, snapshots: {} }),
      'utf8',
    );
    expect(loadDeckBriefingConfig(dir)).toEqual({ enabled: true, autoShow: false });
  });
});
