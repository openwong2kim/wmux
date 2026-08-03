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
  detectedAgents: Map<string, string>;
  appends: { sessionId: string; data: TranscriptAppendData; clientIds: readonly string[] }[];
  dir: string;
  /**
   * The only place a transcript may legitimately live: the projector refuses to
   * open anything outside `<CLAUDE_CONFIG_DIR>/projects`, so the harness sets
   * that variable to a tmp dir and writes every fixture underneath it.
   */
  projects: string;
}

let harness: Harness;

function binding(overrides: Partial<ResumeBinding> = {}): ResumeBinding {
  const merged: ResumeBinding = {
    agent: 'claude',
    sessionId: '920b9112-1111-4222-8333-444455556666',
    cwd: '/tmp/synthetic-repo',
    ts: 1,
    ...overrides,
  };
  // A real transcript is always named `${agentSessionId}.jsonl` and the guard
  // requires it, so derive the id from the file each test names.
  if (overrides.transcriptPath && !overrides.sessionId) {
    merged.sessionId = path.basename(overrides.transcriptPath).replace(/\.jsonl$/, '');
  }
  return merged;
}

/** Copy a checked-in fixture into the legal projects root and return its path. */
function fixture(name: string): string {
  const dest = path.join(harness.projects, name);
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(FIXTURES, name), dest);
  return dest;
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-projector-'));
  const projects = path.join(dir, 'projects', '-synthetic-repo');
  fs.mkdirSync(projects, { recursive: true });
  const bindings = new Map<string, ResumeBinding>();
  const detectedAgents = new Map<string, string>();
  const appends: Harness['appends'] = [];
  const projector = new TranscriptProjector({
    getResumeBinding: (id) => bindings.get(id),
    getDetectedAgent: (id) => detectedAgents.get(id),
    getSessionEnv: () => ({ CLAUDE_CONFIG_DIR: dir }),
    emitAppend: (sessionId, data, clientIds) => appends.push({ sessionId, data, clientIds }),
    debounceMs: 1,
    pollMs: 50,
  });
  harness = { projector, bindings, detectedAgents, appends, dir, projects };
});

afterEach(() => {
  harness.projector.dispose();
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

describe('TranscriptProjector.status — unavailable reasons', () => {
  it('no-hook when the pane has no binding and no agent was detected', () => {
    // No binding AND no detected agent → the hooks never fired here.
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'no-hook' });
  });

  it('stale-session when an agent is running but no binding was captured', () => {
    // An agent IS detected (the pane is running claude) but the binding is
    // absent — the session started before the hooks were armed, or its first
    // Stop has not landed yet. The UI says "wait", not "install the hooks".
    harness.detectedAgents.set('pty-1', 'claude');
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'stale-session' });
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
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(harness.projects, 'gone.jsonl') }));
    expect(harness.projector.status('pty-1')).toEqual({
      available: false,
      reason: 'unreadable',
      transcriptBasename: 'gone.jsonl',
    });
  });

  it('ok, with the agent session id derived from the basename', () => {
    const file = fixture('claude-basic.jsonl');
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
      emitAppend: () => undefined,
    });
    // No getDetectedAgent wired → the split degrades to `no-hook`.
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'no-hook' });
    projector.dispose();
  });
});

