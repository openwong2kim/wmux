/**
 * What shim.ts reads of the MCP traffic it pumps, so a session survives the
 * broker going away after the ack. The same rules as the native shim's
 * core/wmux-native/src/mcp_shim/handover.rs.
 *
 * MCP over stdio is newline-delimited JSON-RPC. The shim splits both
 * directions into lines and reads the top level of each message: its id, its
 * method, and whether it carries an error.
 *
 * `Calls` keeps what a handover needs: the ids of the host's requests the
 * broker has not answered yet, and the host's `initialize` request and
 * `notifications/initialized` notification.
 */

/** The id the replayed `initialize` carries, so its reply can be told apart
 *  from the host's own calls and dropped. */
export const REPLAY_ID = 'wmux-shim-replay';

/** The error message for a call the broker took and never answered. */
export const MAY_HAVE_RUN =
  'The wmux MCP broker stopped while this call was in flight. '
  + 'It may have run; it was not retried. Later calls go to a new wmux MCP server.';

/** The JSON-RPC error code for MAY_HAVE_RUN (implementation-defined server error). */
export const MAY_HAVE_RUN_CODE = -32000;

const NL = 0x0a;

/** Splits a byte stream into lines, each with its `\n`. */
export class Lines {
  private partial: Buffer[] = [];

  /** Calls `each` with every line `chunk` completes, in order. Bytes after
   *  the last `\n` wait for the next chunk. */
  push(chunk: Buffer, each: (line: Buffer) => void): void {
    let start = 0;
    let nl = chunk.indexOf(NL, start);
    while (nl !== -1) {
      const line = chunk.subarray(start, nl + 1);
      if (this.partial.length === 0) {
        each(line);
      } else {
        this.partial.push(line);
        const whole = Buffer.concat(this.partial);
        this.partial = [];
        each(whole);
      }
      start = nl + 1;
      nl = chunk.indexOf(NL, start);
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
  }

  /** The bytes after the last `\n`, which no line holds. */
  takeRest(): Buffer {
    const rest = Buffer.concat(this.partial);
    this.partial = [];
    return rest;
  }
}

/** The top level of one JSON-RPC message. */
export interface Peek {
  /** The id as canonical JSON text (`7`, `"a"`); undefined for a missing,
   *  null or other id. */
  id?: string;
  /** The method name of a request or a notification. */
  method?: string;
  /** The message has an `error` member (a failed response). */
  error: boolean;
}

function peekObject(value: unknown): Peek | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const m = value as { id?: unknown; method?: unknown };
  return {
    id: typeof m.id === 'number' || typeof m.id === 'string' ? JSON.stringify(m.id) : undefined,
    method: typeof m.method === 'string' ? m.method : undefined,
    error: Object.prototype.hasOwnProperty.call(value, 'error'),
  };
}

/** The parsed line, or undefined for anything that is not JSON. */
function parse(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The messages of one line: one for an object, one per object of a batch,
 *  none for anything else (not JSON, or not an object). */
export function peek(line: Buffer): Peek[] {
  const value = parse(line);
  const items = Array.isArray(value) ? value : [value];
  return items.map(peekObject).filter((p): p is Peek => p !== undefined);
}

/** The error the host gets for each call in flight at a handover. */
export function mayHaveRun(id: string): string {
  return `{"jsonrpc":"2.0","id":${id},"error":{"code":${MAY_HAVE_RUN_CODE},"message":${JSON.stringify(MAY_HAVE_RUN)}}}\n`;
}

/** True for the reply to the replayed `initialize`. */
export function isReplayAnswer(line: Buffer): boolean {
  const p = peek(line);
  return p.length === 1 && p[0].method === undefined && p[0].id === JSON.stringify(REPLAY_ID);
}

/** What the host has asked that the broker still owes it, and what a new
 *  server needs to take the session over. */
export class Calls {
  private inFlight: string[] = [];
  /** The host's `initialize` request, re-keyed to REPLAY_ID, with its own id. */
  private init: { replay: Buffer; id: string } | undefined;
  private initAnswered = false;
  private initialized: Buffer | undefined;
  private handedOver = false;

  /** A line from the host, before it goes to the broker. */
  sent(line: Buffer): void {
    if (this.handedOver) return;
    const value = parse(line);
    const batch = Array.isArray(value);
    for (const item of batch ? value : [value]) {
      const p = peekObject(item);
      if (!p) continue;
      if (p.id !== undefined && p.method !== undefined) {
        // A batched initialize is not cached: MCP never batches it.
        if (!batch && p.method === 'initialize') {
          this.init = { replay: Buffer.from(JSON.stringify({ ...(item as object), id: REPLAY_ID }) + '\n'), id: p.id };
          this.initAnswered = false;
        }
        this.inFlight.push(p.id);
      } else if (p.id === undefined && p.method === 'notifications/initialized') {
        this.initialized = line;
      }
    }
  }

  /** A line from the broker. False once the session has been handed over:
   *  the line is dropped (its call was already answered with an error). */
  answered(line: Buffer): boolean {
    if (this.handedOver) return false;
    // Nothing owed: no need to read the line (a large tool result).
    if (this.inFlight.length === 0) return true;
    for (const p of peek(line)) {
      if (p.id === undefined || p.method !== undefined) continue;
      const at = this.inFlight.indexOf(p.id);
      if (at !== -1) this.inFlight.splice(at, 1);
      if (this.init?.id === p.id) this.initAnswered = !p.error;
    }
    return true;
  }

  /** The handover, once: the ids to answer with MAY_HAVE_RUN, and the lines
   *  a new server gets first (the `initialize` under REPLAY_ID and the
   *  `initialized` notification, only when the broker answered that
   *  `initialize` with a result). */
  handOver(): { ids: string[]; replay: Buffer[] } {
    this.handedOver = true;
    const ids = this.inFlight;
    this.inFlight = [];
    const replay: Buffer[] = [];
    if (this.initAnswered && this.init) {
      replay.push(this.init.replay);
      if (this.initialized) replay.push(this.initialized);
    }
    this.init = undefined;
    this.initialized = undefined;
    return { ids, replay };
  }
}
