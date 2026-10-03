// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/integrations/harness/providers/claude/claudeProtocol.ts), MIT License, Copyright (c) 2026 Nick
//
// Pure helpers for Claude Code's stream-json protocol (`claude -p
// --input-format stream-json --output-format stream-json`): the launch argv,
// the stdin messages and control frames, and the parsers that read its stdout
// records. Changes from the source: wmux run modes and argv rules (one
// `--model=<id>` argument, the chat-v2 session id as the argv marker),
// attachments arrive as already-read images, and the model catalog, effort
// and settings-key helpers are left out.
import type { TaskListItem, ToolPreview, TurnMetrics } from '../../../../shared/chatv2/session';
import {
  isTaskListToolName,
  normalizeTaskListStatus,
  taskListFromToolInput,
} from '../../../../shared/chatv2/taskList';
import {
  questionPromptTitle,
  questionsFromUnknown,
  selectedAnswerLabels,
  type UserQuestion,
  type UserQuestionReply,
} from '../../../../shared/chatv2/userQuestion';
import {
  extractToolPreview,
  isAgentToolName,
  titleFromToolInput,
} from '../../../../shared/chatv2/preview';
import { streamTextDelta } from '../../../../shared/chatv2/streamText';
import type { ApprovalDecision } from '../../../../shared/chatv2/harnessEvents';
import type { ChatV2RunMode } from '../../../../shared/chatv2/ipc';

/** Production setting sources: the user's own hooks, rules and MCP servers apply. */
export const CLAUDE_SETTING_SOURCES = 'user,project,local';
/** What `--setting-sources` accepts here: a comma list of the three known sources. */
export const CLAUDE_SETTING_SOURCES_PATTERN = /^(user|project|local)(,(user|project|local)){0,2}$/;

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type ClaudeControlRequest = {
  requestId: string;
  subtype: string;
  toolName?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Epoch ms from a seconds or milliseconds epoch, or an ISO date. */
export function parseResetTimestamp(value: unknown): number | null {
  const normalize = (n: number): number | null => {
    if (!Number.isFinite(n) || n <= 0) return null;
    // 1e10 sits between a seconds epoch (<2286) and a milliseconds epoch (>2001).
    return n > 10_000_000_000 ? n : n * 1000;
  };
  if (typeof value === 'number') return normalize(value);
  if (typeof value !== 'string' || value.trim() === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return normalize(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** An image the driver already read from its staged path. */
export type ClaudeImage = { mimeType: string; data: string };

const ATTACHMENT_ONLY_PROMPT = 'See the attached image.';

export function buildClaudeUserMessage(input: {
  text: string;
  images?: ClaudeImage[];
}): Record<string, unknown> {
  const images = (input.images ?? []).flatMap((image) => {
    const mime = image.mimeType === 'image/jpg' ? 'image/jpeg' : image.mimeType;
    return SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(mime)
      ? [{ type: 'image', source: { type: 'base64', media_type: mime, data: image.data } }]
      : [];
  });
  const trimmed = input.text.trim();
  const text = trimmed || (images.length ? ATTACHMENT_ONLY_PROMPT : '');
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: 'text', text: input.text.trim() ? input.text : text });
  content.push(...images);
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

/**
 * The full argv after the `claude` executable. `model` is already checked
 * against `CHATV2_MODEL` and travels as ONE `--model=<id>` argument; the
 * provider session id is always in argv (`--session-id` or `--resume`), which
 * is the marker the orphan sweep matches.
 */
export function buildClaudeSpawnArgs(input: {
  mode: ChatV2RunMode;
  model: string;
  providerSession: { id: string; mode: 'new' | 'resume' };
  settingSources: string;
}): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    `--setting-sources=${input.settingSources}`,
  ];
  if (input.model) args.push(`--model=${input.model}`);
  if (input.mode === 'bypass') {
    args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  } else {
    // Pinned: without it the CLI falls back to the user's configured default
    // mode, which may auto-approve what this mode promises to ask about.
    args.push('--permission-mode', 'default');
  }
  args.push(input.providerSession.mode === 'resume' ? '--resume' : '--session-id', input.providerSession.id);
  return args;
}

export function buildControlRequest(
  requestId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'control_request',
    request_id: requestId,
    request,
  };
}

