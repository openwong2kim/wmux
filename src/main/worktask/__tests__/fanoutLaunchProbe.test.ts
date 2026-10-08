// #1919 / #1933 — the fan-out launch probe answers `false` ("the agent never
// started") only on the daemon's positive evidence of absence. A pane whose
// agent identity is not known yet must never read as a failed launch.
import { describe, it, expect, vi } from 'vitest';
import {
  createDaemonLaunchProbe,
  LAUNCH_PROBE_CONFIRM_TIMEOUT_MS,
  LAUNCH_PROBE_TIMEOUT_MS,
  type LaunchProbeDaemon,
} from '../fanoutLaunchProbe';

function daemonAnswering(answer: unknown | ((params: Record<string, unknown>) => unknown)): LaunchProbeDaemon & {
  rpc: ReturnType<typeof vi.fn>;
} {
  return {
    isConnected: true,
    rpc: vi.fn(async (_method: string, params: Record<string, unknown>) =>
      typeof answer === 'function' ? (answer as (p: Record<string, unknown>) => unknown)(params) : answer,
    ),
  };
}

describe('createDaemonLaunchProbe', () => {
  it('a named agent → true', async () => {
    const dc = daemonAnswering({ presence: 'running', reason: 'agent-named', incarnationId: 'inc-1' });
    const probe = createDaemonLaunchProbe(() => dc);
    expect(await probe.agentRunning('pty-1')).toBe(true);
    expect(await probe.agentRunning('pty-1', { confirm: true })).toBe(true);
  });

  it('an agent process with no canonical name yet → never false (no false alarm)', async () => {
    // The daemon's process truth says something runs under the shell, but the
    // identity tiers have not named it: running (tracker) or unknown (children).
    for (const answer of [
      { presence: 'running', reason: 'agent-process-alive', incarnationId: 'inc-1' },
      { presence: 'unknown', reason: 'shell-has-children', incarnationId: 'inc-1' },
      { presence: 'unknown', reason: 'foreground-command', incarnationId: 'inc-1' },
    ]) {
      const probe = createDaemonLaunchProbe(() => daemonAnswering(answer));
      const verdict = await probe.agentRunning('pty-1', { confirm: true });
      expect(verdict === true || verdict === undefined).toBe(true);
    }
  });

  it('no agent process and no name, confirmed after the bound → false', async () => {
    const dc = daemonAnswering((params: Record<string, unknown>) =>
      params.probeProcess === true
        ? { presence: 'absent', reason: 'idle-shell', incarnationId: 'inc-1' }
        : { presence: 'unknown', reason: 'not-probed', incarnationId: 'inc-1' },
    );
    const probe = createDaemonLaunchProbe(() => dc);
    expect(await probe.agentRunning('pty-1', { confirm: true })).toBe(false);
    expect(dc.rpc).toHaveBeenCalledWith(
      'daemon.getLaunchPresence',
      { id: 'pty-1', probeProcess: true },
      { timeoutMs: LAUNCH_PROBE_CONFIRM_TIMEOUT_MS },
    );
  });

  it('a cheap poll never reads absence, even if a daemon answered it', async () => {
    const dc = daemonAnswering({ presence: 'absent', reason: 'idle-shell', incarnationId: 'inc-1' });
    const probe = createDaemonLaunchProbe(() => dc);
    expect(await probe.agentRunning('pty-1')).toBeUndefined();
    expect(dc.rpc).toHaveBeenCalledWith(
      'daemon.getLaunchPresence',
      { id: 'pty-1', probeProcess: false },
      { timeoutMs: LAUNCH_PROBE_TIMEOUT_MS },
    );
  });

  it('a known incarnation with no name and no process read is not a failed launch', async () => {
    // The CodeRabbit case: the old probe mapped exactly this to false.
    const dc = daemonAnswering({ presence: 'unknown', reason: 'not-probed', incarnationId: 'inc-1' });
    const probe = createDaemonLaunchProbe(() => dc);
    expect(await probe.agentRunning('pty-1')).toBeUndefined();
    expect(await probe.agentRunning('pty-1', { confirm: true })).toBeUndefined();
  });

  it('daemon unavailable → undefined', async () => {
    expect(await createDaemonLaunchProbe(() => null).agentRunning('pty-1', { confirm: true })).toBeUndefined();
    const disconnected = { ...daemonAnswering({ presence: 'absent' }), isConnected: false };
    expect(await createDaemonLaunchProbe(() => disconnected).agentRunning('pty-1', { confirm: true })).toBeUndefined();
    expect(disconnected.rpc).not.toHaveBeenCalled();
  });

  it('an RPC failure (old daemon without the method, timeout) → undefined', async () => {
    const dc: LaunchProbeDaemon = {
      isConnected: true,
      rpc: vi.fn(async () => {
        throw new Error('Unknown method: daemon.getLaunchPresence');
      }),
    };
    expect(await createDaemonLaunchProbe(() => dc).agentRunning('pty-1', { confirm: true })).toBeUndefined();
  });

  it('an unrecognised answer → undefined', async () => {
    for (const answer of [null, {}, { presence: 'gone' }, { agentName: null, incarnationId: 'inc-1' }]) {
      expect(
        await createDaemonLaunchProbe(() => daemonAnswering(answer)).agentRunning('pty-1', { confirm: true }),
      ).toBeUndefined();
    }
  });
});
