import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  codexConversationLooksEmpty,
  commandOnCursorRow,
  FreshContextBusy,
  FreshContextTimeout,
  runFreshContext,
  withFreshContextLock,
  type FreshContextAgentState,
  type FreshContextProbe,
} from '../freshContext';
import type { SessionStartReceipt } from '../../../../shared/hooks/HookSignalRouter';
import type { RoleBinding } from '../../../../shared/orchestratorRole';

const CLAUDE_IDLE = [
  ' ▐▛███▜▌   Claude Code v9.9.9',
  '',
  '> previous task output',
  '',
  '────────────────────────────',
  '> ',
].join('\n');
const CLAUDE_CLEARED = ['────────────────────────────', '> Try "fix the build"'].join('\n');
const CODEX_IDLE = ['│ >_ OpenAI Codex (v0.158.0) │', '', '› the previous task', '', '• did the previous task', '', '› '].join('\n');
const CODEX_EMPTY = ['╭──────────────────────────────╮', '│ >_ OpenAI Codex (v0.158.0) │', '╰──────────────────────────────╯', '', '  To get started, describe a task', '', '› '].join('\n');
const CODEX_NEW = ['│ >_ OpenAI Codex (v0.158.0) │', '', '› Ask Codex to do anything'].join('\n');

interface ScriptOptions {
  agent?: string | null;
  status?: string;
  inputQuiet?: boolean;
  mirror?: string | null;
  screen?: string;
  /** Screen after the command's Enter has been processed. */
  cleared?: string;
  /** ms after Enter at which the pane shows `cleared`. */
  clearMs?: number;
  /** Fire a SessionStart (with this source) when the clear lands. */
  sessionStartSource?: string | null;
  /** A SessionStart receipt already on record before the send. */
  priorReceipt?: SessionStartReceipt;
  /** Text the composer already holds (a draft) before the command. */
  draft?: string;
  /** Never echo typed text. */
  noEcho?: boolean;
  /** Extra input revisions to add on the command write (someone typing). */
  extraTypingRevisions?: number;
  /** Mutate the state this many ms after Enter. */
  afterEnter?: { ms: number; patch: Partial<FreshContextAgentState> };
  /** Report awaiting_input until this many ms after Enter. */
  awaitingUntilMs?: number;
  /** false = an older daemon without the key-only counter and flags. */
  keyCounter?: boolean;
  /** The daemon's key-only quiet flag. */
  keyInputQuiet?: boolean;
  /** The daemon's flag: the current agent's hooks have reported. */
  hookReports?: boolean;
  /** A pointer moving over the pane: every state read sees one more focus or
   *  motion report (the all-writes counter moves, the key counter does not). */
  pointerMoving?: boolean;
}

