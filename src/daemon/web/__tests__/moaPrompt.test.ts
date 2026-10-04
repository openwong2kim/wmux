// #1772 — the Moa pane's own permission dialog as a `terminal_prompt` record:
// created from main's pushed dialog, expired on every way the Moa pane or its
// dialog can go, and answered from the desktop behind the registry's fences.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../../approvals/ApprovalRegistry';
import type { ApprovalEvent } from '../../approvals/types';
import { MoaPromptSync } from '../moaPrompt';
import type { MoaPaneFact } from '../moaPane';

const DIALOG = [
  '● Bash(rm -rf build/cache)',
  '',
  '────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   rm -rf build/cache',
  '   Remove the build cache',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
];
const IDLE = ['● Done.', '', '> '];
// A WebFetch dialog as Claude Code draws it: no `Esc to cancel` footer, so the
// parser does not read it as active, yet it is up and owns the keyboard.
const FETCH = [
  '────────────────────────────────────────────────────────────',
  ' Fetch',
  '   Claude wants to fetch content from example.net',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '   url: https://example.net/',
  '   prompt: What is the page title?',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to allow Claude to fetch this content?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for example.net",
  '   3. No, and tell Claude what to do differently (esc)',
];
const INPUT = { command: 'rm -rf build/cache', description: 'Remove the build cache' };
const SID = 'brain-hq';

let tmpDir: string;

interface Harness {
  registry: ApprovalRegistry;
  sync: MoaPromptSync;
  fact: MoaPaneFact | null;
  resolves: boolean;
  rows: readonly string[] | null;
  mark: { bytes: number; keyInputRevision: number; incarnation: string };
  /** The pane's own Claude session (its bound transcript), or null (no transcript path yet). */
  agentSession: string | null;
  writes: Array<{ sessionId: string; data: string }>;
  events: ApprovalEvent[];
  clock: { now: number };
  /** Runs inside each screen read, before it answers. */
  duringRead: { fn: (() => void | Promise<void>) | null };
  push: (fact: MoaPaneFact | null) => void;
}

const pane = { meta: { env: { WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: 'ws-hq' } } };

function harness(): Harness {
  let next = 1;
  const h = {
    fact: null,
    resolves: true,
    rows: DIALOG,
    mark: { bytes: 100, keyInputRevision: 3, incarnation: 'inc-1' },
    agentSession: 'conv-1',
    writes: [],
    events: [],
    clock: { now: 10_000 },
    duringRead: { fn: null },
  } as unknown as Harness;
  h.registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (sessionId, data) => {
      h.writes.push({ sessionId, data });
      return true;
    },
    readPromptScreen: async () => {
      await h.duringRead.fn?.();
      return h.rows ? { rows: h.rows, mark: { ...h.mark } } : null;
    },
    promptScreenMark: () => ({ ...h.mark }),
    pendingToolUse: () => null,
    agentSessionId: () => h.agentSession,
    promptReadDelay: async () => undefined,
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
  });
  h.sync = new MoaPromptSync({
    registry: () => h.registry,
    current: () => h.fact,
    resolves: () => h.resolves,
    delay: async () => undefined,
  });
  h.registry.onEvent((e) => {
    h.events.push(e);
    h.sync.onApprovalEvent(e);
  });
  h.push = (fact) => {
    h.fact = fact;
    h.sync.onChanged(fact, fact && h.resolves ? pane : undefined);
  };
  return h;
}

const withDialog = (fingerprint = 'aa11', over: Partial<NonNullable<MoaPaneFact['dialog']>> = {}): MoaPaneFact => ({
  sessionId: SID,
  workspaceId: 'ws-hq',
  dialog: { fingerprint, toolName: 'Bash', toolInput: INPUT, hookSessionId: 'conv-1', toolUseId: 'toolu_1', promptId: 'p-1', ...over },
});
const noDialog = (sessionId = SID): MoaPaneFact => ({ sessionId, workspaceId: 'ws-hq' });

