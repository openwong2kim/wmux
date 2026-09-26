// `kind:'terminal_prompt'` — the agent's own terminal dialog, recorded so a
// phone knows the pane is blocked, and never answerable remotely.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, type ApprovalRegistryDeps } from '../ApprovalRegistry';
import { getApprovalStatePath } from '../approvalStore';
import { TERMINAL_PROMPT_COOLDOWN_MS } from '../terminalPrompt';
import { buildApprovalPushPayload } from '../../push/approvalPushPayload';
import type { ApprovalEvent, ApprovalRequest } from '../types';

let tmpDir: string;

interface Harness {
  registry: ApprovalRegistry;
  writes: Array<{ sessionId: string; data: string }>;
  screenReads: string[];
  events: ApprovalEvent[];
  clock: { now: number };
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const screenReads: string[] = [];
  const events: ApprovalEvent[] = [];
  const clock = { now: 1_000 };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async (sessionId) => {
      screenReads.push(sessionId);
      return [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    },
    writeToSession: (sessionId, data) => {
      writes.push({ sessionId, data });
      return true;
    },
    pressScope: () => ({ isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: true }),
    now: () => clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  registry.onEvent((e) => events.push(e));
  return { registry, writes, screenReads, events, clock };
}

const PROMPT = {
  sessionId: 'pty-a',
  agent: 'claude',
  workspaceId: 'ws-1',
  toolName: 'Bash',
  summary: 'rm -rf build/cache',
  source: 'detector' as const,
};

const pendingOf = (h: Harness): ApprovalRequest[] => h.registry.list().pending;
const creates = (h: Harness): ApprovalEvent[] => h.events.filter((e) => e.type === 'create');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-terminal-prompt-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('ApprovalRegistry — terminal_prompt creation', () => {
  it('records the dialog with its tool and summary, and nothing a phone could answer from', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    const [record] = pendingOf(h);
    expect(record).toEqual({
      id: 'req-1',
      sessionId: 'pty-a',
      workspaceId: 'ws-1',
      agent: 'claude',
      kind: 'terminal_prompt',
      toolName: 'Bash',
      summary: 'rm -rf build/cache',
      risk: 'critical',
      dialogKey: '-|-',
      createdAt: 1_000,
      state: 'pending',
    });
    expect(creates(h)).toHaveLength(1);
  });

  it('records a question-less dialog (the detector path) with no tool at all', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'openclaude', source: 'detector' });
    expect(pendingOf(h)).toMatchObject([{ kind: 'terminal_prompt', agent: 'openclaude' }]);
    expect(pendingOf(h)[0]).not.toHaveProperty('toolName');
    expect(pendingOf(h)[0]).not.toHaveProperty('summary');
  });

  it('is not created for an agent outside the Claude family', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt({ ...PROMPT, agent: 'codex' });
    expect(pendingOf(h)).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('is not created when the pane already has a pending record of any kind', async () => {
    const h = makeRegistry();
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'Which one?' });
    await h.registry.noteTerminalPrompt(PROMPT);
    expect(pendingOf(h).map((r) => r.kind)).toEqual(['awaiting_input']);

    const g = makeRegistry();
    g.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash' });
    await g.registry.noteTerminalPrompt(PROMPT);
    expect(pendingOf(g).map((r) => r.kind)).toEqual(['awaiting_permission']);

    const t = makeRegistry();
    await t.registry.noteTerminalPrompt(PROMPT);
    await t.registry.noteTerminalPrompt({ ...PROMPT, summary: 'something else' });
    expect(pendingOf(t)).toHaveLength(1);
    expect(creates(t)).toHaveLength(1);
  });

  it('a hook record supersedes it; it never supersedes a hook record', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'Which one?' });
    expect(pendingOf(h).map((r) => r.kind)).toEqual(['awaiting_input']);
    expect(h.registry.list().recentlyResolved).toMatchObject([{ kind: 'terminal_prompt', state: 'superseded' }]);

    const g = makeRegistry();
    await g.registry.noteTerminalPrompt(PROMPT);
    g.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash' });
    await g.registry.noteGateDeadline('req-2', 5_000);
    expect(pendingOf(g).map((r) => r.kind)).toEqual(['awaiting_permission']);
  });

  it('is not created inside the cooldown that follows a screen-cleared expiry', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    await h.registry.expireForSession('pty-a', 'screen-cleared', 'terminal_prompt');
    h.clock.now += TERMINAL_PROMPT_COOLDOWN_MS - 1;
    await h.registry.noteTerminalPrompt(PROMPT);
    expect(pendingOf(h)).toEqual([]);
    // Another pane is not affected.
    await h.registry.noteTerminalPrompt({ ...PROMPT, sessionId: 'pty-b' });
    expect(pendingOf(h).map((r) => r.sessionId)).toEqual(['pty-b']);
    h.clock.now += 1;
    await h.registry.noteTerminalPrompt(PROMPT);
    expect(pendingOf(h).map((r) => r.sessionId).sort()).toEqual(['pty-a', 'pty-b']);
  });

  it('a pane that goes away drops its cooldown with it (a reused id starts clean)', async () => {
    const h = makeRegistry();
    await h.registry.expireForSession('pty-a', 'screen-cleared', 'terminal_prompt');
    await h.registry.expireForSession('pty-a', 'pane-gone');
    await h.registry.noteTerminalPrompt(PROMPT);
    expect(pendingOf(h)).toHaveLength(1);
  });

  it('one push per awaiting episode while the dialog flaps', async () => {
    const h = makeRegistry();
    // Detector finds the dialog, the screen check clears it, again and again.
    for (let i = 0; i < 5; i++) {
      await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
      await h.registry.expireForSession('pty-a', 'screen-cleared', 'terminal_prompt');
      h.clock.now += 2_000;
    }
    const pushes = creates(h).map((e) => buildApprovalPushPayload(e.request));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ requiresInAppChoice: true });
  });
});

