// Continue envelopes through acceptInbound: routed to the receiver before any
// link check, answered not-allowed while the policy is off, refused when
// malformed, and an unknown link to a build without a receiver.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { defaultContinuePolicy } from '../../../shared/a2aContinue';
import { defaultSpawnPolicy } from '../../../shared/a2aSpawn';
import { A2aContinueReceiver } from '../continueReceiver';
import { ContinueRequestStore } from '../continueRequestStore';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const peer = { hostId: HOST };
const continueId = `ct-${crypto.randomUUID()}`;
const request = {
  v: 1, continueId, sessionId: crypto.randomUUID(), agent: 'claude',
  repo: { origin: 'github.com/acme/widget', branch: 'main', head: 'a'.repeat(40) }, estimate: { bytes: 10, files: 0 },
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

let dir: string;
let sent: A2aRemoteEnvelope[];
let enabled: boolean;
let deps: InboundDeps;
let withContinue: InboundDeps;
let receiver: A2aContinueReceiver;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-inbound-'));
  sent = [];
  enabled = false;
  receiver = new A2aContinueReceiver({
    policy: { get: () => ({ ...defaultContinuePolicy(), in: { enabled, permissionMode: 'auto' } }) },
    spawnPolicy: { get: () => ({ ...defaultSpawnPolicy(), enabled: true, hosts: { [HOST]: { allowed: true } }, agents: ['claude'] }) },
    requests: new ContinueRequestStore({ dir, scheduleHarden: () => undefined }),
    enqueue: (_hostId, e) => void sent.push(e),
    originKeyOf: async () => null,
    isRepoTop: async () => true,
    freeBytes: async () => 0,
    sessionLive: () => false,
    resendCoalesceMs: 0,
    log: () => undefined,
  });
  deps = {
    linkStore: new LinkStore({ dir, scheduleHarden: () => undefined }),
    // No continue envelope reaches the ledger.
    taskService: {} as InboundDeps['taskService'],
    broadcast: () => undefined,
    aliasFor: () => 'pc-a',
  };
  withContinue = { ...deps, continue: receiver };
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (state: string, body: Record<string, unknown>): A2aRemoteEnvelope => ({
  protocol: A2A_REMOTE_PROTOCOL, linkId: continueId, linkVersion: 0, messageId: crypto.randomUUID(), kind: 'link',
  link: { state, version: 0 } as A2aRemoteEnvelope['link'], ...body, sentAt: new Date().toISOString(),
});
const codes = () => sent.map((e) => e.continueResult?.code);

describe('acceptInbound — continuing a conversation rides a link envelope', () => {
  it('with the policy off a request is answered not-allowed, before any link check', async () => {
    expect(await acceptInbound(env('continue', { continue: request }), peer, withContinue)).toEqual({ ok: true, duplicate: false });
    expect(sent[0]).toMatchObject({ linkId: continueId, linkVersion: 0, kind: 'link', link: { state: 'continue-result' } });
    expect(codes()).toEqual(['not-allowed']);
  });

  it('a request, a manifest and a status query reach the receiver; a result from the other PC is taken and dropped', async () => {
    enabled = true;
    expect(await acceptInbound(env('continue', { continue: request }), peer, withContinue)).toEqual({ ok: true, duplicate: false });
    await receiver.idle();
    expect(codes()).toEqual(['repo-not-found']);
    const manifest = { v: 1, continueId, head: 'a'.repeat(40), transcript: { sha256: 'b'.repeat(64), bytes: 1 }, files: [] };
    expect(await acceptInbound(env('continue-manifest', { continueManifest: manifest }), peer, withContinue)).toMatchObject({ ok: true });
    expect(await acceptInbound(env('continue-status', { continueStatus: { v: 1, continueId } }), peer, withContinue)).toMatchObject({ ok: true });
    expect(codes()).toEqual(['repo-not-found', 'repo-not-found', 'repo-not-found']);
    const result = { v: 1, continueId, code: 'started' };
    expect(await acceptInbound(env('continue-result', { continueResult: result }), peer, withContinue)).toEqual({ ok: true, duplicate: false });
    expect(sent).toHaveLength(3);
  });

  it('a malformed body is refused; without a receiver (an older build) it is an unknown link', async () => {
    expect(await acceptInbound(env('continue', { continue: { ...request, extra: 1 } }), peer, withContinue)).toEqual({ ok: false, error: 'bad-request' });
    expect(await acceptInbound(env('continue-manifest', { continueManifest: { v: 1, continueId } }), peer, withContinue)).toEqual({ ok: false, error: 'bad-request' });
    expect(await acceptInbound(env('continue-result', { continueResult: { v: 1, continueId, code: 'maybe' } }), peer, withContinue)).toEqual({ ok: false, error: 'bad-request' });
    expect(await acceptInbound(env('continue', { continue: request }), peer, deps)).toEqual({ ok: false, error: 'unknown-link' });
    expect(sent).toEqual([]);
  });
});
