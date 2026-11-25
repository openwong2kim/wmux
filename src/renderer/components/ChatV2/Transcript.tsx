import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderBrainMarkdown } from '../shared/BrainMarkdown';
import type { AgentStep, Block, ToolPreview } from '../../../shared/chatv2/session';
import { claudeModelLabel } from '../../../shared/claudeModels';
import { displayPath } from '../../../shared/chatv2/paths';
import { taskListProgressLabel } from '../../../shared/chatv2/taskList';
import type { FormAnswers } from '../../../shared/chatv2/questions';
import { ApprovalCard, ErrorCard, QuestionCard } from './Cards';
import { absolutePath, formatClockTime, formatElapsed, formatWorkingDuration, relativeToCwd, toolLabelParts } from './format';
import { diffStats, rowHolds, toolFamily, type ToolGroupRow, type ToolState, type TranscriptRow, type TurnFoldRow } from './rows';
import { IconCheck, IconChevron, IconCopy, IconExternalLink, IconFile, IconX } from '../icons';
import { attachmentThumbnail } from './thumbnails';
import type { Attachment } from '../../../shared/chatv2/session';
import type { BodyRead } from './controller';
import { S } from './strings';

export interface TranscriptActions {
  answer(requestId: string, decision: 'allow' | 'deny', answers?: FormAnswers): Promise<boolean>;
  body(blockId: string, field: 'text' | 'detail' | 'output', offset?: number): Promise<BodyRead | null>;
  /** Send the failed turn's prompt again; only the newest error offers it (`retryId`). */
  retry?: () => Promise<boolean>;
  retryId?: string;
}

/** A status mark drawn as an icon or a shape, never a text glyph: the sidebar's grammar. */
type Mark = 'check' | 'cross' | 'dot' | 'ring' | 'step';

// A call held for the owner's answer wears the needs-you ring, as in the sidebar.
// 'quiet' holds the glyph's place with nothing in it: a finished call inside a run, or an interrupted turn.
type GlyphState = ToolState | 'waiting' | 'quiet';
const TOOL_MARK: Record<Exclude<GlyphState, 'quiet'>, Mark> = { running: 'dot', done: 'check', failed: 'cross', waiting: 'ring', stopped: 'step' };

function MarkIcon({ mark }: { mark: Mark }) {
  if (mark === 'check') return <IconCheck size={12} />;
  if (mark === 'cross') return <IconX size={12} />;
  return <span className="wmux-chatv2-mark" data-mark={mark} />;
}

function StatusGlyph({ state }: { state: GlyphState }) {
  return <span className="wmux-chatv2-glyph" data-state={state} aria-hidden>{state === 'quiet' ? null : <MarkIcon mark={TOOL_MARK[state]} />}</span>;
}

/**
 * Open state of disclosures (tool rows, runs, turn folds) by row key, kept
 * outside the components so a row that remounts (a workspace switch, a window
 * move, a run that grew into a group) opens as the reader left it. Bounded:
 * the oldest entries go first.
 */
const openRows = new Map<string, boolean>();
const OPEN_ROWS_MAX = 2_000;

/** The chat the rows belong to: block ids repeat from one chat to the next, so open state is kept per chat. */
export const OpenScope = createContext('');

export function useOpenState(rowKey: string): [boolean, (open: boolean) => void] {
  const key = `${useContext(OpenScope)}\u0000${rowKey}`;
  const [state, setState] = useState(() => ({ key, open: openRows.get(key) ?? false }));
  // The same component can be handed another row (another chat in this pane, same block ids): read that row's state.
  const open = state.key === key ? state.open : openRows.get(key) ?? false;
  const setOpen = (next: boolean) => {
    openRows.delete(key);
    if (next) {
      openRows.set(key, true);
      if (openRows.size > OPEN_ROWS_MAX) openRows.delete(openRows.keys().next().value as string);
    }
    setState({ key, open: next });
  };
  return [open, setOpen];
}

/**
 * Open state that a find match opens once: the match (`match`, the matched
 * block id) opens the row in the same render, so the view can scroll the match
 * into place, and the opening is stored, so the reader can close it again.
 * A different match opens it again.
 */
