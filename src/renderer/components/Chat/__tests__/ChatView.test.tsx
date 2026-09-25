// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../ChatView';

const fixture = vi.hoisted(() => ({ reason: 'ok', session: 'draft-a', available: true, events: [] as unknown[], hasMore: false, loadEarlier: (() => undefined) as () => void, terminal: undefined as unknown, extra: {} as Record<string, unknown> }));
vi.mock('../../../stores', () => ({ useStore: (select: (s: unknown) => unknown) => select({ surfaceAgentStatus: {} }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../useTranscript', () => ({ useTranscript: () => ({
  events: fixture.events, status: { available: fixture.available, reason: fixture.reason, agentSessionId: fixture.session, ...(fixture.terminal ? { terminal: fixture.terminal } : {}), ...fixture.extra },
  loading: false, loadingEarlier: false, hasMore: fixture.hasMore, blocked: false, error: false,
  retry: vi.fn(), loadEarlier: fixture.loadEarlier,
}) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  fixture.reason = 'ok'; fixture.session = 'draft-a'; fixture.available = true; fixture.events = []; fixture.hasMore = false; fixture.loadEarlier = vi.fn(); fixture.terminal = undefined; fixture.extra = {};
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
  it('keeps Korean composition synchronous and preserves the committed draft', async () => {
    fixture.session = 'korean-ime';
    const send = vi.fn();
    vi.stubGlobal('electronAPI', { chat: { send } });
    await render();
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    for (const text of ['ㅎ', '하', '한']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
        input().dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertCompositionText', isComposing: true }));
        // React restores controlled inputs before returning from the event.
        expect(input().value).toBe(text);
      });
    }
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })));
    expect(send).not.toHaveBeenCalled();
    await act(async () => input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' })));
    expect(input().value).toBe('한');
    await render(false); await render();
    expect(input().value).toBe('한');
    await type('');
  });

  it('filters skills and inserts with the keyboard without sending or losing arguments', async () => {
    const send = vi.fn();
    const skills = vi.fn(async () => ({ state: 'ready', skills: [
      {name:'qa',invocation:'/qa',description:'Check quality',source:'project'},
      {name:'review',invocation:'/review',description:'Review changes',source:'user'},
    ] }));
    vi.stubGlobal('electronAPI', { chat: { skills, send } });
    fixture.session = 'skills-test';
    await render(); await type('/rev keep these arguments');
    await act(async () => { input().focus(); input().setSelectionRange(4,4); document.dispatchEvent(new Event('selectionchange',{bubbles:true})); });
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="chat.send"]')!.disabled).toBe(true);
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
    expect(input().value).toBe('/review keep these arguments');
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await type('/');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    expect(input().value).toBe('/');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await type('');
  });
  it('inserts Codex skills as dollar references and resets the catalogue on provider change', async () => {
    const skills = vi.fn(async ({agent}) => ({state:'ready', skills:[{name:agent,invocation:agent==='codex'?'$codex':'/claude',description:'',source:'user'}]}));
    const launchTerminal = vi.fn();
    vi.stubGlobal('electronAPI',{chat:{skills,launchTerminal}});
    fixture.session=''; fixture.available=false; fixture.reason='no-hook';
    await render(); await type('/');
    expect(host.textContent).toContain('/claude');
    await act(async () => { const select=host.querySelector<HTMLSelectElement>('select[aria-label="chat.provider"]')!; select.value='codex'; select.dispatchEvent(new Event('change',{bubbles:true})); });
    expect(host.textContent).not.toContain('/claude');
    await type('/codex');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
    expect(input().value).toBe('$codex ');
    expect(launchTerminal).not.toHaveBeenCalled();
    await type('');
  });
  it('does not send an unresolved slash query or treat IME Enter as selection', async () => {
    const send=vi.fn();
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('electronAPI',{chat:{send,skills:vi.fn(()=>new Promise(done=>{resolve=done;}))}});
    fixture.session='skills-pending'; await render(); await type('/qa');
    await act(async()=>input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
    expect(input().value).toBe('/qa'); expect(send).not.toHaveBeenCalled();
    await act(async()=>resolve({state:'ready',skills:[{name:'qa',invocation:'/qa',source:'user',description:''}]}));
    await act(async()=>input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
    expect(input().value).toBe('/qa'); expect(send).not.toHaveBeenCalled();
    await type('');
  });
  it('keeps native command navigation available when skill discovery fails', async () => {
    vi.stubGlobal('electronAPI',{chat:{skills:vi.fn(async()=>{throw new Error("No handler registered for chat:skills");}),launchTerminal:vi.fn()}});
    fixture.session='';fixture.available=false;fixture.reason='no-hook';
    await render();
    await act(async()=>{const select=host.querySelector<HTMLSelectElement>('select[aria-label="chat.provider"]')!;select.value='codex';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await type('/');
    expect(host.textContent).toContain('/model');expect(host.textContent).toContain('/permissions');
    expect(host.textContent).toContain('chat.inTerminal');expect(host.textContent).toContain('chat.bridgeOutdated');
    await type('');
  });
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
  describe('send effect from the daemon', () => {
    const terminal = { agent: 'claude', capabilities: { history: true, send: true, permissions: false, cancel: false, fileUndo: false } };
    const submit = async (response: unknown, session: string) => {
      const send = vi.fn<(args: unknown) => Promise<unknown>>(async () => response);
      vi.stubGlobal('electronAPI', { chat: { send } });
      fixture.session = session; fixture.terminal = terminal;
      await render(); await type('held back');
      await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      return send;
    };
    const sendButton = () => host.querySelector<HTMLButtonElement>('[aria-label="chat.send"]')!;
    it('mints a time-prefixed request id for a terminal binding', async () => {
      const send = await submit({ result: 'busy', effect: 'none' }, 'id-format');
      expect(send.mock.calls[0][0]).toMatchObject({ requestId: expect.stringMatching(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) });
      await type('');
    });
    it('returns a proven no-write refusal to the draft without locking the composer', async () => {
      await submit({ result: 'unconfirmed', effect: 'none' }, 'effect-none');
      expect(input().value).toBe('held back');
      expect(host.textContent).toContain('chat.send.refused');
      expect(host.textContent).not.toContain('chat.send.unconfirmed');
      expect(sendButton().disabled).toBe(false);
      await type('');
    });
    it('locks on an uncertain effect whatever the result says', async () => {
      await submit({ result: 'error', effect: 'uncertain' }, 'effect-uncertain');
      expect(host.textContent).toContain('chat.send.error');
      expect(sendButton().disabled).toBe(true);
      await type('');
    });
    it('keeps the enum reading when an older daemon reports no effect', async () => {
      await submit({ result: 'unconfirmed' }, 'effect-absent');
      expect(host.textContent).toContain('chat.send.unconfirmed');
      expect(sendButton().disabled).toBe(true);
      await type('');
    });
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
  it('shows a running turn as one working row, never an empty reply block', async () => {
    fixture.session = 'running-turn';
    fixture.extra = { agentAlive: true, agentStatus: 'running' };
    fixture.events = [{ id: 'u', kind: 'user_text', text: 'long request' }];
    await render();
    expect(host.querySelectorAll('.wmux-chat-working')).toHaveLength(1);
    expect(host.querySelector('.wmux-chat-assistant')).toBeNull();
    expect(host.querySelector('.wmux-chat-user-text')!.textContent).toBe('long request');
  });
});
