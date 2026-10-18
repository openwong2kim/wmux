// The desktop Plan card: Claude's ExitPlanMode dialog as the Fleet approvals
// tab shows it, and the answer it sends. Main builds the view from the
// daemon's `terminal_prompt` record (main/ipc/handlers/planApproval.handler.ts)
// and answers through `daemon.approvals.answerPlan`, the desktop twin of the
// phone's `POST /api/approvals/:id/answer`.

/** One of the plan form's actions, exactly as the daemon read it off the dialog. */
export interface PlanApprovalAction {
  id: string;
  label: string;
  /** The action takes the user's words (the feedback row). */
  needsText: boolean;
}

export interface PlanApprovalView {
  id: string;
  /** The pane (pty) the dialog is on. */
  sessionId: string;
  workspaceId?: string;
  agent: string;
  /** The plan's first line, its title. */
  summary?: string;
  /** The dialog's own question line. */
  question?: string;
  /** The whole plan (markdown, agent-authored: render as text only). Absent when the daemon could not tie the dialog to its call. */
  plan?: string;
  /** `plan` was cut at the daemon's detail limit. */
  planTruncated?: boolean;
  /** Empty: this dialog cannot be answered from here (answer it in the terminal). */
  actions: PlanApprovalAction[];
  /** Echoed with an answer, so a changed dialog is refused. Present exactly when `actions` is not empty. */
  formFingerprint?: string;
  /** An answer is already on its way to the pane. */
  answered: boolean;
  /** A feedback answer stopped partway (some keys typed, not submitted): finish it in the pane. */
  stopped: boolean;
  createdAt: number;
}

export interface PlanApprovalAnswerRequest {
  id: string;
  formFingerprint: string;
  action: string;
  /** Feedback text (the `needsText` action only); omitted or empty = no feedback. */
  text?: string;
}

export type PlanApprovalAnswerResult =
  | { ok: true }
  | { ok: false; reason: string; textRefusal?: string };
