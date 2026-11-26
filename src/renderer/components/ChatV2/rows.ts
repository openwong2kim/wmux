/**
 * Fold-to-view mapping: the folded session becomes a flat list of transcript
 * rows. Each user block opens a turn; the turn's blocks follow it and a footer
 * closes it once the turn ended (or ticks while it is open). A live question
 * sits at the end of the open turn.
 */
import type { Block, Session } from '../../../shared/chatv2/session';
import type { UserQuestionPrompt } from '../../../shared/chatv2/userQuestion';
import { turnModelLabel } from './format';

/**
 * `stopped`: the turn ended (interrupted, failed, at the usage limit) before
 * the call reported its end, or a stop cancelled the approval it waited on.
 */
export type ToolState = 'running' | 'done' | 'failed' | 'stopped';

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
  | TurnFoldRow
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
      /** The open turn is held on the owner: an approval or a question waits. */
      waiting?: 'approval' | 'answer';
    };

/**
 * An unbroken run of tool calls folded into one expandable line. `rows` holds
 * the members in order, including any reasoning between them; `count` counts
 * the tool calls only. `label` is the sentence for the finished calls, and
 * `current` the call still running, if any.
 */
export type ToolGroupRow = {
  kind: 'toolGroup';
  key: string;
  label: string;
  count: number;
  failed: number;
  /** Calls the turn's early end left unfinished. */
  stopped: number;
  /** Calls the owner denied: they never ran, so the sentence leaves them out. */
  denied: number;
  state: ToolState;
  current?: Block;
  additions: number;
  deletions: number;
  rows: TranscriptRow[];
};

/**
 * A settled turn's work behind one line under its prompt ("Worked for 2m 14s").
 * Carries the turn's receipt (what its footer said) and the answer text, for Copy.
 */
export type TurnFoldRow = {
  kind: 'turnFold';
  key: string;
  turnId: string;
  model: string;
  startedAt?: number;
  durationMs?: number;
  outcome?: Block['outcome'];
  /** Failed tool calls inside the fold. */
  failed: number;
  answer: string;
  rows: TranscriptRow[];
};

