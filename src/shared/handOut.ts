// To hand out: work nobody has been given yet. One list per PC, kept by main
// in `hand-out.json`; the owner and agent panes add to it, and a pick hands an
// item to an agent through the existing send paths (docs/work-links.md).
//
// An item's state is never stored. A pick makes a work link (origin
// 'hand-out', `handOutId` = the item), and the item is out while such a link
// is live and open otherwise, so a send that was not delivered (its task
// cancelled, the link abandoned) or a task that failed puts it back. Once that work is done the item
// leaves the list; its ticket carries it from there.
//
// An agent picks with `a2a.task.send` and a `handOutId` param: the send runs
// on the agent's own lane (a company brief keeps its holds and cap), and main
// makes the link from it. The app picks with HandOutPickRequest over IPC.
import type { HandoffPrepNotice, HandoffTarget } from './gitHandoff';
import { issueBranchName, sanitizeHandoffNote, sanitizeHandoffTitle } from './gitHandoff';
import type { SubmitAssurance } from './ptyMessageDelivery';

export const HAND_OUT_LIMITS = {
  /** Items kept; an add past it is refused. */
  MAX_ITEMS: 200,
  MAX_TITLE: 200,
  MAX_NOTE: 2000,
  MAX_FOLDER: 1024,
  MAX_NAME: 100,
  /** Items one list call returns at most. */
  MAX_LISTED: 50,
} as const;

/** Who put the item on the list. A pane's name is its label as it was then. */
export type HandOutAddedBy =
  | { kind: 'owner' }
  | { kind: 'pane'; workspaceId: string; paneId: string; name?: string };

export interface HandOutItem {
  /** `ho-` and a UUID. */
  id: string;
  /** Untrusted text, one line, capped. Show as text only. */
  title: string;
  /** The folder the work is for, absolute. */
  folder: string;
  /** The agent slug the work asks for, e.g. 'claude'; any agent when absent. */
  agent?: string;
  /** Untrusted text, capped. Show as text only. */
  note?: string;
  addedBy: HandOutAddedBy;
  createdAt: number;
}

/** open: nobody has it. out: a pick's work link is live. done: that work is done. */
export type HandOutState = 'open' | 'out' | 'done';

/** An item with its derived state, as main serves it. */
export interface HandOutEntry extends HandOutItem {
  state: HandOutState;
  /** The live link of an item that is out or done. */
  linkId?: string;
}

/** What an add carries: the fields a person or an agent chooses. */
export interface HandOutAddRequest {
  title: string;
  folder: string;
  agent?: string;
  note?: string;
}

export type HandOutAddResult =
  | { ok: true; item: HandOutItem }
  | { ok: false; code: 'invalid' | 'full'; message: string };

/**
 * Where a pick from the app sends an item:
 *  - pane: that agent pane, over the gated delivery the Git page's hand-off uses;
 *  - worktree: a new worktree of the item's folder through the fan-out path,
 *    run from `workspaceId` (a workspace in that folder);
 *  - company: the company's CEO pane. The owner's task to the CEO is the
 *    item's job (its link); the CEO briefs a seat as a follow-on and finishes
 *    that task once the seat's work is checked.
 */
export type HandOutPickTarget =
  | { kind: 'pane'; target: HandoffTarget }
  | { kind: 'worktree'; workspaceId: string; agentCmd?: string }
  | { kind: 'company'; target: HandoffTarget };

export interface HandOutPickRequest {
  itemId: string;
  to: HandOutPickTarget;
}

export type HandOutPickResult =
  /** Sent. `delivered: false` (pane and company) means the task was cancelled
   *  and the item is open again; `reason` is the refusal code. A worktree
   *  start answers its branch and the preparation notice. */
  | { ok: true; linkId: string; taskId?: string; delivered?: boolean; assurance?: SubmitAssurance; reason?: string; note?: string; branch?: string; prep?: HandoffPrepNotice }
  /** unknown: no such item. taken: it is out, or another pick of it runs. */
  | { ok: false; code: 'unknown' | 'taken' | 'invalid' | 'refused' | 'error'; message: string };

const ID_RE = /^ho-[0-9a-f-]{36}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const PANE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const isHandOutId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A folder with its trailing separators gone (a root keeps its own). */
export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim();
  const stripped = trimmed.replace(/[\\/]+$/, '');
  if (!stripped) return trimmed ? trimmed.slice(0, 1) : '';
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
}

/** An absolute POSIX path, or a Windows drive or UNC path. */
export function isAbsoluteFolder(folder: string): boolean {
  return folder.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folder) || /^[A-Za-z]:\\?$/.test(folder) || folder.startsWith('\\\\');
}

/** Whether `child` is `parent` or a folder inside it. Windows paths compare
 *  without case and with either separator. */
