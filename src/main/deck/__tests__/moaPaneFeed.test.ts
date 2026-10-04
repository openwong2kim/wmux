/**
 * The Moa pane feed (main → daemon): what is pushed, when, which hook payloads
 * it trusts, and that a withdrawal is retried until the daemon took it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  __resetMoaPaneFeedForTest,
  buildMoaPanePayload,
  claudeProjectSlug,
  forgetBrainPty,
  noteBrainHookSignal,
  publishMoaPane,
  setMoaPanePush,
  setMoaPaneSource,
  type BrainHookSignal,
  type MoaPanePayload,
  type MoaPaneSource,
} from '../moaPaneFeed';

// Native paths: the check reads them with the platform's path rules, and a
// Windows brain reports Windows paths.
const HOME = path.resolve(path.sep, 'Users', 'u');
const BRAIN_CWD = path.join(HOME, '.wmux', 'brains', 'ws-hq');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const PROJECT = path.join(PROJECTS, claudeProjectSlug(BRAIN_CWD));
const conv = (name: string) => path.join(PROJECT, `${name}.jsonl`);
const HQ: MoaPaneSource = { sessionId: 'brain-1', workspaceId: 'ws-hq', brainCwd: BRAIN_CWD };

let pushes: Array<{ pane: MoaPanePayload; seq: number }>;
let current: MoaPaneSource | null;

const signal = (over: Partial<BrainHookSignal> = {}): BrainHookSignal => ({
  kind: 'agent.stop', agent: 'claude', agentSessionId: 'conv-1', ptyId: 'brain-1', cwd: BRAIN_CWD,
  payload: { transcript_path: conv('conv-1') }, ts: 10, ...over,
});
const bindingOf = () => (buildMoaPanePayload() as { binding?: Record<string, unknown> } | null)?.binding;
const dialogOf = () => (buildMoaPanePayload() as { dialog?: { fingerprint: string } } | null)?.dialog;

beforeEach(() => {
  __resetMoaPaneFeedForTest();
  pushes = [];
  current = null;
  setMoaPaneSource(() => current);
  setMoaPanePush(async (pane, seq) => { pushes.push({ pane, seq }); return { ok: true, applied: true, seq }; });
});
afterEach(() => {
  vi.useRealTimers();
  __resetMoaPaneFeedForTest();
});

describe('moaPaneFeed', () => {
  it('pushes the pane, then null the moment the source withdraws it, with rising seq; never the brain cwd', async () => {
    current = HQ;
    await publishMoaPane();
    current = null;
    await publishMoaPane();
    expect(pushes).toEqual([
      { pane: { sessionId: 'brain-1', workspaceId: 'ws-hq' }, seq: 1 },
      { pane: null, seq: 2 },
    ]);
  });

  it('does not re-send an unchanged answer, except when forced (a new daemon connection)', async () => {
    current = HQ;
    await publishMoaPane();
    await publishMoaPane();
    expect(pushes).toHaveLength(1);
    await publishMoaPane({ force: true });
    expect(pushes.map((p) => p.seq)).toEqual([1, 2]);
  });

  it('carries the transcript binding the brain\'s own Stop reported, and re-publishes when it lands', async () => {
    current = HQ;
    await publishMoaPane();
    noteBrainHookSignal(signal());
    await publishMoaPane(); // joins the publish the signal started
    expect(pushes.at(-1)!.pane).toEqual({
      sessionId: 'brain-1', workspaceId: 'ws-hq',
      binding: { agent: 'claude', sessionId: 'conv-1', cwd: BRAIN_CWD, transcriptPath: conv('conv-1'), ts: 10 },
    });
  });

  it('keeps the path through a later SessionStart of the same conversation without one', () => {
    current = HQ;
    noteBrainHookSignal(signal());
    noteBrainHookSignal(signal({ kind: 'agent.session_start', payload: {}, ts: 20 }));
    expect(bindingOf()).toMatchObject({ transcriptPath: conv('conv-1'), ts: 20 });
  });

  it('a late Stop from the conversation a /clear left behind does not replace the new one', () => {
    current = HQ;
    noteBrainHookSignal(signal({ ts: 10 }));
    // /clear: a new conversation starts...
    noteBrainHookSignal(signal({ kind: 'agent.session_start', agentSessionId: 'conv-2', payload: { transcript_path: conv('conv-2') }, ts: 30 }));
    // ...and the old one's Stop arrives late.
    noteBrainHookSignal(signal({ ts: 20 }));
    expect(bindingOf()).toMatchObject({ sessionId: 'conv-2', transcriptPath: conv('conv-2'), ts: 30 });
  });

  it('drops a forged binding: another cwd, a path outside the brain\'s project, or a file that is not the conversation', () => {
    current = HQ;
    for (const forged of [
      signal({ cwd: path.join(HOME, 'elsewhere') }),
      signal({ payload: { transcript_path: path.join(PROJECTS, claudeProjectSlug(path.join(HOME, 'elsewhere')), 'conv-1.jsonl') } }),
      signal({ payload: { transcript_path: conv('other-conv') } }),
      signal({ payload: { transcript_path: path.join(HOME, 'passwd') } }),
      signal({ payload: { transcript_path: [PROJECT, '..', claudeProjectSlug(BRAIN_CWD), 'conv-1.jsonl'].join(path.sep) } }),
      signal({ payload: { transcript_path: path.join(HOME, 'notprojects', claudeProjectSlug(BRAIN_CWD), 'conv-1.jsonl') } }),
      signal({ payload: { transcript_path: 'conv-1.jsonl' } }),
    ]) {
      __resetMoaPaneFeedForTest();
      setMoaPaneSource(() => current);
      noteBrainHookSignal(forged);
      expect(bindingOf()).toBeUndefined();
    }
  });

  it('ignores signals that carry no conversation, and another brain\'s binding never rides on the HQ pane', () => {
    current = HQ;
    noteBrainHookSignal(signal({ kind: 'agent.tool_started' }));
    noteBrainHookSignal(signal({ agentSessionId: undefined }));
    noteBrainHookSignal(signal({ ptyId: 'brain-2' }));
    expect(buildMoaPanePayload()).toEqual({ sessionId: 'brain-1', workspaceId: 'ws-hq' });
  });

  it('flags the brain\'s permission dialog with its fingerprint and hook evidence, and clears it when the turn moves on', async () => {
    current = HQ;
    noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -r build' },
      tool_use_id: 'toolu_1', session_id: 'conv-1', prompt_id: 'p-1', transcript_path: '/not/pushed.jsonl',
    } }));
    const dialog = dialogOf();
    expect(dialog?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // The same fields HookIngest reads (payload.session_id etc.), nothing else.
    expect(dialog).toEqual({
      fingerprint: dialog?.fingerprint, toolName: 'Bash', toolInput: { command: 'rm -r build' },
      toolUseId: 'toolu_1', hookSessionId: 'conv-1', promptId: 'p-1',
    });
    await publishMoaPane();
    expect(pushes.at(-1)!.pane).toMatchObject({ dialog });
    for (const kind of ['agent.stop', 'agent.user_prompt_submit', 'agent.session_start', 'agent.stop_failure']) {
      noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: { tool_name: 'Bash' } }));
      expect(dialogOf()).toBeDefined();
      noteBrainHookSignal(signal({ kind, payload: {} }));
      expect(dialogOf()).toBeUndefined();
    }
  });

  it('omits a tool input over 8 KB whole — never cut — and keeps the dialog', () => {
    current = HQ;
    const big = { command: 'x'.repeat(9000) };
    noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: { tool_name: 'Bash', tool_input: big, session_id: 'conv-1' } }));
    const dialog = dialogOf() as Record<string, unknown> | undefined;
    expect(dialog?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(dialog).not.toHaveProperty('toolInput');
    expect(dialog).toMatchObject({ toolName: 'Bash', hookSessionId: 'conv-1' });
    // Just under the cap is sent whole.
    const fits = { command: 'y'.repeat(8 * 1024 - 20) };
    noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: { tool_name: 'Bash', tool_input: fits } }));
    expect((dialogOf() as { toolInput?: unknown }).toolInput).toEqual(fits);
  });

  it('a PostToolUse (agent.activity) clears the dialog and its evidence', () => {
    current = HQ;
    noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }));
    expect(dialogOf()).toBeDefined();
    noteBrainHookSignal(signal({ kind: 'agent.activity', payload: {} }));
    expect(buildMoaPanePayload()).not.toHaveProperty('dialog');
  });

  it('drops a brain\'s binding and dialog once its pty is gone', () => {
    current = HQ;
    noteBrainHookSignal(signal());
    noteBrainHookSignal(signal({ kind: 'agent.awaiting_input', payload: {} }));
    forgetBrainPty('brain-1');
    expect(buildMoaPanePayload()).toEqual({ sessionId: 'brain-1', workspaceId: 'ws-hq' });
  });

  it('treats a throwing source as no Moa pane', () => {
    setMoaPaneSource(() => { throw new Error('store'); });
    expect(buildMoaPanePayload()).toBeNull();
  });

  it('retries a withdrawal the daemon refused or never answered until it is applied', async () => {
    vi.useFakeTimers();
    current = HQ;
    await publishMoaPane();
    let answers: unknown[] = [{ ok: false, error: 'busy' }, new Error('pipe closed'), { ok: true, applied: true }];
    setMoaPanePush(async (pane, seq) => {
      pushes.push({ pane, seq });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    current = null;
    await publishMoaPane();
    expect(pushes.at(-1)!.pane).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1100);
    const nulls = pushes.filter((p) => p.pane === null);
    expect(nulls).toHaveLength(3);
    // Applied: no more retries.
    answers = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushes.filter((p) => p.pane === null)).toHaveLength(3);
    expect(nulls.map((p) => p.seq)).toEqual([...nulls.map((p) => p.seq)].sort((a, b) => a - b));
  });
});
