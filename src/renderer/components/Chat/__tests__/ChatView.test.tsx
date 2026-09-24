// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../ChatView';

const fixture = vi.hoisted(() => ({ reason: 'ok', session: 'draft-a', available: true, events: [] as unknown[], hasMore: false, loadEarlier: (() => undefined) as () => void }));
vi.mock('../../../stores', () => ({ useStore: (select: (s: unknown) => unknown) => select({ surfaceAgentStatus: {} }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../useTranscript', () => ({ useTranscript: () => ({
  events: fixture.events, status: { available: fixture.available, reason: fixture.reason, agentSessionId: fixture.session },
  loading: false, loadingEarlier: false, hasMore: fixture.hasMore, blocked: false, error: false,
  retry: vi.fn(), loadEarlier: fixture.loadEarlier,
}) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  fixture.reason = 'ok'; fixture.session = 'draft-a'; fixture.available = true; fixture.events = []; fixture.hasMore = false; fixture.loadEarlier = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (show = true) => { await act(async () => root.render(show ? <ChatView ptyId="draft-test-pty" active onTerminal={() => undefined} /> : null)); };
const input = () => host.querySelector('textarea')!;
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('assistant-ui composer connected to session drafts', () => {
  it('starts from the sole bottom composer with the selected provider and explicit mode', async () => {
    const launchTerminal = vi.fn(async () => ({ ok: true }));
    const send = vi.fn();
    vi.stubGlobal('electronAPI', { chat: { launchTerminal, send } });
    fixture.session = ''; fixture.available = false; fixture.reason = 'no-hook';
    await render();
    expect(host.querySelectorAll('textarea')).toHaveLength(1);
    expect(host.querySelector('.wmux-chat-controls input')).toBeNull();
    expect(input().closest('.wmux-chat-footer')).not.toBeNull();
    expect(input().disabled).toBe(false);
    const change = async (label: string, value: string) => act(async () => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await change('chat.launchMode', 'bypass');
    await change('chat.provider', 'codex');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="chat.launchMode"]')!.value).toBe('default');
    await change('chat.launchMode', 'yolo');
    await type('first message\nsecond line');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(launchTerminal).toHaveBeenCalledWith({ ptyId: 'draft-test-pty', agent: 'codex', mode: 'yolo', prompt: 'first message\nsecond line' });
    expect(send).not.toHaveBeenCalled();
    expect(input().disabled).toBe(true);
  });
  it('preserves a refused first message in the same composer', async () => {
    vi.stubGlobal('electronAPI', { chat: { launchTerminal: vi.fn(async () => ({ ok: false, error: 'Terminal is busy' })) } });
    fixture.session = ''; fixture.available = false; fixture.reason = 'no-hook';
    await render(); await type('keep first message');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(input().value).toBe('keep first message');
    expect(host.textContent).toContain('Terminal is busy');
    await type('');
  });
  it('keeps drafts across view switches and isolates them from a replacement conversation', async () => {
    await render(); await type('unfinished request');
    await render(false); await render();
    expect(input().value).toBe('unfinished request');
    fixture.session = 'draft-b'; await render();
    expect(input().value).toBe('');
    await type('different conversation');
    fixture.reason = 'ok'; fixture.session = 'draft-a'; await render();
    expect(input().value).toBe('unfinished request');
    await type('');
  });
  it('disables composition until a conversation is available', async () => {
    fixture.available = false; await render();
    expect(input().disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="chat.send"]')!.disabled).toBe(true);
    fixture.available = true; await render();
    expect(input().disabled).toBe(false);
  });
  it('restores the draft when the live daemon refuses delivery', async () => {
    const send = vi.fn(async () => ({ result: 'busy' }));
    vi.stubGlobal('electronAPI', { chat: { send } });
    fixture.session = 'refused-send';
    await render(); await type('keep this request');
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(send).toHaveBeenCalledWith({ ptyId: 'draft-test-pty', agentSessionId: 'refused-send', text: 'keep this request' });
    expect(input().value).toBe('keep this request');
    expect(host.textContent).toContain('chat.send.busy');
    await render(false); await render();
    expect(input().value).toBe('keep this request');
  });
  it('says a refusal once and offers Terminal next to it', async () => {
    vi.stubGlobal('electronAPI', { chat: { send: vi.fn(async () => ({ result: 'unconfirmed' })) } });
    fixture.session = 'refused-once';
    await render(); await type('held back');
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const notices = [...host.querySelectorAll('.wmux-chat-notice')].filter((n) => n.textContent!.includes('chat.send.unconfirmed'));
    expect(notices).toHaveLength(1);
    expect(notices[0].querySelector('button')!.textContent).toBe('chat.openTerminal');
    await type('');
  });
  it('pages back on its own when the tail page holds a reply without its request', async () => {
    fixture.session = 'reply-only'; fixture.hasMore = true;
    fixture.events = [{ id: 'a', kind: 'assistant_text', text: 'done', turnComplete: true }];
    await render();
    expect(fixture.loadEarlier).toHaveBeenCalledTimes(1);
  });
  it('leaves paging to the reader once a request is on screen', async () => {
    fixture.session = 'has-request'; fixture.hasMore = true;
    fixture.events = [{ id: 'u', kind: 'user_text', text: 'hi' }, { id: 'a', kind: 'assistant_text', text: 'done', turnComplete: true }];
    await render();
    expect(fixture.loadEarlier).not.toHaveBeenCalled();
  });
});
