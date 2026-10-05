/**
 * Fold-to-view mapping: the folded session becomes a flat list of transcript
 * rows. Each user block opens a turn; the turn's blocks follow it and a footer
 * closes it once the turn ended (or ticks while it is open). A live question
 * sits at the end of the open turn.
 */
import type { Block, Session } from '../../../shared/chatv2/session';
import type { UserQuestionPrompt } from '../../../shared/chatv2/userQuestion';
import { turnModelLabel } from './format';
import { S } from './strings';

export type ToolState = 'running' | 'done' | 'failed';

export type TranscriptRow =
  | { kind: 'user'; key: string; block: Block }
  | { kind: 'assistant'; key: string; block: Block }
  | { kind: 'reasoning'; key: string; block: Block }
  | { kind: 'tool'; key: string; block: Block; state: ToolState }
  | { kind: 'subagent'; key: string; block: Block; state: ToolState }
  | { kind: 'tasks'; key: string; block: Block }
  | { kind: 'plan'; key: string; block: Block }
  | { kind: 'image'; key: string; block: Block }
  | { kind: 'notice'; key: string; block: Block; tone: 'error' | 'interrupt' }
  | { kind: 'meta'; key: string; block: Block }
  | { kind: 'question'; key: string; prompt: UserQuestionPrompt }
  | ToolGroupRow
  | {
      kind: 'footer';
      key: string;
      /** The user block that opened the turn. */
      turnId: string;
      model: string;
      startedAt?: number;
      durationMs?: number;
      outcome?: Block['outcome'];
      /** The turn is still open: the footer ticks from `startedAt`. */
      live: boolean;
    };

/**
 * Consecutive routine tool calls folded into one expandable line. `rows` holds
 * the members in order, including any reasoning between them; `count` counts
 * the tool calls only.
 */
export type ToolGroupRow = {
  kind: 'toolGroup';
  key: string;
  label: string;
  count: number;
  state: ToolState;
  additions: number;
  deletions: number;
  rows: TranscriptRow[];
};

export function toolState(block: Block): ToolState {
  const status = block.tool?.status;
  if (status === 'failed' || status === 'cancelled' || status === 'error') return 'failed';
  if (status === 'completed' || status === 'done' || status === 'success') return 'done';
  // The fold clears `streaming` when the turn ends, so a call it never closed stops reading as live.
  return block.streaming || (!!block.approval && !block.approval.decided) ? 'running' : 'done';
}

function blockRow(block: Block): TranscriptRow | null {
  const key = block.id;
  switch (block.role) {
    case 'user':
      return { kind: 'user', key, block };
    case 'assistant':
      return block.text.trim() || block.streaming ? { kind: 'assistant', key, block } : null;
    case 'reasoning':
      return block.text.trim() ? { kind: 'reasoning', key, block } : null;
    case 'tool':
    case 'approval':
      return block.agentRun
        ? { kind: 'subagent', key, block, state: toolState(block) }
        : { kind: 'tool', key, block, state: toolState(block) };
    case 'tasks':
      return block.taskList?.items.length ? { kind: 'tasks', key, block } : null;
    case 'plan':
      return { kind: 'plan', key, block };
    case 'image':
      return { kind: 'image', key, block };
    case 'system':
      return block.notice ? { kind: 'notice', key, block, tone: block.notice } : block.text.trim() ? { kind: 'meta', key, block } : null;
    default:
      return null;
  }
}

function footer(session: Session, user: Block, open: boolean): TranscriptRow | null {
  const live = open && !!session.busy;
  if (!live && !user.outcome && user.durationMs == null) return null;
  return {
    kind: 'footer',
    key: `${user.id}:footer`,
    turnId: user.id,
    model: turnModelLabel(user.turnModel?.harness ?? session.harness, user.turnModel?.id ?? session.model),
    ...(user.startedAt != null ? { startedAt: user.startedAt } : {}),
    ...(user.durationMs != null ? { durationMs: user.durationMs } : {}),
    ...(user.outcome ? { outcome: user.outcome } : {}),
    live,
  };
}

/**
 * Rows built from the same block (or question) object are reused, so a push
 * that changed one block re-renders one row. Pass one cache per view.
 */
export type RowCache = WeakMap<object, TranscriptRow | null>;

// Footers of the previous call per cache (a footer depends on more than its block).
const footerCache = new WeakMap<RowCache, WeakMap<Block, TranscriptRow | null>>();

function sameFooter(a: TranscriptRow | null | undefined, b: TranscriptRow | null): boolean {
  if (!a || !b || a.kind !== 'footer' || b.kind !== 'footer') return a === b;
  return a.live === b.live && a.model === b.model && a.startedAt === b.startedAt && a.durationMs === b.durationMs && a.outcome === b.outcome;
}

