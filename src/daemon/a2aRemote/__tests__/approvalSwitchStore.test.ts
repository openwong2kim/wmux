// This PC's approvals setting (approvalSwitchStore.ts): off for every PC with no
// file, off for every PC (and why) when damaged, on only for the PCs listed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSourceText } from '../../../test-utils/sourceText';
import { APPROVALS_FILE, ApprovalSwitchStore, coerceApprovalsSettings, pairingOf, setApprovals } from '../approvalSwitchStore';

const PC_A = '11111111-1111-4111-8111-111111111111';
const PC_B = '22222222-2222-4222-8222-222222222222';

let dir: string;
let logs: Array<[string, string]>;
/** Each PC's pairing here (its peer records), as the daemon's pairing stores give it. */
let pairings: Record<string, string>;
const pairing = (hostId: string): string | null => pairings[hostId] ?? null;
const sha = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');
const store = (opts: { write?: (p: string, d: unknown) => void } = {}): ApprovalSwitchStore => new ApprovalSwitchStore({
  dir,
  pairing,
  ...opts,
  log: (level, msg) => { logs.push([level, msg]); },
  scheduleHarden: () => undefined,
  now: () => Date.UTC(2026, 10, 19),
});
const onDisk = (): unknown => JSON.parse(fs.readFileSync(path.join(dir, APPROVALS_FILE), 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  logs = [];
  pairings = { [PC_A]: 'peer:a-1', [PC_B]: 'peer:b-1' };
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
    expect(onDisk()).toEqual({ v: 1, hosts: { [PC_A]: { exposure: 'tool-only', pairing: sha('peer:a-1') } } });
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
    ['an entry with a field it does not read', JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'command', pairing: 'a'.repeat(64), also: 'x' } } })],
    ['an entry with no pairing', JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'command' } } })],
    ['a pairing that is not a hash', JSON.stringify({ v: 1, hosts: { [PC_A]: { exposure: 'command', pairing: 'peer:a-1' } } })],
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
    const failing = new ApprovalSwitchStore({ dir, pairing, log: () => undefined, scheduleHarden: () => undefined, write: () => { throw new Error('disk full'); } });
    expect(failing.exposure(PC_A)).toBeNull();
    expect(fs.existsSync(path.join(dir, APPROVALS_FILE))).toBe(false);
    const next = store();
    expect(next.get().damaged).toBe(true);
    expect(next.exposure(PC_A)).toBeNull();
  });

  it('a list beside damagedAt is not one this version wrote: damaged', () => {
    expect(coerceApprovalsSettings({ v: 1, hosts: { [PC_A]: { exposure: 'command', pairing: 'a'.repeat(64) } } })).toMatchObject({ hosts: { [PC_A]: { exposure: 'command' } } });
    expect(coerceApprovalsSettings({ v: 1, hosts: { [PC_A]: { exposure: 'command', pairing: 'a'.repeat(64) } }, damagedAt: '2026-11-19T00:00:00.000Z' })).toBeNull();
    expect(coerceApprovalsSettings({ v: 1, hosts: {}, damagedAt: '2026-11-19T00:00:00.000Z' })).toMatchObject({ hosts: {} });
  });

  it('refuses a value that is not a host id', () => {
    expect(store().set('pc-a', 'command')).toEqual({ ok: false, error: 'not a host id' });
  });
});

