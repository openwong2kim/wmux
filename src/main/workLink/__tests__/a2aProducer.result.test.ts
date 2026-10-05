import { describe, expect, it, vi } from 'vitest';
import { recordTaskState } from '../a2aProducer';
import { parseWorkLink, workLinkResultFromTask, WORK_LINK_LIMITS } from '../../../shared/workLink';
import type { WorkLinkStore } from '../workLinkStore';

function fakeStore() {
  const upsert = vi.fn(async (_input: Record<string, unknown>) => null);
  return { store: { upsert } as unknown as WorkLinkStore, upsert };
}

const evidence = {
  summary: 'Redirect fixed; e2e passes.',
  items: [
    { kind: 'command', status: 'passed', summary: 'unit', command: 'npm test' },
    { kind: 'command', status: 'failed', summary: 'lint', command: 'npm run lint' },
  ],
};

describe('recordTaskState — the final report is kept on the link', () => {
  it('copies the result when the task completes, from the committed task', async () => {
    const { store, upsert } = fakeStore();
    await recordTaskState('task-1', 'completed', store, { id: 'task-1', status: { state: 'completed', evidence } });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      a2aTaskId: 'task-1',
      a2aState: 'completed',
      result: expect.objectContaining({ summary: 'Redirect fixed; e2e passes.', verification: '1/2' }),
    }));
  });

  it('copies a failure reason, and from a plain update ({ status } with a string message)', async () => {
    const { store, upsert } = fakeStore();
    await recordTaskState('task-1', 'failed', store, { status: { state: 'failed', message: 'Build broke on CI.' } });
    expect(upsert.mock.calls[0][0]).toMatchObject({ result: { summary: 'Build broke on CI.' } });
  });

  it('writes no result for a non-final state or a report with no text', async () => {
    const { store, upsert } = fakeStore();
    await recordTaskState('task-1', 'working', store, { status: { state: 'working', evidence } });
    await recordTaskState('task-1', 'completed', store, { status: { state: 'completed' } });
    for (const call of upsert.mock.calls) expect(call[0]).not.toHaveProperty('result');
  });

  it('bounds the copied and the parsed summary', () => {
    const long = 'x'.repeat(10_000);
    expect(workLinkResultFromTask({ status: { state: 'completed', evidence: { summary: long, items: [] } } }, 1)?.summary)
      .toHaveLength(WORK_LINK_LIMITS.MAX_RESULT_SUMMARY);
    const link = parseWorkLink({
      id: 'wl-1', origin: 'manual', state: 'done', owner: { workspaceId: 'ws-1' }, decisionIds: [], createdAt: 1, updatedAt: 1,
      result: { summary: long, verification: '1/2', at: 1 },
    });
    expect(link?.result?.summary).toHaveLength(WORK_LINK_LIMITS.MAX_RESULT_SUMMARY);
    expect(parseWorkLink({
      id: 'wl-1', origin: 'manual', state: 'done', owner: { workspaceId: 'ws-1' }, decisionIds: [], createdAt: 1, updatedAt: 1,
      result: { summary: 'ok', verification: 'all of them', at: 1 },
    })).toBeNull();
  });
});
