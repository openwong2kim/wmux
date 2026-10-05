// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/integrations/harness/core/apply.ts), MIT License, Copyright (c) 2026 Nick
//
// The chat-v2 fold. The daemon is authoritative: it folds every stamped event
// into the session it persists and snapshots. Renderers fold the deltas they
// receive with this same code. Changes from the source make the fold a pure
// function of (session, stamped events): block ids are `<seq>.<n>` and turn
// times come from the event's `at`, never from random ids or the wall clock.
// User turns and turn ends are events (`user.message`, `turn.ended`) instead
// of direct calls, and the source's orchestration, plan-promotion and steer
// paths are removed. Deltas always append (a resent snapshot is the driver's
// to drop, by seq or `snapshotRemainder`), an empty delta is a no-op,
// approvals attach to a tool block by `callId` only, and per-block byte caps
// (limits.ts) are part of the fold.
import type {
  AgentRunMeta,
  AgentStep,
  Block,
  Session,
  TaskListItem,
  ToolPreview,
} from "./session";
import { mergeContextUsage } from "./contextUsage";
import { displayPath } from "./paths";
import {
  composeToolTitle,
  isFileTool,
  isWeakToolTitle,
  mergeToolPreview,
  stubFilePreview,
} from "./preview";
import {
  CHATV2_AGENT_STEP_DETAIL_BYTES,
  CHATV2_AGENT_STEP_TEXT_BYTES,
  CHATV2_AGENT_STEPS_MAX,
  CHATV2_BLOCK_TEXT_BYTES,
  CHATV2_PREVIEW_OUTPUT_BYTES,
  CHATV2_TASK_ITEM_BYTES,
  CHATV2_TASK_ITEMS_MAX,
  CHATV2_TOOL_DETAIL_BYTES,
  truncateUtf8,
} from "./limits";
import { taskListText } from "./taskList";
import type { HarnessEvent, StampedHarnessEvent } from "./harnessEvents";

/**
 * Where new blocks get their ids and turn times: the stamp of the event being
 * folded. `n` counts blocks created while folding that one event. `uncapped`
 * skips the byte caps: the daemon keeps one such shadow fold to serve
 * `bodies`; every snapshot and every renderer uses the capped fold.
 */
type Fold = { seq: number; at: number; n: number; uncapped: boolean };

export interface FoldOptions {
  /** Daemon shadow fold for `bodies` only. Never shown, never sent. */
  uncapped?: boolean;
}

/** `text` within `maxBytes`, and whether it was cut. */
function capBytes(fold: Fold, text: string, maxBytes: number): { text: string; cut: boolean } {
  if (fold.uncapped) return { text, cut: false };
  const capped = truncateUtf8(text, maxBytes);
  return { text: capped, cut: capped.length !== text.length };
}

function newId(fold: Fold): string {
  fold.n += 1;
  return `${fold.seq}.${fold.n}`;
}

/**
 * Apply one delivery batch without copying the transcript for every token.
 * Folding a list in one call, in any split into consecutive calls, or one
 * event at a time gives the same session.
 */
export function applyHarnessEvents(
  session: Session,
  events: readonly StampedHarnessEvent[],
  options: FoldOptions = {},
): Session {
  const uncapped = options.uncapped === true;
  let next = session;
  for (let index = 0; index < events.length; index++) {
    const stamped = events[index];
    const event = stamped.event;
    if (event.type !== "message.delta" && event.type !== "reasoning.delta") {
      next = applyHarnessEvent(next, stamped, options);
      continue;
    }
    // A run of same-type deltas folds as one patch. The block it may create
    // takes the stamp of the run's first non-empty delta, exactly as folding
    // the run one event at a time would (an empty delta is a no-op).
    let first: StampedHarnessEvent | undefined = event.text ? stamped : undefined;
    const texts = [event.text];
    while (index + 1 < events.length) {
      const following = events[index + 1];
      if (following.event.type !== event.type) break;
      const text = (following.event as { text: string }).text;
      texts.push(text);
      if (!first && text) first = following;
      index++;
    }
    if (!first) continue;
    next = patchStreaming(
      next,
      event.type === "message.delta" ? "assistant" : "reasoning",
      texts,
      true,
      { seq: first.seq, at: first.at, n: 0, uncapped },
    );
  }
  return next;
}

