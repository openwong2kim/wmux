// How many subagents a pane's agent has running, read line by line from the
// agent's own transcript (TranscriptActivityWatcher hands every line it reads
// to the counter of its watch). The sidebar shows the count so a pane whose
// main turn ended, but whose subagents are still working, says why it is
// still running.
//
// Both counters start empty at the point the watch starts reading (Codex
// starts at end-of-file; Claude's one-time window replay is not fed here), so
// a subagent launched before the watch is not counted. That is the safe
// direction: a missed start shows nothing, a missed end would show a count
// that never goes away.

export interface SubagentCounter {
  /** One complete transcript line, in file order. */
  noteLine(line: string): void;
  /** Subagents currently running. */
  readonly count: number;
  /** Work its turns left running for the agent to hear about later, where the counter knows it (Claude). */
  readonly background?: number;
  /** Forget everything (lines were skipped, or the file was replaced). */
  reset(): void;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function parse(line: string): Record<string, unknown> | null {
  try { return record(JSON.parse(line)); } catch { return null; }
}

/** Most call ids remembered between a call and its SubAgentActivity record. */
const MAX_PENDING_CALLS = 256;

/**
 * Codex (multi_agent v2). The PARENT rollout records each sub-agent's
 * lifecycle as `event_msg` / `item_completed` with an item of type
 * `SubAgentActivity` naming the agent by `agent_thread_id`:
 *   - `started`      (id = the spawn_agent call id): the agent runs.
 *   - `interacted`   (id = the call id of a followup_task or send_message):
 *                    followup_task gives the agent a new task, so it runs;
 *                    send_message only delivers a message and changes
 *                    nothing (a child also uses it to report to its parent).
 *   - `completed` / `interrupted`: the agent's run ended.
 * The tool behind an `interacted` is looked up by call id among the
 * function_call records before it (the call is always written first). An
 * `interacted` whose call was not seen changes nothing.
 *
 * The parent's own `turn_aborted` ends them all. An interrupt of the parent
 * turn aborts every running child in the same instant, and the parent rollout
 * then records no `completed` for them (real rollouts, 2026-10-19: each child
 * rollout ends on its own `turn_aborted` ~30 ms before the parent's). The
 * parent's `task_complete` does not: a child can outlive the turn that
 * spawned it.
 */
export class CodexSubagentCounter implements SubagentCounter {
  private readonly running = new Set<string>();
  /** call id → tool name, for followup_task / send_message calls not yet matched. */
  private readonly calls = new Map<string, string>();

  get count(): number { return this.running.size; }

  reset(): void {
    this.running.clear();
    this.calls.clear();
  }

  noteLine(line: string): void {
    // Cheap pre-filter: only these record kinds can matter.
    const activity = line.includes('SubAgentActivity');
    const aborted = line.includes('turn_aborted');
    if (!activity && !aborted && !line.includes('followup_task') && !line.includes('send_message')) return;
    const entry = parse(line);
    if (!entry) return;
    const payload = record(entry.payload);
    if (aborted && entry.type === 'event_msg' && payload.type === 'turn_aborted') {
      this.running.clear();
      return;
    }
    if (entry.type === 'response_item') {
      const name = payload.name;
      if ((name === 'followup_task' || name === 'send_message') && typeof payload.call_id === 'string') {
        this.calls.set(payload.call_id, name);
        if (this.calls.size > MAX_PENDING_CALLS) this.calls.delete(this.calls.keys().next().value as string);
      }
      return;
    }
    if (!activity || entry.type !== 'event_msg' || payload.type !== 'item_completed') return;
    const item = record(payload.item);
    const thread = item.agent_thread_id;
    if (item.type !== 'SubAgentActivity' || typeof thread !== 'string' || !thread) return;
    if (item.kind === 'started') this.running.add(thread);
    else if (item.kind === 'completed' || item.kind === 'interrupted') this.running.delete(thread);
    else if (item.kind === 'interacted' && typeof item.id === 'string') {
      if (this.calls.get(item.id) === 'followup_task') this.running.add(thread);
      this.calls.delete(item.id);
    }
  }
}

/** The tools that start a Claude subagent. */
const CLAUDE_AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
/** The tools that stop a background task by its task id (see wmux-bridge.mjs). */
const CLAUDE_TASK_STOP_TOOLS: ReadonlySet<string> = new Set(['TaskStop', 'KillShell', 'KillBash']);
/** The immediate result of an Agent call that left the agent running (the
 *  same shape wmux-bridge.mjs BACKGROUND_TASK_ID_RE matches), anchored at the
 *  start so a result that only quotes it started nothing. */
const ASYNC_AGENT_RE = /^\s*Async agent launched successfully[\s\S]*?agentId:\s*([\w-]+)/i;
/** The tools that can leave work running past their call: a Bash command run in the background, a Monitor. */
const CLAUDE_BACKGROUND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor']);
/** Their immediate result when they did (Claude Code 2.1), anchored like ASYNC_AGENT_RE: the task id. */
const BACKGROUND_STARTED_RES: readonly RegExp[] = [
  /^\s*Command running in background with ID:\s*([\w-]+)/,
  /^\s*Monitor started \(task\s+([\w-]+)/,
];

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => { const t = record(c).text; return typeof t === 'string' ? t : ''; }).join('');
}

