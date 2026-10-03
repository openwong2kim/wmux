// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATV2_ANSWER_ARM_MS } from '../../../../shared/chatv2/limits';
import type { Block } from '../../../../shared/chatv2/session';
import { setChatV2BridgeForTests } from '../bridge';
import { ApprovalCard } from '../Cards';
import ChatV2View from '../ChatV2View';
import { createMockHost, type MockHost } from './mockHost';

const store = vi.hoisted(() => ({ state: { surfaceAgent: {} as Record<string, { name: string }>, agentAliveByPtyId: {}, commandRunningByPtyId: {} } }));
vi.mock('../../../stores', () => ({ useStore: Object.assign((select: (s: unknown) => unknown) => select(store.state), { getState: () => ({ setSurfaceViewMode: vi.fn() }) }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });

let root: Root;
let host: HTMLDivElement;
let ptyCalls: string[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ptyCalls = [];
  // Any PTY call made while choosing or showing the chat view is recorded.
  const pty = new Proxy({}, { get: (_t, key) => (...args: unknown[]) => { ptyCalls.push(String(key)); return Promise.resolve(args); } });
  vi.stubGlobal('electronAPI', { pty });
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setChatV2BridgeForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

describe('approval arm', () => {
  it('keeps Allow and Deny disabled until requestedAt + 1.5 s', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const onAnswer = vi.fn(async () => true);
    const block: Block = { id: '3.1', role: 'tool', text: 'Write', tool: { callId: 't', title: 'Write' }, approval: { requestId: 'r1', requestedAt: 99_500 } };
    await act(async () => root.render(<ApprovalCard block={block} onAnswer={onAnswer} />));
    const buttons = () => [...host.querySelectorAll('button')];
    expect(buttons().map((b) => b.disabled)).toEqual([true, true]);
    act(() => buttons()[0].click());
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS - 500 - 1); });
    expect(buttons()[0].disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(buttons().map((b) => b.disabled)).toEqual([false, false]);
    await act(async () => { buttons()[0].click(); });
    expect(onAnswer).toHaveBeenCalledWith('r1', 'allow');
  });

  it('is armed at once for a request older than the arm window', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const block: Block = { id: '3.1', role: 'tool', text: 'Bash', approval: { requestId: 'r2', requestedAt: 10_000 } };
    await act(async () => root.render(<ApprovalCard block={block} onAnswer={async () => true} />));
    expect([...host.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
  });
});

describe('ChatV2View', () => {
  let mock: MockHost;
  beforeEach(() => {
    mock = createMockHost();
    setChatV2BridgeForTests(mock);
  });

  it('shows New chat on a free pane and never touches a PTY or creates a chat by itself', async () => {
    await act(async () => root.render(<ChatV2View paneId="daemon-free" active onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('[data-chatv2="empty"]')?.textContent).toContain('New chat');
    expect(mock.calls.map((call) => call.method)).toEqual(['subscribe']);
    expect(ptyCalls).toEqual([]);
  });

  it('renders a streaming turn, an approval card and the finished footer from pushes', async () => {
    await mock.call('subscribe', { paneId: 'daemon-live' });
    await mock.call('create', { paneId: 'daemon-live', agent: 'claude', mode: 'default', model: 'claude-opus-5-5' });
    await act(async () => root.render(<ChatV2View paneId="daemon-live" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => {
      mock.emit('daemon-live', [
        { type: 'user.message', text: 'make a file', clientMessageId: 'c-00000001' },
        { type: 'message.delta', text: 'Working on **it**' },
        { type: 'tool.started', callId: 't1', title: 'Write', kind: 'edit', status: 'pending' },
        { type: 'approval.requested', requestId: 'r1', title: 'Write', callId: 't1' },
      ]);
    });
    expect(host.querySelector('.wmux-chatv2-assistant')?.textContent).toContain('Working on');
    expect(host.querySelector('[data-chatv2-approval="r1"]')).not.toBeNull();
    expect(host.querySelector('[data-chatv2="ready"]')?.getAttribute('data-status')).toBe('needs-input');
    await act(async () => {
      mock.emit('daemon-live', [
        { type: 'approval.resolved', requestId: 'r1', decision: 'allow' },
        { type: 'tool.updated', callId: 't1', status: 'completed' },
        { type: 'turn.ended', outcome: 'completed' },
      ]);
    });
    expect(host.querySelector('.wmux-chatv2-footer')?.textContent).toMatch(/^Opus 5\.5 worked for \d+s/);
    expect(host.textContent).toContain('Continue in Terminal');
    expect(ptyCalls).toEqual([]);
  });

  it('keeps an unterminated code fence as code while it streams', async () => {
    await mock.call('subscribe', { paneId: 'daemon-fence' });
    await mock.call('create', { paneId: 'daemon-fence', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-fence" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => {
      mock.emit('daemon-fence', [
        { type: 'user.message', text: 'code', clientMessageId: 'c-00000001' },
        { type: 'message.delta', text: 'Here:\n```ts\nconst a = 1;\n' },
      ]);
    });
    const code = () => host.querySelector('[data-streaming] [data-brain-md-code]');
    expect(code()?.textContent).toBe('const a = 1;\n');
    await act(async () => { mock.emit('daemon-fence', [{ type: 'message.delta', text: 'const b = 2;\n```\nDone.' }]); });
    expect(host.querySelector('[data-brain-md-code]')?.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  it('shows a handed-off chat read-only', async () => {
    await mock.call('subscribe', { paneId: 'daemon-ho' });
    await mock.call('create', { paneId: 'daemon-ho', agent: 'claude', mode: 'default' });
    await mock.call('toTerminal', { paneId: 'daemon-ho', chatSessionId: mock.record('daemon-ho')!.binding.chatSessionId });
    await act(async () => root.render(<ChatV2View paneId="daemon-ho" active onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('This conversation moved to Terminal.');
  });
});
