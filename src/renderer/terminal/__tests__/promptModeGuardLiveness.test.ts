/**
 * The #1794 prompt-mode guard wired to the desktop's real process-truth probe
 * (paneForegroundProbe), driven through the two paths where that probe answers
 * "alive" at a prompt whose arming agent then dies:
 *
 *  - Windows: the `pty.resources` CIM snapshot fails (collectPaneResources
 *    returns `{}` when powershell.exe cannot be spawned or times out — the
 *    low-memory case), so the probe falls back to `pty.list`. There the agent
 *    tracker still reads alive past AGENT_DEATH_LAG_MS (ProcessMonitor treats a
 *    failed tasklist as unknown, never dead, so its death edge defers).
 *  - WSL panes: the tree walk is never asked, the tracker always decides.
 *
 * Before the fix the guard's `false` answer was final: the owed reset was
 * dropped and no later prompt or death edge brought it back.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { installShellPromptModeReset } from '../../../shared/terminal/shellPromptModeReset';
import { AGENT_DEATH_LAG_MS, paneForegroundProbe, type PaneForegroundApi } from '../paneForegroundProbe';

const ESC = '\x1b';
const BEL = '\x07';
const PROMPT = `${ESC}]133;D;0${BEL}${ESC}]133;A${BEL}PS C:\\> ${ESC}]133;B${BEL}`;
const COMMAND = `${ESC}]133;C${BEL}`;
/** What Claude Code arms around its input box on Windows. */
const AGENT_ARMS = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`;
const SGR_MOVE = `${ESC}[<35;114;8M`;
const PTY = 'daemon-p1';

function manualTimers() {
  const due: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => {
      due.push(fn);
      return () => { const i = due.indexOf(fn); if (i >= 0) due.splice(i, 1); };
    },
    runAll: () => { for (const fn of due.splice(0)) fn(); },
  };
}

/** A pane whose tracker reads the agent alive until `agentDies()`. */
function pane(opts: { wsl?: boolean } = {}) {
  let agentAlive = true;
  let clock = 0;
  const ptyWrites: string[] = [];
  const api: PaneForegroundApi = {
    // CIM snapshot failed (or a WSL pane, where it is never asked).
    resources: async () => ({}),
    list: async () => [{
      id: PTY,
      commandRunning: false,
      ...(opts.wsl ? { wslTarget: { distro: 'Ubuntu' } } : {}),
      agentProcessAlive: agentAlive,
      ...(agentAlive ? { liveAgent: 'claude' } : {}),
    }],
  };
  const timers = manualTimers();
  const term = new Terminal({ cols: 120, rows: 24, allowProposedApi: true });
  const guard = installShellPromptModeReset(term, {
    isForegroundGone: paneForegroundProbe(PTY, api, () => clock),
    setTimer: timers.setTimer,
    now: () => clock,
  });
  // useTerminal's onData path: whatever the guard does not drop reaches the PTY.
  term.onData((data) => { if (!guard.dropsReport(data)) ptyWrites.push(data); });
  const feed = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await feed('');
  };
  return {
    term,
    guard,
    ptyWrites,
    feed,
    settle,
    timers,
    advance: (ms: number) => { clock += ms; },
    agentDies: () => { agentAlive = false; },
  };
}

const modes = (term: Terminal) => ({ mouse: term.modes.mouseTrackingMode, focus: term.modes.sendFocusMode });

/** Drive the pane to the state the residual bug leaves: the probe answered "alive". */
async function declinedAsAlive(p: ReturnType<typeof pane>) {
  await p.feed(PROMPT + COMMAND + AGENT_ARMS + 'claude ui');
  // Killed: the shell prints its prompt, the tracker has not noticed yet.
  await p.feed(PROMPT);
  await p.settle();
  expect(p.guard.dropping).toBe(true); // unknown truth: reports held back
  // Tracker still reads alive past the death lag: the probe answers `false`.
  p.advance(AGENT_DEATH_LAG_MS);
  p.timers.runAll();
  await p.settle();
  expect(p.guard.dropping).toBe(false);
  expect(modes(p.term)).toEqual({ mouse: 'any', focus: true });
}

describe('prompt-mode guard + paneForegroundProbe: a reset declined as "alive"', () => {
  it('stays armed after the agent dies, even across later prompts, without a re-ask (the residual drop)', async () => {
    const p = pane();
    await declinedAsAlive(p);
    // The tracker now confirms the death; the user runs a command and gets a prompt back.
    p.agentDies();
    await p.feed(COMMAND + 'Directory listing\r\n' + PROMPT);
    await p.settle();
    expect(modes(p.term)).toEqual({ mouse: 'any', focus: true });
    // ...and every pointer move is typed into the prompt.
    p.term.input(SGR_MOVE, false);
    expect(p.ptyWrites).toEqual([SGR_MOVE]);
  });

  for (const wsl of [false, true]) {
    it(`the agent's death edge re-asks and resets terminal-side only (${wsl ? 'WSL pane' : 'Windows, failed CIM snapshot'})`, async () => {
      const p = pane({ wsl });
      await declinedAsAlive(p);
      p.agentDies();
      p.guard.processGone();
      await p.settle();
      expect(modes(p.term)).toEqual({ mouse: 'none', focus: false });
      expect(p.term.modes.bracketedPasteMode).toBe(false); // never armed here, never touched
      expect(p.guard.appliedCount).toBe(1);
      // Nothing was written to the PTY: no reset bytes, no reports.
      expect(p.ptyWrites).toEqual([]);
    });
  }

  it('leaves bracketed paste armed by the shell alone', async () => {
    const p = pane();
    await p.feed(`${ESC}[?2004h`);
    await declinedAsAlive(p);
    p.agentDies();
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term)).toEqual({ mouse: 'none', focus: false });
    expect(p.term.modes.bracketedPasteMode).toBe(true);
  });

  it('a TUI still alive behind the prompt keeps its mouse when the hint fires', async () => {
    // e.g. a misattributed tracker pick: the hint arrives, the probe still reads alive.
    const p = pane();
    await declinedAsAlive(p);
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term)).toEqual({ mouse: 'any', focus: true });
    expect(p.guard.appliedCount).toBe(0);
    expect(p.guard.dropping).toBe(false);
    // ...and a real death edge afterwards still resets.
    p.agentDies();
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term).mouse).toBe('none');
  });

  it('a new TUI that armed the mouse since is never reset by the old death edge', async () => {
    const p = pane();
    await declinedAsAlive(p);
    // Armed with no C mark (a TUI started behind the prompt): the phase stays
    // 'prompt', so only the new-owner rule protects it.
    await p.feed(`${ESC}[?1000h${ESC}[?1006h` + 'tui');
    p.agentDies();
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term).mouse).toBe('vt200');
    expect(p.guard.appliedCount).toBe(0);
    // Its own prompt later is a fresh decision, not the dead agent's debt.
    expect(p.guard.dropping).toBe(false);
  });

  it('ignores the hint while a command owns the pane', async () => {
    const p = pane();
    await declinedAsAlive(p);
    await p.feed(COMMAND + 'long build output');
    p.agentDies();
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term).mouse).toBe('any');
    expect(p.guard.dropping).toBe(false);
  });

  it('a running agent with nothing declined is never touched', async () => {
    const p = pane();
    await p.feed(PROMPT + COMMAND + AGENT_ARMS + 'claude ui');
    p.agentDies(); // even a (wrong) death reading
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term)).toEqual({ mouse: 'any', focus: true });
    expect(p.guard.appliedCount).toBe(0);
  });

  it('reset() forgets a declined debt', async () => {
    const p = pane();
    await declinedAsAlive(p);
    p.guard.reset();
    p.agentDies();
    p.guard.processGone();
    await p.settle();
    expect(modes(p.term).mouse).toBe('any');
  });

  it('a guard without process truth (browser build, phone, mirror) never declines, so the hint is a no-op', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const guard = installShellPromptModeReset(term);
    await new Promise<void>((r) => term.write(PROMPT + COMMAND + AGENT_ARMS + PROMPT, r));
    await new Promise<void>((r) => term.write('', r));
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(guard.appliedCount).toBe(1);
    guard.processGone();
    await new Promise<void>((r) => term.write('', r));
    expect(guard.appliedCount).toBe(1);
  });
});

