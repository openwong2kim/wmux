/**
 * The Moa pane feed (main → daemon): what is pushed, when, and that a
 * withdrawal is sent at once rather than deduplicated away.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetMoaPaneFeedForTest,
  buildMoaPanePayload,
  forgetBrainPty,
  noteBrainHookSignal,
  publishMoaPane,
  setMoaPanePush,
  setMoaPaneSource,
  type BrainHookSignal,
  type MoaPanePayload,
  type MoaPaneSource,
} from '../moaPaneFeed';

let pushes: Array<{ pane: MoaPanePayload; seq: number }>;
let current: MoaPaneSource | null;

const signal = (over: Partial<BrainHookSignal> = {}): BrainHookSignal => ({
  kind: 'agent.stop', agent: 'claude', agentSessionId: 'conv-1', ptyId: 'brain-1', cwd: '/brains/hq',
  payload: { transcript_path: '/h/.claude/projects/p/conv-1.jsonl' }, ts: 10, ...over,
});

beforeEach(() => {
  __resetMoaPaneFeedForTest();
  pushes = [];
  current = null;
  setMoaPaneSource(() => current);
  setMoaPanePush(async (pane, seq) => { pushes.push({ pane, seq }); });
});

describe('moaPaneFeed', () => {
  it('pushes the pane, then null the moment the source withdraws it, with rising seq', async () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    await publishMoaPane();
    current = null;
    await publishMoaPane();
    expect(pushes).toEqual([
      { pane: { sessionId: 'brain-1', workspaceId: 'hq' }, seq: 1 },
      { pane: null, seq: 2 },
    ]);
  });

  it('does not re-send an unchanged answer, except when forced (a new daemon connection)', async () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    await publishMoaPane();
    await publishMoaPane();
    expect(pushes).toHaveLength(1);
    await publishMoaPane({ force: true });
    expect(pushes.map((p) => p.seq)).toEqual([1, 2]);
  });

  it('carries the transcript binding the brain\'s own Stop reported, and re-publishes when it lands', async () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    await publishMoaPane();
    noteBrainHookSignal(signal());
    await publishMoaPane(); // joins the publish the signal started
    expect(pushes.at(-1)!.pane).toEqual({
      sessionId: 'brain-1', workspaceId: 'hq',
      binding: { agent: 'claude', sessionId: 'conv-1', cwd: '/brains/hq', transcriptPath: '/h/.claude/projects/p/conv-1.jsonl', ts: 10 },
    });
  });

  it('keeps the path through a later SessionStart of the same conversation without one', () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    noteBrainHookSignal(signal());
    noteBrainHookSignal(signal({ kind: 'agent.session_start', payload: {}, ts: 20 }));
    expect((buildMoaPanePayload() as { binding?: { transcriptPath?: string; ts: number } }).binding)
      .toMatchObject({ transcriptPath: '/h/.claude/projects/p/conv-1.jsonl', ts: 20 });
  });

  it('ignores signals that carry no conversation, and another brain\'s binding never rides on the HQ pane', () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    noteBrainHookSignal(signal({ kind: 'agent.tool_started' }));
    noteBrainHookSignal(signal({ agentSessionId: undefined }));
    noteBrainHookSignal(signal({ ptyId: 'brain-2' }));
    expect(buildMoaPanePayload()).toEqual({ sessionId: 'brain-1', workspaceId: 'hq' });
  });

  it('drops a brain\'s binding once its pty is gone', () => {
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    noteBrainHookSignal(signal());
    forgetBrainPty('brain-1');
    expect(buildMoaPanePayload()).toEqual({ sessionId: 'brain-1', workspaceId: 'hq' });
  });

  it('treats a throwing source as no Moa pane, and retries a failed push on the next call', async () => {
    setMoaPaneSource(() => { throw new Error('store'); });
    expect(buildMoaPanePayload()).toBeNull();
    current = { sessionId: 'brain-1', workspaceId: 'hq' };
    setMoaPaneSource(() => current);
    let fail = true;
    setMoaPanePush(async (pane, seq) => {
      if (fail) throw new Error('down');
      pushes.push({ pane, seq });
    });
    await publishMoaPane();
    fail = false;
    await publishMoaPane();
    expect(pushes).toEqual([{ pane: { sessionId: 'brain-1', workspaceId: 'hq' }, seq: 2 }]);
  });
});
