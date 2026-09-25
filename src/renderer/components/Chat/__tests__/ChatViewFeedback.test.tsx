// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../ChatView';
import { deliverChatDrop } from '../chatAttachments';

const fixture = vi.hoisted(() => ({ events: [] as unknown[], extra: {} as Record<string, unknown>, session: 's1', clearTurn: (() => undefined) as (id: string) => void }));
vi.mock('../../../stores', () => {
  const useStore = (select: (s: unknown) => unknown) => select({ surfaceAgentStatus: {} });
  useStore.getState = () => ({ clearSurfaceTurnOpen: fixture.clearTurn });
  return { useStore };
});
vi.mock('../../../hooks/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) => vars ? `${key}(${Object.values(vars).join(',')})` : key;
  return { useT: () => t };
});
vi.mock('../useTranscript', () => ({ useTranscript: () => ({
  events: fixture.events, status: { available: true, reason: 'ok', agentSessionId: fixture.session, ...fixture.extra },
  loading: false, loadingEarlier: false, hasMore: false, blocked: false, error: false, retry: vi.fn(), loadEarlier: vi.fn(),
}) }));

const claude = (over: Record<string, boolean> = {}) => ({ kind: 'terminal', agent: 'claude', nativeSessionId: 'n',
  capabilities: { history: true, send: true, permissions: false, cancel: true, fileUndo: false, images: true, queue: true, ...over } });
const running = (terminal = claude()) => ({ agentAlive: true, agentStatus: 'running', terminal });
const idle = (terminal = claude()) => ({ agentAlive: true, agentStatus: 'complete', terminal });

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  fixture.events = [{ id: 'u1', kind: 'user_text', text: 'first' }, { id: 'a1', kind: 'assistant_text', text: 'reply', turnComplete: true }];
  fixture.extra = idle(); fixture.clearTurn = vi.fn();
  fixture.session = `s-${Math.random()}`;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = async () => { await act(async () => root.render(<ChatView ptyId="pty-1" active onTerminal={() => undefined} />)); };
const input = () => host.querySelector('textarea')!;
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const key = async (init: KeyboardEventInit) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const preview = (path: string) => ({ ok: true, path, name: path.split('/').pop(), bytes: 10, thumbnail: `data:image/png;base64,${path.length}` });

describe('composer attachments', () => {
  it('shows a dropped image as a chip, removable with × and Backspace, and sends its path', async () => {
    const send = vi.fn(async () => ({ result: 'sent' }));
    const attachment = vi.fn(async ({ path }: { path: string }) => preview(path));
    vi.stubGlobal('electronAPI', { chat: { send, attachment } });
    await render();
    await act(async () => { expect(deliverChatDrop('pty-1', ['/tmp/a.png', '/tmp/b.png'])).toBe(true); });
    expect([...host.querySelectorAll('.wmux-chat-attachment-name')].map((n) => n.textContent)).toEqual(['a.png', 'b.png']);
    expect(host.querySelector<HTMLImageElement>('.wmux-chat-attachment img')!.src).toContain('data:image/png');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="chat.attach.remove(a.png)"]')!.click());
    expect([...host.querySelectorAll('.wmux-chat-attachment-name')].map((n) => n.textContent)).toEqual(['b.png']);
    await act(async () => { deliverChatDrop('pty-1', ['/tmp/c.png']); });
    await key({ key: 'Backspace' });
    expect([...host.querySelectorAll('.wmux-chat-attachment-name')].map((n) => n.textContent)).toEqual(['b.png']);
    await type('What is this?');
    await submit();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'What is this?', attachments: ['/tmp/b.png'] }));
    expect(host.querySelector('.wmux-chat-attachment')).toBeNull();
    // Until the transcript records it, the sent message shows with its picture.
    const bubble = host.querySelector('.wmux-chat-pending')!;
    expect(bubble.textContent).toContain('What is this?');
    expect(bubble.querySelector('.wmux-chat-image img')).not.toBeNull();
  });

  it('says why a drop was refused instead of ignoring it', async () => {
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), attachment: vi.fn(async () => ({ ok: false, reason: 'size' })) } });
    await render();
    await act(async () => { deliverChatDrop('pty-1', ['/tmp/huge.png']); });
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('chat.attach.size(huge.png)');
    expect(host.querySelector('.wmux-chat-attachment')).toBeNull();
  });

  it('refuses images for an agent that cannot take them', async () => {
    fixture.extra = idle({ ...claude({ images: false, queue: false }), agent: 'codex' });
    const attachment = vi.fn();
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), attachment } });
    await render();
    await act(async () => { deliverChatDrop('pty-1', ['/tmp/a.png']); });
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('chat.attach.unsupported');
    expect(attachment).not.toHaveBeenCalled();
  });

  it('shows the image a recorded user message carried', async () => {
    const attachment = vi.fn(async ({ path }: { path: string }) => preview(path));
    const openPath = vi.fn();
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), attachment }, shell: { openPath } });
    // Claude Code 2.1.282 writes the source path as a separate meta entry.
    fixture.events = [{ id: 'u1', kind: 'user_text', text: '[Image #1] What is this?', hasImage: true },
      { id: 'n1', kind: 'meta', subtype: 'caveat', label: 'Image source', images: ['/tmp/red.png'] }];
    await render();
    await act(async () => undefined);
    expect(host.querySelector('.wmux-chat-user-text')!.textContent).toBe('What is this?');
    await act(async () => host.querySelector<HTMLButtonElement>('.wmux-chat-image')!.click());
    expect(openPath).toHaveBeenCalledWith('/tmp/red.png');
    expect(host.querySelector('.wmux-chat-image img')).not.toBeNull();
    expect(host.textContent).not.toContain('Image source');
  });
});

