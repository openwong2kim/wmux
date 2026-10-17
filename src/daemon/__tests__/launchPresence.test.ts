// #1919 / #1933 — `daemon.getLaunchPresence` says `absent` only on positive
// evidence: no canonical name, no live tracked agent, no running foreground
// command, and a process read showing the pane's shell with no children.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideLaunchPresence,
  launchPresenceAllowsResend,
  launchPresenceNeedsProcessRead,
  type LaunchPresenceInputs,
} from '../launchPresence';
import { promptLineState } from '../../shared/promptLineState';

const base: LaunchPresenceInputs = {
  sessionExists: true,
  agentName: null,
  trackerAlive: undefined,
  commandRunning: undefined,
  isExec: false,
  isWsl: false,
};

describe('decideLaunchPresence', () => {
  it('a canonical name → running', () => {
    expect(decideLaunchPresence({ ...base, agentName: 'Claude Code', idleShell: { ok: true } })).toEqual({
      presence: 'running',
      reason: 'agent-named',
    });
  });

  it('a live tracked agent process with no name yet → running, not absent', () => {
    expect(decideLaunchPresence({ ...base, trackerAlive: true, idleShell: { ok: true } })).toEqual({
      presence: 'running',
      reason: 'agent-process-alive',
    });
  });

  it('a shell with a child process but no name → unknown (identity may lag)', () => {
    expect(
      decideLaunchPresence({ ...base, idleShell: { ok: false, reason: 'shell-has-children' } }),
    ).toEqual({ presence: 'unknown', reason: 'shell-has-children' });
  });

  it('a running foreground command → unknown, whatever the process read', () => {
    expect(decideLaunchPresence({ ...base, commandRunning: true, idleShell: { ok: true } }).presence).toBe('unknown');
  });

  it('no name, no agent process, idle shell with no children → absent', () => {
    // The launch line was swallowed: OSC 133 never saw a command-start.
    expect(decideLaunchPresence({ ...base, idleShell: { ok: true } })).toEqual({
      presence: 'absent',
      reason: 'idle-shell',
    });
    // The launcher ran and exited (grok not installed): back at the prompt,
    // and a tracked agent that died reads `false`, not alive.
    expect(
      decideLaunchPresence({ ...base, commandRunning: false, trackerAlive: false, idleShell: { ok: true } }).presence,
    ).toBe('absent');
  });

  it('without a process read nothing is absent', () => {
    expect(decideLaunchPresence({ ...base, commandRunning: false })).toEqual({
      presence: 'unknown',
      reason: 'not-probed',
    });
    expect(launchPresenceNeedsProcessRead({ ...base, commandRunning: false })).toBe(true);
    expect(launchPresenceNeedsProcessRead({ ...base, agentName: 'Claude Code' })).toBe(false);
  });

  it('process truth that is unavailable or does not apply → unknown', () => {
    expect(decideLaunchPresence({ ...base, sessionExists: false, idleShell: { ok: true } }).reason).toBe('no-session');
    expect(decideLaunchPresence({ ...base, isExec: true, idleShell: { ok: true } }).reason).toBe('exec-pane');
    expect(decideLaunchPresence({ ...base, isWsl: true, idleShell: { ok: true } }).reason).toBe('wsl-pane');
    expect(decideLaunchPresence({ ...base, idleShell: 'error' }).reason).toBe('probe-failed');
    expect(decideLaunchPresence({ ...base, idleShell: { ok: false, reason: 'missing' } }).reason).toBe('shell-missing');
    expect(decideLaunchPresence({ ...base, idleShell: { ok: false, reason: 'unsupported-shell' } }).reason).toBe(
      'unsupported-shell',
    );
    for (const idleShell of ['error', { ok: false, reason: 'missing' }, { ok: false, reason: 'unsupported-shell' }] as const) {
      expect(decideLaunchPresence({ ...base, idleShell }).presence).toBe('unknown');
    }
  });

  it('a WSL pane whose bash came back to its prompt failing → absent (#2231)', () => {
    // The PowerShell prompt argument typed into bash: a parse error, status 2.
    expect(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 2 })).toEqual({
      presence: 'absent',
      reason: 'wsl-launch-failed',
    });
    // claude not installed in the distro.
    expect(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 127, commandRunning: false }).presence).toBe('absent');
    expect(launchPresenceNeedsProcessRead({ ...base, isWsl: true, exitAfterPrompt: 2 })).toBe(false);
  });

  it('a WSL pane with no failing return to the prompt stays unknown', () => {
    // Still loading (no second prompt), or a clean exit: no evidence.
    expect(decideLaunchPresence({ ...base, isWsl: true }).reason).toBe('wsl-pane');
    expect(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 0 }).reason).toBe('wsl-pane');
    // Something runs in the foreground: never absent.
    expect(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 2, commandRunning: true }).presence).toBe('unknown');
    // A name or a live agent process still wins.
    expect(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 2, agentName: 'Claude Code' }).presence).toBe('running');
  });

  // F26 — the launch line never reached bash: first prompt drawn, no line
  // read, nothing written since. The watchdog used to call this unknown, so
  // the task stayed `working` with a bare prompt and nobody was told.
  it('a WSL pane whose bash never read the launch line → absent', () => {
    expect(decideLaunchPresence({ ...base, isWsl: true, lineNeverRead: true })).toEqual({
      presence: 'absent',
      reason: 'wsl-line-never-read',
    });
    expect(launchPresenceNeedsProcessRead({ ...base, isWsl: true, lineNeverRead: true })).toBe(false);
    // A name, a live agent process or a running command still wins.
    expect(decideLaunchPresence({ ...base, isWsl: true, lineNeverRead: true, agentName: 'Claude Code' }).presence).toBe('running');
    expect(decideLaunchPresence({ ...base, isWsl: true, lineNeverRead: true, trackerAlive: true }).presence).toBe('running');
    expect(decideLaunchPresence({ ...base, isWsl: true, lineNeverRead: true, commandRunning: true }).presence).toBe('unknown');
    expect(decideLaunchPresence({ ...base, isWsl: true, lineNeverRead: false }).reason).toBe('wsl-pane');
  });

  // F26 review — a second launch line is typed only on a process-table read
  // of an idle shell. A WSL verdict is read from the prompt markers alone.
  it('allows a re-sent launch line only on an idle-shell process read', () => {
    expect(launchPresenceAllowsResend(decideLaunchPresence({ ...base, idleShell: { ok: true } }))).toBe(true);
    expect(launchPresenceAllowsResend(decideLaunchPresence({ ...base, idleShell: { ok: false, reason: 'shell-has-children' } }))).toBe(false);
    expect(launchPresenceAllowsResend(decideLaunchPresence({ ...base, idleShell: 'error' }))).toBe(false);
    expect(launchPresenceAllowsResend(decideLaunchPresence({ ...base, isWsl: true, exitAfterPrompt: 2 }))).toBe(false);
    // WSL bash without command-start: the prompt and the launch line's echo
    // land in one chunk, so the prompt's offset is the end of the output and
    // the markers say "never read" while the worker runs. The verdict is
    // `absent`, and it must still not allow a second line.
    const coalesced = [
      { type: 'command_end', byteOffset: 40 },
      { type: 'prompt_start', byteOffset: 40 },
      { type: 'prompt_end', byteOffset: 420 },
    ];
    const lineNeverRead = promptLineState(coalesced, 420) === 'idle-at-prompt';
    const verdict = decideLaunchPresence({ ...base, isWsl: true, lineNeverRead, idleShell: { ok: true } });
    expect(verdict.presence).toBe('absent');
    expect(launchPresenceAllowsResend(verdict)).toBe(false);
  });

  it('the failing return counts only in a WSL pane (others read the process table)', () => {
    expect(decideLaunchPresence({ ...base, exitAfterPrompt: 2 })).toEqual({ presence: 'unknown', reason: 'not-probed' });
  });
});

