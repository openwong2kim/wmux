// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/integrations/harness/core/types.ts), MIT License, Copyright (c) 2026 Nick
//
// The one event model of chat v2. A driver (daemon) emits HarnessEvents; the
// daemon stamps each with a seq and a time and folds it into the session with
// apply.ts; renderers fold the same stamped events with the same apply.ts.
//
// Changes from the source: request ids are strings (Claude's
// `control_request.request_id` is a UUID), generated images are path-only
// (no base64 in a snapshot), and two wmux events carry what the source kept
// outside its event stream: `user.message` (a turn the daemon accepted) and
// `turn.ended` (the turn's outcome).
import type {
  AgentStepKind,
  Attachment,
  InterjectionMeta,
  TaskListItem,
  ToolPreview,
  TurnMetrics,
  TurnOutcome,
} from "./session";
import type { UserQuestion } from "./userQuestion";

export type HarnessEvent =
  | { type: "session.started" }
  /**
   * The agent process is gone. A driver that exits mid-turn emits only this;
   * the fold closes the open turn as `failed`. Do not also emit `turn.ended`.
   */
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.providerBound"; providerSessionId: string }
  | { type: "turn.started"; providerTurnId: string }
  | {
      type: "session.configChanged";
      model?: string;
      modelSettings?: Record<string, string>;
    }
  | { type: "status"; text: string }
  /** The provider refused the turn until its usage window resets (epoch ms). */
  | { type: "usage.limited"; resetsAt?: number }
  /**
   * The agent has yielded but the turn is not over: work it started is still
   * running and will wake it again. Empty once it is back at work.
   */
  | { type: "background.updated"; tasks: string[] }
  | ({ type: "interjection"; text: string } & InterjectionMeta)
  /**
   * wmux: the daemon accepted a user turn and handed it to the driver. Opens
   * the turn (`Session.busy`). `clientMessageId` is the sender's idempotency
   * key, echoed on the user block.
   */
  | {
      type: "user.message";
      text: string;
      attachments?: Attachment[];
      clientMessageId: string;
    }
  /** wmux: the turn is over. Settles open streams, approvals and the question. */
  | { type: "turn.ended"; outcome: TurnOutcome }
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | {
      type: "image.generated";
      itemId: string;
      path: string;
      name: string;
      mimeType: string;
      size: number;
      alt?: string;
    }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed" }
  | {
      type: "tool.started";
      agentModel?: string;
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      /** Work the agent left running when it yielded. */
      background?: boolean;
      preview?: ToolPreview;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
    }
  | {
      type: "tool.updated";
      agentModel?: string;
      callId: string;
      title?: string;
      kind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
    }
  /** Something a subagent did, mirrored onto its parent Agent tool call. */
  | {
      type: "agent.step";
      /** Tool call id of the parent Agent/Task call. */
      callId: string;
      /** Provider step identity; repeats merge onto the same row. */
      stepId: string;
      kind: AgentStepKind;
      text: string;
      /** Tool kind for a "tool" step, so it gets the right icon. */
      toolKind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
      /** The subagent's own name, when the provider only reveals it here. */
      agentName?: string;
      agentType?: string;
    }
  | {
      type: "approval.requested";
      /** The driver's request id; also `NativeDecisionRef.requestId`. */
      requestId: string;
      title: string;
      kind?: string;
      callId?: string;
      preview?: ToolPreview;
    }
  | {
      type: "approval.resolved";
      requestId: string;
      /** "cancelled" = settled without an answer (turn ended, expired, hook decided). */
      decision: "allow" | "deny" | "cancelled";
    }
  | {
      type: "question.asked";
      requestId: string;
      title?: string;
      questions: UserQuestion[];
      callId?: string;
      autoResolveAt?: number;
    }
  | {
      type: "question.updated";
      requestId: string;
      autoResolveAt?: number;
    }
  | {
      type: "question.resolved";
      requestId: string;
      decision: "answered" | "skipped" | "cancelled";
    }
  | {
      type: "tasks.updated";
      key?: string;
      explanation?: string;
      /** Merge changed items into the existing list instead of replacing it. */
      merge?: boolean;
      /** This snapshot owns its labels, so a changed item text is a rename. */
      authoritative?: boolean;
      /** Provider conversation that owns these items. */
      providerSessionId?: string;
      items: TaskListItem[];
    }
  | {
      type: "plan";
      text: string;
      /** Merge identity for deltas and the authoritative completed item. */
      key?: string;
      /** Append a stream delta instead of replacing the current snapshot. */
      append?: boolean;
      /** False marks the plan ready for review. */
      streaming?: boolean;
    }
  /** Context-window level after the harness's latest request. */
  | { type: "context"; used?: number; window?: number }
  /** Provider token accounting for the active user turn. */
  | ({ type: "turn.metrics" } & TurnMetrics);

export type HarnessEventType = HarnessEvent["type"];

/** An approval answer, as the driver writes it back to the agent. */
export type ApprovalDecision = "allow" | "deny";

/**
 * One event as the daemon recorded it. `seq` is per chat session and per
 * epoch, starting at 1 and gapless; `at` is the daemon's epoch-ms clock when
 * the event was recorded. Both are inputs to the fold (block ids and turn
 * times come from them), which is what makes every fold of the same stamped
 * events identical.
 */
export type StampedHarnessEvent = {
  seq: number;
  at: number;
  event: HarnessEvent;
};