export function buildControlResponse(
  requestId: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response,
    },
  };
}

export type ClaudeControlResponse = {
  requestId: string;
  ok: boolean;
  payload: Record<string, unknown> | null;
  error?: string;
};

export function parseControlResponse(
  rec: Record<string, unknown>,
): ClaudeControlResponse | null {
  if (stringField(rec, 'type') !== 'control_response') return null;
  const nested = asRecord(rec.response);
  const requestId =
    stringField(nested, 'request_id') ?? stringField(rec, 'request_id') ?? '';
  if (!requestId) return null;
  const subtype = stringField(nested, 'subtype') ?? '';
  if (subtype === 'error') {
    return {
      requestId,
      ok: false,
      payload: null,
      error: stringField(nested, 'error') ?? 'control request failed',
    };
  }
  if (subtype && subtype !== 'success') return null;
  return {
    requestId,
    ok: true,
    payload: asRecord(nested?.response) ?? {},
  };
}

export function toClaudePermissionResult(
  decision: ApprovalDecision,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (decision === 'allow') {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message: 'User declined tool execution.',
  };
}

export function parseControlRequest(
  rec: Record<string, unknown>,
): ClaudeControlRequest | null {
  const type = stringField(rec, "type");
  if (type !== "control_request" && type !== "sdk_control_request") {
    return null;
  }
  const nested = asRecord(rec.request);
  const requestId =
    stringField(rec, "request_id") ?? stringField(nested, "request_id") ?? "";
  const subtype =
    stringField(nested, "subtype") ?? stringField(rec, "subtype") ?? "";
  if (!requestId || !subtype) return null;
  const input =
    asRecord(nested?.input) ??
    asRecord(nested?.tool_input) ??
    asRecord(rec.input) ??
    {};
  return {
    requestId,
    subtype,
    toolName: stringField(nested, "tool_name") ?? stringField(rec, "tool_name"),
    input,
    toolUseId:
      stringField(nested, "tool_use_id") ??
      stringField(nested, "toolUseID") ??
      stringField(rec, "tool_use_id"),
  };
}

export function parseControlCancelId(
  rec: Record<string, unknown>,
): string | undefined {
  if (stringField(rec, "type") !== "control_cancel_request") return undefined;
  return (
    stringField(rec, "request_id") ??
    stringField(asRecord(rec.request), "request_id")
  );
}

export function sessionIdFromMessage(
  rec: Record<string, unknown>,
): string | undefined {
  const type = stringField(rec, "type");
  const subtype = stringField(rec, "subtype");
  if (type === "system" && subtype?.startsWith("hook_")) return undefined;
  // Subagents can carry their own session id. Rebinding the parent to it
  // would drop resume for the conversation the user is actually in.
  const parent = rec.parent_tool_use_id;
  if (typeof parent === "string" && parent.length > 0) return undefined;
  return stringField(rec, "session_id");
}

/**
 * Claude Code pings `system/status` for every request lifecycle step
 * ("requesting", "responding", …). Codex and opencode only emit status text for
 * notable events — retries, warnings, compaction — so drop the lifecycle chatter
 * here and keep the transcript comparable across harnesses.
 */
const LIFECYCLE_STATUSES = new Set([
  "requesting",
  "request",
  "responding",
  "response",
  "streaming",
  "thinking",
  "working",
  "running",
  "pending",
  "queued",
  "waiting",
  "in_progress",
  "tool_use",
  "idle",
  "done",
  "completed",
  "status",
  "compact",
]);

export function statusTextFromSystem(
  rec: Record<string, unknown>,
): string | undefined {
  if (stringField(rec, "type") !== "system") return undefined;
  const subtype = stringField(rec, "subtype") ?? "";
  const compact = subtype.startsWith("compact");
  if (subtype !== "status" && !compact) return undefined;
  // Prose lives in `message`; `status` carries the bare lifecycle token.
  const text = (stringField(rec, "message") ?? "").trim();
  const notable =
    text && !LIFECYCLE_STATUSES.has(text.toLowerCase().replace(/[\s.…]+$/, ""));
  if (notable) return text;
  // Compaction is worth one row even when the CLI sends no prose with it.
  return compact ? "Compacted context" : undefined;
}