describe('Stop and Esc while a turn runs', () => {
  it('Stopping… then Stopped once the agent records the interrupt', async () => {
    fixture.extra = running();
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    const interrupt = vi.fn(async () => ({ result: 'sent' }));
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), interrupt } });
    await render();
    expect(host.querySelector('.wmux-chat-composer-footer')!.textContent).toContain('chat.hint.runningQueue');
    // A stray newline left after a send still counts as an empty composer.
    await type('\n');
    await key({ key: 'Escape' });
    expect(interrupt).toHaveBeenCalledWith({ ptyId: 'pty-1', agentSessionId: fixture.session });
    expect(host.querySelector('.wmux-chat-stop')!.textContent).toBe('chat.stopping');
    expect(host.textContent).toContain('chat.stopState.stopping');
    fixture.events = [...fixture.events, { id: 'x', kind: 'meta', subtype: 'turn_aborted', label: 'Interrupted' }];
    await render();
    expect(host.textContent).toContain('chat.stopState.stopped');
    expect(fixture.clearTurn).toHaveBeenCalledWith('pty-1');
  });

  it('says the agent kept running when no interrupt is recorded', async () => {
    vi.useFakeTimers();
    fixture.extra = running();
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), interrupt: vi.fn(async () => ({ result: 'sent' })) } });
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('.wmux-chat-stop')!.click());
    await act(async () => { vi.advanceTimersByTime(10_001); });
    expect(host.textContent).toContain('chat.stopState.kept');
  });

  it('leaves Esc alone during IME composition, with text in the composer, and at rest', async () => {
    fixture.extra = running();
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    const interrupt = vi.fn(async () => ({ result: 'sent' }));
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), interrupt } });
    await render();
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await key({ key: 'Escape', isComposing: true });
    await key({ key: 'Escape', keyCode: 229 });
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    await type('draft');
    await key({ key: 'Escape' });
    expect(interrupt).not.toHaveBeenCalled();
    await type('');
    fixture.extra = idle(); fixture.events = [...fixture.events, { id: 'a', kind: 'assistant_text', text: 'done', turnComplete: true }];
    await render();
    await key({ key: 'Escape' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(host.querySelector('.wmux-chat-stop')).toBeNull();
  });

  it('hides Stop and says so when the agent cannot be interrupted from Chat', async () => {
    fixture.extra = running({ ...claude({ cancel: false, queue: false, images: false }), agent: 'opencode' });
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(), interrupt: vi.fn() } });
    await render();
    expect(host.querySelector('.wmux-chat-stop')).toBeNull();
    expect(host.querySelector('.wmux-chat-composer-footer')!.textContent).toContain('chat.hint.runningNoStop');
  });
});

describe('sending while the agent works', () => {
  it('queues a Claude message mid-turn and shows it until the transcript records it', async () => {
    fixture.extra = running();
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    const send = vi.fn(async () => ({ result: 'sent' }));
    vi.stubGlobal('electronAPI', { chat: { send, interrupt: vi.fn() } });
    await render();
    await type('then say BANANA');
    await key({ key: 'Enter' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'then say BANANA' }));
    expect(host.querySelector('.wmux-chat-pending')!.textContent).toContain('chat.queued');
    fixture.events = [...fixture.events, { id: 'a', kind: 'assistant_text', text: 'essay', turnComplete: true }, { id: 'u2', kind: 'user_text', text: 'then say BANANA' }];
    await render();
    expect(host.querySelector('.wmux-chat-pending')).toBeNull();
  });

  it('keeps refusing mid-turn sends for an agent that does not queue', async () => {
    fixture.extra = running({ ...claude({ queue: false, images: false }), agent: 'codex' });
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    const send = vi.fn();
    vi.stubGlobal('electronAPI', { chat: { send, interrupt: vi.fn() } });
    await render();
    await type('more');
    await submit();
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('.wmux-chat-composer-footer')!.textContent).toContain('chat.hint.runningStop');
    await type('');
  });
  it('settles one queued bubble per recorded row and keeps them across a view switch', async () => {
    fixture.extra = running();
    fixture.events = [{ id: 'u1', kind: 'user_text', text: 'long request' }];
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(async () => ({ result: 'sent' })), interrupt: vi.fn() } });
    await render();
    for (let i = 0; i < 2; i++) { await type('again'); await key({ key: 'Enter' }); }
    expect(host.querySelectorAll('.wmux-chat-pending')).toHaveLength(2);
    await act(async () => root.render(null)); await render();
    expect(host.querySelectorAll('.wmux-chat-pending')).toHaveLength(2);
    fixture.events = [...fixture.events, { id: 'u2', kind: 'user_text', text: 'again' }];
    await render();
    expect(host.querySelectorAll('.wmux-chat-pending')).toHaveLength(1);
    fixture.events = [...fixture.events, { id: 'u3', kind: 'user_text', text: 'again' }];
    await render();
    expect(host.querySelectorAll('.wmux-chat-pending')).toHaveLength(0);
  });
});
