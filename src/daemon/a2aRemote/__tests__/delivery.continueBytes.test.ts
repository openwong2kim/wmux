// The delivery layer's part in a continued conversation's bytes: it
// registers their routes, and pulls them only from a PC this one joined.
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { LinkStore } from '../linkStore';
import { A2aRouteTable } from '../routes';
import type { SessionClient } from '../session';

const JOINED = '11111111-1111-4111-8111-111111111111';
const JOINER = '22222222-2222-4222-8222-222222222222';
const quiet = (): void => undefined;

let dir: string;
let log: AppendOnlyLog;
let delivery: A2aRemoteDelivery;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-bytes-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: quiet });
  log.open();
});
afterEach(async () => {
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('A2aRemoteDelivery and the continue bytes', () => {
  it('registers their routes, and fetches only from a PC this one joined', async () => {
    const host: A2aRemoteHostRecordV1 = { v: 1, hostId: JOINED, name: 'A', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' };
    const fetched: string[] = [];
    const client: SessionClient = {
      requestJson: async () => ({ status: 200, json: { ok: true, duplicate: false } }),
      // A stream that never yields: only the fetch is under test.
      openStream: async function* (_p, { signal }) {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        yield* [];
      },
      getStream: async (p, _opts, consume) => {
        fetched.push(p);
        return consume({ headers: {}, body: Readable.from([Buffer.from('bytes')]) as unknown as http.IncomingMessage });
      },
    };
    const continueBytes = { registerRoutes: vi.fn() };
    delivery = new A2aRemoteDelivery({
      dir: path.join(dir, 'a2a'),
      links: new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet }),
      taskService: new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: 1 } }),
      peers: { list: () => [{ hostId: JOINER, name: 'C' }] },
      remoteHosts: { list: () => [host], get: (h) => (h === JOINED ? host : undefined), credentialFor: () => ({ peerId: '33333333-3333-4333-8333-333333333333', secret: 'a'.repeat(43) }) },
      broadcast: quiet,
      refreshLink: async () => undefined,
      continueBytes,
      client: () => client,
      log: quiet,
    });
    const table = new A2aRouteTable();
    delivery.registerRoutes(table);
    expect(continueBytes.registerRoutes).toHaveBeenCalledWith(table);

    delivery.syncSessions();
    // A PC that joined this one uploads instead: nothing to fetch from.
    expect(delivery.continueFetch(JOINER)).toBeNull();
    const get = delivery.continueFetch(JOINED);
    expect(get).not.toBeNull();
    const text = await get!('/api/a2a/continue/x/y', { timeoutMs: 1_000, signal: new AbortController().signal }, async ({ body }) => {
      let out = '';
      for await (const chunk of body) out += (chunk as Buffer).toString('utf8');
      return out;
    });
    expect(text).toBe('bytes');
    expect(fetched).toEqual(['/api/a2a/continue/x/y']);
  });
});