export function turnStatusFromResult(rec: Record<string, unknown>): {
  status: "completed" | "failed" | "interrupted" | "cancelled";
  error?: string;
} {
  const subtype = stringField(rec, "subtype") ?? "";
  if (subtype === "success") return { status: "completed" };
  const errors = Array.isArray(rec.errors)
    ? rec.errors.filter((item): item is string => typeof item === "string")
    : [];
  const joined = errors.join(" ").toLowerCase();
  const terminal = stringField(rec, "terminal_reason") ?? "";
  if (
    terminal === "aborted_tools" ||
    terminal === "aborted_streaming" ||
    joined.includes("interrupt")
  ) {
    return { status: "interrupted" };
  }
  if (joined.includes("cancel")) return { status: "cancelled" };
  const error = errors.find((item) => !item.startsWith("[ede_diagnostic]"));
  return { status: "failed", error: error ?? "Claude turn failed." };
}

/**
 * A `rate_limit_event` that refuses requests, with when its window resets.
 * `null` once requests are allowed again, or while extra usage is paying for
 * them and the turn goes on.
 */
export function usageLimitFromRateLimitEvent(
  rec: Record<string, unknown>,
): { resetsAt?: number } | null {
  const info = asRecord(rec.rate_limit_info);
  if (stringField(info, "status") !== "rejected") return null;
  if (info?.isUsingOverage === true) return null;
  const resetsAt = parseResetTimestamp(info?.resetsAt);
  return resetsAt != null ? { resetsAt } : {};
}

const USAGE_LIMIT_TEXT = /hit your (?:usage )?limit|usage limit reached/i;

/** Claude also ends a limited turn with the limit as its error text. */
export function isUsageLimitResult(rec: Record<string, unknown>): boolean {
  if (rec.is_error !== true) return false;
  const errors = Array.isArray(rec.errors)
    ? rec.errors.filter((item): item is string => typeof item === "string")
    : [];
  return [stringField(rec, "result") ?? "", ...errors].some((text) =>
    USAGE_LIMIT_TEXT.test(text),
  );
}

export function streamDeltaFromEvent(
  rec: Record<string, unknown>,
): { kind: "assistant" | "reasoning"; text: string } | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") {
    return null;
  }
  const delta = asRecord(event.delta);
  const deltaType = stringField(delta, "type") ?? "";
  if (deltaType === "text_delta") {
    const text = streamTextDelta(delta?.text);
    return text ? { kind: "assistant", text } : null;
  }
  if (deltaType === "thinking_delta") {
    const text = streamTextDelta(delta?.thinking);
    return text ? { kind: "reasoning", text } : null;
  }
  return null;
}

export function toolStartFromEvent(rec: Record<string, unknown>): {
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
} | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_start") {
    return null;
  }
  const block = asRecord(event.content_block);
  if (!block) return null;
  const blockType = stringField(block, "type") ?? "";
  if (
    blockType !== "tool_use" &&
    blockType !== "server_tool_use" &&
    blockType !== "mcp_tool_use"
  ) {
    return null;
  }
  const id = stringField(block, "id");
  const name = stringField(block, "name");
  if (!id || !name) return null;
  const index = typeof event.index === "number" ? event.index : -1;
  return {
    index,
    id,
    name,
    input: asRecord(block.input) ?? {},
  };
}

export function inputJsonDeltaFromEvent(
  rec: Record<string, unknown>,
): { index: number; partial: string } | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") {
    return null;
  }
  const delta = asRecord(event.delta);
  if (stringField(delta, "type") !== "input_json_delta") return null;
  const partial =
    typeof delta?.partial_json === "string" ? delta.partial_json : "";
  if (!partial) return null;
  const index = typeof event.index === "number" ? event.index : -1;
  return { index, partial };
}

export function isSubagentMessage(rec: Record<string, unknown>): boolean {
  const parent = rec.parent_tool_use_id;
  return typeof parent === "string" && parent.length > 0;
}

export function isAgentTaskType(taskType: string | undefined): boolean {
  const key = (taskType ?? "").toLowerCase();
  return key === "local_agent" || key === "remote_agent";
}

