// #1919 / #1933 — `daemon.getLaunchPresence` says `absent` only on positive
// evidence: no canonical name, no live tracked agent, no running foreground
// command, and a process read showing the pane's shell with no children.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideLaunchPresence,
  launchPresenceNeedsProcessRead,
  type LaunchPresenceInputs,
} from '../launchPresence';

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
  });

  it('reads the process table only when asked and still undecided, and a failed read is unknown', () => {
    expect(body).toMatch(/params\['probeProcess'\] === true && launchPresenceNeedsProcessRead\(inputs\)/);
    expect(body).toMatch(/agentProcessTracker\.idleShellState\(session\.meta\.pid, session\.meta\.env, true\)/);
    expect(body).toMatch(/idleShell = 'error'/);
    expect(body).toMatch(/decideLaunchPresence\(\{ \.\.\.inputs, idleShell \}\)/);
  });
});