/**
 * Claude Code. Two kinds of subagent are counted, background shells and
 * Monitors are not (`count`):
 *   - A foreground Agent/Task call runs until its tool_result arrives. A
 *     prompt the user typed also ends it (a call left without a result by an
 *     interrupt must not stay counted).
 *   - An async agent: the call's immediate result is "Async agent launched
 *     successfully … agentId: <id>". It runs until a `<task-notification>`
 *     names its tool_use id or its agent id (queue-operation `content`, a
 *     queued_command attachment's `prompt`, or the user record that delivers
 *     it), or a TaskStop names its agent id.
 * Only `assistant` / `user` records are read for tool calls: other records
 * (an `api-request-blob`) can carry copies of earlier turns.
 *
 * `background` is the work a turn left running for the agent to hear about
 * later (the headless delivery waits for it): the async agents above (until
 * their notification is handed to the agent, whatever its status), plus
 * background shells and Monitors. Those two start when their call's result
 * says so (BACKGROUND_STARTED_RES) and end on a `<task-notification>` that
 * names them and carries a `<status>`, once it is handed to the agent (a
 * queued_command attachment or the user record, not the queue-operation
 * written when it arrives): a Monitor sends one without a status for each
 * event it sees, and a notification queued while the turn still runs is not
 * the agent's yet. A TaskStop / KillShell naming one ends it too.
 */
export class ClaudeSubagentCounter implements SubagentCounter {
  /** Foreground Agent/Task calls without a result yet, by tool_use id. */
  private readonly foreground = new Set<string>();
  /** Async agents: tool_use id → agent id. */
  private readonly async = new Map<string, string>();
  /** Bash / Monitor calls without a result yet, by tool_use id. */
  private readonly backgroundCalls = new Set<string>();
  /** Background shells and Monitors: tool_use id → task id. */
  private readonly shells = new Map<string, string>();
  /** Async agents whose end the agent was not handed yet: tool_use id → agent id (`count` drops them earlier). */
  private readonly asyncUnheard = new Map<string, string>();

  get count(): number { return this.foreground.size + this.async.size; }

  /** Async agents, background shells and Monitors still running. */
  get background(): number { return this.asyncUnheard.size + this.shells.size; }

  reset(): void {
    this.foreground.clear();
    this.async.clear();
    this.backgroundCalls.clear();
    this.shells.clear();
    this.asyncUnheard.clear();
  }

  private settleAgentId(agentId: string): void {
    for (const [toolUseId, id] of this.async) if (id === agentId) this.async.delete(toolUseId);
  }

  private settleShell(taskId: string): void {
    for (const [toolUseId, id] of this.shells) if (id === taskId) this.shells.delete(toolUseId);
    for (const [toolUseId, id] of this.asyncUnheard) if (id === taskId) this.asyncUnheard.delete(toolUseId);
  }

