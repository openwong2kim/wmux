// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/model/session.ts), MIT License, Copyright (c) 2026 Nick
//
// The folded chat-v2 transcript model. Pruned to what a wmux chat pane shows:
// no inbox/notes/orchestration/handoff cards, no project/provider catalogs,
// and no side threads. `Session` here is one driver conversation bound to one
// pane; the daemon folds it (see apply.ts) and serves it as snapshots.
import type { ContextUsage } from "./contextUsage";
import type { UserQuestionPrompt } from "./userQuestion";

/** Agents a chat-v2 driver can run. v1 creates `claude` only (see ipc.ts). */
export type HarnessId = "claude" | "codex" | "opencode";

export const HARNESS_TITLE: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type BlockRole =
  | "user"
  | "assistant"
  | "image"
  | "reasoning"
  | "tool"
  | "approval"
  | "tasks"
  | "plan"
  | "system";

export type TaskListItemStatus =
  "pending" | "in_progress" | "completed" | "cancelled";

export type TaskListItem = {
  /** Stable provider identity, when available, for merging status-only updates. */
  id?: string;
  text: string;
  status: TaskListItemStatus;
};

export type TaskListMeta = {
  /** Provider identity for replacing later snapshots of the same list. */
  key?: string;
  /** Provider conversation that produced this list, when the provider scopes task ids to one. */
  providerSessionId?: string;
  explanation?: string;
  items: TaskListItem[];
};

export type PlanStatus = "streaming" | "ready";

export type PlanBlockMeta = {
  /** Provider or turn identity used to merge streamed snapshots. */
  key?: string;
  status: PlanStatus;
  /** Provider-authored plan text once it stopped streaming. */
  originalText?: string;
  edited?: boolean;
};

/** A mid-turn interjection the harness asked to surface. */
export type InterjectionSeverity = "nit" | "concern" | "blocker";

export type InterjectionMeta = {
  customType: string;
  /** Highest severity among this interjection's retained notes, when any is known. */
  severity?: InterjectionSeverity;
};

export type ToolPreviewKind = "read" | "write" | "shell" | "search";

export type ToolPreviewLineKind = "add" | "del" | "context";

export type ToolPreviewLine = {
  number?: number;
  kind: ToolPreviewLineKind;
  text: string;
};

export type ToolPreview = {
  kind: ToolPreviewKind;
  title?: string;
  path?: string;
  fileName?: string;
  startLine?: number;
  additions?: number;
  deletions?: number;
  /** Write supplied new contents without the previous file to compare. */
  contentOnly?: boolean;
  query?: string;
  lines?: ToolPreviewLine[];
  output?: string;
};

/** One thing a subagent did, mirrored into the parent transcript. */
export type AgentStepKind = "tool" | "message" | "reasoning";

export type AgentStep = {
  /** Provider step identity, so repeats merge instead of stacking up. */
  id: string;
  kind: AgentStepKind;
  /** Tool label, or the prose the subagent wrote. */
  text: string;
  toolKind?: string;
  status?: string;
  detail?: string;
  preview?: ToolPreview;
};

/**
 * The inside of a delegated run: what the subagent is called, and the trail it
 * left. Held on the parent Agent tool block so the transcript can open it
 * without a second session.
 */
export type AgentRunMeta = {
  /** What the subagent is called, e.g. "Correctness review". */
  name: string;
  /** Provider agent type, e.g. "code-reviewer". */
  agentType?: string;
  /** Model reported for the child, which may differ from its parent. */
  model?: string;
  steps: AgentStep[];
};

export type AttachmentKind = "image";

/**
 * What the transcript keeps of an attached file. The bytes are never part of
 * a snapshot: `path` is the staged absolute path the daemon read when it sent
 * the turn (see `validChatAttachments`).
 */
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  path: string;
};

export type GeneratedImageMeta = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  alt?: string;
};

/** The provider stopped the last turn at a usage limit. */
export type UsageLimit = {
  /** Epoch ms when the provider's window resets, once known. */
  resetsAt?: number;
};