export function sessionRows(session: Session, cache: RowCache = new WeakMap()): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const footers = new WeakMap<Block, TranscriptRow | null>();
  let turn: Block | null = null;
  const close = (open: boolean) => {
    if (!turn) return;
    const fresh = footer(session, turn, open);
    const previous = footerCache.get(cache)?.get(turn);
    const row = previous !== undefined && sameFooter(previous, fresh) ? previous : fresh;
    footers.set(turn, row);
    if (row) rows.push(row);
  };
  for (const block of session.blocks) {
    if (block.role === 'user') {
      close(false);
      turn = block;
    }
    let row = cache.get(block);
    if (row === undefined) {
      row = blockRow(block);
      cache.set(block, row);
    }
    if (row) rows.push(row);
  }
  const prompt = session.pendingQuestion;
  if (prompt) {
    let row = cache.get(prompt);
    if (row === undefined) {
      row = { kind: 'question', key: `q:${prompt.requestId}`, prompt };
      cache.set(prompt, row);
    }
    if (row) rows.push(row);
  }
  close(true);
  footerCache.set(cache, footers);
  return rows;
}

/** Requests a person can answer now, oldest first (approvals on blocks, then the question). */
export function pendingRequests(session: Session): string[] {
  const ids = session.blocks.filter((b) => b.approval && !b.approval.decided).map((b) => b.approval!.requestId);
  if (session.pendingQuestion) ids.push(session.pendingQuestion.requestId);
  return ids;
}

export type ToolFamily = 'read' | 'edit' | 'command' | 'search' | 'other';

/** Which same-kind fold a tool call belongs to. */
export function toolFamily(block: Block): ToolFamily {
  const kind = block.tool?.kind?.toLowerCase() ?? '';
  const preview = block.tool?.preview?.kind;
  if (kind === 'execute' || kind === 'shell' || (!kind && preview === 'shell')) return 'command';
  if (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'move' || (!kind && preview === 'write')) return 'edit';
  if (kind === 'read' || (!kind && preview === 'read')) return 'read';
  if (kind === 'search' || (!kind && preview === 'search')) return 'search';
  return 'other';
}

/** Lines an edit added and removed: the preview's own counts, else its diff lines. */
export function diffStats(block: Block): { additions: number; deletions: number } {
  const preview = block.tool?.preview;
  if (!preview || preview.contentOnly) return { additions: 0, deletions: 0 };
  const lines = preview.lines ?? [];
  return {
    additions: preview.additions ?? lines.filter((line) => line.kind === 'add').length,
    deletions: preview.deletions ?? lines.filter((line) => line.kind === 'del').length,
  };
}

// Same-kind runs fold from this many calls; any longer mixed run from MIXED_MIN.
const SAME_MIN: Record<ToolFamily, number> = { read: 3, edit: 2, command: 3, search: 3, other: Infinity };
const MIXED_MIN = 3;

// English like the rest of chat v2 (strings.ts): its labels move into the
// locale files, next to the legacy chat's `chat.group*`, when it leaves experimental.
function groupLabel(family: ToolFamily | 'mixed', n: number): string {
  switch (family) {
    case 'read': return S.groupRead(n);
    case 'edit': return S.groupEdited(n);
    case 'command': return S.groupRan(n);
    case 'search': return S.groupSearched(n);
    default: return S.groupMixed(n);
  }
}

/** A plain tool call nobody has to look at: no approval, not failed. */
function foldable(row: TranscriptRow): row is Extract<TranscriptRow, { kind: 'tool' }> {
  return row.kind === 'tool' && row.state !== 'failed' && !row.block.approval;
}

// Groups of the previous call per cache, by first member key.
const groupCache = new WeakMap<RowCache, Map<string, ToolGroupRow>>();

