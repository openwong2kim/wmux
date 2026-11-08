// The engine against something on the relay's endpoint that is not wmux's
// relay, with the real playwright-core: a fake browser that completes
// Playwright's connect handshake, on each transport the relay serves on.
// Only an endpoint that answers Wmux.relayProof with the grant's key is used.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { RELAY_PROOF_METHOD, relayProof, relayProofMatches, newRelayProofNonce } from '../../../shared/relayProof';

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { PlaywrightEngine } from '../PlaywrightEngine';

const RELAY_PATH = '/devtools/browser/relay';
type Mode = 'honest' | 'wrong' | 'unknown' | 'silent';

interface FakeEndpoint {
  endpoint: string;
  /** Every CDP method received, in order, over every connection. */
  methods: string[];
  connections: number;
  /** Resolves once every connection made so far has closed. */
  allClosed: () => Promise<void>;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

/**
 * A fake browser at `place`: answers what Playwright's connectOverCDP asks,
 * and meets Wmux.relayProof as `mode` says (honest: with `key`).
 */
async function fakeEndpoint(place: 'tcp' | 'socket', mode: Mode, key: Buffer): Promise<FakeEndpoint> {
  const methods: string[] = [];
  const open = new Set<WebSocket>();
  let waiters: Array<() => void> = [];
  let connections = 0;
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== RELAY_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      open.add(ws);
      ws.on('close', () => {
        open.delete(ws);
        if (open.size === 0) { for (const w of waiters) w(); waiters = []; }
      });
      ws.on('message', (data) => {
        const c = JSON.parse(data.toString()) as { id: number; method: string; params?: { nonce?: string }; sessionId?: string };
        methods.push(c.method);
        const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ id: c.id, ...body, ...(c.sessionId !== undefined && { sessionId: c.sessionId }) }));
        switch (c.method) {
          case 'Browser.getVersion':
            reply({ result: { protocolVersion: '1.3', product: 'Chrome/140.0.0.0', revision: '@0', userAgent: 'Mozilla/5.0 Chrome/140.0.0.0', jsVersion: '14.0' } });
            return;
          case 'Target.attachToBrowserTarget':
            reply({ result: { sessionId: `BS${connections}-${methods.length}` } });
            return;
          case 'Target.getBrowserContexts':
            reply({ result: { browserContextIds: [] } });
            return;
          case RELAY_PROOF_METHOD:
            if (mode === 'honest') reply({ result: { proof: relayProof(key, Buffer.from(c.params?.nonce ?? '', 'base64url')) } });
            else if (mode === 'wrong') reply({ result: { proof: randomBytes(32).toString('base64url') } });
            else if (mode === 'unknown') reply({ error: { code: -32601, message: `'${c.method}' wasn't found` } });
            return; // silent: never answers
          default:
            reply({ result: {} });
        }
      });
    });
  });
  let endpoint: string;
  if (place === 'tcp') {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${RELAY_PATH}`;
  } else if (process.platform === 'win32') {
    const pipe = `\\\\.\\pipe\\wmux-test-impostor-${randomBytes(8).toString('hex')}`;
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    endpoint = `ws+unix:${pipe}:${RELAY_PATH}`;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-impostor-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'r.sock');
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    endpoint = `ws+unix://${sock}:${RELAY_PATH}`;
  }
  const close = async () => {
    for (const ws of open) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return {
    endpoint,
    methods,
    get connections() { return connections; },
    allClosed: () => (open.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve); })),
    close,
  };
}

/** browser.cdp.info for a Chrome on the pipe, with a relay grant for `endpoint`. */
function answerWith(endpoint: string, key: Buffer): void {
  mockSendRpc.mockImplementation((method: string, params?: { relay?: boolean }) => Promise.resolve(method === 'browser.cdp.info'
    ? {
      workspaceBackend: 'chrome',
      targets: [],
      profile: 'p1',
      piped: true,
      ...(params?.relay && { relay: { endpoint, headers: { Authorization: 'Bearer stolen-or-spent' }, proofKey: key.toString('base64url') } }),
    }
    : {}));
}

