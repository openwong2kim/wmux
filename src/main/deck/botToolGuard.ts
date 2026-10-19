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

import type { RawSdkMessage } from './BrainAdapter';

export const BOT_TOOL_PREFIX = 'mcp__wmux__';

/** The MCP statuses that can still become usable within the turn. */
const NOT_YET_FAILED = new Set(['connected', 'pending']);

interface RawBlock {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

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
  private readonly started = new Map<string, string>();
  private wmuxOk = 0;
  private readonly unknown: string[] = [];

  /** `allowedTools`: the session's allowed tool names; its `mcp__wmux__`
   *  entries are the bot's wmux tools. */
  constructor(allowedTools: readonly string[]) {
    this.wmuxTools = new Set(allowedTools.filter((t) => t.startsWith(BOT_TOOL_PREFIX)));
  }

  /** Feed one raw SDK frame. Returns an error message when the session has
   *  no usable wmux tools at all (the turn should stop now), else null. */
  observe(msg: RawSdkMessage): string | null {
    if (msg.type === 'system' && msg.subtype === 'init') return this.onInit(msg);
    const blocks = (msg.message?.content ?? []) as RawBlock[];
    if (msg.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && typeof b.name === 'string') this.started.set(b.id, b.name);
      }
    } else if (msg.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const name = this.started.get(b.tool_use_id);
        if (name === undefined) continue;
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
