import { BROKER_TOOL_NAME_RE, brokerConnectionsReport } from '../shared/mcpSessions';

/** The slice of `process` the reporter uses: the IPC channel, when there is one. */
export interface ReportChannel {
  connected?: boolean;
  send?: (message: unknown, callback: (error: Error | null) => void) => boolean;
}

export interface ConnectionReporter {
  opened(): void;
  closed(): void;
  /** A tools/call started; only a valid tool name is ever reported. */
  toolStarted(name: string): void;
  toolEnded(name: string): void;
}

/**
 * Tells the supervisor how many shim connections the broker hosts, and the
 * names of the tool calls in flight (so a crash can say what it cut off). A
 * burst of changes becomes one report on the next turn. Without a connected
 * channel (a broker started by hand, or a supervisor that went away) it does
 * nothing, and a channel that closes under a send is ignored: the count is
 * diagnostics only and must never stop or crash the broker.
 */
export function createConnectionReporter(channel: ReportChannel): ConnectionReporter {
  let open = 0;
  /** Calls in flight per tool name. */
  const tools = new Map<string, number>();
  let queued = false;
  let lastSent = '';
  const flush = () => {
    queued = false;
    if (!channel.send || channel.connected !== true) return;
    const report = brokerConnectionsReport(open, [...tools.keys()]);
    const key = JSON.stringify(report);
    if (key === lastSent) return;
    try {
      // The callback form routes an async failure here instead of to the
      // process 'error' event.
      channel.send(report, () => undefined);
      lastSent = key;
    } catch {
      // ERR_IPC_CHANNEL_CLOSED between the check and the send.
    }
  };
  const changed = () => {
    if (queued) return;
    queued = true;
    setImmediate(flush);
  };
  // A tool name joining or leaving the set is sent at once, before the call
  // runs: a crash in the call itself should still find its name reported.
  const namesChanged = () => flush();
  return {
    opened() {
      open++;
      changed();
    },
    closed() {
      open = Math.max(0, open - 1);
      changed();
    },
    toolStarted(name) {
      if (!BROKER_TOOL_NAME_RE.test(name)) return;
      const n = tools.get(name) ?? 0;
      tools.set(name, n + 1);
      if (n === 0) namesChanged();
    },
    toolEnded(name) {
      const n = tools.get(name);
      if (n === undefined) return;
      if (n <= 1) {
        tools.delete(name);
        namesChanged();
      } else {
        tools.set(name, n - 1);
      }
    },
  };
}

/** The slice of an MCP transport tool tracking wraps. */
export interface TrackedTransport {
  onmessage?: (message: unknown, ...rest: never[]) => void;
  send: (message: unknown, ...rest: never[]) => Promise<void>;
}

/**
 * Follow a connection's tools/call requests to their responses and report
 * the tool names in flight. Only the name is read, never the arguments.
 * Returns a dispose that ends whatever is still in flight (the connection
 * closed before answering).
 */
export function trackToolCalls(transport: TrackedTransport, reporter: ConnectionReporter): () => void {
  const pending = new Map<unknown, string>();
  const onmessage = transport.onmessage;
  const end = (id: unknown) => {
    const name = pending.get(id);
    if (name === undefined) return;
    pending.delete(id);
    reporter.toolEnded(name);
  };
  transport.onmessage = (message: unknown, ...rest: never[]) => {
    const m = message as { id?: unknown; method?: unknown; params?: { name?: unknown; requestId?: unknown } } | null;
    if (m && m.method === 'tools/call' && m.id !== undefined && typeof m.params?.name === 'string') {
      // A reused id replaces its earlier call rather than counting twice.
      end(m.id);
      pending.set(m.id, m.params.name);
      reporter.toolStarted(m.params.name);
    } else if (m && m.method === 'notifications/cancelled' && m.params?.requestId !== undefined) {
      // A cancelled call gets no response from the server.
      end(m.params.requestId);
    }
    onmessage?.(message, ...rest);
  };
  const send = transport.send.bind(transport);
  transport.send = (message: unknown, ...rest: never[]) => {
    const id = (message as { id?: unknown; method?: unknown } | null)?.id;
    if (id !== undefined && !(message as { method?: unknown }).method) end(id);
    return send(message, ...rest);
  };
  return () => {
    for (const name of pending.values()) reporter.toolEnded(name);
    pending.clear();
  };
}

/**
 * Count `socket` as open until it closes. Called before any await, so a socket
 * that closes while its session is still being set up is counted closed too;
 * one already closed is never left counted.
 */
export function trackConnection(
  socket: { destroyed: boolean; once(event: 'close', listener: () => void): unknown },
  reporter: { opened(): void; closed(): void },
): void {
  reporter.opened();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    reporter.closed();
  };
  if (socket.destroyed) close();
  else socket.once('close', close);
}
