import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BUDGET_BYTES, TranscriptProjector } from '../TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';

const FIXTURES = path.join(__dirname, 'fixtures');

interface Harness {
  projector: TranscriptProjector;
  bindings: Map<string, ResumeBinding>;
  appends: { sessionId: string; data: TranscriptAppendData; clientIds: readonly string[] }[];
  dir: string;
}

let harness: Harness;

function binding(overrides: Partial<ResumeBinding> = {}): ResumeBinding {
  return {
    agent: 'claude',
    sessionId: '920b9112-1111-4222-8333-444455556666',
    cwd: '/tmp/synthetic-repo',
    ts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-projector-'));
  const bindings = new Map<string, ResumeBinding>();
  const appends: Harness['appends'] = [];
  const projector = new TranscriptProjector({
    getResumeBinding: (id) => bindings.get(id),
    emitAppend: (sessionId, data, clientIds) => appends.push({ sessionId, data, clientIds }),
    debounceMs: 1,
    pollMs: 50,
  });
  harness = { projector, bindings, appends, dir };
});

afterEach(() => {
  harness.projector.dispose();
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

describe('TranscriptProjector.status — the four unavailable reasons', () => {
  it('no-binding when the pane has no resume binding at all', () => {
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'no-binding' });
  });

  it('not-claude for an agent that publishes no structured transcript', () => {
    harness.bindings.set('pty-1', binding({ agent: 'codex', transcriptPath: '/tmp/x.jsonl' }));
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'not-claude' });
  });

  it('no-transcript-path before the first turn ends (SessionStart has no path)', () => {
    harness.bindings.set('pty-1', binding());
    expect(harness.projector.status('pty-1')).toEqual({
      available: false,
      reason: 'no-transcript-path',
    });
  });

  it('unreadable when the transcript was purged', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(harness.dir, 'gone.jsonl') }));
    expect(harness.projector.status('pty-1')).toEqual({
      available: false,
      reason: 'unreadable',
      transcriptBasename: 'gone.jsonl',
    });
  });

  it('ok, with the agent session id derived from the basename', () => {
    const file = path.join(FIXTURES, 'claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const status = harness.projector.status('pty-1');
    expect(status.available).toBe(true);
    expect(status.reason).toBe('ok');
    expect(status.transcriptBasename).toBe('claude-basic.jsonl');
    expect(status.agentSessionId).toBe('claude-basic');
    expect(status.sizeBytes).toBe(fs.statSync(file).size);
  });

  it('survives a throwing binding lookup', () => {
    const projector = new TranscriptProjector({
      getResumeBinding: () => {
        throw new Error('session table exploded');
      },
      emitAppend: () => {},
    });
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'no-binding' });
    projector.dispose();
  });
});

describe('TranscriptProjector.snapshot', () => {
  it('returns null when the pane is not projectable', () => {
    expect(harness.projector.snapshot('pty-1')).toBeNull();
  });

  it('projects the tail of a real fixture', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(FIXTURES, 'claude-basic.jsonl') }));
    const page = harness.projector.snapshot('pty-1')!;
    expect(page.events.map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'meta',
    ]);
  });

  it('keeps every response under the A3 byte budget', () => {
    const file = path.join(harness.dir, 'fat.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        uuid: `fat-${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(4000) }] },
      }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));

    const page = harness.projector.snapshot('pty-1')!;
    expect(Buffer.byteLength(JSON.stringify(page.events), 'utf8')).toBeLessThanOrEqual(BUDGET_BYTES);
    // Shrinking the window must not lie about the cursor.
    expect(page.cursor.fileSize).toBe(fs.statSync(file).size);
    expect(page.hasMore).toBe(true);
  });
});