export function applyHarnessEvent(
  session: Session,
  stamped: StampedHarnessEvent,
  options: FoldOptions = {},
): Session {
  const fold: Fold = { seq: stamped.seq, at: stamped.at, n: 0, uncapped: options.uncapped === true };
  const event: HarnessEvent = stamped.event;
  switch (event.type) {
    case "user.message":
      return appendUser(session, event, fold);
    case "turn.ended":
      return endTurn(session, event.outcome, fold);
    case "session.ended":
      return session.busy ? endTurn(session, "failed", fold) : session;
    case "message.delta":
      return patchStreaming(session, "assistant", event.text, true, fold);
    case "message.completed":
      return finishRole(session, "assistant");
    case "image.generated":
      return appendImage(session, event, fold);
    case "reasoning.delta":
      return patchStreaming(session, "reasoning", event.text, true, fold);
    case "reasoning.completed":
      return finishRole(session, "reasoning");
    case "tool.started":
      return upsertTool(session, {
        callId: event.callId,
        title: event.title,
        kind: event.kind,
        status: event.status,
        preview: event.preview,
        streaming: true,
        agentModel: event.agentModel,
        ...(event.background ? { background: true } : {}),
      }, fold);
    case "tool.updated":
      return upsertTool(session, {
        callId: event.callId,
        title: event.title,
        kind: event.kind,
        status: event.status,
        detail: event.detail,
        preview: event.preview,
        streaming: event.status !== "completed" && event.status !== "failed",
        agentModel: event.agentModel,
      }, fold);
    case "agent.step":
      return recordAgentStep(session, event, fold);
    case "approval.requested":
      return attachApproval(session, event, fold);
    case "approval.resolved": {
      // A request settles once: a late answer cannot overwrite `cancelled`.
      const blocks = session.blocks.map((block) =>
        block.approval?.requestId === event.requestId && !block.approval.decided
          ? {
              ...block,
              approval: { ...block.approval, decided: event.decision },
            }
          : block,
      );
      return { ...session, blocks };
    }
    case "question.asked":
      return {
        ...session,
        pendingQuestion: {
          requestId: event.requestId,
          requestedAt: fold.at,
          questions: event.questions,
          ...(event.title ? { title: event.title } : {}),
          ...(event.autoResolveAt != null
            ? { autoResolveAt: event.autoResolveAt }
            : {}),
        },
      };
    case "question.updated":
      return session.pendingQuestion?.requestId === event.requestId
        ? {
            ...session,
            pendingQuestion: {
              ...session.pendingQuestion,
              autoResolveAt: event.autoResolveAt,
            },
          }
        : session;
    case "question.resolved":
      return session.pendingQuestion?.requestId === event.requestId
        ? { ...session, pendingQuestion: undefined }
        : session;
    case "context":
      return {
        ...session,
        context: mergeContextUsage(session.context, {
          used: event.used,
          window: event.window,
        }),
      };
    case "turn.metrics":
      return mergeTurnMetrics(session, event);
    case "tasks.updated":
      return upsertTaskList(session, event, fold);
    case "background.updated":
      if (event.tasks.length === 0) {
        if (!session.backgroundTasks) return session;
        const { backgroundTasks: _cleared, ...rest } = session;
        return rest;
      }
      return { ...session, backgroundTasks: event.tasks };
    case "plan":
      return upsertPlan(session, event, fold);
    case "session.error":
      return appendBlock(failStreaming(session, fold.at), {
        id: newId(fold),
        role: "system",
        text: event.message,
        notice: "error",
      });
    case "session.providerBound":
      return { ...session, providerSessionId: event.providerSessionId };
    case "turn.started": {
      const index = lastMatchingBlock(
        session.blocks,
        (block) => block.role === "user",
      );
      if (index < 0) return session;
      const block = session.blocks[index];
      if (block.providerTurnId === event.providerTurnId) return session;
      const blocks = session.blocks.slice();
      blocks[index] = { ...block, providerTurnId: event.providerTurnId };
      return { ...session, blocks };
    }
    case "session.configChanged":
      return {
        ...session,
        ...(event.model ? { model: event.model } : {}),
        ...(event.modelSettings
          ? {
              modelSettings: {
                ...session.modelSettings,
                ...event.modelSettings,
              },
            }
          : {}),
      };
    case "status":
      return appendStatus(session, event.text, fold);
    case "usage.limited":
      return {
        ...session,
        usageLimit: event.resetsAt != null ? { resetsAt: event.resetsAt } : {},
      };
    case "interjection":
      // A visible boundary the user must not miss, so unlike status it never
      // deduplicates and never reads as turn lifecycle.
      return appendBlock(session, {
        id: newId(fold),
        role: "system",
        text: event.text,
        interjection: {
          customType: event.customType,
          ...(event.severity ? { severity: event.severity } : {}),
        },
      });
    case "session.started":
      return session;
    default:
      return session;
  }
}

