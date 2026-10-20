// ─── Bot tool guard — a bot turn that could not reach its wmux tools ───────
//
// A bot acts only through its wmux tools (room_post, handoff_send,
// fanout_start, …). Two ways a Claude SDK bot turn can lose them without the
// SDK reporting an error:
//
//   1. The wmux MCP server is not in the session (it failed to start, or the
//      session came up without any `mcp__wmux__` tool). The `system/init`
//      frame says so (`mcp_servers[].status`, `tools`).
//   2. The tools are there, but the model calls them by the bare names the
//      prompts use (`room_post` instead of `mcp__wmux__room_post`). Claude Code
//      answers "No such tool available" with no hint of the real name, and a
//      model that keeps the bare name ends the turn having posted nothing —
//      which used to settle the wake as done.
//
// The guard watches the raw SDK frames of one turn and names either case, so
// the adapter ends the turn with an error instead of a silent success.
//
// It also stops a turn stuck in a loop: the same tool called with the same
// input (key order ignored) failing the same way REPEAT_LIMIT times in a row,
// or two such calls alternating REPEAT_LIMIT times each. Without it the loop
// runs until maxTurns and spends the bot's budget. Calls and outcomes are kept
// as hashes only. Identical successes never stop a turn: a bot waiting on a
// worker polls a status read between sleeps and legitimately gets the same
// answer back; that wait is bounded by maxTurns and the turn timeout.

import { createHash } from 'node:crypto';
import type { RawSdkMessage } from './BrainAdapter';

export const BOT_TOOL_PREFIX = 'mcp__wmux__';

/** The MCP statuses that can still become usable within the turn. */
const NOT_YET_FAILED = new Set(['connected', 'pending']);

/** How many identical failing calls in a row (or alternations of a pair)
 *  end the turn. */
export const REPEAT_LIMIT = 3;

interface RawBlock {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  input?: unknown;
  content?: unknown;
  text?: string;
}