/** Lets the queued notes, expiries and screen checks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}
const pending = (h: Harness) => h.registry.list().pending;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-prompt-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('MoaPromptSync — the record follows main\'s dialog', () => {
  it('a dialog push raises ONE answerable terminal_prompt on the Moa pane; a repeat push raises nothing more', async () => {
    const h = harness();
    h.push(withDialog());
    await flush();
    h.push(withDialog());
    h.push({ ...withDialog(), binding: { agent: 'claude', sessionId: 'conv-1', cwd: '/b', ts: 2 } });
    await flush();
    const records = pending(h);
    expect(records).toHaveLength(1);
    // The pane's own session matched the hook's (via the Moa fact binding), so
    // the dialog is bound and its choices are there (amendment G).
    expect(records[0]).toMatchObject({
      sessionId: SID, kind: 'terminal_prompt', agent: 'claude', workspaceId: 'ws-hq', toolName: 'Bash',
      question: 'Do you want to proceed?', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(records[0]!.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(h.sync.view()).toMatchObject({ id: records[0]!.id, answerable: true, answered: false });
  });

  it('a binding without a transcript path (no own session known) gives a card nobody can answer remotely', async () => {
    const h = harness();
    h.agentSession = null;
    h.push(withDialog());
    await flush();
    const [record] = pending(h);
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('choices');
    expect(h.sync.view()).toMatchObject({ answerable: false });
  });

  it('a tool input main omitted (over 8 KB) gives an unanswerable card, never a cut binding', async () => {
    const h = harness();
    h.push(withDialog('aa11', { toolInput: undefined }));
    await flush();
    expect(pending(h)).toHaveLength(1);
    expect(h.sync.view()).toMatchObject({ answerable: false });
  });

  it.each([
    ['Moa off (null push)', (h: Harness) => h.push(null)],
    ['the HQ changed (another brain)', (h: Harness) => h.push(noDialog('brain-other'))],
    ['the pane no longer resolves', (h: Harness) => { h.resolves = false; h.push(withDialog()); }],
  ])('%s expires the card at once', async (_label, act) => {
    const h = harness();
    h.push(withDialog());
    await flush();
    expect(pending(h)).toHaveLength(1);
    act(h);
    await flush();
    expect(pending(h)).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  it('a new dialog (A → B) expires A, then raises B', async () => {
    const h = harness();
    h.push(withDialog('aa11'));
    await flush();
    const [a] = pending(h);
    h.rows = DIALOG.map((r) => r.replace(/build\/cache/g, 'dist'));
    h.push(withDialog('bb22', { toolInput: { command: 'rm -rf dist', description: 'Remove the build cache' } }));
    await flush();
    const records = pending(h);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).not.toBe(a!.id);
    expect(h.registry.list().recentlyResolved.find((r) => r.id === a!.id)?.state).toBe('expired');
  });

  it('dialog gone per main but still on screen (a subagent\'s PostToolUse) keeps the card; gone from the screen expires it', async () => {
    const h = harness();
    h.push(withDialog());
    await flush();
    h.push(noDialog());
    await flush();
    expect(pending(h)).toHaveLength(1);
    // A later push for the same no-dialog state does not look again; the
    // next dialog-gone transition does.
    h.push(withDialog());
    await flush();
    h.rows = IDLE;
    h.push(noDialog());
    await flush();
    expect(pending(h)).toHaveLength(0);
  });

  it('a card the screen kept, then answered in the terminal with no push, gives way to the next dialog', async () => {
    const h = harness();
    h.push(withDialog('aa11'));
    await flush();
    const [a] = pending(h);
    // A subagent's PostToolUse clears main's flag while A is still on screen.
    h.push(noDialog());
    await flush();
    expect(pending(h).map((r) => r.id)).toEqual([a!.id]);
    // A is answered in the terminal (no push: the flag is already clear); B opens.
    h.rows = DIALOG.map((r) => r.replace(/build\/cache/g, 'dist'));
    h.push(withDialog('bb22', { toolInput: { command: 'rm -rf dist', description: 'Remove the build cache' }, toolUseId: 'toolu_2' }));
    await flush();
    const records = pending(h);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).not.toBe(a!.id);
    expect(h.sync.view()).toMatchObject({ id: records[0]!.id, answerable: true });
  });

  it('the same dialog pushed again after its flag flickered keeps its one card', async () => {
    const h = harness();
    h.push(withDialog('aa11'));
    await flush();
    const [a] = pending(h);
    h.push(noDialog());
    await flush();
    h.push(withDialog('aa11'));
    await flush();
    expect(pending(h).map((r) => r.id)).toEqual([a!.id]);
  });

  it('main\'s flag cleared while a dialog the parser cannot read as active (WebFetch) is still up keeps the card', async () => {
    const h = harness();
    h.rows = FETCH;
    h.push(withDialog('ff01', { toolName: 'WebFetch', toolInput: { url: 'https://example.net/', prompt: 'What is the page title?' } }));
    await flush();
    expect(pending(h)).toHaveLength(1);
    expect(h.sync.view()).toMatchObject({ answerable: false });
    h.push(noDialog());
    await flush();
    // The pending record is also what keeps the Moa pane's raw-input fence up
    // (WebTerminalServer.terminalPromptBlocksInput) once main's flag is clear.
    expect(pending(h)).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(0);
  });

  it('one clear read between reads that show the dialog does not expire the card', async () => {
    const h = harness();
    h.push(withDialog());
    await flush();
    let reads = 0;
    h.duringRead.fn = () => { reads += 1; h.rows = reads % 2 === 1 ? IDLE : DIALOG; };
    h.push(noDialog());
    await flush();
    expect(reads).toBeGreaterThan(1);
    expect(pending(h)).toHaveLength(1);
  });

  it('an unreadable screen is not proof the dialog is gone', async () => {
    const h = harness();
    h.push(withDialog());
    await flush();
    h.rows = null;
    h.push(noDialog());
    await flush();
    expect(pending(h)).toHaveLength(1);
  });

  it('Moa off while the creation reads the screen → no record at all', async () => {
    const h = harness();
    let once = true;
    h.duringRead.fn = () => {
      if (!once) return;
      once = false;
      h.push(null);
    };
    h.push(withDialog());
    await flush();
    expect(pending(h)).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'create')).toHaveLength(0);
  });

  it('a push carrying no pane for another brain never raises a card there', async () => {
    const h = harness();
    h.resolves = false;
    h.push(withDialog());
    await flush();
    expect(pending(h)).toHaveLength(0);
  });
});

describe('MoaPromptSync — the desktop answer', () => {
  async function ready(h: Harness) {
    h.push(withDialog());
    await flush();
    const view = h.sync.view()!;
    expect(view.answerable).toBe(true);
    return view;
  }
  const answer = (h: Harness, view: { id: string; promptFingerprint?: string }, choiceKey = '1') =>
    h.sync.answer({ approvalId: view.id, choiceKey, promptFingerprint: view.promptFingerprint });

  it('inside the reflex delay → answer-too-soon, nothing written', async () => {
    const h = harness();
    const view = await ready(h);
    expect(await answer(h, view)).toEqual({ ok: false, reason: 'answer-too-soon' });
    expect(h.writes).toEqual([]);
  });

  it('presses the chosen option once as "desktop"; a second answer is refused', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    expect(await answer(h, view)).toEqual({ ok: true, state: 'pending' });
    expect(h.writes).toEqual([{ sessionId: SID, data: '1' }]);
    expect(pending(h)[0]).toMatchObject({ resolvedBy: 'desktop', selectedChoiceKey: '1', decision: 'approve' });
    expect(await answer(h, view)).toEqual({ ok: false, reason: 'already-answered' });
    expect(h.writes).toHaveLength(1);
  });

  it('a press is followed by a screen check: the dialog gone resolves the record', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    h.rows = IDLE;
    // The press re-proves the dialog on screen, so it is drawn for that read.
    h.duringRead.fn = () => { h.rows = DIALOG; h.duringRead.fn = () => { h.rows = IDLE; }; };
    expect(await answer(h, view, '2')).toMatchObject({ ok: true });
    await flush();
    expect(pending(h)).toHaveLength(0);
    expect(h.registry.list().recentlyResolved.find((r) => r.id === view.id)).toMatchObject({ state: 'resolved', decision: 'deny' });
  });

  it('Moa off before the answer → refused, no key', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    h.push(null);
    await flush();
    expect(await answer(h, view)).toEqual({ ok: false, reason: 'not-pending' });
    expect(h.writes).toEqual([]);
  });

  it('Moa off while the answer re-reads the screen → no key', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    h.duringRead.fn = () => { h.resolves = false; };
    const result = await answer(h, view);
    expect(result.ok).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('a dialog already declined in the terminal (Esc, no hook): the refused answer expires the card', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    h.rows = IDLE;
    expect(await answer(h, view)).toEqual({ ok: false, reason: 'prompt-changed' });
    await flush();
    expect(pending(h)).toHaveLength(0);
    expect(h.writes).toEqual([]);
  });

  it('refuses another pane\'s record, a malformed answer, and a choice that is not one of the record\'s', async () => {
    const h = harness();
    const view = await ready(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-other', agent: 'claude', source: 'detector' });
    const other = pending(h).find((r) => r.sessionId === 'pty-other')!;
    expect(await answer(h, { id: other.id, promptFingerprint: view.promptFingerprint })).toEqual({ ok: false, reason: 'not-pending' });
    expect(await h.sync.answer({ approvalId: view.id, choiceKey: '1' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await answer(h, view, '7')).toEqual({ ok: false, reason: 'invalid-choice' });
    expect(h.writes).toEqual([]);
  });
});
