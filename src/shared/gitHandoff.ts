// Handing an issue or PR from the Git page to an agent: the fixed message the
// agent receives, the title sanitizer, the worktree branch name, and the IPC
// contract between the page and main.
//
// The message is a fixed reference, never the issue's own text: one line
// naming the item (its title sanitized and cut), one line telling the agent
// how to read it with gh, then the operator's note if one was given.
import type { IssueRef } from './issueRef';
import type { PrDragRef } from './prDragRef';

/** What is handed over: an issue or a PR (both URL-checked refs). */
export type HandoffRef = { kind: 'issue'; ref: IssueRef } | { kind: 'pr'; ref: PrDragRef };

/** The agent pane it goes to. */
export interface HandoffTarget {
  workspaceId: string;
  paneId: string;
  surfaceId?: string;
  ptyId: string;
  /** Display name (e.g. "Claude Code"). */
  agentName: string;
  /** Agent slug (e.g. "claude"), recorded on the work link. */
  agentSlug?: string;
}

/** Longest title carried in a hand-off message. */
export const HANDOFF_TITLE_MAX = 120;
/** Longest operator note. */
export const HANDOFF_NOTE_MAX = 2000;

/** An untrusted title as one safe line: control characters and line breaks
 *  removed, whitespace collapsed, quotes kept from closing the quote, cut to
 *  HANDOFF_TITLE_MAX with an ellipsis. */
export function sanitizeHandoffTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > HANDOFF_TITLE_MAX ? `${flat.slice(0, HANDOFF_TITLE_MAX - 1).trimEnd()}…` : flat;
}

/** The operator's note: control characters other than line breaks removed, capped. */
export function sanitizeHandoffNote(note: string): string {
  // eslint-disable-next-line no-control-regex
  return note.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim().slice(0, HANDOFF_NOTE_MAX);
}

/** The fixed message an agent receives for a hand-off. */
export function buildHandoffMessage(h: HandoffRef, note?: string): string {
  const { owner, repo, number, url } = h.ref;
  const slug = `${owner}/${repo}`;
  const title = sanitizeHandoffTitle(h.ref.title);
  const lines = h.kind === 'issue'
    ? [`[wmux] Issue ${slug}#${number}: "${title}" — ${url}`, `Read it with: gh issue view ${number} --repo ${slug}`]
    : [`[wmux] PR ${slug}#${number}: "${title}" — ${url}`, `Read it with: gh pr view ${number} --repo ${slug} and gh pr diff ${number} --repo ${slug}`];
  const n = note ? sanitizeHandoffNote(note) : '';
  if (n) lines.push('', n);
  return lines.join('\n');
}

/** A worktree branch for an issue: `issue-<n>-<slug>`, the slug from the
 *  title (ASCII letters and digits, dashed, at most 40 characters). */
export function issueBranchName(number: number, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug ? `issue-${number}-${slug}` : `issue-${number}`;
}

// ── IPC contract ─────────────────────────────────────────────────────────────

export interface HandoffSendRequest {
  item: HandoffRef;
  target: HandoffTarget;
  note?: string;
  /** Send although the item is already linked to work in progress. */
  force?: boolean;
}

/** Work already running on the item (blocks a send unless forced). */
export interface HandoffInProgress {
  linkId: string;
  workspaceId: string;
  state: string;
}

export type HandoffSendResult =
  | { ok: true; linkId: string; taskId?: string; delivered: boolean; note?: string }
  | { ok: false; code: 'in-progress'; inProgress: HandoffInProgress }
  | { ok: false; code: 'invalid' | 'refused' | 'error'; message: string };

export interface HandoffStartRequest {
  item: HandoffRef;
  /** A path inside the repo (the page's current repo). */
  repoPath: string;
  /** The workspace in that repo the fan-out runs from. */
  workspaceId: string;
  /** The agent command (the user's default: the fan-out dialog's last one). */
  agentCmd?: string;
  note?: string;
  force?: boolean;
}

export type HandoffStartResult =
  | { ok: true; linkId: string; workspaceId: string; branch: string }
  | { ok: false; code: 'in-progress'; inProgress: HandoffInProgress }
  | { ok: false; code: 'invalid' | 'error'; message: string };
