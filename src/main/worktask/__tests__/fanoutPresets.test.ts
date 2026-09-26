import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFanoutPresetsPath, loadFanoutPresetsReport, saveFanoutPresets } from '../fanoutPresets';
import { FANOUT_PRESETS_MAX } from '../../../shared/fanoutPreset';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-presets-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fanout preset store', () => {
  it('a missing file is the shipped templates', () => {
    const r = loadFanoutPresetsReport(dir);
    expect(r.presets.map((p) => p.name)).toEqual(['Image', 'Video']);
    expect(r.dropped).toEqual([]);
  });

  it('a corrupt file is no presets, flagged unreadable (never a guess)', () => {
    fs.writeFileSync(getFanoutPresetsPath(dir), '{ nope', 'utf8');
    expect(loadFanoutPresetsReport(dir)).toEqual({ presets: [], dropped: [], unreadable: true });
  });

  it('a valid file loads, and an invalid row is reported as dropped', () => {
    fs.writeFileSync(
      getFanoutPresetsPath(dir),
      JSON.stringify({ presets: [{ name: 'A', items: [{ agent: 'codex', model: 'm1' }], worktree: false }, { name: 'B', items: [{ agent: 'bash' }] }] }),
      'utf8',
    );
    const r = loadFanoutPresetsReport(dir);
    expect(r.presets).toEqual([{ name: 'A', items: [{ agent: 'codex', model: 'm1' }], worktree: false }]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ name: 'B', issue: { code: 'agent-unknown' } });
  });

  it.each([
    ['an invalid row', [{ name: 'X', items: [{ agent: 'codex', model: '--yolo' }] }], 'model-invalid'],
    ['a duplicate name', [{ name: 'X', items: [{ agent: 'codex' }] }, { name: 'x', items: [{ agent: 'grok' }] }], 'duplicate-name'],
    ['over the cap', Array.from({ length: FANOUT_PRESETS_MAX + 1 }, (_, k) => ({ name: `P${k}`, items: [{ agent: 'codex' }] })), 'presets-over-cap'],
    ['not a list', { name: 'X' }, 'presets-not-array'],
  ])('save refuses %s and writes nothing', async (_label, input, code) => {
    const out = await saveFanoutPresets(input, dir);
    expect(out).toMatchObject({ ok: false, code });
    expect(fs.existsSync(getFanoutPresetsPath(dir))).toBe(false);
  });

  it('save writes the list and keeps the replaced file as .bak', async () => {
    fs.writeFileSync(getFanoutPresetsPath(dir), JSON.stringify({ presets: [{ name: 'Old', items: [{ agent: 'gemini' }] }] }), 'utf8');
    const out = await saveFanoutPresets([{ name: 'New', items: [{ agent: 'grok' }], worktree: false }], dir);
    expect(out.ok).toBe(true);
    expect(loadFanoutPresetsReport(dir).presets.map((p) => p.name)).toEqual(['New']);
    expect(fs.readFileSync(`${getFanoutPresetsPath(dir)}.bak`, 'utf8')).toContain('"Old"');
  });
});