// The binding has several writers — the daemon's hook ingest (validated), the
// `daemon.setResumeBinding` RPC that main's hooks.signal fallback calls with the
// RAW payload path, main's resume spool, and the restored state file. Only the
// first was ever checked, so the projector re-checks at the point of projection:
// one choke point every read goes through, whichever writer put the path there.
describe('TranscriptProjector — transcript path containment (every writer)', () => {
  /** A binding no writer validated, exactly as an unchecked route would leave it. */
  function poisoned(transcriptPath: string, sessionId?: string): ResumeBinding {
    return {
      agent: 'claude',
      sessionId: sessionId ?? path.basename(transcriptPath).replace(/\.jsonl$/, ''),
      cwd: '/tmp/synthetic-repo',
      transcriptPath,
      ts: 1,
    };
  }

  it('refuses a path outside the Claude projects root on every read path', () => {
    const secret = path.join(harness.dir, 'secret.jsonl');
    fs.writeFileSync(secret, JSON.stringify({
      type: 'user',
      uuid: 's-1',
      message: { role: 'user', content: 'private' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', poisoned(secret));

    expect(harness.projector.status('pty-1')).toEqual({
      available: false,
      reason: 'unsafe-transcript-path',
    });
    expect(harness.projector.snapshot('pty-1')).toBeNull();
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 1 })).toBeNull();
  });

  it('refuses a path inside the root whose basename is not the agent session id', () => {
    const other = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', poisoned(other, 'a-different-session'));
    expect(harness.projector.status('pty-1').reason).toBe('unsafe-transcript-path');
    expect(harness.projector.snapshot('pty-1')).toBeNull();
  });

  it('never opens a refused path, even for a live subscriber being nudged', async () => {
    const secret = path.join(harness.dir, 'secret.jsonl');
    fs.writeFileSync(secret, JSON.stringify({
      type: 'user',
      uuid: 's-1',
      message: { role: 'user', content: 'private' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', poisoned(secret));

    const status = harness.projector.subscribe('c1', 'pty-1');
    expect(status.available).toBe(false);
    harness.projector.nudge('pty-1', 'agent.stop');
    fs.appendFileSync(secret, JSON.stringify({
      type: 'user',
      uuid: 's-2',
      message: { role: 'user', content: 'more private' },
    }) + '\n', 'utf8');
    harness.projector.nudge('pty-1', 'agent.stop');
    await delay(40);
    expect(harness.appends).toHaveLength(0);
  });

  it('follows a workspace-relocated CLAUDE_CONFIG_DIR rather than only the default root', () => {
    // The env-derived root is the reason the check is not a hardcoded `~/.claude`
    // compare: a workspace profile may relocate it per pane.
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    expect(harness.projector.status('pty-1').available).toBe(true);
  });
});

describe('TranscriptProjector.snapshot', () => {
  it('returns null when the pane is not projectable', () => {
    expect(harness.projector.snapshot('pty-1')).toBeNull();
  });

  it('projects the tail of a real fixture', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
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
    const file = path.join(harness.projects, 'fat.jsonl');
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
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.subscribe('c2', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);

    harness.projector.unsubscribe('c1', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);
    harness.projector.unsubscribe('c2', 'pty-1');
    expect(harness.projector.watchCount).toBe(0);
  });

  it('seeds a client that joins an existing watch with a reset snapshot', async () => {
    // The first subscriber's snapshot drains the shared cursor to EOF. Without
    // the forceReset on join, the second subscriber's scheduled delta is empty
    // and it starts with nothing but future appends — the "subscribe alone gets
    // the conversation" promise would hold only for whoever came first.
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    await delay(40);
    const before = harness.appends.length;
    expect(before).toBeGreaterThan(0);

    harness.projector.subscribe('c2', 'pty-1');
    await delay(40);
    const joined = harness.appends.slice(before);
    expect(joined.length).toBeGreaterThan(0);
    const seed = joined[joined.length - 1];
    expect(seed.clientIds).toContain('c2');
    expect((seed.data as { reset?: boolean }).reset).toBe(true);
    expect((seed.data as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it('subscribes even with no transcript path yet, so the first stop can fill it in', () => {
    harness.bindings.set('pty-1', binding());
    const status = harness.projector.subscribe('c1', 'pty-1');
    expect(status.available).toBe(false);
    expect(harness.projector.watchCount).toBe(1);
  });

  it('dropClient removes that client from every pane it watched', () => {
    const file = fixture('claude-basic.jsonl');
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
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.unsubscribe('c9', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);
  });

  it('dropPty removes the watch regardless of subscribers', () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.dropPty('pty-1');
    expect(harness.projector.watchCount).toBe(0);
  });
});

describe('TranscriptProjector.nudge', () => {
  it('is a cheap no-op for a pane nobody subscribed to', () => {
    const getResumeBinding = vi.fn(() => undefined);
    const projector = new TranscriptProjector({ getResumeBinding, emitAppend: () => undefined });
    projector.nudge('pty-1', 'agent.activity');
    // No subscription ⇒ no binding read, no IO.
    expect(getResumeBinding).not.toHaveBeenCalled();
    projector.dispose();
  });

  it('emits an append (unicast to the subscriber) after a nudge', async () => {
    const file = path.join(harness.projects, 'live.jsonl');
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
    const file = path.join(harness.projects, 'reuse.jsonl');
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
    const next = path.join(harness.projects, 'fresh.jsonl');
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

  it('does NOT replay the previous conversation when the new session has no binding yet', async () => {
    // The `/clear` shape: SessionStart fires before the new `.jsonl` exists, so
    // its provisional capture carries no transcript path and the daemon refuses
    // it — the PREVIOUS session's binding is still what the projector can see.
    const file = path.join(harness.projects, 'first-session.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'the previous conversation' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 1);

    harness.projector.nudge('pty-1', 'agent.session_start', 'second-session');
    await delay(40);
    // Nothing re-adopted: the old transcript must not be presented as the new
    // session's, and repeated nudges must not sneak it back in either.
    harness.projector.nudge('pty-1', 'agent.activity');
    harness.projector.nudge('pty-1', 'agent.stop');
    await delay(40);
    expect(harness.appends).toHaveLength(1);

    // The genuine binding refresh releases the hold.
    const next = path.join(harness.projects, 'second-session.jsonl');
    fs.writeFileSync(next, JSON.stringify({
      type: 'user',
      uuid: 'u-2',
      message: { role: 'user', content: 'the new conversation' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: next, ts: 2 }));
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 2);
    const second = harness.appends[1].data;
    expect(second.reset).toBe(true);
    expect(second.events.map((e) => (e.kind === 'user_text' ? e.text : ''))).toEqual([
      'the new conversation',
    ]);
  });

  it('keeps projecting when session_start RESUMES the session the binding names', async () => {
    const file = path.join(harness.projects, 'resumed.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'resumed conversation' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.session_start', 'resumed');
    await waitFor(() => harness.appends.length === 1);
    expect(harness.appends[0].data.events.map((e) => (e.kind === 'user_text' ? e.text : ''))).toEqual([
      'resumed conversation',
    ]);
  });

  it('does not emit when nothing changed', async () => {
    const file = path.join(harness.projects, 'idle.jsonl');
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
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
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
    const file = path.join(harness.projects, 'burst.jsonl');
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
    const file = path.join(harness.projects, 'partial.jsonl');
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
  it('re-extracts the body from the line the ref points at', () => {
    const file = fixture('code-and-diff.jsonl');
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
    const file = fixture('code-and-diff.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 0, n: 1, eventId: 'someone-else' })).toBeNull();
  });

  it('refuses an out-of-range block handle and a bad offset', () => {
    const file = fixture('code-and-diff.jsonl');
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

// Codex's outside-voice review questioned whether the existing on-expand fetch
// could serve a tool body at all, or whether "reuse codeBlock" was really a new
// implementation in disguise. It serves them: `bodies` is keyed by event id and
// block number, and a tool body registers under the same shape a code block
// does. This pins that, plus the rotation guard that keeps a stale offset from
// answering with a different conversation's bytes.
describe('TranscriptProjector.codeBlock — tool bodies', () => {
  it('serves an over-cap tool output through the same fetch code blocks use', () => {
    const big = 'q'.repeat(9000);
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-body',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: big }],
      },
    });
    const file = path.join(harness.projects, '920b9112-1111-4222-8333-444455556666.jsonl');
    fs.writeFileSync(file, `${line}
`, 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));

    const page = harness.projector.snapshot('pty-1');
    const ev = page?.events.find((e) => e.kind === 'tool_result');
    if (!ev || ev.kind !== 'tool_result') throw new Error('expected a tool_result event');
    expect(ev.output?.bytes).toBe(9000);
    // Over the cap, so the inline copy is only a head.
    expect((ev.output?.inline ?? '').length).toBeLessThan(9000);

    const fetched = harness.projector.codeBlock('pty-1', {
      srcOffset: ev.output?.srcOffset ?? 0,
      n: ev.output?.n ?? 1,
      eventId: ev.id,
    });
    expect(fetched?.body).toHaveLength(9000);

    // A stale event id must not be answered from the same offset — the guard
    // that stops a rotated file from serving another conversation's bytes.
    expect(
      harness.projector.codeBlock('pty-1', {
        srcOffset: ev.output?.srcOffset ?? 0,
        n: ev.output?.n ?? 1,
        eventId: 'not-this-event',
      }),
    ).toBeNull();
  });
});

describe('TranscriptProjector — #782 phone turn-view contract (stateless delta)', () => {
  it('delta is stateless: a phone read arms no watch and resets no subscriber', () => {
    const file = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    // The desktop subscribes, arming one watch.
    harness.projector.subscribe('desk-1', 'pty-1');
    expect(harness.projector.watchCount).toBe(1);

    const snap = harness.projector.snapshot('pty-1')!;
    // A phone delta call must NOT subscribe, force-reset, or move the shared
    // tailOffset — the #782 CRITICAL 6 guarantee that a phone opening a pane
    // never scrambles the desktop Chat View sharing the session.
    const phone = harness.projector.delta('pty-1', snap.cursor.tailOffset, {
      cursorFileSize: snap.cursor.fileSize,
    });
    expect(phone).not.toBeNull();
    expect(phone!.reset).toBe(false);
    // No phone watch was armed.
    expect(harness.projector.watchCount).toBe(1);
  });

  it('delta reports reset when the file shrank under the cursor', () => {
    const file = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const snap = harness.projector.snapshot('pty-1')!;
    // Cursor believes a LARGER file than what is on disk → truncated/rewritten.
    // A grow is a normal append and must NOT reset — otherwise every turn
    // resets the delta and the forward path becomes dead code.
    const result = harness.projector.delta('pty-1', snap.cursor.tailOffset, {
      cursorFileSize: snap.cursor.fileSize + 1000,
    })!;
    expect(result.reset).toBe(true);
    // A reset carries a fresh snapshot, not an empty delta.
    expect(result.events.length).toBe(snap.events.length);
  });

  it('delta resets when the cursor offset is no longer a line boundary', () => {
    const file = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const st = fs.statSync(file);
    // Offset 5 is inside the first line — a cursor that an in-place rewrite
    // left pointing mid-entry. fileSize matches so the boundary check alone is
    // the trigger (the in-place-rewrite case a size check cannot catch).
    const result = harness.projector.delta('pty-1', 5, {
      cursorFileSize: st.size,
    })!;
    expect(result.reset).toBe(true);
  });

  it('codeBlock refuses a mid-line offset (#782 boundary check)', () => {
    const file = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    // Offset 5 is inside the first line; readTranscriptLineAt would slice from
    // there with no boundary check, so the projector must refuse before reading.
    expect(harness.projector.codeBlock('pty-1', { srcOffset: 5, n: 1 })).toBeNull();
  });

  it('a huge tool result ships an inline head + truncated, under the page budget', () => {
    const file = fixture('huge-tool-result.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const snap = harness.projector.snapshot('pty-1')!;
    // The single entry is ~120 KB — under the 128 KB page budget, so the page
    // carries it whole rather than dropping it.
    expect(snap.events).toHaveLength(1);
    const ev = snap.events[0];
    expect(ev.kind).toBe('tool_result');
    if (ev.kind !== 'tool_result') return;
    expect(ev.output?.truncated).toBe(true);
    // The inline body is a ~4 KB head, not the whole 120 KB payload.
    expect(Buffer.byteLength(ev.output?.inline ?? '', 'utf8')).toBeLessThan(9000);
    // The full size is still reported so the UI can say how much was cut.
    expect(ev.bytes).toBeGreaterThan(100000);
  });
});
