import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChatService } from '../TerminalChatService';

interface Plugin { epoch: string; answer: (res: ServerResponse) => void; requests: Record<string, unknown>[]; read?: Record<string, unknown> }

async function fixture(run: (f: { service: TerminalChatService; plugin: Plugin; emit: ReturnType<typeof vi.fn> }) => Promise<void>, log?: string[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-tui-send-'));
  const plugin: Plugin = { epoch: 'a'.repeat(32) + ':1:ses_one', answer: res => res.end(JSON.stringify({ result: 'sent' })), requests: [] };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const request = JSON.parse(body); plugin.requests.push(request); log?.push(`plugin:${request.action}`);
      if (request.action === 'read') {
        res.end(JSON.stringify({ available: true, sessionId: 'ses_one', epoch: plugin.epoch, phase: 'complete', events: [], ...plugin.read }));
      } else plugin.answer(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  const file = path.join(directory, createHash('sha256').update('pane').digest('hex') + '.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, agent: 'opencode', pid: 123, port: address.port, token: 'b'.repeat(64) }), { mode: 0o600 });
  const emit = vi.fn();
  const service = new TerminalChatService({ directory, owner: async () => { log?.push('owner'); return { pid: 123, incarnation: 'i' }; }, emit });
  try { await run({ service, plugin, emit }); }
  finally { service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
}
const sends = (plugin: Plugin) => plugin.requests.filter(r => r.action === 'send');
const ID = '1758712345123-6f1d2c3b-4a59-4e87-9b10-2c3d4e5f6a7b';

describe('TerminalChatService.send (phone bridge)', () => {
  it('refuses a route switch away and back: same ses_ id, new generation', async () => fixture(async f => {
    const held = (await f.service.read('pane'))!.page.cursor.historyEpoch!;
    f.plugin.epoch = 'a'.repeat(32) + ':2:ses_one';
    expect(await f.service.send('pane', 'ses_one', 'hi', ID, { expectedRawEpoch: held })).toEqual({ result: 'session_changed' });
    expect(sends(f.plugin)).toEqual([]);
  }));

  it('forwards the raw epoch of the read it compared, including a token-derived one', async () => fixture(async f => {
    expect(await f.service.send('pane', 'ses_one', 'hi', ID, { expectedRawEpoch: f.plugin.epoch })).toEqual({ result: 'sent' });
    expect(sends(f.plugin)).toEqual([{ action: 'send', sessionId: 'ses_one', epoch: f.plugin.epoch, text: 'hi', requestId: ID }]);
  }));

  it('refuses a request over 24,000 bytes before any send reaches the plugin', async () => fixture(async f => {
    expect(await f.service.send('pane', 'ses_one', '가'.repeat(16_000), ID)).toEqual({ result: 'error', reason: 'too-large' });
    expect(sends(f.plugin)).toEqual([]);
  }));

  it('re-authorizes immediately before the plugin request', async () => fixture(async f => {
    expect(await f.service.send('pane', 'ses_one', 'hi', ID, { authorized: async () => false })).toEqual({ result: 'error', reason: 'unauthorized' });
    expect(sends(f.plugin)).toEqual([]);
  }));

  it('re-authorizes after the owner lookup, descriptor read and owner re-check, right before the request', async () => {
    const log: string[] = [];
    await fixture(async f => {
      const authorized = async (stage?: string) => { log.push(`auth:${stage}`); return true; };
      expect(await f.service.send('pane', 'ses_one', 'hi', ID, { authorized })).toEqual({ result: 'sent' });
    }, log);
    expect(log).toEqual(['owner', 'owner', 'plugin:read', 'owner', 'owner', 'owner', 'auth:first-write', 'plugin:send', 'owner']);
  });

  it('maps receipts-full distinctly and tolerates an old plugin with a bare unavailable', async () => fixture(async f => {
    f.plugin.answer = res => res.end(JSON.stringify({ result: 'unavailable', reason: 'receipts-full' }));
    expect(await f.service.send('pane', 'ses_one', 'hi', ID)).toEqual({ result: 'unavailable', reason: 'receipts-full' });
    f.plugin.answer = res => res.end(JSON.stringify({ result: 'unavailable' }));
    expect(await f.service.send('pane', 'ses_one', 'hi', ID)).toEqual({ result: 'unavailable' });
  }));

  it('reports a lost answer after the request left as transport-lost', async () => fixture(async f => {
    f.plugin.answer = res => res.destroy();
    expect(await f.service.send('pane', 'ses_one', 'hi', ID)).toEqual({ result: 'unconfirmed', reason: 'transport-lost' });
    expect(sends(f.plugin)).toHaveLength(1);
  }));

  it('treats a plugin refusal status as nothing dispatched', async () => fixture(async f => {
    f.plugin.answer = res => { res.writeHead(400); res.end(); };
    expect(await f.service.send('pane', 'ses_one', 'hi', ID)).toEqual({ result: 'unavailable' });
  }));
});

describe('TerminalChatService.abort (phone and desktop Stop)', () => {
  const TURN = 't1:oc.0123456789abcdef01234567';
  const aborts = (plugin: Plugin) => plugin.requests.filter(r => r.action === 'abort');
  const current = (f: { plugin: Plugin }) => {
    f.plugin.read = { phase: 'running', actions: ['read', 'send', 'abort'], turnId: TURN, turnStartedAt: 1_758_712_345_000 };
  };

  it('an old plugin (no actions) has cancel:false, no turn, and is never sent an abort', async () => fixture(async f => {
    const read = await f.service.read('pane');
    expect(read?.status.terminal?.capabilities.cancel).toBe(false);
    expect(read).not.toHaveProperty('turn');
    expect(await f.service.abort('pane', 'ses_one')).toEqual({ result: 'unavailable' });
    expect(aborts(f.plugin)).toEqual([]);
  }));

  it('reads the advertised abort and the plugin turn', async () => fixture(async f => {
    current(f);
    const read = await f.service.read('pane');
    expect(read?.status.terminal?.capabilities.cancel).toBe(true);
    expect(read?.turn).toEqual({ id: TURN, state: 'running', startedAt: 1_758_712_345_000 });
    f.plugin.read = { ...f.plugin.read, turnId: 'not a turn id' };
    expect(await f.service.read('pane')).not.toHaveProperty('turn');
  }));

  it('forwards the compared epoch and turn id and names the plugin turn', async () => fixture(async f => {
    current(f);
    f.plugin.answer = res => res.end(JSON.stringify({ result: 'sent', turnId: TURN, phase: 'running' }));
    expect(await f.service.abort('pane', 'ses_one', { expectedRawEpoch: f.plugin.epoch, turnId: TURN }))
      .toEqual({ result: 'sent', turn: { id: TURN, state: 'running' } });
    expect(aborts(f.plugin)).toEqual([{ action: 'abort', sessionId: 'ses_one', epoch: f.plugin.epoch, turnId: TURN }]);
  }));

  it('refuses a stale epoch, another session, or a failed re-authorization before the plugin', async () => fixture(async f => {
    current(f);
    expect(await f.service.abort('pane', 'ses_one', { expectedRawEpoch: 'x:1:ses_one' })).toEqual({ result: 'session_changed' });
    expect(await f.service.abort('pane', 'ses_two')).toEqual({ result: 'session_changed' });
    expect(await f.service.abort('pane', 'ses_one', { authorized: async () => false })).toEqual({ result: 'error', reason: 'unauthorized' });
    expect(aborts(f.plugin)).toEqual([]);
  }));

  it('a watch that loses the plugin turns cancel off with send', async () => fixture(async f => {
    current(f);
    f.service.subscribe('c', 'pane');
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledTimes(1));
    expect(f.emit.mock.calls[0][1].status.terminal.capabilities.cancel).toBe(true);
    f.plugin.read = { phase: 'unknown-phase' };
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(f.emit.mock.calls[1][1].status.terminal.capabilities).toMatchObject({ send: false, cancel: false });
  }));

  it('maps an unknown answer to unavailable and a lost one to unconfirmed', async () => fixture(async f => {
    current(f);
    f.plugin.answer = res => res.end(JSON.stringify({ result: 'maybe' }));
    expect(await f.service.abort('pane', 'ses_one')).toEqual({ result: 'unavailable' });
    f.plugin.answer = res => res.end(JSON.stringify({ result: 'prompt_active', turnId: TURN, phase: 'awaiting_input' }));
    expect(await f.service.abort('pane', 'ses_one')).toMatchObject({ result: 'prompt_active' });
    f.plugin.answer = res => { res.writeHead(400); res.end(); };
    expect(await f.service.abort('pane', 'ses_one')).toEqual({ result: 'unavailable' });
    f.plugin.answer = res => res.destroy();
    expect(await f.service.abort('pane', 'ses_one')).toEqual({ result: 'unconfirmed', reason: 'transport-lost' });
  }));
});