// Source-shape guard: the handler is a closure inside the daemon's RPC
// registration, which a unit test cannot construct (see
// agentStateReaderWiring.test.ts for the same pattern).
describe('daemon.getLaunchPresence wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const at = src.indexOf("pipeServer.onRpc('daemon.getLaunchPresence'");
  const body = src.slice(at, src.indexOf('\n  });', at));

  it('is registered', () => {
    expect(at).toBeGreaterThan(-1);
  });

  it('takes the name from the shared canonical reader and process truth from the tracker', () => {
    expect(body).toMatch(/agentName: readDaemonAgentState\(id\)\.agentName \?\? null/);
    expect(body).toMatch(/trackerAlive: agentProcessTracker\.statusFor\(id\)/);
    expect(body).toMatch(/commandRunning: session\?\.promptLog\.commandRunningIfKnown\(\)/);
    expect(body).toMatch(/isWsl: !!session\?\.meta\.wslTarget/);
    expect(body).toMatch(/isExec: !!session\?\.meta\.exec/);
    expect(body).toMatch(/exitAfterPrompt: session\?\.promptLog\.exitAfterPrompt\(\)/);
    expect(body).toMatch(
      /lineNeverRead: !!session && promptLineState\(session\.promptLog\.snapshot\(\), session\.ringBuffer\.totalBytesWritten\) === 'idle-at-prompt'/,
    );
  });

  it('reads the process table only when asked and still undecided, and a failed read is unknown', () => {
    expect(body).toMatch(/params\['probeProcess'\] === true && launchPresenceNeedsProcessRead\(inputs\)/);
    expect(body).toMatch(/agentProcessTracker\.idleShellState\(session\.meta\.pid, session\.meta\.env, true\)/);
    expect(body).toMatch(/idleShell = 'error'/);
    expect(body).toMatch(/decideLaunchPresence\(\{ \.\.\.inputs, idleShell \}\)/);
  });
});