function scriptedPane(o: ScriptOptions = {}) {
  let clock = 1_000_000;
  const writes: string[] = [];
  const state: FreshContextAgentState = {
    agentName: o.agent === undefined ? 'Claude Code' : o.agent,
    agentVerified: true,
    agentStatus: o.status ?? 'idle',
    inputQuiet: o.inputQuiet ?? true,
    inputRevision: 10,
    incarnationId: 'inc-1',
    ...(o.keyCounter === false
      ? {}
      : { keyInputRevision: 10, keyInputQuiet: o.keyInputQuiet ?? true }),
    ...(o.hookReports !== undefined ? { hookReports: o.hookReports } : {}),
  };
  let screen = o.screen ?? CLAUDE_IDLE;
  let receipt: SessionStartReceipt | undefined = o.priorReceipt;
  let enterAt: number | undefined;
  let composer = o.draft ?? '';
  const base = screen;
  const withRow = (row: string): string => {
    const lines = base.split('\n');
    lines[lines.length - 1] = row;
    return lines.join('\n');
  };
  const glyph = (o.screen ?? CLAUDE_IDLE).includes('OpenAI Codex') ? '› ' : '> ';
  if (composer) screen = withRow(`${glyph}${composer}`);

  const tick = (): void => {
    if (enterAt === undefined) return;
    const since = clock - enterAt;
    if (since >= (o.clearMs ?? 500) && screen !== (o.cleared ?? CLAUDE_CLEARED)) {
      screen = o.cleared ?? CLAUDE_CLEARED;
      if (o.sessionStartSource !== null && o.sessionStartSource !== undefined) {
        receipt = { at: clock, agent: state.agentName === 'Codex CLI' ? 'codex' : 'claude', source: o.sessionStartSource };
      }
    }
    if (o.afterEnter && since >= o.afterEnter.ms) Object.assign(state, o.afterEnter.patch);
    state.agentStatus = o.awaitingUntilMs !== undefined && since < o.awaitingUntilMs ? 'awaiting_input' : state.agentStatus === 'awaiting_input' ? 'idle' : state.agentStatus;
  };

  const probe: FreshContextProbe = {
    readAgentState: async () => {
      tick();
      if (o.pointerMoving) state.inputRevision += 1;
      return state.agentName === undefined ? null : { ...state };
    },
    readMirrorStatus: async () => o.mirror ?? null,
    readScreen: async () => {
      tick();
      return screen;
    },
    readSessionStart: () => receipt,
    write: (data) => {
      writes.push(data);
      state.inputRevision += 1;
      if (state.keyInputRevision !== undefined) state.keyInputRevision += 1;
      if (data === '\r') {
        enterAt = clock;
        return;
      }
      if (data.startsWith('\x7f')) {
        composer = composer.slice(0, composer.length - data.length);
      } else {
        composer += data;
        state.inputRevision += o.extraTypingRevisions ?? 0;
        if (state.keyInputRevision !== undefined) state.keyInputRevision += o.extraTypingRevisions ?? 0;
      }
      if (!o.noEcho) screen = withRow(`${glyph}${composer}`);
    },
  };
  return {
    probe,
    writes,
    state,
    opts: {
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

const CLAUDE: RoleBinding = { agent: 'claude', freshContext: true };
const CODEX: RoleBinding = { agent: 'codex', freshContext: true };

describe('commandOnCursorRow', () => {
  it('tells an empty composer from a draft', () => {
    expect(commandOnCursorRow('x\n│ > /clear      │', '/clear')).toBe('alone');
    expect(commandOnCursorRow('x\n› /new', '/new')).toBe('alone');
    expect(commandOnCursorRow('x\n❯ /clear', '/clear')).toBe('alone');
    expect(commandOnCursorRow('x\n> fix the bug/clear', '/clear')).toBe('with_draft');
    // A continuation row of a multi-line draft has no prompt glyph.
    expect(commandOnCursorRow('> line one\n  /clear', '/clear')).toBe('with_draft');
    expect(commandOnCursorRow('x\n> /clear trailing', '/clear')).toBe('with_draft');
    expect(commandOnCursorRow('> /clear\n> ', '/clear')).toBe('absent');
  });

  // Composer rows as real captures draw them (src/daemon/approvals/__tests__/
  // fixtures/terminal-prompts), with the command typed in. Claude Code 2.1.283
  // draws its `❯` row between rules; in claude-ask-single-03 the row reads
  // `❯ make the button blue`, but that is a PROMPT SUGGESTION (ghost text after
  // the caret at column 2, keysSent "3"), not typed input. Typing replaces the
  // suggestion, so the typed row is `❯ /clear`. Codex 0.157.1: `› CMD one`.
  it('reads the real composer row shapes', () => {
    const rule = '─'.repeat(100);
    const claude = ['  ◐ medium · /effort', rule, '❯ /clear'].join('\n');
    expect(commandOnCursorRow(claude, '/clear')).toBe('alone');
    // A real draft (typed text) before the command, in the same row shape.
    // The read is plain text: ghost text left NEXT TO a typed command would
    // read the same way, and is conservatively treated as a draft too.
    expect(commandOnCursorRow([rule, '❯ make the button blue/clear'].join('\n'), '/clear')).toBe('with_draft');
    expect(commandOnCursorRow([rule, '❯'].join('\n'), '/clear')).toBe('absent');
    // After the clear, a fresh suggestion on the empty composer is not the command.
    expect(commandOnCursorRow([rule, '❯ make the button blue'].join('\n'), '/clear')).toBe('absent');
    expect(commandOnCursorRow(['• Running touch out.txt', '', '› /new'].join('\n'), '/new')).toBe('alone');
    expect(commandOnCursorRow(['› CMD one/new'].join('\n'), '/new')).toBe('with_draft');
  });
});

describe('runFreshContext — not_bound / skipped before anything is typed', () => {
  it('not_bound without a binding, without the opt-in, or for an agent with no command', async () => {
    for (const binding of [undefined, { agent: 'claude' }, { agent: 'agy', freshContext: true }, { freshContext: true }]) {
      const pane = scriptedPane();
      const out = await runFreshContext(binding as RoleBinding | undefined, pane.probe, pane.opts);
      expect(out.freshContext).toBe('not_bound');
      expect(pane.writes).toEqual([]);
    }
  });

  it('skipped_unobservable when the daemon has no state or the screen is unreadable', async () => {
    const noState = scriptedPane();
    noState.probe.readAgentState = async () => null;
    expect((await runFreshContext(CLAUDE, noState.probe, noState.opts)).freshContext).toBe('skipped_unobservable');
    const blind = scriptedPane();
    blind.probe.readScreen = async () => '';
    const out = await runFreshContext(CLAUDE, blind.probe, blind.opts);
    expect(out).toMatchObject({ freshContext: 'skipped_unobservable', freshContextReason: expect.stringMatching(/^screen_unreadable/) });
    expect(blind.writes).toEqual([]);
  });

  it('skipped_mismatch names the live agent and agentVerified', async () => {
    const pane = scriptedPane({ agent: 'Codex CLI' });
    pane.state.agentVerified = false;
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out.freshContext).toBe('skipped_mismatch');
    expect(out.freshContextReason).toContain('"codex"');
    expect(out.freshContextReason).toContain('agentVerified: false');
    expect(pane.writes).toEqual([]);
    const none = scriptedPane({ agent: null });
    expect((await runFreshContext(CLAUDE, none.probe, none.opts)).freshContext).toBe('skipped_mismatch');
  });

  it('skipped_busy when the agent works, input is active, or the renderer shows it busy', async () => {
    for (const o of [{ status: 'running' }, { status: 'awaiting_input' }, { keyInputQuiet: false }, { mirror: 'running' }]) {
      const pane = scriptedPane(o);
      const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
      expect(out.freshContext).toBe('skipped_busy');
      expect(pane.writes).toEqual([]);
    }
  });

  // Review P1-A: agents turn on focus and any-motion mouse reporting, so the
  // all-writes counter moves whenever the pointer crosses the pane.
  it('a pointer over the pane is not someone typing; an older daemon stays conservative', async () => {
    const pointer = scriptedPane({ inputQuiet: false, pointerMoving: true, sessionStartSource: null });
    expect((await runFreshContext(CLAUDE, pointer.probe, pointer.opts)).freshContext).toBe('applied');
    const oldDaemon = scriptedPane({ inputQuiet: false, keyCounter: false });
    expect(await runFreshContext(CLAUDE, oldDaemon.probe, oldDaemon.opts)).toMatchObject({
      freshContext: 'skipped_busy',
      freshContextReason: expect.stringMatching(/^input_active/),
    });
  });

  it('asks a keepContext function only when the role asks for fresh context', async () => {
    let asked = 0;
    const keepContext = async () => {
      asked++;
      return 'a2a_tasks_unknown' as const;
    };
    const unbound = scriptedPane();
    const notBound = await runFreshContext({ agent: 'claude' }, unbound.probe, { ...unbound.opts, keepContext });
    expect(notBound.freshContext).toBe('not_bound');
    expect(asked).toBe(0);
    const bound = scriptedPane();
    expect(await runFreshContext(CLAUDE, bound.probe, { ...bound.opts, keepContext })).toMatchObject({
      freshContext: 'skipped_busy',
      freshContextReason: expect.stringMatching(/^a2a_tasks_unknown/),
    });
    expect(asked).toBe(1);
    expect(bound.writes).toEqual([]);
  });
});

describe('runFreshContext — the typed command', () => {
  it('erases the command and skips when the composer held a draft', async () => {
    const pane = scriptedPane({ draft: 'half-written thought' });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toMatchObject({ freshContext: 'skipped_busy', freshContextReason: expect.stringMatching(/^draft_in_composer/) });
    expect(pane.writes).toEqual(['/clear', '\x7f'.repeat(6)]);
    expect(pane.writes).not.toContain('\r');
  });

  // Review P3-4: erasing after a human keystroke would delete THEIR last
  // characters and leave a fragment such as `/c` for the task to land on.
  it('fails with nothing more written when someone typed alongside the command', async () => {
    const pane = scriptedPane({ extraTypingRevisions: 1 });
    const err = await runFreshContext(CLAUDE, pane.probe, pane.opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreshContextTimeout);
    expect(err).toMatchObject({ code: 'input_interleaved' });
    expect((err as Error).message).toMatch(/nothing further was written/);
    expect(pane.writes).toEqual(['/clear']);
  });

  it('an older daemon cannot tell a key from a pointer, so it erases and skips as before', async () => {
    const pane = scriptedPane({ extraTypingRevisions: 1, keyCounter: false });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toMatchObject({ freshContext: 'skipped_busy', freshContextReason: expect.stringMatching(/^input_interleaved/) });
    expect(pane.writes).toEqual(['/clear', '\x7f'.repeat(6)]);
  });

  it('erases the command when it never shows on the cursor row', async () => {
    const pane = scriptedPane({ noEcho: true });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toMatchObject({ freshContext: 'skipped_unobservable', freshContextReason: expect.stringMatching(/^command_not_seen/) });
    expect(pane.writes).toEqual(['/clear', '\x7f'.repeat(6)]);
  });
});

describe('runFreshContext — evidence after Enter', () => {
  it('claude with hooks: applied on the SessionStart(clear) hook', async () => {
    const pane = scriptedPane({
      priorReceipt: { at: 1, agent: 'claude', source: 'startup' },
      sessionStartSource: 'clear',
    });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toEqual({ freshContext: 'applied', freshContextCommand: '/clear', freshContextSignal: 'session_start' });
    expect(pane.writes).toEqual(['/clear', '\r']);
  });

  // Review P1-B: a receipt from an earlier run of claude in this pane, and a
  // relaunch whose hooks never reach wmux. The hook is preferred, never
  // required: after the grace window the settled screen is taken.
  it('claude relaunched without hooks: waits out the grace window, then takes the screen', async () => {
    const pane = scriptedPane({ priorReceipt: { at: 1, agent: 'claude', source: 'startup' }, sessionStartSource: null });
    const started = pane.opts.now();
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toMatchObject({
      freshContext: 'applied',
      freshContextSignal: 'screen',
      freshContextReason: expect.stringMatching(/^session_start_missing/),
    });
    const elapsed = pane.opts.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(500 + 300 + 2_500);
    expect(elapsed).toBeLessThan(8_000);
    expect(pane.writes).toEqual(['/clear', '\r']);
  });

  it("does not wait for the hook when the daemon says the current agent's hooks never reported", async () => {
    const pane = scriptedPane({
      priorReceipt: { at: 1, agent: 'claude', source: 'startup' }, sessionStartSource: null, hookReports: false,
    });
    const started = pane.opts.now();
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toEqual({ freshContext: 'applied', freshContextCommand: '/clear', freshContextSignal: 'screen' });
    expect(pane.opts.now() - started).toBeLessThan(2_000);
  });

  it('a compact receipt is not evidence', async () => {
    const pane = scriptedPane({ priorReceipt: { at: 1, agent: 'claude', source: 'startup' }, sessionStartSource: 'compact' });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toMatchObject({ freshContextSignal: 'screen', freshContextReason: expect.stringMatching(/^session_start_missing/) });
  });

  // Review P2-A: the banner is usually still on screen before `/new`, and an
  // emptied composer under the OLD transcript is not a new conversation.
  it('an unchanged Codex screen counts only when its conversation was already empty', async () => {
    const empty = scriptedPane({ agent: 'Codex CLI', screen: CODEX_EMPTY, cleared: CODEX_EMPTY, sessionStartSource: null });
    const started = empty.opts.now();
    expect(await runFreshContext(CODEX, empty.probe, empty.opts)).toMatchObject({
      freshContext: 'applied',
      freshContextSignal: 'screen',
      freshContextReason: expect.stringMatching(/screen_unchanged/),
    });
    expect(empty.opts.now() - started).toBeGreaterThanOrEqual(500 + 3_000);
    // The old conversation still on screen: never taken, the step times out.
    const stale = scriptedPane({ agent: 'Codex CLI', screen: CODEX_IDLE, cleared: CODEX_IDLE, sessionStartSource: null });
    await expect(runFreshContext(CODEX, stale.probe, stale.opts)).rejects.toMatchObject({ code: 'timeout' });
    expect(stale.writes).toEqual(['/new', '\r']);
  });

  // Review N1: hooks confirmed working means the SessionStart comes in the
  // legitimate case; an unchanged screen is not taken in its place.
  it('an unchanged screen never counts when the daemon confirms the hooks work', async () => {
    const unchanged = scriptedPane({ cleared: CLAUDE_IDLE, sessionStartSource: null, hookReports: true });
    await expect(runFreshContext(CLAUDE, unchanged.probe, unchanged.opts)).rejects.toMatchObject({ code: 'timeout' });
    // ...while the hook, or a changed screen after the grace, still applies.
    const hook = scriptedPane({ cleared: CLAUDE_IDLE, sessionStartSource: 'clear', hookReports: true });
    expect((await runFreshContext(CLAUDE, hook.probe, hook.opts)).freshContextSignal).toBe('session_start');
    // Claude without hooks: an unchanged screen still counts after the hold.
    const noHooks = scriptedPane({ cleared: CLAUDE_IDLE, sessionStartSource: null });
    expect(await runFreshContext(CLAUDE, noHooks.probe, noHooks.opts)).toMatchObject({
      freshContextReason: expect.stringMatching(/screen_unchanged/),
    });
  });

  // Review D1: only a submitted `›` prompt row makes a conversation; `•` rows
  // (tips or notices a fresh launch may draw) do not.
  it('codexConversationLooksEmpty decides on a user-prompt row above the input line', () => {
    expect(codexConversationLooksEmpty(CODEX_EMPTY)).toBe(true);
    expect(codexConversationLooksEmpty(CODEX_IDLE)).toBe(false);
    // A just-launched screen with `•` tip and notice rows is still empty.
    const freshWithTips = [
      '╭──────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.158.0) │',
      '╰──────────────────────────────╯',
      '',
      '• Tip: use /init to create an AGENTS.md',
      '• Notice: a new version is available',
      '',
      '─'.repeat(40),
      '› ',
    ].join('\n');
    expect(codexConversationLooksEmpty(freshWithTips)).toBe(true);
    // The input line itself, and an empty `›` composer row, are not prompts.
    expect(codexConversationLooksEmpty([CODEX_EMPTY, '› typed but not sent'].join('\n'))).toBe(true);
    expect(codexConversationLooksEmpty(['│ >_ OpenAI Codex (v0.158.0) │', '› ', '› '].join('\n'))).toBe(true);
    // A long answer whose prompt is still inside the read window.
    const longAnswer = [
      '│ >_ OpenAI Codex (v0.158.0) │',
      '› explain the parser',
      ...Array.from({ length: 150 }, (_, i) => `• line ${i}`),
      '› ',
    ].join('\n');
    expect(codexConversationLooksEmpty(longAnswer)).toBe(false);
    expect(codexConversationLooksEmpty('› ')).toBe(false);
  });

  it('the real Codex 0.157.1 after-turn capture reads as a conversation', () => {
    const capture = JSON.parse(
      readFileSync(
        path.join(__dirname, '../../../../daemon/approvals/__tests__/fixtures/terminal-prompts/codex-approval-exec-01.json'),
        'utf8',
      ),
    ) as { screen: string[] };
    expect(codexConversationLooksEmpty(capture.screen.join('\n'))).toBe(false);
  });

  it('a fresh-launch screen with tip rows lets an unchanged screen count after the hold', async () => {
    const fresh = [CODEX_EMPTY.replace('  To get started, describe a task', '• Tip: try /init'), ''].join('');
    const pane = scriptedPane({ agent: 'Codex CLI', screen: fresh, cleared: fresh, sessionStartSource: null });
    expect(await runFreshContext(CODEX, pane.probe, pane.opts)).toMatchObject({
      freshContext: 'applied',
      freshContextReason: expect.stringMatching(/screen_unchanged/),
    });
  });

  it('a changed screen is taken as soon as it settles', async () => {
    const pane = scriptedPane({ agent: 'Codex CLI', screen: CODEX_IDLE, cleared: CODEX_NEW, sessionStartSource: null });
    const started = pane.opts.now();
    await runFreshContext(CODEX, pane.probe, pane.opts);
    expect(pane.opts.now() - started).toBeLessThan(1_500);
  });

  it('a state read that fails after typing erases the command (state_unreadable)', async () => {
    const pane = scriptedPane();
    const read = pane.probe.readAgentState;
    let reads = 0;
    pane.probe.readAgentState = async () => (++reads === 2 ? null : read());
    expect(await runFreshContext(CLAUDE, pane.probe, pane.opts)).toMatchObject({
      freshContext: 'skipped_unobservable',
      freshContextReason: expect.stringMatching(/^state_unreadable/),
    });
    expect(pane.writes).toEqual(['/clear', '\x7f'.repeat(6)]);
  });

  it('claude without hooks: applied on the settled screen', async () => {
    const pane = scriptedPane({ sessionStartSource: null });
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out).toEqual({ freshContext: 'applied', freshContextCommand: '/clear', freshContextSignal: 'screen' });
  });

  it('codex: applied on the screen once the banner is redrawn', async () => {
    const pane = scriptedPane({ agent: 'Codex CLI', screen: CODEX_IDLE, cleared: CODEX_NEW, sessionStartSource: null });
    const out = await runFreshContext(CODEX, pane.probe, pane.opts);
    expect(out).toEqual({ freshContext: 'applied', freshContextCommand: '/new', freshContextSignal: 'screen' });
    expect(pane.writes).toEqual(['/new', '\r']);
  });

  it('codex: the banner counts anywhere in the read, far above a bottom-pinned composer', async () => {
    const tall = ['│ >_ OpenAI Codex (v0.158.0) │', ...Array<string>(30).fill(''), '› '].join('\n');
    const pane = scriptedPane({ agent: 'Codex CLI', screen: CODEX_IDLE, cleared: tall, sessionStartSource: null });
    const out = await runFreshContext(CODEX, pane.probe, pane.opts);
    expect(out).toMatchObject({ freshContext: 'applied', freshContextSignal: 'screen' });
  });

  it('codex: a SessionStart is used when it arrives, never required', async () => {
    const pane = scriptedPane({
      agent: 'Codex CLI', screen: CODEX_IDLE, cleared: CODEX_NEW, sessionStartSource: 'startup',
      priorReceipt: { at: 1, agent: 'codex', source: 'startup' },
    });
    const out = await runFreshContext(CODEX, pane.probe, pane.opts);
    expect(out.freshContextSignal).toBe('session_start');
  });

  it('codex: no banner, no evidence — times out', async () => {
    const pane = scriptedPane({ agent: 'Codex CLI', screen: CODEX_IDLE, cleared: '› ', sessionStartSource: null });
    await expect(runFreshContext(CODEX, pane.probe, pane.opts)).rejects.toMatchObject({ code: 'timeout' });
    expect(pane.writes).toEqual(['/new', '\r']);
  });

  it('a pane that never settles times out after the configured window', async () => {
    const pane = scriptedPane({ clearMs: 60_000 });
    const started = pane.opts.now();
    await expect(runFreshContext(CLAUDE, pane.probe, { ...pane.opts, timeoutMs: 8_000 })).rejects.toBeInstanceOf(FreshContextTimeout);
    const elapsed = pane.opts.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(8_000);
    expect(elapsed).toBeLessThan(10_000);
    expect(pane.writes).toEqual(['/clear', '\r']);
  });

  it('keeps waiting while the agent shows a prompt', async () => {
    const pane = scriptedPane({ awaitingUntilMs: 3_000 });
    const startedAt = pane.opts.now();
    const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
    expect(out.freshContext).toBe('applied');
    expect(pane.opts.now() - startedAt).toBeGreaterThanOrEqual(3_000);
  });

  it('fails when the session changes or someone types after the Enter', async () => {
    const changed = scriptedPane({ clearMs: 2_000, afterEnter: { ms: 200, patch: { incarnationId: 'inc-2' } } });
    await expect(runFreshContext(CLAUDE, changed.probe, changed.opts)).rejects.toMatchObject({ code: 'session_changed' });
    const typed = scriptedPane({ clearMs: 2_000, afterEnter: { ms: 200, patch: { keyInputRevision: 99 } } });
    await expect(runFreshContext(CLAUDE, typed.probe, typed.opts)).rejects.toMatchObject({ code: 'input_interleaved' });
    expect(typed.writes).toEqual(['/clear', '\r']);
  });

  it('a pointer moving over the pane during the wait does not fail it', async () => {
    const pane = scriptedPane({ pointerMoving: true, sessionStartSource: null });
    expect((await runFreshContext(CLAUDE, pane.probe, pane.opts)).freshContext).toBe('applied');
    // An older daemon cannot tell, and stays conservative: the command is
    // erased before its Enter and the task goes in without a clear.
    const old = scriptedPane({ pointerMoving: true, keyCounter: false, sessionStartSource: null });
    expect(await runFreshContext(CLAUDE, old.probe, old.opts)).toMatchObject({
      freshContext: 'skipped_busy',
      freshContextReason: expect.stringMatching(/^input_interleaved/),
    });
    expect(old.writes).not.toContain('\r');
  });
});

describe('withFreshContextLock', () => {
  it('serializes work on one pane and leaves other panes free', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = withFreshContextLock('p1', async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = withFreshContextLock('p1', async () => {
      order.push('second');
    });
    const other = withFreshContextLock('p2', async () => {
      order.push('other');
    });
    await other;
    await Promise.resolve();
    expect(order).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  // Review P2-D: a queued send must never outlive its caller.
  it('gives up after the bounded wait, before writing anything, and keeps the queue intact', async () => {
    let releaseFirst: () => void = () => undefined;
    const first = withFreshContextLock('p4', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    let ran = false;
    await expect(withFreshContextLock('p4', async () => { ran = true; }, 20)).rejects.toBeInstanceOf(FreshContextBusy);
    expect(ran).toBe(false);
    const order: string[] = [];
    const third = withFreshContextLock('p4', async () => { order.push('third'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await first;
    await third;
    expect(order).toEqual(['third']);
  });

  it('releases the pane when the work throws', async () => {
    await expect(withFreshContextLock('p3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withFreshContextLock('p3', async () => 'ok')).resolves.toBe('ok');
  });
});
