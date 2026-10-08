import { describe, expect, it } from 'vitest';
import { moaRemoteTasks } from '../a2aRemoteDelivery';
import { summarizeTask } from '../a2aTaskQueryView';
import {
  a2aEndpointAlias,
  isAllowedEndpointPair,
  isConsistentEndpoint,
  formatInvite,
  formatPeerCredential,
  isA2aRoute,
  looksLikePeerCredential,
  normalizeFingerprint256,
  parseInvite,
  parsePeerCredential,
} from '../a2aRemote';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const PEER_ID = '0b9a7c3e-1f2d-4c5b-8a6e-9d8c7b6a5f4e';
const SECRET = 'A'.repeat(43);

describe('a2aRemote invite', () => {
  it('round-trips and canonicalizes the fingerprint', () => {
    const raw = `wmux-a2a://DESKTOP-WIN2:7681/K7PXM4QA#sha256=${FP.toLowerCase()}`;
    const parsed = parseInvite(raw);
    expect(parsed).toEqual({ ok: true, invite: { host: 'DESKTOP-WIN2', port: 7681, code: 'K7PXM4QA', fingerprint256: FP } });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(`wmux-a2a://DESKTOP-WIN2:7681/K7PXM4QA#sha256=${FP}`);
  });

  it('round-trips a Windows machine name with an underscore', () => {
    const raw = `wmux-a2a://DEV_PC_01.corp.local:7681/K7PXM4QA#sha256=${FP}`;
    const parsed = parseInvite(raw);
    expect(parsed).toEqual({ ok: true, invite: { host: 'DEV_PC_01.corp.local', port: 7681, code: 'K7PXM4QA', fingerprint256: FP } });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(raw);
  });

  it('lets a fragment extension after the fingerprint through the structure check', () => {
    const parsed = parseInvite(`wmux-a2a://DESKTOP-WIN2:7681/K7PXM4QA#sha256=${FP}&alt=10.0.0.2,192.168.0.20`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.invite.fingerprint256).toBe(FP);
  });

  it.each([
    ['', 'empty'],
    ['https://host:7681/K7PXM4QA#sha256=' + FP, 'scheme'],
    ['wmux-a2a://bad!host:7681/K7PXM4QA#sha256=' + FP, 'host'],
    ['wmux-a2a://-dash:7681/K7PXM4QA#sha256=' + FP, 'host'],
    ['wmux-a2a://host:70000/K7PXM4QA#sha256=' + FP, 'port'],
    ['wmux-a2a://h:abc/K7PXM4QA#sha256=' + FP, 'port'],
    ['wmux-a2a://h:0x1f/K7PXM4QA#sha256=' + FP, 'port'],
    ['wmux-a2a://h:/K7PXM4QA#sha256=' + FP, 'port'],
    ['wmux-a2a://h:7681/k7pxm4qa#sha256=' + FP, 'code'],
    ['wmux-a2a://h:7681/#sha256=' + FP, 'code'],
    ['wmux-a2a://h:7681/K7PXM4QA#sha256=GG', 'fingerprint'],
    ['wmux-a2a://h:7681/K7PXM4QA#sha256=', 'fingerprint'],
    ['wmux-a2a://h:7681/K7PXM4QA#sha256=GG&alt=10.0.0.2', 'fingerprint'],
    ['wmux-a2a://host:7681/K7PXM4Q0#sha256=' + FP, 'code'],
    ['wmux-a2a://host:7681/K7PXM4QA#sha256=ABCD', 'fingerprint'],
  ])('rejects %s as %s', (raw, error) => {
    expect(parseInvite(raw)).toEqual({ ok: false, error });
  });
});