function mergeTurnMetrics(
  session: Session,
  event: Extract<HarnessEvent, { type: "turn.metrics" }>,
): Session {
  let userIndex = -1;
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    if (session.blocks[index].role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return session;

  const current = session.blocks[userIndex];
  const metrics = {
    ...(current.turnMetrics ?? {}),
    ...(event.inputTokens != null ? { inputTokens: event.inputTokens } : {}),
    ...(event.outputTokens != null ? { outputTokens: event.outputTokens } : {}),
    ...(event.cacheReadTokens != null
      ? { cacheReadTokens: event.cacheReadTokens }
      : {}),
    ...(event.cacheWriteTokens != null
      ? { cacheWriteTokens: event.cacheWriteTokens }
      : {}),
    ...(event.cacheHitPercent != null
      ? { cacheHitPercent: event.cacheHitPercent }
      : {}),
  };
  const blocks = session.blocks.slice();
  blocks[userIndex] = { ...current, turnMetrics: metrics };
  return { ...session, blocks };
}

function upsertPlan(
  session: Session,
  event: Extract<HarnessEvent, { type: "plan" }>,
  fold: Fold,
): Session {
  const key = event.key?.trim() || undefined;
  const lastUser = lastMatchingBlock(
    session.blocks,
    (block) => block.role === "user",
  );
  const existing = lastMatchingBlock(session.blocks, (block, index) => {
    if (block.role !== "plan") return false;
    if (key) {
      return block.plan?.key === key || (!block.plan?.key && index > lastUser);
    }
    return index > lastUser;
  });
  const streaming = event.streaming ?? false;

  if (existing >= 0) {
    const current = session.blocks[existing];
    const capped = capBytes(
      fold,
      event.append ? current.text + event.text : event.text || current.text,
      CHATV2_BLOCK_TEXT_BYTES,
    );
    const text = capped.text;
    const blocks = session.blocks.slice();
    blocks[existing] = {
      ...current,
      text,
      streaming,
      ...overflowField(current, capped.cut ? { text: true } : {}),
      plan: {
        ...(current.plan ?? { status: streaming ? "streaming" : "ready" }),
        ...(key ? { key } : {}),
        status: streaming ? "streaming" : "ready",
        ...(!streaming && text ? { originalText: text, edited: false } : {}),
      },
    };
    return { ...session, blocks };
  }

  if (!event.text) return session;
  const capped = capBytes(fold, event.text, CHATV2_BLOCK_TEXT_BYTES);
  return appendBlock(session, {
    id: newId(fold),
    role: "plan",
    text: capped.text,
    streaming,
    ...(capped.cut ? { overflow: { text: true } } : {}),
    plan: {
      ...(key ? { key } : {}),
      status: streaming ? "streaming" : "ready",
      ...(!streaming ? { originalText: capped.text } : {}),
    },
  });
}

function upsertTaskList(
  session: Session,
  event: Extract<HarnessEvent, { type: "tasks.updated" }>,
  fold: Fold,
): Session {
  const key = event.key?.trim() || undefined;
  const lastUser = lastMatchingBlock(
    session.blocks,
    (block) => block.role === "user",
  );
  const existing = lastMatchingBlock(session.blocks, (block, index) => {
    if (block.role !== "tasks") return false;
    if (key) {
      if (block.taskList?.key !== key) return false;
      // A list from another provider conversation stays as history.
      return (
        !event.providerSessionId ||
        block.taskList?.providerSessionId === event.providerSessionId
      );
    }
    return index > lastUser;
  });
  const previousItems =
    existing >= 0 ? session.blocks[existing].taskList?.items : undefined;
  const merged = previousItems
    ? event.merge
      ? mergeTaskListItems(previousItems, event.items)
      : event.authoritative
        ? event.items
        : preserveTaskListLabels(previousItems, event.items)
    : event.items;
  const items = fold.uncapped
    ? merged
    : merged.slice(0, CHATV2_TASK_ITEMS_MAX).map((item) => {
        const text = truncateUtf8(item.text, CHATV2_TASK_ITEM_BYTES);
        return text === item.text ? item : { ...item, text };
      });

  if (items.length === 0) {
    if (existing < 0) return session;
    return {
      ...session,
      blocks: session.blocks.filter((_, index) => index !== existing),
    };
  }

  const taskList = {
    ...(key ? { key } : {}),
    ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
    ...(event.explanation?.trim()
      ? { explanation: event.explanation.trim() }
      : {}),
    items,
  };
  const text = taskListText(items);
  if (existing >= 0) {
    const blocks = session.blocks.slice();
    blocks[existing] = {
      ...blocks[existing],
      text,
      taskList,
    };
    return { ...session, blocks };
  }

  return appendBlock(session, {
    id: newId(fold),
    role: "tasks",
    text,
    taskList,
  });
}

function mergeTaskListItems(
  existing: TaskListItem[],
  updates: TaskListItem[],
): TaskListItem[] {
  if (updates.length === 0) return existing;
  const items = existing.slice();
  const indexById = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index].id;
    if (id) indexById.set(id, index);
  }

  for (const update of updates) {
    const index = update.id
      ? (indexById.get(update.id) ??
        items.findIndex((item) => item.text === update.text))
      : items.findIndex((item) => item.text === update.text);
    if (index < 0) {
      items.push(update);
      if (update.id) indexById.set(update.id, items.length - 1);
      continue;
    }
    const current = items[index];
    items[index] = {
      ...(current.id || update.id ? { id: current.id ?? update.id } : {}),
      // A merge update changes state. Full snapshots remain responsible for
      // intentional task renames or reordered lists.
      text: current.text,
      status: update.status,
    };
  }
  return items;
}

