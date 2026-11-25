// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATV2_ANSWER_ARM_MS } from '../../../../shared/chatv2/limits';
import type { Block } from '../../../../shared/chatv2/session';
import { setChatV2BridgeForTests } from '../bridge';
import { ApprovalCard, PinnedApproval, QuestionCard, readableError } from '../Cards';
import { deliverChatDrop } from '../../Chat/chatAttachments';
import { chatV2Error } from '../../../../shared/chatv2/ipc';
import { enqueueMessage, setStaged } from '../Composer';
import ChatV2View from '../ChatV2View';
import { SHELL_TAIL_LINES, shellView, TranscriptRowView, type TranscriptActions } from '../Transcript';
import type { TranscriptRow } from '../rows';
import { createMockHost, type MockHost } from './mockHost';

const store = vi.hoisted(() => ({ state: { surfaceAgent: {} as Record<string, { name: string }>, agentAliveByPtyId: {}, commandRunningByPtyId: {} } }));
vi.mock('../../../stores', () => ({ useStore: Object.assign((select: (s: unknown) => unknown) => select(store.state), { getState: () => ({ setSurfaceViewMode: vi.fn() }) }) }));
vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
const focusPaneByPtyId = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../hooks/useNotificationListener', () => ({ focusPaneByPtyId }));

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

describe('tool rows', () => {
  const actions: TranscriptActions = { answer: async () => true, body: async () => ({ text: 'line 1\nline 2\nline 3\n', nextOffset: 21 }) };
  const renderRow = (block: Block, state: 'running' | 'done' | 'failed' = 'done') =>
    act(async () => root.render(<TranscriptRowView row={{ kind: 'tool', key: block.id, block, state }} cwd="/repo" actions={actions} findActive={false} />));

  it('says a call held for approval waits, not runs, and marks state with icons, not text glyphs', async () => {
    const block: Block = { id: '5.1', role: 'tool', text: 'rm -rf dist', tool: { callId: 't', title: 'rm -rf dist', kind: 'execute' }, approval: { requestId: 'r-wait', requestedAt: 0 } };
    await renderRow(block, 'running');
    expect(host.querySelector('.wmux-chatv2-tool-verb')?.textContent).toBe('Waiting for approval');
    expect(host.querySelector('.wmux-chatv2-tool-object')?.textContent).toBe('rm -rf dist');
    // The card that answers it is pinned over the composer, not drawn under the row.
    expect(host.querySelector('[data-chatv2-approval]')).toBeNull();
    // The needs-you ring, not the running dot.
    expect(host.querySelector('.wmux-chatv2-glyph')?.getAttribute('data-state')).toBe('waiting');
    expect(host.querySelector('.wmux-chatv2-glyph [data-mark="ring"]')).not.toBeNull();
    await renderRow({ ...block, approval: undefined }, 'done');
    expect(host.querySelector('.wmux-chatv2-tool-verb')?.textContent).toBe('Ran');
    const glyph = host.querySelector('.wmux-chatv2-glyph');
    expect(glyph?.textContent).toBe('');
    expect(glyph?.querySelector('svg')).not.toBeNull();
  });

  it('shows an edit\u2019s diff without repeating its result text under it', async () => {
    const preview = { kind: 'write' as const, path: '/repo/a.ts', lines: [{ kind: 'add' as const, text: 'x' }] };
    await renderRow({ id: '6.1', role: 'tool', text: 'Edit', tool: { callId: 't', title: 'Edit a.ts', kind: 'edit', status: 'completed', detail: 'The file /repo/a.ts has been updated.', preview } });
    expect(host.querySelector('[data-diff]')).not.toBeNull();
    expect(host.textContent).not.toContain('has been updated');
    await renderRow({ id: '6.2', role: 'tool', text: 'Read', tool: { callId: 't', title: 'Read a.ts', kind: 'read', status: 'failed', detail: 'File does not exist.' } });
    expect(host.querySelector('[data-detail]')?.textContent).toBe('File does not exist.');
    // A failed edit keeps its error, and the way to the rest of it, under the diff.
    await renderRow({ id: '6.3', role: 'tool', text: 'Edit', tool: { callId: 't', title: 'Edit a.ts', kind: 'edit', status: 'failed', detail: 'String to replace not found in file.', preview }, overflow: { detail: true } }, 'failed');
    expect(host.querySelector('[data-diff]')).not.toBeNull();
    expect(host.querySelector('[data-detail]')?.textContent).toBe('String to replace not found in file.');
    expect(host.querySelector('[data-truncated]')?.textContent).toBe('Show full output');
  });

  it('offers a cut command output whole, in place, and folds it back', async () => {
    await renderRow({ id: '8.1', role: 'tool', text: 'npm test', tool: { callId: 't', title: 'npm test', kind: 'execute', status: 'completed', preview: { kind: 'shell', command: 'npm test', output: 'line 1\n' } }, overflow: { output: true } });
    const toggle = () => host.querySelector('[data-output-toggle]') as HTMLButtonElement;
    expect(toggle().textContent).toBe('Show full output');
    await act(async () => { toggle().click(); });
    await flush();
    expect(host.querySelector('.wmux-chatv2-shell-output')?.textContent).toBe('line 1\nline 2\nline 3\n');
    expect(host.querySelector('.wmux-chatv2-shell-output')?.hasAttribute('data-full')).toBe(true);
    expect(toggle().textContent).toBe('Show less');
    await act(async () => { toggle().click(); });
    expect(host.querySelector('.wmux-chatv2-shell-output')?.hasAttribute('data-full')).toBe(false);
  });

  it('opens a cut long output on its real tail, with how many lines came before and one control', async () => {
    const log = Array.from({ length: 100 }, (_, i) => `[build] ${String(i).padStart(5, '0')} compiling ok`).join('\n') + '\n';
    // The fold kept a head that ends mid-line, as a byte cap does.
    const head = log.slice(0, 100);
    const reads: string[] = [];
    const tailActions: TranscriptActions = { answer: async () => true, body: async (_id, field) => { reads.push(field); return { text: log }; } };
    const block: Block = { id: '8.2', role: 'tool', text: 'npm run build', tool: { callId: 't', title: 'npm run build', kind: 'execute', status: 'completed', preview: { kind: 'shell', command: 'npm run build', output: head } }, overflow: { output: true, detail: true } };
    await act(async () => root.render(<TranscriptRowView row={{ kind: 'tool', key: block.id, block, state: 'done' }} cwd="/repo" actions={tailActions} findActive={false} />));
    const output = () => host.querySelector('.wmux-chatv2-shell-output')?.textContent ?? '';
    // Closed and not read yet: the head's whole lines only, never a cut line.
    expect(output().endsWith('\n')).toBe(true);
    expect(output()).toContain('[build] 00002 compiling ok\n');
    expect(output()).not.toContain('[build] 00003');
    // Opening the row reads the whole output, so the tail shown is the command's own.
    const details = host.querySelector('details') as HTMLDetailsElement;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    await flush();
    expect(reads).toEqual(['output']);
    expect(output().split('\n').filter(Boolean)).toHaveLength(SHELL_TAIL_LINES);
    expect(output()).toContain('[build] 00099 compiling ok\n');
    expect(host.querySelector('[data-shell-earlier]')?.textContent).toBe(`\u2026 ${100 - SHELL_TAIL_LINES} earlier lines`);
    // One control, not one per cut field.
    expect([...host.querySelectorAll('.wmux-chatv2-tool button')].map((b) => b.textContent)).toEqual(['Show full output']);
    await act(async () => { (host.querySelector('[data-output-toggle]') as HTMLButtonElement).click(); });
    expect(output()).toBe(log);
    expect(host.querySelector('[data-shell-earlier]')).toBeNull();
  });

  it('reads an output that fits from its top with no control, and opens a larger one on its tail', async () => {
    // jsdom lays nothing out: an 18px line in a box that holds 14 of them.
    const proto = HTMLPreElement.prototype;
    const lineCount = (el: Element) => (el.textContent ?? '').replace(/\n$/, '').split('\n').length;
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return lineCount(this) * 18; } });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return Math.min(lineCount(this) * 18, 14 * 18); } });
    try {
      const shell = (id: string, lines: number): Block => {
        const output = Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n';
        return { id, role: 'tool', text: 'git diff', tool: { callId: 't', title: 'git diff', kind: 'execute', status: 'completed', preview: { kind: 'shell', command: 'git diff', output } } };
      };
      await renderRow(shell('9.1', 12));
      const pre = () => host.querySelector('.wmux-chatv2-shell-output') as HTMLPreElement;
      expect(pre().scrollTop).toBe(0);
      expect(host.querySelector('[data-output-toggle]')).toBeNull();
      await renderRow(shell('9.2', 30));
      expect(pre().scrollTop).toBe(30 * 18);
      expect(host.querySelector('[data-output-toggle]')?.textContent).toBe('Show full output');
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollHeight;
      delete (proto as unknown as Record<string, unknown>).clientHeight;
    }
  });

  it('reads a running command\u2019s cut output again once it moved on, keeping the old read until then', async () => {
    let body = 'early 1\nearly 2\n';
    const reads: string[] = [];
    const liveActions: TranscriptActions = { answer: async () => true, body: async () => { reads.push(body); return { text: body }; } };
    const block = (status: string, output: string): Block => ({ id: '8.3', role: 'tool', text: 'npm run e2e', tool: { callId: 't', title: 'npm run e2e', kind: 'execute', status, preview: { kind: 'shell', command: 'npm run e2e', output } }, overflow: { output: true } });
    const show = (b: Block, state: 'running' | 'done') =>
      act(async () => root.render(<TranscriptRowView row={{ kind: 'tool', key: b.id, block: b, state }} cwd="/repo" actions={liveActions} findActive={false} />));
    await show(block('in_progress', 'early 1\n'), 'running');
    const details = host.querySelector('details') as HTMLDetailsElement;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    await flush();
    const output = () => host.querySelector('.wmux-chatv2-shell-output')?.textContent;
    expect(output()).toBe('early 1\nearly 2\n');
    // The command finishes with more output: the open box reads it again.
    body = 'early 1\nearly 2\nlate 3\ndone\n';
    await show(block('completed', 'early 1\n'), 'done');
    await flush();
    expect(reads).toHaveLength(2);
    expect(output()).toBe(body);
  });

  it('shows a cut head up to its last whole line, and a complete output\u2019s tail', () => {
    expect(shellView('a\nb\nc', false, false)).toEqual({ text: 'a\nb\n', earlier: 0 });
    expect(shellView('one long line', false, false)).toEqual({ text: 'one long line', earlier: 0 });
    expect(shellView('1\n2\n3\n4\n', true, false, 2)).toEqual({ text: '3\n4\n', earlier: 2 });
    expect(shellView('1\n2\n3\n4\n', true, true, 2)).toEqual({ text: '1\n2\n3\n4\n', earlier: 0 });
  });
});