export function useFindOpen(rowKey: string, match: string | null): [boolean, (open: boolean) => void] {
  const [stored, setOpen] = useOpenState(rowKey);
  const [applied, setApplied] = useState<string | null>(null);
  useEffect(() => {
    if (!match) { if (applied) setApplied(null); return; }
    if (applied === match) return;
    setApplied(match);
    if (!stored) setOpen(true);
  }, [match]);
  return [stored || (!!match && applied !== match), setOpen];
}

/** A <details> whose open state survives a remount (see useOpenState) and that a find match opens (see useFindOpen). */
function Disclosure({ storeKey, className, forceOpen, children }: { storeKey: string; className?: string; forceOpen?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = useFindOpen(storeKey, forceOpen ?? null);
  return (
    <details className={className} open={open} onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) setOpen(next); }}>
      {children}
    </details>
  );
}

const TASK_MARK: Record<string, Mark> = { completed: 'check', in_progress: 'dot', cancelled: 'cross' };

/**
 * Assistant prose and plans, in the chat variant: code blocks keep the fence's
 * file name and an always-visible Copy, links open (through the app's
 * external-link handler), and emphasis stays off code-like text.
 */
const renderMarkdown = (text: string) => renderBrainMarkdown(text, { richCode: true, chat: true, links: true, strictEmphasis: true });

function previewSummary(preview: ToolPreview | undefined, title: string, cwd: string): string {
  // A shell preview's own title is the tool name ("Bash"), never a summary.
  const value = preview?.path ? displayPath(preview.path, cwd) : preview?.query ?? '';
  return value && !title.includes(value) ? value : '';
}

function PreviewBody({ preview, cwd }: { preview: ToolPreview; cwd: string }) {
  if (preview.lines?.length) {
    const path = preview.kind === 'write' && preview.path;
    return (
      <div className="wmux-chatv2-pre" data-diff>
        {path && (
          // The row title already names the path; this is where it leads.
          <button type="button" className="wmux-chatv2-evidence" title={displayPath(path, cwd)} onClick={() => void window.electronAPI?.shell?.openPath?.(absolutePath(path, cwd))}>
            {S.openFile}<IconExternalLink size={11} />
          </button>
        )}
        <pre>
          {preview.lines.map((line, index) => (
            <span key={index} className="wmux-chatv2-line" data-kind={line.kind}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} {line.text}
            </span>
          ))}
        </pre>
      </div>
    );
  }
  return preview.output ? <pre className="wmux-chatv2-pre">{preview.output}</pre> : null;
}

/** How often an open, running command's full output is read again as it grows. */
const RUNNING_REREAD_MS = 2_000;

/** How many of a long output's last lines the collapsed box holds. */
export const SHELL_TAIL_LINES = 40;

/**
 * What the output box shows. A head the fold cut (`complete` false) is shown
 * up to its last whole line, never cut mid-line. A complete output, collapsed,
 * shows its last `tail` lines and how many came before them.
 */
export function shellView(text: string, complete: boolean, expanded: boolean, tail = SHELL_TAIL_LINES): { text: string; earlier: number } {
  const whole = complete ? text : text.slice(0, text.lastIndexOf('\n') + 1) || text;
  const lines = whole.replace(/\n$/, '').split('\n');
  if (expanded || !complete || lines.length <= tail) return { text: whole, earlier: 0 };
  return { text: `${lines.slice(-tail).join('\n')}\n`, earlier: lines.length - tail };
}

/**
 * A command and what it printed: a dim `$ command` line, then the output,
 * faded where it scrolls. A long output opens on its real tail (what the
 * command said last): an output the fold cut is read in full when its row
 * opens, so the end shown is the command's end, not the cut's. One control
 * shows the whole output and folds it back.
 */
