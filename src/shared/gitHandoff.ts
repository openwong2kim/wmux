// Handing an issue or PR from the Git page to an agent: the fixed message the
// agent receives, the title sanitizer, the worktree branch name, and the IPC
// contract between the page and main.
//
// The message is a fixed reference, never the issue's own text: one line
// naming the item (its title sanitized and cut), one line telling the agent
// how to read it with gh, then the operator's note if one was given.
import { neutralName, TYPED_TITLE_MAX } from './typedLineName';
import type { IssueRef } from './issueRef';
import type { PrDragRef } from './prDragRef';
import type { SubmitAssurance } from './ptyMessageDelivery';

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

// Invisible characters that can reorder or hide text: bidi controls,
// zero-width and other format characters, the byte-order mark.
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** An untrusted title as one safe line: control characters, line breaks and
 *  invisible characters removed, the characters a shell expands inside double
 *  quotes defused (`$` dropped, a backtick becomes `'`, a backslash `/`),
 *  quotes kept from closing the quote, whitespace collapsed, cut to
 *  HANDOFF_TITLE_MAX with an ellipsis. Should the pane turn out to be a shell
 *  after all, nothing in it runs. */
export function sanitizeHandoffTitle(title: string): string {
  const flat = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/\$/g, '')
    .replace(/`/g, "'")
    .replace(/\\/g, '/')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > HANDOFF_TITLE_MAX ? `${flat.slice(0, HANDOFF_TITLE_MAX - 1).trimEnd()}…` : flat;
}

/** The operator's note: control characters other than line breaks and
 *  invisible characters removed, capped. */
export function sanitizeHandoffNote(note: string): string {
  return note
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(INVISIBLE_RE, '')
    .trim()
    .slice(0, HANDOFF_NOTE_MAX);
}

/** The fixed message an agent receives for a hand-off. */
export function buildHandoffMessage(h: HandoffRef, note?: string): string {
  const { owner, repo, number, url } = h.ref;
  const slug = `${owner}/${repo}`;
  // The title on a typed line: through the one neutraliser.
  const title = neutralName(sanitizeHandoffTitle(h.ref.title), TYPED_TITLE_MAX);
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
  /** Not delivered: `reason` is the refusal code (user_typing, agent_changed,
   *  no_agent_pane, ...), `note` the delivery's own hint. The task was
   *  cancelled, so nothing is left waiting. Delivered: `assurance` says
   *  whether the Enter is known to have started a turn ('unverified': pasted,
   *  but the agent may not have taken it, e.g. a busy Codex). */
  | { ok: true; linkId: string; taskId?: string; delivered: boolean; assurance?: SubmitAssurance; note?: string; reason?: string }
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

/**
 * What the new worktree's preparation left undone, for the start's toast:
 * the project's setup did not run (`skipped`: its wmux.json is not approved
 * or a part of it was rejected), or selected config files did not arrive.
 * Counts only.
 */
export interface HandoffPrepNotice {
  skipped?: 'untrusted' | 'stale' | 'denied' | 'malformed' | 'needs-review';
  missing: number;
  refused: number;
}

/** The toast a worktree's preparation notice reads as (renderer i18n key + values). */
/** The toast text for a new worktree whose preparation did not run. */
export function prepSkipKey(reason: string | undefined): 'git.prepMalformed' | 'git.prepNeedsReview' | 'git.prepSkipped' {
  if (reason === 'malformed') return 'git.prepMalformed';
  if (reason === 'needs-review') return 'git.prepNeedsReview';
  return 'git.prepSkipped';
}

export function prepNoticeToast(n: HandoffPrepNotice): { key: ReturnType<typeof prepSkipKey> | 'git.prepGapsShort'; values?: Record<string, number> } | null {
  if (n.skipped) return { key: prepSkipKey(n.skipped) };
  if (n.missing + n.refused > 0) return { key: 'git.prepGapsShort', values: { missing: n.missing, refused: n.refused } };
  return null;
}

export type HandoffStartResult =
  | { ok: true; linkId: string; workspaceId: string; branch: string; prep?: HandoffPrepNotice }
  | { ok: false; code: 'in-progress'; inProgress: HandoffInProgress }
  | { ok: false; code: 'invalid' | 'error'; message: string };