/** Provider/model provenance captured when a user turn is submitted. */
export type TurnModel = {
  harness: HarnessId;
  id: string;
};

/** Provider-reported token accounting for one user turn. */
export type TurnMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-normalized share of input served from cache, as a percentage. */
  cacheHitPercent?: number;
};

/** How a turn ended; set on the user block that opened it. */
export type TurnOutcome = "completed" | "interrupted" | "failed" | "usage-limited";

export type Block = {
  /**
   * Deterministic: `<seq>.<n>`, the n-th block created while folding the
   * event with that seq (see apply.ts). The daemon and every renderer that
   * folds the same events produce the same ids.
   */
  id: string;
  role: BlockRole;
  text: string;
  image?: GeneratedImageMeta;
  attachments?: Attachment[];
  streaming?: boolean;
  /** Epoch ms when this user turn started. */
  startedAt?: number;
  /** How long the agent worked on this user turn, in ms. */
  durationMs?: number;
  /** How this user turn ended. */
  outcome?: TurnOutcome;
  /** Stable model label for this turn. Present on user blocks. */
  turnModel?: TurnModel;
  /** Provider turn boundary for this user message, when known. */
  providerTurnId?: string;
  /** The `clientMessageId` the sender chose, echoed so a sender can match its send. */
  clientMessageId?: string;
  /** Provider-reported token metrics for this user turn, when available. */
  turnMetrics?: TurnMetrics;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: ToolPreview;
    /** Left running by the agent when it yielded; the turn waits on it. */
    background?: boolean;
  };
  approval?: {
    /** The driver's request id (Claude `control_request.request_id`). */
    requestId: string;
    decided?: "allow" | "deny" | "cancelled";
  };
  /** Inner activity of a delegated run. Present on Agent/Task tool blocks. */
  agentRun?: AgentRunMeta;
  taskList?: TaskListMeta;
  plan?: PlanBlockMeta;
  /** Mid-turn interjection chrome; system blocks only. Body lives in text. */
  interjection?: InterjectionMeta;
  /**
   * A system row the reader must not miss — an error or an interruption —
   * rather than turn chrome like a status ping. Never folds into the trail.
   */
  notice?: "error" | "interrupt";
};

/** wmux run modes a driver may start with (see ipc.ts `ChatV2RunMode`). */
export type RuntimeMode = "default" | "bypass";

export type Session = {
  /** The daemon's chat-v2 record id (`ChatV2Binding.chatSessionId`). */
  id: string;
  harness: HarnessId;
  /** Model id the driver was started with; '' = the agent's default. */
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  /** Working directory the driver runs in (the anchor pane's cwd at create). */
  cwd: string;
  blocks: Block[];
  /** True while a turn is in flight. */
  busy?: boolean;
  /** What the live turn waits on after the agent yielded with background work. */
  backgroundTasks?: string[];
  /** Last turn hit a provider usage limit; cleared by the next send. */
  usageLimit?: UsageLimit;
  /** The agent's own conversation id (Claude `session_id`), once bound. */
  providerSessionId?: string;
  /** Context-window level reported by the harness. Absent until it reports. */
  context?: ContextUsage;
  /** Live clarifying question (AskUserQuestion). */
  pendingQuestion?: UserQuestionPrompt;
};

export function newChatSession(input: {
  id: string;
  harness: HarnessId;
  cwd: string;
  model?: string;
  modelSettings?: Record<string, string>;
  runtimeMode?: RuntimeMode;
}): Session {
  return {
    id: input.id,
    harness: input.harness,
    model: input.model ?? "",
    modelSettings: { ...(input.modelSettings ?? {}) },
    runtimeMode: input.runtimeMode ?? "default",
    cwd: input.cwd,
    blocks: [],
  };
}

export function hasPendingApproval(blocks: Block[]): boolean {
  return blocks.some((block) => block.approval && !block.approval.decided);
}

export function sessionNeedsInput(session: Session): boolean {
  return hasPendingApproval(session.blocks) || session.pendingQuestion != null;
}
