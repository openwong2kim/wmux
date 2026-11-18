// This PC's approvals setting (approvalSwitchStore.ts): off for every PC with no
// file, off for every PC (and why) when damaged, on only for the PCs listed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVALS_FILE, ApprovalSwitchStore, coerceApprovalsSettings } from '../approvalSwitchStore';

const PC_A = '11111111-1111-4111-8111-111111111111';
const PC_B = '22222222-2222-4222-8222-222222222222';

let dir: string;
let logs: Array<[string, string]>;
const store = (): ApprovalSwitchStore => new ApprovalSwitchStore({
  dir,
  log: (level, msg) => { logs.push([level, msg]); },
  scheduleHarden: () => undefined,
  now: () => Date.UTC(2026, 10, 19),
});
const onDisk = (): unknown => JSON.parse(fs.readFileSync(path.join(dir, APPROVALS_FILE), 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  logs = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the approvals setting', () => {
  it('no file: off for every PC, nothing written, nothing logged', () => {
    const s = store();
    expect(s.get()).toEqual({ hosts: {}, damaged: false });
    expect(s.exposure(PC_A)).toBeNull();
    expect(s.anyOn()).toBe(false);
    expect(fs.existsSync(path.join(dir, APPROVALS_FILE))).toBe(false);
    expect(logs).toEqual([]);
  });

  it('on for one PC only, saved and read back by the next daemon; off removes it', () => {
    expect(store().set(PC_A, 'tool-only')).toEqual({ ok: true, hosts: { [PC_A]: 'tool-only' } });
    expect(onDisk()).toEqual({ v: 1, hosts: { [PC_A]: { exposure: 'tool-only' } } });
    const next = store();
    expect(next.exposure(PC_A)).toBe('tool-only');
    expect(next.exposure(PC_B)).toBeNull();
    expect(next.set(PC_A, 'command')).toMatchObject({ ok: true });
    expect(store().exposure(PC_A)).toBe('command');
    expect(store().set(PC_A, 'off')).toEqual({ ok: true, hosts: {} });
    expect(store().exposure(PC_A)).toBeNull();
    expect(store().anyOn()).toBe(false);
  });

  it.each([
    ['not JSON', 'not json'],
    ['an unknown version', JSON.stringify({ v: 2, hosts: {} })],
    ['an exposure it does not read', JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'all' } } })],
    ['a key that is not a host id', JSON.stringify({ v: 1, hosts: { 'pc-a': { exposure: 'command' } } })],
    ['a `default` (there is none)', JSON.stringify({ v: 1, default: 'command', hosts: {} })],
    ['an entry with a field it does not read', JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'command', also: 'x' } } })],
  ])('damaged (%s): off for every PC, set aside, an empty list written with when it was found', (_label, body) => {
    fs.writeFileSync(path.join(dir, APPROVALS_FILE), body);
    const s = store();
    expect(s.get()).toEqual({ hosts: {}, damaged: true });
    expect(s.exposure(PC_A)).toBeNull();
    expect(s.anyOn()).toBe(false);
    expect(onDisk()).toEqual({ v: 1, hosts: {}, damagedAt: '2026-11-19T00:00:00.000Z' });
    expect(fs.readdirSync(dir).some((n) => n.startsWith(`${APPROVALS_FILE}.corrupt-`))).toBe(true);
    // The next start reads the same, until a person sets a PC again.
    expect(store().get()).toEqual({ hosts: {}, damaged: true });
    expect(store().set(PC_B, 'tool-only')).toMatchObject({ ok: true, hosts: { [PC_B]: 'tool-only' } });
    expect(store().get()).toEqual({ hosts: { [PC_B]: 'tool-only' }, damaged: false });
  });

  it('a damaged file whose repair write fails still reads as off on the next start', () => {
    fs.writeFileSync(path.join(dir, APPROVALS_FILE), JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'cmd' } } }));
    const failing = new ApprovalSwitchStore({ dir, log: () => undefined, scheduleHarden: () => undefined, write: () => { throw new Error('disk full'); } });
    expect(failing.exposure(PC_A)).toBeNull();
    expect(fs.existsSync(path.join(dir, APPROVALS_FILE))).toBe(false);
    const next = store();
    expect(next.get().damaged).toBe(true);
    expect(next.exposure(PC_A)).toBeNull();
  });

  it('a list beside damagedAt is not one this version wrote: damaged', () => {
    expect(coerceApprovalsSettings({ v: 1, hosts: { [PC_A]: { exposure: 'command' } }, damagedAt: '2026-11-19T00:00:00.000Z' })).toBeNull();
    expect(coerceApprovalsSettings({ v: 1, hosts: {}, damagedAt: '2026-11-19T00:00:00.000Z' })).toMatchObject({ hosts: {} });
  });

  it('refuses a value that is not a host id', () => {
    expect(store().set('pc-a', 'command')).toEqual({ ok: false, error: 'not a host id' });
  });
});
