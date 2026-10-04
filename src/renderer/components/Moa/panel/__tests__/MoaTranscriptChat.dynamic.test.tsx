// @vitest-environment jsdom
//
// Moa's chat look: the HQ brain's transcript (deck.moa.transcript) read by
// the shared useTranscript and drawn by the shared Chat components, with the
// composer routed to the brain send instead of the pane chat bridge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MoaTranscriptChat, { tidyMoaUserText, type MoaTranscriptApi } from '../MoaTranscriptChat';
import type { TranscriptAppendData, TranscriptPage, TurnEvent } from '../../../../../shared/transcript/turnEvents';

vi.mock('../../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });

let root: Root;
let host: HTMLDivElement;

const cursor = { headOffset: 0, tailOffset: 100, fileSize: 100, mtimeMs: 1 };
const events: TurnEvent[] = [
  { id: 'u1', kind: 'user_text', text: 'Fan out the flaky-test fix', ts: 1 },
  { id: 'a1', kind: 'assistant_text', text: 'Handed it to the api workspace.', ts: 2, turnComplete: true },
];

function fakeApi(over: Partial<MoaTranscriptApi> = {}) {
  let append: ((data: TranscriptAppendData) => void) | null = null;
  const api = {
    status: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 's1' })),
    snapshot: vi.fn(async (): Promise<TranscriptPage | null> => ({ events, cursor, hasMore: false, truncatedHead: false })),
    subscribe: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 's1' })),
    unsubscribe: vi.fn(async () => undefined),
    onAppend: vi.fn((cb: (data: TranscriptAppendData) => void) => { append = cb; return () => { append = null; }; }),
    ...over,
  } as unknown as MoaTranscriptApi;
  return { api, push: (data: TranscriptAppendData) => append?.(data) };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Element.prototype.scrollTo = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const input = () => host.querySelector('textarea')!;
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('MoaTranscriptChat', () => {
  it('renders the HQ transcript as chat bubbles and follows appends', async () => {
    const { api, push } = fakeApi();
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    expect(api.snapshot).toHaveBeenCalled();
    expect(api.subscribe).toHaveBeenCalled();
    expect(host.querySelector('.wmux-chat-user')?.textContent).toContain('Fan out the flaky-test fix');
    expect(host.querySelector('.wmux-chat-assistant')?.textContent).toContain('Handed it to the api workspace.');

    await act(async () => push({ seq: 1, events: [{ id: 'a2', kind: 'assistant_text', text: 'PR #42 is open.', ts: 3 }], cursor: { ...cursor, tailOffset: 150, fileSize: 150 } }));
    expect(host.textContent).toContain('PR #42 is open.');
  });

  it('sends through the brain send and shows the message until the transcript records it', async () => {
    const { api } = fakeApi();
    const onSend = vi.fn(async () => ({ ok: true }));
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={onSend} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    await type('Check the release');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onSend).toHaveBeenCalledWith('Check the release');
    expect(host.querySelector('[data-moa-chat-pending]')?.textContent).toContain('Check the release');
  });

  it('a brain with no conversation yet reads as empty, not as a connection error', async () => {
    const { api } = fakeApi({ snapshot: vi.fn(async () => null) as never });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    expect(host.querySelector('[data-moa-chat-empty]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('mid-turn, a dialog only the TUI shows gets an Answer in terminal action', async () => {
    const onTerminal = vi.fn();
    // Main reports the dialog as agentStatus 'awaiting_input' (MoaTranscript.status).
    const { api } = fakeApi({ status: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 's1', agentStatus: 'awaiting_input' })) as never });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={onTerminal} api={api} />));
    const hint = host.querySelector('[data-moa-chat-terminal-hint]') as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.getAttribute('role')).toBe('status');
    const answer = hint.querySelector('[data-moa-chat-answer-in-terminal]') as HTMLButtonElement;
    expect(answer.textContent).toBe('moa.panel.answerInTerminal');
    await act(async () => { answer.click(); });
    expect(onTerminal).toHaveBeenCalled();
  });

  it('while a turn runs the composer is closed and Stop interrupts', async () => {
    const { api } = fakeApi();
    const onInterrupt = vi.fn();
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy onSend={vi.fn()} onInterrupt={onInterrupt} onTerminal={vi.fn()} api={api} />));
    expect(input().disabled).toBe(true);
    await act(async () => { (host.querySelector('[data-moa-chat-stop]') as HTMLButtonElement).click(); });
    expect(onInterrupt).toHaveBeenCalled();
  });
});