function preserveTaskListLabels(
  existing: TaskListItem[],
  snapshot: TaskListItem[],
): TaskListItem[] {
  const existingById = new Map(
    existing.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
  );
  return snapshot.map((item) => {
    const previous = item.id ? existingById.get(item.id) : undefined;
    return previous && previous.text !== item.text
      ? { ...item, text: previous.text }
      : item;
  });
}

function lastMatchingBlock(
  blocks: Block[],
  predicate: (block: Block, index: number) => boolean,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index], index)) return index;
  }
  return -1;
}

function appendUser(
  session: Session,
  event: Extract<HarnessEvent, { type: "user.message" }>,
  fold: Fold,
): Session {
  const settled = settlePendingApprovals(session);
  const { usageLimit: _cleared, ...rest } = settled;
  const capped = capBytes(fold, event.text, CHATV2_BLOCK_TEXT_BYTES);
  return appendBlock(
    { ...rest, busy: true },
    {
      id: newId(fold),
      role: "user",
      text: capped.text,
      ...(capped.cut ? { overflow: { text: true } } : {}),
      startedAt: fold.at,
      turnModel: { harness: session.harness, id: session.model },
      clientMessageId: event.clientMessageId,
      ...(event.attachments && event.attachments.length > 0
        ? { attachments: event.attachments }
        : {}),
    },
  );
}

/** Close the open turn: settle streams, record how it ended, and when it ended. */
function endTurn(
  session: Session,
  outcome: NonNullable<Block["outcome"]>,
  fold: Fold,
): Session {
  const stopped =
    outcome === "failed"
      ? failStreaming(session, fold.at)
      : stopStreaming(session, fold.at);
  const index = lastMatchingBlock(
    stopped.blocks,
    (block) => block.role === "user",
  );
  if (index < 0 || stopped.blocks[index].outcome) return stopped;
  const blocks = stopped.blocks.slice();
  blocks[index] = { ...blocks[index], outcome };
  return { ...stopped, blocks };
}

export function stopStreaming(session: Session, endedAt: number): Session {
  const { backgroundTasks: _cleared, ...settled } =
    settlePendingApprovals(session);
  return {
    ...settled,
    busy: false,
    pendingQuestion: undefined,
    blocks: stampTurnDuration(settled.blocks.map(stopBlockProgress), endedAt),
  };
}

/**
 * Approval request ids are live only for the turn that produced them. Once
 * that turn has stopped (or a later turn is about to start), leaving one
 * undecided makes its old Allow/Deny controls and notification actionable
 * even though the harness can no longer receive the response.
 */
function settlePendingApprovals(session: Session): Session {
  let changed = false;
  const blocks = session.blocks.flatMap((block) => {
    if (!block.approval || block.approval.decided) return [block];
    changed = true;
    if (block.role === "approval") return [];
    const status = block.tool?.status?.toLowerCase() ?? "";
    const toolFinished =
      status === "completed" ||
      status === "success" ||
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled";
    return [
      {
        ...block,
        streaming: false,
        ...(block.tool && !toolFinished
          ? { tool: { ...block.tool, status: "cancelled" } }
          : {}),
        approval: { ...block.approval, decided: "cancelled" as const },
      },
    ];
  });
  return changed ? { ...session, blocks } : session;
}

/**
 * A terminal provider failure also settles work whose final tool event was
 * lost with the transport. Leaving those calls `in_progress` hides the real
 * failure behind a neutral completed-turn summary.
 */
function failStreaming(session: Session, endedAt: number): Session {
  const openTools = new Set(
    session.blocks.flatMap((block) => {
      if (block.role !== "tool" && block.role !== "approval") return [];
      const status = block.tool?.status?.toLowerCase() ?? "";
      return block.streaming ||
        status === "in_progress" ||
        status === "pending" ||
        status === "running"
        ? [block.id]
        : [];
    }),
  );
  const stopped = stopStreaming(session, endedAt);
  return {
    ...stopped,
    blocks: stopped.blocks.map((block) => {
      const open = openTools.has(block.id);
      const pendingApproval = !!block.approval && !block.approval.decided;
      if (!open && !pendingApproval) return block;
      return {
        ...block,
        streaming: false,
        ...(block.tool && open
          ? { tool: { ...block.tool, status: "failed" } }
          : {}),
        ...(block.approval && !block.approval.decided
          ? { approval: { ...block.approval, decided: "cancelled" as const } }
          : {}),
      };
    }),
  };
}