function ShellBody({ block, field, running, actions, command, output }: { block: Block; field: 'output' | 'detail'; running: boolean; actions: TranscriptActions; command: string | null; output: string }) {
  const root = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLPreElement>(null);
  const cut = !!block.overflow?.[field];
  // A full read belongs to one state of the value. A running call's block is
  // folded anew as output arrives (past the capped preview too), so a new
  // block of a running call makes it stale, at most once per RUNNING_REREAD_MS
  // so a busy command is not read again on every push; a new status (the call
  // finished) or another field makes it stale at once.
  const turn = useRef({ block, n: 0, at: 0 });
  if (turn.current.block !== block) {
    const now = Date.now();
    const bump = running && now - turn.current.at >= RUNNING_REREAD_MS;
    turn.current = { block, n: turn.current.n + (bump ? 1 : 0), at: bump ? now : turn.current.at };
  }
  const full = useFullBody(block, field, actions, `${field}|${block.tool?.status ?? ''}|${turn.current.n}|${output}`);
  const fullRef = useRef(full);
  fullRef.current = full;
  const complete = !cut || (!!full.read && !full.read.stopped);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [long, setLong] = useState(false);
  const shown = shellView(full.read ? full.read.text : output, complete, expanded);
  // Which edges have more beyond them: those fade.
  const edges = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const fade = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : '';
    if (fade) el.dataset.fade = fade; else delete el.dataset.fade;
  };
  const settle = () => {
    const el = ref.current;
    if (!el) return;
    // A closed <details> measures 0: only an open one says whether the output is long.
    if (!expandedRef.current && el.clientHeight > 0) {
      // Only an output larger than its box opens on its tail; one that fits reads from its top.
      const over = el.scrollHeight > el.clientHeight + 1;
      el.scrollTop = over ? el.scrollHeight : 0;
      setLong(over);
    }
    edges();
  };
  // A cut output is read in full once its row is open, so its tail is the real one.
  const readIfCut = () => {
    const body = fullRef.current;
    if (cut && (body.read === undefined || body.stale) && !body.loading) body.load();
  };
  useLayoutEffect(settle, [shown.text, expanded]);
  // A closed <details> lays out nothing, so measure again (and read) whenever one around it opens.
  useEffect(() => {
    const opened: HTMLDetailsElement[] = [];
    for (let el = root.current?.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) opened.push(el);
    const onToggle = () => {
      if (opened.every((el) => el.open)) readIfCut();
      settle();
    };
    if (opened.length && opened.every((el) => el.open)) readIfCut();
    opened.forEach((el) => el.addEventListener('toggle', onToggle));
    return () => opened.forEach((el) => el.removeEventListener('toggle', onToggle));
  }, [shown.text, cut, full.stale]);
  const toggle = () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    readIfCut();
  };
  const stopped = !!full.read?.stopped || full.read === null;
  const firstRead = full.loading && full.read === undefined;
  return (
    <div ref={root} className="wmux-chatv2-pre" data-shell>
      {command && <div className="wmux-chatv2-shell-command">$ {command}</div>}
      {shown.earlier > 0 && <div className="wmux-chatv2-shell-earlier" data-shell-earlier>{`\u2026 ${S.earlierLines(shown.earlier)}`}</div>}
      {shown.text && <pre ref={ref} className="wmux-chatv2-shell-output" data-full={expanded || undefined} onScroll={edges}>{shown.text}</pre>}
      {stopped ? (
        <BodyMore read={full.read} loading={full.loading} load={full.load} first={S.showMore} />
      ) : (long || shown.earlier > 0 || expanded || (cut && !complete)) && (
        <span className="wmux-chatv2-body-more">
          {/* A refresh of an output already shown keeps the control as it is. */}
          <button type="button" className="wmux-chatv2-link" data-output-toggle aria-expanded={expanded} disabled={firstRead} onClick={toggle}>
            {firstRead ? S.loadingFull : expanded ? S.showLess : S.showMore}
          </button>
        </span>
      )}
    </div>
  );
}

/** Green `+N` and red `−M` for an edit; nothing when both are zero. */
function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <span className="wmux-chatv2-diffstat">
      {additions > 0 && <span data-kind="add">+{additions}</span>}
      {deletions > 0 && <span data-kind="del">{'\u2212'}{deletions}</span>}
    </span>
  );
}

function ToolLabel({ verb, object, mono }: CallLabel) {
  return (
    <span className="wmux-chatv2-tool-title">
      <span className="wmux-chatv2-tool-verb">{verb}</span>
      {object && <> <span className="wmux-chatv2-tool-object" data-mono={mono || undefined}>{object}</span></>}
    </span>
  );
}

const Chevron = () => <span className="wmux-chatv2-chevron" aria-hidden><IconChevron size={12} /></span>;

/**
 * The part a byte cap cut, fetched on request (`bodies`). `text` undefined =
 * not asked, null = no longer kept. A partial read keeps what it has and offers
 * to continue (`stopped`).
 */