describe('useTerminal wiring (source-level lock)', () => {
  const SRC = readFileSync(path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const start = SRC.indexOf('const unsubscribeKeyboardLiveness = useStore.subscribe(');
  const end = SRC.indexOf('\n    });\n', start);
  const LIVENESS = SRC.slice(start, end);

  it('re-asks the guard on the agentAlive death edge only, never on the commandRunning edge', () => {
    expect(start).toBeGreaterThan(-1);
    expect(LIVENESS).toMatch(
      /if \(gone\(state\.agentAliveByPtyId\[ptyId\], prev\.agentAliveByPtyId\[ptyId\]\)\) \{\s*shellPromptModeResetFor\(terminal\)\?\.processGone\(\);\s*\}/,
    );
    expect(LIVENESS.match(/processGone\(\)/g)).toHaveLength(1);
  });

  it('re-asks on adopt when the death edge fired while the terminal was parked', () => {
    expect(SRC).toMatch(
      /if \(adopted && seedState\.agentAliveByPtyId\[ptyId\] === false\) \{\s*shellPromptModeResetFor\(terminal\)\?\.processGone\(\);\s*\}/,
    );
  });

  it('never writes the alive-shell reset itself from the liveness subscription', () => {
    expect(LIVENESS).not.toMatch(/STALE_REPLAY_ALIVE_SHELL_RESETS/);
    expect(LIVENESS).not.toMatch(/\.write\(/);
  });
});