function stopBlockProgress(block: Block): Block {
  let stopped = block.streaming ? { ...block, streaming: false } : block;
  if (stopped.role === "plan" && stopped.plan?.status === "streaming") {
    stopped = {
      ...stopped,
      plan: {
        ...stopped.plan,
        status: "ready",
        originalText: stopped.text,
        edited: false,
      },
    };
  }
  const current = stopped.taskList;
  if (!current?.items.some((item) => item.status === "in_progress")) {
    return stopped;
  }
  const items = current.items.map((item) =>
    item.status === "in_progress"
      ? { ...item, status: "pending" as const }
      : item,
  );
  return {
    ...stopped,
    text: taskListText(items),
    taskList: { ...current, items },
  };
}

function stampTurnDuration(blocks: Block[], endedAt: number): Block[] {
  let lastUser = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return blocks;
  const user = blocks[lastUser];
  if (user.durationMs != null || user.startedAt == null) return blocks;
  const next = blocks.slice();
  next[lastUser] = {
    ...user,
    durationMs: Math.max(0, endedAt - user.startedAt),
  };
  return next;
}

/** Status pings repeat; keep one row per run instead of stacking identical lines. */
function appendStatus(session: Session, text: string, fold: Fold): Session {
  const trimmed = text.trim();
  if (!trimmed) return session;
  const last = [...session.blocks]
    .reverse()
    .find((block) => block.role !== "reasoning");
  if (last?.role === "system" && last.text === trimmed) return session;
  return appendBlock(session, {
    id: newId(fold),
    role: "system",
    text: trimmed,
  });
}

function appendImage(
  session: Session,
  event: Extract<HarnessEvent, { type: "image.generated" }>,
  fold: Fold,
): Session {
  return appendBlock(session, {
    id: newId(fold),
    role: "image",
    text: "",
    image: {
      path: event.path,
      name: event.name,
      mimeType: event.mimeType,
      size: event.size,
      ...(event.alt ? { alt: event.alt } : {}),
    },
  });
}

function appendBlock(session: Session, block: Block): Session {
  return {
    ...session,
    blocks: [
      ...(block.role === "system" && !block.interjection
        ? session.blocks
        : sealLastStream(session.blocks)),
      block,
    ],
  };
}

/** Only ordinary status rows leave an open prose stream intact. */
function patchStreaming(
  session: Session,
  role: "assistant" | "reasoning",
  input: string | readonly string[],
  streaming: boolean,
  fold: Fold,
): Session {
  const chunks = typeof input === "string" ? [input] : input;
  if (chunks.every((text) => !text)) return session;
  let index = session.blocks.length - 1;
  while (
    index >= 0 &&
    session.blocks[index].role === "system" &&
    !session.blocks[index].interjection
  )
    index--;
  const last = session.blocks[index];
  // A completion closes one provider message. The next delta is a new message
  // even when no tool or status row landed between them; joining the two can
  // turn separate Markdown blocks into text such as `commitConnect`.
  if (last?.role === role && last.streaming) {
    // Deltas append. Once a block hit its cap its inline text cannot grow.
    if (last.overflow?.text && !fold.uncapped) return session;
    const capped = capBytes(fold, last.text + chunks.join(""), CHATV2_BLOCK_TEXT_BYTES);
    if (capped.text === last.text && last.streaming === streaming) return session;
    const blocks = session.blocks.slice();
    blocks[index] = {
      ...last,
      text: capped.text,
      streaming,
      ...overflowField(last, capped.cut ? { text: true } : {}),
    };
    return { ...session, blocks };
  }
  const blocks = sealLastStream(session.blocks);
  const capped = capBytes(fold, chunks.join(""), CHATV2_BLOCK_TEXT_BYTES);
  blocks.push({
    id: newId(fold),
    role,
    text: capped.text,
    streaming,
    ...(capped.cut ? { overflow: { text: true } } : {}),
  });
  return { ...session, blocks };
}

