// #1919 / #1933 — the fan-out launch probe's daemon side.
//
// The launch check (FanOutService.scheduleLaunchCheck) polls this cheaply
// while it waits for the worker's agent, and asks once with `confirm` after
// its bound. It may answer `false` ("no agent started") only on positive
// evidence of absence from the daemon: no canonical agent name, no live
// tracked agent process, no running foreground command, and a fresh process
// snapshot that shows the pane's shell with no child process. The daemon
// takes that snapshot only for a `confirm` call (see daemon/launchPresence.ts).
//
// A missing name alone is never `false`: identity detection can lag, or fail
// to attribute a process, while the agent runs. Everything the daemon cannot
// decide — and a daemon that is down, too old to know the method, or slow —
// is `undefined`, which the check treats as no evidence (no warning).

import type { FanOutLaunchProbe } from './FanOutService';

/** One launch-probe read; a slow one is skipped, not waited on. */
export const LAUNCH_PROBE_TIMEOUT_MS = 2_000;
/** The confirming read enumerates the process table (a WMI query on Windows). */
export const LAUNCH_PROBE_CONFIRM_TIMEOUT_MS = 15_000;

/** The slice of DaemonClient the probe needs. */
export interface LaunchProbeDaemon {
  readonly isConnected: boolean;
  rpc(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export function createDaemonLaunchProbe(getDaemon: () => LaunchProbeDaemon | null): FanOutLaunchProbe {
  return {
    agentRunning: async (ptyId, opts) => {
      const dc = getDaemon();
      if (!dc?.isConnected) return undefined;
      const confirm = opts?.confirm === true;
      try {
        const res = (await dc.rpc(
          'daemon.getLaunchPresence',
          { id: ptyId, probeProcess: confirm },
          { timeoutMs: confirm ? LAUNCH_PROBE_CONFIRM_TIMEOUT_MS : LAUNCH_PROBE_TIMEOUT_MS },
        )) as { presence?: unknown } | null;
        const presence = res?.presence;
        if (presence === 'running') return true;
        // `absent` is decided by the daemon's process read, which only a
        // confirming call asks for; a cheap call's answer is never taken as one.
        if (presence === 'absent' && confirm) return false;
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}