  noteLine(line: string): void {
    const notification = line.includes('<task-notification>');
    const turnEnd = (this.foreground.size > 0 || this.backgroundCalls.size > 0) && line.includes('"stop_reason":"');
    if (!notification && !turnEnd && !line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"type":"user"')) return;
    const entry = parse(line);
    // A subagent's own records (older Claude Code wrote them into the lead's
    // transcript) are its conversation, not the lead's: its task prompt is no
    // human prompt, and its calls are not the lead's subagents.
    if (!entry || entry.isSidechain === true) return;
    const message = record(entry.message);
    // Only the conversation's own records: an `api-request-blob` carries a
    // copy of earlier turns, and re-reading its tool calls would revive them.
    const turn = entry.type === 'assistant' || entry.type === 'user';
    const content = turn && Array.isArray(message.content) ? message.content : null;
    // A prompt the user typed: no foreground call of the turn before it runs.
    if (entry.type === 'user' && entry.isMeta !== true && entry.isCompactSummary !== true
      && record(entry.origin).kind !== 'task-notification'
      && (typeof message.content === 'string' || (content && !content.some((b) => record(b).type === 'tool_result')))) {
      this.foreground.clear();
      this.backgroundCalls.clear();
    }
    // The lead's turn ended: no foreground call of it still runs (one left
    // without a result by an interrupt, say).
    if (entry.type === 'assistant' && typeof message.stop_reason === 'string' && message.stop_reason !== 'tool_use'
      && !(content ?? []).some((b) => record(b).type === 'tool_use')) {
      this.foreground.clear();
      this.backgroundCalls.clear();
    }
    for (const raw of content ?? []) {
      const block = record(raw);
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (CLAUDE_AGENT_TOOLS.has(block.name)) this.foreground.add(block.id);
        else if (CLAUDE_BACKGROUND_TOOLS.has(block.name)) this.backgroundCalls.add(block.id);
        else if (CLAUDE_TASK_STOP_TOOLS.has(block.name)) {
          const input = record(block.input);
          const taskId = input.task_id ?? input.shell_id ?? input.bash_id;
          if (typeof taskId === 'string' && taskId) {
            this.settleAgentId(taskId);
            this.settleShell(taskId);
          }
        }
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        if (this.backgroundCalls.delete(block.tool_use_id)) {
          const text = resultText(block.content);
          const taskId = BACKGROUND_STARTED_RES.map((re) => re.exec(text)?.[1]).find((id) => id !== undefined);
          if (taskId) this.shells.set(block.tool_use_id, taskId);
          continue;
        }
        if (!this.foreground.delete(block.tool_use_id)) continue;
        const agentId = ASYNC_AGENT_RE.exec(resultText(block.content))?.[1];
        if (agentId) {
          this.async.set(block.tool_use_id, agentId);
          this.asyncUnheard.set(block.tool_use_id, agentId);
        }
      }
    }
    if (!notification) return;
    // The notification's body: a queue-operation's `content`, a queued_command
    // attachment's `prompt`, or the user record it is delivered as.
    const body = entry.type === 'queue-operation' ? entry.content
      : entry.type === 'attachment' ? record(entry.attachment).prompt
        : entry.type === 'user' ? resultText(message.content)
          : undefined;
    if (typeof body !== 'string' || !body.includes('<task-notification>')) return;
    // Its arrival settles an async agent, whatever its <status> says.
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]?.trim();
    if (toolUseId) this.async.delete(toolUseId);
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim();
    if (taskId) this.settleAgentId(taskId);
    if (entry.type === 'queue-operation') return;
    // Handed to the agent: an async agent's end, whatever its status.
    if (toolUseId) this.asyncUnheard.delete(toolUseId);
    if (taskId) for (const [id, agentId] of this.asyncUnheard) if (agentId === taskId) this.asyncUnheard.delete(id);
    // A shell or Monitor: only its last notification (with a status).
    if (!/<status>[^<]*<\/status>/.test(body)) return;
    if (toolUseId) this.shells.delete(toolUseId);
    if (taskId) this.settleShell(taskId);
  }
}

/** A fresh counter for an agent whose subagents can be counted. */
export const SUBAGENT_COUNTERS: Readonly<Record<string, () => SubagentCounter>> = {
  claude: () => new ClaudeSubagentCounter(),
  codex: () => new CodexSubagentCounter(),
};