function attachApproval(
  session: Session,
  event: Extract<HarnessEvent, { type: "approval.requested" }>,
  fold: Fold,
): Session {
  const index = findToolForApproval(session, event);
  if (index >= 0) {
    const blocks = session.blocks.slice();
    const prev = blocks[index];
    const preview = mergeToolPreview(event.preview, prev.tool?.preview);
    const label =
      finalToolLabel(
        session,
        event.kind ?? prev.tool?.kind,
        preferLabel(event.title, prev.tool?.title, prev.text),
        preview,
      ) || prev.text;
    blocks[index] = {
      ...prev,
      text: label || prev.text,
      tool: prev.tool
        ? {
            ...prev.tool,
            kind: event.kind ?? prev.tool.kind,
            title: label || prev.tool.title,
            ...(preview ? { preview } : {}),
          }
        : event.callId
          ? {
              callId: event.callId,
              title: label,
              kind: event.kind,
              ...(preview ? { preview } : {}),
            }
          : prev.tool,
      approval: { requestId: event.requestId, requestedAt: fold.at },
    };
    return { ...session, blocks };
  }
  const preview = event.preview;
  const label =
    finalToolLabel(session, event.kind, preferLabel(event.title), preview) ||
    kindTitle(event.kind);
  return appendBlock(session, {
    id: newId(fold),
    role: "tool",
    text: label,
    tool: {
      ...(event.callId ? { callId: event.callId } : {}),
      title: label,
      kind: event.kind,
      ...(preview ? { preview } : {}),
    },
    approval: { requestId: event.requestId, requestedAt: fold.at },
  });
}

function findToolForApproval(
  session: Session,
  event: Extract<HarnessEvent, { type: "approval.requested" }>,
): number {
  // By callId only: guessing by label or by "the one unmatched tool" picks a
  // different block when a renderer holds only the transcript's tail.
  if (!event.callId) return -1;
  return session.blocks.findIndex(
    (block) => block.tool?.callId === event.callId,
  );
}

function upsertTool(
  session: Session,
  patch: {
    callId: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: ToolPreview;
    streaming: boolean;
    agentModel?: string;
    background?: boolean;
  },
  fold: Fold,
): Session {
  const index = findToolIndex(session, patch);
  if (index < 0) {
    const cappedDetail = capToolDetail(fold, patch.detail);
    const detail = cappedDetail.text;
    const cappedPreview = capPreviewOutput(
      fold,
      fillPreview(patch.preview, detail, patch.kind, patch.title),
    );
    const preview = cappedPreview.preview;
    const over = {
      ...(cappedDetail.cut ? { detail: true as const } : {}),
      ...(cappedPreview.cut ? { output: true as const } : {}),
    };
    const label = finalToolLabel(
      session,
      patch.kind,
      displayLabel(patch),
      preview,
    );
    return appendBlock(session, {
      id: newId(fold),
      role: "tool",
      text: label,
      streaming: patch.streaming,
      ...(Object.keys(over).length ? { overflow: over } : {}),
      ...(patch.agentModel
        ? { agentRun: { name: label, model: patch.agentModel, steps: [] } }
        : {}),
      tool: {
        callId: patch.callId,
        title: label,
        kind: patch.kind,
        status: patch.status,
        ...(detail ? { detail } : {}),
        ...(preview ? { preview } : {}),
        ...(patch.background ? { background: true } : {}),
      },
    });
  }
  const prev = session.blocks[index];
  const cappedDetail = capToolDetail(fold, patch.detail);
  const detail = cappedDetail.text ?? prev.tool?.detail;
  const cappedPreview = capPreviewOutput(
    fold,
    fillPreview(
      mergeToolPreview(patch.preview, prev.tool?.preview),
      detail,
      patch.kind ?? prev.tool?.kind,
      patch.title,
    ),
  );
  const preview = cappedPreview.preview;
  const over = {
    ...(cappedDetail.cut ? { detail: true as const } : {}),
    ...(cappedPreview.cut ? { output: true as const } : {}),
  };
  const label = finalToolLabel(
    session,
    patch.kind ?? prev.tool?.kind,
    displayLabel(patch, prev),
    preview,
  );
  const kind = patch.kind ?? prev.tool?.kind;
  const status = patch.status ?? prev.tool?.status;
  const agentName = prev.agentRun?.steps.length ? prev.agentRun.name : label;
  if (
    prev.text === label &&
    prev.streaming === patch.streaming &&
    prev.tool?.title === label &&
    prev.tool?.kind === kind &&
    prev.tool?.status === status &&
    prev.tool?.detail === detail &&
    Object.keys(over).length === 0 &&
    (!patch.agentModel || prev.agentRun?.model === patch.agentModel) &&
    (!prev.agentRun || prev.agentRun.name === agentName) &&
    samePreview(prev.tool?.preview, preview)
  ) {
    return session;
  }
  const blocks = session.blocks.slice();
  blocks[index] = {
    ...prev,
    text: label,
    streaming: patch.streaming,
    ...overflowField(prev, over),
    ...(patch.agentModel || prev.agentRun
      ? {
          agentRun: {
            steps: prev.agentRun?.steps ?? [],
            ...prev.agentRun,
            name: agentName,
            ...(patch.agentModel ? { model: patch.agentModel } : {}),
          },
        }
      : {}),
    tool: {
      callId: patch.callId,
      title: label,
      kind,
      status,
      ...(detail ? { detail } : {}),
      ...(preview ? { preview } : {}),
      ...(prev.tool?.background ? { background: true } : {}),
    },
  };
  return { ...session, blocks };
}

