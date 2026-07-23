import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CompletionEvidence } from '../../../shared/types';
import { isVerifiedItem } from '../../../shared/completionEvidence';

// ClaudeWorker.updateTaskStatus sends wire payload to the renderer via _bridge.sendToRenderer.
// _bridge pulls in electron (ipcMain) so vitest must mock it — instead we assert (A′) honest
// evidence shape from the captured payload.
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: sendToRendererMock }));

import { ClaudeWorker } from '../ClaudeWorker';

const fakeWindow = {} as BrowserWindow;

/** Drive private processLine with a mock result line and return the captured wire payload. */
async function drivenResult(line: string, sessionId: string | null = 'sess-abc'): Promise<Record<string, unknown>> {
  sendToRendererMock.mockClear();
  const worker = new ClaudeWorker(() => fakeWindow);
  const session = { proc: {} as never, taskId: 'task-1', lineBuffer: '', sessionId };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).processLine(session, 'ws-receiver', line);
  await Promise.resolve(); // flush microtask for fire-and-forget updateTaskStatus
  const call = sendToRendererMock.mock.calls.at(-1);
  expect(call?.[1]).toBe('a2a.task.update');
  return call?.[2] as Record<string, unknown>;
}

describe('ClaudeWorker — (A′) honest evidence production (§6.M P1 PR-D′)', () => {
  beforeEach(() => sendToRendererMock.mockClear());

  it('is_error:false → completed + inspection/unverified evidence (no promotion to command/passed)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'done the thing', is_error: false, total_cost_usd: 0.0123 }),
    );
    expect(payload.status).toBe('completed');
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('done the thing');
    expect(ev.items).toHaveLength(1);
    const item = ev.items[0];
    // No laundering (CL1): run-success must never promote to command/passed (verified).
    expect(item.kind).toBe('inspection');
    expect(item.status).toBe('unverified');
    expect(item).not.toHaveProperty('command');
    expect(item.summary).toMatch(/self-reported/);
    if (item.kind === 'inspection' || item.kind === 'artifact') {
      expect(item.location).toBe('claude -p (stream-json)');
    }
    expect(item.output).toContain('session=sess-abc');
    expect(item.output).toContain('cost=$0.0123');
    // Grader must not count this item as verified (verifiedItemCount will be 0).
    expect(isVerifiedItem(item)).toBe(false);
  });

  it('C7: empty result text → default summary prevents empty summary self-rejection', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: '', is_error: false, total_cost_usd: 0 }),
    );
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('agent run completed (empty result text)');
    expect(ev.items).toHaveLength(1);
    expect(isVerifiedItem(ev.items[0])).toBe(false);
  });

  it('missing sessionId → session=? fallback in output (no self-rejection)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'ok', is_error: false }),
      null,
    );
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.items[0].output).toContain('session=?');
    expect(ev.items[0].output).toContain('cost=$?');
  });

  it('is_error:true → failed + Error: reason + inspection/unverified diagnostic item (X8 shape pass)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'boom', is_error: true, total_cost_usd: 0.5 }),
    );
    expect(payload.status).toBe('failed');
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('Error: boom');
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0].kind).toBe('inspection');
    expect(ev.items[0].status).toBe('unverified');
    expect(ev.items[0].summary).toBe('claude CLI run reported error');
  });

  it('is_error:true + empty result → default failure reason', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: '', is_error: true }),
    );
    expect((payload.evidence as CompletionEvidence).summary).toBe('Error: agent run failed');
  });
});