export function toolState(block: Block): ToolState {
  const status = block.tool?.status;
  if (status === 'completed' || status === 'done' || status === 'success') return 'done';
  // An approval settled without an answer (a stop, an expiry) on a call that never finished: it did not run, and nothing failed.
  if (block.approval?.decided === 'cancelled') return 'stopped';
  if (status === 'failed' || status === 'cancelled' || status === 'error') return 'failed';
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
  const waiting = !live ? undefined
    : session.blocks.some((b) => b.approval && !b.approval.decided) ? 'approval'
      : session.pendingQuestion ? 'answer' : undefined;
  return {
    kind: 'footer',
    key: `${user.id}:footer`,
    turnId: user.id,
    model: turnModelLabel(user.turnModel?.harness ?? session.harness, user.turnModel?.id ?? session.model),
    ...(user.startedAt != null ? { startedAt: user.startedAt } : {}),
    ...(user.durationMs != null ? { durationMs: user.durationMs } : {}),
    ...(user.outcome ? { outcome: user.outcome } : {}),
    live,
    ...(waiting ? { waiting } : {}),
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
  return a.live === b.live && a.waiting === b.waiting && a.model === b.model && a.startedAt === b.startedAt && a.durationMs === b.durationMs && a.outcome === b.outcome;
}

/** A call that reported its own end (done or failed), as opposed to one the turn's end closed. */
function closedCall(block: Block): boolean {
  const status = block.tool?.status;
  return status === 'completed' || status === 'done' || status === 'success' || status === 'failed' || status === 'cancelled' || status === 'error';
}

// Rows of calls a turn's early end left open, by block, per cache.
const stoppedCache = new WeakMap<RowCache, WeakMap<Block, TranscriptRow>>();

export function sessionRows(session: Session, cache: RowCache = new WeakMap()): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let stopped = stoppedCache.get(cache);
  if (!stopped) { stopped = new WeakMap(); stoppedCache.set(cache, stopped); }
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
    // A turn that ended early leaves the calls it never closed: they did not finish, so they are not done.
    if (row && (row.kind === 'tool' || row.kind === 'subagent') && row.state === 'done' && turn?.outcome && turn.outcome !== 'completed' && !closedCall(block)) {
      let held = stopped.get(block);
      if (!held || held.kind !== row.kind) { held = { ...row, state: 'stopped' }; stopped.set(block, held); }
      row = held;
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


// One run's sentence, in the order its kinds were first used: "Read 3 files,
// edited 2, ran 1 command". A noun the item before already said is dropped.
const RUN_VERB: Record<ToolFamily, string> = { read: 'read', edit: 'edited', command: 'ran', search: 'searched', other: 'used' };

function runNoun(family: ToolFamily, n: number): string {
  switch (family) {
    case 'read':
    case 'edit': return n === 1 ? 'file' : 'files';
    case 'command': return n === 1 ? 'command' : 'commands';
    case 'search': return n === 1 ? 'time' : 'times';
    default: return n === 1 ? 'tool' : 'tools';
  }
}

/** What a call acted on, to count distinct files for reads and edits. */
function callTarget(block: Block): string {
  // A title that is just the tool's name ("Edit") names no file: it would count every file as one.
  const title = block.tool?.title?.trim();
  return block.tool?.preview?.path ?? (title && /\s/.test(title) ? title : block.id);
}

/** "Read 3 files, edited 2, ran 1 command" for the finished calls of a run ('' when none finished). */
export function runSentence(blocks: readonly Block[]): string {
  const order: ToolFamily[] = [];
  const counts = new Map<ToolFamily, Set<string> | number>();
  for (const block of blocks) {
    const family = toolFamily(block);
    if (!counts.has(family)) { order.push(family); counts.set(family, family === 'read' || family === 'edit' ? new Set<string>() : 0); }
    const count = counts.get(family)!;
    if (typeof count === 'number') counts.set(family, count + 1); else count.add(callTarget(block));
  }
  let lastNoun = '';
  const parts = order.map((family) => {
    const count = counts.get(family)!;
    const n = typeof count === 'number' ? count : count.size;
    const noun = runNoun(family, n);
    // "edited 2" after "Read 3 files": the noun is already said (only for the same plural).
    const part = family === 'search' && n === 1 ? 'searched once'
      : noun === lastNoun ? `${RUN_VERB[family]} ${n}` : `${RUN_VERB[family]} ${n} ${noun}`;
    lastNoun = noun;
    return part;
  });
  const text = parts.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/**
 * A tool call that can ride in a run: anything but a call still waiting on the
 * owner's approval (that one needs a person, so it stays on its own line).
 * Failed and running calls ride along; the run's line counts them.
 */
function foldable(row: TranscriptRow): row is Extract<TranscriptRow, { kind: 'tool' }> {
  return row.kind === 'tool' && !(row.block.approval && !row.block.approval.decided);
}

/** A call the owner denied: it never ran. */
const deniedCall = (row: Extract<TranscriptRow, { kind: 'tool' }>): boolean => row.block.approval?.decided === 'deny';

/** A call that failed on its own; one the owner denied did what was asked. */
const failedCall = (row: Extract<TranscriptRow, { kind: 'tool' }>): boolean => row.state === 'failed' && !deniedCall(row);

// Groups of the previous call per cache, by first member key.
const groupCache = new WeakMap<RowCache, Map<string, ToolGroupRow>>();

function sameMembers(a: readonly TranscriptRow[], b: readonly TranscriptRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

function toolGroup(members: TranscriptRow[], previous: Map<string, ToolGroupRow> | undefined): ToolGroupRow {
  const tools = members.filter(foldable);
  let additions = 0;
  let deletions = 0;
  for (const row of tools) {
    if (toolFamily(row.block) !== 'edit' || row.state === 'failed') continue;
    const stats = diffStats(row.block);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  const running = tools.find((row) => row.state === 'running');
  const stoppedCalls = tools.filter((row) => row.state === 'stopped').length;
  const fresh: ToolGroupRow = {
    kind: 'toolGroup',
    key: `group:${members[0].key}`,
    // The sentence says what ran: a call still running, cut short or denied is told apart.
    label: runSentence(tools.filter((row) => row.state !== 'running' && row.state !== 'stopped' && !deniedCall(row)).map((row) => row.block)),
    stopped: stoppedCalls,
    denied: tools.filter(deniedCall).length,
    count: tools.length,
    failed: tools.filter(failedCall).length,
    state: running ? 'running' : 'done',
    ...(running ? { current: running.block } : {}),
    additions,
    deletions,
    rows: members,
  };
  const prior = previous?.get(members[0].key);
  return prior && prior.label === fresh.label && prior.state === fresh.state && prior.denied === fresh.denied && prior.stopped === fresh.stopped && prior.failed === fresh.failed && prior.current === fresh.current && sameMembers(prior.rows, members) ? prior : fresh;
}

/**
 * Folds every unbroken run of tool calls (see `foldable`) into one
 * `toolGroup` row whose line is one sentence for the whole run; a single call
 * stays its own row, which shows its own command. Reasoning between two calls
 * rides inside the run; reasoning after the last call stays outside, so a live
 * "Thinking" never hides. Anything else (text, approvals, questions,
 * subagents, notices) ends the run. The group is keyed by its first member, so
 * it keeps its place (and its open state) while a streaming run grows, and the
 * same object is returned while its members are unchanged.
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
    let tools = 1;
    while (end < rows.length && (foldable(rows[end]) || rows[end].kind === 'reasoning')) {
      if (rows[end].kind === 'tool') { last = end; tools += 1; }
      end += 1;
    }
    const members = rows.slice(index, last + 1);
    if (tools < 2) {
      out.push(...members);
    } else {
      const group = toolGroup(members, previous);
      groups.set(members[0].key, group);
      out.push(group);
    }
    index = last + 1;
  }
  groupCache.set(cache, groups);
  return out;
}

/** Rows a settled turn keeps open under its fold: the answer and what the turn itself said. */
function staysOpen(row: TranscriptRow): boolean {
  return row.kind === 'notice' || row.kind === 'plan' || row.kind === 'image' || row.kind === 'question';
}

/** Rows that can follow the answer without being work: a status line ("Continued in the terminal."), the task list. */
function trailsAnswer(row: TranscriptRow): boolean {
  return staysOpen(row) || row.kind === 'meta' || row.kind === 'tasks';
}

/** The tool calls a set of rows holds, through groups. */
function toolRowsIn(rows: readonly TranscriptRow[]): Extract<TranscriptRow, { kind: 'tool' }>[] {
  return rows.flatMap((row) => (row.kind === 'toolGroup' ? toolRowsIn(row.rows) : row.kind === 'tool' ? [row] : []));
}

// Folds of the previous call per cache, by key.
const turnFoldCache = new WeakMap<RowCache, Map<string, TurnFoldRow>>();

/**
 * Folds each settled turn behind one quiet line under its prompt: the work
 * (tool runs, reasoning, prose written along the way) goes into a `turnFold`
 * row, and only the answer (the prose after the last piece of work) and the
 * turn's own notices, plans and images stay open below it. The turn's receipt
 * (its footer) becomes that line. The open turn is left as it is. Rows before
 * the first prompt (a window that starts mid-turn) are left too.
 */
export function foldTurns(rows: TranscriptRow[], cache: RowCache = new WeakMap()): TranscriptRow[] {
  const previous = turnFoldCache.get(cache);
  const folds = new Map<string, TurnFoldRow>();
  const out: TranscriptRow[] = [];
  let index = 0;
  while (index < rows.length && rows[index].kind !== 'user') out.push(rows[index++]);
  while (index < rows.length) {
    const user = rows[index] as Extract<TranscriptRow, { kind: 'user' }>;
    let end = index + 1;
    while (end < rows.length && rows[end].kind !== 'user') end += 1;
    const body = rows.slice(index + 1, end);
    const footer = body.at(-1)?.kind === 'footer' ? body.at(-1) as Extract<TranscriptRow, { kind: 'footer' }> : undefined;
    const settled = footer ? !footer.live : end < rows.length;
    out.push(user);
    if (!settled) {
      out.push(...body);
      index = end;
      continue;
    }
    const work = footer ? body.slice(0, -1) : body;
    // The answer: the prose after the last row that is not prose.
    let tail = work.length;
    while (tail > 0 && (work[tail - 1].kind === 'assistant' || trailsAnswer(work[tail - 1]))) tail -= 1;
    // Rows that stay open anyway do not make an answer: it starts at the first prose of that tail.
    let answerFrom = tail;
    while (answerFrom < work.length && work[answerFrom].kind !== 'assistant') answerFrom += 1;
    const members: TranscriptRow[] = [];
    const open: TranscriptRow[] = [];
    // A status line stays open only after the last piece of work (with or without an answer); one mid-turn folds.
    work.forEach((row, at) => (at >= answerFrom || staysOpen(row) || (at >= tail && row.kind === 'meta') ? open : members).push(row));
    // Copy offers only a whole answer: a capped block holds just its first part.
    const prose = open.filter((row): row is Extract<TranscriptRow, { kind: 'assistant' }> => row.kind === 'assistant');
    const answer = prose.some((row) => row.block.overflow?.text) ? '' : prose.map((row) => row.block.text).join('\n\n').trim();
    const fresh: TurnFoldRow = {
      kind: 'turnFold',
      key: `${user.key}:fold`,
      turnId: user.key,
      model: footer?.model ?? '',
      ...(footer?.startedAt != null ? { startedAt: footer.startedAt } : {}),
      ...(footer?.durationMs != null ? { durationMs: footer.durationMs } : {}),
      ...(footer?.outcome ? { outcome: footer.outcome } : {}),
      failed: toolRowsIn(members).filter(failedCall).length,
      answer,
      rows: members,
    };
    const prior = previous?.get(fresh.key);
    const row = prior && sameMembers(prior.rows, members) && prior.answer === fresh.answer && prior.model === fresh.model
      && prior.startedAt === fresh.startedAt && prior.durationMs === fresh.durationMs && prior.outcome === fresh.outcome ? prior : fresh;
    folds.set(row.key, row);
    out.push(row, ...open);
    index = end;
  }
  turnFoldCache.set(cache, folds);
  return out;
}

/** The view's rows for a session: turns, then tool runs, then settled turns folded. */
export function transcriptRows(session: Session, cache: RowCache = new WeakMap()): TranscriptRow[] {
  return foldTurns(groupToolRows(sessionRows(session, cache), cache), cache);
}

/** Whether `row` shows the block `blockId`, itself or through a run or a folded turn. */
export function rowHolds(row: TranscriptRow, blockId: string): boolean {
  if (row.kind === 'toolGroup' || row.kind === 'turnFold') return row.rows.some((member) => rowHolds(member, blockId));
  return 'block' in row && row.block.id === blockId;
}