function capToolDetail(fold: Fold, value: string | undefined): { text: string | undefined; cut: boolean } {
  const text = value?.trim();
  if (!text) return { text: undefined, cut: false };
  return capBytes(fold, text, CHATV2_TOOL_DETAIL_BYTES);
}

function capPreviewOutput(
  fold: Fold,
  preview: ToolPreview | undefined,
): { preview: ToolPreview | undefined; cut: boolean } {
  if (!preview?.output) return { preview, cut: false };
  const capped = capBytes(fold, preview.output, CHATV2_PREVIEW_OUTPUT_BYTES);
  return capped.cut
    ? { preview: { ...preview, output: capped.text }, cut: true }
    : { preview, cut: false };
}

/** Merge newly cut fields into a block's `overflow` (a field stays cut once it was). */
function overflowField(
  block: Block,
  cut: NonNullable<Block["overflow"]>,
): Pick<Block, "overflow"> | Record<string, never> {
  if (Object.keys(cut).length === 0) return {};
  return { overflow: { ...(block.overflow ?? {}), ...cut } };
}

function samePreview(a?: ToolPreview, b?: ToolPreview): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.path === b.path &&
    a.query === b.query &&
    a.command === b.command &&
    a.fileName === b.fileName &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.contentOnly === b.contentOnly &&
    a.startLine === b.startLine &&
    a.output === b.output &&
    a.lines === b.lines
  );
}

function fillPreview(
  preview: ToolPreview | undefined,
  _detail: string | undefined,
  kind?: string,
  title?: string,
): ToolPreview | undefined {
  if (
    preview?.contentOnly ||
    preview?.lines?.some((line) => line.kind === "add" || line.kind === "del")
  ) {
    return preview;
  }
  if (preview) return { ...preview, lines: undefined };
  if (isFileTool(kind, title, preview)) {
    return stubFilePreview(kind, title);
  }
  return undefined;
}

/**
 * How much of a subagent's trail the parent keeps (limits.ts). A delegated
 * run can be thousands of calls long; the transcript only ever shows a window
 * of it, and an unbounded array would outgrow a snapshot page.
 */

/**
 * Mirrors one subagent action onto its parent Agent tool block. Steps merge by
 * provider id, so a call that starts pending and later completes stays one row
 * instead of appearing twice.
 */
function recordAgentStep(
  session: Session,
  event: Extract<HarnessEvent, { type: "agent.step" }>,
  fold: Fold,
): Session {
  const index = session.blocks.findIndex(
    (block) => block.tool?.callId === event.callId,
  );
  if (index < 0) return session;
  const prev = session.blocks[index];
  const text = capAgentStepText(fold, event.text);
  // A tool step earns a row on its label alone; prose with nothing in it does
  // not.
  if (!text && event.kind !== "tool") return session;

  const run = prev.agentRun;
  const detail = event.detail?.trim()
    ? capBytes(fold, event.detail.trim(), CHATV2_AGENT_STEP_DETAIL_BYTES).text
    : undefined;
  const step: AgentStep = {
    id: event.stepId,
    kind: event.kind,
    text,
    ...(event.toolKind ? { toolKind: event.toolKind } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(detail ? { detail } : {}),
    ...(event.preview ? { preview: event.preview } : {}),
  };

  const at = run?.steps.findIndex((entry) => entry.id === event.stepId) ?? -1;
  let steps: AgentStep[];
  if (run && at >= 0) {
    const existing = run.steps[at];
    steps = run.steps.slice();
    steps[at] = {
      ...existing,
      ...step,
      // A completion carries the result, not the request: keep the label the
      // call announced itself with rather than letting the result rename it.
      text: text || existing.text,
      preview: mergeToolPreview(event.preview, existing.preview),
    };
  } else {
    steps = [...(run?.steps ?? []), step];
    if (!fold.uncapped && steps.length > CHATV2_AGENT_STEPS_MAX) {
      steps = steps.slice(steps.length - CHATV2_AGENT_STEPS_MAX);
    }
  }

  const next: AgentRunMeta = {
    ...(run?.model ? { model: run.model } : {}),
    name:
      event.agentName ||
      run?.name ||
      prev.tool?.title ||
      prev.text ||
      "Subagent",
    ...((event.agentType ?? run?.agentType)
      ? { agentType: event.agentType ?? run?.agentType }
      : {}),
    steps,
  };
  if (run && sameAgentRun(run, next)) return session;
  const blocks = session.blocks.slice();
  blocks[index] = { ...prev, agentRun: next };
  return { ...session, blocks };
}

function sameAgentRun(a: AgentRunMeta, b: AgentRunMeta): boolean {
  if (a.name !== b.name || a.agentType !== b.agentType || a.model !== b.model)
    return false;
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => sameAgentStep(step, b.steps[index]));
}

