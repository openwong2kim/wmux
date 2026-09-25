import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChatService } from '../TerminalChatService';

interface Plugin { epoch: string; answer: (res: ServerResponse) => void; requests: Record<string, unknown>[] }

async function fixture(run: (f: { service: TerminalChatService; plugin: Plugin }) => Promise<void>, log?: string[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-tui-send-'));
  const plugin: Plugin = { epoch: 'a'.repeat(32) + ':1:ses_one', answer: res => res.end(JSON.stringify({ result: 'sent' })), requests: [] };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const request = JSON.parse(body); plugin.requests.push(request); log?.push(`plugin:${request.action}`);
      if (request.action === 'read') {
        res.end(JSON.stringify({ available: true, sessionId: 'ses_one', epoch: plugin.epoch, phase: 'complete', events: [] }));
      } else plugin.answer(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  const file = path.join(directory, createHash('sha256').update('pane').digest('hex') + '.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, agent: 'opencode', pid: 123, port: address.port, token: 'b'.repeat(64) }), { mode: 0o600 });
  const service = new TerminalChatService({ directory, owner: async () => { log?.push('owner'); return { pid: 123, incarnation: 'i' }; }, emit: vi.fn() });
  try { await run({ service, plugin }); }
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
