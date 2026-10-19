import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aLinkState, A2aRemoteMessageKind } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import {
  LINKS_FILE,
  LINKS_PER_HOST_MAX,
  LinkStore,
  PROPOSAL_TTL_MS,
  TERMINAL_KEEP,
  linkFromProposal,
  type LinkNotice,
  type LinkStoreOptions,
  type NewLinkInput,
} from '../linkStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';
const uuid = (): string => crypto.randomUUID();

let dir: string;
let fail = false;
let clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<LinkStoreOptions> = {}): LinkStore =>
  new LinkStore({ dir, now: () => clock, scheduleHarden: () => undefined, write: flakyWrite, ...o });

const input = (o: Partial<NewLinkInput> = {}): NewLinkInput => ({
  local: { kind: 'pane', workspaceId: 'ws1', paneId: 'p1' },
  remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'rp', label: 'remote claude' },
  allow: { outbound: true, inbound: false },
  ...o,
});
const at = (n: number): Partial<NewLinkInput> => ({ local: { kind: 'pane', workspaceId: `ws${n}`, paneId: `p${n}` } });

beforeEach(() => {
  fail = false;
  clock = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-links-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a link in `state` and return its id. Active links end at version 2. */
function linkIn(s: LinkStore, state: A2aLinkState, o: Partial<NewLinkInput> = {}): string {
  if (state === 'proposed-out') return s.proposeOut(input(o)).linkId;
  const id = uuid();
  s.receiveProposal({ ...input(o), linkId: id });
  if (state === 'proposed-in') return id;
  s.accept(id);
  if (state === 'active') return id;
  if (state === 'revoked') s.revoke(id, 'local');
  else s.markBroken(id, 'pane-closed');
  return id;
}

describe('LinkStore transitions', () => {
  it('proposeOut / receiveProposal stamp v, version 1 and the state', () => {
    const L1 = uuid();
    const s = make({ mintId: () => L1 });
    expect(s.proposeOut(input())).toMatchObject({ v: 1, linkId: L1, version: 1, state: 'proposed-out' });
    const L2 = uuid();
    const inn = s.receiveProposal({ ...input(at(2)), linkId: L2 });
    expect(inn).toMatchObject({ v: 1, linkId: L2, version: 1, state: 'proposed-in' });
    expect(inn.createdAt).toBe(new Date(clock).toISOString());
  });

  it('receiveProposal refuses a duplicate linkId in any state, and a non-UUID linkId', () => {
    const s = make();
    const id = linkIn(s, 'revoked');
    expect(() => s.receiveProposal({ ...input(at(9)), linkId: id })).toThrow(/duplicate/);
    expect(() => s.receiveProposal({ ...input(at(9)), linkId: 'not-a-uuid' })).toThrow(/linkId/);
  });

  it('accept: proposed-in -> active, version + 1', () => {
    const s = make();
    expect(s.accept(linkIn(s, 'proposed-in'))).toMatchObject({ state: 'active', version: 2 });
  });

  it('applyRemoteAccept needs EXACTLY our version + 1', () => {
    const s = make();
    const id = linkIn(s, 'proposed-out');
    expect(() => s.applyRemoteAccept(id, 1)).toThrow(/expected 2/);
    expect(() => s.applyRemoteAccept(id, 3)).toThrow(/expected 2/);
    expect(s.applyRemoteAccept(id, 2)).toMatchObject({ state: 'active', version: 2 });
  });

  it('revoke records the side; markBroken records the reason; both bump the version', () => {
    const s = make();
    expect(s.revoke(linkIn(s, 'active'), 'remote')).toMatchObject({ state: 'revoked', endedReason: 'revoked-remote', version: 3 });
    expect(s.revoke(linkIn(s, 'proposed-out', at(9)), 'local')).toMatchObject({ endedReason: 'revoked-local', version: 2 });
    expect(s.markBroken(linkIn(s, 'proposed-in', at(8)), 'workspace-gone')).toMatchObject({ state: 'broken', endedReason: 'workspace-gone' });
  });

  it('a remote revoke is taken at any version; a remote broken needs exactly ours + 1', () => {
    const s = make();
    // revoke(…, 'remote') carries no version on purpose: it can never be blocked.
    expect(s.revoke(linkIn(s, 'active'), 'remote').state).toBe('revoked');
    const b = linkIn(s, 'active', at(2));
    expect(() => s.markBroken(b, 'pane-closed', 2)).toThrow(/expected 3/);
    expect(() => s.markBroken(b, 'pane-closed', 9)).toThrow(/expected 3/);
    expect(s.markBroken(b, 'pane-closed', 3)).toMatchObject({ state: 'broken', version: 3 });
  });

  // The full table: every op from every state.
  const ALL: A2aLinkState[] = ['proposed-out', 'proposed-in', 'active', 'revoked', 'broken'];
  const ops: Record<string, { allowed: A2aLinkState[]; run: (s: LinkStore, id: string) => unknown }> = {
    accept: { allowed: ['proposed-in'], run: (s, id) => s.accept(id) },
    applyRemoteAccept: { allowed: ['proposed-out'], run: (s, id) => s.applyRemoteAccept(id, (s.get(id)?.version ?? 0) + 1) },
    revoke: { allowed: ['proposed-out', 'proposed-in', 'active'], run: (s, id) => s.revoke(id, 'local') },
    markBroken: { allowed: ['proposed-out', 'proposed-in', 'active'], run: (s, id) => s.markBroken(id, 'pane-moved') },
  };
  for (const [op, { allowed, run }] of Object.entries(ops)) {
    for (const from of ALL) {
      const ok = allowed.includes(from);
      it(`${op} from ${from} ${ok ? 'is allowed' : 'throws'}`, () => {
        const s = make();
        const id = linkIn(s, from);
        if (ok) expect(() => run(s, id)).not.toThrow();
        else {
          const before = s.get(id);
          expect(() => run(s, id)).toThrow(/not allowed/);
          expect(s.get(id)).toEqual(before);
        }
      });
    }
  }

  it('ops on an unknown link throw', () => {
    const s = make();
    expect(() => s.accept('nope')).toThrow(/unknown/);
    expect(() => s.revoke('nope', 'local')).toThrow(/unknown/);
  });

  it('at most one non-terminal link per (local pane, remote host, remote pane)', () => {
    const s = make();
    const id = linkIn(s, 'proposed-out');
    expect(() => s.proposeOut(input())).toThrow(/already linked/);
    expect(() => s.receiveProposal({ ...input(), linkId: uuid() })).toThrow(/already linked/);
    expect(() => s.proposeOut(input({ remote: { hostId: HOST2, kind: 'pane', workspaceId: 'rws', paneId: 'rp' } }))).not.toThrow();
    expect(() => s.proposeOut(input({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'rp2' } }))).not.toThrow();
    s.revoke(id, 'local');
    expect(() => s.proposeOut(input())).not.toThrow();
  });

  it('caps live links per remote host', () => {
    const s = make();
    for (let i = 0; i < LINKS_PER_HOST_MAX; i++) s.receiveProposal({ ...input(at(i)), linkId: uuid() });
    expect(() => s.receiveProposal({ ...input(at(999)), linkId: uuid() })).toThrow(/live links/);
    // Another host is unaffected; ending one frees a slot.
    expect(() => s.proposeOut(input({ ...at(999), remote: { hostId: HOST2, kind: 'pane', workspaceId: 'a', paneId: 'b' } }))).not.toThrow();
    s.revoke(s.listByHost(HOST)[0].linkId, 'local');
    expect(() => s.receiveProposal({ ...input(at(999)), linkId: uuid() })).not.toThrow();
  });

  it('bounds remote ids and sanitizes the label', () => {
    const s = make();
    const long = 'x'.repeat(129);
    expect(() => s.receiveProposal({ ...input({ remote: { hostId: HOST, kind: 'pane', workspaceId: long, paneId: 'p' } }), linkId: uuid() })).toThrow(/remote/);
    expect(() => s.receiveProposal({ ...input({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p\n1' } }), linkId: uuid() })).toThrow(/remote/);
    expect(() => s.receiveProposal({ ...input({ local: { kind: 'pane', workspaceId: 'w\u0000', paneId: 'p' } }), linkId: uuid() })).toThrow(/local/);
    const rec = s.receiveProposal({
      ...input({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p', label: ` a\u001b[31m${'b'.repeat(100)}` } }),
      linkId: uuid(),
    });
    expect(rec.remote.label).toMatch(/^a \[31mb+$/);
    expect(rec.remote.label).toHaveLength(64);
    const blank = s.receiveProposal({ ...input({ ...at(3), remote: { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p', label: '  ' } }), linkId: uuid() });
    expect(blank.remote).not.toHaveProperty('label');
  });

  it('rejects malformed input', () => {
    const s = make();
    expect(() => s.proposeOut(input({ remote: { hostId: 'nope', kind: 'pane', workspaceId: 'a', paneId: 'b' } }))).toThrow(/remote/);
    expect(() => s.proposeOut(input({ local: { kind: 'pane', workspaceId: '', paneId: 'b' } }))).toThrow(/local/);
    expect(() => s.markBroken(linkIn(s, 'active'), 'revoked-local' as never)).toThrow(/reason/);
  });

  it('prunes the oldest terminal links beyond TERMINAL_KEEP', () => {
    const s = make();
    const first = linkIn(s, 'revoked', at(0));
    for (let i = 1; i <= TERMINAL_KEEP; i++) {
      clock += 1;
      linkIn(s, 'revoked', at(i));
    }
    expect(s.get(first)).toBeUndefined();
    expect(s.list().filter((r) => r.state === 'revoked')).toHaveLength(TERMINAL_KEEP);
    expect(make().list()).toHaveLength(TERMINAL_KEEP);
  });
});

describe('LinkStore.forgetHost (revoke cascade)', () => {
  it('ends every live link to the host as revoked-remote and leaves others alone', () => {
    const s = make();
    const a = linkIn(s, 'active');
    const b = linkIn(s, 'proposed-in', at(2));
    const c = linkIn(s, 'proposed-out', at(3));
    const done = linkIn(s, 'broken', at(4));
    const other = linkIn(s, 'active', { ...at(5), remote: { hostId: HOST2, kind: 'pane', workspaceId: 'x', paneId: 'y' } });
    expect(s.forgetHost(HOST)).toBe(3);
    for (const id of [a, b, c]) expect(s.get(id)).toMatchObject({ state: 'revoked', endedReason: 'revoked-remote' });
    expect(s.get(done)?.state).toBe('broken');
    expect(s.get(other)?.state).toBe('active');
    expect(make().get(a)?.state).toBe('revoked');
    expect(s.forgetHost(HOST)).toBe(0);
  });

  it('keeps its in-memory effect on a failed write', () => {
    const s = make();
    const a = linkIn(s, 'active');
    fail = true;
    expect(() => s.forgetHost(HOST)).toThrow('disk full');
    expect(s.get(a)?.state).toBe('revoked');
  });
});

describe('LinkStore queries', () => {
  it('listByHost and findActive* return every matching link', () => {
    const s = make();
    const a = linkIn(s, 'active');
    const b = linkIn(s, 'active', { remote: { hostId: HOST2, kind: 'pane', workspaceId: 'rws', paneId: 'rp' } });
    linkIn(s, 'proposed-in', { remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'other' } });
    expect(s.listByHost(HOST)).toHaveLength(2);
    expect(s.findActiveByLocalPane('ws1', 'p1').map((r) => r.linkId).sort()).toEqual([a, b].sort());
    expect(s.findActiveByRemote(HOST, 'rws', 'rp').map((r) => r.linkId)).toEqual([a]);
    expect(s.findActiveByRemote(HOST, 'rws', 'other')).toEqual([]);
  });

  it('returned records are copies', () => {
    const s = make();
    const id = linkIn(s, 'active');
    const got = s.get(id);
    if (got) got.allow.inbound = true;
    expect(s.get(id)?.allow.inbound).toBe(false);
  });
});

describe('LinkStore.checkMessage', () => {
  type Args = {
    v?: number;
    host?: string;
    dir: 'inbound' | 'outbound';
    kind: A2aRemoteMessageKind;
    notice?: LinkNotice;
    /** Default `{ onThisLink: true }`; `null` passes no task at all. */
    task?: { onThisLink: boolean } | null;
  };
  type Row = [label: string, state: A2aLinkState, allow: NewLinkInput['allow'], args: Args, expected: string];
  const both = { outbound: true, inbound: true };
  const outOnly = { outbound: true, inbound: false };
  const inOnly = { outbound: false, inbound: true };
  const none = { outbound: false, inbound: false };
  // Versions from linkIn(): proposed-* = 1, active = 2, revoked/broken = 3 (or 2 from proposed-out).
  const rows: Row[] = [
    ['inbound task, inbound allowed', 'active', inOnly, { dir: 'inbound', kind: 'task' }, 'ok'],
    ['inbound task, inbound denied', 'active', outOnly, { dir: 'inbound', kind: 'task' }, 'direction-not-allowed'],
    ['outbound task, outbound allowed', 'active', outOnly, { dir: 'outbound', kind: 'task' }, 'ok'],
    ['outbound task, outbound denied', 'active', inOnly, { dir: 'outbound', kind: 'task' }, 'direction-not-allowed'],
    ['inbound reply, no direction', 'active', none, { dir: 'inbound', kind: 'reply' }, 'ok'],
    ['outbound reply, no direction', 'active', none, { dir: 'outbound', kind: 'reply' }, 'ok'],
    ['inbound state, no direction', 'active', none, { dir: 'inbound', kind: 'state' }, 'ok'],
    ['outbound state, no direction', 'active', none, { dir: 'outbound', kind: 'state' }, 'ok'],
    ['reply for a task not on this link', 'active', both, { dir: 'inbound', kind: 'reply', task: { onThisLink: false } }, 'unknown-task'],
    ['reply with no task verdict', 'active', both, { dir: 'inbound', kind: 'reply', task: null }, 'unknown-task'],
    ['state for a task not on this link', 'active', both, { dir: 'outbound', kind: 'state', task: { onThisLink: false } }, 'unknown-task'],
    ['state with no task verdict', 'active', both, { dir: 'inbound', kind: 'state', task: null }, 'unknown-task'],
    ['task needs no task verdict', 'active', both, { dir: 'inbound', kind: 'task', task: null }, 'ok'],
    ['older version', 'active', both, { v: 1, dir: 'inbound', kind: 'reply' }, 'stale-link-version'],
    ['newer version', 'active', both, { v: 3, dir: 'inbound', kind: 'task' }, 'stale-link-version'],
    ['wrong host', 'active', both, { host: HOST2, dir: 'inbound', kind: 'task' }, 'forbidden'],
    ['wrong host on a revoked link', 'revoked', both, { host: HOST2, dir: 'inbound', kind: 'reply' }, 'forbidden'],
    ['task on proposed-out', 'proposed-out', both, { v: 1, dir: 'outbound', kind: 'task' }, 'link-not-active'],
    ['reply on proposed-in', 'proposed-in', both, { v: 1, dir: 'inbound', kind: 'reply' }, 'link-not-active'],
    ['state on revoked', 'revoked', both, { v: 3, dir: 'inbound', kind: 'state' }, 'link-not-active'],
    ['task on broken', 'broken', both, { v: 3, dir: 'inbound', kind: 'task' }, 'link-not-active'],
    // Lifecycle notices.
    ['accept notice at ours + 1', 'proposed-out', none, { dir: 'inbound', kind: 'link', notice: { state: 'active', version: 2 } }, 'ok'],
    ['accept notice at ours', 'proposed-out', none, { dir: 'inbound', kind: 'link', notice: { state: 'active', version: 1 } }, 'stale-link-version'],
    ['accept notice skipping a version', 'proposed-out', none, { dir: 'inbound', kind: 'link', notice: { state: 'active', version: 3 } }, 'stale-link-version'],
    ['accept notice on proposed-in', 'proposed-in', none, { dir: 'inbound', kind: 'link', notice: { state: 'active', version: 2 } }, 'link-not-active'],
    ['accept notice on active', 'active', none, { dir: 'inbound', kind: 'link', notice: { state: 'active', version: 3 } }, 'link-not-active'],
    ['broken notice at ours + 1', 'active', none, { dir: 'inbound', kind: 'link', notice: { state: 'broken', version: 3, reason: 'pane-closed' } }, 'ok'],
    ['broken notice at a stale version', 'active', none, { dir: 'inbound', kind: 'link', notice: { state: 'broken', version: 2 } }, 'stale-link-version'],
    ['revoke notice at an old version', 'active', none, { dir: 'inbound', kind: 'link', notice: { state: 'revoked', version: 1 } }, 'ok'],
    ['revoke notice at a future version', 'proposed-out', none, { dir: 'inbound', kind: 'link', notice: { state: 'revoked', version: 99 } }, 'ok'],
    ['revoke notice on revoked', 'revoked', both, { dir: 'inbound', kind: 'link', notice: { state: 'revoked', version: 4 } }, 'link-not-active'],
    ['revoke notice from wrong host', 'active', both, { host: HOST2, dir: 'inbound', kind: 'link', notice: { state: 'revoked', version: 3 } }, 'forbidden'],
    ['link kind without a notice', 'active', both, { dir: 'inbound', kind: 'link' }, 'bad-request'],
    ['notice with an unknown state', 'active', both, { dir: 'inbound', kind: 'link', notice: { state: 'weird' as never, version: 3 } }, 'bad-request'],
  ];
  for (const [label, state, allow, a, expected] of rows) {
    it(`${label} -> ${expected}`, () => {
      const s = make();
      const id = linkIn(s, state, { allow });
      const task = a.task === null ? undefined : (a.task ?? { onThisLink: true });
      const r = s.checkMessage(id, a.v ?? 2, a.host ?? HOST, a.dir, a.kind, a.notice, task);
      if (expected === 'ok') expect(r).toMatchObject({ ok: true, link: { linkId: id } });
      else expect(r).toEqual({ ok: false, error: expected });
    });
  }

  // Lifecycle notices from every state: accept only from proposed-out at
  // exactly ours + 1; broken from any live state at exactly ours + 1; revoke
  // from any live state at any version; nothing on a terminal link.
  const STATES: A2aLinkState[] = ['proposed-out', 'proposed-in', 'active', 'revoked', 'broken'];
  const NOTICE_TABLE: Array<[LinkNotice['state'], (st: A2aLinkState, exact: boolean) => string]> = [
    ['active', (st, exact) => (st === 'proposed-out' ? (exact ? 'ok' : 'stale-link-version') : 'link-not-active')],
    ['broken', (st, exact) => (st === 'revoked' || st === 'broken' ? 'link-not-active' : exact ? 'ok' : 'stale-link-version')],
    ['revoked', (st) => (st === 'revoked' || st === 'broken' ? 'link-not-active' : 'ok')],
  ];
  for (const [noticeState, expectFor] of NOTICE_TABLE) {
    for (const st of STATES) {
      for (const exact of [true, false]) {
        const expected = expectFor(st, exact);
        it(`${noticeState} notice on ${st} at ${exact ? 'ours + 1' : 'a stale version'} -> ${expected}`, () => {
          const s = make();
          const id = linkIn(s, st);
          const ours = s.get(id)?.version ?? 0;
          const r = s.checkMessage(id, 0, HOST, 'inbound', 'link', { state: noticeState, version: exact ? ours + 1 : ours });
          if (expected === 'ok') expect(r).toMatchObject({ ok: true });
          else expect(r).toEqual({ ok: false, error: expected });
        });
      }
    }
  }

  it('unknown link -> unknown-link', () => {
    expect(make().checkMessage(uuid(), 1, HOST, 'inbound', 'task')).toEqual({ ok: false, error: 'unknown-link' });
  });

  it('an unrecognised kind is refused', () => {
    const s = make();
    const id = linkIn(s, 'active', { allow: both });
    expect(s.checkMessage(id, 2, HOST, 'inbound', 'bogus' as never)).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('linkFromProposal', () => {
  it('flips perspective and directions', () => {
    const got = linkFromProposal(HOST, {
      linkId: 'L',
      from: { kind: 'pane', workspaceId: 'their-ws', paneId: 'their-p', label: 'codex' },
      to: { kind: 'pane', workspaceId: 'our-ws', paneId: 'our-p' },
      allow: { outbound: true, inbound: false },
    });
    expect(got).toEqual({
      linkId: 'L',
      local: { kind: 'pane', workspaceId: 'our-ws', paneId: 'our-p' },
      remote: { hostId: HOST, kind: 'pane', workspaceId: 'their-ws', paneId: 'their-p', label: 'codex' },
      allow: { outbound: false, inbound: true },
    });
  });
});

describe('LinkStore persistence', () => {
  const file = (): string => path.join(dir, LINKS_FILE);
  const rawLink = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    v: 1,
    linkId: uuid(),
    version: 1,
    state: 'active',
    local: { kind: 'pane', workspaceId: 'ws1', paneId: 'p1' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'rp' },
    allow: { outbound: true, inbound: true },
    proposer: 'local',
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    ...o,
  });
  const expectRejected = (links: unknown[]): void => {
    fs.writeFileSync(file(), JSON.stringify({ v: 1, links }));
    const s = make();
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(`${file()}.corrupt-${clock}`)).toBe(true);
  };

  it('round-trips through a new instance', () => {
    const s = make();
    const a = linkIn(s, 'active');
    linkIn(s, 'broken', at(2));
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).v).toBe(1);
    const t = make();
    expect(t.list()).toEqual(s.list());
    expect(t.checkMessage(a, 2, HOST, 'outbound', 'task')).toMatchObject({ ok: true });
  });

  it('a record without a proposer, or one that contradicts its state, is rejected', () => {
    expectRejected([{ ...rawLink(), proposer: undefined }]);
    expectRejected([rawLink({ state: 'proposed-in', proposer: 'local' })]);
  });

  it('a hand-written valid file loads', () => {
    fs.writeFileSync(file(), JSON.stringify({ v: 1, links: [rawLink(), rawLink({ state: 'revoked', endedReason: 'revoked-local' })] }));
    expect(make().list()).toHaveLength(2);
  });

  it('corrupt file: starts empty, keeps the original as .corrupt-<ts>, warns', () => {
    fs.writeFileSync(file(), JSON.stringify({ v: 1, links: [{ v: 1, linkId: 'x', state: 'weird' }] }));
    const log = vi.fn();
    expect(make({ log }).list()).toEqual([]);
    expect(fs.existsSync(`${file()}.corrupt-${clock}`)).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('corrupt'));
  });

  it('a second corrupt file at the same timestamp gets a counter suffix', () => {
    fs.writeFileSync(`${file()}.corrupt-${clock}`, 'older');
    fs.writeFileSync(file(), 'nope');
    make();
    expect(fs.readFileSync(`${file()}.corrupt-${clock}`, 'utf-8')).toBe('older');
    expect(fs.readFileSync(`${file()}.corrupt-${clock}-1`, 'utf-8')).toBe('nope');
  });

  it('a wrong file version is treated as corrupt', () => {
    fs.writeFileSync(file(), JSON.stringify({ v: 2, links: [] }));
    expect(make().list()).toEqual([]);
    expect(fs.existsSync(`${file()}.corrupt-${clock}`)).toBe(true);
  });

  it('a terminal link without a matching endedReason is rejected', () => expectRejected([rawLink({ state: 'revoked' })]));
  it('a revoked link with a broken reason is rejected', () => expectRejected([rawLink({ state: 'revoked', endedReason: 'pane-closed' })]));
  it('a broken link with a revoke reason is rejected', () => expectRejected([rawLink({ state: 'broken', endedReason: 'revoked-local' })]));
  it('a live link with an endedReason is rejected', () => expectRejected([rawLink({ endedReason: 'revoked-local' })]));
  it('two live links on one pane triple are rejected', () => expectRejected([rawLink(), rawLink({ state: 'proposed-in' })]));
  it('a non-UUID linkId is rejected', () => expectRejected([rawLink({ linkId: 'x' })]));

  it('an unreadable file leaves the store unavailable and the file untouched', () => {
    if (process.platform === 'win32') return;
    fs.mkdirSync(file()); // EISDIR on read: neither missing nor corrupt
    const log = vi.fn();
    const s = make({ log });
    expect(s.list()).toEqual([]);
    expect(() => s.proposeOut(input())).toThrow(/unavailable/);
    expect(fs.statSync(file()).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(false);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('could not be read'));
  });

  it('create / accept / applyRemoteAccept roll back on a failed write', () => {
    const s = make();
    const pin = linkIn(s, 'proposed-in');
    const pout = linkIn(s, 'proposed-out', at(3));
    fail = true;
    expect(() => s.proposeOut(input(at(4)))).toThrow('disk full');
    expect(() => s.receiveProposal({ ...input(at(5)), linkId: uuid() })).toThrow();
    expect(s.list()).toHaveLength(2);
    expect(() => s.accept(pin)).toThrow();
    expect(s.get(pin)).toMatchObject({ state: 'proposed-in', version: 1 });
    expect(() => s.applyRemoteAccept(pout, 2)).toThrow();
    expect(s.get(pout)).toMatchObject({ state: 'proposed-out', version: 1 });
    fail = false;
    expect(make().list()).toHaveLength(2);
  });

  it('revoke and markBroken keep their in-memory effect on a failed write', () => {
    const log = vi.fn();
    const s = make({ log });
    const a = linkIn(s, 'active');
    const b = linkIn(s, 'active', at(2));
    fail = true;
    expect(() => s.revoke(a, 'local')).toThrow('disk full');
    expect(s.get(a)?.state).toBe('revoked');
    expect(s.checkMessage(a, 3, HOST, 'inbound', 'reply')).toEqual({ ok: false, error: 'link-not-active' });
    expect(() => s.markBroken(b, 'pane-closed')).toThrow('disk full');
    expect(s.get(b)?.state).toBe('broken');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('could not be persisted'));
  });
});

describe('LinkStore display fields and discard (PR2b)', () => {
  it('keeps the remote workspace name and repo key across a reload, sanitized', () => {
    const s = make();
    const id = s.proposeOut(input({
      remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'rp', workspaceName: '  API\u0007 server ', gitRemote: 'github.com/acme/api' },
    })).linkId;
    expect(make().get(id)?.remote).toMatchObject({ workspaceName: 'API server', gitRemote: 'github.com/acme/api' });
    // A repo key with whitespace is dropped, not stored.
    const bad = s.proposeOut(input({ ...at(2), remote: { hostId: HOST, kind: 'pane', workspaceId: 'rws', paneId: 'rp', gitRemote: 'a b' } })).linkId;
    expect(s.get(bad)?.remote.gitRemote).toBeUndefined();
  });

  it('discard drops only an unacknowledged proposal, and rolls back on a failed write', () => {
    const s = make();
    const out = linkIn(s, 'proposed-out');
    const inn = linkIn(s, 'proposed-in', at(2));
    expect(() => s.discard(inn)).toThrow(/not allowed/);
    fail = true;
    expect(() => s.discard(out)).toThrow('disk full');
    expect(s.get(out)?.state).toBe('proposed-out');
    fail = false;
    s.discard(out);
    expect(s.get(out)).toBeUndefined();
    expect(make().get(out)).toBeUndefined();
  });
});

describe('LinkStore Moa (brain) ends', () => {
  const brainIn = (o: { hq?: string; rhq?: string; host?: string } = {}): NewLinkInput => ({
    local: { kind: 'brain', workspaceId: o.hq ?? 'hq' },
    remote: { hostId: o.host ?? HOST, kind: 'brain', workspaceId: o.rhq ?? 'rhq' },
    allow: { outbound: true, inbound: true },
  });

  it('stores a brain link without a paneId and finds it by HQ', () => {
    const s = make();
    const id = linkIn(s, 'active', brainIn());
    expect(s.get(id)!.local).toEqual({ kind: 'brain', workspaceId: 'hq' });
    expect(s.get(id)!.remote).not.toHaveProperty('paneId');
    expect(s.findActiveByLocalBrain('hq').map((l) => l.linkId)).toEqual([id]);
    expect(s.findActiveByLocalPane('hq', 'p1')).toEqual([]);
    expect(s.checkMessage(id, 2, HOST, 'inbound', 'task')).toMatchObject({ ok: true, kind: 'brain' });
    expect(make().get(id)?.local.kind).toBe('brain');
  });

  it('refuses brain <-> pane, a brain with a paneId and a pane without one', () => {
    const s = make();
    expect(() => s.proposeOut({ ...brainIn(), remote: { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p' } })).toThrow(/not allowed/);
    expect(() => s.proposeOut({ ...brainIn(), local: { kind: 'brain', workspaceId: 'hq', paneId: 'p' } })).toThrow(/local/);
    expect(() => s.proposeOut(input({ local: { kind: 'pane', workspaceId: 'w' } }))).toThrow(/local/);
  });

  it('allows one live link per remote host\'s Moa, even across a recreated HQ', () => {
    const s = make();
    linkIn(s, 'proposed-out', brainIn());
    expect(() => s.proposeOut(brainIn({ hq: 'hq2', rhq: 'rhq2' }))).toThrow(/already linked/);
    expect(() => s.proposeOut(brainIn({ host: HOST2 }))).not.toThrow();
  });

  it('rejects a stored brain end that carries a paneId', () => {
    const s = make();
    const id = linkIn(s, 'active', brainIn());
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LINKS_FILE), 'utf8')) as { links: Array<{ local: Record<string, unknown> }> };
    raw.links[0].local['paneId'] = 'p';
    fs.writeFileSync(path.join(dir, LINKS_FILE), JSON.stringify(raw));
    expect(make().get(id)).toBeUndefined();
  });
});

describe('LinkStore proposal expiry and proposer', () => {
  it('records who proposed, and drops undecided incoming proposals after the TTL', () => {
    const s = make();
    const out = linkIn(s, 'proposed-out');
    const inn = linkIn(s, 'proposed-in', at(2));
    const act = linkIn(s, 'active', at(3));
    expect(s.get(out)?.proposer).toBe('local');
    expect(s.get(inn)?.proposer).toBe('remote');
    clock += PROPOSAL_TTL_MS - 1;
    expect(s.expireProposals()).toEqual([]);
    clock += 2;
    expect(s.expireProposals().map((l) => l.linkId)).toEqual([inn]);
    expect(s.get(inn)).toMatchObject({ state: 'revoked', endedReason: 'revoked-local' });
    expect(s.get(out)?.state).toBe('proposed-out');
    expect(s.get(act)?.state).toBe('active');
  });

  it('breaks with exposure-revoked', () => {
    const s = make();
    const id = linkIn(s, 'active');
    expect(s.markBroken(id, 'exposure-revoked')).toMatchObject({ state: 'broken', endedReason: 'exposure-revoked' });
    expect(make().get(id)?.endedReason).toBe('exposure-revoked');
  });
});
