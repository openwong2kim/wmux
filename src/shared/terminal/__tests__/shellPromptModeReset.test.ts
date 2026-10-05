import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  installShellPromptModeReset,
  isMouseOrFocusReport,
  PROMPT_MODE_RESET_GUARD_OSC,
  shellPromptModeResetFor,
  type ShellPromptModeResetOptions,
} from '../shellPromptModeReset';

const ESC = '\x1b';
const BEL = '\x07';
const PROMPT = `${ESC}]133;D;0${BEL}${ESC}]133;A${BEL}PS C:\\> ${ESC}]133;B${BEL}`;
const COMMAND = `${ESC}]133;C${BEL}`;
/** What Claude Code arms around its input box on Windows. */
const AGENT_ARMS = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`;
/** ConPTY's own session-start preamble. */
const CONPTY_START = `${ESC}[?9001h${ESC}[?1004h`;

function make(options?: ShellPromptModeResetOptions) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const writes: string[] = [];
  const realWrite = term.write.bind(term);
  // Record what the guard writes terminal-side (pane output goes through `feed`).
  const guard = installShellPromptModeReset({
    get parser() { return term.parser; },
    get modes() { return term.modes; },
    write: (data: string) => { writes.push(data); realWrite(data); },
  }, options);
  const feed = (data: string) => new Promise<void>((resolve) => realWrite(data, resolve));
  /** Resolves once everything queued so far (guard writes included) has parsed. */
  const drain = () => new Promise<void>((resolve) => realWrite('', resolve));
  return { term, guard, writes, feed, drain };
}

const armed = (term: Terminal) => ({
  mouse: term.modes.mouseTrackingMode,
  focus: term.modes.sendFocusMode,
  paste: term.modes.bracketedPasteMode,
});

describe('installShellPromptModeReset (#1792)', () => {
  it('resets mouse and focus once an agent that armed them is replaced by the shell prompt', async () => {
    const { term, guard, feed, drain } = make();
    await feed(CONPTY_START + `${ESC}[?2004h` + PROMPT);
    await feed(COMMAND + AGENT_ARMS + 'claude is running');
    expect(armed(term)).toEqual({ mouse: 'any', focus: true, paste: true });
    // Killed: no ?1003l / ?1004l ever arrives, the shell just prints its prompt.
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toEqual({ mouse: 'none', focus: false, paste: true });
    expect(guard.appliedCount).toBe(1);
  });

  it('leaves bracketed paste (?2004) alone', async () => {
    const { term, writes, feed, drain } = make();
    await feed(`${ESC}[?2004h` + PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await drain();
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(writes.join('')).not.toContain('?2004l');
  });

  it('does not fire while the agent is still running', async () => {
    const { term, guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS + 'thinking...\r\n' + 'more output');
    await drain();
    expect(armed(term).mouse).toBe('any');
    expect(writes).toEqual([]);
    expect(guard.appliedCount).toBe(0);
  });

  it('does not fire for an alt-screen TUI (vim) that is still drawing', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h` + '~\r\n~');
    await drain();
    expect(term.buffer.active.type).toBe('alternate');
    expect(armed(term).mouse).toBe('vt200');
    expect(writes).toEqual([]);
  });

  it('fires when the killed TUI left its alternate screen on, and leaves the screen alone', async () => {
    // Recorded live (#1792 dogfood): Claude Code 2.1.289 on Windows, then
    // `taskkill /F` on its PID and PowerShell printing its prompt.
    const { term, guard, feed, drain } = make();
    await feed(CONPTY_START + PROMPT);
    await feed(COMMAND
      + `${ESC}[?2004h${ESC}[?2031h${ESC}[?1004h${ESC}[?2031l${ESC}[?2004l`
      + `${ESC}[?2004h${ESC}[?2031h${ESC}[?1004h${ESC}[?1049h`
      + `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?25h`
      + 'claude ui');
    expect(armed(term)).toEqual({ mouse: 'any', focus: true, paste: true });
    await feed(`${ESC}]133;D;1${BEL}${ESC}]133;A${BEL}PS C:\\cc> ${ESC}]133;B${BEL}`);
    await drain();
    expect(armed(term)).toEqual({ mouse: 'none', focus: false, paste: true });
    expect(term.buffer.active.type).toBe('alternate');
    expect(guard.appliedCount).toBe(1);
  });

  it('leaves a running full-screen agent alone (no prompt mark while it draws)', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1049h${ESC}[?1000h${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`);
    await feed('frame 1\r\nframe 2');
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'any', focus: true });
    expect(writes).toEqual([]);
  });

  it('does not touch a TUI that arms the mouse after the prompt with no command mark', async () => {
    // A shell whose integration emits A but never C (no PSReadLine Enter hook).
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + AGENT_ARMS + 'agent running without a C mark');
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'any', focus: true });
    expect(writes).toEqual([]);
    // ...and when it dies, the next prompt does reset.
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('is idempotent: later prompts write nothing more', async () => {
    const { guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await drain();
    await feed(PROMPT);
    await feed(COMMAND + 'dir\r\n' + PROMPT);
    await drain();
    expect(writes).toHaveLength(1);
    expect(guard.appliedCount).toBe(1);
  });

  it('writes nothing when the agent exited cleanly', async () => {
    const { term, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS + `${ESC}[?1003l${ESC}[?1006l${ESC}[?1004l`);
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
    expect(writes).toEqual([]);
  });

  it("leaves ConPTY's own session-start ?1004h alone at a plain prompt", async () => {
    const { term, writes, feed, drain } = make();
    await feed(CONPTY_START + PROMPT);
    await feed(COMMAND + 'Directory listing\r\n' + PROMPT);
    await drain();
    expect(term.modes.sendFocusMode).toBe(true);
    expect(writes).toEqual([]);
  });

  it('counts a mouse mode armed before any prompt mark (a pane attached mid-agent)', async () => {
    const { term, feed, drain } = make();
    await feed(CONPTY_START + AGENT_ARMS + 'agent output from the replay');
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('re-validates where the reset lands: a TUI launched behind the prompt keeps its mouse', async () => {
    const { term, guard, writes, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    // One backlog chunk: the dead agent's prompt, then a new agent started
    // before xterm reached the reset queued at that prompt.
    await feed(PROMPT + 'claude\r\n' + COMMAND + `${ESC}[?1003h${ESC}[?1006h`);
    await drain();
    expect(writes).toHaveLength(1);
    expect(guard.appliedCount).toBe(0);
    expect(armed(term).mouse).toBe('any');
  });

  it('applies the reset for the latest prompt when several are queued', async () => {
    const { term, feed, drain } = make();
    const term1 = PROMPT + COMMAND + AGENT_ARMS;
    // dead agent → prompt → new agent → dead again → prompt, all in one parse.
    await feed(term1 + PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('ignores a guard marker with the wrong nonce (pane output cannot veto anything)', async () => {
    const { term, feed, drain } = make();
    await feed(PROMPT + COMMAND + `${ESC}[?1000h`);
    await feed(`${ESC}]${PROMPT_MODE_RESET_GUARD_OSC};bogus;begin${BEL}${ESC}[?1000l`);
    await drain();
    expect(armed(term).mouse).toBe('none');
  });

  it('installs once per terminal', () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const a = installShellPromptModeReset(term);
    const b = installShellPromptModeReset(term);
    expect(a).toBe(b);
    a.dispose();
    expect(installShellPromptModeReset(term)).not.toBe(a);
  });
});

/** A manual timer queue for the recheck seam. */
function manualTimers() {
  const due: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => {
      due.push(fn);
      return () => { const i = due.indexOf(fn); if (i >= 0) due.splice(i, 1); };
    },
    runAll: () => { for (const fn of due.splice(0)) fn(); },
    get pending() { return due.length; },
  };
}

const SGR_MOVE = `${ESC}[<35;24;14M`;
const FOCUS_IN = `${ESC}[I`;

describe('installShellPromptModeReset — process truth (#1794 review item 1)', () => {
  it('keeps the mouse of a TUI started in the background behind a returned prompt', async () => {
    // `Start-Process -NoNewWindow node tui.js`: C, the cmdlet returns at once
    // (P), the TUI arms after that prompt, the user runs `dir` (C + P).
    const probe = vi.fn(() => false);
    const { term, guard, writes, feed, drain } = make({ isForegroundGone: probe });
    await feed(CONPTY_START + PROMPT + COMMAND + PROMPT);
    await feed(`${ESC}[?1003h${ESC}[?1006h`);
    await feed(COMMAND + 'Directory listing\r\n' + PROMPT);
    await drain();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(armed(term).mouse).toBe('any');
    expect(writes).toEqual([]);
    expect(guard.dropping).toBe(false);
    expect(guard.dropsReport(SGR_MOVE)).toBe(false);
  });

  it('without process truth the same sequence resets (phone / mirror behaviour)', async () => {
    const { term, feed, drain } = make();
    await feed(CONPTY_START + PROMPT + COMMAND + PROMPT);
    await feed(`${ESC}[?1003h${ESC}[?1006h`);
    await feed(COMMAND + 'Directory listing\r\n' + PROMPT);
    await drain();
    expect(armed(term).mouse).toBe('none');
  });

  it('keeps the mouse of a TUI stopped with Ctrl+Z and resumed with fg', async () => {
    const { term, guard, writes, feed, drain } = make({ isForegroundGone: () => false });
    await feed(PROMPT + COMMAND + `${ESC}[?1000h${ESC}[?1006h` + 'htop');
    // Ctrl+Z: the shell prints `[1]+ Stopped` and its prompt.
    await feed('\r\n[1]+  Stopped  htop\r\n' + PROMPT);
    await drain();
    expect(armed(term).mouse).toBe('vt200');
    // `fg`: a C mark and the TUI redraws without arming anything again.
    await feed(COMMAND + 'htop redraw');
    await drain();
    expect(armed(term).mouse).toBe('vt200');
    expect(writes).toEqual([]);
    expect(guard.appliedCount).toBe(0);
  });

  it('resets once process truth says the arming process is gone (async answer)', async () => {
    const { term, guard, feed, drain } = make({ isForegroundGone: async () => true });
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await new Promise((r) => setTimeout(r, 0));
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
    expect(guard.appliedCount).toBe(1);
    expect(guard.dropping).toBe(false);
  });

  it('unknown truth: keeps dropping reports and asks again until it knows', async () => {
    const timers = manualTimers();
    const answers: (boolean | undefined)[] = [undefined, undefined, true];
    const probe = vi.fn(() => answers.shift());
    const { term, guard, feed, drain } = make({ isForegroundGone: probe, setTimer: timers.setTimer });
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT);
    await drain();
    expect(armed(term).mouse).toBe('any');
    expect(guard.dropsReport(SGR_MOVE)).toBe(true);
    expect(guard.dropsReport(FOCUS_IN)).toBe(true);
    expect(guard.dropsReport('a')).toBe(false);
    timers.runAll();
    expect(guard.dropping).toBe(true);
    timers.runAll();
    await drain();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
    expect(guard.dropping).toBe(false);
  });

  it('gives up asking after maxProbes but keeps dropping until a new owner', async () => {
    const timers = manualTimers();
    const probe = vi.fn(() => undefined);
    const { term, guard, feed, drain } = make({ isForegroundGone: probe, setTimer: timers.setTimer, maxProbes: 2 });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    timers.runAll();
    timers.runAll();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(timers.pending).toBe(0);
    expect(guard.dropsReport(SGR_MOVE)).toBe(true);
    await feed(COMMAND + `${ESC}[?1003h`);
    await drain();
    expect(guard.dropping).toBe(false);
    expect(armed(term).mouse).toBe('any');
  });

  it('a command run while the answer is pending does not forget the owed reset', async () => {
    const timers = manualTimers();
    const answers: (boolean | undefined)[] = [undefined, true];
    const { term, feed, drain } = make({ isForegroundGone: () => answers.shift(), setTimer: timers.setTimer });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    // The user runs `dir` before the truth arrives: C stops the drop...
    await feed(COMMAND + 'Directory listing\r\n');
    expect(timers.pending).toBe(0);
    // ...and its prompt asks again.
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
  });

  it('ignores a stale answer once a new owner armed the mouse', async () => {
    let answer!: (gone: boolean) => void;
    const { term, guard, writes, feed, drain } = make({
      isForegroundGone: () => new Promise<boolean>((r) => { answer = r; }),
    });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await feed(COMMAND + `${ESC}[?1003h`);
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    await drain();
    expect(writes).toEqual([]);
    expect(armed(term).mouse).toBe('any');
    expect(guard.dropping).toBe(false);
  });

  it('a later install binds a new probe (an adopting mount)', async () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const guard = installShellPromptModeReset(term, { isForegroundGone: first });
    expect(installShellPromptModeReset(term, { isForegroundGone: second })).toBe(guard);
    await new Promise<void>((r) => term.write(PROMPT + COMMAND + AGENT_ARMS + PROMPT, r));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('installShellPromptModeReset — terminal.reset() (#1794 review item 2)', () => {
  it("after a pane switch, the next session's ConPTY ?1004h is not taken for a command's arm", async () => {
    const { term, guard, writes, feed, drain } = make();
    // Pane A: a plain prompt, so the guard's phase is 'prompt'.
    await feed(CONPTY_START + PROMPT + COMMAND + 'output\r\n' + PROMPT);
    // Switch to pane B on the same terminal (phone page): reset + its snapshot.
    term.reset();
    guard.reset();
    await feed(CONPTY_START + 'PowerShell banner\r\n' + PROMPT);
    await drain();
    expect(term.modes.sendFocusMode).toBe(true);
    expect(writes).toEqual([]);
  });

  it('without reset() the same switch clears ConPTY focus (the reported bug)', async () => {
    const { term, writes, feed, drain } = make();
    await feed(CONPTY_START + PROMPT + COMMAND + 'output\r\n' + PROMPT);
    term.reset();
    await feed(CONPTY_START + 'PowerShell banner\r\n' + PROMPT);
    await drain();
    expect(term.modes.sendFocusMode).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('a reset already queued when the terminal is reset is swallowed where it lands', async () => {
    const { term, guard, feed, drain } = make();
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    // The prompt queues the marker; reset() before xterm parses it; the new
    // pane's TUI arms its mouse.
    const done = feed(PROMPT);
    term.reset();
    guard.reset();
    await done;
    await feed(`${ESC}[?1003h`);
    await drain();
    expect(guard.appliedCount).toBe(0);
    expect(guard.dropping).toBe(false);
  });

  it('reset() stops a pending truth request and its drop', async () => {
    const timers = manualTimers();
    const { guard, feed } = make({ isForegroundGone: () => undefined, setTimer: timers.setTimer });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    expect(guard.dropping).toBe(true);
    guard.reset();
    expect(guard.dropping).toBe(false);
    expect(timers.pending).toBe(0);
  });

  it('shellPromptModeResetFor finds the installed guard without installing one', () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    expect(shellPromptModeResetFor(term)).toBeUndefined();
    const g = installShellPromptModeReset(term);
    expect(shellPromptModeResetFor(term)).toBe(g);
  });
});

describe('installShellPromptModeReset — input drop (#1794 review item 3)', () => {
  it('drops reports between the prompt mark and the reset queued behind pending output', async () => {
    const { term, guard, feed, drain } = make();
    let seenWhileQueued: boolean | undefined;
    let dropsWhileQueued: boolean[] = [];
    // An OSC the test owns, parsed after the prompt but before the marker the
    // guard appended to the end of the write queue.
    term.parser.registerOscHandler(9999, () => {
      seenWhileQueued = guard.dropping;
      dropsWhileQueued = [SGR_MOVE, FOCUS_IN, `${ESC}[O`, 'ls', '\r', `${ESC}[A`].map((d) => guard.dropsReport(d));
      return true;
    });
    await feed(PROMPT + COMMAND + AGENT_ARMS);
    await feed(PROMPT + 'x'.repeat(200_000) + `${ESC}]9999;probe${BEL}`);
    await drain();
    expect(seenWhileQueued).toBe(true);
    expect(dropsWhileQueued).toEqual([true, true, true, false, false, false]);
    expect(guard.dropping).toBe(false);
    expect(armed(term).mouse).toBe('none');
  });

  it('stops dropping when a new owner arms a mode before the reset lands', async () => {
    const { guard, feed, drain } = make({ isForegroundGone: () => new Promise<boolean>(() => undefined) });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    expect(guard.dropsReport(SGR_MOVE)).toBe(true);
    await feed(`${ESC}[?1000h`);
    await drain();
    expect(guard.dropsReport(SGR_MOVE)).toBe(false);
  });

  it('matches whole reports only', () => {
    expect(isMouseOrFocusReport(`${ESC}[<0;10;5M`)).toBe(true);
    expect(isMouseOrFocusReport(`${ESC}[<0;10;5m`)).toBe(true);
    expect(isMouseOrFocusReport(`${ESC}[M #!`)).toBe(true);
    expect(isMouseOrFocusReport(`${ESC}[32;10;5M`)).toBe(true);
    expect(isMouseOrFocusReport(`${ESC}[I`)).toBe(true);
    expect(isMouseOrFocusReport(`${ESC}[O`)).toBe(true);
    expect(isMouseOrFocusReport(`echo ${ESC}[I`)).toBe(false);
    expect(isMouseOrFocusReport(`${ESC}[A`)).toBe(false);
    expect(isMouseOrFocusReport(`${ESC}[200~paste${ESC}[201~`)).toBe(false);
    expect(isMouseOrFocusReport('')).toBe(false);
  });
});

describe('installShellPromptModeReset — ConPTY focus (#1794 review item 4)', () => {
  it("a mouse-only leak keeps ConPTY's own focus reporting", async () => {
    const { term, guard, writes, feed, drain } = make();
    await feed(CONPTY_START + PROMPT + COMMAND + `${ESC}[?1003h${ESC}[?1006h`);
    await feed(PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: true });
    expect(writes.join('')).not.toContain('?1004l');
    expect(guard.appliedCount).toBe(1);
  });

  it('a command that armed focus itself gets focus cleared too (not re-armed)', async () => {
    const { term, writes, feed, drain } = make();
    await feed(CONPTY_START + PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await drain();
    expect(armed(term)).toMatchObject({ mouse: 'none', focus: false });
    expect(writes.join('')).not.toContain('?1004h');
  });
});