describe('a PC no longer paired', () => {
  it('revoked, then paired again under the same host id: off, after a restart too', () => {
    const s = store();
    s.set(PC_A, 'command');
    s.set(PC_B, 'tool-only');
    expect(s.forgetHost(PC_A)).toBe(true);
    expect(s.exposure(PC_A)).toBeNull();
    expect(s.exposure(PC_B)).toBe('tool-only');
    // Paired again: nothing about it is remembered.
    expect(store().exposure(PC_A)).toBeNull();
    expect(store().forgetHost(PC_A)).toBe(false);
  });

  it('a removal whose write failed: off now, and still off after the PC is paired again and the daemon restarts', () => {
    store().set(PC_A, 'command');
    store().set(PC_B, 'tool-only');
    const failing = store({ write: () => { throw new Error('disk full'); } });
    expect(failing.forgetHost(PC_A)).toBe(true);
    expect(failing.exposure(PC_A)).toBeNull();
    expect(logs.some(([level, msg]) => level === 'error' && msg.includes('not saved'))).toBe(true);
    // The file still lists it under the old pairing.
    expect(Object.keys((onDisk() as { hosts: object }).hosts)).toEqual([PC_A, PC_B]);
    // Paired again: new peer records. The next start keeps it among paired PCs, and it reads as off.
    pairings[PC_A] = 'peer:a-2';
    const next = store();
    expect(next.exposure(PC_A)).toBeNull();
    expect(next.get().hosts).toEqual({ [PC_B]: 'tool-only' });
    expect(next.retainHosts(() => true)).toBe(true);
    expect(store().exposure(PC_A)).toBeNull();
    expect(store().exposure(PC_B)).toBe('tool-only');
    // Set again under the new pairing: on.
    expect(store().set(PC_A, 'tool-only')).toMatchObject({ ok: true });
    expect(store().exposure(PC_A)).toBe('tool-only');
  });

  it('a PC with no pairing here cannot be turned on, and one whose pairing went is off', () => {
    delete pairings[PC_A];
    expect(store().set(PC_A, 'command')).toEqual({ ok: false, error: 'that PC is not paired with this one' });
    expect(store().set(PC_B, 'command')).toMatchObject({ ok: true });
    delete pairings[PC_B];
    expect(store().exposure(PC_B)).toBeNull();
    expect(store().anyOn()).toBe(false);
  });

  it('a PC\'s pairing is its unrevoked peer records and its host record; a new peer id is another pairing', () => {
    const peer = { hostId: PC_A, peerId: 'p-1' };
    expect(pairingOf(PC_A, [], undefined)).toBeNull();
    expect(pairingOf(PC_A, [{ ...peer, revokedAt: '2026-11-19T00:00:00.000Z' }], undefined)).toBeNull();
    expect(pairingOf(PC_A, [{ hostId: PC_B, peerId: 'p-9' }], undefined)).toBeNull();
    const one = pairingOf(PC_A, [peer], undefined);
    expect(one).not.toBeNull();
    // Revoked and paired again: the old record stays, revoked, beside a new one.
    const again = pairingOf(PC_A, [{ ...peer, revokedAt: '2026-11-19T00:00:00.000Z' }, { hostId: PC_A, peerId: 'p-2' }], undefined);
    expect(again).not.toBeNull();
    expect(again).not.toBe(one);
    const joined = pairingOf(PC_A, [], { peerId: 'h-1' });
    expect(joined).not.toBeNull();
    expect(pairingOf(PC_A, [], { peerId: 'h-2' })).not.toBe(joined);
    // Both ways: both records, in any order.
    expect(pairingOf(PC_A, [peer], { peerId: 'h-1' })).toBe(pairingOf(PC_A, [peer], { peerId: 'h-1' }));
    expect(new Set([one, joined, pairingOf(PC_A, [peer], { peerId: 'h-1' })]).size).toBe(3);
  });

  it('a start drops the PCs the pairing stores no longer know', () => {
    store().set(PC_A, 'command');
    store().set(PC_B, 'command');
    const s = store();
    expect(s.retainHosts((h) => h === PC_B)).toBe(true);
    expect(store().get().hosts).toEqual({ [PC_B]: 'command' });
  });

  it('the daemon\'s revoke cascade forgets it, and a start keeps only paired PCs', () => {
    const src = readSourceText(path.join(__dirname, '..', '..', 'index.ts'));
    const cascade = src.slice(src.indexOf('const a2aCascade = (hostId: string): void => {'), src.indexOf('a2aDelivery?.onPeerRevoked(hostId);'));
    expect(cascade).toContain('a2aApprovalSwitch.forgetHost(hostId)');
    expect(src).toContain('a2aApprovalSwitch.retainHosts(a2aPaired);');
    expect(src).toContain('pairing: (hostId) => approvalPairingOf(hostId, a2aPeers.list(), a2aRemoteHosts.get(hostId)),');
  });
});

describe('approvals.set', () => {
  const set = (s: ApprovalSwitchStore, params: Record<string, unknown>) => {
    const lines: string[] = [];
    const changed: Array<[string, boolean]> = [];
    const res = setApprovals(s, params, { log: (_l, m) => lines.push(m), changed: (h, on) => changed.push([h, on]) });
    return { res, lines, changed };
  };

  it('writes one line: who asked, the PC, the exposure before and after; nothing else', () => {
    const s = store();
    const first = set(s, { hostId: PC_A, exposure: 'tool-only' });
    expect(first.res).toMatchObject({ ok: true });
    expect(first.lines).toEqual([`[a2a-remote] approvals set by=none host=${PC_A} off->tool-only`]);
    expect(first.changed).toEqual([[PC_A, true]]);
    const second = set(s, { hostId: PC_A, exposure: 'command', senderPtyId: 'pty-7' });
    expect(second.lines).toEqual([`[a2a-remote] approvals set by=pty-7 host=${PC_A} tool-only->command`]);
    expect(second.changed).toEqual([]);
    const third = set(s, { hostId: PC_A, exposure: 'off', senderPtyId: 'x\ny', note: 'ignored' });
    expect(third.lines).toEqual([`[a2a-remote] approvals set by=invalid host=${PC_A} command->off`]);
    expect(third.changed).toEqual([[PC_A, false]]);
  });

  it('a PC not paired now can be turned off but never on', () => {
    const s = store();
    s.set(PC_A, 'command');
    let paired = false;
    const lines: string[] = [];
    const call = (exposure: string) => setApprovals(s, { hostId: PC_A, exposure }, { log: (_l, m) => lines.push(m), paired: () => paired });
    expect(call('command')).toEqual({ ok: false, error: 'that PC is not paired with this one' });
    expect(call('tool-only')).toMatchObject({ ok: false });
    expect(s.exposure(PC_A)).toBe('command');
    expect(call('off')).toMatchObject({ ok: true });
    expect(s.exposure(PC_A)).toBeNull();
    expect(call('tool-only')).toMatchObject({ ok: false });
    expect(s.exposure(PC_A)).toBeNull();
    paired = true;
    expect(call('tool-only')).toMatchObject({ ok: true });
    expect(lines).toHaveLength(5);
  });

  it('a refused call is logged the same way, with no value it was given', () => {
    const s = store();
    const bad = set(s, { hostId: 'not\na host', exposure: 'everything' });
    expect(bad.res).toMatchObject({ ok: false });
    expect(bad.lines).toEqual(['[a2a-remote] approvals set by=none host=invalid off->invalid']);
    expect(s.get().hosts).toEqual({});
  });
});
