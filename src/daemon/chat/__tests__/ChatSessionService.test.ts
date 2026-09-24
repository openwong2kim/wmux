import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionService } from '../ChatSessionService';
import { BASE_CAPABILITIES, type ChatAdapter, type ChatAdapterContext } from '../adapter';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chat-test-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let ctx!: ChatAdapterContext;
  let complete!: () => void;
  let reject!: (reason: Error) => void;
  let cwd = dir;
  const adapter: ChatAdapter = {
    capabilities: { ...BASE_CAPABILITIES, resume: true },
    connect: vi.fn(async (context) => { ctx = context; return 'native-session'; }),
    prompt: vi.fn(() => new Promise<void>((yes, no) => { complete = yes; reject = no; })),
    cancel: vi.fn(async () => { complete(); }), close: vi.fn(),
  };
  const deps = { directory: path.join(dir, 'sessions'), providers: [{ id: 'test', name: 'Test', transport: 'acp' as const, create: () => adapter }],
    pane: (id: string) => id === 'pane' ? { cwd, env: {} } : undefined, changed: vi.fn() };
  const service = new ChatSessionService(deps); cleanup.push(() => service.dispose());
  return { service, adapter, deps, context: () => ctx, complete: () => complete(), reject: () => reject(new Error('Connection lost')),
    move: () => { cwd = '/different'; } };
}

describe('managed chat session contract', () => {
  it('writes intent before dispatch and deduplicates request IDs including changed payloads', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    const dispatch = f.adapter.prompt;
    vi.mocked(dispatch).mockImplementationOnce(async () => {
      const file = path.join(f.deps.directory, fs.readdirSync(f.deps.directory)[0]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).inFlight).toBe('send-1');
    });
    expect(await f.service.send('pane', 'native-session', 'hello', 'send-1')).toBe('sent');
    await vi.waitFor(() => expect(f.service.status('pane')?.managed?.phase).toBe('ready'));
    expect(await f.service.send('pane', 'native-session', 'hello', 'send-1')).toBe('sent');
    expect(await f.service.send('pane', 'native-session', 'changed', 'send-1')).toBe('error');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects a second turn and stale conversation identities', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    expect(await f.service.send('pane', 'old-session', 'hello', 'one')).toBe('session_changed');
    await f.service.send('pane', 'native-session', 'hello', 'one');
    expect(await f.service.send('pane', 'native-session', 'world', 'two')).toBe('busy');
  });
  it('retains unconfirmed intent across restart and never automatically replays it', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    await f.service.send('pane', 'native-session', 'hello', 'one');
    f.reject(); await vi.waitFor(() => expect(f.service.status('pane')?.managed?.phase).toBe('unconfirmed'));
    expect(f.service.status('pane')?.managed?.phase).toBe('unconfirmed');
    f.service.dispose();
    const restored = new ChatSessionService(f.deps); cleanup.push(() => restored.dispose());
    expect(restored.status('pane')?.managed?.phase).toBe('unconfirmed');
    expect(f.adapter.prompt).toHaveBeenCalledTimes(1);
    expect(await restored.reconnect('pane', 'native-session')).toEqual({ ok: true });
    expect(await restored.send('pane', 'native-session', 'hello', 'one')).toBe('unconfirmed');
    expect(f.adapter.prompt).toHaveBeenCalledTimes(1);
  });
  it('binds approvals to the live turn and refuses replay or foreign-session answers', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    await f.service.send('pane', 'native-session', 'hello', 'one');
    const answer = f.context().request({ kind: 'permission', title: 'Write', options: [{ id: 'allow', label: 'Allow once' }] });
    const request = f.service.status('pane')!.managed!.pending[0];
    expect(await f.service.send('pane', 'native-session', 'world', 'two')).toBe('blocked');
    expect((await f.service.respond('pane', 'foreign', request.id, { optionId: 'allow' })).ok).toBe(false);
    expect((await f.service.respond('pane', 'native-session', request.id, { optionId: 'all' })).ok).toBe(false);
    expect((await f.service.respond('pane', 'native-session', request.id, { optionId: 'allow' })).ok).toBe(true);
    expect(await answer).toEqual({ optionId: 'allow' });
    expect((await f.service.respond('pane', 'native-session', request.id, { optionId: 'allow' })).ok).toBe(false);
  });
  it('cancels pending permissions and ignores late events from the previous connection', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    await f.service.send('pane', 'native-session', 'hello', 'one');
    const oldContext = f.context();
    const answer = oldContext.request({ kind: 'permission', title: 'Write', options: [{ id: 'allow', label: 'Allow' }] });
    expect((await f.service.cancel('pane', 'native-session')).ok).toBe(true);
    expect(await answer).toEqual({});
    await f.service.reconnect('pane', 'native-session');
    oldContext.emit({ id: 'late', kind: 'assistant_text', text: 'wrong connection' });
    expect(f.service.snapshot('pane')!.events.some((e) => e.id === 'late')).toBe(false);
  });
  it('does not send if durable intent cannot be saved', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    const write = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('disk full'); });
    try { expect(await f.service.send('pane', 'native-session', 'hello', 'one')).toBe('error'); }
    finally { write.mockRestore(); }
    expect(f.adapter.prompt).not.toHaveBeenCalled();
  });
  it('uses stable event IDs, bounds messages and paginates without duplicate rows', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    for (let i = 0; i < 100; i++) f.context().emit({ id: String(i), kind: 'assistant_text', text: 'hello' });
    f.context().emit({ id: '99', kind: 'assistant_text', text: 'x'.repeat(200_000) });
    const tail = f.service.snapshot('pane')!;
    const head = f.service.snapshot('pane', tail.cursor.headOffset)!;
    expect(head.events.length + tail.events.length).toBe(100);
    expect(tail.events.at(-1)?.truncated).toBe(true);
    expect(head.hasMore).toBe(false);
  });
  it('invalidates pagination when retention shifts history indices', async () => {
    const f = fixture(); await f.service.start('pane', 'test');
    const epoch = f.service.snapshot('pane')?.cursor.historyEpoch;
    for (let i = 0; i < 2001; i++) f.context().emit({ id: String(i), kind: 'assistant_text', text: 'hello' });
    const page = f.service.snapshot('pane');
    expect(page?.truncatedHead).toBe(true);
    expect(page?.cursor.historyEpoch).toBeTruthy();
    expect(page?.cursor.historyEpoch).not.toBe(epoch);
    expect(f.service.snapshot('pane', 1)?.events[0].id).toBe('1');
  });
  it('preserves malformed disk records and refuses to start over them', async () => {
    const f = fixture(); await f.service.start('pane', 'test'); f.service.dispose();
    const file = path.join(f.deps.directory, fs.readdirSync(f.deps.directory)[0]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.events = [{ id: 'broken', kind: 'assistant_text', text: { invalid: true } }];
    fs.writeFileSync(file, JSON.stringify(saved));
    const restored = new ChatSessionService(f.deps); cleanup.push(() => restored.dispose());
    expect(restored.has('pane')).toBe(false);
    expect((await restored.start('pane', 'test')).ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).events).toEqual(saved.events);
  });
  it('refuses resume after the trusted workspace changes', async () => {
    const f = fixture(); await f.service.start('pane', 'test'); f.move();
    expect((await f.service.reconnect('pane', 'native-session')).ok).toBe(false);
  });
});
