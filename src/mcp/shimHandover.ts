/**
 * What shim.ts reads of the MCP traffic it pumps, so a session survives the
 * broker going away after the ack. The same rules as the native shim's
 * core/wmux-native/src/mcp_shim/handover.rs.
 *
 * MCP over stdio is newline-delimited JSON-RPC. The shim splits both
 * directions into lines and reads only the top level of each message: its id,
 * its method, and whether it carries an error. Values are skipped unparsed, so
 * a large tool result costs one pass over its bytes; ids and method names are
 * small tokens read with JSON.parse.
 *
 * `Calls` keeps what a handover needs: the ids of the host's requests the
 * broker has not answered yet (less those the host cancelled), and the host's
 * `initialize` request and `notifications/initialized` notification.
 */

/** The id the replayed `initialize` carries, so its reply can be told apart
 *  from the host's own calls and dropped. */
export const REPLAY_ID = 'wmux-shim-replay';

/** The error message for a call the broker took and never answered. It is
 *  what the model reads, so it says plainly not to assume the call did nothing. */
export const MAY_HAVE_RUN =
  'The wmux MCP broker stopped while this call was in flight, so it may have run. '
  + 'It was not retried. Do not assume it did not run: check its effect before you repeat it. '
  + 'Later calls go to a new wmux MCP server.';

/** The JSON-RPC error code for MAY_HAVE_RUN (implementation-defined server error). */
export const MAY_HAVE_RUN_CODE = -32000;

const NL = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

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
  /** Where the id's value sits in the line. */
  idSpan?: [number, number];
  /** The method name of a request or a notification. */
  method?: string;
  /** The message has an `error` member (a failed response). */
  error: boolean;
  /** Where the `params` value sits in the line. */
  paramsSpan?: [number, number];
}

/** A small JSON token (a key, an id, a method, a cancel's params) parsed. */
function token(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Canonical JSON text of a number or string id; undefined for anything else. */
function canonicalId(v: unknown): string | undefined {
  return typeof v === 'number' || typeof v === 'string' ? JSON.stringify(v) : undefined;
}

const isSpace = (c: number | undefined) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

class Scan {
  i = 0;
  constructor(private readonly b: Buffer) {}

  ws(): void {
    while (isSpace(this.b[this.i])) this.i++;
  }

  eat(c: number): boolean {
    if (this.b[this.i] !== c) return false;
    this.i++;
    return true;
  }

  /** A string at `i`: its span, quotes included, or undefined. */
  string(): [number, number] | undefined {
    const start = this.i;
    if (!this.eat(QUOTE)) return undefined;
    for (;;) {
      const c = this.b[this.i];
      if (c === undefined) return undefined;
      if (c === QUOTE) {
        this.i++;
        return [start, this.i];
      }
      this.i += c === BACKSLASH ? 2 : 1;
    }
  }

  /** Any value at `i`, skipped: its span. */
  value(): [number, number] | undefined {
    const start = this.i;
    const c = this.b[this.i];
    if (c === undefined) return undefined;
    if (c === QUOTE) return this.string();
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      for (;;) {
        const d = this.b[this.i];
        if (d === undefined) return undefined;
        if (d === QUOTE) {
          if (!this.string()) return undefined;
          continue;
        }
        if (d === 0x7b || d === 0x5b) depth++;
        else if (d === 0x7d || d === 0x5d) {
          depth--;
          if (depth === 0) {
            this.i++;
            return [start, this.i];
          }
        }
        this.i++;
      }
    }
    for (;;) {
      const d = this.b[this.i];
      if (d === undefined || d === 0x2c || d === 0x7d || d === 0x5d || isSpace(d)) break;
      this.i++;
    }
    return this.i > start ? [start, this.i] : undefined;
  }

  /** An object at `i`. A key seen twice keeps its last value, as JSON.parse does. */
  object(): Peek | undefined {
    if (!this.eat(0x7b)) return undefined;
    const peek: Peek = { error: false };
    this.ws();
    if (this.eat(0x7d)) return peek;
    for (;;) {
      this.ws();
      const k = this.string();
      if (!k) return undefined;
      const key = token(this.b.subarray(k[0], k[1]));
      if (typeof key !== 'string') return undefined;
      this.ws();
      if (!this.eat(0x3a)) return undefined;
      this.ws();
      const v = this.value();
      if (!v) return undefined;
      if (key === 'id') {
        peek.id = canonicalId(token(this.b.subarray(v[0], v[1])));
        peek.idSpan = v;
      } else if (key === 'method') {
        const m = token(this.b.subarray(v[0], v[1]));
        peek.method = typeof m === 'string' ? m : undefined;
      } else if (key === 'error') {
        peek.error = true;
      } else if (key === 'params') {
        peek.paramsSpan = v;
      }
      this.ws();
      if (this.eat(0x2c)) continue;
      if (this.eat(0x7d)) return peek;
      return undefined;
    }
  }

  /** A batch at `i`: the objects in it. */
  batch(): Peek[] | undefined {
    if (!this.eat(0x5b)) return undefined;
    const out: Peek[] = [];
    this.ws();
    if (this.eat(0x5d)) return out;
    for (;;) {
      this.ws();
      if (this.b[this.i] === 0x7b) {
        const p = this.object();
        if (!p) return undefined;
        out.push(p);
      } else if (!this.value()) {
        return undefined;
      }
      this.ws();
      if (this.eat(0x2c)) continue;
      if (this.eat(0x5d)) return out;
      return undefined;
    }
  }
}

