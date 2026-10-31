import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BUDGET_BYTES, TranscriptProjector } from '../TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';
import { shortPathOf } from '../../../test-utils/shortPath';
import { deliberateSleep } from '../../../test-utils/waitFor';

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

  it('no-transcript-path, not stale-session, for a Codex pane still waiting for its binding (#1764)', () => {
    // Codex binds only once its rollout is known; until then the phone must
    // read "waiting for the record", not "this pane moved on to a new session".
    harness.detectedAgents.set('pty-1', 'codex');
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'no-transcript-path' });
  });

  it('unsupported-agent for an agent that publishes no structured transcript', () => {
    harness.bindings.set('pty-1', binding({ agent: 'grok', transcriptPath: '/tmp/x.jsonl' }));
    expect(harness.projector.status('pty-1')).toEqual({ available: false, reason: 'unsupported-agent' });
  });

  it('no-transcript-path before the first turn ends (SessionStart has no path)', () => {
    harness.bindings.set('pty-1', binding());
    expect(harness.projector.status('pty-1')).toEqual({
      available: false,
      reason: 'no-transcript-path',
    });
  });

  it('a transcript with nothing at its path yet reads as an empty conversation (a bare launch)', () => {
    // Claude names it at SessionStart and writes it on the first prompt; a
    // purged one reads the same. The chat bridge offers it only while the agent runs.
    harness.bindings.set('pty-1', binding({ transcriptPath: path.join(harness.projects, 'gone.jsonl') }));
    expect(harness.projector.status('pty-1')).toMatchObject({
      available: true,
      reason: 'ok',
      transcriptBasename: 'gone.jsonl',
      agentSessionId: 'gone',
      sizeBytes: 0,
    });
    expect(harness.projector.snapshot('pty-1')?.events).toEqual([]);
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
    await deliberateSleep(40, 'negative: nothing is projected');
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
    await vi.waitFor(() => expect(harness.appends.length).toBeGreaterThan(0), { timeout: 10_000 });
    const before = harness.appends.length;
    expect(before).toBeGreaterThan(0);

    harness.projector.subscribe('c2', 'pty-1');
    await vi.waitFor(() => expect(harness.appends.length).toBeGreaterThan(before), { timeout: 10_000 });
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

  it.runIf(process.platform === 'win32')('arms fs.watch on the long spelling of an 8.3 short transcript dir (#984)', (ctx) => {
    // libuv 1.52 builds with asserts on abort the process on the first event
    // for a directory watched through a short alias.
    const shortDir = shortPathOf(harness.dir);
    if (!shortDir) return ctx.skip(); // 8.3 names are off for this volume
    fixture('claude-basic.jsonl');
    const shortFile = path.join(shortDir, 'projects', '-synthetic-repo', 'claude-basic.jsonl');
    // Config root and transcript in the same short spelling, the way a short
    // %TEMP% or CLAUDE_CONFIG_DIR hands both over.
    const projector = new TranscriptProjector({
      getResumeBinding: () => binding({ transcriptPath: shortFile }),
      getSessionEnv: () => ({ CLAUDE_CONFIG_DIR: shortDir }),
      emitAppend: () => undefined,
    });
    const watch = vi.spyOn(fs, 'watch');
    try {
      projector.subscribe('c1', 'pty-1');
      expect(watch).toHaveBeenCalledTimes(1);
      const target = String(watch.mock.calls[0][0]);
      expect(target).not.toContain('~');
      expect(target.toLowerCase()).toBe(fs.realpathSync.native(harness.projects).toLowerCase());
    } finally {
      projector.dispose();
      watch.mockRestore();
    }
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
    await deliberateSleep(40, 'ordering: let the session_start nudge settle before the next nudges');
    // Nothing re-adopted: the old transcript must not be presented as the new
    // session's, and repeated nudges must not sneak it back in either.
    harness.projector.nudge('pty-1', 'agent.activity');
    harness.projector.nudge('pty-1', 'agent.stop');
    await deliberateSleep(40, 'negative: repeated nudges do not re-adopt the old transcript');
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
    await deliberateSleep(30, 'negative: activity nudges add no append');
    expect(harness.appends).toHaveLength(1);
  });

  it('does nothing after dispose', async () => {
    harness.bindings.set('pty-1', binding({ transcriptPath: fixture('claude-basic.jsonl') }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.dispose();
    harness.projector.nudge('pty-1', 'agent.stop');
    await deliberateSleep(20, 'negative: nothing is projected after dispose');
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
    await deliberateSleep(60, 'negative: repeated nudges do not spin');
    expect(harness.appends).toHaveLength(1);
    expect(harness.appends[0].data.cursor.tailOffset).toBe(settled);

    // The newline releases it, and the record arrives as the row it is.
    fs.appendFileSync(file, '\n', 'utf8');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length === 2);
    expect(harness.appends[1].data.events.map((e) => [e.id, e.kind])).toEqual([['huge-1', 'user_text']]);
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

describe('TranscriptProjector.searchPage — host search reads', () => {
  it('answers the resolver reason for a pane it cannot read', () => {
    expect(harness.projector.searchPage('pty-1')).toEqual({ ok: false, reason: 'no-hook' });
  });

  it('pages backward past the A3 budget, and each line end is a snapshot boundary', () => {
    const file = path.join(harness.projects, 'search-pages.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        uuid: `page-${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `row ${i} ` + 'z'.repeat(4000) }] },
      }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));

    const first = harness.projector.searchPage('pty-1');
    if (!first.ok) throw new Error(first.reason);
    // A full 256 KiB window, not the budget-shrunk one `snapshot` serves.
    expect(Buffer.byteLength(JSON.stringify(first.page.events), 'utf8')).toBeGreaterThan(BUDGET_BYTES);
    expect(first.lineEnds).toHaveLength(first.page.events.length);
    expect(first.lineEnds[first.lineEnds.length - 1]).toBe(fs.statSync(file).size);

    // The window ending at an event's line end ends with that event.
    const i = 3;
    const around = harness.projector.snapshot('pty-1', { before: first.lineEnds[i] })!;
    expect(around.events[around.events.length - 1].id).toBe(first.page.events[i].id);

    const older = harness.projector.searchPage('pty-1', first.page.cursor.headOffset);
    if (!older.ok) throw new Error(older.reason);
    expect(older.page.events[older.page.events.length - 1].id).toBe(`page-${Number(first.page.events[0].id.slice(5)) - 1}`);
  });
});

describe('TranscriptProjector — #782 phone turn-view contract (stateless delta)', () => {
  /**
   * A valid entry whose normalized events exceed BUDGET_BYTES while the raw
   * JSONL record still fits inside the projector's smallest read window. The
   * long entry id is repeated across every projected tool event, forcing the
   * budget fitter (rather than readTail's raw-record skip) to omit the row.
   */
  function budgetDroppingEntry(): string {
    return JSON.stringify({
      type: 'assistant',
      uuid: `oversized-${'u'.repeat(500)}`,
      message: {
        role: 'assistant',
        content: Array.from({ length: 300 }, () => ({ type: 'tool_use' })),
      },
    });
  }

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

  it('reports a budget drop on the normal forward path', () => {
    const file = path.join(harness.projects, 'forward-budget-drop.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'seed',
      message: { role: 'user', content: 'before the oversized entry' },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const snap = harness.projector.snapshot('pty-1');
    if (!snap) throw new Error('expected an initial snapshot');

    const oversized = `${budgetDroppingEntry()}\n`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBeLessThan(8 * 1024);
    fs.appendFileSync(file, oversized, 'utf8');

    const result = harness.projector.delta('pty-1', snap.cursor.tailOffset, {
      cursorFileSize: snap.cursor.fileSize,
    });
    if (!result) throw new Error('expected a forward delta');
    expect(result.reset).toBe(false);
    expect(result.budgetDropped).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.cursor.tailOffset).toBe(fs.statSync(file).size);
  });

  it('preserves the budget-drop receipt when reset returns a fresh snapshot', () => {
    const file = path.join(harness.projects, 'reset-budget-drop.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'old-session',
      message: { role: 'user', content: 'x'.repeat(16 * 1024) },
    }) + '\n', 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const snap = harness.projector.snapshot('pty-1');
    if (!snap) throw new Error('expected an initial snapshot');

    const oversized = `${budgetDroppingEntry()}\n`;
    fs.writeFileSync(file, oversized, 'utf8');
    expect(fs.statSync(file).size).toBeLessThan(snap.cursor.fileSize);

    const result = harness.projector.delta('pty-1', snap.cursor.tailOffset, {
      cursorFileSize: snap.cursor.fileSize,
    });
    if (!result) throw new Error('expected a reset delta');
    expect(result.reset).toBe(true);
    expect(result.budgetDropped).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.cursor.tailOffset).toBe(fs.statSync(file).size);
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

  it('staleCursor applies the same shrink and line-boundary checks to a back-paging head', () => {
    const file = fixture('claude-basic.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const snap = harness.projector.snapshot('pty-1')!;
    expect(harness.projector.staleCursor('pty-1', snap.cursor.headOffset, snap.cursor.fileSize)).toBe(false);
    expect(harness.projector.staleCursor('pty-1', snap.cursor.headOffset, snap.cursor.fileSize + 1000)).toBe(true);
    expect(harness.projector.staleCursor('pty-1', 5, snap.cursor.fileSize)).toBe(true);
    expect(harness.projector.staleCursor('pty-unbound', 0)).toBe(true);
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

describe('TranscriptProjector.sentFileBinding', () => {
  const write = (name: string): string => {
    const file = path.join(harness.projects, name);
    fs.writeFileSync(file, '{"type":"system"}\n', 'utf8');
    return file;
  };

  it('answers the bound transcript with no subscriber, and null while a new session has not bound yet', () => {
    const first = write('first-session.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: first }));
    const before = harness.projector.sentFileBinding('pty-1');
    expect(before).toMatchObject({ transcriptPath: first, agentSessionId: 'first-session' });

    // `/clear`: the new session starts before its transcript exists, so the
    // binding on file still names the previous one.
    harness.projector.nudge('pty-1', 'agent.session_start', 'second-session');
    expect(harness.projector.sentFileBinding('pty-1')).toBeNull();
    harness.projector.nudge('pty-1', 'agent.stop');
    expect(harness.projector.sentFileBinding('pty-1')).toBeNull();

    const second = write('second-session.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: second, ts: 2 }));
    const after = harness.projector.sentFileBinding('pty-1');
    expect(after).toMatchObject({ transcriptPath: second, agentSessionId: 'second-session' });
    expect(after?.generation).not.toBe(before?.generation);
  });

  it('keeps the binding on a resume of the same session, but still moves the generation', () => {
    const file = write('resumed.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const before = harness.projector.sentFileBinding('pty-1');
    harness.projector.nudge('pty-1', 'agent.session_start', 'resumed');
    const after = harness.projector.sentFileBinding('pty-1');
    expect(after).toMatchObject({ transcriptPath: file });
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
  });

  it('holds a session_start that names no session until the next stop', () => {
    const file = write('anon.jsonl');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.nudge('pty-1', 'agent.session_start');
    expect(harness.projector.sentFileBinding('pty-1')).toBeNull();
    harness.projector.nudge('pty-1', 'agent.activity');
    expect(harness.projector.sentFileBinding('pty-1')).toBeNull();
    harness.projector.nudge('pty-1', 'agent.stop');
    expect(harness.projector.sentFileBinding('pty-1')).toMatchObject({ transcriptPath: file });
  });
});

describe('snapshot — a huge non-conversation line before the answer (after /clear)', () => {
  const entry = (uuid: string, role: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: role, uuid, timestamp: '2026-10-07T00:00:00.000Z', message: { role, content, ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) }, ...extra });

  it('reads back past the oversized line so the post-clear rows are in the first page', () => {
    const file = path.join(harness.projects, '920b9112-1111-4222-8333-444455556677.jsonl');
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => entry(`old-${i}`, 'user', `older turn ${i}`)),
      entry('caveat', 'user', '<local-command-caveat>Caveat: generated by local commands</local-command-caveat>', { isMeta: true }),
      entry('clear', 'user', '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>'),
      entry('prompt', 'user', 'Reply with just ok.'),
      // A session-start attachment bigger than the whole tail window.
      JSON.stringify({ type: 'attachment', uuid: 'att', attachment: { type: 'skill_listing', content: 'x'.repeat(400 * 1024) } }),
      entry('answer', 'assistant', [{ type: 'text', text: 'ok' }]),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    harness.bindings.set('pane', binding({ transcriptPath: file }));

    const page = harness.projector.snapshot('pane')!;
    const kinds = page.events.map((e) => (e.kind === 'meta' ? `meta:${e.subtype}` : e.kind));
    expect(kinds.slice(-4)).toEqual(['meta:caveat', 'meta:slash_command', 'user_text', 'assistant_text']);
    expect(page.events.some((e) => e.kind === 'user_text' && e.text === 'Reply with just ok.')).toBe(true);
    // The whole (small) file fits, so the page reaches the start.
    expect(page.cursor.headOffset).toBe(0);
    expect(page.hasMore).toBe(false);
    // The tail cursor is still the end of the file.
    expect(page.cursor.tailOffset).toBe(fs.statSync(file).size);
  });

  it('keeps the head on a line boundary when the oversized line is all there is before the answer', () => {
    const file = path.join(harness.projects, '920b9112-1111-4222-8333-444455556688.jsonl');
    const big = JSON.stringify({ type: 'attachment', uuid: 'att', attachment: { type: 'skill_listing', content: 'y'.repeat(600 * 1024) } });
    fs.writeFileSync(file, big + '\n' + entry('answer', 'assistant', [{ type: 'text', text: 'ok' }]) + '\n');
    harness.bindings.set('pane', binding({ transcriptPath: file }));
    const page = harness.projector.snapshot('pane')!;
    expect(page.events.map((e) => e.kind)).toEqual(['assistant_text']);
    // The oversized line is read whole (it yields no rows), so the head moves
    // to its start, which is the start of the file.
    expect(page.cursor.headOffset).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it('an oversized line whose rows alone bust the budget does not empty the first page', () => {
    const file = path.join(harness.projects, '920b9112-1111-4222-8333-444455556699.jsonl');
    // 24 text blocks of 16 KB: past TAIL_BYTES on disk, past BUDGET_BYTES as rows.
    const blocks = Array.from({ length: 24 }, (_, i) => ({ type: 'text', text: `${i} ${'z'.repeat(16 * 1024)}` }));
    const big = entry('big', 'assistant', blocks);
    fs.writeFileSync(file, big + '\n' + entry('answer', 'assistant', [{ type: 'text', text: 'ok' }]) + '\n');
    harness.bindings.set('pane', binding({ transcriptPath: file }));
    const page = harness.projector.snapshot('pane')!;
    expect(page.events.some((e) => e.kind === 'assistant_text' && e.text === 'ok')).toBe(true);
  });
});

describe('TranscriptProjector — a WSL pane\'s transcript on its distro share', () => {
  const SID = '920b9112-1111-4222-8333-444455557777';
  const LINUX = `/home/dev/.claude/projects/-home-dev-repo/${SID}.jsonl`;
  let shareBase: string;
  let share: string;
  let file: string;
  let alive: boolean;
  let target: { distribution: string; user: string } | undefined;
  let boundId: string;
  let projector: TranscriptProjector;
  /** Every share access the proof makes, and every share-root lookup. */
  let proofCalls: string[];
  /** When set, every share call of the proof fails with this code. */
  let shareError: string | null;
  const appends: { data: TranscriptAppendData }[] = [];

  beforeEach(() => {
    // The harness folder stands in for `\\wsl$\Ubuntu`, laid out as the distro's filesystem.
    shareBase = fs.realpathSync.native(harness.dir);
    share = path.join(shareBase, 'Ubuntu');
    file = path.join(share, 'home', 'dev', '.claude', 'projects', '-home-dev-repo', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'claude-basic.jsonl'), file);
    alive = true;
    target = { distribution: 'Ubuntu', user: 'dev' };
    boundId = SID;
    proofCalls = [];
    shareError = null;
    appends.length = 0;
    const counted = <R>(name: string, fn: (p: string) => Promise<R>) => (p: string): Promise<R> => {
      proofCalls.push(`${name} ${p}`);
      return shareError ? Promise.reject(Object.assign(new Error(shareError), { code: shareError })) : fn(p);
    };
    projector = new TranscriptProjector({
      getResumeBinding: () => binding({ sessionId: boundId, wslTranscriptPath: LINUX.replace(SID, boundId) }),
      getWslTarget: () => target,
      isPaneAlive: () => alive,
      emitAppend: (_sessionId, data) => appends.push({ data }),
      debounceMs: 1,
      sharePollMs: 20,
      wslShare: {
        platform: 'win32',
        shareRoot: (distro) => { proofCalls.push(`shareRoot ${distro}`); return path.join(shareBase, distro); },
        fs: {
          realpath: counted('realpath', (p) => fs.promises.realpath(p)),
          lstat: counted('lstat', (p) => fs.promises.lstat(p)),
          stat: counted('stat', (p) => fs.promises.stat(p)),
        },
      },
    });
  });

  afterEach(() => {
    projector.dispose();
    vi.restoreAllMocks();
  });

  const available = () => vi.waitFor(() => expect(projector.status('pty-1').available).toBe(true), { timeout: 10_000 });

  it('serves the file once proven, with no proof per read; an async reader waits for the proof', async () => {
    // A synchronous read finds no proof yet: it starts one and does not wait.
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'no-transcript-path' });
    // An async reader waits for that proof and then reads.
    await projector.ready('pty-1');
    expect(projector.status('pty-1')).toMatchObject({ available: true, transcriptBasename: `${SID}.jsonl` });
    const proven = proofCalls.length;
    expect(projector.transcriptPath('pty-1')).toBe(file);
    expect(projector.snapshot('pty-1')?.events.map((e) => e.kind)).toContain('assistant_text');
    expect(proofCalls).toHaveLength(proven);
    // A nudge of a pane nobody watches only marks it due; its next read proves it again.
    projector.nudge('pty-1', 'agent.stop');
    expect(proofCalls).toHaveLength(proven);
    expect(projector.transcriptPath('pty-1')).toBe(file);
    await vi.waitFor(() => expect(proofCalls.length).toBeGreaterThan(proven), { timeout: 10_000 });
  });

  it('refuses at once when the pane\'s own target does not own the path', () => {
    target = { distribution: 'Ubuntu', user: 'other' };
    // Decided without the disk, so even the first read has the answer.
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'unsafe-transcript-path' });
    expect(projector.snapshot('pty-1')).toBeNull();
    expect(proofCalls.filter((c) => !c.startsWith('shareRoot'))).toEqual([]);
  });

  it('makes no share access at all for a pane whose process is gone, watched or not', async () => {
    projector.subscribe('c1', 'pty-1');
    await vi.waitFor(() => expect(appends.length).toBeGreaterThan(0), { timeout: 10_000 });
    alive = false;
    proofCalls = [];
    const synced: string[] = [];
    const underShare = (p: unknown) => typeof p === 'string' && p.toLowerCase().startsWith(shareBase.toLowerCase());
    for (const name of ['statSync', 'lstatSync', 'openSync', 'readFileSync', 'existsSync'] as const) {
      const original = fs[name] as (...args: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (underShare(args[0])) synced.push(`${name} ${String(args[0])}`);
        return original.apply(fs, args);
      }) as never);
    }
    // A second subscriber on the existing watch schedules a read at the cached
    // path; the poll keeps ticking; both must leave the share alone.
    projector.subscribe('c2', 'pty-1');
    await deliberateSleep(80, 'negative: a pending read and the poll stay off the share');
    // status, the summary's path lookup, a page, a delta, a nudge and a rebind.
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'unreadable' });
    expect(projector.transcriptPath('pty-1')).toBeNull();
    expect(projector.snapshot('pty-1')).toBeNull();
    expect(projector.delta('pty-1', 0)).toBeNull();
    projector.nudge('pty-1', 'agent.stop');
    projector.rebind('pty-1');
    await projector.ready('pty-1');
    await deliberateSleep(60, 'negative: no proof starts for a dead pane');
    expect(proofCalls).toEqual([]);
    expect(synced).toEqual([]);
  });

  it('drops the proven path at once when a refresh fails to prove it', async () => {
    projector.subscribe('c1', 'pty-1');
    await available();
    // The project folder becomes a junction to a folder outside the projects root.
    const outside = path.join(share, 'elsewhere');
    fs.renameSync(path.dirname(file), outside);
    fs.symlinkSync(outside, path.dirname(file), 'junction');
    projector.rebind('pty-1');
    await vi.waitFor(() => expect(projector.status('pty-1')).toEqual({ available: false, reason: 'unsafe-transcript-path' }), { timeout: 10_000 });
    expect(projector.transcriptPath('pty-1')).toBeNull();
    expect(projector.snapshot('pty-1')).toBeNull();
  });

  it('answers a share that does not answer as unreadable, never unsafe, and tries again later', async () => {
    shareError = 'EBUSY';
    await projector.ready('pty-1');
    expect(projector.status('pty-1')).toEqual({ available: false, reason: 'unreadable' });
    // The share answers again: the next read past one poll interval proves it.
    shareError = null;
    await vi.waitFor(async () => {
      await projector.ready('pty-1');
      expect(projector.status('pty-1').available).toBe(true);
    }, { timeout: 10_000 });
  });

  it('keeps the last good proof through a share that does not answer', async () => {
    projector.subscribe('c1', 'pty-1');
    await available();
    const proven = proofCalls.length;
    shareError = 'EIO';
    projector.rebind('pty-1');
    await vi.waitFor(() => expect(proofCalls.length).toBeGreaterThan(proven), { timeout: 10_000 });
    await deliberateSleep(10, 'the failed proof settles');
    expect(projector.transcriptPath('pty-1')).toBe(file);
    expect(projector.status('pty-1').reason).not.toBe('unsafe-transcript-path');
  });

  it('proves a transcript written after a pending proof before reading any of it', async () => {
    fs.rmSync(file);
    await projector.ready('pty-1');
    // Only the folder is proven: the path is not handed out, and reads are empty.
    expect(projector.status('pty-1').available).toBe(true);
    expect(projector.transcriptPath('pty-1')).toBeNull();
    expect(projector.snapshot('pty-1')?.events).toEqual([]);
    fs.copyFileSync(path.join(FIXTURES, 'claude-basic.jsonl'), file);
    const before = proofCalls.length;
    // The first read after the file appears reads nothing and proves it.
    expect(projector.snapshot('pty-1')?.events).toEqual([]);
    expect(proofCalls.length).toBeGreaterThan(before);
    await vi.waitFor(() => expect(projector.transcriptPath('pty-1')).toBe(file), { timeout: 10_000 });
    expect(projector.snapshot('pty-1')?.events.map((e) => e.kind)).toContain('assistant_text');
  });

  it('holds a /clear on a WSL pane that was never read', async () => {
    // No read yet, so no proof: the hold must come from the binding itself.
    projector.nudge('pty-1', 'agent.session_start', '920b9112-1111-4222-8333-444455558888');
    // The binding on file still names the previous conversation; once proven,
    // it must not be handed out as the new session's.
    await projector.ready('pty-1');
    expect(projector.transcriptPath('pty-1')).toBe(file);
    expect(projector.sentFileBinding('pty-1')).toBeNull();
    // Its own session start (a resume of the same one) holds nothing.
    projector.nudge('pty-1', 'agent.session_start', SID);
    expect(projector.sentFileBinding('pty-1')).toMatchObject({ agentSessionId: SID });
  });

  it('polls the share instead of watching it, and carries a live append', async () => {
    const watch = vi.spyOn(fs, 'watch');
    projector.subscribe('c1', 'pty-1');
    await vi.waitFor(() => expect(appends.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(watch).not.toHaveBeenCalled();
    const before = appends.length;
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant',
      uuid: 'wsl-live-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from the share' }] },
    }) + '\n');
    await vi.waitFor(() => {
      const rows = appends.slice(before).flatMap((a) => (a.data as { events: Array<{ kind: string; text?: string }> }).events);
      expect(rows.some((e) => e.kind === 'assistant_text' && e.text === 'from the share')).toBe(true);
    }, { timeout: 10_000 });
  });

  it('stops polling when the last subscriber leaves, the pane goes, or its process exits', async () => {
    const started = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const armed = async (session: string) => {
      const count = started.mock.calls.length;
      projector.subscribe('c1', session);
      await vi.waitFor(() => expect(started.mock.calls.length).toBe(count + 1), { timeout: 10_000 });
      expect(started.mock.calls[count][1]).toBe(20);
      return started.mock.results[count].value;
    };
    const first = await armed('pty-1');
    projector.unsubscribe('c1', 'pty-1');
    expect(cleared).toHaveBeenCalledWith(first);

    const second = await armed('pty-2');
    projector.dropPty('pty-2');
    expect(cleared).toHaveBeenCalledWith(second);

    const third = await armed('pty-3');
    alive = false;
    await vi.waitFor(() => expect(cleared).toHaveBeenCalledWith(third), { timeout: 10_000 });
  });
});