export type ClaudeAgentTaskStarted = {
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType: string;
  backgrounded: boolean;
  ambient: boolean;
};

export function parseTaskStarted(
  rec: Record<string, unknown>,
): ClaudeAgentTaskStarted | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_started"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    description: stringField(rec, "description") ?? "Subagent",
    taskType: stringField(rec, "task_type") ?? "",
    backgrounded: rec.is_backgrounded === true,
    ambient: rec.ambient === true,
  };
}

export type ClaudeAgentTaskProgress = {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  lastToolName?: string;
  summary?: string;
};

export function parseTaskProgress(
  rec: Record<string, unknown>,
): ClaudeAgentTaskProgress | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_progress"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    description: stringField(rec, "description") ?? "Subagent",
    subagentType: stringField(rec, "subagent_type"),
    lastToolName: stringField(rec, "last_tool_name"),
    summary: stringField(rec, "summary"),
  };
}

export type ClaudeAgentTaskUpdated = {
  taskId: string;
  status?: string;
  description?: string;
  error?: string;
  backgrounded?: boolean;
};

export function parseTaskUpdated(
  rec: Record<string, unknown>,
): ClaudeAgentTaskUpdated | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_updated"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  const patch = asRecord(rec.patch) ?? {};
  if (!taskId) return null;
  const backgrounded =
    patch.is_backgrounded === true
      ? true
      : patch.is_backgrounded === false
        ? false
        : undefined;
  return {
    taskId,
    status: stringField(patch, "status"),
    description: stringField(patch, "description"),
    error: stringField(patch, "error"),
    ...(backgrounded !== undefined ? { backgrounded } : {}),
  };
}

export type ClaudeAgentTaskNotification = {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary: string;
  ambient: boolean;
};

export function parseTaskNotification(
  rec: Record<string, unknown>,
): ClaudeAgentTaskNotification | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_notification"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    status: stringField(rec, "status") ?? "completed",
    summary: stringField(rec, "summary") ?? "",
    ambient: rec.ambient === true,
  };
}

export type ClaudeBackgroundTask = {
  taskId: string;
  taskType: string;
  description: string;
};

/** Every task Claude is running for the session: subagents, shells, monitors. */
export function parseBackgroundTasks(
  rec: Record<string, unknown>,
): ClaudeBackgroundTask[] | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "background_tasks_changed"
  ) {
    return null;
  }
  const tasks = Array.isArray(rec.tasks) ? rec.tasks : [];
  return tasks.flatMap((item) => {
    const row = asRecord(item);
    if (!row || row.ambient === true) return [];
    const taskId = stringField(row, "task_id");
    const taskType = stringField(row, "task_type") ?? "";
    if (!taskId) return [];
    return [
      {
        taskId,
        taskType,
        description: stringField(row, "description") ?? "Subagent",
      },
    ];
  });
}

export type ClaudeToolProgress = {
  toolUseId: string;
  parentToolUseId?: string;
  toolName?: string;
  subagentType?: string;
};

export function parseToolProgress(
  rec: Record<string, unknown>,
): ClaudeToolProgress | null {
  if (stringField(rec, "type") !== "tool_progress") return null;
  const toolUseId = stringField(rec, "tool_use_id");
  if (!toolUseId) return null;
  const parent = stringField(rec, "parent_tool_use_id");
  return {
    toolUseId,
    ...(parent ? { parentToolUseId: parent } : {}),
    toolName: stringField(rec, "tool_name"),
    subagentType: stringField(rec, "subagent_type"),
  };
}

export function isTerminalAgentTaskStatus(status: string | undefined): boolean {
  const key = (status ?? "").toLowerCase();
  return (
    key === "completed" ||
    key === "failed" ||
    key === "killed" ||
    key === "stopped"
  );
}

export function assistantTextBlocks(rec: Record<string, unknown>): string[] {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (stringField(row, "type") !== "text") return [];
    const text = typeof row?.text === "string" ? row.text : "";
    return text ? [text] : [];
  });
}

/** Reasoning a message carries, used to mirror a subagent's thinking. */
export function assistantThinkingBlocks(rec: Record<string, unknown>): string[] {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (stringField(row, "type") !== "thinking") return [];
    const text = typeof row?.thinking === "string" ? row.thinking : "";
    return text ? [text] : [];
  });
}

