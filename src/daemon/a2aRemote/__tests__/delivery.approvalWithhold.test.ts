// A queued status about approvals is held to the approvals setting as it
// leaves: dropped while the setting is off for that PC, and dropped when it
// carries a command and the setting is no longer `command`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aApprovalExposure, type A2aOutboxRecordV1, type A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import { A2aRemoteDelivery, type A2aRemoteDeliveryDeps } from '../delivery';
import { APPROVAL_STATUS_ID_PREFIX, statusMessageId } from '../outbound';

const HOST = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function delivery(exposure: { now: A2aApprovalExposure | null }): A2aRemoteDelivery {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-withhold-'));
  dirs.push(dir);
  return new A2aRemoteDelivery({
    dir,
    links: { list: () => [] },
    taskService: {},
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: () => undefined,
    refreshLink: async () => null,
    approvalExposure: () => exposure.now,
    log: () => undefined,
  } as unknown as A2aRemoteDeliveryDeps);
}

const OFFER = { promptId: '0123456789abcdef', tool: 'Bash', command: 'ls', redacted: false, cut: false, allowed: ['allow', 'deny'] as Array<'allow' | 'deny'> };
function queue(d: A2aRemoteDelivery, status: A2aRemoteStatusV1, source?: 'approvals'): A2aOutboxRecordV1 {
  return d.outbox.enqueue(HOST, {
    protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: statusMessageId(`t-${Math.random()}`, status, source),
    kind: 'status', taskId: 't', status, sentAt: new Date().toISOString(),
  });
}
const withhold = (d: A2aRemoteDelivery, rec: A2aOutboxRecordV1): boolean => (d as unknown as { withhold(h: string, r: A2aOutboxRecordV1): boolean }).withhold(HOST, rec);
const since = '2026-11-19T00:00:00.000Z';

describe('a queued approvals status as it leaves', () => {
  it('off for that PC now: an offer or outcomes are dropped, never sent', () => {
    const exposure: { now: A2aApprovalExposure | null } = { now: null };
    const d = delivery(exposure);
    const offer = queue(d, { kind: 'question', since, detail: { question: 'permission', approval: OFFER } });
    const outcomes = queue(d, { kind: 'working', since, detail: { approvals: [{ messageId: 'ap-1', outcome: 'done' }] } });
    expect(withhold(d, offer)).toBe(true);
    expect(withhold(d, outcomes)).toBe(true);
    expect(d.outbox.get(HOST, offer.seq)).toMatchObject({ state: 'refused' });
    expect(d.outbox.get(HOST, outcomes.seq)).toMatchObject({ state: 'refused' });
  });

  it('no longer `command`: one carrying a command is dropped; one without goes', () => {
    const exposure: { now: A2aApprovalExposure | null } = { now: 'tool-only' };
    const d = delivery(exposure);
    const withCommand = queue(d, { kind: 'question', since, detail: { question: 'permission', approval: OFFER } });
    const { command: _c, ...toolOnly } = OFFER;
    const without = queue(d, { kind: 'question', since, detail: { question: 'permission', approval: { ...toolOnly, allowed: ['deny'] } } });
    expect(withhold(d, withCommand)).toBe(true);
    expect(d.outbox.get(HOST, withCommand.seq)).toMatchObject({ state: 'refused' });
    expect(withhold(d, without)).toBe(false);
    exposure.now = 'command';
    const again = queue(d, { kind: 'question', since, detail: { question: 'permission', approval: OFFER } });
    expect(withhold(d, again)).toBe(false);
  });

  it('off for that PC now: every status the approvals producer made is dropped, its plain ones too', () => {
    const exposure: { now: A2aApprovalExposure | null } = { now: null };
    const d = delivery(exposure);
    const plain = queue(d, { kind: 'waiting-input', since }, 'approvals');
    expect(plain.envelope.messageId.startsWith(APPROVAL_STATUS_ID_PREFIX)).toBe(true);
    expect(withhold(d, plain)).toBe(true);
    expect(d.outbox.get(HOST, plain.seq)).toMatchObject({ state: 'refused' });
    // Another producer's plain status (a headless worker's) goes.
    const headless = queue(d, { kind: 'waiting-input', since });
    expect(headless.envelope.messageId.startsWith('ss-')).toBe(true);
    expect(withhold(d, headless)).toBe(false);
    exposure.now = 'tool-only';
    expect(withhold(d, queue(d, { kind: 'working', since }, 'approvals'))).toBe(false);
  });

  it('a status about nothing approvals-related is not touched', () => {
    const d = delivery({ now: null });
    const plain = queue(d, { kind: 'working', since });
    expect(withhold(d, plain)).toBe(false);
  });
});