describe('TranscriptProjector — a Claude rewind (Esc Esc)', () => {
  const texts = (events: readonly { kind: string; text?: string }[]) =>
    events.filter((e) => e.kind === 'user_text' || e.kind === 'assistant_text').map((e) => e.text);
  /** Writes the first `head` lines of a fixture; `rest()` appends the others. */
  function staged(name: string, head: number): { file: string; rest: () => void } {
    const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
    const file = path.join(harness.projects, name);
    fs.writeFileSync(file, lines.slice(0, head).map((l) => l + '\n').join(''), 'utf8');
    return { file, rest: () => fs.appendFileSync(file, lines.slice(head).map((l) => l + '\n').join(''), 'utf8') };
  }

  it('drops the abandoned branch once the sibling prompt lands: delta answers a reset snapshot', () => {
    const { file, rest } = staged('rewind.jsonl', 6);
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const before = harness.projector.snapshot('pty-1')!;
    expect(texts(before.events)).toEqual(['first question', 'first answer', 'abandoned question', 'abandoned answer']);

    rest();
    const after = harness.projector.delta('pty-1', before.cursor.tailOffset, { cursorFileSize: before.cursor.fileSize })!;
    expect(after.reset).toBe(true);
    expect(texts(after.events)).toEqual(['first question', 'first answer', 'new question', 'new answer']);
    expect(texts(harness.projector.snapshot('pty-1')!.events)).toEqual(['first question', 'first answer', 'new question', 'new answer']);
  });

  it('pushes the rewind to a subscriber as a reset append', async () => {
    const { file, rest } = staged('rewind.jsonl', 6);
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    harness.projector.subscribe('c1', 'pty-1');
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length > 0);

    rest();
    harness.projector.nudge('pty-1', 'agent.stop');
    await waitFor(() => harness.appends.length > 1);
    const last = harness.appends[harness.appends.length - 1].data;
    expect(last.reset).toBe(true);
    expect(texts(last.events)).toEqual(['first question', 'first answer', 'new question', 'new answer']);
  });

  it('hides an abandoned run longer than one read window on every page', () => {
    const lines = fs.readFileSync(path.join(FIXTURES, 'rewind.jsonl'), 'utf8').split('\n').filter(Boolean);
    // The abandoned run's tool result outgrows the tail window, so the
    // abandoned prompt and the replacing one land in different pages.
    const big = JSON.parse(lines[4]) as { message: { content: Array<{ content: string }> } };
    big.message.content[0].content = 'x'.repeat(400 * 1024);
    lines[4] = JSON.stringify(big);
    const file = path.join(harness.projects, 'rewind-long.jsonl');
    fs.writeFileSync(file, lines.map((l) => l + '\n').join(''), 'utf8');
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));

    const seen: string[] = [];
    let page = harness.projector.snapshot('pty-1')!;
    for (let guard = 0; guard < 10; guard++) {
      seen.unshift(...texts(page.events).map(String));
      if (!page.hasMore) break;
      page = harness.projector.snapshot('pty-1', { before: page.cursor.headOffset })!;
    }
    expect(seen).toEqual(['first question', 'first answer', 'new question', 'new answer']);
  });

  it('keeps a chain across compact boundaries and parallel tool calls whole, and appends without a reset', () => {
    const { file, rest } = staged('compact-chain.jsonl', 15);
    harness.bindings.set('pty-1', binding({ transcriptPath: file }));
    const before = harness.projector.snapshot('pty-1')!;
    expect(texts(before.events)).toEqual(['run two things', 'both done', 'after the first compact', 'answer three', 'after the second compact', 'answer four']);
    expect(before.events.filter((e) => e.kind === 'tool_use')).toHaveLength(2);
    expect(before.events.filter((e) => e.kind === 'tool_result')).toHaveLength(2);

    rest();
    const after = harness.projector.delta('pty-1', before.cursor.tailOffset, { cursorFileSize: before.cursor.fileSize })!;
    expect(after.reset).toBe(false);
    expect(texts(after.events)).toEqual(['one more', 'answer five']);
  });
});