/** Provider id of an assistant message, for keying steps mirrored from it. */
export function assistantMessageId(
  rec: Record<string, unknown>,
): string | undefined {
  return stringField(asRecord(rec.message), "id");
}

export function assistantToolUses(rec: Record<string, unknown>): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_use") return [];
    const id = stringField(row, "id");
    const name = stringField(row, "name");
    if (!id || !name) return [];
    return [{ id, name, input: asRecord(row.input) ?? {} }];
  });
}

export function toolResultsFromUserMessage(
  rec: Record<string, unknown>,
): Array<{
  toolUseId: string;
  isError: boolean;
  text: string;
}> {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_result") return [];
    const toolUseId = stringField(row, "tool_use_id");
    if (!toolUseId) return [];
    const text = toolResultText(row.content);
    return [
      {
        toolUseId,
        isError: row.is_error === true,
        text,
      },
    ];
  });
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      const row = asRecord(block);
      if (
        stringField(row, "type") === "text" &&
        typeof row?.text === "string"
      ) {
        return [row.text];
      }
      return [];
    })
    .join("");
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  const rec = asRecord(value);
  const plan = stringField(rec, "plan");
  return plan;
}

export function extractAskUserQuestionTitle(
  input: Record<string, unknown>,
): string {
  return questionPromptTitle(questionsFromUnknown(input)) || "Claude question";
}

/**
 * The `updatedInput` that answers AskUserQuestion: Claude reads `answers`
 * keyed by each question's prompt. `questions` is the set the reply's ids
 * refer to (the driver's re-keyed copy); it defaults to Claude's own parse.
 */
export function askUserQuestionAllowInput(
  input: Record<string, unknown>,
  reply?: UserQuestionReply,
  questions: UserQuestion[] = questionsFromUnknown(input),
): Record<string, unknown> {
  const answers: Record<string, string> = {};
  if (reply?.kind === "answered") {
    for (const question of questions) {
      const labels = selectedAnswerLabels(question, reply);
      // A typed answer next to picked options (multi-select) is kept too.
      const custom = reply.custom?.[question.id]?.trim();
      if (custom && question.allowCustom && !labels.includes(custom)) labels.push(custom);
      if (labels.length === 0) continue;
      answers[question.prompt] = question.multiSelect
        ? labels.join(", ")
        : (labels[0] ?? "");
    }
  }
  return { questions: input.questions, answers };
}

export function tryParseJsonRecord(
  value: string,
): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function taskListFromTodos(
  input: Record<string, unknown>,
): TaskListItem[] | null {
  return taskListFromToolInput("TodoWrite", input);
}

export function isTodoTool(toolName: string): boolean {
  return isTaskListToolName(toolName);
}

/**
 * Newer Claude Code builds replace TodoWrite with incremental task tools:
 * TaskCreate adds one item and TaskUpdate changes one item by id.
 */
export function isClaudeTaskTool(toolName: string): boolean {
  return ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(
    toolName.trim(),
  );
}

/**
 * Fold one successful TaskCreate/TaskUpdate call into the session's task map.
 * Returns true when the visible list changed. TaskCreate only learns its id
 * from the result text ("Task #3 created successfully: ...").
 */
