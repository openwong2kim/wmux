// The daemon.folderTrustState contract, over a real DaemonClient and a real
// DaemonPipeServer: main's gate falls back to it when the renderer has no
// screen for a pane, and anything but a clear answer must read as 'unknown'.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonPipeServer } from '../../daemon/DaemonPipeServer';
import { DaemonClient } from '../DaemonClient';
import { registerFolderTrustRpc } from '../../daemon/folderTrustState';
import { RingBuffer } from '../../daemon/RingBuffer';

const TOKEN = 'test-token-folder-trust';

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-foldertrust-${id}`;
  return path.join(os.tmpdir(), `wmux-test-foldertrust-${id}.sock`);
}

describe('DaemonClient.folderTrustState', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;
  let answer: () => Promise<unknown>;
  let asked: unknown[];
  let budgets: unknown[];

  beforeEach(async () => {
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    asked = [];
    budgets = [];
    answer = async () => ({ state: 'clear' });
    server.onRpc('daemon.folderTrustState', async (params) => {
      asked.push(params['id']);
      budgets.push(params['budgetMs']);
      return answer();
    });
    await server.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
  });

  it("asks for the session by id and returns the daemon's verdict", async () => {
    for (const state of ['trust', 'clear', 'unknown'] as const) {
      answer = async () => ({ state });
      expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state });
    }
    expect(asked).toEqual(['daemon-1', 'daemon-1', 'daemon-1']);
  });

  it('sends a read budget only when the caller names one', async () => {
    await client.folderTrustState('daemon-1', 1150, 1000);
    await client.folderTrustState('daemon-1', 400);
    expect(budgets).toEqual([1000, undefined]);
  });

  it("carries the reason tag of an 'unknown', and drops one it cannot log", async () => {
    answer = async () => ({ state: 'unknown', reason: 'unseen-cells' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'unknown', reason: 'unseen-cells' });
    answer = async () => ({ state: 'clear', reason: 'unseen-cells' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'clear' });
    answer = async () => ({ state: 'unknown', reason: 'two\nlines' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'unknown' });
  });

  it('carries the mark of another dialog in the cells read, never on a trust verdict', async () => {
    answer = async () => ({ state: 'unknown', reason: 'unseen-cells', dialog: true });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'unknown', reason: 'unseen-cells', dialog: true });
    answer = async () => ({ state: 'clear', dialog: true });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'clear', dialog: true });
    answer = async () => ({ state: 'trust', dialog: true });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'trust' });
    answer = async () => ({ state: 'clear', dialog: 'yes' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state: 'clear' });
  });

  it('says why there is no verdict: a malformed answer, an error, an older daemon', async () => {
    answer = async () => ({ state: 'yes' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'malformed answer' });
    answer = async () => { throw new Error('boom'); };
    expect(await client.folderTrustState('daemon-1', 400)).toMatchObject({ unavailable: expect.stringContaining('boom') });
    expect(await client.folderTrustState('daemon-1', 400)).not.toHaveProperty('state');
  });

  it('a daemon without the method, or no answer in time, is unavailable', async () => {
    const olderName = pipeName();
    const older = new DaemonPipeServer(olderName);
    older.setAuthToken(TOKEN);
    older.onRpc('daemon.client.identify', async () => ({ ok: true }));
    await older.start();
    const olderClient = new DaemonClient(olderName, TOKEN);
    try {
      expect(await olderClient.connect()).toBe(true);
      expect(await olderClient.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'daemon predates daemon.folderTrustState' });
    } finally {
      await olderClient.disconnect();
      await older.stop();
    }
    answer = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await client.folderTrustState('daemon-1', 400)).toMatchObject({ unavailable: expect.stringContaining('RPC timeout') });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('is unavailable without asking when the daemon is not connected', async () => {
    await client.disconnect();
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'daemon not connected' });
    expect(asked).toEqual([]);
  });
});

// The daemon's own handler (registerFolderTrustRpc) over the wire: a session
// whose ring holds a measured dialog reads 'trust'; one at a shell, or one it
// does not hold, 'clear'.
describe('daemon.folderTrustState end to end', () => {
  it('answers from the session ring', async () => {
    const name = pipeName();
    const server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    const fixture = (dir: string, name: string) =>
      JSON.parse(fs.readFileSync(path.join(__dirname, '../../daemon/approvals/__tests__/fixtures', dir, `${name}.json`), 'utf8')) as { screen: string[]; cols: number; rows: number };
    const rows = fixture('folder-trust', 'codex-folder-trust-60x30').screen;
    const sessionAt = (bytes: string, cols = 60, height = 30) => {
      const ring = new RingBuffer(64 * 1024);
      ring.noteGeometry(cols, height);
      ring.write(Buffer.from(bytes));
      return { meta: { state: 'attached' as const, cols, rows: height }, ptyProcess: { cols, rows: height }, ringBuffer: ring, bridge: { isMuted: false, outputModes: null, heldOutput: () => null } };
    };
    const frame = (screen: string[]) => `\x1b[2J${screen.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`;
    // A permission prompt: no trust question, another dialog in the cells read.
    const permission = fixture('terminal-prompts', 'claude-bash-boxed-01');
    const sessions = new Map([
      ['pane-trust', sessionAt(frame(rows))],
      ['pane-shell', sessionAt('$ ls\r\nREADME.md\r\n$ ')],
      ['pane-permission', sessionAt(frame(permission.screen), Number(permission.cols), Number(permission.rows))],
    ]);
    registerFolderTrustRpc(server, { getSession: (id) => sessions.get(id) });
    await server.start();
    const c = new DaemonClient(name, TOKEN);
    try {
      expect(await c.connect()).toBe(true);
      expect(await c.folderTrustState('pane-trust', 400)).toEqual({ state: 'trust' });
      expect(await c.folderTrustState('pane-shell', 400)).toEqual({ state: 'clear' });
      expect(await c.folderTrustState('pane-gone', 400)).toEqual({ state: 'clear' });
      expect(await c.folderTrustState('pane-permission', 400)).toEqual({ state: 'clear', dialog: true });
      // A delivery's budget, and one past the ceiling, read the same ring.
      expect(await c.folderTrustState('pane-trust', 1150, 1000)).toEqual({ state: 'trust' });
      expect(await c.folderTrustState('pane-shell', 2150, 60_000)).toEqual({ state: 'clear' });
    } finally {
      await c.disconnect();
      await server.stop();
    }
  });
});
