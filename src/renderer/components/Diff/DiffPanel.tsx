// J2 — DiffPanel: 태스크 산출물 diff 리뷰·hunk 채택·코멘트 (스펙 §1·§3·§4)
//
// §6.J 문면 준수: "읽기·코멘트·체크아웃 3동작만 — 풀 IDE diff 에디터 금지."
// 파일 트리(numstat) + unified diff(+/- 색만) + hunk 체크박스 + 채택 버튼 +
// 실패 hunk 표시 + "적용됨"/"채택불가" 뱃지 + 코멘트 버튼.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  DiffHunk,
  DiffReadFile,
  DiffReadResult,
  DiffApplyRequest,
  DiffApplyResult,
  DiffTargetSnapshot,
} from '../../../shared/diffParse';
import type { ChannelMention } from '../../../shared/channels';
import { HUMAN_WORKSPACE_ID, CHANNEL_MENTIONS_MAX } from '../../../shared/channels';
import { commentAnchor, numberHunkLines, type DiffLine } from '../../../shared/prReview';
import { sanitizeRemoteText } from '../../../shared/a2aRemoteDelivery';
import { findLeaf } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { unwrapRpc } from '../../utils/unwrapRpc';
import { findWorkspaceSurfaceById } from '../../utils/paneTraversal';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';
import { HunkGutter, HunkLines } from './HunkLines';

// gpui button recipes (theme-safe color-mix on tokens; primary/danger keep the
// rgba sheen the DESIGN spec calls for). Reused across this panel's header.
const BTN_RAISED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--bg-surface)_72%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] hover:bg-[var(--bg-surface)] hover:border-[color-mix(in_srgb,var(--text-main)_16%,transparent)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.25)]';
const BTN_PRIMARY_WARM =
  'rounded-[5px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-highlight)_22%,transparent),0_1px_2px_rgba(0,0,0,0.3)] hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--text-main))] transition-colors';
const BTN_DANGER_TINTED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)] border-[color-mix(in_srgb,var(--accent-red)_32%,transparent)] text-[color-mix(in_srgb,var(--accent-red)_70%,var(--text-main))] hover:bg-[color-mix(in_srgb,var(--accent-red)_22%,transparent)]';

/**
 * diff 대상 유니온 — 기존 태스크 워크트리(J2, hunk 채택·코멘트·PR 포함)와
 * 워크스페이스 repo(읽기 전용: git diff HEAD + untracked)를 한 컴포넌트가
 * 렌더한다. fork 대신 유니온: diffParse 렌더·캡·truncated 로직의 이중화를 막는다.
 * 워크스페이스 모드는 task 결합부(미션채널 코멘트·채택·PR·close)를 전부 가드로
 * 끈다 — §6.J "읽기·코멘트·체크아웃 3동작" 계약 내의 순수 열람 표면.
 */
export type DiffPanelSource =
  | { kind: 'task'; taskId: string }
  | { kind: 'workspace'; repoPath: string };

interface DiffPanelProps {
  source: DiffPanelSource;
  isActive: boolean;
  /** Focus is on this tab. Defaults to `isActive`; differs in a pane's work
   *  area, where the tab stays drawn while focus is on the terminal beside it,
   *  so a workspace diff reloads when focus comes back to it. */
  focused?: boolean;
  surfaceId: string;
  /** 렌더러 신원 앵커(채널 포스트용). */
  verifiedWorkspaceId: string;
}

// 태스크 메타(task.mission.list에서 역참조).
interface TaskMeta {
  worktreePath: string;
  branch: string;
  missionChannelId: string;
  channelArchived: boolean;
  /** F11 — closed면 close/PR 버튼을 감춘다(worktree 제거됨·닫을 것 없음). */
  status: 'open' | 'closed';
  /** A detached task is closed but keeps its worktree — its diff is still live. */
  detached: boolean;
}

/** Which file a line comment points into: the new file (added or unchanged
 *  lines) or the old one (removed lines). */
export type DiffCommentSide = 'new' | 'old';

/** A line (or line range, `line`..`endLine`) on one side of a hunk. */
export interface DiffLineAnchor {
  side: DiffCommentSide;
  line: number;
  endLine?: number;
}

// F10 — diff 코멘트 역조회(미션 채널의 diff-comment 앵커 메시지).
// A comment without `line` is a hunk comment (every anchor posted before line
// comments existed carries `line: 0`).
export interface DiffComment {
  file: string;
  hunkHeader: string;
  side?: DiffCommentSide;
  line?: number;
  endLine?: number;
  author: string;
  text: string;
  postedAt: number;
  /** Set on a workspace review draft, which can be removed before it is sent. */
  draftId?: string;
}

const isLineNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// 채널 메시지에서 이 태스크의 diff-comment 앵커만 추출한다(§4 data.kind 매칭).
export function extractDiffComments(
  messages: Array<{ text?: string; memberName?: string; postedAt?: number; data?: unknown }>,
  taskId: string,
): DiffComment[] {
  const out: DiffComment[] = [];
  for (const m of messages) {
    const d = m.data as
      | { kind?: string; taskId?: string; file?: string; hunkHeader?: string; side?: unknown; line?: unknown; endLine?: unknown }
      | undefined;
    if (!d || d.kind !== 'diff-comment' || d.taskId !== taskId) continue;
    if (typeof d.file !== 'string') continue;
    // A positive line makes it a line comment; anything else stays a hunk comment.
    const line = isLineNumber(d.line) ? d.line : 0;
    const endLine = line && isLineNumber(d.endLine) && d.endLine > line ? d.endLine : undefined;
    out.push({
      file: d.file,
      hunkHeader: typeof d.hunkHeader === 'string' ? d.hunkHeader : '',
      ...(line ? { side: d.side === 'old' ? 'old' as const : 'new' as const, line, ...(endLine ? { endLine } : {}) } : {}),
      author: m.memberName ?? '(unknown)',
      text: m.text ?? '',
      postedAt: typeof m.postedAt === 'number' ? m.postedAt : 0,
    });
  }
  return out;
}

/** `12`, `12-15`, with ` (old)` for lines of the old file. */
export function formatLineRange(a: DiffLineAnchor): string {
  const range = a.endLine && a.endLine > a.line ? `${a.line}-${a.endLine}` : `${a.line}`;
  return a.side === 'old' ? `${range} (old)` : range;
}

/** The side and line a diff line takes a comment on, or null for a meta line. */
export function lineAnchorOf(line: DiffLine): { side: DiffCommentSide; line: number } | null {
  const a = commentAnchor(line);
  return a ? { side: a.side === 'LEFT' ? 'old' : 'new', line: a.line } : null;
}

/**
 * Where each comment on a file is drawn. A hunk comment sits under the hunk
 * whose header it names. A line comment sits under its last line, in the hunk
 * whose header it names, when that hunk still shows every end of its range on
 * its side. Anything else moved with the content and is listed under the file.
 */
export function placeDiffComments(
  file: { path: string; hunks: ReadonlyArray<Pick<DiffHunk, 'header' | 'oldStart' | 'newStart' | 'bodyLines'>> },
  comments: readonly DiffComment[],
): { byHunk: Map<string, DiffComment[]>; byLine: Map<string, DiffComment[]>; moved: DiffComment[] } {
  const shown = new Map<string, Set<string>>();
  for (const h of file.hunks) {
    const keys = new Set<string>();
    for (const l of numberHunkLines(h)) {
      const a = lineAnchorOf(l);
      if (a) keys.add(`${a.side}:${a.line}`);
    }
    shown.set(h.header, keys);
  }
  const byHunk = new Map<string, DiffComment[]>();
  const byLine = new Map<string, DiffComment[]>();
  const moved: DiffComment[] = [];
  const add = (map: Map<string, DiffComment[]>, key: string, c: DiffComment) => {
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  };
  for (const c of comments) {
    if (c.file !== file.path) continue;
    const keys = c.hunkHeader ? shown.get(c.hunkHeader) : undefined;
    if (!keys) {
      moved.push(c);
    } else if (!c.line) {
      add(byHunk, c.hunkHeader, c);
    } else {
      const side = c.side ?? 'new';
      const end = c.endLine ?? c.line;
      if (keys.has(`${side}:${c.line}`) && keys.has(`${side}:${end}`)) add(byLine, `${c.hunkHeader}\0${side}:${end}`, c);
      else moved.push(c);
    }
  }
  return { byHunk, byLine, moved };
}