/** One finished call: what was called with what, and how it came out. */
interface CallOutcome {
  name: string;
  key: string;
  failed: boolean;
}

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` match. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A wmux tool's refusal: main answered `{ ok: false, … }`. The MCP server
 *  returns it as the first text block of an ordinary result (callRpc in
 *  src/mcp/index.ts sets no isError), so the SDK frame does not say it failed. */
function isRefusal(content: unknown): boolean {
  const first = Array.isArray(content) ? (content as RawBlock[]).find((c) => c?.type === 'text') : undefined;
  const text = typeof content === 'string' ? content : first?.text;
  if (typeof text !== 'string' || !text.trimStart().startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

/** A tool name as the bot's prompts spell it (room_post, not mcp__wmux__room_post). */
const shownName = (name: string): string => (name.startsWith(BOT_TOOL_PREFIX) ? name.slice(BOT_TOOL_PREFIX.length) : name);

/** One line for a bot's system prompt: the exact names of its wmux tools. */
export function botToolNamingRule(allowedTools: readonly string[]): string {
  const names = allowedTools.filter((t) => t.startsWith(BOT_TOOL_PREFIX));
  if (names.length === 0) return '';
  return [
    `Tool names: your wmux tools are MCP tools named with the prefix ${BOT_TOOL_PREFIX}. This prompt and your wakes name them without it, so "room_post" means the tool ${BOT_TOOL_PREFIX}room_post.`,
    `Call them only by their full names: ${names.join(', ')}. A bare name such as room_post is not a tool and fails with "No such tool available".`,
  ].join(' ');
}

export class BotToolGuard {
  private sessionTools: Set<string> | null = null;
  private readonly wmuxTools: ReadonlySet<string>;
  /** tool_use id → its name and the hash of its input. */
  private readonly started = new Map<string, { name: string; input: string }>();
  private wmuxOk = 0;
  private readonly unknown: string[] = [];
  /** The last 2 × REPEAT_LIMIT finished calls, oldest first. */
  private readonly recent: CallOutcome[] = [];

  /** `allowedTools`: the session's allowed tool names; its `mcp__wmux__`
   *  entries are the bot's wmux tools. */
  constructor(allowedTools: readonly string[]) {
    this.wmuxTools = new Set(allowedTools.filter((t) => t.startsWith(BOT_TOOL_PREFIX)));
  }

  /** Feed one raw SDK frame. Returns an error message when the session has
   *  no usable wmux tools at all, or the model is stuck repeating a failing
   *  call (the turn should stop now), else null. */
  observe(msg: RawSdkMessage): string | null {
    if (msg.type === 'system' && msg.subtype === 'init') return this.onInit(msg);
    const blocks = (msg.message?.content ?? []) as RawBlock[];
    if (msg.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && typeof b.name === 'string') {
          this.started.set(b.id, { name: b.name, input: hashOf(canonicalJson(b.input)) });
        }
      }
    } else if (msg.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const call = this.started.get(b.tool_use_id);
        if (call === undefined) continue;
        const { name } = call;
        // A refusal counts as a failed call here only. It still counts as
        // reaching the wmux tools below: the name worked, so verdict() must
        // not report it as a naming slip.
        const failed = b.is_error === true || (name.startsWith(BOT_TOOL_PREFIX) && isRefusal(b.content));
        const loop = this.onOutcome({ name, key: hashOf(`${name}\0${call.input}\0${failed}\0${canonicalJson(b.content)}`), failed });
        if (loop) return loop;
        if (name.startsWith(BOT_TOOL_PREFIX)) {
          if (b.is_error !== true) this.wmuxOk += 1;
        } else if (this.isBareWmuxName(name)) {
          this.unknown.push(name);
        }
      }
    }
    return null;
  }

  /** At the end of the turn: an error message when the brain tried tools it
   *  does not have and reached none of its wmux tools, else null. A turn that
   *  slipped once and then used the real name is fine. */
  verdict(): string | null {
    if (this.wmuxOk > 0 || this.unknown.length === 0) return null;
    const names = [...new Set(this.unknown)].slice(0, 5).join(', ');
    return `the bot called ${names}, which are not its tools (its wmux tools are named ${BOT_TOOL_PREFIX}<name>), so nothing it meant to post or hand off went out`;
  }

  /** Record one finished call; a stop message when it completes a loop. */
  private onOutcome(c: CallOutcome): string | null {
    const r = this.recent;
    r.push(c);
    if (r.length > 2 * REPEAT_LIMIT) r.shift();
    const n = r.length;
    // The same failing call, REPEAT_LIMIT times in a row.
    if (c.failed && n >= REPEAT_LIMIT && r.slice(n - REPEAT_LIMIT).every((o) => o.key === c.key)) {
      return `Stopped: ${shownName(c.name)} was called ${REPEAT_LIMIT} times in a row with the same input and the same result.`;
    }
    // Two calls taking turns (A, B, A, B, …), at least one of them failing.
    if (n === 2 * REPEAT_LIMIT) {
      const a = r[0];
      const b = r[1];
      if (a.key !== b.key && (a.failed || b.failed) && r.every((o, i) => o.key === (i % 2 === 0 ? a : b).key)) {
        return `Stopped: ${shownName(a.name)} and ${shownName(b.name)} were called in turn ${REPEAT_LIMIT} times each with the same inputs and the same results.`;
      }
    }
    return null;
  }

  private onInit(msg: RawSdkMessage): string | null {
    const tools = Array.isArray(msg.tools) ? msg.tools.filter((t): t is string => typeof t === 'string') : null;
    if (tools) this.sessionTools = new Set(tools);
    const server = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.find((s) => s?.name === 'wmux') : undefined;
    const status = typeof server?.status === 'string' ? server.status : 'missing';
    if (!NOT_YET_FAILED.has(status)) return `the wmux tools did not load for this bot (wmux MCP server: ${status})`;
    if (status === 'connected' && tools && !tools.some((t) => t.startsWith(BOT_TOOL_PREFIX))) {
      return 'the wmux tools did not load for this bot (the wmux MCP server listed no tools)';
    }
    return null;
  }

  /** A call by a wmux tool's name without its prefix, which the session
   *  does not hold under that bare name. */
  private isBareWmuxName(name: string): boolean {
    if (this.sessionTools?.has(name)) return false;
    const full = BOT_TOOL_PREFIX + name;
    return this.wmuxTools.has(full) || this.sessionTools?.has(full) === true;
  }
}
