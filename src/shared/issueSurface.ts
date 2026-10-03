// Wire types for the Git page's Issues view, shared by main (GhIssueService)
// and the renderer (IssueSection). GitHub only for now: gh fills them.

export interface IssueLabel {
  readonly name: string;
}

/** One open issue, everything a list row draws. */
export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly author: string;
  readonly labels: IssueLabel[];
  readonly assignees: string[];
  /** ISO 8601. The detail cache skips a re-fetch while it is unchanged. */
  readonly updatedAt: string;
  readonly url: string;
  /** Comment count (gh reads at most the first 100). */
  readonly comments: number;
}

export interface IssueComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  /** The body was cut at ISSUE_BODY_CAP; the UI points to the browser. */
  readonly truncated: boolean;
}

export interface IssueDetail {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  /** COMPLETED / NOT_PLANNED / '' as gh reports it. */
  readonly stateReason: string;
  readonly author: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly labels: IssueLabel[];
  readonly assignees: string[];
  readonly createdAt: string;
  readonly closedAt: string;
  readonly url: string;
  /** Oldest first. With createdAt/closedAt this is the timeline-lite. */
  readonly comments: IssueComment[];
}

/** Which open issues the list shows. `label` carries the label name. */
export type IssueFilter =
  | { kind: 'all' }
  | { kind: 'assigned' }
  | { kind: 'created' }
  | { kind: 'label'; label: string };

/** The remote the list was read from, as the issue URLs spell it. */
export interface IssueRepo {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export type IssueGateCode = 'no-remote' | 'unsupported-host' | 'cli-missing' | 'unauthenticated' | 'error';

export type IssueListResult =
  | { ok: true; issues: IssueSummary[]; repo: IssueRepo | null }
  | { ok: false; code: 'rate-limited'; message: string; retryAt: number }
  | { ok: false; code: IssueGateCode; message: string; provider?: 'github' | 'gitlab' };

export type IssueDetailResult =
  | { ok: true; detail: IssueDetail }
  | { ok: false; code: 'rate-limited'; message: string; retryAt: number }
  | { ok: false; code: 'error'; message: string };

/** Longest label name the filter accepts. */
export const ISSUE_LABEL_MAX = 100;

/** A filter from untrusted input (IPC), or null when it is not one. */
export function parseIssueFilter(raw: unknown): IssueFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'all' || kind === 'assigned' || kind === 'created') return { kind };
  if (kind !== 'label') return null;
  const label = (raw as { label?: unknown }).label;
  if (typeof label !== 'string') return null;
  const name = label.trim();
  if (!name || name.length > ISSUE_LABEL_MAX || /[\r\n\0]/.test(name)) return null;
  return { kind: 'label', label: name };
}
