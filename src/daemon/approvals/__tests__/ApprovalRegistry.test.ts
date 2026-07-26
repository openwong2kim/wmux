import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  RESOLVED_BY_MAX,
  sanitizeResolvedBy,
  type ApprovalRegistryDeps,
} from '../ApprovalRegistry';
import {
  getApprovalStatePath,
  RESOLVED_HISTORY_CAP,
  SCREEN_TAIL_ROWS,
  SCREEN_TAIL_ROW_CHARS,
} from '../approvalStore';
import { keystrokesForAgent, looksLikeApprovalPrompt } from '../approvalKeystrokes';
import { MAX_OPTIONS, MAX_OPTION_LABEL_CHARS, MAX_QUESTION_CHARS } from '../askUserQuestion';
import type { ApprovalEvent } from '../types';

let tmpDir: string;

/**
 * The screen a Claude Code AskUserQuestion select actually puts up: a framed
 * question with numbered options and the `❯` cursor on the highlighted one.
 * This is the ONLY shape the registry will press into.
 */
const PROMPT_ROWS = [
  '╭──────────────────────────────────────────╮',
  '│ Which approach should I take?            │',
  '│                                          │',
  '│ ❯ 1. Rewrite the parser                  │',
  '│   2. Patch the existing one              │',
  '╰──────────────────────────────────────────╯',
];

/** A pane that has moved on — numbered list, but no select on screen. */
const NO_PROMPT_ROWS = [
  'Here is what I found:',
  '  1. the cache was stale',
  '  2. the lock was never released',
  '$ ',
];

interface Harness {
  registry: ApprovalRegistry;
  writes: Array<{ sessionId: string; data: string }>;
  events: ApprovalEvent[];
  /** Swap what the next screen read returns (null = unreadable). */
  setScreen: (rows: string[] | null) => void;
  /** Gate the screen read so a test can hold a resolve mid-flight. */
  blockScreen: () => () => void;
  ids: { next: number };
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const events: ApprovalEvent[] = [];
  let screen: string[] | null = PROMPT_ROWS;
  let release: (() => void) | null = null;
  const ids = { next: 1 };
  let clock = 1_000;

  const deps: ApprovalRegistryDeps = {
    wmuxDir: tmpDir,
    readScreenTail: async () => {
      if (release) await new Promise<void>((resolve) => { release = resolve; });
      return screen;
    },
    writeToSession: (sessionId, data) => {
      writes.push({ sessionId, data });
      return true;
    },
    now: () => clock++,
    newId: () => `req-${ids.next++}`,
    ...overrides,
  };
  const registry = new ApprovalRegistry(deps);
  registry.onEvent((e) => events.push(e));
  return {
    registry,
    writes,
    events,
    setScreen: (rows) => { screen = rows; },
    blockScreen: () => {
      // Arm the gate; the returned function lets the held read through.
      release = () => undefined;
      return () => {
        const r = release;
        release = null;
        r?.();
      };
    },
    ids,
  };
}

/**
 * Create a request and WAIT for the mutation chain to settle it. The production
 * caller (HookIngest) deliberately does not wait — it is on the hook bridge's
 * 2 s budget — so the promise exists for exactly this.
 */
function awaitingInput(
  registry: ApprovalRegistry,
  sessionId = 'pty-a',
  agent = 'claude',
  extras: { question?: string; options?: string[] } = {},
): Promise<void> {
  return registry.noteHookAwaitingInput({ sessionId, agent, workspaceId: 'ws-1', ...extras });
}