describe('MoaTranscriptChat — main\'s transcript contract', () => {
  it('a started brain whose first turn has not written yet says it is starting', async () => {
    const { api } = fakeApi({
      status: vi.fn(async () => ({ available: false, reason: 'no-transcript-path' })) as never,
      snapshot: vi.fn(async () => null) as never,
    });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    expect(host.querySelector('[data-moa-chat-starting]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('no brain yet (after a restart) is an empty conversation, not an error', async () => {
    const { api } = fakeApi({
      status: vi.fn(async () => ({ available: false, reason: 'no-brain' })) as never,
      snapshot: vi.fn(async () => null) as never,
    });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    expect(host.querySelector('[data-moa-chat-empty]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('the tail subscribe() pushes with reset is shown once, not twice', async () => {
    let append: ((data: TranscriptAppendData) => void) | null = null;
    const { api } = fakeApi({
      onAppend: vi.fn((cb: (data: TranscriptAppendData) => void) => { append = cb; return () => undefined; }) as never,
      subscribe: vi.fn(async () => {
        // Main answers subscribe and pushes the current tail at once.
        queueMicrotask(() => append?.({ seq: 1, reset: true, events, cursor }));
        return { available: true, reason: 'ok', agentSessionId: 's1' };
      }) as never,
    });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelectorAll('.wmux-chat-user')).toHaveLength(1);
    expect(host.querySelectorAll('.wmux-chat-assistant')).toHaveLength(1);
  });
});

describe('MoaTranscriptChat — commands', () => {
  it('/clear is sent but leaves no pending bubble (it opens no turn)', async () => {
    const { api } = fakeApi();
    const onSend = vi.fn(async () => ({ ok: true }));
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={onSend} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    await type('/clear');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onSend).toHaveBeenCalledWith('/clear');
    expect(host.querySelector('[data-moa-chat-pending]')).toBeNull();
  });
});

describe('MoaTranscriptChat — drafts', () => {
  it('a draft survives the swap to the terminal (or closing the panel) and back', async () => {
    const { api } = fakeApi();
    const chat = () => <MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />;
    await act(async () => root.render(chat()));
    await type('Half-written question');
    await act(async () => root.render(<div />)); // the terminal view replaces the chat
    expect(host.querySelector('textarea')).toBeNull();
    await act(async () => root.render(chat()));
    expect(input().value).toBe('Half-written question');
  });
});

describe('MoaTranscriptChat — code blocks', () => {
  it('fetches a code-block body from main, never from the daemon pane bridge', async () => {
    const marker = String.fromCharCode(0);
    const withCode: TurnEvent[] = [
      { id: 'a9', kind: 'assistant_text', text: `Here:${marker}code:1${marker}`, ts: 5, turnComplete: true,
        codeBlocks: [{ n: 1, lang: 'ts', lines: 2, srcOffset: 40, truncated: true }] },
    ];
    const codeBlock = vi.fn(async () => ({ body: 'const ok = true;' }));
    const daemon = vi.fn(async () => null);
    vi.stubGlobal('electronAPI', { chat: { codeBlock: daemon } });
    const { api } = fakeApi({
      snapshot: vi.fn(async () => ({ events: withCode, cursor, hasMore: false, truncatedHead: false })),
      codeBlock,
    } as never);
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    const details = host.querySelector('details.wmux-chat-detail') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(codeBlock).toHaveBeenCalledWith({ srcOffset: 40, n: 1, eventId: 'a9' });
    expect(daemon).not.toHaveBeenCalled();
    expect(host.textContent).toContain('const ok = true;');
  });

  it("subscribes as the panel, so the titlebar's reply dot keeps its own subscription", async () => {
    const { api } = fakeApi();
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    expect(api.subscribe).toHaveBeenCalledWith('panel');
    act(() => root.render(<div />));
    await act(async () => { await Promise.resolve(); });
    expect(api.unsubscribe).toHaveBeenCalledWith('panel');
  });
});

describe('tidyMoaUserText', () => {
  it('shows one short line instead of any pasted wire, as Claude records it', () => {
    const out = tidyMoaUserText([
      // The real shape: an id on both tags, and the TUI's split leaves the
      // wire's tail after the closing tag.
      { id: '1', kind: 'user_text', text: '\n\n<pasted_content id="4dff">\n[autonomy] mode: assist…\n</pasted_content id="4dff">\n\n fork, use deck_ask_decision. What next?' },
      { id: '2', kind: 'user_text', text: '<pasted_content id="b">You are the wmux Orchestrator… (cut)' },
      { id: '3', kind: 'user_text', text: 'plain' },
      { id: '4', kind: 'assistant_text', text: '<pasted_content id="c">quoted</pasted_content>' },
    ], 'Instructions sent to Moa');
    expect(out.map((e) => e.text)).toEqual(['Instructions sent to Moa', 'Instructions sent to Moa', 'plain', '<pasted_content id="c">quoted</pasted_content>']);
  });
});