/** One comment in a workspace review draft, not yet handed to the agent. */
export interface DiffReviewDraft {
  id: string;
  file: string;
  hunkHeader: string;
  /** Absent for a comment on the whole hunk. */
  anchor?: DiffLineAnchor;
  text: string;
  /** The first commented line's text, so a removed line still reads in the note. */
  snippet: string;
}

export const REVIEW_COMMENT_MAX = 1000;
export const REVIEW_SNIPPET_MAX = 120;

/** Control sequences stripped, whitespace collapsed to one line, capped in code points. */
function reviewLine(raw: string, max: number): string {
  const chars = Array.from(sanitizeRemoteText(raw).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * A workspace review draft as text for the agent. `multiline: false` is the
 * form typed into the agent's input line: ONE line, because outside bracketed
 * paste a newline submits the line (the browser hand-off follows the same
 * rule). The multi-line form is for the clipboard. Every field is stripped of
 * control sequences; the code snippet comes from the diff and is quoted as a
 * JSON string so it cannot read as the user's words.
 */
export function formatDiffReviewNote(
  repoPath: string,
  drafts: readonly DiffReviewDraft[],
  multiline: boolean,
): string {
  const repo = reviewLine(repoPath, 300);
  const items = drafts.map((d) => {
    const file = reviewLine(d.file, 300);
    const head = reviewLine(d.hunkHeader, DIFF_COMMENT_HEADER_MAX);
    const where = d.anchor ? `${file}:${formatLineRange(d.anchor)}` : head ? `${file} (hunk ${head})` : file;
    const snippet = d.anchor ? reviewLine(d.snippet, REVIEW_SNIPPET_MAX) : '';
    return { where, code: snippet ? JSON.stringify(snippet) : '', text: reviewLine(d.text, REVIEW_COMMENT_MAX) };
  });
  const intro = `Review comments on the uncommitted changes in ${repo}`;
  if (!multiline) {
    const body = items.map((it, i) => `(${i + 1}) ${it.where}${it.code ? ` at ${it.code}` : ''}: ${it.text}`).join(' · ');
    return `[diff review] ${intro}: ${body}`;
  }
  const body = items
    .map((it, i) => `${i + 1}. ${it.where}${it.code ? ` at ${it.code}` : ''}\n   ${it.text}`)
    .join('\n');
  return `${intro}:\n\n${body}\n`;
}

// J4 §S2 — diff 주석 포스트에 부착할 텍스트 앵커. CLI/MCP read가 data payload를
// 렌더하지 않아도 에이전트가 어느 파일·hunk에 대한 코멘트인지 본문만으로 알 수 있게
// 한다. hunkHeader는 text 쪽만 절단하고(data 앵커는 원형 유지 — extractDiffComments가
// 그걸 읽는다), 비어 있으면 `@ ...` 파트를 생략한다.
export const DIFF_COMMENT_HEADER_MAX = 80;

export function formatDiffCommentText(
  file: string,
  hunkHeader: string,
  comment: string,
  lineAnchor?: DiffLineAnchor,
): string {
  const head =
    hunkHeader.length > DIFF_COMMENT_HEADER_MAX
      ? hunkHeader.slice(0, DIFF_COMMENT_HEADER_MAX)
      : hunkHeader;
  // A line comment names its line(s) after the file: `a.ts:12-15 @ @@ ...`.
  const where = lineAnchor && lineAnchor.line > 0 ? `${file}:${formatLineRange(lineAnchor)}` : file;
  const anchor = head ? `[diff: ${where} @ ${head}]` : `[diff: ${where}]`;
  return `${anchor} ${comment}`;
}

/**
 * Which selected paths a reload has invalidated.
 *
 * A hunk index is a coordinate into one particular rendering of a file. The
 * panel keeps the selection across a manual reload on purpose, so a file whose
 * content moved underneath would otherwise carry ticks that now point at
 * different hunks — and, because the digest sent with an adoption used to be
 * read from the freshly loaded entry, main's integrity check would have agreed
 * with itself and let them through. A path is stale when the entry it was
 * ticked against is gone, or is no longer the entry we are holding.
 *
 * @param recorded  path -> the digest its hunks were ticked against
 * @param loaded    path -> the entry in the read we are now displaying
 */
export function staleSelectionPaths(
  recorded: Record<string, string>,
  loaded: Map<string, { digest: string }>,
): string[] {
  return Object.keys(recorded).filter((path) => loaded.get(path)?.digest !== recorded[path]);
}

// J4 §S1 — diff 주석 포스트의 자동 멘션 대상을 해석한다. 미션 채널 멤버 중 사람
// (HUMAN_WORKSPACE_ID)과 코멘터 자신(selfWorkspaceId — 미션 채널의 createdBy는 owner
// 워크스페이스라 항상 멤버다)을 제외한 나머지를 워크스페이스 단위로 하나씩 멘션한다.
//
// memberId를 붙이지 않는(=워크스페이스-레벨) 것이 의도적이다: 데몬의 mentionUnread
// 집계(ChannelService.unreadFor)는 memberId 없는 멘션을 그 워크스페이스의 모든 멤버
// 행에 대해 카운트하므로, 한 워크스페이스에 에이전트 팬이 여럿(예: 같은 WS의
// Claude+Codex)이어도 전원이 깨어난다. 반대로 memberId를 붙이면 post RPC의 dedup 키가
// (workspaceId, paneId)라 memberId만 다른 형제 멘션이 collapse되어 첫 행만 살아남고
// 나머지는 조용히 유실된다. CHANNEL_MENTIONS_MAX로 사전 절단한다(초과분은 post RPC가
// 어차피 CHANNEL_MENTIONS_TOO_MANY로 거부).
export function resolveDiffMentionTargets(
  members: ReadonlyArray<{ workspaceId?: string; memberId?: string; memberName?: string }>,
  selfWorkspaceId: string,
): ChannelMention[] {
  const byWorkspace = new Map<string, ChannelMention>();
  for (const m of members) {
    const workspaceId = typeof m.workspaceId === 'string' ? m.workspaceId : '';
    if (!workspaceId) continue;
    if (workspaceId === HUMAN_WORKSPACE_ID) continue;
    if (workspaceId === selfWorkspaceId) continue;
    if (byWorkspace.has(workspaceId)) continue;
    const memberId = typeof m.memberId === 'string' ? m.memberId : '';
    const name =
      typeof m.memberName === 'string' && m.memberName.length > 0
        ? m.memberName
        : memberId || workspaceId;
    byWorkspace.set(workspaceId, { workspaceId, name });
  }
  return [...byWorkspace.values()].slice(0, CHANNEL_MENTIONS_MAX);
}

// diff.read/applyHunks 브릿지(preload 노출).
interface DiffBridge {
  read: (
    worktreePath: string,
    targetHeadOid?: string,
    mode?: 'task' | 'workspace',
  ) => Promise<DiffReadResult | { ok: false; error: string }>;
  applyHunks: (req: DiffApplyRequest, worktreePath: string) => Promise<DiffApplyResult>;
}

function getDiffBridge(): DiffBridge | null {
  const api = (window as unknown as { electronAPI?: { diff?: DiffBridge } }).electronAPI;
  return api?.diff ?? null;
}

// task.mission.list로 taskId → 워크트리·채널 역참조.
async function resolveTaskMeta(taskId: string, verifiedWorkspaceId: string): Promise<TaskMeta | null> {
  const api = (window as unknown as {
    electronAPI?: { rpc?: { invoke: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
  }).electronAPI;
  if (!api?.rpc) return null;
  try {
    // rpc.invoke returns the `{ id, ok, result }` envelope; the task list is in `result`.
    const res = unwrapRpc(await api.rpc.invoke('task.mission.list', { verifiedWorkspaceId })) as {
      ok?: boolean;
      tasks?: Array<{
        id: string;
        status?: 'open' | 'closed';
        worktreePath?: string;
        branch?: string;
        missionChannelId?: string;
        detachedAt?: number;
      }>;
    };
    const task = res?.tasks?.find((t) => t.id === taskId);
    if (!task || !task.worktreePath) return null;
    // 채널 archived 여부(코멘트 버튼 게이팅). F9 fail-safe: 채널 get이 실패하면
    // archived=true로 간주해 코멘트를 비활성화한다 — 조회 불가 상태에서 코멘트
    // 발사를 허용하면 소실·아카이브된 채널에 헛발사할 수 있으므로 안전측으로 닫는다.
    let channelArchived = true;
    const channelId = task.missionChannelId ?? '';
    if (channelId) {
      try {
        const chRes = unwrapRpc(await api.rpc.invoke('a2a.channel.get', {
          verifiedWorkspaceId,
          channelId,
        })) as { ok?: boolean; channel?: { status?: string }; error?: unknown };
        // get 성공 시에만 실제 status를 신뢰. 그 외(ok:false·형태 미상)는 닫힘 유지.
        if (chRes && chRes.ok === true && chRes.channel) {
          channelArchived = chRes.channel.status === 'archived';
        }
      } catch {
        /* 조회 실패 → channelArchived=true 유지(코멘트 비활성) */
      }
    }
    return {
      worktreePath: task.worktreePath,
      branch: task.branch ?? '',
      missionChannelId: channelId,
      channelArchived,
      status: task.status === 'closed' ? 'closed' : 'open',
      detached: typeof task.detachedAt === 'number',
    };
  } catch {
    return null;
  }
}

// F10 — 미션 채널의 diff-comment 앵커를 역조회한다(§4 read RPC 재사용).
async function loadDiffComments(
  channelId: string,
  taskId: string,
  verifiedWorkspaceId: string,
): Promise<DiffComment[]> {
  if (!channelId) return [];
  const api = (window as unknown as {
    electronAPI?: { rpc?: { invoke: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
  }).electronAPI;
  if (!api?.rpc) return [];
  try {
    const res = unwrapRpc(await api.rpc.invoke('a2a.channel.getMessages', {
      verifiedWorkspaceId,
      channelId,
    })) as { ok?: boolean; messages?: Array<{ text?: string; memberName?: string; postedAt?: number; data?: unknown }> };
    if (!res || res.ok !== true || !Array.isArray(res.messages)) return [];
    return extractDiffComments(res.messages, taskId);
  } catch {
    return [];
  }
}

// 미션 채널 로스터 행(멘션 대상 해석 + 코멘터 자신의 sender 신원 파생에 쓰는 최소 필드).
interface MissionMemberRow {
  workspaceId: string;
  memberId: string;
  memberName?: string;
}

// J4 §S1 — 미션 채널 로스터를 조회한다. 기존 채널 멤버 read RPC(a2a.channel.getMembers)를
// 재사용 — loadDiffComments와 동일 트랜스포트·신원(verifiedWorkspaceId). 한 번 조회한
// 로스터에서 멘션 대상(resolveDiffMentionTargets)과 sender 자기-행(post 신원)을 함께
// 파생한다. 실패·비가시(사설 채널 비멤버 → 빈 로스터)는 빈 배열 → 멘션 없이 포스트하고
// (자기-행 없음 → post는 데몬 멤버십 게이트에서 실패하고 F9가 사유를 표면화).
async function loadMissionRoster(
  channelId: string,
  verifiedWorkspaceId: string,
): Promise<MissionMemberRow[]> {
  if (!channelId) return [];
  const api = (window as unknown as {
    electronAPI?: { rpc?: { invoke: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
  }).electronAPI;
  if (!api?.rpc) return [];
  try {
    const res = unwrapRpc(await api.rpc.invoke('a2a.channel.getMembers', {
      verifiedWorkspaceId,
      channelId,
    })) as {
      ok?: boolean;
      members?: Array<{ workspaceId?: string; memberId?: string; memberName?: string }>;
    };
    if (!res || res.ok !== true || !Array.isArray(res.members)) return [];
    const out: MissionMemberRow[] = [];
    for (const m of res.members) {
      if (typeof m.workspaceId !== 'string' || typeof m.memberId !== 'string') continue;
      out.push({
        workspaceId: m.workspaceId,
        memberId: m.memberId,
        ...(typeof m.memberName === 'string' ? { memberName: m.memberName } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// F10 — 코멘트 목록 렌더(작성자·본문·시각 — 최소).
// `bare` drops the list's own rule and fill: under a diff line the row it sits
// in already draws them (one boundary). `onRemove` offers removing a draft.
function CommentList({ comments, bare, onRemove, removeLabel }: {
  comments: DiffComment[];
  bare?: boolean;
  onRemove?: (draftId: string) => void;
  removeLabel?: string;
}) {
  if (comments.length === 0) return null;
  return (
    <div className={bare ? 'space-y-1' : 'px-2 py-1 border-t border-[var(--bg-mantle)] bg-[var(--bg-base)] space-y-1'}>
      {comments.map((c, i) => (
        <div key={c.draftId ?? i} className="text-[10px]" data-diff-comment={c.line ? formatLineRange({ side: c.side ?? 'new', line: c.line, endLine: c.endLine }) : 'hunk'}>
          <span className="text-[var(--text-main)] font-semibold">{c.author}</span>{' '}
          <span className="text-[var(--text-muted)]">
            {c.line ? `L${formatLineRange({ side: c.side ?? 'new', line: c.line, endLine: c.endLine })} ` : ''}
            {c.postedAt ? new Date(c.postedAt).toLocaleString() : ''}
          </span>
          {c.draftId && onRemove && (
            <button
              type="button"
              className={`ml-1 align-middle rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
              onClick={() => { if (c.draftId) onRemove(c.draftId); }}
              aria-label={removeLabel}
              title={removeLabel}
              data-testid="diff-review-remove"
            >
              <IconX size={10} />
            </button>
          )}
          <div className="text-[var(--text-sub)] whitespace-pre-wrap">{c.text}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * An agent owns this terminal now: one is recorded on it, and neither the
 * process tracker (it died) nor shell integration (the shell is back at its
 * prompt) says otherwise. A review note is a prompt for the agent; it must
 * never be typed into a bare shell.
 */
function agentOwnsPty(
  s: { surfaceAgent: Record<string, unknown>; agentAliveByPtyId: Record<string, boolean>; commandRunningByPtyId: Record<string, boolean> },
  ptyId: string,
): boolean {
  return !!s.surfaceAgent[ptyId] && s.agentAliveByPtyId[ptyId] !== false && s.commandRunningByPtyId[ptyId] !== false;
}

/** Where the open comment composer points: a hunk (`line` 0) or a line range in it. */
interface CommentTarget {
  /** `${path}#${hunkIndex}` */
  key: string;
  file: string;
  hunkHeader: string;
  side: DiffCommentSide;
  line: number;
  endLine?: number;
  snippet: string;
  /** The hunk's body when the composer opened: a reload that kept the header
   *  but changed the lines closes the composer (see the effect below). */
  hunkBody: string;
}

const hunkBodyOf = (hunk: Pick<DiffHunk, 'bodyLines'>): string => hunk.bodyLines.join('\n');

// 크롬 emoji 금지(DESIGN.md) — 코멘트 액션은 monochrome 말풍선 glyph.
function IconComment() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2 2.5h10a1 1 0 011 1v6a1 1 0 01-1 1H6l-3 2.5V10.5H2a1 1 0 01-1-1v-6a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function DiffPanel({ source, isActive, focused = isActive, surfaceId, verifiedWorkspaceId }: DiffPanelProps) {
  // source는 렌더마다 새 객체일 수 있으므로(호출부 인라인 구성) 원시값으로 분해해
  // load 콜백의 dep로 쓴다 — 객체 identity를 dep에 넣으면 매 렌더 refetch 루프.
  const isTask = source.kind === 'task';
  const taskId = source.kind === 'task' ? source.taskId : '';
  const repoPath = source.kind === 'workspace' ? source.repoPath : '';
  const [meta, setMeta] = useState<TaskMeta | null>(null);
  const [data, setData] = useState<DiffReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // path → 선택된 hunk index Set.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});
  /** The file fingerprint each path's hunks were ticked AGAINST. Recorded at
   *  selection time, not at adopt time: a reload deliberately keeps the
   *  selection (see `load`), so reading the digest off the freshly loaded entry
   *  would hand main a digest that always agrees with itself, and hunk indices
   *  picked from the previous content would silently adopt whatever now sits at
   *  those positions. That is the exact case this gate exists to refuse. */
  const [selectionDigest, setSelectionDigest] = useState<Record<string, string>>({});
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [failedProbes, setFailedProbes] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // F10: 미션 채널에서 역조회한 diff 코멘트.
  const [comments, setComments] = useState<DiffComment[]>([]);
  // Inline comment composer (replaces the dead window.prompt — see handleComment):
  // where the open composer points (its hunk, plus a line or range for a line
  // comment), and its draft text.
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [commentText, setCommentText] = useState('');
  // Workspace diff: comments wait here until they are handed to the agent as
  // one review note (there is no mission channel to post them to).
  const [reviewDraft, setReviewDraft] = useState<DiffReviewDraft[]>([]);
  const draftSeqRef = useRef(0);
  // J3 §1·§2: close·PR 진행 상태(중복 클릭 방지).
  const [lifecycleBusy, setLifecycleBusy] = useState<'close' | 'pr' | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const t = useT();

  // Bumped by every load() and by a successful Close. A load whose generation
  // is no longer current drops its results, so a read that was in flight when
  // Close succeeded cannot put back the 'open' meta or the removed hunks.
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    const superseded = () => gen !== loadGenRef.current;
    setLoading(true);
    setError(null);
    setApplyMsg(null);
    setFailedProbes(new Set());
    try {
      let readPath: string;
      if (isTask) {
        const m = await resolveTaskMeta(taskId, verifiedWorkspaceId);
        if (superseded()) return;
        if (!m) {
          setError(t('diff.taskNotFound'));
          setLoading(false);
          return;
        }
        setMeta(m);
        // A closed task's worktree has been removed: say so instead of reading a
        // path that no longer exists (and offering its stale hunks for adoption).
        if (m.status === 'closed' && !m.detached) {
          setData(null);
          setError(t('diff.taskClosed'));
          setLoading(false);
          return;
        }
        // F10: 코멘트 역조회(실패는 빈 목록 — diff 렌더는 막지 않음).
        const loadedComments = await loadDiffComments(m.missionChannelId, taskId, verifiedWorkspaceId);
        if (superseded()) return;
        setComments(loadedComments);
        readPath = m.worktreePath;
      } else {
        // 워크스페이스 모드 — 태스크 역참조·코멘트 없음. repoPath는 diff:resolveRepo가
        // 정규화한 worktree toplevel이다.
        readPath = repoPath;
      }
      const bridge = getDiffBridge();
      if (!bridge) {
        setError(t('diff.bridgeUnavailable'));
        setLoading(false);
        return;
      }
      // workspace 모드는 명시 전달 — 자기 HEAD 대비 미커밋만(본 repo 매핑 없음).
      // linked worktree에서 브랜치 커밋이 diff로 새는 것을 막는다(Codex P2).
      const res = await bridge.read(readPath, undefined, isTask ? 'task' : 'workspace');
      if (superseded()) return;
      if (!res.ok) {
        setError(res.error);
        setData(null);
      } else {
        setData(res);
        // Stay on the file being reviewed when it is still in the diff.
        if (res.files.length > 0) {
          setSelectedFile((prev) =>
            prev && res.files.some((f) => f.path === prev) ? prev : res.files[0].path,
          );
        }
      }
      setLoading(false);
    } catch (e) {
      // A rejected IPC call must not leave the panel on "Loading" or surface as
      // an unhandled rejection from the `void load()` callers.
      if (superseded()) return;
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      setLoading(false);
    }
  }, [isTask, taskId, repoPath, verifiedWorkspaceId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 워크스페이스 diff는 파생 데이터 — 탭 재활성화(비활성→활성 전이) 때 재읽기.
  // 태스크 모드는 기존 수동 Reload 계약 유지(채택 selection이 refetch로 날아가면 안 됨).
  const wasActiveRef = useRef(focused);
  useEffect(() => {
    if (!isTask && focused && !wasActiveRef.current) void load();
    wasActiveRef.current = focused;
  }, [focused, isTask, load]);

  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffReadFile>();
    for (const f of data?.files ?? []) map.set(f.path, f);
    return map;
  }, [data]);

  const toggleHunk = useCallback(
    (path: string, idx: number) => {
      const digest = filesByPath.get(path)?.digest ?? '';
      setSelection((prev) => {
        const next = { ...prev };
        const set = new Set(next[path] ?? []);
        if (set.has(idx)) set.delete(idx);
        else set.add(idx);
        next[path] = set;
        return next;
      });
      setSelectionDigest((prev) => (prev[path] === digest ? prev : { ...prev, [path]: digest }));
    },
    [filesByPath],
  );

  // A reload keeps the selection on purpose, but hunk INDICES only mean
  // something against the content they were picked from. So when a path's
  // fingerprint moves — the agent rewrote the file, or it left the diff
  // entirely — that path's ticks are dropped rather than carried onto content
  // the user has not seen. Paths that did not change keep theirs, which is the
  // behaviour the manual-reload contract is there for.
  useEffect(() => {
    if (!data) return;
    const stale = staleSelectionPaths(selectionDigest, filesByPath);
    if (stale.length === 0) return;
    setSelection((prev) => {
      const next = { ...prev };
      for (const p of stale) delete next[p];
      return next;
    });
    setSelectionDigest((prev) => {
      const next = { ...prev };
      for (const p of stale) delete next[p];
      return next;
    });
  }, [data, filesByPath, selectionDigest]);

  const selectedCount = useMemo(
    () => Object.values(selection).reduce((s, set) => s + set.size, 0),
    [selection],
  );

  const handleAdopt = useCallback(async () => {
    if (!meta || !data) return;
    const bridge = getDiffBridge();
    if (!bridge) return;
    // Each selection carries the fingerprint recorded when its hunks were
    // ticked — NOT the one on the entry we happen to be holding now. Reading it
    // fresh here would make the digest agree with itself by construction and
    // let indices picked from older content adopt whatever now sits at those
    // positions. A path with no recorded digest sends an empty one and is
    // rejected in main.
    const selections = Object.entries(selection)
      .filter(([, set]) => set.size > 0)
      .map(([path, set]) => ({
        path,
        hunkIndices: [...set].sort((a, b) => a - b),
        digest: selectionDigest[path] ?? '',
      }));
    if (selections.length === 0) {
      setApplyMsg(t('diff.noHunksSelected'));
      return;
    }
    setApplying(true);
    setApplyMsg(null);
    setFailedProbes(new Set());
    const snapshot: DiffTargetSnapshot = data.snapshot;
    const req: DiffApplyRequest = { taskId, snapshot, selections };
    let res: DiffApplyResult;
    try {
      res = await bridge.applyHunks(req, meta.worktreePath);
    } catch (e) {
      setApplying(false);
      setApplyMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    setApplying(false);
    if (res.ok) {
      const adoptedMsg = t('diff.adopted', { count: res.appliedFiles.length });
      // Adopting writes the target, not the task worktree, so the adopted hunks
      // are still in the reloaded diff with unchanged digests and the stale-
      // selection sweep would keep their ticks. Clear them so a second click
      // cannot re-apply the same hunks.
      setSelection({});
      setSelectionDigest({});
      // load() clears the message bar, so the confirmation goes up after it.
      // The adopt did land in the target even if this reload fails; load()
      // shows its own error in the panel body and never throws.
      await load();
      setApplyMsg(adoptedMsg);
    } else {
      if (res.code === 'probe' && res.failedProbes) {
        setFailedProbes(new Set(res.failedProbes.map((p) => `${p.path}#${p.hunkIndex}`)));
        setApplyMsg(t('diff.someHunksFailed'));
      } else if (res.code === 'stale') {
        // Refused without probing: mark the same hunks so the panel points at
        // them, and show the reason, which names the paths/hunks that moved.
        if (res.staleSelections) {
          setFailedProbes(new Set(res.staleSelections.map((s) => `${s.path}#${s.hunkIndex}`)));
        }
        setApplyMsg(res.error);
      } else if (res.code === 'drift') {
        setApplyMsg(t('diff.targetMoved'));
      } else if (res.code === 'dirty') {
        setApplyMsg(res.error);
      } else {
        setApplyMsg(res.error);
      }
    }
  }, [meta, data, selection, selectionDigest, taskId, load, t]);

  // 코멘트 발사(§4·J4): 미션 채널에 diff-comment 앵커 포스트(렌더러 channelLocal 경로).
  const handleComment = useCallback(
    async (target: CommentTarget) => {
      const { file, hunkHeader } = target;
      const lineAnchor: DiffLineAnchor | undefined = target.line > 0
        ? { side: target.side, line: target.line, ...(target.endLine ? { endLine: target.endLine } : {}) }
        : undefined;
      if (!isTask) {
        // Workspace diff: no channel to post to. The comment joins the review
        // draft, which goes to the agent as one note from the header.
        const comment = commentText.trim();
        if (!comment) return;
        setCommentTarget(null);
        setCommentText('');
        const draft: DiffReviewDraft = {
          id: `d${++draftSeqRef.current}`,
          file,
          hunkHeader,
          ...(lineAnchor ? { anchor: lineAnchor } : {}),
          text: comment,
          snippet: target.snippet,
        };
        setReviewDraft((prev) => [...prev, draft]);
        setApplyMsg(t('diff.reviewAdded'));
        return;
      }
      if (!meta || meta.channelArchived || !meta.missionChannelId) return;
      // Inline composer, not window.prompt: Electron's renderer has no prompt
      // polyfill and the call throws (dogfood-measured — the same dead path the
      // ask flow already replaced), so this comment feature never actually ran.
      const comment = commentText.trim();
      if (!comment) return;
      // Close the composer now (mirrors the ask form); the captured `comment`
      // drives the post below, so clearing the draft here is safe.
      setCommentTarget(null);
      setCommentText('');
      const api = (window as unknown as {
        electronAPI?: { rpc?: { mutateChannelLocal: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
      }).electronAPI;
      if (!api?.rpc) return;
      // 미션 채널 로스터를 한 번 조회해 멘션 대상과 sender 자기-행을 함께 파생한다.
      const roster = await loadMissionRoster(meta.missionChannelId, verifiedWorkspaceId);
      // J4 §S1: hunk에 코멘트를 다는 행위 자체가 "에이전트야 이거 반영해"이므로 미션
      // 채널의 태스크 에이전트(사람·자신 제외 멤버 전원)를 항상 멘션한다 — 이 멘션이
      // 기존 mention→wake 루프를 타고 에이전트를 깨워 피드백을 전달한다. 대상 0
      // (에이전트 전원 leave/kick)이면 멘션 없이 포스트한다(주석 기록 자체는 유효).
      const mentions = resolveDiffMentionTargets(roster, verifiedWorkspaceId);
      // sender 신원 = 코멘터 자신의 로스터 행. 데몬 post 게이트가 sender.workspaceId ===
      // verifiedWorkspaceId를 핀하고 비멤버를 거부하므로, 미션 채널의 owner(=diff owner
      // 워크스페이스, 항상 멤버)인 verifiedWorkspaceId로 sender를 구성한다. memberName은
      // 데몬이 로스터 행에서 재도출하므로 표시용 폴백일 뿐이다.
      const self = roster.find((m) => m.workspaceId === verifiedWorkspaceId);
      const sender = {
        workspaceId: verifiedWorkspaceId,
        memberId: self?.memberId ?? '',
        memberName: self?.memberName ?? self?.memberId ?? '',
      };
      // J4 §S2: 앵커를 본문에도 각인 — CLI/MCP read가 data를 렌더 안 해도 문맥이 남는다.
      const text = formatDiffCommentText(file, hunkHeader, comment, lineAnchor);
      // F9: post 실패(채널 소실·권한·IPC 오류)를 삼키지 않고 에러 메시지로 표면화.
      try {
        const res = (await api.rpc.mutateChannelLocal('a2a.channel.post', {
          verifiedWorkspaceId,
          channelId: meta.missionChannelId,
          // sender: 데몬 post는 sender(+ sender.workspaceId===verifiedWorkspaceId 핀)를
          // 요구한다. 이 필드가 없으면 NOT_AUTHORIZED로 거부된다(발견된 J2 갭 보강).
          sender,
          text,
          // data 앵커는 렌더러 인라인 매핑용 — hunkHeader는 원형 유지(§S2, text만 절단).
          // `line: 0` is a hunk comment; a line comment carries its side, line and range end.
          data: lineAnchor
            ? { kind: 'diff-comment', taskId, file, hunkHeader, ...lineAnchor }
            : { kind: 'diff-comment', taskId, file, hunkHeader, side: 'new', line: 0 },
          ...(mentions.length > 0 ? { mentions } : {}),
        })) as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false) {
          setApplyMsg(t('diff.commentFailed', { error: res.error ?? t('diff.unknownError') }));
          return;
        }
        setApplyMsg(t('diff.commentFired', { count: mentions.length }));
        // F10: 발사 직후 역조회 갱신 — 방금 단 코멘트가 인라인에 바로 뜬다.
        setComments(await loadDiffComments(meta.missionChannelId, taskId, verifiedWorkspaceId));
      } catch (e) {
        setApplyMsg(t('diff.commentFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [isTask, meta, taskId, verifiedWorkspaceId, commentText, t],
  );

  // A gutter click opens the composer on that line; a shift-click while a line
  // composer is open in the same hunk and side stretches it to a range.
  const placeLineComment = useCallback(
    (key: string, file: string, hunkHeader: string, hunkBody: string, line: DiffLine, extend: boolean) => {
      const a = lineAnchorOf(line);
      if (!a) return;
      setCommentTarget((prev) => {
        if (extend && prev && prev.key === key && prev.line > 0 && prev.side === a.side) {
          const lo = Math.min(prev.line, a.line);
          const hi = Math.max(prev.endLine ?? prev.line, a.line);
          return { ...prev, line: lo, ...(hi > lo ? { endLine: hi } : { endLine: undefined }), snippet: a.line < prev.line ? line.text : prev.snippet };
        }
        return { key, file, hunkHeader, hunkBody, side: a.side, line: a.line, snippet: line.text };
      });
    },
    [],
  );
  const lineComposerOpenAt = (key: string, line: DiffLine): boolean => {
    const a = lineAnchorOf(line);
    return !!a && commentTarget?.key === key && commentTarget.side === a.side && commentTarget.line === a.line && !commentTarget.endLine;
  };

  // Workspace review: the terminal the note goes to — the one in this diff's
  // pane running an agent (the shown terminal first). The note is a prompt for
  // the agent, never a command for a bare shell, so no agent means Copy only.
  // Resolved only while a draft exists, as a string key so the selector
  // re-renders this panel only when the answer changes.
  const reviewTargetKey = useStore((s) => {
    if (isTask || reviewDraft.length === 0) return '';
    for (const ws of s.workspaces) {
      const at = findWorkspaceSurfaceById(ws, surfaceId);
      if (!at) continue;
      const leaf = at.stashed ? null : findLeaf(ws.rootPane, at.paneId);
      if (!leaf) return '';
      const terminals = leaf.surfaces.filter((x) => !x.surfaceType || x.surfaceType === 'terminal');
      const shown = terminals.find((x) => x.id === leaf.activeSurfaceId);
      const pick = [shown, ...terminals].find((x) => !!x?.ptyId && agentOwnsPty(s, x.ptyId));
      return pick ? JSON.stringify([ws.id, leaf.id, pick.id, pick.ptyId, s.surfaceAgent[pick.ptyId].name]) : '';
    }
    return '';
  });
  const reviewTarget = reviewTargetKey
    ? (JSON.parse(reviewTargetKey) as [string, string, string, string, string])
    : null;

  const sendReview = useCallback(async () => {
    if (!reviewTarget || reviewDraft.length === 0) return;
    const [wsId, paneId, terminalSurfaceId, ptyId, agentName] = reviewTarget;
    // Checked again at the click: the agent may have exited since the last render.
    if (!agentOwnsPty(useStore.getState(), ptyId)) return;
    const sent = reviewDraft;
    try {
      // An invoke that resolves only once main handed the bytes to a live
      // session and rejects otherwise (pty.write is a fire-and-forget send,
      // so a dropped write would read as success and lose the draft). The
      // note is one sanitized line, so it is typed as-is, without Enter.
      await window.electronAPI.pty.writeLaunch(ptyId, formatDiffReviewNote(repoPath, sent, false), false);
    } catch (e) {
      // Main refused or the session is gone: keep the draft so it can be sent again or copied.
      setApplyMsg(t('diff.reviewSendFailed', { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    // Focus the terminal: the note sits in its input unsent until the user presses Enter.
    useStore.getState().setActiveSurface(paneId, terminalSurfaceId, wsId);
    setReviewDraft((prev) => prev.filter((d) => !sent.includes(d)));
    setApplyMsg(t('diff.reviewSent', { agent: agentName }));
  }, [reviewTarget, reviewDraft, repoPath, t]);

  const copyReview = useCallback(async () => {
    if (reviewDraft.length === 0) return;
    const count = reviewDraft.length;
    // Kept after a copy: the draft is only cleared once it reached an agent or was discarded.
    try {
      await window.clipboardAPI.writeText(formatDiffReviewNote(repoPath, reviewDraft, true));
      setApplyMsg(t('diff.reviewCopied', { count }));
    } catch {
      setApplyMsg(t('diff.reviewCopyFailed'));
    }
  }, [reviewDraft, repoPath, t]);

  // A reload that changed the hunk an open composer points at (its header, or
  // its lines under an unchanged header) closes it, so a comment is never sent
  // with an anchor or a quoted line taken from content no longer shown. The
  // typed text is kept for the next composer.
  useEffect(() => {
    if (!commentTarget) return;
    const idx = Number(commentTarget.key.slice(commentTarget.key.lastIndexOf('#') + 1));
    const hunk = filesByPath.get(commentTarget.file)?.hunks[idx];
    if (!hunk || hunk.header !== commentTarget.hunkHeader || hunkBodyOf(hunk) !== commentTarget.hunkBody) {
      setCommentTarget(null);
    }
  }, [filesByPath, commentTarget]);

  // J3 §1 — close(remove 성공→close 순서). 확인 1회 후 결과를 토스트로 구분
  // (dirty=보존/unpushed=경고+PR 제안/archivePending). main이 데몬 projection에서
  // 물질화 필드를 역참조하므로 taskId만 전달한다.
  const handleClose = useCallback(async () => {
    if (lifecycleBusy) return;
    const api = (window as unknown as { electronAPI?: { workTask?: import('../../../preload/preload').ElectronAPI['workTask'] } }).electronAPI;
    if (!api?.workTask) return;
    if (!window.confirm(t('diff.closeConfirm'))) return;
    setLifecycleBusy('close');
    try {
      const res = await api.workTask.close(taskId, verifiedWorkspaceId);
      if (res.ok) {
        // F11과 정합: close가 커밋됐으니 로컬 meta도 closed로 — PR/닫기 버튼이
        // 제거된 worktree를 상대로 다시 눌리지 않게 즉시 숨긴다.
        setMeta((m) => (m ? { ...m, status: 'closed', detached: false } : m));
        // The worktree is gone: drop its hunks and ticks so nothing can be
        // adopted from it, and discard any load still in flight.
        loadGenRef.current += 1;
        setLoading(false);
        setData(null);
        setSelection({});
        setSelectionDigest({});
        setApplyMsg(null);
        setError(t('diff.taskClosed'));
        // The daemon commits the close before task:close returns, so re-list the
        // owner's tasks now: otherwise the sidebar and Fleet keep showing this
        // task as open until the next 15 s mission poll. verifiedWorkspaceId is
        // the owner (see Pane.tsx); on a legacy surface without one it is the
        // task's own workspace, which owns no tasks, so the re-list is a no-op.
        void useStore.getState().refreshMissions(verifiedWorkspaceId);
        pushToast({
          level: res.archivePending ? 'warn' : 'info',
          message: res.unmaterialized
            ? t('diff.closedUnmaterialized')
            : res.archivePending
              ? t('diff.closedArchiveDeferred')
              : t('diff.closedFull'),
        });
      } else if (res.reason === 'dirty') {
        pushToast({
          level: 'warn',
          message: t('diff.closePreserved'),
        });
        // Right after an adopt the agent's edits are still uncommitted in the
        // worktree, so Close refuses. Keep the way out on screen (the toast
        // times out): discard them there, or commit and open a PR.
        const preserved = res.preservedWorktree ?? meta?.worktreePath;
        if (preserved) setApplyMsg(t('diff.closePreservedAt', { path: preserved }));
      } else if (res.reason === 'unpushed') {
        pushToast({
          level: 'warn',
          message: t('diff.closeUnpushed', { count: res.aheadCount ?? '' }),
        });
      } else {
        pushToast({ level: 'error', message: t('diff.closeFailed', { error: res.error ?? '' }) });
      }
    } catch (e) {
      pushToast({ level: 'error', message: t('diff.closeFailed', { error: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setLifecycleBusy(null);
    }
  }, [lifecycleBusy, taskId, verifiedWorkspaceId, meta, pushToast, t]);

  // J3 §2 — 1클릭 PR(확인 1회 포함). gh 4중 게이트·멱등 재진입은 main이 수행.
  const handleCreatePr = useCallback(async () => {
    if (lifecycleBusy) return;
    const api = (window as unknown as { electronAPI?: { workTask?: import('../../../preload/preload').ElectronAPI['workTask'] } }).electronAPI;
    if (!api?.workTask) return;
    const branchHint = meta?.branch ? `\n${t('diff.branchLine', { branch: meta.branch })}` : '';
    if (
      !window.confirm(
        t('diff.prConfirm', { branchHint }),
      )
    ) {
      return;
    }
    setLifecycleBusy('pr');
    try {
      const res = await api.workTask.createPr(taskId, verifiedWorkspaceId);
      if (res.ok) {
        pushToast({
          level: res.commitPending ? 'warn' : 'info',
          message: res.recovered
            ? t('diff.prRecovered', { url: res.prUrl ?? '' })
            : t('diff.prCreated', { url: res.prUrl ?? '' }) + (res.commitPending ? t('diff.prUrlPending') : ''),
          action: { label: t('diff.openPr'), onClick: () => window.open(res.prUrl, '_blank') },
        });
      } else if (res.reason === 'gh-missing' || res.reason === 'gh-unauth') {
        pushToast({ level: 'warn', message: `${res.error}${res.browseFallback ? ` — ${res.browseFallback}` : ''}` });
      } else if (res.reason === 'dirty') {
        pushToast({ level: 'warn', message: res.error });
      } else {
        pushToast({ level: 'error', message: t('diff.prFailed', { error: res.error ?? '' }) });
      }
    } catch (e) {
      pushToast({ level: 'error', message: t('diff.prFailed', { error: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setLifecycleBusy(null);
    }
  }, [lifecycleBusy, taskId, verifiedWorkspaceId, meta, pushToast, t]);

  const activeFile = selectedFile ? filesByPath.get(selectedFile) : null;

  // 파일 트리에 보일 경로 목록 — 파싱된 files + numstat에만 있는 경로(untracked
  // 바이너리·대형·symlink 등 표시 전용). files가 비어도 이런 변경이 있으면
  // "clean"이 아니며 트리에 표시돼야 한다(Codex P2 — hidden change 오판 방지).
  const displayPaths = useMemo(() => {
    if (!data) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of data.files) {
      if (!seen.has(f.path)) { seen.add(f.path); out.push(f.path); }
    }
    for (const n of data.numstat) {
      if (!seen.has(n.path)) { seen.add(n.path); out.push(n.path); }
    }
    return out;
  }, [data]);
  const hasAnyChange = displayPaths.length > 0;

  // F10 — 활성 파일의 코멘트를 hunkHeader별로 그룹핑. 현재 diff의 hunk 헤더와
  // 일치하는 코멘트는 해당 hunk 아래, 불일치분(라인 드리프트로 헤더가 바뀐 것)은
  // 파일 하단 "위치 이동됨" 그룹으로 강등. A line comment sits under its line
  // (see placeDiffComments). A workspace diff shows its unsent review draft.
  const draftAuthor = t('diff.reviewDraftAuthor');
  const shownComments = useMemo<DiffComment[]>(
    () =>
      isTask
        ? comments
        : reviewDraft.map((d) => ({
          file: d.file,
          hunkHeader: d.hunkHeader,
          ...(d.anchor ?? {}),
          author: draftAuthor,
          text: d.text,
          postedAt: 0,
          draftId: d.id,
        })),
    [isTask, comments, reviewDraft, draftAuthor],
  );
  const fileComments = useMemo(() => {
    if (!activeFile) {
      return { byHunk: new Map<string, DiffComment[]>(), byLine: new Map<string, DiffComment[]>(), moved: [] as DiffComment[] };
    }
    return placeDiffComments(activeFile, shownComments);
  }, [activeFile, shownComments]);
  const removeDraft = useCallback((id: string) => setReviewDraft((prev) => prev.filter((d) => d.id !== id)), []);
  // Comments can be written: a task's open mission channel, or any workspace diff.
  const canComment = isTask ? !!meta && !meta.channelArchived && !!meta.missionChannelId : true;

  // The composer under a hunk header (hunk comment) or under a line (line comment).
  const renderComposer = (target: CommentTarget, underLine: boolean) => {
    const where = target.line > 0
      ? `${target.file}:${formatLineRange({ side: target.side, line: target.line, endLine: target.endLine })}`
      : target.file;
    return (
      <div
        className={underLine
          ? 'flex items-center gap-1.5'
          : 'flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-base)] border-t border-[var(--bg-mantle)]'}
        data-diff-comment-form
      >
        <input
          type="text"
          autoFocus
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => {
            // IME 조합 중 Enter(한/일/중)는 조합 확정이지 제출이 아님 —
            // isComposing/keyCode 229를 가드(ask 폼과 동일).
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              void handleComment(target);
            } else if (e.key === 'Escape') {
              setCommentTarget(null);
              setCommentText('');
            }
          }}
          placeholder={t('diff.commentPrompt', { file: where })}
          spellCheck={false}
          {...(isTask ? {} : { maxLength: REVIEW_COMMENT_MAX })}
          className="flex-1 min-w-0 bg-transparent text-[11px] text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none px-1"
          data-testid="diff-comment-input"
        />
        <button
          className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)] disabled:opacity-40"
          disabled={!commentText.trim()}
          onClick={() => void handleComment(target)}
          data-testid="diff-comment-submit"
        >
          {isTask ? t('diff.commentSend') || 'Comment' : t('diff.reviewAdd')}
        </button>
      </div>
    );
  };

  return (
    <div
      className="absolute inset-0 flex flex-col bg-[var(--bg-base)]"
      style={{ display: isActive ? 'flex' : 'none' }}
      data-surface-id={surfaceId}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--bg-mantle)] shrink-0 text-xs">
        <span className="text-[var(--text-main)] font-semibold">{t('diff.title')}</span>
        {meta && <span className="text-[var(--text-muted)] text-[10px]">{meta.branch}</span>}
        {/* 워크스페이스 모드 — 브랜치는 스냅샷에서(태스크 meta 없음). */}
        {!isTask && data && (
          <span className="text-[var(--text-muted)] text-[10px]">{data.snapshot.targetBranch}</span>
        )}
        <div className="flex-1" />
        <button
          className={`px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${BTN_RAISED}`}
          onClick={() => void load()}
        >
          {t('diff.reload')}
        </button>
        {/* Workspace review draft: drawn only while it holds a comment. Send
            types the note into the agent's input (unsent); without an agent
            terminal in this pane, Copy is the action. */}
        {!isTask && reviewDraft.length > 0 && (
          <>
            <button
              className={`px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${BTN_RAISED}`}
              onClick={() => { setReviewDraft([]); setApplyMsg(null); }}
              data-testid="diff-review-discard"
            >
              {t('diff.reviewDiscard')}
            </button>
            <button
              className={reviewTarget
                ? `px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${BTN_RAISED}`
                : `px-2 py-0.5 text-[10px] ${BTN_PRIMARY_WARM}`}
              onClick={() => void copyReview()}
              title={t('diff.reviewCopyTitle')}
              data-testid="diff-review-copy"
            >
              {reviewTarget ? t('diff.reviewCopy') : t('diff.reviewCopyCount', { count: reviewDraft.length })}
            </button>
            {reviewTarget && (
              <button
                className={`px-2 py-0.5 text-[10px] ${BTN_PRIMARY_WARM}`}
                onClick={() => void sendReview()}
                title={t('diff.reviewSendTitle')}
                data-testid="diff-review-send"
              >
                {t('diff.reviewSend', { agent: reviewTarget[4], count: reviewDraft.length })}
              </button>
            )}
          </>
        )}
        {/* 채택은 태스크 모드 전용 — 워크스페이스 모드는 repo 자신 대상이라 무의미(읽기 전용). */}
        {isTask && !(meta?.status === 'closed' && !meta.detached) && (
          <button
            className={`px-2 py-0.5 text-[10px] ${BTN_PRIMARY_WARM} disabled:opacity-40`}
            onClick={() => void handleAdopt()}
            data-testid="diff-adopt"
            disabled={applying || selectedCount === 0}
            title={t('diff.adoptTitle')}
          >
            {applying ? t('diff.adopting') : t('diff.adopt', { count: selectedCount })}
          </button>
        )}
        {/* J3 §2·§1 — 1클릭 PR·close. F11: closed 태스크에선 숨긴다(worktree 제거됨). */}
        {meta && meta.status !== 'closed' && (
          <>
            <button
              className={`px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${BTN_RAISED} disabled:opacity-40`}
              onClick={() => void handleCreatePr()}
              disabled={lifecycleBusy !== null}
              title={t('diff.prTitle')}
            >
              {lifecycleBusy === 'pr' ? t('diff.prBusy') : 'PR'}
            </button>
            <button
              className={`px-2 py-0.5 text-[10px] ${BTN_DANGER_TINTED} disabled:opacity-40`}
              onClick={() => void handleClose()}
              disabled={lifecycleBusy !== null}
              title={t('diff.closeTitle')}
            >
              {lifecycleBusy === 'close' ? t('diff.closing') : t('diff.close')}
            </button>
          </>
        )}
      </div>

      {applyMsg && (
        <div className="px-3 py-1 text-[11px] text-[var(--text-sub)] bg-[var(--bg-mantle)] border-b border-[var(--bg-mantle)] shrink-0">
          {applyMsg}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center w-full text-[var(--text-muted)] text-sm">
            {t('diff.loading')}
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center w-full text-[var(--text-muted)] text-sm">
            {error}
          </div>
        )}
        {!loading && !error && data && !hasAnyChange && (
          <div className="flex items-center justify-center w-full text-[var(--text-muted)] text-sm">
            {t('diff.noChanges')}
          </div>
        )}
        {!loading && !error && data && hasAnyChange && (
          <>
            {/* 파일 트리(numstat) — files + numstat-only(표시 전용) 경로 union. */}
            <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--bg-mantle)] text-[11px]">
              {displayPaths.map((path) => {
                const f = filesByPath.get(path);
                const num = data.numstat.find((n) => n.path === path);
                const isTrunc = data.truncated.includes(path);
                const isUnsupported = (data.unsupported ?? []).includes(path);
                // numstat에만 있는 경로(파싱된 file 없음) = 바이너리·대형·symlink 등
                // 표시 전용. 클릭해도 hunk가 없어 "표시 전용" 안내가 뜬다.
                return (
                  <button
                    key={path}
                    className={`w-full text-left px-2 py-1 truncate hover:bg-[var(--bg-mantle)] ${
                      selectedFile === path ? 'bg-[var(--bg-mantle)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'
                    }`}
                    onClick={() => setSelectedFile(path)}
                    title={path}
                  >
                    <span className="truncate">{path}</span>
                    {num && (
                      <span className="ml-1 text-[10px]">
                        <span className="text-[var(--accent-green)]">+{num.additions ?? '?'}</span>{' '}
                        <span className="text-[var(--accent-red)]">-{num.deletions ?? '?'}</span>
                      </span>
                    )}
                    {f && !f.hunkSelectable && (
                      <span className="ml-1 text-[10px] text-[var(--text-muted)]">[{f.kind}·{t('diff.nonAdoptable')}]</span>
                    )}
                    {(isTrunc || isUnsupported || !f) && (
                      <span className="ml-1 text-[10px] text-[var(--text-muted)]">[{t('diff.displayOnlyTag')}]</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* unified diff 뷰 + hunk 체크박스 */}
            <div className="flex-1 overflow-auto p-2">
              {!activeFile && selectedFile && (
                <div className="text-[var(--text-muted)] text-xs">
                  {t('diff.displayOnly')}
                </div>
              )}
              {!activeFile && !selectedFile && (
                <div className="text-[var(--text-muted)] text-sm">{t('diff.selectFile')}</div>
              )}
              {activeFile && activeFile.hunks.length === 0 && (
                <div className="text-[var(--text-muted)] text-xs">
                  {activeFile.kind} {t('diff.displayOnlySuffix')}
                </div>
              )}
              {activeFile &&
                activeFile.hunks.map((hunk, idx) => {
                  const key = `${activeFile.path}#${idx}`;
                  const checked = selection[activeFile.path]?.has(idx) ?? false;
                  const failed = failedProbes.has(key);
                  return (
                    <div key={idx} className="mb-2 border border-[var(--bg-mantle)] rounded overflow-hidden">
                      <div className="flex items-center gap-2 px-2 py-1 bg-[var(--bg-surface)] text-[10px]">
                        {isTask && activeFile.hunkSelectable && (
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleHunk(activeFile.path, idx)}
                            title={t('diff.selectHunk')}
                          />
                        )}
                        <span className="font-mono text-[var(--text-sub)] truncate">{hunk.header}</span>
                        {failed && (
                          <span className="text-[10px] text-[var(--accent-red)]">{t('diff.nonAdoptable')}</span>
                        )}
                        <div className="flex-1" />
                        {canComment && (
                          <button
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                            onClick={() => {
                              setCommentText('');
                              setCommentTarget((prev) =>
                                prev?.key === key && prev.line === 0
                                  ? null
                                  : { key, file: activeFile.path, hunkHeader: hunk.header, hunkBody: hunkBodyOf(hunk), side: 'new', line: 0, snippet: '' },
                              );
                            }}
                            title={t('diff.commentHunk')}
                            data-testid="diff-comment-open"
                          >
                            <IconComment />
                          </button>
                        )}
                        {meta?.channelArchived && (
                          <span className="text-[10px] text-[var(--text-muted)]" title={t('diff.channelArchived')}>
                            {t('diff.commentDisabled')}
                          </span>
                        )}
                      </div>
                      {/* 인라인 코멘트 폼 — Enter 발사, Esc 닫기 (죽은 window.prompt 대체). */}
                      {commentTarget?.key === key && commentTarget.line === 0 && renderComposer(commentTarget, false)}
                      <div className="px-2 py-1">
                        {/* Numbered lines: a line number is the button that comments on that line. */}
                        <HunkLines
                          bodyLines={hunk.bodyLines}
                          numbered={{ oldStart: hunk.oldStart, newStart: hunk.newStart }}
                          gutter={(line) => {
                            const a = lineAnchorOf(line);
                            if (!a || !canComment) return <HunkGutter line={line} />;
                            const range = formatLineRange(a);
                            return (
                              <button
                                type="button"
                                className={`wmux-hunk-gutter-btn ${FOCUS_RING}`}
                                onClick={(e) => {
                                  // A second click on the open line closes its composer and its text.
                                  if (!e.shiftKey && lineComposerOpenAt(key, line)) {
                                    setCommentTarget(null);
                                    setCommentText('');
                                    return;
                                  }
                                  placeLineComment(key, activeFile.path, hunk.header, hunkBodyOf(hunk), line, e.shiftKey);
                                }}
                                aria-label={t('diff.commentLine', { file: activeFile.path, line: range })}
                                title={t('diff.commentLineTitle')}
                                data-testid="diff-line-comment"
                                data-line-comment={`${a.side}:${a.line}`}
                              >
                                <HunkGutter line={line} />
                              </button>
                            );
                          }}
                          below={(line) => {
                            const a = lineAnchorOf(line);
                            if (!a) return null;
                            const here = fileComments.byLine.get(`${hunk.header}\0${a.side}:${a.line}`) ?? [];
                            const composing =
                              commentTarget?.key === key &&
                              commentTarget.line > 0 &&
                              commentTarget.side === a.side &&
                              (commentTarget.endLine ?? commentTarget.line) === a.line;
                            if (here.length === 0 && !composing) return null;
                            return (
                              <>
                                <CommentList comments={here} bare onRemove={removeDraft} removeLabel={t('diff.reviewRemove')} />
                                {composing && renderComposer(commentTarget, true)}
                              </>
                            );
                          }}
                        />
                      </div>
                      {/* F10: 이 hunk 헤더에 매칭된 코멘트 인라인 표시. */}
                      <CommentList comments={fileComments.byHunk.get(hunk.header) ?? []} onRemove={removeDraft} removeLabel={t('diff.reviewRemove')} />
                    </div>
                  );
                })}
              {/* F10: hunkHeader 불일치(위치 이동됨) 코멘트 그룹 — 파일 하단. */}
              {activeFile && fileComments.moved.length > 0 && (
                <div className="mb-2 border border-[var(--accent-red)] rounded overflow-hidden">
                  <div className="px-2 py-1 bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]">
                    {t('diff.commentMoved', { count: fileComments.moved.length })}
                  </div>
                  <CommentList comments={fileComments.moved} onRemove={removeDraft} removeLabel={t('diff.reviewRemove')} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