/** Drain pending microtasks — enough to park a mutation at its first await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approvals-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('ApprovalRegistry — lifecycle', () => {
  it('a hook awaiting_input creates ONE pending request, listed with its pane and workspace', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(1);
    expect(recentlyResolved).toHaveLength(0);
    expect(pending[0]).toMatchObject({
      id: 'req-1',
      sessionId: 'pty-a',
      workspaceId: 'ws-1',
      agent: 'claude',
      kind: 'awaiting_input',
      state: 'pending',
    });
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  it('approve writes the mapped keystroke to the PTY exactly once and resolves', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(0);
    expect(recentlyResolved[0]).toMatchObject({
      id: 'req-1',
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'phone',
    });
    // The verified screen is kept on the record — the only evidence of what we
    // pressed into.
    expect(recentlyResolved[0].screenTail).toContain('❯ 1. Rewrite the parser');
    expect(h.events.map((e) => e.type)).toEqual(['create', 'resolve']);
  });

  it('deny sends ESC, never a carriage return', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    await h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'phone' });

    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '\x1b' }]);
  });

  it('an unknown id is not-found and writes nothing', async () => {
    const h = makeRegistry();
    const res = await h.registry.resolve({ id: 'nope', decision: 'approve', resolvedBy: 'phone' });
    expect(res).toEqual({ ok: false, reason: 'not-found' });
    expect(h.writes).toHaveLength(0);
  });

  it('a non-claude agent is unsupported-agent and stays PENDING for the desktop', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'codex');
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'unsupported-agent' });
    expect(h.writes).toHaveLength(0);
    // Refusing to press is not the same as killing the request: a human at the
    // desktop can still answer it.
    expect(h.registry.list().pending).toHaveLength(1);
  });
});

describe('ApprovalRegistry — supersede and expire', () => {
  it('a second awaiting_input on the same pane supersedes the first', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await awaitingInput(h.registry);
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('req-2');
    expect(recentlyResolved[0]).toMatchObject({ id: 'req-1', state: 'superseded' });
    expect(h.events.map((e) => e.type)).toEqual(['create', 'supersede', 'create']);
  });

  it('resolving a superseded request reports expired, not already-resolved', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect((res as { request: { state: string } }).request.state).toBe('superseded');
    expect(h.writes).toHaveLength(0);
  });

  it('a pane with a pending request only ever has one, across many prompts', async () => {
    const h = makeRegistry();
    for (let i = 0; i < 5; i++) {
      await awaitingInput(h.registry);
      await settle();
    }
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('expireForSession kills the pending request on THAT pane only', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a');
    await settle();
    await awaitingInput(h.registry, 'pty-b');
    await settle();

    await h.registry.expireForSession('pty-a', 'turn-ended');
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending.map((r) => r.sessionId)).toEqual(['pty-b']);
    expect(recentlyResolved[0]).toMatchObject({ sessionId: 'pty-a', state: 'expired' });
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  it('expiring a pane with nothing pending emits nothing', async () => {
    const h = makeRegistry();
    await h.registry.expireForSession('pty-a', 'pane-gone');
    await settle();
    expect(h.events).toHaveLength(0);
  });

  it('an expired request refuses to resolve and writes nothing', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await h.registry.expireForSession('pty-a', 'turn-ended');
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect(h.writes).toHaveLength(0);
  });
});

describe('ApprovalRegistry — CAS under concurrent resolvers', () => {
  it('two concurrent resolves: one wins, the loser gets already-resolved with the winner named', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    // Hold the FIRST resolve inside its screen read — the exact window where a
    // read-modify-write without a mutation chain would let both callers see
    // 'pending' and both write bytes.
    const letThrough = h.blockScreen();
    const first = h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone-a' });
    await settle();
    const second = h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'phone-b' });
    await settle();

    expect(h.writes).toHaveLength(0); // still parked in the verify
    letThrough();

    const [a, b] = await Promise.all([first, second]);

    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: 'already-resolved', resolvedBy: 'phone-a' });
    // The whole point: bytes hit the PTY exactly once, and they are the
    // WINNER's bytes.
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });

  it('five concurrent resolves produce exactly one write and four refusals', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: `phone-${i}` }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already-resolved')).toHaveLength(4);
    expect(h.writes).toHaveLength(1);
  });

  it('a supersede that lands while a resolve is parked cannot steal the pending record', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const letThrough = h.blockScreen();
    const resolving = h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    await settle();
    // A new prompt arrives mid-resolve. It must queue BEHIND the resolve, not
    // flip req-1 to 'superseded' underneath it — so it cannot be awaited here
    // (it will not settle until the resolve ahead of it releases the chain).
    const creating = awaitingInput(h.registry);
    await settle();
    letThrough();

    const res = await resolving;
    await creating;

    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
    const { pending, recentlyResolved } = h.registry.list();
    expect(pending.map((r) => r.id)).toEqual(['req-2']);
    expect(recentlyResolved.find((r) => r.id === 'req-1')?.state).toBe('resolved');
  });
});

describe('ApprovalRegistry — pre-write screen re-verify', () => {
  it('refuses with prompt-gone when the select is no longer on screen, and expires the request', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    h.setScreen(NO_PROMPT_ROWS);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
    // Refusal expires it: the same tap would just be refused again.
    expect(h.registry.list().pending).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual(['create', 'expire']);
    // The rejected screen is kept so a human can see WHY it was refused.
    expect(h.registry.list().recentlyResolved[0].screenTail).toContain('the lock was never released');
  });

  it('refuses when the screen cannot be read at all (no evidence is not evidence)', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    h.setScreen(null);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
  });

  it('refuses when the screen read throws', async () => {
    const h = makeRegistry({
      readScreenTail: async () => { throw new Error('headless parse blew up'); },
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
  });

  it('a pane that dies between the verify and the write does not report a delivery', async () => {
    const h = makeRegistry({ writeToSession: () => false });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.registry.list().pending).toHaveLength(0);
  });

  it('a throwing PTY write is a refusal, not an exception out of resolve', async () => {
    const h = makeRegistry({
      writeToSession: () => { throw new Error('stream destroyed'); },
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
  });
});

describe('ApprovalRegistry — persistence and recovery invalidation', () => {
  it('a restart expires every pending request it inherits', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a');
    await settle();
    await awaitingInput(first.registry, 'pty-b');
    await settle();
    expect(first.registry.list().pending).toHaveLength(2);

    // A new daemon reading the same data dir: the panes around it are being
    // recovered as brand-new PTYs, so nothing pending can still be answerable.
    const second = makeRegistry();
    await settle();

    expect(second.registry.list().pending).toHaveLength(0);
    expect(second.registry.list().recentlyResolved.map((r) => r.state)).toEqual([
      'expired',
      'expired',
    ]);
  });

  it('an inherited-then-expired request refuses to resolve after the restart', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);
    await settle();

    const second = makeRegistry();
    const res = await second.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
    });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect(second.writes).toHaveLength(0);
  });

  it('resolved history survives a restart (so the 409 UX can still name the winner)', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);
    await settle();
    await first.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone-a' });

    const second = makeRegistry();
    const res = await second.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone-b',
    });

    expect(res).toMatchObject({ ok: false, reason: 'already-resolved', resolvedBy: 'phone-a' });
  });

  it('a corrupt approvals.json degrades to an empty registry rather than throwing', async () => {
    fs.writeFileSync(getApprovalStatePath(tmpDir), '{ this is not json', 'utf-8');
    const h = makeRegistry();
    expect(h.registry.list().pending).toHaveLength(0);
    // …and it still works from there.
    await awaitingInput(h.registry);
    await settle();
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('terminal history is capped so a long-lived daemon cannot grow the file forever', async () => {
    const h = makeRegistry();
    for (let i = 0; i < RESOLVED_HISTORY_CAP + 10; i++) {
      await awaitingInput(h.registry, `pty-${i}`);
      await settle();
      await h.registry.expireForSession(`pty-${i}`, 'turn-ended');
      await settle();
    }
    expect(h.registry.list().recentlyResolved.length).toBeLessThanOrEqual(RESOLVED_HISTORY_CAP);
  });

  it('list() hands out copies — a caller cannot mutate registry state', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    h.registry.list().pending[0].state = 'resolved';

    expect(h.registry.list().pending[0].state).toBe('pending');
  });
});

describe('A4 — the question a request is asking', () => {
  const asked = { question: 'Which file should I delete?', options: ['src/old.ts', 'src/older.ts'] };

  it('carries the question and options onto the pending record', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    expect(h.registry.list().pending[0]).toMatchObject(asked);
  });

  it('survives a restart on the (now expired) history record', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a', 'claude', asked);

    const second = makeRegistry();
    await settle();

    expect(second.registry.list().recentlyResolved[0]).toMatchObject({
      state: 'expired',
      ...asked,
    });
  });

  it('the options ARRAY is copied, not shared — a consumer cannot edit registry state', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    h.registry.list().pending[0].options?.push('rm -rf /');
    h.registry.list().pending[0].options?.reverse();

    expect(h.registry.list().pending[0].options).toEqual(asked.options);
  });

  it('the event payload is copied too', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    (h.events[0].request.options as string[]).push('rm -rf /');

    expect(h.registry.list().pending[0].options).toEqual(asked.options);
  });

  it('a request with no question is still created and still resolvable', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);

    expect(h.registry.list().pending[0].question).toBeUndefined();
    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    expect(res.ok).toBe(true);
  });

  it('a hand-edited oversized question is re-truncated on read-back', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);

    // Simulate a hand-edit / an older build with looser caps.
    const file = getApprovalStatePath(tmpDir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.requests[0].question = 'z'.repeat(10_000);
    raw.requests[0].options = Array.from({ length: 200 }, () => 'w'.repeat(500));
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const second = makeRegistry();
    const record = second.registry.list().recentlyResolved[0];

    expect(record.question?.length).toBeLessThanOrEqual(MAX_QUESTION_CHARS);
    expect(record.options?.length).toBeLessThanOrEqual(MAX_OPTIONS);
    expect(record.options?.[0].length).toBeLessThanOrEqual(MAX_OPTION_LABEL_CHARS);
  });
});

describe('risk hint — a UI step-up signal, never a gate', () => {
  it('flags a question that names a destructive action', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'Run `rm -rf build/` to clear the output?',
    });

    expect(h.registry.list().pending[0].risk).toBe('critical');
    expect(h.events[0].request.risk).toBe('critical');
  });

  it('flags on an OPTION label too — the danger can live in the answer, not the question', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'How should I clean up?',
      options: ['Leave it', 'DROP TABLE sessions'],
    });

    expect(h.registry.list().pending[0].risk).toBe('critical');
  });

  it('is absent — not null, not "safe" — on an ordinary question', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'Which approach should I take?',
      options: ['Rewrite the parser', 'Patch the existing one'],
    });

    expect('risk' in h.registry.list().pending[0]).toBe(false);
  });

  it('★ never blocks an answer — a flagged request resolves like any other', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', { question: 'git push --force to main?' });

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('survives a restart, and a hand-edited value outside the closed set is dropped', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a', 'claude', { question: 'terraform destroy prod?' });

    const second = makeRegistry();
    await settle();
    expect(second.registry.list().recentlyResolved[0].risk).toBe('critical');

    const file = getApprovalStatePath(tmpDir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.requests[0].risk = 'apocalyptic';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const third = makeRegistry();
    expect(third.registry.list().recentlyResolved[0].risk).toBeUndefined();
  });
});

describe('keystroke map v1', () => {
  it('claude maps approve to the first option and deny to ESC', () => {
    expect(keystrokesForAgent('claude')).toEqual({ approve: '1', deny: '\x1b' });
  });

  it('neither keystroke carries a carriage return', () => {
    const keys = keystrokesForAgent('claude');
    expect(keys?.approve).not.toContain('\r');
    expect(keys?.deny).not.toContain('\r');
  });

  it('every other agent is unmapped rather than guessed at', () => {
    for (const slug of ['codex', 'gemini', 'opencode', 'openclaude', 'aider', '']) {
      expect(keystrokesForAgent(slug)).toBeNull();
    }
  });
});

describe('looksLikeApprovalPrompt', () => {
  it('accepts a cursor-marked option row, framed or bare', () => {
    expect(looksLikeApprovalPrompt(PROMPT_ROWS)).toBe(true);
    expect(looksLikeApprovalPrompt(['❯ 1. Yes'])).toBe(true);
    expect(looksLikeApprovalPrompt(['  > 2) Patch it'])).toBe(true);
  });

  it('rejects a numbered list with no selection cursor', () => {
    expect(looksLikeApprovalPrompt(NO_PROMPT_ROWS)).toBe(false);
  });

  it('rejects an empty or blank screen', () => {
    expect(looksLikeApprovalPrompt([])).toBe(false);
    expect(looksLikeApprovalPrompt(['', '   ', ''])).toBe(false);
  });

  it('rejects a cursor with no option behind it', () => {
    expect(looksLikeApprovalPrompt(['❯ '])).toBe(false);
    expect(looksLikeApprovalPrompt(['❯ 1.'])).toBe(false);
  });
});

describe('resolve durability', () => {
  it('reports durable:true on the normal path', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    expect(res).toMatchObject({ ok: true, durable: true });
  });

  it('still resolves, but says so, when the write cannot land', async () => {
    // A wmuxDir that is a FILE: every write under it fails at mkdir. Chosen over
    // making the state file a directory, which atomicWriteJSON survives — it
    // renames the existing target aside before writing.
    const notADir = path.join(tmpDir, 'blocked');
    fs.writeFileSync(notADir, 'not a directory', 'utf8');
    const h = makeRegistry({ wmuxDir: notADir });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    // ok:true is not a lie — the keystroke IS in the terminal, and the caller
    // must not retry. What failed is the record of it.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.durable).toBe(false);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });
});

describe('resolvedBy sanitation', () => {
  it('strips control characters and bounds the length', () => {
    // Persisted per record, interpolated into a daemon log line, and echoed to
    // the loser of a race — so a newline is log injection and an unbounded
    // string is file growth.
    const LF = String.fromCharCode(0x0a);
    const CR = String.fromCharCode(0x0d);
    const NUL = String.fromCharCode(0x00);
    expect(sanitizeResolvedBy(`deck${LF}FAKE LOG LINE`)).toBe('deck FAKE LOG LINE');
    expect(sanitizeResolvedBy(`a${CR}${LF}b${NUL}c`)).toBe('a b c');
    expect(sanitizeResolvedBy('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeResolvedBy('x'.repeat(5_000))).toHaveLength(RESOLVED_BY_MAX);
    expect(sanitizeResolvedBy(undefined)).toBe('');
    expect(sanitizeResolvedBy({ evil: true })).toBe('');
  });

  it('applies at the chokepoint, so no caller can bypass it', async () => {
    const { registry: reg } = makeRegistry();
    await reg.noteHookAwaitingInput({ sessionId: 'p1', agent: 'claude' });
    const id = reg.list().pending[0].id;

    const out = await reg.resolve({
      id,
      decision: 'approve',
      resolvedBy:
        'deck' + String.fromCharCode(0x0d) + String.fromCharCode(0x0a) + 'y'.repeat(5_000),
    });

    expect(out.ok).toBe(true);
    const stored = reg.list().recentlyResolved[0].resolvedBy ?? '';
    expect(stored.length).toBeLessThanOrEqual(RESOLVED_BY_MAX);
    expect(stored.includes(String.fromCharCode(0x0d))).toBe(false);
    expect(stored.includes(String.fromCharCode(0x0a))).toBe(false);
  });
it('logs the SANITIZED label, not the raw parameter', async () => {
    // Sanitizing only what gets STORED left the log line taking a CR/LF
    // straight from the caller — clean on disk, forged in the log, which is
    // the injection the sanitizer exists to prevent.
    const lines: string[] = [];
    const { registry: reg } = makeRegistry({
      log: (_level: string, message: string) => { lines.push(message); },
    });
    await reg.noteHookAwaitingInput({ sessionId: 'p1', agent: 'claude' });
    const id = reg.list().pending[0].id;

    const LF = String.fromCharCode(0x0a);
    await reg.resolve({
      id,
      decision: 'approve',
      resolvedBy: 'deck' + LF + '[approvals] approve FORGED on p9 by nobody',
    });

    const resolveLine = lines.find((l: string) => l.includes('[approvals] approve'));
    expect(resolveLine).toBeDefined();
    expect((resolveLine ?? "").includes(LF)).toBe(false);
    expect(resolveLine).toContain('deck [approvals] approve FORGED');
  });

  it('bounds a persisted label and screen tail on the way back IN', async () => {
    // approvals.json is plain JSON on disk. Sanitizing only on write left a
    // hand-edited record able to come back unbounded.
    const dir = tmpDir;
    const huge = 'z'.repeat(10_000);
    fs.writeFileSync(
      getApprovalStatePath(dir),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: 'r1',
            sessionId: 'p1',
            agent: 'claude',
            kind: 'awaiting_input',
            createdAt: 1,
            state: 'resolved',
            resolvedBy: huge,
            screenTail: Array.from({ length: 500 }, () => huge).join('\n'),
          },
        ],
      }),
      'utf8',
    );

    const { registry: reg } = makeRegistry();
    const record = reg.list().recentlyResolved[0];
    const resolvedBy = record.resolvedBy ?? '';
    const screenTail = record.screenTail ?? '';
    expect(resolvedBy.length).toBeLessThanOrEqual(RESOLVED_BY_MAX);
    expect(screenTail.split('\n')).toHaveLength(SCREEN_TAIL_ROWS);
    for (const row of screenTail.split('\n')) {
      expect(row.length).toBeLessThanOrEqual(SCREEN_TAIL_ROW_CHARS);
    }
  });
});
