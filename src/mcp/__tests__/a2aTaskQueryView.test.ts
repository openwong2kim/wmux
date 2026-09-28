// a2a_task_query's caller-facing view: compact summaries paged newest first,
// the full task only on request. The raw RPC returned every task with its
// whole history and outgrew the 64 KiB result cap.
import { describe, expect, it } from 'vitest';
import { TASK_PREVIEW_CHARS, shapeTaskQueryResult } from '../a2aTaskQueryView';

function task(id: string, updatedAt: string, texts: string[]) {
  return {
    kind: 'task',
    id,
    status: { state: 'submitted', timestamp: updatedAt },
    history: texts.map((text, index) => ({
      kind: 'message',
      messageId: `${id}-m${index}`,
      role: 'user',
      parts: [{ kind: 'text', text }],
    })),
    artifacts: [],
    metadata: {
      title: `title ${id}`,
      from: { workspaceId: 'ws-a', name: 'Alpha' },
      to: { workspaceId: 'ws-b', name: 'Beta' },
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt,
    },
  };
}

const raw = {
  workspaceId: 'ws-b',
  tasks: [
    task('t1', '2026-09-28T01:00:00.000Z', ['first', 'x'.repeat(5000)]),
    task('t3', '2026-09-28T03:00:00.000Z', ['newest']),
    task('t2', '2026-09-28T02:00:00.000Z', ['middle']),
  ],
};

describe('shapeTaskQueryResult', () => {
  it('lists bounded summaries newest first and pages with nextCursor', () => {
    const page1 = shapeTaskQueryResult(raw, { limit: 2 }) as Record<string, any>;
    expect(page1.workspaceId).toBe('ws-b');
    expect(page1.total).toBe(3);
    expect(page1.tasks.map((t: any) => t.id)).toEqual(['t3', 't2']);
    expect(page1.tasks[0]).toEqual({
      id: 't3',
      state: 'submitted',
      title: 'title t3',
      from: 'Alpha',
      to: 'Beta',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T03:00:00.000Z',
      messageCount: 1,
      lastMessage: { role: 'user', preview: 'newest' },
    });
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = shapeTaskQueryResult(raw, { limit: 2, cursor: page1.nextCursor }) as Record<string, any>;
    expect(page2.tasks.map((t: any) => t.id)).toEqual(['t1']);
    expect(page2).not.toHaveProperty('nextCursor');
    // The long last message is cut to a preview, not carried whole.
    expect(page2.tasks[0].messageCount).toBe(2);
    expect(Array.from(page2.tasks[0].lastMessage.preview as string)).toHaveLength(TASK_PREVIEW_CHARS + 1);

    expect(shapeTaskQueryResult(raw, { cursor: 'garbage' })).toHaveProperty('error');
  });

  it('returns the full task for task_id and one message for message_id', () => {
    const full = shapeTaskQueryResult(raw, { taskId: 't1' }) as Record<string, any>;
    expect(full.task).toEqual(raw.tasks[0]);
    const one = shapeTaskQueryResult(raw, { taskId: 't1', messageId: 't1-m0' }) as Record<string, any>;
    expect(one.message.parts[0].text).toBe('first');
    expect(shapeTaskQueryResult(raw, { taskId: 'nope' })).toHaveProperty('error');
    // An RPC error passes through untouched.
    expect(shapeTaskQueryResult({ error: 'boom' })).toEqual({ error: 'boom' });
  });

  it('shrinks a page that would not fit the byte budget and pages on', () => {
    const page = shapeTaskQueryResult(raw, { capBytes: 900 }) as Record<string, any>;
    expect(page.tasks.length).toBeLessThan(3);
    expect(Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8')).toBeLessThanOrEqual(900);
    expect(typeof page.nextCursor).toBe('string');
  });
});