export function applyClaudeTaskTool(
  tasks: Map<string, TaskListItem>,
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
): boolean {
  const name = toolName.trim();
  if (name === "TaskCreate") {
    const text = [input.subject, input.activeForm, input.description]
      .find(
        (value): value is string =>
          typeof value === "string" && !!value.trim(),
      )
      ?.trim();
    const id = resultText.match(/Task #([^\s:]+)/)?.[1];
    if (!text || !id) return false;
    tasks.set(id, { id, text, status: "pending" });
    return true;
  }
  if (name === "TaskUpdate") {
    const rawId = input.taskId;
    const id =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === "string"
          ? rawId.trim().replace(/^#/, "")
          : "";
    const current = id ? tasks.get(id) : undefined;
    if (!current) return false;
    const status = stringField(input, "status")?.trim().toLowerCase();
    if (status === "deleted") {
      tasks.delete(id);
      return true;
    }
    const subject = stringField(input, "subject")?.trim();
    tasks.set(id, {
      ...current,
      ...(subject ? { text: subject } : {}),
      ...(status ? { status: normalizeTaskListStatus(status) } : {}),
    });
    return true;
  }
  return false;
}

export function toolKindFromName(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (isTodoTool(toolName) || isClaudeTaskTool(toolName)) return "tasks";
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "execute";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("multiedit")
  ) {
    return "edit";
  }
  if (normalized === "read" || normalized.includes("read")) return "read";
  if (
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search") ||
    normalized.includes("websearch")
  ) {
    return "search";
  }
  if (normalized === "skill" || normalized === "skills") return "skill";
  if (isAgentToolName(toolName)) return "agent";
  return toolName;
}

export function toolTitle(
  name: string,
  input: Record<string, unknown>,
): string {
  return titleFromToolInput(name, toolKindFromName(name), input);
}

export function previewFromTool(
  name: string,
  input: Record<string, unknown>,
  output?: string,
): ToolPreview | undefined {
  const kind = toolKindFromName(name);
  return extractToolPreview(
    {
      title: name,
      name,
      kind,
      input,
      rawInput: input,
      content: output,
    },
    {
      title: name,
      name,
      kind,
      rawInput: input,
    },
  );
}

export function summarizeToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  if (command) return `${toolName}: ${command.slice(0, 400)}`;
  const description = stringField(input, "description");
  if (description) return description;
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= 400) return `${toolName}: ${serialized}`;
    return `${toolName}: ${serialized.slice(0, 397)}...`;
  } catch {
    return toolName;
  }
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const value = rec?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Tokens occupying the window for one request.
 *
 * Cached reads still take up window space, so they count the same as fresh
 * input; output counts because it carries into the next request.
 */
function contextUsedFromUsage(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  return (
    numberField(usage, "input_tokens") +
    numberField(usage, "cache_creation_input_tokens") +
    numberField(usage, "cache_read_input_tokens") +
    numberField(usage, "output_tokens")
  );
}

/** Aggregate token accounting for the completed Claude turn. */
export function turnMetricsFromResult(
  rec: Record<string, unknown>,
): TurnMetrics | undefined {
  const usage = asRecord(rec.usage);
  if (!usage) return undefined;
  const inputTokens = numberField(usage, "input_tokens");
  const outputTokens = numberField(usage, "output_tokens");
  const cacheReadTokens = numberField(usage, "cache_read_input_tokens");
  const cacheWriteTokens = numberField(usage, "cache_creation_input_tokens");
  const cacheReported =
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage;
  const cacheableInput = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (!inputTokens && !outputTokens && !cacheableInput) return undefined;
  return {
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(cacheReported && cacheableInput
      ? { cacheHitPercent: (cacheReadTokens / cacheableInput) * 100 }
      : {}),
  };
}

/**
 * Context level from an `assistant` message. Callers must skip subagent
 * messages — subagents run their own window and would make the reading jump.
 */
export function contextUsedFromAssistant(
  rec: Record<string, unknown>,
): number | undefined {
  const usage = asRecord(asRecord(rec.message)?.usage);
  if (!usage) return undefined;
  const used = contextUsedFromUsage(usage);
  return used > 0 ? used : undefined;
}

/**
 * Context level and window from a turn `result`.
 *
 * `usage` at the top level sums every iteration of the turn, so the last entry
 * of `usage.iterations` is what actually sits in the window. `modelUsage`
 * carries the window itself, which is why we let the CLI tell us rather than
 * keeping a model table in sync.
 */
export function contextFromResult(
  rec: Record<string, unknown>,
): { used?: number; window?: number } | undefined {
  const usage = asRecord(rec.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  const last = asRecord(iterations[iterations.length - 1]);
  const used = contextUsedFromUsage(last ?? usage);

  let window: number | undefined;
  const modelUsage = asRecord(rec.modelUsage);
  for (const entry of Object.values(modelUsage ?? {})) {
    const contextWindow = numberField(asRecord(entry), "contextWindow");
    if (contextWindow > 0) {
      window = Math.max(window ?? 0, contextWindow);
    }
  }

  if (!used && !window) return undefined;
  return { used: used > 0 ? used : undefined, window };
}