function useFullBody(block: Block, field: 'text' | 'detail' | 'output', actions: TranscriptActions, resetKey?: string) {
  const [read, setRead] = useState<BodyRead | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  // A changed `resetKey` means the value moved on (more output, a new status):
  // what was read is stale (kept on screen until a fresh read replaces it), and
  // a read still in flight is dropped when it lands.
  const [stale, setStale] = useState(false);
  const generation = useRef(0);
  const seenKey = useRef(resetKey);
  useEffect(() => {
    if (seenKey.current === resetKey) return;
    seenKey.current = resetKey;
    generation.current += 1;
    setStale(true);
    setLoading(false);
  }, [resetKey]);
  const load = () => {
    if (loading) return;
    setLoading(true);
    const resume = !stale && !!read?.stopped;
    const from = resume ? read?.nextOffset ?? 0 : 0;
    const before = resume ? read?.text ?? '' : '';
    const asked = generation.current;
    void actions.body(block.id, field, from).then((next) => {
      if (asked !== generation.current) return;
      setStale(false);
      if (next) setRead({ ...next, text: before + next.text });
      else if (before) setRead({ text: before, nextOffset: from, stopped: 'error' });
      else setRead(null);
    }).finally(() => { if (asked === generation.current) setLoading(false); });
  };
  return { read, load, loading, stale };
}

/** Continue or retry a partial read, or say the value is gone. */
function BodyMore({ read, loading, load, first }: { read: BodyRead | null | undefined; loading: boolean; load: () => void; first: string }) {
  if (read === null) return <span className="wmux-chatv2-meta">{S.bodyGone}</span>;
  if (read && !read.stopped) return null;
  const label = loading ? S.loadingFull : !read ? first : read.stopped === 'limit' ? S.showRest : S.retry;
  return (
    <span className="wmux-chatv2-body-more">
      {read?.stopped === 'error' && <span className="wmux-chatv2-meta" role="status">{S.partialLoaded}</span>}
      <button type="button" className="wmux-chatv2-link" data-truncated disabled={loading} onClick={load}>{label}</button>
    </span>
  );
}

function FullBody({ block, field, actions }: { block: Block; field: 'detail' | 'output'; actions: TranscriptActions }) {
  const { read, load, loading } = useFullBody(block, field, actions);
  return (
    <>
      {read && <pre className="wmux-chatv2-pre">{read.text}</pre>}
      <BodyMore read={read} loading={loading} load={load} first={S.showMore} />
    </>
  );
}

/** Block prose, with the cut tail offered on request when the fold capped it. */
function CappedText({ block, actions, render }: { block: Block; actions: TranscriptActions; render: (text: string) => React.ReactNode }) {
  const { read, load, loading } = useFullBody(block, 'text', actions);
  return (
    <>
      {render(read ? read.text : block.text)}
      {block.overflow?.text && <BodyMore read={read} loading={loading} load={load} first={S.showFullText} />}
    </>
  );
}

/** A call's line: a verb (sans) and what it acted on (mono when it is a command, path or pattern). */
type CallLabel = { verb: string; object: string; mono: boolean };

/**
 * A search whose query reads as a file pattern rather than text: a glob star,
 * brace or path, and none of a regular expression's own marks (`.*`, `\`, `|`,
 * anchors, groups), so a grep for `foo.*bar` still reads as a search.
 */