function sameMembers(a: TranscriptRow[], b: TranscriptRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

type Chunk = { members: TranscriptRow[]; family: ToolFamily | 'mixed'; folds: boolean };

/**
 * Splits one run into what it shows as: each same-kind stretch that reaches
 * its threshold is its own chunk, and the calls between such stretches merge
 * into one mixed chunk (folded from MIXED_MIN calls, else left as rows).
 * Reasoning stays with the call before it.
 */
function runChunks(run: TranscriptRow[]): Chunk[] {
  const segments: { members: TranscriptRow[]; family: ToolFamily; tools: number }[] = [];
  for (const row of run) {
    const family = row.kind === 'tool' ? toolFamily(row.block) : null;
    const open = segments.at(-1);
    if (open && (family === null || family === open.family)) {
      open.members.push(row);
      if (family) open.tools += 1;
    } else {
      segments.push({ members: [row], family: family ?? 'other', tools: 1 });
    }
  }
  const chunks: Chunk[] = [];
  let mixed: TranscriptRow[] = [];
  let mixedTools = 0;
  const flush = () => {
    if (!mixed.length) return;
    chunks.push({ members: mixed, family: 'mixed', folds: mixedTools >= MIXED_MIN });
    mixed = [];
    mixedTools = 0;
  };
  for (const segment of segments) {
    if (segment.tools >= SAME_MIN[segment.family]) {
      flush();
      chunks.push({ members: segment.members, family: segment.family, folds: true });
    } else {
      mixed.push(...segment.members);
      mixedTools += segment.tools;
    }
  }
  flush();
  // A run ends on a call, so only reasoning between calls is here, and it stays with its chunk.
  return chunks;
}

/** The family a merged chunk reads as: its one kind, or mixed. */
function mergedFamily(chunks: Chunk[]): ToolFamily | 'mixed' {
  const families = new Set(chunks.map((chunk) => chunk.family));
  return families.size === 1 ? chunks[0].family : 'mixed';
}

/**
 * Chunks a run without breaking a group already on screen. A group keeps its
 * first member (its key, so its open state) and at least all of its members:
 * chunks are merged until they cover it, and only what follows is chunked
 * afresh. Otherwise a mixed group that a later same-kind stretch re-splits
 * would get a new key and remount closed while it streams.
 */
function pinnedChunks(run: TranscriptRow[], previous: Map<string, ToolGroupRow> | undefined): Chunk[] {
  const pinAt = (from: number): number => {
    for (let i = from; i < run.length; i += 1) {
      const prior = previous?.get(run[i].key);
      if (prior && prior.rows.every((member, k) => run[i + k]?.key === member.key)) return i;
    }
    return -1;
  };
  const chunks: Chunk[] = [];
  let from = 0;
  while (from < run.length) {
    const pin = pinAt(from);
    if (pin < 0) { chunks.push(...runChunks(run.slice(from))); break; }
    if (pin > from) chunks.push(...runChunks(run.slice(from, pin)));
    const held = previous!.get(run[pin].key)!.rows.length;
    const next = pinAt(pin + held);
    const rest = runChunks(run.slice(pin, next < 0 ? run.length : next));
    let take = 0;
    let covered = 0;
    while (covered < held) covered += rest[take++].members.length;
    const head = rest.slice(0, take);
    chunks.push({ members: head.flatMap((chunk) => chunk.members), family: mergedFamily(head), folds: true }, ...rest.slice(take));
    from = next < 0 ? run.length : next;
  }
  return chunks;
}

function toolGroup(members: TranscriptRow[], family: ToolFamily | 'mixed', previous: Map<string, ToolGroupRow> | undefined): ToolGroupRow {
  const tools = members.filter(foldable);
  let additions = 0;
  let deletions = 0;
  for (const row of tools) {
    if (toolFamily(row.block) !== 'edit') continue;
    const stats = diffStats(row.block);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  const fresh: ToolGroupRow = {
    kind: 'toolGroup',
    key: `group:${members[0].key}`,
    label: groupLabel(family, tools.length),
    count: tools.length,
    state: tools.some((row) => row.state === 'running') ? 'running' : 'done',
    additions,
    deletions,
    rows: members,
  };
  const prior = previous?.get(members[0].key);
  return prior && prior.label === fresh.label && prior.state === fresh.state && sameMembers(prior.rows, members) ? prior : fresh;
}

/**
 * Folds runs of consecutive routine tool calls (see `foldable`) into
 * `toolGroup` rows: same-kind stretches first, mixed leftovers after. Reasoning between two calls rides inside the run; reasoning
 * after the last call stays outside, so a live "Thinking" never hides. Anything
 * else — text, approvals, questions, failures, notices — ends the run. The
 * group is keyed by its first member, so it keeps its place (and its open
 * state) while a streaming run grows, and the same object is returned while
 * its members are unchanged.
 */
export function groupToolRows(rows: TranscriptRow[], cache: RowCache = new WeakMap()): TranscriptRow[] {
  const previous = groupCache.get(cache);
  const groups = new Map<string, ToolGroupRow>();
  const out: TranscriptRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (!foldable(rows[index])) { out.push(rows[index]); index += 1; continue; }
    // Extend the run over tool calls and interior reasoning.
    let end = index + 1;
    let last = index;
    while (end < rows.length && (foldable(rows[end]) || rows[end].kind === 'reasoning')) {
      if (rows[end].kind === 'tool') last = end;
      end += 1;
    }
    for (const chunk of pinnedChunks(rows.slice(index, last + 1), previous)) {
      if (!chunk.folds) { out.push(...chunk.members); continue; }
      const group = toolGroup(chunk.members, chunk.family, previous);
      groups.set(chunk.members[0].key, group);
      out.push(group);
    }
    index = last + 1;
  }
  groupCache.set(cache, groups);
  return out;
}
