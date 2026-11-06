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
  const flush = () => {
    queued = false;
    if (!channel.send || channel.connected !== true) return;
    try {
      // The callback form routes an async failure here instead of to the
      // process 'error' event.
      channel.send(brokerConnectionsReport(open, [...tools.keys()]), () => undefined);
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
    toolStarted(name) {
      if (!BROKER_TOOL_NAME_RE.test(name)) return;
      tools.set(name, (tools.get(name) ?? 0) + 1);
      changed();
    },
    toolEnded(name) {
      const n = tools.get(name);
      if (n === undefined) return;
      if (n <= 1) tools.delete(name);
      else tools.set(name, n - 1);
      changed();
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
  transport.onmessage = (message: unknown, ...rest: never[]) => {
    const m = message as { id?: unknown; method?: unknown; params?: { name?: unknown } } | null;
    if (m && m.method === 'tools/call' && m.id !== undefined && typeof m.params?.name === 'string') {
      pending.set(m.id, m.params.name);
      reporter.toolStarted(m.params.name);
    }
    onmessage?.(message, ...rest);
  };
  const send = transport.send.bind(transport);
  transport.send = (message: unknown, ...rest: never[]) => {
    const id = (message as { id?: unknown; method?: unknown } | null)?.id;
    if (id !== undefined && !(message as { method?: unknown }).method && pending.has(id)) {
      reporter.toolEnded(pending.get(id) as string);
      pending.delete(id);
    }
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
