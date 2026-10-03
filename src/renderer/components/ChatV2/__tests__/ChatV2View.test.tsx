// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATV2_ANSWER_ARM_MS } from '../../../../shared/chatv2/limits';
import type { Block } from '../../../../shared/chatv2/session';
import { setChatV2BridgeForTests } from '../bridge';
import { ApprovalCard, QuestionCard } from '../Cards';
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
  it('keeps Allow and Deny disabled for 1.5 s after the card is first shown, whatever the daemon stamp says', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const onAnswer = vi.fn(async () => true);
    // Stamped long before "now" by a daemon whose clock runs behind: still armed from local receipt.
    const block: Block = { id: '3.1', role: 'tool', text: 'Write', tool: { callId: 't', title: 'Write' }, approval: { requestId: 'r-arm-1', requestedAt: 10_000 } };
    await act(async () => root.render(<ApprovalCard block={block} onAnswer={onAnswer} />));
    const buttons = () => [...host.querySelectorAll('button')];
    expect(buttons().map((b) => b.disabled)).toEqual([true, true]);
    act(() => buttons()[0].click());
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS - 1); });
    expect(buttons()[0].disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(buttons().map((b) => b.disabled)).toEqual([false, false]);
    await act(async () => { buttons()[0].click(); });
    expect(onAnswer).toHaveBeenCalledWith('r-arm-1', 'allow');
    // Accepted: shown as decided until the resolved push arrives, so it cannot be answered twice.
    expect(host.querySelector('[data-decision="allow"]')).not.toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('stays armed when a card it already showed mounts again, and unlocks after a refused answer', async () => {
    vi.useFakeTimers({ now: 200_000 });
    const block: Block = { id: '4.1', role: 'tool', text: 'Bash', approval: { requestId: 'r-arm-2', requestedAt: 200_000 } };
    const onAnswer = vi.fn(async () => false);
    await act(async () => root.render(<ApprovalCard block={block} onAnswer={onAnswer} />));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    await act(async () => root.render(<div />));
    await act(async () => root.render(<ApprovalCard block={block} onAnswer={onAnswer} />));
    expect([...host.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
    await act(async () => { host.querySelector('button')!.click(); });
    expect([...host.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
  });
});

describe('question card', () => {
  it('arms like an approval and answers with the picked option keys and free text', async () => {
    vi.useFakeTimers({ now: 50_000 });
    const onAnswer = vi.fn(async () => true);
    const prompt = { requestId: 'q-card-1', requestedAt: 50_000, questions: [{ id: 'q0', prompt: 'Which format?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'JSON' }, { id: 'b', label: 'YAML' }] }] };
    await act(async () => root.render(<QuestionCard prompt={prompt} onAnswer={onAnswer} />));
    const submit = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!;
    await act(async () => { (host.querySelector('input[type="radio"]') as HTMLInputElement).click(); });
    expect(submit().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    expect(submit().disabled).toBe(false);
    await act(async () => { submit().click(); });
    expect(onAnswer).toHaveBeenCalledWith('q-card-1', 'allow', [{ keys: ['a'] }]);
  });

  it('makes a single-choice option and the free-text answer exclusive', async () => {
    vi.useFakeTimers({ now: 60_000 });
    const onAnswer = vi.fn(async () => true);
    const prompt = { requestId: 'q-card-2', requestedAt: 60_000, questions: [{ id: 'q0', prompt: 'Which?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'A' }] }] };
    await act(async () => root.render(<QuestionCard prompt={prompt} onAnswer={onAnswer} />));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    const radio = host.querySelector('input[type="radio"]') as HTMLInputElement;
    const other = host.querySelector('input.wmux-chatv2-input-line') as HTMLInputElement;
    await act(async () => { radio.click(); });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(other, 'my own');
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(radio.checked).toBe(false);
    await act(async () => { radio.click(); });
    expect(other.value).toBe('');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!.click(); });
    expect(onAnswer).toHaveBeenCalledWith('q-card-2', 'allow', [{ keys: ['a'] }]);
    // Accepted: the card stays locked until the question resolves.
    expect([...host.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  });
});

describe('ChatV2View', () => {
  let mock: MockHost;
  beforeEach(() => {
    mock = createMockHost();
    setChatV2BridgeForTests(mock);
  });

  it('shows New chat on a free pane and never touches a PTY or creates a chat by itself', async () => {
    mock.nextCwd = '/home/me/verified/repo';
    // The pane's own report is only a cue to ask again; the daemon's answer is shown.
    await act(async () => root.render(<ChatV2View paneId="daemon-free" active cwd="/reported/elsewhere" onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('[data-chatv2="empty"]')?.textContent).toContain('New chat');
    expect(host.querySelector('[data-chatv2-runs-in]')?.textContent).toBe('Runs in …/verified/repo');
    expect(host.querySelector('[data-chatv2-runs-in]')?.getAttribute('title')).toBe('/home/me/verified/repo');
    expect(mock.calls.map((call) => call.method).sort()).toEqual(['bindingForPane', 'subscribe']);
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
    // The chat shows the directory it runs in.
    expect(host.querySelector('[data-chatv2-cwd]')?.getAttribute('title')).toBe('Working directory: /tmp/demo');
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

  it('offers the cut tail of a capped reply on request', async () => {
    await mock.call('subscribe', { paneId: 'daemon-cap' });
    await mock.call('create', { paneId: 'daemon-cap', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-cap" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => {
      mock.emit('daemon-cap', [
        { type: 'user.message', text: 'long', clientMessageId: 'c-00000001' },
        { type: 'message.delta', text: 'x'.repeat(33 * 1024) },
        { type: 'turn.ended', outcome: 'completed' },
      ]);
    });
    const more = host.querySelector('.wmux-chatv2-assistant [data-truncated]') as HTMLButtonElement;
    expect(more?.textContent).toBe('Show full text');
    await act(async () => { more.click(); });
    await flush();
    expect(host.querySelector('.wmux-chatv2-assistant')?.textContent).toContain('The full output is no longer kept.');
  });

  it('shows every page of a long body', async () => {
    await mock.call('subscribe', { paneId: 'daemon-pages' });
    await mock.call('create', { paneId: 'daemon-pages', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-pages" active onTerminal={() => undefined} />));
    await flush();
    const full = 'y'.repeat(33 * 1024) + 'TAIL';
    await act(async () => {
      mock.emit('daemon-pages', [
        { type: 'user.message', text: 'long', clientMessageId: 'c-00000001' },
        { type: 'message.delta', text: full },
        { type: 'turn.ended', outcome: 'completed' },
      ]);
    });
    const blockId = host.querySelector('.wmux-chatv2-assistant')!.getAttribute('data-block-id')!;
    mock.fullBodies.set(`${blockId}:text`, full);
    await act(async () => { (host.querySelector('[data-truncated]') as HTMLButtonElement).click(); });
    await flush();
    expect(host.querySelector('.wmux-chatv2-assistant')?.textContent).toBe(full);
    expect(host.querySelector('[data-truncated]')).toBeNull();
  });

  it('says a read stopped part way and finishes it on Retry', async () => {
    await mock.call('subscribe', { paneId: 'daemon-partial' });
    await mock.call('create', { paneId: 'daemon-partial', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-partial" active onTerminal={() => undefined} />));
    await flush();
    const full = 'q'.repeat(33 * 1024) + 'END';
    await act(async () => {
      mock.emit('daemon-partial', [
        { type: 'user.message', text: 'long', clientMessageId: 'c-00000001' },
        { type: 'message.delta', text: full },
        { type: 'turn.ended', outcome: 'completed' },
      ]);
    });
    const blockId = host.querySelector('.wmux-chatv2-assistant')!.getAttribute('data-block-id')!;
    mock.fullBodies.set(`${blockId}:text`, full);
    mock.failBodiesAt = 2048;
    await act(async () => { (host.querySelector('[data-truncated]') as HTMLButtonElement).click(); });
    await flush();
    const assistant = () => host.querySelector('.wmux-chatv2-assistant')!;
    expect(assistant().textContent).toContain('Only part of the text loaded.');
    expect(assistant().querySelector('[data-truncated]')?.textContent).toBe('Retry');
    await act(async () => { (assistant().querySelector('[data-truncated]') as HTMLButtonElement).click(); });
    await flush();
    expect(assistant().textContent).toBe(full);
  });

  it('says where a chat would run without naming a path the daemon did not give', async () => {
    mock.nextCwd = undefined;
    await act(async () => root.render(<ChatV2View paneId="daemon-nocwd" active cwd="/reported" onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('[data-chatv2-runs-in]')?.textContent).toBe('Runs in the shell\u2019s working directory, or where this pane started.');
  });

  it('shows a handed-off chat read-only', async () => {
    await mock.call('subscribe', { paneId: 'daemon-ho' });
    await mock.call('create', { paneId: 'daemon-ho', agent: 'claude', mode: 'default' });
    await mock.call('toTerminal', { paneId: 'daemon-ho', chatSessionId: mock.record('daemon-ho')!.binding.chatSessionId });
    await act(async () => root.render(<ChatV2View paneId="daemon-ho" active onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('This conversation moved to Terminal.');
    // New chat drops the tombstone and brings the composer back.
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'New chat')!.click(); });
    await flush();
    expect(host.querySelector('[data-chatv2="empty"]')).not.toBeNull();
  });
});
