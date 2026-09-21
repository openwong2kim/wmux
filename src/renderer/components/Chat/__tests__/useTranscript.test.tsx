// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBridgeApi, TranscriptAppendData, TranscriptPage, TurnEvent } from '../../../../shared/transcript/turnEvents';
import { useTranscript } from '../useTranscript';

const event = (id: string): TurnEvent => ({ id, kind: 'user_text', text: id });
const page = (ids: string[], head = 0, tail = 100): TranscriptPage => ({
  events: ids.map(event), cursor: { headOffset: head, tailOffset: tail, fileSize: tail, mtimeMs: tail }, hasMore: head > 0, truncatedHead: false,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let latest: ReturnType<typeof useTranscript>;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; container?.remove(); vi.useRealTimers(); });
function fixture() {
  let disconnected!: () => void;
  let connected!: () => void;
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { daemon: {
    onDisconnected: (cb: () => void) => { disconnected = cb; return vi.fn(); },
    onConnected: (cb: () => void) => { connected = cb; return vi.fn(); },
  } } });
  let append!: (id: string, delta: TranscriptAppendData) => void;
  let gate!: Parameters<ChatBridgeApi['onGate']>[0];
  const api: ChatBridgeApi = { status: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 'conv-1' })),
    snapshot: vi.fn(async () => page(['a'])), subscribe: vi.fn(async () => ({ ok: true, status: { available: true, reason: 'ok' } })),
    unsubscribe: vi.fn(async () => ({ ok: true })), codeBlock: vi.fn(async () => null), send: vi.fn(async () => ({ result: 'sent' as const })),
    openGates: vi.fn(async () => []), onAppend: (cb) => { append = cb; return vi.fn(); }, onGate: (cb) => { gate = cb; return vi.fn(); } };
  function Harness({ id = 'pty-1', active = true }: { id?: string; active?: boolean }) { latest = useTranscript(id, active, api); return null; }
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const render = async (id = 'pty-1', active = true) => { await act(async () => { root!.render(<Harness id={id} active={active} />); }); };
  return { api, render, disconnect: () => disconnected(), reconnect: () => connected(), append: (delta: TranscriptAppendData, id = 'pty-1') => append(id, delta), gate: (kind: 'open' | 'closed') => gate('pty-1', { kind }) };
}
describe('visible chat transcript lifecycle', () => {
  it('rejects an in-flight snapshot after disconnect and repairs history on reconnect', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.render();
    const pending = deferred<TranscriptPage>();
    vi.mocked(f.api.snapshot).mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => f.disconnect());
    await act(async () => pending.resolve(page(['stale'])));
    expect(latest.error).toBe(true);
    expect(latest.events.map((e) => e.id)).toEqual(['a']);
    vi.mocked(f.api.snapshot).mockResolvedValueOnce(page(['a', 'b']));
    await act(async () => f.reconnect());
    expect(latest.error).toBe(false);
    expect(latest.events.map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('does not retain another conversation when its replacement is unreadable', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.render();
    vi.mocked(f.api.status).mockResolvedValue({ available: false, reason: 'unreadable', agentSessionId: 'conv-2' });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(latest.events).toEqual([]);
    expect(latest.status.agentSessionId).toBe('conv-2');
  });
  it('retains visible history when polling loses its connection', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.render();
    vi.mocked(f.api.status).mockResolvedValue({ available: false, reason: 'unavailable' });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(latest.events.map((e) => e.id)).toEqual(['a']);
    expect(latest.status.agentSessionId).toBe('conv-1');
    expect(latest.error).toBe(true);
    expect(latest.blocked).toBe(true);
  });
  it('merges appends arriving during initial snapshot, filters other panes and releases subscriptions', async () => {
    const f = fixture(); const pending = deferred<TranscriptPage>();
    vi.mocked(f.api.snapshot).mockReturnValueOnce(pending.promise);
    await f.render();
    act(() => f.append({ seq: 1, events: [event('a'), event('b')], cursor: page([], 0, 200).cursor }));
    await act(async () => pending.resolve(page(['a'])));
    expect(latest.events.map((e) => e.id)).toEqual(['a', 'b']);
    act(() => f.append({ seq: 2, events: [event('foreign')], cursor: page([], 0, 300).cursor }, 'other-pty'));
    expect(latest.events).toHaveLength(2);
    await f.render('pty-1', false);
    expect(f.api.unsubscribe).toHaveBeenCalledWith('pty-1');
  });
  it('discards old history on reset and ignores a late earlier-page response', async () => {
    const f = fixture(); vi.mocked(f.api.snapshot).mockResolvedValueOnce(page(['a'], 50));
    await f.render();
    const older = deferred<TranscriptPage>(); vi.mocked(f.api.snapshot).mockReturnValueOnce(older.promise);
    let loading!: Promise<void>; act(() => { loading = latest.loadEarlier(); });
    vi.mocked(f.api.snapshot).mockResolvedValueOnce(page(['new'], 0, 100));
    await act(async () => f.append({ seq: 1, reset: true, events: [], cursor: page([], 0, 1).cursor }));
    await act(async () => { older.resolve(page(['old'], 0, 50)); await loading; });
    expect(latest.events.map((e) => e.id)).toEqual(['new']);
  });
  it('keeps sending blocked until approval state is known and observes gate transitions', async () => {
    const f = fixture(); vi.mocked(f.api.openGates).mockResolvedValueOnce(null);
    await f.render(); expect(latest.blocked).toBe(true);
    act(() => f.gate('closed')); expect(latest.blocked).toBe(false);
    act(() => f.gate('open')); expect(latest.blocked).toBe(true);
  });
  it('resnapshots after a sequence gap instead of presenting incomplete history', async () => {
    const f = fixture(); await f.render();
    act(() => f.append({ seq: 1, events: [event('b')], cursor: page([], 0, 200).cursor }));
    vi.mocked(f.api.snapshot).mockResolvedValueOnce(page(['a', 'b', 'c', 'd'], 0, 400));
    await act(async () => f.append({ seq: 3, events: [event('d')], cursor: page([], 0, 400).cursor }));
    expect(latest.events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('does not reopen input when a stale gate seed resolves after an approval event', async () => {
    const f = fixture(); const seed = deferred<string[] | null>();
    vi.mocked(f.api.openGates).mockReturnValueOnce(seed.promise);
    await f.render();
    act(() => f.gate('open'));
    await act(async () => seed.resolve([]));
    expect(latest.blocked).toBe(true);
  });
  it('does not paint a previous PTY snapshot after the session switches', async () => {
    const f = fixture(); const pending = deferred<TranscriptPage>(); vi.mocked(f.api.snapshot).mockReturnValueOnce(pending.promise);
    await f.render(); vi.mocked(f.api.snapshot).mockResolvedValueOnce(page(['second'])); await f.render('pty-2');
    await act(async () => pending.resolve(page(['first'])));
    expect(latest.events.map((e) => e.id)).toEqual(['second']);
  });
});