function sameAgentStep(a: AgentStep, b: AgentStep): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.toolKind === b.toolKind &&
    a.status === b.status &&
    a.detail === b.detail &&
    samePreview(a.preview, b.preview)
  );
}

function capAgentStepText(fold: Fold, value: string): string {
  return capBytes(fold, value.trim(), CHATV2_AGENT_STEP_TEXT_BYTES).text;
}

function findToolIndex(
  session: Session,
  patch: { callId: string },
): number {
  // By callId only, like approvals (see findToolForApproval).
  if (!patch.callId) return -1;
  return session.blocks.findIndex(
    (block) => block.tool?.callId === patch.callId,
  );
}

function sealLastStream(blocks: Block[]): Block[] {
  let index = blocks.length - 1;
  while (
    index >= 0 &&
    blocks[index].role === "system" &&
    !blocks[index].interjection
  )
    index--;
  const last = blocks[index];
  if (
    !last?.streaming ||
    (last.role !== "assistant" && last.role !== "reasoning")
  ) {
    return blocks.slice();
  }
  const next = blocks.slice();
  next[index] = { ...last, streaming: false };
  return next;
}

function displayLabel(
  patch: { title?: string; kind?: string },
  prev?: Block,
): string {
  return (
    preferLabel(patch.title, prev?.tool?.title, prev?.text) ||
    kindTitle(patch.kind ?? prev?.tool?.kind)
  );
}

function finalToolLabel(
  session: Session,
  kind: string | undefined,
  title: string | undefined,
  preview?: ToolPreview,
): string {
  const path = preview?.path
    ? displayPath(preview.path, session.cwd)
    : preview?.fileName;
  return (
    composeToolTitle({
      kind,
      title,
      path,
      query: preview?.query,
      previewKind: preview?.kind,
      cwd: session.cwd,
    }) ||
    title?.trim() ||
    kindTitle(kind)
  );
}

function preferLabel(...parts: (string | undefined)[]): string {
  const filled = parts
    .filter((part): part is string => !!part?.trim())
    .map((part) => part.trim())
    .filter((part) => !isCallId(part));
  const strong = filled.filter((part) => !isWeakToolTitle(part));
  const compactStrong = strong.filter((part) => compactLabel(part) === part);
  compactStrong.sort((a, b) => b.length - a.length);
  if (compactStrong[0]) return compactStrong[0];
  // A long command is still more useful than an earlier "Shell" placeholder.
  if (strong[0]) return strong[0];
  const compact = filled.filter((part) => compactLabel(part) === part);
  compact.sort((a, b) => b.length - a.length);
  return compact[0] ?? filled[0] ?? "";
}

function compactLabel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.includes("\n") || trimmed.length > 240) return undefined;
  return trimmed;
}

function kindTitle(kind?: string): string {
  const key = kind?.trim().toLowerCase() ?? "";
  switch (key) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Find";
    case "execute":
    case "shell":
    case "bash":
      return "Shell";
    case "skill":
      return "Skill";
    case "agent":
    case "task":
    case "subagent":
      return "Subagent";
    case "think":
      return "Think";
    case "fetch":
      return "Fetch";
    case "other":
    case "":
      return "Working";
    default:
      return key.replace(/^_/, "").replace(/[_-]+/g, " ");
  }
}

function isCallId(value: string): boolean {
  const text = value.trim();
  return (
    /^(call[-_]?|tool[-_])[a-z0-9_-]+$/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
  );
}

function finishRole(session: Session, role: Block["role"]): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.role === role && block.streaming
        ? { ...block, streaming: false }
        : block,
    ),
  };
}

/**
 * The lowest block index whose block differs between two folds of the same
 * session (by identity, so unchanged blocks are skipped cheaply), or
 * `next.blocks.length` when nothing changed. The daemon stamps it on every
 * delta push as `touchedFrom` (see ipc.ts) so a renderer that holds only the
 * tail of the transcript knows when it must re-snapshot.
 */
export function blockChangeFrom(prev: Session, next: Session): number {
  const a = prev.blocks;
  const b = next.blocks;
  if (a === b) return b.length;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? b.length : shared;
}