/** The messages of one line: one for an object, one per object of a batch,
 *  none for anything else (not JSON, or not an object). */
export function peek(line: Buffer): Peek[] {
  const s = new Scan(line);
  s.ws();
  const c = line[s.i];
  if (c === 0x7b) {
    const p = s.object();
    return p ? [p] : [];
  }
  if (c === 0x5b) return s.batch() ?? [];
  return [];
}

/** The error the host gets for each call in flight at a handover. `id` is the
 *  id as the host spelled it, so the host matches it whatever its number form. */
export function mayHaveRun(id: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":'),
    Buffer.from(id),
    Buffer.from(`,"error":{"code":${MAY_HAVE_RUN_CODE},"message":${JSON.stringify(MAY_HAVE_RUN)}}}\n`),
  ]);
}

/** The reply to the replayed `initialize`: true when it is an error, false
 *  for a result, undefined for any other line. */
export function replayAnswer(line: Buffer): boolean | undefined {
  const p = peek(line);
  if (p.length === 1 && p[0].method === undefined && p[0].id === JSON.stringify(REPLAY_ID)) return p[0].error;
  return undefined;
}

/** What the host has asked that the broker still owes it, and what a new
 *  server needs to take the session over. */
export class Calls {
  /** Each request owed an answer: its canonical id, and the id as the host spelled it. */
  private inFlight: { id: string; raw: Buffer }[] = [];
  /** The host's `initialize` request, re-keyed to REPLAY_ID, with its own id. */
  private init: { replay: Buffer; id: string } | undefined;
  private initAnswered = false;
  private initialized: Buffer | undefined;
  private handedOver = false;

  private settle(id: string): void {
    const at = this.inFlight.findIndex((x) => x.id === id);
    if (at !== -1) this.inFlight.splice(at, 1);
  }

  /** A line from the host, before it goes to the broker. */
  sent(line: Buffer): void {
    if (this.handedOver) return;
    const batch = line.find((c) => !isSpace(c)) === 0x5b;
    for (const p of peek(line)) {
      if (p.id !== undefined && p.method !== undefined) {
        const [s, e] = p.idSpan as [number, number];
        // A batched initialize is not cached: MCP never batches it.
        if (!batch && p.method === 'initialize') {
          const replay = Buffer.concat([line.subarray(0, s), Buffer.from(JSON.stringify(REPLAY_ID)), line.subarray(e)]);
          this.init = { replay, id: p.id };
          this.initAnswered = false;
        }
        this.inFlight.push({ id: p.id, raw: Buffer.from(line.subarray(s, e)) });
      } else if (p.id === undefined && p.method === 'notifications/initialized') {
        this.initialized = Buffer.from(line);
      } else if (p.id === undefined && p.method === 'notifications/cancelled' && p.paramsSpan) {
        // A cancelled request gets no answer (MCP), so it is owed none.
        const params = token(line.subarray(p.paramsSpan[0], p.paramsSpan[1]));
        const id = typeof params === 'object' && params !== null
          ? canonicalId((params as { requestId?: unknown }).requestId)
          : undefined;
        if (id !== undefined) this.settle(id);
      }
    }
  }

  /** A line from the broker. False once the session has been handed over:
   *  the line is dropped (its call was already answered with an error). */
  answered(line: Buffer): boolean {
    if (this.handedOver) return false;
    for (const p of peek(line)) {
      if (p.id === undefined || p.method !== undefined) continue;
      this.settle(p.id);
      if (this.init?.id === p.id) this.initAnswered = !p.error;
    }
    return true;
  }

  /** The handover, once: the ids to answer with MAY_HAVE_RUN (as the host
   *  spelled them), and the lines a new server gets first (the `initialize`
   *  under REPLAY_ID and the `initialized` notification, only when the broker
   *  answered that `initialize` with a result). */
  handOver(): { ids: Buffer[]; replay: Buffer[] } {
    this.handedOver = true;
    const ids = this.inFlight.map((x) => x.raw);
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