export function folderWithin(child: string, parent: string): boolean {
  const windows = /^[A-Za-z]:/.test(parent) || parent.startsWith('\\\\');
  const norm = (p: string) => {
    const n = normalizeFolder(p);
    return windows ? n.replace(/\//g, '\\').toLowerCase() : n;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const sep = windows ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** One line: control and invisible characters gone, whitespace collapsed, capped. */
function oneLine(text: string, max: number): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An add from untrusted input (IPC, a pipe call), cleaned; else null. */
export function parseHandOutAdd(v: unknown): HandOutAddRequest | null {
  if (!isRecord(v) || typeof v.title !== 'string' || typeof v.folder !== 'string') return null;
  const title = oneLine(v.title, HAND_OUT_LIMITS.MAX_TITLE);
  if (!title) return null;
  if (v.folder.includes('\0') || v.folder.length > HAND_OUT_LIMITS.MAX_FOLDER) return null;
  const folder = normalizeFolder(v.folder);
  if (!folder || !isAbsoluteFolder(folder)) return null;
  const out: HandOutAddRequest = { title, folder };
  if (v.agent !== undefined && v.agent !== null && v.agent !== '') {
    if (typeof v.agent !== 'string' || !AGENT_RE.test(v.agent)) return null;
    out.agent = v.agent;
  }
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== 'string') return null;
    const note = sanitizeHandoffNote(v.note).slice(0, HAND_OUT_LIMITS.MAX_NOTE);
    if (note) out.note = note;
  }
  return out;
}

function parseAddedBy(v: unknown): HandOutAddedBy | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'owner') return { kind: 'owner' };
  if (v.kind !== 'pane') return null;
  if (typeof v.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(v.workspaceId)) return null;
  if (typeof v.paneId !== 'string' || !PANE_ID_RE.test(v.paneId)) return null;
  if (v.name !== undefined && typeof v.name !== 'string') return null;
  const name = typeof v.name === 'string' ? oneLine(v.name, HAND_OUT_LIMITS.MAX_NAME) : '';
  return { kind: 'pane', workspaceId: v.workspaceId, paneId: v.paneId, ...(name ? { name } : {}) };
}

/** A stored item from untrusted input (the file on disk), or null. */
export function parseHandOutItem(v: unknown): HandOutItem | null {
  if (!isRecord(v) || !isHandOutId(v.id) || !isTime(v.createdAt)) return null;
  const fields = parseHandOutAdd(v);
  const addedBy = parseAddedBy(v.addedBy);
  if (!fields || !addedBy) return null;
  return { id: v.id, ...fields, addedBy, createdAt: v.createdAt };
}

/** The fields of a work link (shared/workLink.ts) an item's state reads. Kept
 *  local so the MCP bundle can import this file without the link module. */
export interface HandOutLinkView {
  id: string;
  handOutId?: string;
  state: string;
  reason?: string;
  createdAt: number;
}

/** A link that holds no work any more: abandoned, or blocked by its failed task. */
const isDropped = (link: HandOutLinkView): boolean =>
  link.state === 'abandoned' || (link.state === 'blocked' && link.reason === 'task-failed');

/**
 * An item's state from the work links its picks made: the newest link that
 * is not abandoned or failed decides (done, else out); with none the item
 * is open.
 */
export function handOutStateOf(itemId: string, links: readonly HandOutLinkView[]): { state: HandOutState; linkId?: string } {
  let live: HandOutLinkView | undefined;
  for (const link of links) {
    if (link.handOutId !== itemId || isDropped(link)) continue;
    if (!live || link.createdAt > live.createdAt) live = link;
  }
  if (!live) return { state: 'open' };
  return { state: live.state === 'done' ? 'done' : 'out', linkId: live.id };
}

/** Who added an item, as the message names them. */
export function handOutAddedByLine(by: HandOutAddedBy): string {
  return by.kind === 'owner' ? 'the owner' : by.name ? `#${by.name}` : 'an agent pane';
}

/**
 * The message an agent receives for an item: its title, folder, who added it
 * and its note. `company` asks a CEO to brief one of its seats with it.
 */
export function buildHandOutMessage(item: HandOutItem, opts: { company?: boolean } = {}): string {
  const lines = [
    `[wmux] To hand out: "${sanitizeHandoffTitle(item.title)}"`,
    `Folder: ${oneLine(item.folder, HAND_OUT_LIMITS.MAX_FOLDER)}`,
    `Added by ${handOutAddedByLine(item.addedBy)}${item.agent ? `; asks for ${item.agent}` : ''}.`,
  ];
  if (opts.company) lines.push('Brief one of your seats with it, and finish this task once that work is checked.');
  const note = item.note ? sanitizeHandoffNote(item.note) : '';
  if (note) lines.push('', note);
  return lines.join('\n');
}

/**
 * The branch of a worktree pick: `hand-out-<slug>-<suffix>`, the slug by the
 * issue branch's rules (none for a title with no ASCII letters or digits).
 * The suffix keeps a second pick of an item, or an item with the same title,
 * off a branch git already has.
 */
export function handOutBranchName(title: string, suffix: string): string {
  const slug = issueBranchName(0, title).replace(/^issue-0-?/, '');
  return ['hand-out', slug, suffix].filter(Boolean).join('-');
}