export function looksLikeGlob(query: string): boolean {
  if (/\.[*+?]|\\|\||\^|\$|\(/.test(query)) return false;
  return /[*?{]/.test(query) || /^[^\s]*\/[^\s]*$/.test(query);
}

export function callLabel(block: Block, state: ToolState, cwd: string): CallLabel {
  const tool = block.tool;
  const preview = tool?.preview;
  const family = toolFamily(block);
  // A command reads exactly as it ran; only paths in other titles are shortened to the chat's directory.
  const raw = (tool?.title || block.text || tool?.kind || 'Tool').trim();
  const title = family === 'command' ? raw : relativeToCwd(raw, cwd);
  if (block.approval && !block.approval.decided) return { verb: S.waitingForApproval, object: preview?.command ?? title, mono: family !== 'other' };
  // A call the owner denied never ran: it says so, instead of reading as run.
  if (block.approval?.decided === 'deny') return { verb: S.denied, object: preview?.command ?? title, mono: family !== 'other' };
  // A call the turn's end cut short says so, instead of reading as done (a search too).
  if (state === 'stopped') return { verb: S.stoppedCall, object: preview?.command ?? title, mono: family !== 'other' };
  if (family === 'search') {
    const query = preview?.query ?? title.replace(/^(?:find|search|grep|glob)\b\s*/i, '');
    const glob = looksLikeGlob(query);
    const verb = state === 'running' ? (glob ? S.findingFiles : S.searchingFor) : glob ? S.foundFiles : S.searchedFor;
    return { verb, object: glob ? query : `\u201c${query}\u201d`, mono: true };
  }
  const shell = family === 'command' && !READABLE_TITLE.test(title);
  const parts = toolLabelParts(title, { command: shell, running: state === 'running' });
  return { ...parts, mono: family !== 'other' };
}

// Titles the fold already rewrote into words ("Read a.ts" for `cat a.ts`) are not commands.
const READABLE_TITLE = /^(Read|List|Find|Search|Edit|Write|Delete|Move|Fetch|Skill)\b/;

/**
 * What a command printed: the preview's output, else the result detail. The
 * detail starts as the request ("Bash: git add .") and keeps it when the
 * command printed nothing, so a detail that is just the request is no output.
 */
export function shellOutput(output: string | undefined, detail: string | undefined, command: string | null): string {
  if (output) return output;
  if (!detail) return '';
  const request = /^[\w.-]+: ([\s\S]*)$/.exec(detail);
  return request && command && command.startsWith(request[1]) ? '' : detail;
}

function ToolRow({ block, state, cwd, actions, findActive, enter, inRun }: { block: Block; state: ToolState; cwd: string; actions: TranscriptActions; findActive: boolean; enter?: boolean; inRun?: boolean }) {
  const tool = block.tool;
  const preview = tool?.preview;
  const title = tool?.title || block.text || tool?.kind || 'Tool';
  const label = callLabel(block, state, cwd);
  const summary = previewSummary(preview, `${label.verb} ${label.object}`, cwd);
  const family = toolFamily(block);
  const shell = family === 'command';
  const command = shell ? preview?.command ?? (!preview && !READABLE_TITLE.test(title) ? title : null) : null;
  const output = shell ? shellOutput(preview?.output, tool?.detail, command) : '';
  const stats = family === 'edit' ? diffStats(block) : null;
  const hasBody = shell ? !!(output || block.overflow?.output || block.overflow?.detail) : !!(preview?.lines?.length || preview?.output || tool?.detail);
  // A call held for the owner's answer is not running yet: it waits (its card is pinned over the composer).
  const waiting = !!block.approval && !block.approval.decided;
  // A diff already shows what an edit did; the result text under it only repeats it.
  // A failed edit still shows its error under the diff.
  const diff = !!preview?.lines?.length && state !== 'failed';
  const line = (
    <>
      {/* A finished call inside a run leaves its check to the run's line. */}
      {/* A denied call did not fail: it never ran, so it takes the muted mark. */}
      <StatusGlyph state={waiting ? 'waiting' : block.approval?.decided === 'deny' ? 'stopped' : inRun && state === 'done' ? 'quiet' : state} />
      <ToolLabel {...label} />
      {summary && <span className="wmux-chatv2-tool-summary">{summary}</span>}
      {stats && <DiffStats additions={stats.additions} deletions={stats.deletions} />}
      {hasBody && <Chevron />}
    </>
  );
  return (
    <div className="wmux-chatv2-tool" data-block-id={block.id} data-find-active={findActive || undefined} data-enter={enter || undefined}>
      {hasBody ? (
        <Disclosure storeKey={block.id} forceOpen={findActive ? block.id : null}>
          <summary className="wmux-chatv2-tool-line">{line}</summary>
          {shell ? (
            <ShellBody block={block} field={preview?.output ? 'output' : 'detail'} running={state === 'running'} actions={actions} command={command} output={output} />
          ) : (
            <>
              {preview && <PreviewBody preview={preview} cwd={cwd} />}
              {block.overflow?.output && <FullBody block={block} field="output" actions={actions} />}
              {tool?.detail && !diff && <pre className="wmux-chatv2-pre" data-detail>{tool.detail}</pre>}
              {block.overflow?.detail && !diff && <FullBody block={block} field="detail" actions={actions} />}
            </>
          )}
        </Disclosure>
      ) : (
        <div className="wmux-chatv2-tool-line">{line}</div>
      )}
      {block.approval?.decided && <ApprovalCard block={block} onAnswer={actions.answer} />}
    </div>
  );
}

/**
 * One run of tool calls behind one sans sentence ("Read 3 files, edited 2,
 * ran 1 command"), the call still running after it, failures counted in red,
 * and one muted check once the run settled clean. Opened on demand (or by find).
 */
function ToolGroupView({ row, cwd, actions, findId, findActive, enter }: { row: ToolGroupRow; cwd: string; actions: TranscriptActions; findId?: string | null; findActive: boolean; enter?: boolean }) {
  const current = row.current ? callLabel(row.current, 'running', cwd) : null;
  // The check says the run's calls ran; a run that is all denied or cut short gets none.
  const glyph = row.state === 'running' ? 'running' : row.failed ? 'failed' : row.stopped ? 'stopped' : row.label ? 'done' : 'quiet';
  return (
    <div className="wmux-chatv2-tool" data-tool-group={row.count} data-enter={enter || undefined}>
      <Disclosure storeKey={row.key} forceOpen={findActive ? findId ?? row.key : null}>
        <summary className="wmux-chatv2-tool-line" data-run>
          <StatusGlyph state={glyph} />
          <span className="wmux-chatv2-tool-title">
            {row.label}
            {current && <>{row.label ? ' \u00b7 ' : ''}{current.verb} {current.object}</>}
          </span>
          {row.failed > 0 && <span className="wmux-chatv2-run-failed">{S.failedCount(row.failed)}</span>}
          {row.stopped > 0 && <span className="wmux-chatv2-run-stopped">{S.stoppedCount(row.stopped)}</span>}
          {row.denied > 0 && <span className="wmux-chatv2-run-stopped" data-denied>{S.deniedCount(row.denied)}</span>}
          <DiffStats additions={row.additions} deletions={row.deletions} />
          <Chevron />
        </summary>
        <div className="wmux-chatv2-group-rows">
          {row.rows.map((member) => (
            <TranscriptRowView key={member.key} row={member} cwd={cwd} actions={actions} inRun findActive={!!findId && rowHolds(member, findId)} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * What a sent message carried, above its bubble: an image as its picture (when
 * this window staged it and kept the thumbnail), anything else as a file chip.
 */
function SentAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="wmux-chatv2-sent-attachments" data-chatv2-sent-attachments>
      {attachments.map((item) => {
        const thumbnail = item.kind === 'image' ? attachmentThumbnail(item.path) : undefined;
        return thumbnail ? (
          <img key={item.id} className="wmux-chatv2-sent-image" src={thumbnail} alt={item.name} title={item.name} />
        ) : (
          <span key={item.id} className="wmux-chatv2-sent-file" title={item.path} data-kind={item.kind}>
            <IconFile size={12} />
            <span>{item.name}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Copy a text, saying so for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className="wmux-chatv2-icon" aria-label={copied ? S.copied : label} title={copied ? S.copied : label} data-chatv2-copy
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => undefined)}>
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

/** What a settled turn's line says: "Worked for 2m 14s", "Failed after 3s"… */
export function turnFoldLabel(row: Pick<TurnFoldRow, 'durationMs' | 'outcome'>): string {
  const elapsed = formatElapsed(row.durationMs);
  switch (row.outcome) {
    case 'failed': return elapsed ? S.failedAfter(elapsed) : S.failed;
    case 'interrupted': return elapsed ? S.interruptedAfter(elapsed) : S.interrupted;
    case 'usage-limited': return elapsed ? S.usageLimitedAfter(elapsed) : S.usageLimited;
    default: return elapsed ? S.workedFor(elapsed) : S.worked;
  }
}

/**
 * A settled turn's work behind one quiet line under its prompt. The line is
 * the turn's receipt: a muted check (a red cross when it failed), how long it
 * worked, and, on hover or focus, the model, the clock time and Copy for the
 * answer. Its rows mount only while it is open.
 */
function TurnFoldView({ row, cwd, actions, findId, findActive, enter }: { row: TurnFoldRow; cwd: string; actions: TranscriptActions; findId?: string | null; findActive: boolean; enter?: boolean }) {
  const [open, setOpen] = useFindOpen(row.key, findActive ? findId ?? row.key : null);
  const expandable = row.rows.length > 0;
  const endedAt = row.startedAt != null && row.durationMs != null ? row.startedAt + row.durationMs : null;
  const glyph = row.outcome === 'failed' ? 'failed' : row.outcome === 'interrupted' || row.outcome === 'usage-limited' ? 'quiet' : 'done';
  const label = (
    <>
      <StatusGlyph state={glyph} />
      <span>{turnFoldLabel(row)}</span>
      {row.failed > 0 && <span className="wmux-chatv2-run-failed">{S.failedCount(row.failed)}</span>}
      {expandable && <Chevron />}
    </>
  );
  const meta = [row.model, endedAt != null ? formatClockTime(endedAt) : ''].filter(Boolean).join(' \u00b7 ');
  return (
    <div className="wmux-chatv2-turn" data-turn-fold data-outcome={row.outcome} data-open={open || undefined} data-enter={enter || undefined}>
      <div className="wmux-chatv2-turn-bar">
        {expandable ? (
          <button type="button" className="wmux-chatv2-turn-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
        ) : (
          <span className="wmux-chatv2-turn-toggle">{label}</span>
        )}
        {meta && <span className="wmux-chatv2-turn-meta">{meta}</span>}
        {row.answer && <CopyButton text={row.answer} label={S.copyAnswer} />}
      </div>
      {open && expandable && (
        <div className="wmux-chatv2-turn-rows">
          {row.rows.map((member) => (
            <TranscriptRowView key={member.key} row={member} cwd={cwd} actions={actions}
              findActive={!!findId && rowHolds(member, findId)} findId={member.kind === 'toolGroup' ? findId : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function stepState(step: AgentStep): ToolState {
  if (step.status === 'failed' || step.status === 'cancelled') return 'failed';
  return step.status === 'completed' || step.kind !== 'tool' ? 'done' : 'running';
}

function SubagentRow({ block, state, actions, findActive, enter }: { block: Block; state: ToolState; actions: TranscriptActions; findActive: boolean; enter?: boolean }) {
  const run = block.agentRun!;
  const meta = [run.agentType, run.model && claudeModelLabel(run.model), S.steps(run.steps.length)].filter(Boolean).join(' · ');
  return (
    <div className="wmux-chatv2-subagent" data-block-id={block.id} data-find-active={findActive || undefined} data-enter={enter || undefined}>
      <Disclosure storeKey={block.id} forceOpen={findActive ? block.id : null}>
        <summary className="wmux-chatv2-tool-line">
          <StatusGlyph state={state} />
          <span className="wmux-chatv2-tool-title">{run.name || S.subagent}</span>
          <span className="wmux-chatv2-tool-summary">{meta}</span>
          <Chevron />
        </summary>
        <ol className="wmux-chatv2-steps">
          {run.steps.map((step) => (
            <li key={step.id} className="wmux-chatv2-tool-line" data-kind={step.kind}>
              {step.kind === 'tool' ? <StatusGlyph state={stepState(step)} /> : <span className="wmux-chatv2-glyph" aria-hidden><MarkIcon mark="step" /></span>}
              <span className="wmux-chatv2-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
      </Disclosure>
      {block.approval?.decided && <ApprovalCard block={block} onAnswer={actions.answer} />}
    </div>
  );
}

/** Live turns tick every second; finished ones show the stored duration and end time. */
function TurnFooter({ row, enter }: { row: Extract<TranscriptRow, { kind: 'footer' }>; enter?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!row.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [row.live]);
  const elapsed = row.live ? (row.startedAt != null ? Math.max(0, now - row.startedAt) : null) : row.durationMs ?? null;
  // A turn held on the owner says so, instead of reading as work going on.
  const label = row.live && row.waiting
    ? `${row.model} ${row.waiting === 'approval' ? S.turnWaitingApproval : S.turnWaitingAnswer}`
    : formatWorkingDuration(elapsed, row.model, !row.live);
  const endedAt = !row.live && row.startedAt != null && row.durationMs != null ? row.startedAt + row.durationMs : null;
  const outcome = row.outcome === 'interrupted' ? S.interrupted : row.outcome === 'failed' ? S.failed : row.outcome === 'usage-limited' ? S.usageLimited : null;
  return (
    <div className="wmux-chatv2-footer" data-live={row.live || undefined} data-waiting={(row.live && row.waiting) || undefined} data-enter={enter || undefined} aria-live={row.live ? 'off' : undefined}>
      {row.live && <span className="wmux-chatv2-live-dot" aria-hidden />}
      <span>{label}</span>
      {endedAt != null && <><span aria-hidden>·</span><span>{formatClockTime(endedAt)}</span></>}
      {outcome && <><span aria-hidden>·</span><span data-outcome={row.outcome}>{outcome}</span></>}
    </div>
  );
}

export const TranscriptRowView = memo(function TranscriptRowView({ row, cwd, actions, findActive, findId, enter, inRun }: {
  row: TranscriptRow;
  cwd: string;
  actions: TranscriptActions;
  findActive: boolean;
  /** The find match, for a group to mark the member it holds. */
  findId?: string | null;
  /** Appended after the view first loaded: fades in once. */
  enter?: boolean;
  /** A member of a tool run: its done check is the run's. */
  inRun?: boolean;
}) {
  const active = { 'data-find-active': findActive || undefined, 'data-enter': enter || undefined };
  const entering = { 'data-enter': enter || undefined };
  switch (row.kind) {
    case 'user':
      return (
        <>
          {!!row.block.attachments?.length && <SentAttachments attachments={row.block.attachments} />}
          {(row.block.text.trim() || !row.block.attachments?.length) && (
            <div className="wmux-chatv2-user" data-block-id={row.block.id} {...active}><CappedText block={row.block} actions={actions} render={(text) => text} /></div>
          )}
        </>
      );
    case 'assistant':
      return (
        <div className="wmux-chatv2-assistant" data-block-id={row.block.id} data-streaming={row.block.streaming || undefined} {...active}>
          <CappedText block={row.block} actions={actions} render={renderMarkdown} />
        </div>
      );
    case 'reasoning':
      return (
        <div data-block-id={row.block.id} {...entering}>
          <Disclosure storeKey={row.block.id} className="wmux-chatv2-reasoning" forceOpen={findActive ? row.block.id : null}>
            <summary>{row.block.streaming ? `${S.thinking}…` : S.thinking}</summary>
            <div className="wmux-chatv2-reasoning-body"><CappedText block={row.block} actions={actions} render={(text) => text} /></div>
          </Disclosure>
        </div>
      );
    case 'tool':
      return <ToolRow block={row.block} state={row.state} cwd={cwd} actions={actions} findActive={findActive} enter={enter} inRun={inRun} />;
    case 'toolGroup':
      return <ToolGroupView row={row} cwd={cwd} actions={actions} findId={findId} findActive={findActive} enter={enter} />;
    case 'turnFold':
      return <TurnFoldView row={row} cwd={cwd} actions={actions} findId={findId} findActive={findActive} enter={enter} />;
    case 'subagent':
      return <SubagentRow block={row.block} state={row.state} actions={actions} findActive={findActive} enter={enter} />;
    case 'tasks': {
      const list = row.block.taskList!;
      return (
        <div className="wmux-chatv2-tasks" data-block-id={row.block.id} {...active}>
          <span className="wmux-chatv2-tool-summary">{taskListProgressLabel(list.items)}</span>
          <ul>
            {list.items.map((item, index) => (
              <li key={item.id ?? index} data-status={item.status}>
                <span className="wmux-chatv2-glyph" aria-hidden><MarkIcon mark={TASK_MARK[item.status] ?? 'ring'} /></span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case 'plan':
      return <div className="wmux-chatv2-plan" data-block-id={row.block.id} {...active}><CappedText block={row.block} actions={actions} render={renderMarkdown} /></div>;
    case 'image':
      return <div className="wmux-chatv2-meta" data-block-id={row.block.id} {...entering}>{row.block.image?.name ?? row.block.text}</div>;
    case 'notice':
      if (row.tone === 'error') return <ErrorCard text={row.block.text} enter={enter} onRetry={actions.retryId === row.block.id ? actions.retry : undefined} />;
      return <div className="wmux-chatv2-notice" data-tone={row.tone} {...entering}>{row.block.text}</div>;
    case 'meta':
      return <div className="wmux-chatv2-meta" {...entering}>{row.block.text}</div>;
    case 'question':
      return <QuestionCard prompt={row.prompt} onAnswer={actions.answer} enter={enter} />;
    case 'footer':
      return <TurnFooter row={row} enter={enter} />;
  }
});