describe('ApprovalRegistry — terminal_prompt expiry', () => {
  it.each([
    ['turn-ended', undefined],
    ['session-start', undefined],
    ['pane-gone', undefined],
    ['screen-cleared', 'terminal_prompt'],
    ['answered-locally', 'terminal_prompt'],
  ] as const)('expires on %s', async (reason, kind) => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    await h.registry.expireForSession('pty-a', reason, kind);
    expect(pendingOf(h)).toEqual([]);
    expect(h.registry.list().recentlyResolved).toMatchObject([{ kind: 'terminal_prompt', state: 'expired' }]);
  });

  it('an answered-in-terminal sweep leaves an AskUserQuestion record alone', async () => {
    const h = makeRegistry();
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'Which one?' });
    await h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
    expect(pendingOf(h).map((r) => r.kind)).toEqual(['awaiting_input']);
  });

  it('a daemon restart invalidates it and keeps its kind, tool and summary', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    const reloaded = makeRegistry();
    expect(reloaded.registry.list().pending).toEqual([]);
    expect(reloaded.registry.list().recentlyResolved).toMatchObject([
      { id: 'req-1', kind: 'terminal_prompt', state: 'expired', toolName: 'Bash', summary: 'rm -rf build/cache' },
    ]);
  });

  it('a hand-edited file cannot invent a kind or an unbounded summary', async () => {
    fs.writeFileSync(getApprovalStatePath(tmpDir), JSON.stringify({
      version: 1,
      requests: [
        { id: 'a', sessionId: 's', agent: 'claude', createdAt: 1, state: 'expired', kind: 'root_shell' },
        { id: 'b', sessionId: 's', agent: 'claude', createdAt: 1, state: 'expired', kind: 'terminal_prompt',
          summary: `line\u0000one ${'x'.repeat(500)}` },
      ],
    }));
    const h = makeRegistry();
    const byId = new Map(h.registry.list().recentlyResolved.map((r) => [r.id, r]));
    expect(byId.get('a')?.kind).toBe('awaiting_input');
    expect(byId.get('b')?.kind).toBe('terminal_prompt');
    expect(byId.get('b')?.summary?.length).toBe(201);
    expect(byId.get('b')?.summary).not.toContain('\u0000');
  });
});

describe('ApprovalRegistry — terminal_prompt resolve', () => {
  it.each([
    ['approve', undefined],
    ['deny', undefined],
    ['approve', '1'],
  ] as const)('%s (choiceKey %s) is refused as answer-in-terminal and writes nothing', async (decision, choiceKey) => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    const result = await h.registry.resolve({
      id: 'req-1',
      decision,
      resolvedBy: 'phone',
      ...(choiceKey ? { choiceKey } : {}),
    });
    expect(result).toMatchObject({ ok: false, reason: 'answer-in-terminal', request: { state: 'pending' } });
    expect(h.writes).toEqual([]);
    expect(h.screenReads).toEqual([]);
    expect(pendingOf(h)).toHaveLength(1);
    // Nothing changed, so nothing was announced.
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  it('an automated press is refused the same way', async () => {
    const h = makeRegistry();
    await h.registry.noteTerminalPrompt(PROMPT);
    const result = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'brain', resolver: 'automated' });
    expect(result).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
    expect(h.writes).toEqual([]);
  });
});

describe('buildApprovalPushPayload — terminal_prompt', () => {
  const record = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id: 'ap-1',
    sessionId: 'sess-1',
    agent: 'claude',
    kind: 'terminal_prompt',
    createdAt: 1,
    state: 'pending',
    ...overrides,
  });

  it('never offers a lock-screen affirmative', () => {
    const payload = buildApprovalPushPayload(record({ toolName: 'Bash', summary: 'ls' }));
    expect(payload.requiresInAppChoice).toBe(true);
    // A client picks a category with no Deny/Reply for this kind.
    expect(payload.approvalKind).toBe('terminal_prompt');
    expect(payload).not.toHaveProperty('firstOption');
    expect(payload).toMatchObject({ approvalId: 'ap-1', sessionId: 'sess-1' });
  });

  it('says where the answer goes, naming the tool and its input', () => {
    expect(buildApprovalPushPayload(record({ toolName: 'Bash', summary: 'npm test' })).body)
      .toBe('Answer in Terminal: Bash — npm test');
    expect(buildApprovalPushPayload(record({ toolName: 'Write' })).body).toBe('Answer in Terminal: Write');
    expect(buildApprovalPushPayload(record()).body).toBe('Answer in Terminal: a pane is waiting on a prompt.');
  });

  it('reads an rm -rf summary as critical, an ordinary one as normal', () => {
    expect(buildApprovalPushPayload(record({ toolName: 'Bash', summary: 'rm -rf build/cache' })).risk).toBe('critical');
    expect(buildApprovalPushPayload(record({ toolName: 'Bash', summary: 'npm test' })).risk).toBe('normal');
  });
});
