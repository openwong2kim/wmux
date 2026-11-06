import { brokerConnectionsReport } from '../shared/mcpSessions';

/** The slice of `process` the reporter uses: the IPC channel, when there is one. */
export interface ReportChannel {
  connected?: boolean;
  send?: (message: unknown, callback: (error: Error | null) => void) => boolean;
}

/**
 * Tells the supervisor how many shim connections the broker hosts. A burst of
 * opens and closes becomes one report on the next turn. Without a connected
 * channel (a broker started by hand, or a supervisor that went away) it does
 * nothing, and a channel that closes under a send is ignored: the count is
 * diagnostics only and must never stop or crash the broker.
 */
export function createConnectionReporter(channel: ReportChannel): { opened(): void; closed(): void } {
  let open = 0;
  let queued = false;
  const flush = () => {
    queued = false;
    if (!channel.send || channel.connected !== true) return;
    try {
      // The callback form routes an async failure here instead of to the
      // process 'error' event.
      channel.send(brokerConnectionsReport(open), () => undefined);
    } catch {
      // ERR_IPC_CHANNEL_CLOSED between the check and the send.
    }
  };
  const changed = () => {
    if (queued) return;
    queued = true;
    setImmediate(flush);
  };
  return {
    opened() {
      open++;
      changed();
    },
    closed() {
      open = Math.max(0, open - 1);
      changed();
    },
  };
}