describe('TranscriptProjector.subscribe / unsubscribe — per (client, session)', () => {
  it('refcounts by client and tears the watch down with the last one', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(FIXTURES, 'claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.subscribe('c2', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);

    harness.projector.unsubscribe('c1', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);
    harness.projector.unsubscribe('c2', 'pty-1');
    expect(harness.projector.watchCount).toBe(0);
  });

  it('subscribes even with no transcript path yet, so the first stop can fill it in', () => {
    harness.bindings.set('pty-1', binding());
    const status = harness.projector.subscribe('c1', 'pty-1');
    expect(status.available).toBe(false);
    expect(harness.projector.watchCount).toBe(1);
  });

  it('dropClient removes that client from every pane it watched', () => {
    const file = path.join(FIXTURES, 'claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.bindings.set('pty-2', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.subscribe('c1', 'pty-2');
    harness.projector.subscribe('c2', 'pty-2');
    expect(harness.projector.watchCount).toBe(2);

    harness.projector.dropClient('c1');
    // pty-1 had only c1; pty-2 still has c2.
    expect(harness.projector.watchCount).toBe(1);
    harness.projector.dropClient('c2');
    expect(harness.projector.watchCount).toBe(0);
  });

  it('unsubscribe for an unknown pane or client is a no-op', () => {
    expect(() => harness.projector.unsubscribe('c9', 'nope')).not.toThrow();
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(FIXTURES, 'claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.unsubscribe('c9', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);
  });

  it('dropPty removes the watch regardless of subscribers', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(FIXTURES, 'claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.dropPty('pty-1');
    expect(harness.projector.watchCount).toBe(0);
  });
});

describe('TranscriptProjector.nudge', () => {
  it('is a cheap no-op for a pane nobody subscribed to', () => {
    const getResumeBinding = vi.fn(() => undefined);
    const projector = new TranscriptProjector({ getResumeBinding, emitAppend: () => {} });
    projector.nudge('pty-1', 'agent.activity');
    // No subscription ⇒ no binding read, no IO.
    expect(getResumeBinding).not.toHaveBeenCalled();
    projector.dispose();
  });

  it('emits an append (unicast to the subscriber) after a nudge', async () => {
    const file = path.join(harness.dir, 'live.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'first' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');

    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length > 0);

    const first = harness.appends[0];
    expect(first.sessionId).toBe('pty-1');
    expect(first.clientIds).toEqual(['c1']);
    expect(first.data.seq).toBe(1);
    // The very first read after subscribe is a snapshot, so it is a reset.
    expect(first.data.reset).toBe(true);
    expect(first.data.events).toHaveLength(1);
  });

  it('a session_start nudge forces reset on the next append', async () => {
    const file = path.join(harness.dir, 'reuse.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'old conversation' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 1);

    // A reused pane: new session, new file, same pane id.
    const next = path.join(harness.dir, 'fresh.jsonl');
    fs.writeFileSync(next, JSON.stringify({
      type: 'user',
      uuid: 'u-2',
      message: { role: 'user', content: 'new conversation' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: next, ts: 2 }));

    harness.projector.nudge('pty-1', 'agent.session_start');
    await waitFor(() => harness.appends.length === 2);

    const second = harness.appends[1].data;
    expect(second.reset).toBe(true);
    expect(second.seq).toBe(2);
    const texts = second.events.map((e) => (e.kind === 'user_text' ? e.text : ''));
    expect(texts).toEqual(['new conversation']);
  });

  it('does not emit when nothing changed', async () => {
    const file = path.join(harness.dir, 'idle.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'only entry' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 1);

    harness.projector.nudge('pty-1', 'agent.activity');
    harness.projector.nudge('pty-1', 'agent.activity');
    await delay(30);
    expect(harness.appends).toHaveLength(1);
  });

  it('does nothing after dispose', async () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(FIXTURES, 'claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.dispose();
    harness.projector.nudge('pty-1', 'agent.stop');
    await delay(20);
    expect(harness.appends).toHaveLength(0);
  });
});

describe('TranscriptProjector — draining a burst (D3) and stalling on an oversized entry (D1)', () => {
  /** `count` synthetic user turns, each padded so the set exceeds the budget. */
  function burst(count: number, pad = 2000, prefix = 'burst'): string {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify({
        type: 'user',
        uuid: `${prefix}-${String(i).padStart(5, '0')}`,
        message: { role: 'user', content: `turn ${i} ${'x'.repeat(pad)}` },
      }));
    }
    return lines.join('\n') + '\n';
  }

  it('keeps reading until the cursor reaches EOF after a budget-limited append', async () => {
    const file = path.join(harness.dir, 'burst.jsonl');
    // Start with one small entry so the first (snapshot) read is cheap, then
    // append far more than one budgeted read can carry.
    fs.writeFileSync(file, burst(1, 10, 'seed'), 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 1);

    // One write, one nudge: without the drain the newest turns would sit unread
    // until the NEXT fs event, which on a finished turn may never come.
    fs.appendFileSync(file, burst(400), 'utf8');
    const size = fs.statSync(file).size;
    harness.projector.nudge('pty-1', 'agent.stop');

    await waitFor(() => {
      const last = harness.appends[harness.appends.length - 1];
      return last.data.cursor.tailOffset === size;
    });
    // It genuinely took more than one budgeted payload to get there, and each
    // one stayed under the budget.
    expect(harness.appends.length).toBeGreaterThan(2);
    for (const a of harness.appends) {
      expect(Buffer.byteLength(JSON.stringify(a.data.events), 'utf8')).toBeLessThanOrEqual(BUDGET_BYTES);
    }
    // Every turn arrived exactly once, in order.
    const ids = harness.appends.flatMap((a) => a.data.events.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('burst-00399');
  });

  it('does not emit or advance while an oversized entry is still unterminated', async () => {
    const file = path.join(harness.dir, 'partial.jsonl');
    fs.writeFileSync(file, burst(1, 10, 'seed'), 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 1);
    const settled = harness.appends[0].data.cursor.tailOffset;

    // A single entry larger than the read cap, with no newline yet.
    const huge = JSON.stringify({
      type: 'user',
      uuid: 'huge-1',
      message: { role: 'user', content: 'y'.repeat(400 * 1024) },
    });
    fs.appendFileSync(file, huge, 'utf8');

    // Repeated nudges (a mid-turn agent nudges often) must not spin: nothing is
    // emitted and the cursor stays on the last good boundary.
    for (let i = 0; i < 5; i++) harness.projector.nudge('pty-1', 'agent.activity');
    await delay(60);
    expect(harness.appends).toHaveLength(1);
    expect(harness.appends[0].data.cursor.tailOffset).toBe(settled);

    // The newline releases it, and the skipped row is VISIBLE rather than a hole.
    fs.appendFileSync(file, '\n', 'utf8');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 2);
    const labels = harness.appends[1].data.events
      .filter((e) => e.kind === 'meta')
      .map((e) => (e.kind === 'meta' ? e.label : ''));
    expect(labels).toContain('oversized entry skipped');
  });
});

describe('TranscriptProjector.codeBlock — on-expand body fetch', () => {
  const file = path.join(FIXTURES, 'code-and-diff.jsonl');

  it('re-extracts the body from the line the ref points at', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const page = harness.projector.snapshot('pty-1')!;
    const event = page.events.find((e) => e.kind === 'assistant_text' && e.codeBlocks);
    if (!event || event.kind !== 'assistant_text' || !event.codeBlocks) throw new Error('no code block');
    const ref = event.codeBlocks[0];

    const body = harness.projector.codeBlock('pty-1', {
      srcOffset: ref.srcOffset!,
      n: ref.n,
      eventId: event.id,
    });
    expect(body).toEqual({ body: 'export const a = 1;\nexport const b = 2;\nexport const c = 3;' });
  });

  it('refuses when the event id does not match the line at that offset', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 1, eventId: 'someone-else' })).toBeNull();
  });

  it('refuses an out-of-range block handle and a bad offset', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 99 })).toBeNull();
    expect(harness.projector.codeBlock('pty-1', { srcOffset: -1, n: 1 })).toBeNull();
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 0 })).toBeNull();
  });

  it('refuses when the pane is not projectable', () => {
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 1 })).toBeNull();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