const cdpInfoCalls = () => mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.cdp.info').length;
const freshEngine = () => {
  (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance = null;
  return PlaywrightEngine.getInstance();
};

beforeEach(() => {
  mockSendRpc.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  const engine = (PlaywrightEngine as unknown as { instance: PlaywrightEngine | null }).instance;
  if (engine) await engine.disconnect();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const PLACES: Array<['tcp' | 'socket', string]> = [
  ['tcp', 'loopback TCP'],
  ['socket', process.platform === 'win32' ? 'a named pipe' : 'a Unix socket'],
];

describe.each(PLACES.map(([place, name]) => ({ place, name })))('the engine and the relay proof, on $name', ({ place }) => {
  it('connects to an endpoint that proves itself with the grant\'s key (the pinned playwright-core sends Wmux.*)', async () => {
    const key = randomBytes(32);
    const fake = await fakeEndpoint(place, 'honest', key);
    answerWith(fake.endpoint, key);
    const engine = freshEngine();
    await engine.ensureConnected('ws-a');
    expect(fake.methods).toContain(RELAY_PROOF_METHOD);
    expect((engine as unknown as { browser: { isConnected(): boolean } | null }).browser?.isConnected()).toBe(true);
    expect(cdpInfoCalls()).toBe(1);
  }, 30_000);

  for (const mode of ['wrong', 'unknown'] as const) {
    it(`refuses an impostor that completes the handshake but answers the proof ${mode === 'wrong' ? 'wrongly' : 'as unknown'}, and does not retry`, async () => {
      const key = randomBytes(32);
      const fake = await fakeEndpoint(place, mode, key);
      answerWith(fake.endpoint, key);
      const engine = freshEngine();
      await expect(engine.ensureConnected('ws-a')).rejects.toThrow('the browser relay did not prove itself');
      // The handshake ran (the impostor saw it), then the proof; after it, only
      // Playwright's own session housekeeping, nothing the engine drives.
      // One connection, one grant.
      expect(fake.methods).toContain('Browser.getVersion');
      expect(fake.methods).toContain(RELAY_PROOF_METHOD);
      const housekeeping = new Set(['Target.detachFromTarget', 'Runtime.runIfWaitingForDebugger']);
      expect(fake.methods.slice(fake.methods.indexOf(RELAY_PROOF_METHOD) + 1).filter((m) => !housekeeping.has(m))).toEqual([]);
      expect(fake.connections).toBe(1);
      expect(cdpInfoCalls()).toBe(1);
      expect((engine as unknown as { browser: unknown }).browser).toBeNull();
      await fake.allClosed();
    }, 30_000);
  }

  it('refuses an impostor that never answers the proof, within the proof timeout', async () => {
    const key = randomBytes(32);
    const fake = await fakeEndpoint(place, 'silent', key);
    answerWith(fake.endpoint, key);
    const started = Date.now();
    await expect(freshEngine().ensureConnected('ws-a')).rejects.toThrow('the browser relay did not prove itself');
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(fake.connections).toBe(1);
    expect(cdpInfoCalls()).toBe(1);
    await fake.allClosed();
  }, 30_000);
});

describe('the MCP bundle\'s playwright-core and Wmux.*', () => {
  it('sends Wmux.relayProof on a browser CDP session as build-mcp.js builds it', async () => {
    const require = createRequire(__filename);
    const { buildPlaywrightChunk } = require('../../../../scripts/lib/playwright-chunk.cjs') as { buildPlaywrightChunk: (dir: string) => Promise<string> };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pw-chunk-'));
    cleanups.push(() => fs.rmSync(out, { recursive: true, force: true }));
    const bundled = require(await buildPlaywrightChunk(out)) as typeof import('playwright-core');
    const key = randomBytes(32);
    const fake = await fakeEndpoint('tcp', 'honest', key);
    const browser = await bundled.chromium.connectOverCDP(fake.endpoint, { timeout: 10_000 });
    cleanups.push(() => browser.close().catch(() => undefined));
    const session = await browser.newBrowserCDPSession();
    const nonce = newRelayProofNonce();
    const send = session.send.bind(session) as (method: string, params: object) => Promise<{ proof?: unknown }>;
    const answer = await send(RELAY_PROOF_METHOD, { nonce });
    expect(relayProofMatches(key, Buffer.from(nonce, 'base64url'), answer.proof)).toBe(true);
  }, 120_000);
});
