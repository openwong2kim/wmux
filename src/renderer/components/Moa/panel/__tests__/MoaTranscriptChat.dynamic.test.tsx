// @vitest-environment jsdom
//
// Moa's chat look: the HQ brain's transcript (deck.moa.transcript) read by
// the shared useTranscript and drawn by the shared Chat components, with the
// composer routed to the brain send instead of the pane chat bridge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setDeckHeaderSlot } from '../../../Deck/deckHeaderSlot';
import MoaTranscriptChat, { hideMoaWakes, tidyMoaUserText, type MoaApprovalApi, type MoaTranscriptApi } from '../MoaTranscriptChat';
import type { MoaApproval, MoaApprovalAnswerResult } from '../../../../../shared/moa';
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

  it('a prompt the transcript records before the send resolves shows one bubble, not two', async () => {
    const { api, push } = fakeApi();
    let finish: (r: { ok: boolean }) => void = () => undefined;
    const onSend = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { finish = resolve; }));
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={onSend} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    await type('Check the release');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onSend).toHaveBeenCalledWith('Check the release');
    await act(async () => push({ seq: 1, events: [{ id: 'u2', kind: 'user_text', text: 'Check the release', ts: 3 }], cursor: { ...cursor, tailOffset: 150, fileSize: 150 } }));
    await act(async () => finish({ ok: true }));
    expect(host.querySelector('[data-moa-chat-pending]')).toBeNull();
    expect([...host.querySelectorAll('.wmux-chat-user')].filter((n) => n.textContent?.includes('Check the release'))).toHaveLength(1);
  });

  it('tool activity is hidden; while Moa works a header control says so and opens it', async () => {
    const slot = document.createElement('div');
    document.body.append(slot);
    setDeckHeaderSlot(slot);
    try {
      const { api } = fakeApi();
      await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
      const chat = host.querySelector('[data-moa-chat]') as HTMLElement;
      expect(chat.dataset.activity).toBe('hidden');
      const toggle = slot.querySelector('[data-moa-working-toggle]') as HTMLButtonElement;
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.dataset.busy).toBe('true');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe('moa.panel.activityShow');
      await act(async () => { toggle.click(); });
      expect(chat.dataset.activity).toBe('shown');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      // Idle and collapsed: the control goes away.
      await act(async () => { toggle.click(); });
      await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
      expect(slot.querySelector('[data-moa-working-toggle]')).toBeNull();
    } finally {
      setDeckHeaderSlot(null);
      slot.remove();
    }
  });

  it('with Moa idle, folded activity can still be opened, labelled as activity (not as working); failed calls fold with it', async () => {
    const slot = document.createElement('div');
    document.body.append(slot);
    setDeckHeaderSlot(slot);
    try {
      const evs: TurnEvent[] = [
        { id: 'u1', kind: 'user_text', text: 'Go', ts: 1 },
        { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a', ts: 2 } as unknown as TurnEvent,
        { id: 'r1', kind: 'tool_result', toolUseId: 'x1', ok: true, ts: 3 } as unknown as TurnEvent,
        { id: 'a1', kind: 'assistant_text', text: 'Done.', ts: 4, turnComplete: true },
      ];
      const { api } = fakeApi({ snapshot: vi.fn(async () => ({ events: evs, cursor, hasMore: false, truncatedHead: false })) as never });
      await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
      const toggle = slot.querySelector('[data-moa-working-toggle]') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      expect(toggle.dataset.busy).toBeUndefined();
      expect(toggle.getAttribute('aria-label')).toBe('moa.panel.activityShowIdle');
      await act(async () => { toggle.click(); });
      expect((host.querySelector('[data-moa-chat]') as HTMLElement).dataset.activity).toBe('shown');
    } finally {
      setDeckHeaderSlot(null);
      slot.remove();
    }
    // The hide rule covers the fold, the working line and a failed tool row
    // (Moa's own retry): the operator reads replies, not tool errors.
    const css = readFileSync(path.join(__dirname, '../../moa.css'), 'utf8');
    const rule = css.slice(css.indexOf('[data-moa-chat][data-activity="hidden"]'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('.wmux-chat-tool');
  });

  it('an empty result answer (a transient miss) is asked again instead of remembered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { api } = fakeApi();
      const link = { id: 'l2', origin: 'moa', title: 'Retry me', a2aTaskId: 't2', owner: { workspaceId: 'ws-w' }, state: 'done', decisionIds: [], createdAt: 1, updatedAt: 1.5 };
      const linksApi = { list: vi.fn(async () => [link]), onChanged: vi.fn(() => () => undefined) };
      const taskResult = vi.fn()
        .mockResolvedValueOnce({ result: null })
        .mockResolvedValue({ result: { summary: 'second time lucky', verified: 0, checks: 1 } });
      await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} linksApi={linksApi as never} resultApi={{ taskResult }} />));
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
      expect(host.querySelector('[data-moa-result-card="l2"] [data-moa-result-summary]')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(3_000); });
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
      expect(taskResult).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-moa-result-card="l2"] [data-moa-result-summary]')?.textContent).toBe('second time lucky');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delegated task that finished, before Moa closed the work, shows its report card where it finished: not checked by Moa, the agent\'s words folded', async () => {
    const { api } = fakeApi();
    const link = {
      id: 'l1', origin: 'moa', title: 'Add subtract to math.js', a2aTaskId: 't1', owner: { workspaceId: 'ws-w', paneId: 'p1' },
      state: 'done', decisionIds: [], createdAt: 1, updatedAt: 1.5,
    };
    const linksApi = { list: vi.fn(async () => [link]), onChanged: vi.fn(() => () => undefined) };
    const resultApi = { taskResult: vi.fn(async () => ({ result: { summary: 'subtract() added', verified: 1, checks: 2, files: ['math.js'] } })) };
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} linksApi={linksApi as never} resultApi={resultApi} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const card = host.querySelector('[data-moa-result-card="l1"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(resultApi.taskResult).toHaveBeenCalledWith({ workspaceId: 'ws-w', taskId: 't1' });
    const report = card.closest('[data-moa-report]') as HTMLElement;
    expect(report.querySelector('[data-moa-report-title]')?.textContent).toBe('Add subtract to math.js');
    expect(report.querySelector('[data-moa-report-checked]')?.getAttribute('data-moa-report-checked')).toBe('agent');
    // The agent's own words: folded, rendered as text (markdown), not raw.
    const details = card.querySelector('[data-moa-result-details]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(card.querySelector('[data-moa-result-summary]')?.textContent).toBe('subtract() added');
    expect(card.querySelector('[data-moa-result-files]')?.textContent).toBe('math.js');
    expect(card.querySelector('[data-moa-result-open]')?.textContent).toBe('moa.panel.openPane');
    expect(host.textContent).not.toContain('moa.result.checks');
    // Placed by time: after the user row (ts 1), before the reply (ts 2).
    const order = [...host.querySelectorAll('.wmux-chat-user, [data-moa-result-card], .wmux-chat-assistant')].map((n) => n.matches('[data-moa-result-card]') ? 'card' : n.matches('.wmux-chat-user') ? 'user' : 'reply');
    expect(order).toEqual(['user', 'card', 'reply']);
  });

  it('Moa\'s own decision and fan-out calls read as purpose cards outside the activity fold, waiting state from Waiting on you', async () => {
    const callEvents: TurnEvent[] = [
      { id: 'u1', kind: 'user_text', text: 'Ship it', ts: 1 },
      { id: 'c1', kind: 'tool_use', toolUseId: 'tu1', name: 'mcp__wmux__deck_ask_decision', argSummary: 'x', input: { n: 1, bytes: 10, inline: '{"question":"Ship to main?","context":"CI is red on one flaky test"}' }, ts: 2 } as unknown as TurnEvent,
      { id: 'r1', kind: 'tool_result', toolUseId: 'tu1', ok: true, bytes: 10, output: { n: 1, bytes: 10, inline: '{"ok":true,"id":"d1"}' }, ts: 3 } as unknown as TurnEvent,
      { id: 'c2', kind: 'tool_use', toolUseId: 'tu2', name: 'mcp__wmux__fanout_start', argSummary: 'x', input: { n: 1, bytes: 10, inline: '{"titles":["lint","tests"]}' }, ts: 4 } as unknown as TurnEvent,
      { id: 'c3', kind: 'tool_use', toolUseId: 'tu3', name: 'mcp__wmux__pane_list', argSummary: 'x', input: { n: 1, bytes: 2, inline: '{}' }, ts: 5 } as unknown as TurnEvent,
    ];
    const { api } = fakeApi({ snapshot: vi.fn(async () => ({ events: callEvents, cursor, hasMore: false, truncatedHead: false })) as never });
    const decisionsApi = { decisions: vi.fn(async () => ({ decisions: [{ workspaceId: 'ws-hq', decision: { id: 'd1', question: 'Ship to main?', options: [], context: '', raisedAt: 2 } }] })), onChanged: vi.fn(() => () => undefined) };
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} decisionsApi={decisionsApi as never} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const decision = host.querySelector('[data-moa-purpose="decision"]') as HTMLElement;
    expect(decision).not.toBeNull();
    expect(decision.closest('.wmux-chat-activity')).toBeNull();
    expect(decision.textContent).toContain('Ship to main?');
    expect(decision.textContent).toContain('CI is red on one flaky test');
    expect(decision.querySelector('[data-moa-purpose-waiting]')).not.toBeNull();
    expect(decision.querySelector('[data-moa-purpose-raw] pre')?.textContent).toContain('"question"');
    const fanout = host.querySelector('[data-moa-purpose="fanout"]') as HTMLElement;
    expect([...fanout.querySelectorAll('[data-moa-purpose-tasks] li')].map((li) => li.textContent)).toEqual(['lint', 'tests']);
    // Ordinary tool calls stay in the (hidden) activity.
    expect(host.querySelectorAll('[data-moa-purpose]')).toHaveLength(2);
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

describe('MoaTranscriptChat — Moa\'s own permission prompt (#1772)', () => {
  const RECORD: MoaApproval = {
    id: 'ap-1', toolName: 'Bash', summary: 'rm -rf build', question: 'Do you want to proceed?',
    choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], promptFingerprint: 'f'.repeat(32),
    answerable: true, answered: false, createdAt: 1,
  };
  const awaiting = () => fakeApi({ status: vi.fn(async () => ({ available: true, reason: 'ok', agentSessionId: 's1', agentStatus: 'awaiting_input' })) as never });
  function prompts(record: MoaApproval | null, answers: MoaApprovalAnswerResult[] = [{ ok: true }]) {
    let current = record;
    let changed: (() => void) | null = null;
    const api = {
      approval: vi.fn(async () => ({ approval: current })),
      approvalAnswer: vi.fn(async () => answers.shift() ?? { ok: true }),
      onChanged: vi.fn((cb: () => void) => { changed = cb; return () => { changed = null; }; }),
    } as unknown as MoaApprovalApi & { approvalAnswer: ReturnType<typeof vi.fn> };
    return { api, set: (next: MoaApproval | null) => { current = next; changed?.(); } };
  }
  const render = async (approvalApi: MoaApprovalApi) => {
    const { api } = awaiting();
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} approvalApi={approvalApi} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const row = () => host.querySelector('[data-moa-chat-terminal-hint]') as HTMLElement | null;
  const choice = (key: string) => host.querySelector(`[data-moa-chat-approval-choice="${key}"]`) as HTMLButtonElement | null;

  it('shows the record\'s question, summary and choices, and still offers the terminal', async () => {
    const { api } = prompts(RECORD);
    await render(api);
    expect(row()?.textContent).toContain('Do you want to proceed?');
    expect(host.querySelector('[data-moa-chat-approval-summary]')?.textContent).toBe('rm -rf build');
    expect(choice('1')?.textContent).toBe('Yes');
    expect(choice('2')?.textContent).toBe('No');
    expect(host.querySelector('[data-moa-chat-answer-in-terminal]')).not.toBeNull();
  });

  it('a click answers with the record\'s id and fingerprint', async () => {
    const { api } = prompts(RECORD);
    await render(api);
    await act(async () => { choice('2')!.click(); });
    expect(api.approvalAnswer).toHaveBeenCalledWith({ approvalId: 'ap-1', choiceKey: '2', promptFingerprint: 'f'.repeat(32) });
    expect(host.querySelector('[data-moa-chat-approval-notice]')).toBeNull();
  });

  it('answered elsewhere (not_pending) leaves quietly; too soon asks for a retry; anything else is an error', async () => {
    const { api } = prompts(RECORD, [
      { ok: false, code: 'not_pending' },
      { ok: false, code: 'answer_too_soon' },
      { ok: false, code: 'error', reason: 'prompt-changed' },
    ]);
    await render(api);
    await act(async () => { choice('1')!.click(); });
    expect(host.querySelector('[data-moa-chat-approval-notice]')).toBeNull();
    await act(async () => { choice('1')!.click(); });
    expect(host.querySelector('[data-moa-chat-approval-notice]')?.getAttribute('data-moa-chat-approval-notice')).toBe('retry');
    await act(async () => { choice('1')!.click(); });
    expect(host.querySelector('[data-moa-chat-approval-notice]')?.getAttribute('data-moa-chat-approval-notice')).toBe('error');
  });

  it('an unanswerable or already answered record shows no choices; main\'s change signal re-reads it', async () => {
    const { api, set } = prompts({ ...RECORD, answerable: false });
    await render(api);
    expect(row()?.textContent).toContain('Do you want to proceed?');
    expect(choice('1')).toBeNull();
    await act(async () => { set({ ...RECORD, answerable: false, answered: true }); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector('[data-moa-chat-approval-answered]')).not.toBeNull();
    await act(async () => { set(null); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector('[data-moa-chat-approval]')).toBeNull();
    // Still awaiting per the transcript status: the plain terminal hint.
    expect(row()?.textContent).toContain('moa.panel.terminalHint');
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
  it('wake prompts main types for Moa never draw as the operator\'s bubble; the operator\'s own words do', () => {
    const shown = hideMoaWakes([
      { id: 'w1', kind: 'user_text', text: '[pane-events] (UNTRUSTED terminal/A2A signals)\n  seq=1 ...\nwork-request: ACTIVE — this wake belongs to a direct human request', ts: 1 },
      { id: 'w2', kind: 'user_text', text: 'The operator DISMISSED the decision you raised as not needed.', ts: 2 },
      { id: 'h1', kind: 'user_text', text: 'Tell wmux to start the Fleet revamp', ts: 3 },
      { id: 'h2', kind: 'user_text', text: 'Why did [pane-events] show up?', ts: 4 },
    ]);
    expect(shown.map((e) => e.kind)).toEqual(['meta', 'meta', 'user_text', 'user_text']);
    expect(shown[0]).toMatchObject({ id: 'moa-wake:w1', subtype: 'turn_started', label: '' });
  });

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

// The sequence from a real run (2026-10-05): a cross-workspace request, a
// refused direct send, a hand-off, a wake, Moa checking the file, the
// delegation finishing, and Moa closing the work with its final reply.
const RUN_LINK = {
  id: 'l1', origin: 'moa', title: 'math.js에 빼기 함수 추가', a2aTaskId: 't-run', owner: { workspaceId: 'ws-demo', paneId: 'p1' },
  state: 'done', decisionIds: [], createdAt: 1, updatedAt: 11.5,
};
const tool = (id: string, toolUseId: string, name: string, inline: string, ts: number) =>
  ({ id, kind: 'tool_use', toolUseId, name, argSummary: name, input: { n: 1, bytes: inline.length, inline }, ts }) as unknown as TurnEvent;
const toolResult = (id: string, toolUseId: string, ok: boolean, inline: string, ts: number) =>
  ({ id, kind: 'tool_result', toolUseId, ok, bytes: inline.length, output: { n: 1, bytes: inline.length, inline }, ts }) as unknown as TurnEvent;
const RUN: TurnEvent[] = [
  { id: 'u1', kind: 'user_text', text: 'math.js에 빼기 함수 추가해줘', ts: 1 },
  tool('t1', 'x1', 'mcp__wmux__terminal_send', '{}', 2),
  toolResult('r1', 'x1', false, 'cross-workspace send refused', 3),
  { id: 'a1', kind: 'assistant_text', text: 'Proposing the handoff to the agent in the other workspace, since direct send was refused.', ts: 4 },
  tool('t2', 'x2', 'mcp__wmux__moa_propose_handoff', '{"title":"math.js에 빼기 함수 추가"}', 5),
  toolResult('r2', 'x2', true, '{"ok":true,"id":"h1"}', 6),
  { id: 'a2', kind: 'assistant_text', text: '승인 카드를 올렸습니다.', ts: 7, turnComplete: true },
  { id: 'w1', kind: 'user_text', text: '[pane-events] stop', ts: 8 },
  { id: 'a3', kind: 'assistant_text', text: "I have the checkout path, so I'll read math.js directly.", ts: 9 },
  tool('t3', 'x3', 'Read', '{}', 10),
  toolResult('r3', 'x3', true, 'export function subtract', 10.5),
  { id: 'a4', kind: 'assistant_text', text: 'Verified: subtract exists. Closing the task and the work.', ts: 11 },
  tool('t4', 'x4', 'mcp__wmux__deck_complete_work', '{"summary":"math.js에 subtract(a,b)를 추가함","verification":"math.js 2행을 직접 읽어 확인"}', 12),
  toolResult('r4', 'x4', true, '{"ok":true}', 12.5),
  { id: 'a5', kind: 'assistant_text', text: 'math.js에 `subtract(a,b)`를 추가했습니다.', ts: 13, turnComplete: true },
];

describe('MoaTranscriptChat — one job, one report', () => {
  async function renderRun() {
    const { api } = fakeApi({ snapshot: vi.fn(async () => ({ events: RUN, cursor, hasMore: false, truncatedHead: false })) as never });
    const linksApi = { list: vi.fn(async () => [RUN_LINK]), onChanged: vi.fn(() => () => undefined) };
    const resultApi = { taskResult: vi.fn(async () => ({ result: { summary: '**✓ 완료**\n\n| 항목 | 내용 |\n|---|---|\n| math.js | subtract 추가 |', verified: 0, checks: 1, files: ['math.js'] } })) };
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} linksApi={linksApi as never} resultApi={resultApi} />));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  const visibleReplies = () => [...host.querySelectorAll('.wmux-chat-assistant .wmux-chat-prose')]
    .filter((n) => !n.closest('.wmux-chat-activity') && !n.closest('.wmux-chat-thinking'))
    .map((n) => n.textContent);

  it('the turn that closed the work draws ONE report: Moa\'s reply, what Moa checked, the agent\'s report folded, a jump', async () => {
    await renderRun();
    const reports = host.querySelectorAll('[data-moa-report]');
    expect(reports).toHaveLength(1);
    const report = reports[0] as HTMLElement;
    expect(report.querySelector('[data-moa-report-reply]')?.textContent).toContain('subtract(a,b)');
    const checked = report.querySelector('[data-moa-report-checked]') as HTMLElement;
    expect(checked.dataset.moaReportChecked).toBe('moa');
    expect(checked.textContent).toBe('moa.report.checked');
    // The delegation's result lives inside the report, never as a card of its own.
    expect(host.querySelectorAll('[data-moa-result-card]')).toHaveLength(1);
    expect(report.querySelector('[data-moa-result-card="l1"]')).not.toBeNull();
    // Its markdown is rendered (a table), not shown as raw pipes.
    expect(report.querySelector('[data-moa-result-summary] table')).not.toBeNull();
    expect(report.querySelector('[data-moa-result-summary]')?.textContent).not.toContain('|');
    expect(report.querySelector('[data-moa-result-open]')).not.toBeNull();
    // No separate "Work completed" card, and the reply is not drawn twice.
    expect(host.querySelector('[data-moa-purpose="complete"]')).toBeNull();
    expect(visibleReplies().filter((t) => t?.includes('subtract(a,b)'))).toHaveLength(0);
  });

  it('only each turn\'s final reply reads as a message; narration and failed calls fold into the activity', async () => {
    await renderRun();
    expect(visibleReplies()).toEqual(['승인 카드를 올렸습니다.']);
    for (const line of ['Proposing the handoff', 'checkout path', 'Closing the task']) {
      const at = [...host.querySelectorAll('.wmux-chat-thinking')].find((n) => n.textContent?.includes(line));
      expect(at?.closest('.wmux-chat-activity'), line).not.toBeNull();
    }
    // The refused send is a tool row (hidden with the activity by moa.css), and
    // the hand-off that went through keeps its card.
    const failed = [...host.querySelectorAll('.wmux-chat-tool')].find((n) => n.textContent?.includes('mcp__wmux__terminal_send'));
    expect(failed).toBeDefined();
    expect(host.querySelectorAll('[data-moa-purpose="handoff"]')).toHaveLength(1);
  });

  it('a call of Moa\'s own that did not go through shows only with the activity', async () => {
    const slot = document.createElement('div');
    document.body.append(slot);
    setDeckHeaderSlot(slot);
    try {
      const evs: TurnEvent[] = [
        { id: 'u1', kind: 'user_text', text: 'Go', ts: 1 },
        tool('t1', 'x1', 'mcp__wmux__moa_propose_handoff', '{"title":"x"}', 2),
        toolResult('r1', 'x1', false, 'missing body', 3),
        { id: 'a1', kind: 'assistant_text', text: 'Proposed.', ts: 4, turnComplete: true },
      ];
      const { api } = fakeApi({ snapshot: vi.fn(async () => ({ events: evs, cursor, hasMore: false, truncatedHead: false })) as never });
      await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
      expect(host.querySelector('[data-moa-purpose-failed]')).toBeNull();
      await act(async () => { (slot.querySelector('[data-moa-working-toggle]') as HTMLButtonElement).click(); });
      expect(host.querySelector('[data-moa-purpose-failed]')).not.toBeNull();
    } finally {
      setDeckHeaderSlot(null);
      slot.remove();
    }
  });
});

describe('MoaTranscriptChat — send feedback and the first screen', () => {
  it('the operator\'s bubble shows the moment they send, before the brain\'s transcript records it', async () => {
    const { api } = fakeApi();
    const onSend = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={onSend} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    await type('Check the release');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(host.querySelector('[data-moa-chat-pending]')?.textContent).toContain('Check the release');
  });

  it('a send Moa refuses takes its bubble back', async () => {
    const { api } = fakeApi();
    const onSend = vi.fn(async () => ({ ok: false }));
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={onSend} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    await type('Check the release');
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector('[data-moa-chat-pending]')).toBeNull();
  });

  it('pages back on its own until the operator\'s first message is in view, and stops at a bound', async () => {
    const tail: TurnEvent[] = [{ id: 'a9', kind: 'assistant_text', text: 'Done.', ts: 9, turnComplete: true }];
    const head: TurnEvent[] = [{ id: 'u1', kind: 'user_text', text: 'Add subtract', ts: 1 }];
    const snapshot = vi.fn(async (opts?: { before?: number }) => (opts?.before === undefined
      ? { events: tail, cursor: { ...cursor, headOffset: 50 }, hasMore: true, truncatedHead: false }
      : { events: head, cursor: { ...cursor, headOffset: 0 }, hasMore: false, truncatedHead: false }));
    const { api } = fakeApi({ snapshot: snapshot as never });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(snapshot).toHaveBeenCalledWith({ before: 50 });
    expect(host.querySelector('.wmux-chat-user')?.textContent).toContain('Add subtract');

    // A transcript with no operator message at all is not read to its start.
    act(() => root.unmount());
    root = createRoot(host);
    let head2 = 1000;
    const endless = vi.fn(async () => ({ events: [{ id: `a${head2}`, kind: 'assistant_text', text: 'x', ts: head2 }], cursor: { ...cursor, headOffset: head2-- }, hasMore: true, truncatedHead: false }));
    const { api: api2 } = fakeApi({ snapshot: endless as never });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq2" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api2} />));
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(endless.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('a brain whose transcript holds only main\'s own wake prompts shows the first-run guidance', async () => {
    const evs: TurnEvent[] = [{ id: 'w1', kind: 'user_text', text: '[fleet-snapshot] nothing yet', ts: 1 }];
    const { api } = fakeApi({ snapshot: vi.fn(async () => ({ events: evs, cursor, hasMore: false, truncatedHead: false })) as never });
    await act(async () => root.render(<MoaTranscriptChat ptyId="pty-hq" busy={false} onSend={vi.fn()} onInterrupt={vi.fn()} onTerminal={vi.fn()} api={api} />));
    const empty = host.querySelector('[data-moa-chat-empty]');
    expect(empty?.textContent).toContain('moa.panel.chatEmptyHint');
  });
});
