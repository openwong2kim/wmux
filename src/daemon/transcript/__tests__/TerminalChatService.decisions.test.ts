import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChatService } from '../TerminalChatService';

type Answer = { status?: number; body?: unknown; drop?: boolean };
async function fixture(run: (f: { service: TerminalChatService; answer: (a: Answer) => void; requests: Array<Record<string, unknown>> }) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-tui-decisions-'));
  const requests: Array<Record<string, unknown>> = [];
  let next: Answer = { body: {} };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      requests.push(JSON.parse(body));
      if (next.drop) { res.socket?.destroy(); return; }
      res.writeHead(next.status ?? 200); res.end(next.status && next.status >= 400 ? '' : JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await fs.writeFile(path.join(directory, createHash('sha256').update('pane').digest('hex') + '.json'),
    JSON.stringify({ version: 1, agent: 'opencode', pid: 7, port, token: 'a'.repeat(64) }), { mode: 0o600 });
  const service = new TerminalChatService({ directory, owner: async () => ({ pid: 7, incarnation: 'i' }), emit: vi.fn() });
  try { await run({ service, answer: (a) => { next = a; }, requests }); }
  finally { service.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
}

const PERM = { kind: 'permission', requestId: 'per_1', sessionId: 'ses_kid', digest: 'd'.repeat(32), permission: 'bash', patterns: ['touch a'] };

describe('TerminalChatService decisions', () => {
  it('reads the listed decisions and asks about the known ones by their own session', async () => fixture(async (f) => {
    f.answer({ body: { available: true, sessionId: 'ses_root', decisions: [PERM], gone: ['per_0'] } });
    expect(await f.service.readDecisions('pane', [{ requestId: 'per_0', sessionId: 'ses_root' }]))
      .toEqual({ state: 'ok', routeSessionId: 'ses_root', decisions: [PERM], gone: ['per_0'] });
    expect(f.requests).toEqual([{ action: 'decisions.read', known: [{ requestId: 'per_0', sessionId: 'ses_root' }] }]);
  }));
  it('tells a plugin that predates decisions from one with nothing usable to say', async () => fixture(async (f) => {
    // v1 plugin: an unknown action throws (400), or off a session route it refuses stale-session first.
    f.answer({ status: 400 }); expect(await f.service.readDecisions('pane')).toEqual({ state: 'unsupported' });
    f.answer({ body: { available: false, reason: 'stale-session' } }); expect(await f.service.readDecisions('pane')).toEqual({ state: 'unsupported' });
    f.answer({ body: { available: false, reason: 'not-ready' } }); expect(await f.service.readDecisions('pane')).toEqual({ state: 'unavailable' });
    f.answer({ body: { available: true, sessionId: 'ses_root', decisions: 'nope', gone: [] } });
    expect(await f.service.readDecisions('pane')).toEqual({ state: 'unavailable' });
  }));
  it('one malformed entry costs only itself', async () => fixture(async (f) => {
    const cut = { ...PERM, requestId: 'per_2', truncated: true };
    f.answer({ body: { available: true, sessionId: 'ses_root', decisions: [{ ...PERM, requestId: '../x' }, PERM, { ...PERM, digest: 'short' }, cut], gone: [] } });
    expect(await f.service.readDecisions('pane')).toEqual({ state: 'ok', routeSessionId: 'ses_root', decisions: [PERM, cut], gone: [] });
  }));
  it('maps a reply: ok, gone, refused as nothing delivered, a lost answer as uncertain', async () => fixture(async (f) => {
    const reply = { kind: 'permission' as const, requestId: 'per_1', sessionId: 'ses_kid', digest: 'd'.repeat(32), reply: 'once' as const };
    f.answer({ body: { result: 'ok' } }); expect(await f.service.replyDecision('pane', reply)).toBe('ok');
    expect(f.requests.at(-1)).toEqual({ action: 'decisions.reply', ...reply });
    f.answer({ body: { result: 'not_found' } }); expect(await f.service.replyDecision('pane', reply)).toBe('not-found');
    f.answer({ body: { result: 'refused' } }); expect(await f.service.replyDecision('pane', reply)).toBe('refused');
    f.answer({ body: { result: 'changed' } }); expect(await f.service.replyDecision('pane', reply)).toBe('changed');
    f.answer({ body: { result: 'error' } }); expect(await f.service.replyDecision('pane', reply)).toBe('unavailable');
    f.answer({ body: { result: 'unconfirmed' } }); expect(await f.service.replyDecision('pane', reply)).toBe('uncertain');
    f.answer({ drop: true }); expect(await f.service.replyDecision('pane', reply)).toBe('uncertain');
    f.answer({ status: 400 }); expect(await f.service.replyDecision('pane', reply)).toBe('unavailable');
    // Over the plugin's body cap: refused before it leaves, never "uncertain".
    const sent = f.requests.length;
    const huge = { kind: 'question' as const, requestId: 'que_1', sessionId: 'ses_kid', digest: 'd'.repeat(32), answers: Array.from({ length: 16 }, () => ({ options: [0], other: 'x'.repeat(2000) })) };
    expect(await f.service.replyDecision('pane', huge)).toBe('unavailable');
    expect(f.requests.length).toBe(sent);
  }));
});