describe('a2aRemote peer credential', () => {
  it('round-trips and never contains the device separator', () => {
    const bearer = formatPeerCredential({ peerId: PEER_ID, secret: SECRET });
    expect(bearer).not.toContain('.');
    expect(parsePeerCredential(bearer)).toEqual({ peerId: PEER_ID, secret: SECRET });
    expect(looksLikePeerCredential(bearer)).toBe(true);
  });

  it('refuses near-misses, including a device-shaped credential', () => {
    expect(parsePeerCredential(`${PEER_ID}.${SECRET}`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~${PEER_ID}~short`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~not-a-uuid~${SECRET}`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~${PEER_ID}~${SECRET}~extra`)).toBeNull();
    expect(looksLikePeerCredential(`${PEER_ID}.${SECRET}`)).toBe(false);
  });
});

describe('a2aRemote helpers', () => {
  it('normalizes bare hex fingerprints and rejects wrong lengths', () => {
    expect(normalizeFingerprint256(FP.replace(/:/g, ''))).toBe(FP);
    expect(normalizeFingerprint256(FP.slice(3))).toBeNull();
  });

  it('matches only the a2a route prefix', () => {
    expect(isA2aRoute('/api/a2a/messages')).toBe(true);
    expect(isA2aRoute('/api/a2a')).toBe(false);
    expect(isA2aRoute('/api/sessions')).toBe(false);
  });
});

describe('invite alt addresses', () => {
  const FP2 = Array.from({ length: 32 }, () => 'AB').join(':');
  const base = `wmux-a2a://desk:45660/K7PXM4QA#sha256=${FP2}`;

  it('round-trips alt IPv4s and keeps the alt-less form unchanged', () => {
    const parsed = parseInvite(`${base}&alt=10.0.0.5,192.168.1.9`);
    expect(parsed).toEqual({
      ok: true,
      invite: { host: 'desk', port: 45660, code: 'K7PXM4QA', fingerprint256: FP2, alt: ['10.0.0.5', '192.168.1.9'] },
    });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(`${base}&alt=10.0.0.5,192.168.1.9`);
    const plain = parseInvite(base);
    expect(plain.ok && plain.invite.alt).toBeUndefined();
    if (plain.ok) expect(formatInvite({ ...plain.invite, alt: [] })).toBe(base);
  });

  it.each([
    ['&alt=', 'empty entry'],
    ['&alt=10.0.0.01', 'leading zero'],
    ['&alt=host.example', 'a name'],
    ['&alt=1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5', 'more than four'],
    ['&alt=::1', 'IPv6'],
  ])('rejects alt %s (%s)', (suffix) => {
    expect(parseInvite(`${base}${suffix}`)).toEqual({ ok: false, error: 'alt' });
  });
});

describe('link end kinds (Moa)', () => {
  it('a pane needs a paneId; a brain must not carry one', () => {
    expect(isConsistentEndpoint({ kind: 'pane', paneId: 'p' })).toBe(true);
    expect(isConsistentEndpoint({ kind: 'pane' })).toBe(false);
    expect(isConsistentEndpoint({ kind: 'pane', paneId: '' })).toBe(false);
    expect(isConsistentEndpoint({ kind: 'brain' })).toBe(true);
    expect(isConsistentEndpoint({ kind: 'brain', paneId: '' })).toBe(false);
    expect(isConsistentEndpoint({ kind: 'other', paneId: 'p' })).toBe(false);
  });

  it('links like with like only', () => {
    expect(isAllowedEndpointPair('pane', 'pane')).toBe(true);
    expect(isAllowedEndpointPair('brain', 'brain')).toBe(true);
    expect(isAllowedEndpointPair('brain', 'pane')).toBe(false);
    expect(isAllowedEndpointPair('pane', 'brain')).toBe(false);
  });

  it('aliases a Moa end as <PC>/Moa', () => {
    expect(a2aEndpointAlias('DESK', { kind: 'brain', workspaceId: 'hq', workspaceName: 'HQ' })).toBe('DESK/Moa');
    expect(a2aEndpointAlias('DESK', { kind: 'pane', workspaceId: 'w', paneId: 'p', workspaceName: 'API', label: 'w1-1' })).toBe('DESK/API/w1-1');
  });
});

describe('moaRemoteTasks', () => {
  const id = (n: number): string => `rt-${String(n).padStart(32, '0')}`;
  it('keeps Moa-to-Moa tasks only, with direction and PC, newest first', () => {
    const rows = moaRemoteTasks([
      { id: id(1), state: 'working', title: 'a', from: 'Moa', to: 'PC2/Moa', updatedAt: '2026-10-08T01:00:00.000Z' },
      { id: id(2), state: 'submitted', title: 'b', from: 'PC3/Moa', to: 'Moa', updatedAt: '2026-10-08T02:00:00.000Z' },
      // A remote pane task, even into a workspace named Moa, is not one.
      { id: id(3), state: 'working', title: 'c', from: 'PC2/ws/Moa', to: 'Moa' },
      { id: 'task-local', state: 'working', title: 'd', from: 'Moa', to: 'PC2/Moa' },
    ]);
    expect(rows).toEqual([
      { taskId: id(2), title: 'b', state: 'submitted', direction: 'received', host: 'PC3', updatedAt: '2026-10-08T02:00:00.000Z' },
      { taskId: id(1), title: 'a', state: 'working', direction: 'sent', host: 'PC2', updatedAt: '2026-10-08T01:00:00.000Z' },
    ]);
  });
});

describe('receipts in summaries', () => {
  const id = `rt-${'a'.repeat(32)}`;
  const task = (remote: Record<string, unknown>) => ({
    id, status: { state: 'submitted' }, history: [],
    metadata: { title: 't', from: { name: 'Moa' }, to: { name: 'PC2/Moa' }, remote },
  });
  it('a2a_task_query summaries carry how far the peer got; the Moa panel shows it for sent tasks', () => {
    expect(summarizeTask(task({ direction: 'outbound' }))).not.toHaveProperty('remoteReceipt');
    expect(summarizeTask(task({ remoteDeliveredAt: 'x' }))).toMatchObject({ remoteReceipt: 'delivered' });
    const read = summarizeTask(task({ remoteDeliveredAt: 'x', remoteReadAt: 'y' }));
    expect(read).toMatchObject({ remoteReceipt: 'read' });
    expect(moaRemoteTasks([read])).toMatchObject([{ direction: 'sent', receipt: 'read' }]);
  });
});

