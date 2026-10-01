import { describe, expect, it } from 'vitest';
import {
  commandOnCursorRow,
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
const CODEX_IDLE = ['│ >_ OpenAI Codex (v0.158.0) │', '', '• did the previous task', '', '› '].join('\n');
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
      if (data === '\r') {
        enterAt = clock;
        return;
      }
      if (data.startsWith('\x7f')) {
        composer = composer.slice(0, composer.length - data.length);
      } else {
        composer += data;
        state.inputRevision += o.extraTypingRevisions ?? 0;
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
  // fixtures/terminal-prompts: Claude Code 2.1.283 `❯ make the button blue`
  // between rules, Codex 0.157.1 `› CMD one`), with the command typed instead.
  it('reads the real composer row shapes', () => {
    const rule = '─'.repeat(100);
    const claude = ['  ◐ medium · /effort', rule, '❯ /clear'].join('\n');
    expect(commandOnCursorRow(claude, '/clear')).toBe('alone');
    expect(commandOnCursorRow([rule, '❯ make the button blue/clear'].join('\n'), '/clear')).toBe('with_draft');
    expect(commandOnCursorRow([rule, '❯'].join('\n'), '/clear')).toBe('absent');
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
    for (const o of [{ status: 'running' }, { status: 'awaiting_input' }, { inputQuiet: false }, { mirror: 'running' }]) {
      const pane = scriptedPane(o);
      const out = await runFreshContext(CLAUDE, pane.probe, pane.opts);
      expect(out.freshContext).toBe('skipped_busy');
      expect(pane.writes).toEqual([]);
    }
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

  it('erases the command and skips when other input arrived while it was typed', async () => {
    const pane = scriptedPane({ extraTypingRevisions: 1 });
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

  it('claude with hooks but no SessionStart: times out, nothing written after Enter', async () => {
    const pane = scriptedPane({ priorReceipt: { at: 1, agent: 'claude', source: 'startup' }, sessionStartSource: null });
    const err = await runFreshContext(CLAUDE, pane.probe, pane.opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreshContextTimeout);
    expect((err as FreshContextTimeout).code).toBe('timeout');
    expect((err as Error).message).toContain('SessionStart hook');
    expect(pane.writes).toEqual(['/clear', '\r']);
  });

  it('a compact or startup-before-Enter receipt is not evidence', async () => {
    const pane = scriptedPane({ priorReceipt: { at: 1, agent: 'claude', source: 'startup' }, sessionStartSource: 'compact' });
    await expect(runFreshContext(CLAUDE, pane.probe, pane.opts)).rejects.toBeInstanceOf(FreshContextTimeout);
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
    const typed = scriptedPane({ clearMs: 2_000, afterEnter: { ms: 200, patch: { inputRevision: 99 } } });
    await expect(runFreshContext(CLAUDE, typed.probe, typed.opts)).rejects.toMatchObject({ code: 'input_interleaved' });
    expect(typed.writes).toEqual(['/clear', '\r']);
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

  it('releases the pane when the work throws', async () => {
    await expect(withFreshContextLock('p3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withFreshContextLock('p3', async () => 'ok')).resolves.toBe('ok');
  });
});