describe('approval arm', () => {
  it('keeps Allow and Deny disabled for 1.5 s after the card is first shown, whatever the daemon stamp says', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const onAnswer = vi.fn(async () => true);
    // Stamped long before "now" by a daemon whose clock runs behind: still armed from local receipt.
    const block: Block = { id: '3.1', role: 'tool', text: 'Write', tool: { callId: 't', title: 'Write' }, approval: { requestId: 'r-arm-1', requestedAt: 10_000 } };
    await act(async () => root.render(<PinnedApproval block={block} cwd="/repo" active onAnswer={onAnswer} />));
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
    // Accepted: the pinned card goes at once, so it cannot be answered twice (the row keeps the receipt).
    expect(host.querySelector('[data-chatv2-approval]')).toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('stays armed when a card it already showed mounts again, and unlocks after a refused answer', async () => {
    vi.useFakeTimers({ now: 200_000 });
    const block: Block = { id: '4.1', role: 'tool', text: 'Bash', approval: { requestId: 'r-arm-2', requestedAt: 200_000 } };
    const onAnswer = vi.fn(async () => false);
    await act(async () => root.render(<PinnedApproval block={block} cwd="/repo" active onAnswer={onAnswer} />));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    await act(async () => root.render(<div />));
    await act(async () => root.render(<PinnedApproval block={block} cwd="/repo" active onAnswer={onAnswer} />));
    expect([...host.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
    await act(async () => { host.querySelector('button')!.click(); });
    expect([...host.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
  });
});

describe('decided approval', () => {
  it('shows a check for allowed, a cross for denied, and no mark for cancelled', async () => {
    const decided = (requestId: string, decision: 'allow' | 'deny' | 'cancelled'): Block =>
      ({ id: requestId, role: 'tool', text: 'Edit', approval: { requestId, requestedAt: 0, decided: decision } });
    for (const [decision, label, marked] of [['allow', 'Allowed', true], ['deny', 'Denied', true], ['cancelled', 'Cancelled', false]] as const) {
      await act(async () => root.render(<ApprovalCard block={decided(`r-d-${decision}`, decision)} onAnswer={vi.fn(async () => true)} />));
      const row = host.querySelector(`[data-decision="${decision}"]`);
      expect(row?.textContent).toBe(label);
      expect(!!row?.querySelector('svg')).toBe(marked);
    }
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
    // The "Chat only" kind badge lives in the pane header now, not in a row of the view.
    expect(host.querySelector('.wmux-chat-kind')).toBeNull();
    expect(host.querySelector('[data-chatv2-runs-in]')?.textContent).toBe('Runs in …/verified/repo');
    expect(host.querySelector('[data-chatv2-runs-in]')?.getAttribute('title')).toBe('/home/me/verified/repo');
    expect(mock.calls.map((call) => call.method).sort()).toEqual(['bindingForPane', 'subscribe']);
    expect(ptyCalls).toEqual([]);
  });

  it('starts a Codex chat from the agent chip, on its own default model and always asking', async () => {
    await act(async () => root.render(<ChatV2View paneId="daemon-codex" active onTerminal={() => undefined} />));
    await flush();
    const set = (el: HTMLSelectElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    const agent = () => host.querySelector('[data-chatv2-agent]') as HTMLElement;
    const mode = () => host.querySelector('[data-mode] select') as HTMLSelectElement;
    expect(agent().querySelector('select')?.value).toBe('claude');
    // Bypass picked for Claude does not carry over to Codex.
    await act(async () => { set(mode(), 'bypass'); });
    await act(async () => { set(agent().querySelector('select') as HTMLSelectElement, 'codex'); });
    expect(mode().value).toBe('default');
    expect(mode().disabled).toBe(true);
    // The always-asks chip wears the fixed-chip style: muted, no hover highlight.
    const chip = mode().closest('.wmux-chatv2-chip') as HTMLElement;
    const hoverable = fs.readFileSync(path.resolve('src/renderer/components/ChatV2/composer.css'), 'utf8').match(/^(\.wmux-chatv2-chip:hover[^{]*)\{/m)?.[1].replace(':hover', '').trim();
    expect(hoverable).toBeTruthy();
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.matches(hoverable as string)).toBe(false);
    expect(host.querySelector('.wmux-chatv2-chips')?.textContent).toContain('Codex default');
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(box.placeholder).toBe('What should Codex do?');
    expect(host.querySelector('.wmux-chatv2-empty')?.textContent).toContain('Starts Codex in this pane');
    await act(async () => { set(box, 'fix the build'); });
    await act(async () => { (host.querySelector('.wmux-chatv2-send') as HTMLButtonElement).click(); });
    await flush();
    expect(mock.calls.find((call) => call.method === 'create')?.params).toEqual({ paneId: 'daemon-codex', agent: 'codex', mode: 'default' });
    // The started chat names its agent, fixed.
    expect(agent().tagName).toBe('SPAN');
    expect(agent().textContent).toContain('Codex');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Message Codex…');
  });

  it('offers a jump to the latest row while scrolled up, and follows again on send', async () => {
    await mock.call('subscribe', { paneId: 'daemon-follow' });
    await mock.call('create', { paneId: 'daemon-follow', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-follow" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => { mock.emit('daemon-follow', [{ type: 'user.message', text: 'one', clientMessageId: 'c-00000001' }, { type: 'turn.ended', outcome: 'completed' }]); });
    const viewport = host.querySelector('.wmux-chatv2-viewport') as HTMLDivElement;
    // The reader scrolls up, away from the end.
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    viewport.scrollTop = 100;
    await act(async () => { viewport.dispatchEvent(new Event('scroll')); });
    // Away from the end, the way back is offered by itself, labelled.
    expect(host.querySelector('[data-chatv2-jump]')?.textContent).toBe('Jump to latest');
    await act(async () => { mock.emit('daemon-follow', [{ type: 'session.error', message: 'boom' }]); });
    const jump = host.querySelector('[data-chatv2-jump]') as HTMLButtonElement;
    expect(jump?.getAttribute('title')).toBe('chat.scrollToBottom');
    expect(jump.textContent).toBe('New messages below');
    // The permissions chip is never scrolled away with the other chips.
    expect(host.querySelector('.wmux-chatv2-chips > [data-chatv2-permission]')).not.toBeNull();
    expect(host.querySelector('.wmux-chatv2-chip-strip [data-chatv2-permission]')).toBeNull();
    // Sending goes back to the end, and the jump is no longer needed.
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'two');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (host.querySelector('.wmux-chatv2-send') as HTMLButtonElement).click(); });
    await flush();
    expect(host.querySelector('[data-chatv2-jump]')).toBeNull();
    expect(viewport.scrollTop).toBe(2000);
  });

  it('ends an open find before following the newest row', async () => {
    // jsdom has neither; find uses both to bring a match into view.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    await mock.call('subscribe', { paneId: 'daemon-find' });
    await mock.call('create', { paneId: 'daemon-find', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-find" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => { mock.emit('daemon-find', [{ type: 'user.message', text: 'needle here', clientMessageId: 'c-00000001' }, { type: 'turn.ended', outcome: 'completed' }]); });
    const viewport = host.querySelector('.wmux-chatv2-viewport') as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    // Find a match: the view holds on it.
    await act(async () => { (host.querySelector('.wmux-chatv2') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })); });
    const input = host.querySelector('.wmux-chatv2-find input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(scrollIntoView).toHaveBeenCalled();
    viewport.scrollTop = 100;
    await act(async () => { mock.emit('daemon-find', [{ type: 'session.error', message: 'boom' }]); });
    expect(viewport.scrollTop).toBe(100);
    // The jump closes find and goes to the end.
    await act(async () => { (host.querySelector('[data-chatv2-jump]') as HTMLButtonElement).click(); });
    expect(host.querySelector('.wmux-chatv2-find')).toBeNull();
    expect(viewport.scrollTop).toBe(2000);
    // Find again, then send: find closes and the view follows the sent message.
    await act(async () => { (host.querySelector('.wmux-chatv2') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })); });
    const again = host.querySelector('.wmux-chatv2-find input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(again, 'needle');
      again.dispatchEvent(new Event('input', { bubbles: true }));
    });
    viewport.scrollTop = 100;
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'two');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (host.querySelector('.wmux-chatv2-send') as HTMLButtonElement).click(); });
    await flush();
    expect(host.querySelector('.wmux-chatv2-find')).toBeNull();
    expect(viewport.scrollTop).toBe(2000);
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
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
    // The settled turn's receipt is one line under the prompt: how long it worked, then the model on hover.
    expect(host.querySelector('.wmux-chatv2-footer')).toBeNull();
    expect(host.querySelector('[data-turn-fold] .wmux-chatv2-turn-toggle')?.textContent).toMatch(/^Worked for \d+s/);
    expect(host.querySelector('[data-turn-fold] .wmux-chatv2-turn-meta')?.textContent).toMatch(/^Opus 5\.5/);
    expect(host.querySelector('[data-chatv2-approval]')).toBeNull();
    // The ⋯ menu shows the directory the chat runs in, and Continue in Terminal (out of the chip row).
    expect(host.querySelector('.wmux-chatv2-chips')?.textContent).not.toContain('Continue in Terminal');
    await act(async () => { (host.querySelector('[data-chatv2-more]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-chatv2-cwd]')?.getAttribute('title')).toBe('/tmp/demo');
    expect(host.querySelector('[data-chatv2-menu="terminal"]')?.textContent).toBe('Continue in Terminal');
    expect(ptyCalls).toEqual([]);
  });

  it('moves the chips into the ⋯ menu together when the row cannot hold them, and back once it can', async () => {
    // jsdom lays nothing out: the chip row reports the widths a pane would.
    const row = { client: 400, scroll: 300 };
    const isRow = (el: Element) => el.classList.contains('wmux-chatv2-chips');
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return isRow(this) ? row.client : 0; });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return isRow(this) ? Math.max(row.scroll, row.client) : 0; });
    let resized: () => void = () => undefined;
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb; } observe() { /* the test calls resized() itself */ } disconnect() { /* nothing to release */ } });
    try {
      await mock.call('subscribe', { paneId: 'daemon-fold' });
      await mock.call('create', { paneId: 'daemon-fold', agent: 'claude', mode: 'default', model: 'claude-opus-5-5' });
      await act(async () => root.render(<ChatV2View paneId="daemon-fold" active onTerminal={() => undefined} />));
      await flush();
      const chipsInRow = () => host.querySelectorAll('.wmux-chatv2-chips .wmux-chatv2-chip').length;
      expect(chipsInRow()).toBeGreaterThan(0);
      row.client = 150;
      await act(async () => { resized(); });
      expect(chipsInRow()).toBe(0);
      expect(host.querySelector('.wmux-chatv2-send')).not.toBeNull();
      await act(async () => { (host.querySelector('[data-chatv2-more]') as HTMLButtonElement).click(); });
      const folded = host.querySelector('[data-chatv2-folded-chips]');
      expect(folded?.querySelector('[data-chatv2-model] select')).not.toBeNull();
      expect(folded?.querySelector('[data-chatv2-effort] select')).not.toBeNull();
      expect(folded?.querySelector('[data-chatv2-permission] select')).not.toBeNull();
      // Wide enough for what the row needed when they moved: all back in the row.
      row.client = 320;
      await act(async () => { resized(); });
      expect(chipsInRow()).toBeGreaterThan(0);
      expect(host.querySelector('[data-chatv2-folded-chips]')).toBeNull();
    } finally {
      client.mockRestore();
      scroll.mockRestore();
    }
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
    const code = () => host.querySelector('[data-streaming] [data-brain-md-code] pre');
    expect(code()?.textContent).toBe('const a = 1;\n');
    await act(async () => { mock.emit('daemon-fence', [{ type: 'message.delta', text: 'const b = 2;\n```\nDone.' }]); });
    expect(host.querySelector('[data-brain-md-code] pre')?.textContent).toBe('const a = 1;\nconst b = 2;');
    // A reply's code block carries its language and Copy, as other markdown surfaces do.
    expect(host.querySelector('[data-brain-md-code-lang]')?.textContent).toBe('ts');
    expect(host.querySelector('[data-brain-md-code-copy]')).not.toBeNull();
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

  it('says a chat a terminal in another pane took continued there, and shows that pane (#2730)', async () => {
    await mock.call('create', { paneId: 'daemon-elsewhere', agent: 'claude', mode: 'default' });
    const record = mock.record('daemon-elsewhere')!;
    record.binding = { ...record.binding, status: 'handed-off', continuedIn: { paneId: 'pty-other' }, capabilities: { ...record.binding.capabilities, send: false, toTerminal: false } };
    await act(async () => root.render(<ChatV2View paneId="daemon-elsewhere" active onTerminal={() => undefined} />));
    await flush();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('chat.continuedInPane');
    expect(host.textContent).not.toContain('chat.openTerminal');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'chat.showPane')!.click(); });
    expect(focusPaneByPtyId).toHaveBeenCalledWith(expect.any(Function), 'pty-other');
  });

  it('names no pane when the terminal that took the chat was matched by its folder (#2730)', async () => {
    await mock.call('create', { paneId: 'daemon-folder', agent: 'claude', mode: 'default' });
    const record = mock.record('daemon-folder')!;
    record.binding = { ...record.binding, status: 'handed-off', continuedIn: {}, capabilities: { ...record.binding.capabilities, send: false, toTerminal: false } };
    await act(async () => root.render(<ChatV2View paneId="daemon-folder" active onTerminal={() => undefined} />));
    await flush();
    expect(host.textContent).toContain('chat.continuedInTerminal');
    expect(host.textContent).not.toContain('chat.showPane');
    expect(host.textContent).not.toContain('chat.openTerminal');
  });

  const type = async (value: string) => {
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const clickSend = async () => {
    await act(async () => { (host.querySelector('.wmux-chatv2-send') as HTMLButtonElement).click(); });
    await flush();
  };
  const sent = () => mock.calls.filter((call) => call.method === 'send').map((call) => call.params as { text: string; clientMessageId: string; attachments?: string[] });
  const queued = () => [...host.querySelectorAll('[data-chatv2-queued] .wmux-chatv2-queued-text')].map((el) => el.textContent);
  // A split unmounts the pane's view and mounts it again.
  const remount = async (paneId: string) => {
    await act(async () => root.render(<div />));
    await act(async () => root.render(<ChatV2View paneId={paneId} active onTerminal={() => undefined} />));
    await flush();
  };

  it('queues a message sent mid-turn, delivers it when the turn ends, and keeps the queue through Stop', async () => {
    await mock.call('subscribe', { paneId: 'daemon-queue' });
    await mock.call('create', { paneId: 'daemon-queue', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-queue" active onTerminal={() => undefined} />));
    await flush();
    await type('first');
    await clickSend();
    expect(sent().map((p) => p.text)).toEqual(['first']);
    // Mid-turn, the one primary button is Stop while nothing is typed, and Send (which queues) once something is.
    expect(host.querySelector('.wmux-chatv2-send')?.getAttribute('aria-label')).toBe('Stop');
    expect(host.querySelectorAll('.wmux-chatv2-send')).toHaveLength(1);
    await type('second');
    expect(host.querySelector('.wmux-chatv2-send')?.getAttribute('aria-label')).toBe('Queue · sent when the current reply ends');
    await clickSend();
    await type('third');
    await clickSend();
    expect(sent().map((p) => p.text)).toEqual(['first']);
    expect(queued()).toEqual(['second', 'third']);
    expect(host.querySelector('.wmux-chatv2-queued-caption > span')?.textContent).toBe('chat.queued');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    // The queue sits in the dock above the composer, not in the transcript.
    expect(host.querySelector('.wmux-chatv2-column [data-chatv2-queued]')).toBeNull();
    expect(host.querySelector('.wmux-chatv2-dock [data-chatv2-queued]')).not.toBeNull();
    // Stop ends the turn only: the queue stays, and its first message goes as the turn ends.
    await act(async () => { (host.querySelector('.wmux-chatv2-send[data-stop]') as HTMLButtonElement).click(); });
    await flush();
    expect(mock.calls.some((call) => call.method === 'interrupt')).toBe(true);
    expect(sent().map((p) => p.text)).toEqual(['first', 'second']);
    expect(queued()).toEqual(['third']);
    await act(async () => { mock.emit('daemon-queue', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['first', 'second', 'third']);
    expect(queued()).toEqual([]);
    expect(new Set(sent().map((p) => p.clientMessageId)).size).toBe(3);
  });

  it('keeps Stop reachable with a draft typed: the ⋯ menu offers it, and Esc then leaves the draft alone', async () => {
    await mock.call('subscribe', { paneId: 'daemon-stopdraft' });
    await mock.call('create', { paneId: 'daemon-stopdraft', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-stopdraft" active onTerminal={() => undefined} />));
    await flush();
    await type('first');
    await clickSend();
    await type('a draft');
    expect(host.querySelector('.wmux-chatv2-send[data-stop]')).toBeNull();
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(mock.calls.some((call) => call.method === 'interrupt')).toBe(false);
    await act(async () => { (host.querySelector('[data-chatv2-more]') as HTMLButtonElement).click(); });
    await act(async () => { (host.querySelector('[data-chatv2-menu="stop"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mock.calls.some((call) => call.method === 'interrupt')).toBe(true);
    expect(textarea.value).toBe('a draft');
  });

  // Holds or fails the host's answers to one method, for the review cases below.
  const intercept = (method: string, answer: (forward: () => Promise<unknown>) => Promise<unknown>) => {
    const call = mock.call.bind(mock);
    mock.call = ((m, params) => (m === method ? answer(() => call(m, params)) : call(m, params))) as typeof mock.call;
  };
  const startQueued = async (paneId: string) => {
    await mock.call('subscribe', { paneId });
    await mock.call('create', { paneId, agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId={paneId} active onTerminal={() => undefined} />));
    await flush();
    await type('first');
    await clickSend();
    await type('second');
    await clickSend();
    expect(queued()).toEqual(['second']);
  };

  it('keeps a queued message when the bridge fails its delivery, and tries again on the next event', async () => {
    await startQueued('daemon-reject');
    let fail = true;
    intercept('send', (forward) => (fail ? (fail = false, Promise.reject(new Error('bridge gone'))) : forward()));
    await act(async () => { mock.emit('daemon-reject', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    expect(queued()).toEqual(['second']);
    expect(host.querySelector('[data-chatv2-queued-remove]')).not.toBeNull();
    await act(async () => { mock.emit('daemon-reject', [{ type: 'session.started' }]); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['first', 'second']);
    expect(queued()).toEqual([]);
  });

  it('shows a queued message as sending once its delivery started, with nothing that would pretend to cancel it', async () => {
    await startQueued('daemon-sending');
    let release: () => void = () => undefined;
    let attempts = 0;
    intercept('send', (forward) => { attempts += 1; return new Promise<void>((resolve) => { release = resolve; }).then(forward); });
    await act(async () => { mock.emit('daemon-sending', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    const bubble = host.querySelector('[data-chatv2-queued]') as HTMLElement;
    expect(bubble.hasAttribute('data-sending')).toBe(true);
    expect(bubble.querySelector('.wmux-chatv2-queued-caption')?.textContent).toBe('Sending…');
    expect(bubble.querySelector('[data-chatv2-queued-remove]')).toBeNull();
    expect(bubble.querySelector('[data-chatv2-queued-edit]')).toBeNull();
    // A remount meanwhile does not start it a second time.
    await remount('daemon-sending');
    expect(host.querySelector('[data-chatv2-queued]')?.hasAttribute('data-sending')).toBe(true);
    expect(attempts).toBe(1);
    await act(async () => { release(); });
    await flush();
    expect(mock.calls.filter((call) => call.method === 'send').length).toBe(2);
    expect(queued()).toEqual([]);
  });

  it('moves queued messages into the composer when their chat is gone', async () => {
    await startQueued('daemon-gone');
    await type('newer');
    await clickSend();
    intercept('send', async () => chatV2Error('session-not-found', 'No chat for this pane.'));
    intercept('subscribe', async () => ({ ok: true, binding: null }));
    await act(async () => { mock.emit('daemon-gone', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    await flush();
    expect(host.querySelector('[data-chatv2="empty"]')).not.toBeNull();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('second\n\nnewer');
    expect(host.querySelector('[data-tone="error"]')?.textContent).toBe('The chat your queued messages were waiting for is gone. They are back in the composer.');
  });

  it('keeps the first message of a chat created during a split remount in that chat’s composer', async () => {
    await mock.call('subscribe', { paneId: 'daemon-create' });
    let release: () => void = () => undefined;
    intercept('create', (forward) => new Promise<void>((resolve) => { release = resolve; }).then(forward));
    await act(async () => root.render(<ChatV2View paneId="daemon-create" active onTerminal={() => undefined} />));
    await flush();
    await type('hello');
    await clickSend();
    await remount('daemon-create');
    await act(async () => { release(); });
    await flush();
    await flush();
    expect(host.querySelector('[data-chatv2="ready"]')).not.toBeNull();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello');
    expect(sent()).toEqual([]);
  });

  it('queues a message sent while the agent is still starting, and sends it once it is ready', async () => {
    await mock.call('subscribe', { paneId: 'daemon-starting' });
    await mock.call('create', { paneId: 'daemon-starting', agent: 'claude', mode: 'default' });
    mock.record('daemon-starting')!.binding.status = 'starting';
    await act(async () => root.render(<ChatV2View paneId="daemon-starting" active onTerminal={() => undefined} />));
    await flush();
    await type('go');
    await clickSend();
    expect(sent()).toEqual([]);
    expect(queued()).toEqual(['go']);
    await act(async () => { mock.emit('daemon-starting', [{ type: 'session.started' }]); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['go']);
  });

  it('refuses to edit a queued message whose images would not fit in the composer, and keeps it queued', async () => {
    await startQueued('daemon-full');
    const key = `daemon-full:${mock.record('daemon-full')!.binding.chatSessionId}`;
    const image = (n: number) => ({ path: `/staged/${n}.png`, name: `${n}.png` });
    await act(async () => {
      setStaged(key, [1, 2, 3, 4, 5].map(image));
      enqueueMessage(key, { id: 'm-with-image', text: 'look', staged: [image(6)] });
    });
    const edit = () => host.querySelectorAll('[data-chatv2-queued-edit]')[1] as HTMLButtonElement;
    await act(async () => { edit().click(); });
    expect(queued()).toEqual(['second', 'look']);
    expect(host.querySelectorAll('[data-attachment]')).toHaveLength(5);
    expect(host.querySelectorAll('[data-chatv2-queued]')[1].textContent).toContain('The composer has no room for this message’s images.');
  });

  it('lets a queued message be removed, or taken back to edit, before it goes', async () => {
    await mock.call('subscribe', { paneId: 'daemon-unqueue' });
    await mock.call('create', { paneId: 'daemon-unqueue', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-unqueue" active onTerminal={() => undefined} />));
    await flush();
    await type('first');
    await clickSend();
    await type('wrong one');
    await clickSend();
    await type('right one');
    await clickSend();
    expect(queued()).toEqual(['wrong one', 'right one']);
    const remove = host.querySelector('[data-chatv2-queued-remove]') as HTMLButtonElement;
    // A real button with a name, so it is reached and announced from the keyboard.
    expect(remove.tagName).toBe('BUTTON');
    expect(remove.getAttribute('aria-label')).toBe('Remove queued message');
    await act(async () => { remove.click(); });
    expect(queued()).toEqual(['right one']);
    await act(async () => { mock.emit('daemon-unqueue', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['first', 'right one']);
    // Edit takes a queued message back into the composer, unsent.
    await type('typo');
    await clickSend();
    expect(queued()).toEqual(['typo']);
    await act(async () => { (host.querySelector('[data-chatv2-queued-edit]') as HTMLButtonElement).click(); });
    expect(queued()).toEqual([]);
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('typo');
    await act(async () => { mock.emit('daemon-unqueue', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['first', 'right one']);
  });

  it('changes model and effort of a started chat between turns, and offers / commands and the agent skills', async () => {
    await mock.call('subscribe', { paneId: 'daemon-tune' });
    await mock.call('create', { paneId: 'daemon-tune', agent: 'claude', mode: 'default' });
    mock.skillCatalog = { skills: [{ name: 'review', description: 'Review the diff', invocation: '/review', source: 'project' }], state: 'ready' };
    await act(async () => root.render(<ChatV2View paneId="daemon-tune" active onTerminal={() => undefined} />));
    await flush();
    const effort = host.querySelector('[data-chatv2-effort] select') as HTMLSelectElement;
    expect(effort.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(effort, 'high');
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(mock.calls.find((call) => call.method === 'configure')?.params).toMatchObject({ paneId: 'daemon-tune', effort: 'high' });
    expect((host.querySelector('[data-chatv2-effort] select') as HTMLSelectElement).value).toBe('high');
    // The / menu: in-chat commands, then the agent's skills; Enter inserts the skill.
    await type('/');
    await flush();
    const options = () => [...host.querySelectorAll('[role="option"] .wmux-chatv2-slash-name')].map((el) => el.textContent);
    expect(options()).toEqual(['/model', '/effort', '/terminal', '/review']);
    await type('/rev');
    expect(options()).toEqual(['/review']);
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(box.value).toBe('/review ');
    expect(mock.calls.some((call) => call.method === 'send')).toBe(false);
    // Mid-turn the pickers wait for the agent.
    await act(async () => { mock.emit('daemon-tune', [{ type: 'user.message', text: 'go', clientMessageId: 'c-00000009' }]); });
    expect((host.querySelector('[data-chatv2-effort] select') as HTMLSelectElement).disabled).toBe(true);
  });

  it('asks for the skills once per opening of /, again after an unavailable answer, and never for a / later in the text', async () => {
    await mock.call('subscribe', { paneId: 'daemon-skills' });
    await mock.call('create', { paneId: 'daemon-skills', agent: 'claude', mode: 'default' });
    let answer: 'unavailable' | 'ready' = 'unavailable';
    let skillAsks = 0;
    intercept('skills', async () => { skillAsks += 1; return { ok: true, catalog: { skills: answer === 'ready' ? [{ name: 'review', description: 'Review', invocation: '/review', source: 'project' }] : [], state: answer } }; });
    await act(async () => root.render(<ChatV2View paneId="daemon-skills" active onTerminal={() => undefined} />));
    await flush();
    const skillCalls = () => skillAsks;
    await type('/');
    await flush();
    // Streaming re-renders the view: the open menu does not ask again.
    await act(async () => { mock.emit('daemon-skills', [{ type: 'user.message', text: 'go', clientMessageId: 'c-00000011' }]); });
    await act(async () => root.render(<ChatV2View paneId="daemon-skills" active onTerminal={() => undefined} cwd="/elsewhere" />));
    await flush();
    expect(skillCalls()).toBe(1);
    await type('');
    answer = 'ready';
    await type('/');
    await flush();
    expect(skillCalls()).toBe(2);
    expect([...host.querySelectorAll('[role="option"] .wmux-chatv2-slash-name')].map((el) => el.textContent)).toContain('/review');
    await type('hello /re');
    expect(host.querySelector('.wmux-chatv2-slash')).toBeNull();
  });

  it('holds a message sent during a model change and delivers it once the change settles, also a refused one', async () => {
    await mock.call('subscribe', { paneId: 'daemon-hold' });
    await mock.call('create', { paneId: 'daemon-hold', agent: 'claude', mode: 'default' });
    let release: (() => void) | undefined;
    intercept('configure', () => new Promise<void>((resolve) => { release = resolve; }).then(() => chatV2Error('invalid-params', 'The agent does not take that model or effort.')));
    await act(async () => root.render(<ChatV2View paneId="daemon-hold" active onTerminal={() => undefined} />));
    await flush();
    const effort = host.querySelector('[data-chatv2-effort] select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(effort, 'high');
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('after the change');
    await clickSend();
    await flush();
    expect(sent()).toEqual([]);
    expect(queued()).toEqual(['after the change']);
    await act(async () => { release?.(); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['after the change']);
    expect(queued()).toEqual([]);
  });

  it('keeps holding the queue through a remount during a model change, and delivers it once a refusal settles it', async () => {
    await mock.call('subscribe', { paneId: 'daemon-holdmove' });
    await mock.call('create', { paneId: 'daemon-holdmove', agent: 'claude', mode: 'default' });
    let release: (() => void) | undefined;
    intercept('configure', () => new Promise<void>((resolve) => { release = resolve; }).then(() => chatV2Error('invalid-params', 'The agent does not take that model or effort.')));
    await act(async () => root.render(<ChatV2View paneId="daemon-holdmove" active onTerminal={() => undefined} />));
    await flush();
    const effort = host.querySelector('[data-chatv2-effort] select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(effort, 'high');
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('after the change');
    await clickSend();
    await remount('daemon-holdmove');
    expect(sent()).toEqual([]);
    expect(queued()).toEqual(['after the change']);
    await act(async () => { release?.(); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['after the change']);
  });

  it('attaches any file to the first message, as a file chip, and sends it with the new chat', async () => {
    mock.stageAttachment = async (file: string) => ({ ok: true, path: file, name: file.split('/').pop() ?? file, kind: 'file', size: 3 });
    await act(async () => root.render(<ChatV2View paneId="daemon-first" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => { deliverChatDrop('daemon-first', ['/repo/notes.md']); });
    await flush();
    const chip = host.querySelector('[data-attachment]') as HTMLElement;
    expect(chip.dataset.kind).toBe('file');
    expect(chip.textContent).toBe('notes.md');
    await type('summarize this');
    await clickSend();
    await flush();
    expect(mock.calls.find((call) => call.method === 'create')).toBeTruthy();
    expect(sent()[0]).toMatchObject({ text: 'summarize this', attachments: ['/repo/notes.md'] });
  });

  it('leaves no copy of a first message that went in the new chat\u2019s composer, and keeps one that did not', async () => {
    let release: () => void = () => undefined;
    let sends = 0;
    intercept('send', (forward) => { sends += 1; return sends === 1 ? new Promise<void>((resolve) => { release = resolve; }).then(forward) : Promise.resolve(chatV2Error('invalid-params', 'no')); });
    await act(async () => root.render(<ChatV2View paneId="daemon-firstsend" active onTerminal={() => undefined} />));
    await flush();
    await type('hello');
    await clickSend();
    // The chat shows while its first message is still on the way.
    expect(host.querySelector('[data-chatv2="ready"]')).not.toBeNull();
    await act(async () => { release(); });
    await flush();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await remount('daemon-firstsend');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await act(async () => root.render(<ChatV2View paneId="daemon-firstfail" active onTerminal={() => undefined} />));
    await flush();
    await type('kept');
    await clickSend();
    await flush();
    expect(host.querySelector('[data-chatv2="ready"]')).not.toBeNull();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('kept');
  });

  it('sends on the Enter that follows a finished IME composition, once and with no newline', async () => {
    await mock.call('subscribe', { paneId: 'daemon-ime' });
    await mock.call('create', { paneId: 'daemon-ime', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-ime" active onTerminal={() => undefined} />));
    await flush();
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await type('\uD55C\uAE00');
    // The Enter that commits the syllable belongs to the IME.
    const commit = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    await act(async () => { box.dispatchEvent(commit); });
    expect(commit.defaultPrevented).toBe(false);
    await act(async () => { box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '\uAE00' })); });
    expect(sent()).toEqual([]);
    // A real Enter a few ms later sends, and keeps the newline out.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
    await act(async () => { box.dispatchEvent(enter); });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(sent().map((p) => p.text)).toEqual(['\uD55C\uAE00']);
    expect(box.value).toBe('');
  });

  it('keeps staged attachments with the draft across a split remount, and clears both on send', async () => {
    await mock.call('subscribe', { paneId: 'daemon-attach' });
    await mock.call('create', { paneId: 'daemon-attach', agent: 'claude', mode: 'default' });
    mock.record('daemon-attach')!.binding.capabilities.images = true;
    mock.stageAttachment = async (file: string) => ({ ok: true, path: `/staged/${file.split('/').pop()}`, name: file.split('/').pop() ?? file, kind: 'image', size: 1 });
    await act(async () => root.render(<ChatV2View paneId="daemon-attach" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => { deliverChatDrop('daemon-attach', ['/shots/screen.png']); });
    await flush();
    await type('what is in this picture?');
    await remount('daemon-attach');
    expect(host.querySelector('[data-attachment]')?.textContent).toBe('screen.png');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('what is in this picture?');
    await clickSend();
    expect(sent()[0]).toMatchObject({ text: 'what is in this picture?', attachments: ['/staged/screen.png'] });
    expect(host.querySelector('[data-attachment]')).toBeNull();
    await remount('daemon-attach');
    expect(host.querySelector('[data-attachment]')).toBeNull();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('clears a draft whose send finished after a split remount, and keeps edits made since', async () => {
    await mock.call('subscribe', { paneId: 'daemon-inflight' });
    await mock.call('create', { paneId: 'daemon-inflight', agent: 'claude', mode: 'default' });
    const call = mock.call.bind(mock);
    let release: () => void = () => undefined;
    mock.call = ((method, params) => (method === 'send'
      ? new Promise<void>((resolve) => { release = resolve; }).then(() => call(method, params))
      : call(method, params))) as typeof mock.call;
    await act(async () => root.render(<ChatV2View paneId="daemon-inflight" active onTerminal={() => undefined} />));
    await flush();
    const box = () => host.querySelector('textarea') as HTMLTextAreaElement;
    await type('hello');
    await clickSend();
    await remount('daemon-inflight');
    // Still in flight: shown, but it cannot be sent a second time.
    expect(box().value).toBe('hello');
    expect((host.querySelector('.wmux-chatv2-send') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    await flush();
    expect(box().value).toBe('');
    expect(sent().map((p) => p.text)).toEqual(['hello']);
    // A send whose draft was edited after the remount keeps the newer text.
    await act(async () => { mock.emit('daemon-inflight', [{ type: 'turn.ended', outcome: 'completed' }]); });
    await type('again');
    await clickSend();
    await remount('daemon-inflight');
    await type('again, and more');
    await act(async () => { release(); });
    await flush();
    expect(sent().map((p) => p.text)).toEqual(['hello', 'again']);
    expect(box().value).toBe('again, and more');
  });

  it('says new messages arrived below in a polite live region while scrolled up', async () => {
    await mock.call('subscribe', { paneId: 'daemon-announce' });
    await mock.call('create', { paneId: 'daemon-announce', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-announce" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => { mock.emit('daemon-announce', [{ type: 'user.message', text: 'one', clientMessageId: 'c-00000001' }, { type: 'turn.ended', outcome: 'completed' }]); });
    const region = () => host.querySelector('[data-chatv2-announce]') as HTMLElement;
    expect(region().getAttribute('role')).toBe('status');
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().textContent).toBe('');
    const viewport = host.querySelector('.wmux-chatv2-viewport') as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    viewport.scrollTop = 100;
    await act(async () => { viewport.dispatchEvent(new Event('scroll')); });
    await act(async () => { mock.emit('daemon-announce', [{ type: 'session.error', message: 'boom' }]); });
    expect(region().textContent).toBe('New messages below');
    // The region is its own element, not the jump button's label.
    expect(region().contains(host.querySelector('[data-chatv2-jump]'))).toBe(false);
    // Back at the end, nothing is left to announce.
    viewport.scrollTop = 1700;
    await act(async () => { viewport.dispatchEvent(new Event('scroll')); });
    expect(region().textContent).toBe('');
  });

  it('does not call a settled turn news when its fold leaves a plan it already showed as the newest row', async () => {
    await mock.call('subscribe', { paneId: 'daemon-fold-news' });
    await mock.call('create', { paneId: 'daemon-fold-news', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-fold-news" active onTerminal={() => undefined} />));
    await flush();
    await act(async () => {
      mock.emit('daemon-fold-news', [
        { type: 'user.message', text: 'one', clientMessageId: 'c-00000001' },
        { type: 'plan', text: '1. read\n2. write' },
        { type: 'tool.started', callId: 't1', title: 'Write', kind: 'edit', status: 'pending' },
        { type: 'tool.updated', callId: 't1', status: 'completed' },
      ]);
    });
    const viewport = host.querySelector('.wmux-chatv2-viewport') as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    viewport.scrollTop = 100;
    await act(async () => { viewport.dispatchEvent(new Event('scroll')); });
    await act(async () => { mock.emit('daemon-fold-news', [{ type: 'turn.ended', outcome: 'completed' }]); });
    expect(host.querySelector('[data-chatv2-announce]')?.textContent).toBe('');
    expect(host.querySelector('[data-chatv2-jump]')?.hasAttribute('data-new')).not.toBe(true);
  });

  it('keeps focus in the chat across two approvals in a row, even when the decision lands before the answer returns', async () => {
    vi.useFakeTimers({ now: 700_000, shouldAdvanceTime: true });
    await mock.call('subscribe', { paneId: 'daemon-two-cards' });
    await mock.call('create', { paneId: 'daemon-two-cards', agent: 'claude', mode: 'default' });
    await act(async () => root.render(<ChatV2View paneId="daemon-two-cards" active onTerminal={() => undefined} />));
    await flush();
    const request = (n: number) => [
      { type: 'tool.started', callId: `t${n}`, title: 'ls', kind: 'execute', status: 'pending', preview: { kind: 'shell', command: 'ls' } },
      { type: 'approval.requested', requestId: `r${n}`, title: 'ls', callId: `t${n}` },
    ] as const;
    await act(async () => { mock.emit('daemon-two-cards', [{ type: 'user.message', text: 'go', clientMessageId: 'c-00000001' }, ...request(1)]); });
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    const allow = () => [...host.querySelectorAll('[data-chatv2-approval] button')].find((button) => button.textContent === 'Allow') as HTMLButtonElement;
    allow().focus();
    // The mock host emits the decision before the answer returns: the card is gone by then.
    await act(async () => { allow().click(); });
    await flush();
    expect(host.querySelector('[data-chatv2-approval]')).toBeNull();
    const composer = host.querySelector('.wmux-chatv2-textarea');
    expect(document.activeElement).toBe(composer);
    await act(async () => { mock.emit('daemon-two-cards', [...request(2)]); });
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    await act(async () => { composer!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    await flush();
    expect(mock.calls.filter((call) => call.method === 'answer').map((call) => call.params)).toEqual([
      expect.objectContaining({ requestId: 'r1', decision: 'allow' }),
      expect.objectContaining({ requestId: 'r2', decision: 'allow' }),
    ]);
    expect(document.activeElement).toBe(composer);
  });

  it('measures again when the content shrinks under a reader with no scroll, and drops the way back at the end', async () => {
    const observed: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observed.push(callback); } observe() { return undefined; } disconnect() { return undefined; } });
    try {
      await mock.call('subscribe', { paneId: 'daemon-resize' });
      await mock.call('create', { paneId: 'daemon-resize', agent: 'claude', mode: 'default' });
      await act(async () => root.render(<ChatV2View paneId="daemon-resize" active onTerminal={() => undefined} />));
      await flush();
      await act(async () => { mock.emit('daemon-resize', [{ type: 'user.message', text: 'one', clientMessageId: 'c-00000001' }, { type: 'turn.ended', outcome: 'completed' }]); });
      const viewport = host.querySelector('.wmux-chatv2-viewport') as HTMLDivElement;
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
      viewport.scrollTop = 100;
      await act(async () => { viewport.dispatchEvent(new Event('scroll')); });
      await act(async () => { mock.emit('daemon-resize', [{ type: 'session.error', message: 'boom' }]); });
      expect(host.querySelector('[data-chatv2-jump]')).not.toBeNull();
      // The reader closed a long row: the bottom is on screen now, though nothing scrolled.
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 400 });
      await act(async () => { observed.forEach((callback) => callback()); });
      expect(host.querySelector('[data-chatv2-jump]')).toBeNull();
      expect(host.querySelector('[data-chatv2-announce]')?.textContent).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('pinned approval and turn errors', () => {
  it('shows the command in the card, reads a destructive one red, defaults to Deny and denies on Esc', async () => {
    vi.useFakeTimers({ now: 300_000 });
    const onAnswer = vi.fn(async () => true);
    const block: Block = { id: '7.1', role: 'tool', text: 'Bash', tool: { callId: 't', title: 'rm -rf dist', kind: 'execute', preview: { kind: 'shell', command: 'rm -rf /repo/dist' } }, approval: { requestId: 'r-pin-1', requestedAt: 300_000 } };
    await act(async () => root.render(<div className="wmux-chatv2"><div tabIndex={-1} data-log /><PinnedApproval block={block} cwd="/repo" active onAnswer={onAnswer} /></div>));
    (host.querySelector('[data-log]') as HTMLElement).focus();
    const card = host.querySelector('[data-chatv2-approval]') as HTMLElement;
    // The command exactly as it will run: never shortened.
    expect(card.querySelector('.wmux-chatv2-card-subject')?.textContent).toBe('rm -rf /repo/dist');
    expect(card.hasAttribute('data-destructive')).toBe(true);
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    expect(document.activeElement?.textContent).toBe('Deny');
    await act(async () => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onAnswer).toHaveBeenCalledWith('r-pin-1', 'deny');
  });

  it('says an API error in words and keeps the raw text behind Details', () => {
    expect(readableError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toMatch(/overloaded right now \(529\)/);
    expect(readableError('API Error: 400 {"error":{"message":"prompt is too long"}}')).toBe('prompt is too long (400)');
    expect(readableError('boom')).toBe('boom');
  });
});

describe('pinned approval focus and sent attachments', () => {
  const pinBlock = (requestId: string): Block => ({ id: requestId, role: 'tool', text: 'Bash', tool: { callId: 't', title: 'ls', kind: 'execute', preview: { kind: 'shell', command: 'ls' } }, approval: { requestId, requestedAt: 400_000 } });
  const pinned = (requestId: string, active: boolean, onAnswer = vi.fn(async () => true)) => (
    <div className="wmux-chatv2">
      <div className="wmux-chatv2-find"><input data-find /></div>
      <div className="wmux-chatv2-viewport"><div tabIndex={-1} data-log /></div>
      <PinnedApproval key={requestId} block={pinBlock(requestId)} cwd="/repo" active={active} onAnswer={onAnswer} />
      <div className="wmux-chatv2-composer"><textarea className="wmux-chatv2-textarea" data-composer /></div>
    </div>
  );

  it('takes focus only in the active pane, from the transcript, never out of a text field or from nowhere', async () => {
    vi.useFakeTimers({ now: 400_000 });
    const outside = document.createElement('textarea');
    document.body.append(outside);
    const arm = async () => { await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); }); };
    // Another pane's (empty) input keeps focus.
    outside.focus();
    await act(async () => root.render(pinned('r-focus-1', true)));
    await arm();
    expect(document.activeElement).toBe(outside);
    // This chat's own empty composer keeps it too: the next Space must not answer the card.
    await act(async () => root.render(<div />));
    await act(async () => root.render(pinned('r-focus-2', true)));
    (host.querySelector('[data-composer]') as HTMLElement).focus();
    await arm();
    expect(document.activeElement).toBe(host.querySelector('[data-composer]'));
    // Nothing focused (the body): a background card must not take it.
    await act(async () => root.render(<div />));
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => root.render(pinned('r-focus-3', true)));
    await arm();
    expect(document.activeElement).toBe(document.body);
    // In the transcript of an inactive pane: not either.
    await act(async () => root.render(<div />));
    await act(async () => root.render(pinned('r-focus-4', false)));
    (host.querySelector('[data-log]') as HTMLElement).focus();
    await arm();
    expect(document.activeElement).toBe(host.querySelector('[data-log]'));
    // In the transcript of the active pane: the default answer takes it.
    await act(async () => root.render(<div />));
    await act(async () => root.render(pinned('r-focus-5', true)));
    (host.querySelector('[data-log]') as HTMLElement).focus();
    await arm();
    expect(document.activeElement?.textContent).toBe('Allow');
    outside.remove();
  });

  it('is answered from the composer: Cmd/Ctrl+Enter allows, Esc denies, neither while a draft is typed', async () => {
    vi.useFakeTimers({ now: 500_000 });
    const onAnswer = vi.fn(async () => true);
    await act(async () => root.render(pinned('r-keys-1', true, onAnswer)));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    const composer = host.querySelector('[data-composer]') as HTMLTextAreaElement;
    const composerKeys = vi.fn();
    composer.addEventListener('keydown', composerKeys);
    // A typed draft keeps both keys: Cmd/Ctrl+Enter sends it, Esc is the composer's.
    composer.value = 'a draft';
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
    // A file staged with no text is a draft too: Cmd/Ctrl+Enter sends it.
    composer.value = '';
    const staged = document.createElement('span');
    staged.setAttribute('data-attachment', '');
    composer.parentElement!.prepend(staged);
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    staged.remove();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(composerKeys).toHaveBeenCalledTimes(4);
    // A key the IME still holds answers nothing.
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, keyCode: 229, bubbles: true })); });
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, bubbles: true })); });
    expect(onAnswer).not.toHaveBeenCalled();
    // From the empty composer the card takes the key, and the composer's own handler never sees it.
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    expect(onAnswer).toHaveBeenCalledWith('r-keys-1', 'allow');
    expect(composerKeys).toHaveBeenCalledTimes(6);

    const onDeny = vi.fn(async () => true);
    await act(async () => root.render(<div />));
    await act(async () => root.render(pinned('r-keys-2', true, onDeny)));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    // Esc in the (empty) find box closes find: it never answers the card.
    const find = host.querySelector('[data-find]') as HTMLInputElement;
    await act(async () => { find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onDeny).not.toHaveBeenCalled();
    const empty = host.querySelector('[data-composer]') as HTMLTextAreaElement;
    await act(async () => { empty.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onDeny).toHaveBeenCalledWith('r-keys-2', 'deny');
  });

  it('never allows a destructive call from a key: Esc denies, Allow takes a click', async () => {
    vi.useFakeTimers({ now: 550_000 });
    const onAnswer = vi.fn(async () => true);
    const block: Block = { id: 'd.1', role: 'tool', text: 'Bash', tool: { callId: 't', title: 'rm -rf dist', kind: 'execute', preview: { kind: 'shell', command: 'rm -rf dist' } }, approval: { requestId: 'r-destructive', requestedAt: 550_000 } };
    await act(async () => root.render(
      <div className="wmux-chatv2">
        <div className="wmux-chatv2-viewport"><div tabIndex={-1} data-log /></div>
        <PinnedApproval block={block} cwd="/repo" active onAnswer={onAnswer} />
        <div className="wmux-chatv2-composer"><textarea className="wmux-chatv2-textarea" data-composer /></div>
      </div>,
    ));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    const card = host.querySelector('[data-chatv2-approval]') as HTMLElement;
    expect(card.querySelector('.wmux-chatv2-card-hint')?.textContent).toBe('Esc to deny');
    for (const from of [host.querySelector('[data-composer]'), host.querySelector('[data-log]'), card]) {
      await act(async () => { (from as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
      await act(async () => { (from as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
    }
    expect(onAnswer).not.toHaveBeenCalled();
    const allow = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Allow') as HTMLButtonElement;
    await act(async () => { allow.click(); });
    expect(onAnswer).toHaveBeenCalledWith('r-destructive', 'allow');
  });

  it('hands focus to the composer after an answer, so the next card is answered from the keyboard too', async () => {
    vi.useFakeTimers({ now: 560_000 });
    const onAnswer = vi.fn(async () => true);
    await act(async () => root.render(pinned('r-row-1', true, onAnswer)));
    (host.querySelector('[data-log]') as HTMLElement).focus();
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    expect(document.activeElement?.textContent).toBe('Allow');
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    expect(onAnswer).toHaveBeenCalledWith('r-row-1', 'allow');
    const composer = host.querySelector('[data-composer]');
    expect(document.activeElement).toBe(composer);
    // The next approval: answered from the (empty) composer without a click.
    await act(async () => root.render(pinned('r-row-2', true, onAnswer)));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    expect(document.activeElement).toBe(composer);
    await act(async () => { composer!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onAnswer).toHaveBeenLastCalledWith('r-row-2', 'deny');
    // An answer whose button already dropped focus to the body brings it back to the composer too.
    await act(async () => root.render(pinned('r-row-3', true, onAnswer)));
    await act(async () => { vi.advanceTimersByTime(CHATV2_ANSWER_ARM_MS); });
    (document.activeElement as HTMLElement | null)?.blur();
    const allow = [...host.querySelectorAll('[data-chatv2-approval] button')].find((button) => button.textContent === 'Allow') as HTMLButtonElement;
    await act(async () => { allow.click(); });
    expect(document.activeElement).toBe(composer);
  });

  it('lets the reader close a fold a find match opened, until another match opens it', async () => {
    const member: TranscriptRow = { kind: 'assistant', key: 'f.2', block: { id: 'f.2', role: 'assistant', text: 'inside the fold' } };
    const row: TranscriptRow = { kind: 'turnFold', key: 'f.1:fold', turnId: 'f.1', model: '', failed: 0, answer: '', rows: [member] };
    const actions: TranscriptActions = { answer: async () => true, body: async () => null };
    const show = (findId: string | null) => root.render(<TranscriptRowView row={row} cwd="/repo" actions={actions} findActive={!!findId} findId={findId} />);
    await act(async () => show('f.2'));
    expect(host.textContent).toContain('inside the fold');
    await act(async () => { (host.querySelector('.wmux-chatv2-turn-toggle') as HTMLButtonElement).click(); });
    expect(host.textContent).not.toContain('inside the fold');
    await act(async () => show('f.2'));
    expect(host.textContent).not.toContain('inside the fold');
    await act(async () => show(null));
    await act(async () => show('f.2'));
    expect(host.textContent).toContain('inside the fold');
  });

  it('shows what a sent message carried: a file as a chip with its name', async () => {
    const block: Block = { id: '9.9', role: 'user', text: 'look', attachments: [{ id: 'a1', name: 'notes.md', mimeType: 'text/markdown', kind: 'image', size: 10, path: '/tmp/notes.md' }] };
    const actions: TranscriptActions = { answer: async () => true, body: async () => null };
    await act(async () => root.render(<TranscriptRowView row={{ kind: 'user', key: block.id, block }} cwd="/repo" actions={actions} findActive={false} />));
    expect(host.querySelector('[data-chatv2-sent-attachments]')?.textContent).toContain('notes.md');
    expect(host.querySelector('.wmux-chatv2-user')?.textContent).toBe('look');
  });
});
