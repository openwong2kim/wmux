// Unit tests for the briefing config + snapshot store: default-on config,
// partial-merge saves that preserve snapshots (and vice-versa), snapshot
// round-trip, torn-file → defaults (never throws), and suffix isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BRIEFING,
  loadDeckBriefingConfig,
  saveDeckBriefingConfig,
  loadBriefedSnapshot,
  saveBriefedSnapshot,
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

const snap = (over: Partial<BriefedSnapshot> = {}): BriefedSnapshot => ({
  panes: [{ ptyId: 'p1', agentStatus: 'running' }],
  decisionId: null,
  at: 5,
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
