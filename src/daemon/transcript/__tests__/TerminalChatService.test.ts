import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChatService } from '../TerminalChatService';
async function fixture(run: (f: { service: TerminalChatService; setOwner: (value: number) => void; onRequest: (fn: () => void) => void; requests: unknown[]; file: string }) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-tui-chat-'));
  const requests: unknown[] = []; let hook = () => undefined;
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe('Bearer ' + 'a'.repeat(64));
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const request = JSON.parse(body); requests.push(request); hook();
      res.end(JSON.stringify(request.action === 'read' ? { available: true, sessionId: 'ses_one', epoch: 'epoch:1', phase: 'complete', events: [{ id: 'part-1', kind: 'assistant_text', text: 'native reply' }] } : { result: 'sent' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  let pid = 123;
  const file = path.join(directory, createHash('sha256').update('pane').digest('hex') + '.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, agent: 'opencode', pid, port: address.port, token: 'a'.repeat(64) }), { mode: 0o600 });
  const service = new TerminalChatService({ directory, owner: async () => ({ pid, incarnation: 'incarnation' }), emit: vi.fn() });
  try { await run({ service, setOwner: value => { pid = value; }, onRequest: fn => { hook = fn as typeof hook; }, requests, file }); }
  finally { service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
}
describe('native TUI attachment', () => {
  it('reads through the owned process, and sends only to the displayed native session', async () => fixture(async f => {
    expect((await f.service.read('pane'))?.status).toMatchObject({ agentSessionId: 'ses_one', terminal: { agent: 'opencode', capabilities: { send: true } } });
    expect(await f.service.send('pane', 'ses_other', 'hello', 'request-1234567890')).toBe('session_changed');
    expect(await f.service.send('pane', 'ses_one', 'hello', 'request-1234567890')).toBe('sent');
    expect(f.requests.filter((r: any) => r.action === 'send')).toEqual([{ action: 'send', sessionId: 'ses_one', epoch: 'epoch:1', text: 'hello', requestId: 'request-1234567890' }]);
  }));
  it('refuses a descriptor from another process before any network request', async () => fixture(async f => {
    f.setOwner(456); expect(await f.service.read('pane')).toBeNull(); expect(f.requests).toEqual([]);
  }));
  it('discards a response when the pane owner changes during the request', async () => fixture(async f => {
    f.onRequest(() => f.setOwner(456)); expect(await f.service.read('pane')).toBeNull();
  }));
  it.skipIf(process.platform === 'win32')('does not follow descriptor symlinks', async () => fixture(async f => {
    await fs.rename(f.file, f.file + '.other'); await fs.symlink(f.file + '.other', f.file);
    expect(await f.service.read('pane')).toBeNull(); expect(f.requests).toEqual([]);
  }));
});
