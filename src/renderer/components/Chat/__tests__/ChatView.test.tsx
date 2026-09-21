// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../ChatView';

const fixture = vi.hoisted(() => ({ session: 'draft-a', available: true }));
vi.mock('../../../stores', () => ({ useStore: (select: (s: unknown) => unknown) => select({ surfaceAgentStatus: {} }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../useTranscript', () => ({ useTranscript: () => ({
  events: [], status: { available: fixture.available, reason: 'ok', agentSessionId: fixture.session },
  loading: false, loadingEarlier: false, hasMore: false, blocked: false, error: false,
  retry: vi.fn(), loadEarlier: vi.fn(),
}) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  fixture.session = 'draft-a'; fixture.available = true;
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
  it('keeps drafts across view switches and isolates them from a replacement conversation', async () => {
    await render(); await type('unfinished request');
    await render(false); await render();
    expect(input().value).toBe('unfinished request');
    fixture.session = 'draft-b'; await render();
    expect(input().value).toBe('');
    await type('different conversation');
    fixture.session = 'draft-a'; await render();
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
});
