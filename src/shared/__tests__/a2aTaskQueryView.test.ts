// a2a_task_query's caller-facing view: compact summaries paged newest first,
// the full task only on request, and every shape within one result. The raw
// RPC returned every task with its whole history and outgrew the 64 KiB cap.
import { describe, expect, it } from 'vitest';
import { TASK_PREVIEW_CHARS, TASK_QUERY_CAP_BYTES, applyTaskQueryView, shapeTaskQueryResult } from '../a2aTaskQueryView';
import { DEFAULT_RESULT_CAP_BYTES } from '../../mcp/resultCap';

type View = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One task source answering a paged call, then main shaping the result. */
function shape(result: unknown, options: Parameters<typeof shapeTaskQueryResult>[1] = {}): unknown {
  const r = result as View;
  if (!r || !Array.isArray(r.tasks)) return shapeTaskQueryResult(result, options);
  const params = { view: 'page', ...(options.taskId && { taskId: options.taskId }) };
  return shapeTaskQueryResult({ ...r, tasks: applyTaskQueryView(r.tasks, params) }, options);
}

function task(id: string, hour: number, texts: string[], title = `title ${id}`) {
  const at = `2026-09-28T0${hour}:00:00.000Z`;
  return {
    kind: 'task',
    id,
    status: { state: 'submitted', timestamp: at },
    history: texts.map((text, index) => ({
      kind: 'message',
      messageId: `${id}-m${index}`,
      role: 'user',
      parts: [{ kind: 'text', text }],
    })),
    artifacts: [],
    metadata: {
      title,
      from: { workspaceId: 'ws-a', name: 'Alpha' },
      to: { workspaceId: 'ws-b', name: 'Beta' },
      createdAt: at,
      updatedAt: at,
    },
  };
}

const raw = {
  workspaceId: 'ws-b',
  tasks: [
    task('t1', 1, ['first', 'x'.repeat(5000)]),
    task('t3', 3, ['newest']),
    task('t2', 2, ['middle']),
  ],
};

describe('shapeTaskQueryResult — listing', () => {
  it('lists bounded summaries newest first and pages with nextCursor', () => {
    const page1 = shape(raw, { limit: 2 }) as View;
    expect(page1.workspaceId).toBe('ws-b');
    expect(page1.total).toBe(3);
    expect(page1.remaining).toBe(1);
    expect(page1.nextUpdatedSince).toBe('2026-09-28T03:00:00.000Z');
    expect(page1.tasks.map((t: View) => t.id)).toEqual(['t3', 't2']);
    expect(page1.tasks[0]).toEqual({
      id: 't3',
      state: 'submitted',
      title: 'title t3',
      from: 'Alpha',
      to: 'Beta',
      createdAt: '2026-09-28T03:00:00.000Z',
      updatedAt: '2026-09-28T03:00:00.000Z',
      messageCount: 1,
      lastMessage: { role: 'user', preview: 'newest' },
    });

    // t1 is updated between pages: paging by creation time still reaches it,
    // and the total keeps meaning "all matches", not "what is left".
    const updated = structuredClone(raw);
    updated.tasks[0].metadata.updatedAt = '2026-09-28T09:00:00.000Z';
    const page2 = shape(updated, { limit: 2, cursor: page1.nextCursor }) as View;
    expect(page2.tasks.map((t: View) => t.id)).toEqual(['t1']);
    expect(page2.total).toBe(3);
    expect(page2.remaining).toBe(0);
    expect(page2).not.toHaveProperty('nextCursor');
    // The snapshot stays the one taken when paging began.
    expect(page2.nextUpdatedSince).toBe('2026-09-28T03:00:00.000Z');
    // The long last message is cut to a preview, not carried whole.
    expect(page2.tasks[0].messageCount).toBe(2);
    expect(Array.from(page2.tasks[0].lastMessage.preview as string)).toHaveLength(TASK_PREVIEW_CHARS + 1);

    expect(shape(raw, { cursor: 'garbage' })).toHaveProperty('error');
  });

  it('bounds free-text fields so one huge title cannot empty a page', () => {
    const big = { workspaceId: 'ws-b', tasks: [task('t9', 9, ['hi'], 'T'.repeat(70_000)), ...raw.tasks] };
    const page = shape(big, {}) as View;
    expect(page.tasks).toHaveLength(4);
    expect(Buffer.byteLength(page.tasks[0].title, 'utf8')).toBeLessThanOrEqual(400);
  });

  it('shrinks a page to the byte budget and pages on, or errors when nothing fits', () => {
    const page = shape(raw, { capBytes: 900 }) as View;
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.length).toBeLessThan(3);
    expect(Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8')).toBeLessThanOrEqual(900);
    expect(typeof page.nextCursor).toBe('string');
    expect(shape(raw, { capBytes: 50 })).toHaveProperty('error');
  });
});

describe('shapeTaskQueryResult — one task', () => {
  it('returns the full task for task_id and one message for message_id', () => {
    const full = shape(raw, { taskId: 't1' }) as View;
    expect(full.task).toEqual(raw.tasks[0]);
    expect(full).not.toHaveProperty('historyTruncated');
    const one = shape(raw, { taskId: 't1', messageId: 't1-m0' }) as View;
    expect(one.message.parts[0].text).toBe('first');
    expect(shape(raw, { taskId: 'nope' })).toHaveProperty('error');
    // An RPC error passes through untouched.
    expect(shape({ error: 'boom' })).toEqual({ error: 'boom' });
  });

  it('keeps the newest messages that fit and pages to older ones', () => {
    const long = task('tl', 4, Array.from({ length: 40 }, (_, i) => `${i}:${'m'.repeat(3000)}`));
    long.artifacts = [{ name: 'report', parts: [{ kind: 'text', text: 'a'.repeat(50_000) }] }] as never;
    const input = { workspaceId: 'ws-b', tasks: [long] };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 40; pages += 1) {
      const view = shape(input, { taskId: 'tl', cursor }) as View;
      expect(Buffer.byteLength(JSON.stringify(view, null, 2), 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(view.artifactsSummarized).toBe(true);
      expect(view.task.artifacts[0]).toMatchObject({ name: 'report', parts: 1 });
      expect(view.historyTruncated.totalMessages).toBe(40);
      seen.unshift(...view.task.history.map((m: View) => m.messageId));
      cursor = view.nextCursor;
      if (!cursor) break;
    }
    // Every message is reached exactly once, oldest to newest.
    expect(seen).toEqual(long.history.map((m) => m.messageId));
  });
});

describe('applyTaskQueryView — what one task source returns', () => {
  it('keeps full tasks without view, and returns one task or summaries for view: page', () => {
    expect(applyTaskQueryView(raw.tasks, {})).toEqual(raw.tasks);
    expect(applyTaskQueryView(raw.tasks, { view: 'page', taskId: 't2' })).toEqual([raw.tasks[2]]);
    const rows = applyTaskQueryView(raw.tasks, { view: 'page' }) as View[];
    expect(rows.map((row) => row.id)).toEqual(['t1', 't3', 't2']);
    expect(rows.every((row) => !('history' in row) && !('artifacts' in row))).toBe(true);
  });

  it('budgets pages to the MCP tool result cap', () => {
    expect(TASK_QUERY_CAP_BYTES).toBe(DEFAULT_RESULT_CAP_BYTES);
  });
});
