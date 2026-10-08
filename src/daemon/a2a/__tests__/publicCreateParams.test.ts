import { describe, expect, it } from 'vitest';
import { parsePublicCreateTask } from '../publicCreateParams';

const base = { title: 'T', from: { workspaceId: 'ws-a', name: 'A' }, to: { workspaceId: 'ws-b', name: 'B' } };

describe('public a2a.task.create parsing', () => {
  it('never passes a caller-supplied remote marker', () => {
    const res = parsePublicCreateTask({
      ...base,
      id: 'task-1',
      remote: { v: 1, linkId: 'l', hostId: 'h', messageId: 'm', direction: 'inbound', delivered: false },
      metadata: { remote: { v: 1 } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toEqual({ id: 'task-1', ...base });
    expect('remote' in res.input).toBe(false);
  });

  it('refuses an rt- id', () => {
    expect(parsePublicCreateTask({ ...base, id: `rt-${'a'.repeat(32)}` })).toMatchObject({ ok: false });
  });

  it('keeps the old required-field answer', () => {
    expect(parsePublicCreateTask({ title: 'T' })).toMatchObject({ ok: false, error: expect.stringContaining('required') });
  });
});
