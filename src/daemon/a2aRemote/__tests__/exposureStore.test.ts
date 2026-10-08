import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { EXPOSURE_FILE, ExposureStore, type ExposureStoreOptions } from '../exposureStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';

let dir: string;
let fail = false;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const noHarden = (): void => undefined;
const make = (o: Partial<ExposureStoreOptions> = {}): ExposureStore =>
  new ExposureStore({ dir, now: () => 1_700_000_000_000, scheduleHarden: noHarden, ...o });

beforeEach(() => {
  fail = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-exposure-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ExposureStore', () => {
  it('defaults to nothing exposed', () => {
    const s = make();
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
    s.set(HOST, { workspaceIds: ['ws1'] });
    expect(s.isPaneExposed(HOST, 'ws2', 'p1')).toBe(false);
    expect(s.isPaneExposed(HOST2, 'ws1', 'p1')).toBe(false);
  });

  it('absent pane key = every pane; listed key = only those panes; empty list = none', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1', 'ws2', 'ws3'], paneIds: { ws2: ['p2'], ws3: [], wsX: ['px'] } });
    expect(s.isPaneExposed(HOST, 'ws1', 'anything')).toBe(true);
    expect(s.isPaneExposed(HOST, 'ws2', 'p2')).toBe(true);
    expect(s.isPaneExposed(HOST, 'ws2', 'p3')).toBe(false);
    expect(s.isPaneExposed(HOST, 'ws3', 'p1')).toBe(false);
    // A key for an unexposed workspace is dropped, not stored.
    expect(s.get(HOST)?.paneIds).toEqual({ ws2: ['p2'], ws3: [] });
  });

  it('round-trips through a new instance', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1'], paneIds: { ws1: ['p1'] } });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, EXPOSURE_FILE), 'utf-8'));
    expect(raw.v).toBe(1);
    const t = make();
    expect(t.get(HOST)).toEqual(s.get(HOST));
    expect(t.isPaneExposed(HOST, 'ws1', 'p1')).toBe(true);
    expect(t.isPaneExposed(HOST, 'ws1', 'p2')).toBe(false);
  });

  it('clear removes the record and persists', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1'] });
    expect(s.clear(HOST)).toBe(true);
    expect(s.clear(HOST)).toBe(false);
    expect(make().get(HOST)).toBeUndefined();
  });

  it('forgetWorkspace and forgetPane narrow; forgetting the last listed pane never widens', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1', 'ws2'], paneIds: { ws1: ['p1'] } });
    s.forgetPane('p1');
    expect(s.get(HOST)?.paneIds).toEqual({ ws1: [] });
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
    expect(s.isPaneExposed(HOST, 'ws1', 'p9')).toBe(false);
    s.forgetWorkspace('ws2');
    expect(s.isPaneExposed(HOST, 'ws2', 'p1')).toBe(false);
    s.forgetWorkspace('ws1');
    expect(make().get(HOST)).toMatchObject({ workspaceIds: [], paneIds: {} });
  });

  it('corrupt file: starts empty, keeps the original as .corrupt-<ts>, warns', () => {
    const file = path.join(dir, EXPOSURE_FILE);
    fs.writeFileSync(file, '{not json');
    const log = vi.fn();
    const s = make({ log });
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.corrupt-1700000000000`, 'utf-8')).toBe('{not json');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('corrupt'));
  });

  it('a file with one invalid record is rejected whole (no .bak resurrection)', () => {
    const file = path.join(dir, EXPOSURE_FILE);
    const good = { v: 1, hostId: HOST, workspaceIds: ['ws1'], updatedAt: new Date().toISOString() };
    // A previous generation in .bak must not come back.
    atomicWriteJSONSync(file, { v: 1, exposures: [good] });
    atomicWriteJSONSync(file, { v: 1, exposures: [good, { v: 1, hostId: 'nope', workspaceIds: [] }] });
    const s = make();
    expect(s.list()).toEqual([]);
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
  });

  it('set rolls memory back when the write fails', () => {
    const s = make({ write: flakyWrite });
    s.set(HOST, { workspaceIds: ['ws1'] });
    fail = true;
    expect(() => s.set(HOST, { workspaceIds: ['ws2'] })).toThrow('disk full');
    expect(s.get(HOST)?.workspaceIds).toEqual(['ws1']);
    expect(() => s.set(HOST2, { workspaceIds: ['ws2'] })).toThrow('disk full');
    expect(s.get(HOST2)).toBeUndefined();
  });

  it('narrowing ops keep their in-memory effect when the write fails', () => {
    const s = make({ write: flakyWrite });
    s.set(HOST, { workspaceIds: ['ws1', 'ws2'], paneIds: { ws1: ['p1'] } });
    s.set(HOST2, { workspaceIds: ['ws1'] });
    fail = true;
    expect(() => s.forgetPane('p1')).toThrow();
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
    expect(() => s.forgetWorkspace('ws2')).toThrow();
    expect(s.isPaneExposed(HOST, 'ws2', 'p1')).toBe(false);
    expect(() => s.clear(HOST2)).toThrow();
    expect(s.isPaneExposed(HOST2, 'ws1', 'p1')).toBe(false);
  });

  it('no forget path ever widens exposure; only set() re-adds', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1', 'ws2'], paneIds: { ws1: ['p1'], ws2: ['p2'] } });
    // Forgetting the workspace removes it from workspaceIds, not just the
    // pane-list key — otherwise "absent key = every pane" would widen it.
    s.forgetWorkspace('ws1');
    expect(s.get(HOST)?.workspaceIds).toEqual(['ws2']);
    for (const pane of ['p1', 'p2', 'other']) expect(s.isPaneExposed(HOST, 'ws1', pane)).toBe(false);
    // Forgetting the last listed pane leaves an empty list, not an absent key.
    s.forgetPane('p2');
    for (const pane of ['p1', 'p2', 'other']) expect(s.isPaneExposed(HOST, 'ws2', pane)).toBe(false);
    // Same after a restart.
    const t = make();
    for (const [ws, pane] of [['ws1', 'p1'], ['ws1', 'x'], ['ws2', 'p2'], ['ws2', 'x']]) {
      expect(t.isPaneExposed(HOST, ws, pane)).toBe(false);
    }
    // Re-exposing is a whole-record replacement through set().
    t.set(HOST, { workspaceIds: ['ws1'] });
    expect(t.isPaneExposed(HOST, 'ws1', 'x')).toBe(true);
    expect(t.isPaneExposed(HOST, 'ws2', 'p2')).toBe(false);
  });

  it('forgetHost drops everything exposed to that host', () => {
    const s = make();
    s.set(HOST, { workspaceIds: ['ws1'] });
    s.set(HOST2, { workspaceIds: ['ws1'] });
    expect(s.forgetHost(HOST)).toBe(true);
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
    expect(s.isPaneExposed(HOST2, 'ws1', 'p1')).toBe(true);
    expect(make().get(HOST)).toBeUndefined();
  });

  it('an unreadable file leaves the store unavailable and the file untouched', () => {
    if (process.platform === 'win32') return;
    const file = path.join(dir, EXPOSURE_FILE);
    fs.mkdirSync(file); // EISDIR on read: neither missing nor corrupt
    const s = make();
    expect(s.isPaneExposed(HOST, 'ws1', 'p1')).toBe(false);
    expect(() => s.set(HOST, { workspaceIds: ['ws1'] })).toThrow(/unavailable/);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([EXPOSURE_FILE]);
  });

  it('rejects an invalid hostId', () => {
    expect(() => make().set('not-a-uuid', { workspaceIds: [] })).toThrow();
  });
});

describe('ExposureStore Moa flag', () => {
  it('is off by default, persists when on and survives a reload', () => {
    const s = make();
    expect(s.isBrainExposed(HOST)).toBe(false);
    s.set(HOST, { workspaceIds: [] });
    expect(s.isBrainExposed(HOST)).toBe(false);
    expect(s.get(HOST)).not.toHaveProperty('brain');
    s.set(HOST, { workspaceIds: [], brain: true });
    expect(make().isBrainExposed(HOST)).toBe(true);
    s.set(HOST, { workspaceIds: [], brain: false });
    expect(make().isBrainExposed(HOST)).toBe(false);
  });
});
