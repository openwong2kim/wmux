// J2 — DiffPanel: 태스크 산출물 diff 리뷰·hunk 채택·코멘트 (스펙 §1·§3·§4)
//
// §6.J 문면 준수: "읽기·코멘트·체크아웃 3동작만 — 풀 IDE diff 에디터 금지."
// 파일 트리(numstat) + unified diff(+/- 색만) + hunk 체크박스 + 채택 버튼 +
// 실패 hunk 표시 + "적용됨"/"채택불가" 뱃지 + 코멘트 버튼.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  DiffFile,
  DiffReadResult,
  DiffApplyRequest,
  DiffApplyResult,
  DiffTargetSnapshot,
} from '../../../shared/diffParse';
import type { ChannelMention } from '../../../shared/channels';
import { HUMAN_WORKSPACE_ID, CHANNEL_MENTIONS_MAX } from '../../../shared/channels';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { buildDiffAskContext } from '../../../shared/diffAskContext';

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
}

// F10 — diff 코멘트 역조회(미션 채널의 diff-comment 앵커 메시지).
interface DiffComment {
  file: string;
  hunkHeader: string;
  author: string;
  text: string;
  postedAt: number;
}

// 채널 메시지에서 이 태스크의 diff-comment 앵커만 추출한다(§4 data.kind 매칭).
export function extractDiffComments(
  messages: Array<{ text?: string; memberName?: string; postedAt?: number; data?: unknown }>,
  taskId: string,
): DiffComment[] {
  const out: DiffComment[] = [];
  for (const m of messages) {
    const d = m.data as
      | { kind?: string; taskId?: string; file?: string; hunkHeader?: string }
      | undefined;
    if (!d || d.kind !== 'diff-comment' || d.taskId !== taskId) continue;
    if (typeof d.file !== 'string') continue;
    out.push({
      file: d.file,
      hunkHeader: typeof d.hunkHeader === 'string' ? d.hunkHeader : '',
      author: m.memberName ?? '(unknown)',
      text: m.text ?? '',
      postedAt: typeof m.postedAt === 'number' ? m.postedAt : 0,
    });
  }
  return out;
}

// J4 §S2 — diff 주석 포스트에 부착할 텍스트 앵커. CLI/MCP read가 data payload를
// 렌더하지 않아도 에이전트가 어느 파일·hunk에 대한 코멘트인지 본문만으로 알 수 있게
// 한다. hunkHeader는 text 쪽만 절단하고(data 앵커는 원형 유지 — extractDiffComments가
// 그걸 읽는다), 비어 있으면 `@ ...` 파트를 생략한다.
export const DIFF_COMMENT_HEADER_MAX = 80;

export function formatDiffCommentText(file: string, hunkHeader: string, comment: string): string {
  const head =
    hunkHeader.length > DIFF_COMMENT_HEADER_MAX
      ? hunkHeader.slice(0, DIFF_COMMENT_HEADER_MAX)
      : hunkHeader;
  const anchor = head ? `[diff: ${file} @ ${head}]` : `[diff: ${file}]`;
  return `${anchor} ${comment}`;
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
    const res = (await api.rpc.invoke('task.mission.list', { verifiedWorkspaceId })) as {
      ok?: boolean;
      tasks?: Array<{
        id: string;
        status?: 'open' | 'closed';
        worktreePath?: string;
        branch?: string;
        missionChannelId?: string;
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
        const chRes = (await api.rpc.invoke('a2a.channel.get', {
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
    const res = (await api.rpc.invoke('a2a.channel.getMessages', {
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
    const res = (await api.rpc.invoke('a2a.channel.getMembers', {
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
function CommentList({ comments }: { comments: DiffComment[] }) {
  if (comments.length === 0) return null;
  return (
    <div className="px-2 py-1 border-t border-[var(--bg-mantle)] bg-[var(--bg-base)] space-y-1">
      {comments.map((c, i) => (
        <div key={i} className="text-[10px]">
          <span className="text-[var(--text-main)] font-semibold">{c.author}</span>{' '}
          <span className="text-[var(--text-muted)]">
            {c.postedAt ? new Date(c.postedAt).toLocaleString() : ''}
          </span>
          <div className="text-[var(--text-sub)] whitespace-pre-wrap">{c.text}</div>
        </div>
      ))}
    </div>
  );
}

// hunk 라인에 +/- 색만 입힌다(신택스 하이라이팅 금지 — 비목표).
function HunkBody({ bodyLines }: { bodyLines: readonly string[] }) {
  return (
    <div className="font-mono text-[11px] leading-[1.5] whitespace-pre overflow-x-auto">
      {bodyLines.map((line, i) => {
        const c = line.charAt(0);
        const color =
          c === '+'
            ? 'text-[var(--accent-green,#4ade80)]'
            : c === '-'
              ? 'text-[var(--accent-red,#f87171)]'
              : 'text-[var(--text-sub)]';
        return (
          <div key={i} className={color}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

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

export default function DiffPanel({ source, isActive, surfaceId, verifiedWorkspaceId }: DiffPanelProps) {
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
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [failedProbes, setFailedProbes] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // F10: 미션 채널에서 역조회한 diff 코멘트.
  const [comments, setComments] = useState<DiffComment[]>([]);
  // J3 §1·§2: close·PR 진행 상태(중복 클릭 방지).
  const [lifecycleBusy, setLifecycleBusy] = useState<'close' | 'pr' | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const t = useT();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApplyMsg(null);
    setFailedProbes(new Set());
    let readPath: string;
    if (isTask) {
      const m = await resolveTaskMeta(taskId, verifiedWorkspaceId);
      if (!m) {
        setError(t('diff.taskNotFound'));
        setLoading(false);
        return;
      }
      setMeta(m);
      // F10: 코멘트 역조회(실패는 빈 목록 — diff 렌더는 막지 않음).
      setComments(await loadDiffComments(m.missionChannelId, taskId, verifiedWorkspaceId));
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
    if (!res.ok) {
      setError(res.error);
      setData(null);
    } else {
      setData(res);
      if (res.files.length > 0) setSelectedFile(res.files[0].path);
    }
    setLoading(false);
  }, [isTask, taskId, repoPath, verifiedWorkspaceId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 워크스페이스 diff는 파생 데이터 — 탭 재활성화(비활성→활성 전이) 때 재읽기.
  // 태스크 모드는 기존 수동 Reload 계약 유지(채택 selection이 refetch로 날아가면 안 됨).
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!isTask && isActive && !wasActiveRef.current) void load();
    wasActiveRef.current = isActive;
  }, [isActive, isTask, load]);

  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffFile>();
    for (const f of data?.files ?? []) map.set(f.path, f);
    return map;
  }, [data]);

  const toggleHunk = useCallback((path: string, idx: number) => {
    setSelection((prev) => {
      const next = { ...prev };
      const set = new Set(next[path] ?? []);
      if (set.has(idx)) set.delete(idx);
      else set.add(idx);
      next[path] = set;
      return next;
    });
  }, []);

  const selectedCount = useMemo(
    () => Object.values(selection).reduce((s, set) => s + set.size, 0),
    [selection],
  );

  const handleAdopt = useCallback(async () => {
    if (!meta || !data) return;
    const bridge = getDiffBridge();
    if (!bridge) return;
    const selections = Object.entries(selection)
      .filter(([, set]) => set.size > 0)
      .map(([path, set]) => ({ path, hunkIndices: [...set].sort((a, b) => a - b) }));
    if (selections.length === 0) {
      setApplyMsg(t('diff.noHunksSelected'));
      return;
    }
    setApplying(true);
    setApplyMsg(null);
    setFailedProbes(new Set());
    const snapshot: DiffTargetSnapshot = data.snapshot;
    const req: DiffApplyRequest = { taskId, snapshot, selections };
    const res = await bridge.applyHunks(req, meta.worktreePath);
    setApplying(false);
    if (res.ok) {
      setApplyMsg(t('diff.adopted', { count: res.appliedFiles.length }));
      // 재열람: 채택분은 여전히 태스크 worktree diff에 보이며 "적용됨" 뱃지로 표시됨.
      void load();
    } else {
      if (res.code === 'probe' && res.failedProbes) {
        setFailedProbes(new Set(res.failedProbes.map((p) => `${p.path}#${p.hunkIndex}`)));
        setApplyMsg(t('diff.someHunksFailed'));
      } else if (res.code === 'drift') {
        setApplyMsg(t('diff.targetMoved'));
      } else if (res.code === 'dirty') {
        setApplyMsg(res.error);
      } else {
        setApplyMsg(res.error);
      }
    }
  }, [meta, data, selection, taskId, load, t]);

  // 코멘트 발사(§4·J4): 미션 채널에 diff-comment 앵커 포스트(렌더러 channelLocal 경로).
  const handleComment = useCallback(
    async (file: string, hunkHeader: string) => {
      if (!meta || meta.channelArchived || !meta.missionChannelId) return;
      const comment = window.prompt(t('diff.commentPrompt', { file }));
      if (!comment) return;
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
      const text = formatDiffCommentText(file, hunkHeader, comment);
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
          data: { kind: 'diff-comment', taskId, file, hunkHeader, side: 'new', line: 0 },
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
    [meta, taskId, verifiedWorkspaceId, t],
  );

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
        setMeta((m) => (m ? { ...m, status: 'closed' } : m));
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
  }, [lifecycleBusy, taskId, verifiedWorkspaceId, pushToast, t]);

  // diff→오케스트레이터 질문: hunk 컨텍스트 블록 + 질문을 단일 메시지로
  // 조립해 pendingBrainPrompt 릴레이에 싣고 Orchestrator 탭으로 전환한다
  // (CommanderView가 정상 send 경로로 발사 — 턴을 바로 관전하게 된다).
  // 입력은 인라인 폼: window.prompt는 Electron 렌더러에서 미지원(dogfood 실측
  // — 호출이 throw라 질문이 조용히 무산됐다).
  const [askTarget, setAskTarget] = useState<string | null>(null); // `${path}#${idx}`
  const [askText, setAskText] = useState('');
  const handleAskOrchestrator = useCallback(
    (file: string, hunkHeader: string, hunkBody: string) => {
      const question = askText.trim();
      if (!question) return;
      setAskTarget(null);
      setAskText('');
      const st = useStore.getState();
      const prompt = buildDiffAskContext({
        repoLabel: isTask ? meta?.worktreePath || taskId : repoPath,
        branch: meta?.branch || data?.snapshot.targetBranch || '',
        file,
        hunkHeader,
        hunkBody,
        question,
      });
      st.setPendingBrainPrompt(prompt);
      // 덱이 접혀 있거나 다른 탭이면 열고 전환 — 발사된 턴이 바로 보여야 한다.
      st.setChannelDockVisible(true);
      st.setActiveDeckTab('commander');
    },
    [askText, isTask, meta, taskId, repoPath, data],
  );

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
  // 파일 하단 "위치 이동됨" 그룹으로 강등. (v1 앵커 정밀도 = hunkHeader 단위 — §4.)
  const fileComments = useMemo(() => {
    if (!activeFile) return { byHunk: new Map<string, DiffComment[]>(), moved: [] as DiffComment[] };
    const headers = new Set(activeFile.hunks.map((h) => h.header));
    const byHunk = new Map<string, DiffComment[]>();
    const moved: DiffComment[] = [];
    for (const c of comments) {
      if (c.file !== activeFile.path) continue;
      if (c.hunkHeader && headers.has(c.hunkHeader)) {
        const list = byHunk.get(c.hunkHeader) ?? [];
        list.push(c);
        byHunk.set(c.hunkHeader, list);
      } else {
        moved.push(c);
      }
    }
    return { byHunk, moved };
  }, [activeFile, comments]);

  return (
    <div
      className="absolute inset-0 flex flex-col bg-[var(--bg-base)]"
      style={{ display: isActive ? 'flex' : 'none' }}
      data-surface-id={surfaceId}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--bg-mantle)] shrink-0 text-xs">
        <span className="text-[var(--text-main)] font-semibold">Diff</span>
        {meta && <span className="text-[var(--text-muted)] text-[10px]">{meta.branch}</span>}
        {/* 워크스페이스 모드 — 브랜치는 스냅샷에서(태스크 meta 없음). */}
        {!isTask && data && (
          <span className="text-[var(--text-muted)] text-[10px]">{data.snapshot.targetBranch}</span>
        )}
        <div className="flex-1" />
        <button
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)]"
          onClick={() => void load()}
        >
          Reload
        </button>
        {/* 채택은 태스크 모드 전용 — 워크스페이스 모드는 repo 자신 대상이라 무의미(읽기 전용). */}
        {isTask && (
          <button
            className="px-2 py-0.5 rounded text-[10px] bg-[var(--accent-blue,#3b82f6)] text-white disabled:opacity-40"
            onClick={() => void handleAdopt()}
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
              className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)] disabled:opacity-40"
              onClick={() => void handleCreatePr()}
              disabled={lifecycleBusy !== null}
              title={t('diff.prTitle')}
            >
              {lifecycleBusy === 'pr' ? t('diff.prBusy') : 'PR'}
            </button>
            <button
              className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--accent-red,#f87171)] border border-[var(--bg-mantle)] disabled:opacity-40"
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
            Loading...
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
                        <span className="text-[var(--accent-green,#4ade80)]">+{num.additions ?? '?'}</span>{' '}
                        <span className="text-[var(--accent-red,#f87171)]">-{num.deletions ?? '?'}</span>
                      </span>
                    )}
                    {f && !f.hunkSelectable && (
                      <span className="ml-1 text-[9px] text-[var(--text-muted)]">[{f.kind}·{t('diff.nonAdoptable')}]</span>
                    )}
                    {(isTrunc || isUnsupported || !f) && (
                      <span className="ml-1 text-[9px] text-[var(--text-muted)]">[{t('diff.displayOnlyTag')}]</span>
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
                          <span className="text-[9px] text-[var(--accent-red,#f87171)]">{t('diff.nonAdoptable')}</span>
                        )}
                        <div className="flex-1" />
                        {/* diff→오케스트레이터 질문 — 양 모드 공통(hunk 컨텍스트 동봉). */}
                        <button
                          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                          onClick={() => {
                            setAskText('');
                            setAskTarget((prev) => (prev === key ? null : key));
                          }}
                          title={t('diff.askOrchestrator') || 'Ask the orchestrator about this hunk'}
                          data-diff-ask
                        >
                          {t('diff.ask') || 'Ask'}
                        </button>
                        {!meta?.channelArchived && meta?.missionChannelId && (
                          <button
                            className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                            onClick={() => void handleComment(activeFile.path, hunk.header)}
                            title={t('diff.commentHunk')}
                          >
                            <IconComment />
                          </button>
                        )}
                        {meta?.channelArchived && (
                          <span className="text-[9px] text-[var(--text-muted)]" title={t('diff.channelArchived')}>
                            {t('diff.commentDisabled')}
                          </span>
                        )}
                      </div>
                      {/* 인라인 질문 폼 — Enter 발사, Esc 닫기. */}
                      {askTarget === key && (
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-base)] border-t border-[var(--bg-mantle)]"
                          data-diff-ask-form
                        >
                          <input
                            type="text"
                            autoFocus
                            value={askText}
                            onChange={(e) => setAskText(e.target.value)}
                            onKeyDown={(e) => {
                              // IME 조합 중 Enter(한/일/중)는 조합 확정이지 제출이 아님 —
                              // isComposing/keyCode 229를 가드(Codex P2).
                              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                                handleAskOrchestrator(activeFile.path, hunk.header, hunk.bodyLines.join('\n'));
                              } else if (e.key === 'Escape') {
                                setAskTarget(null);
                                setAskText('');
                              }
                            }}
                            placeholder={t('diff.askPrompt') || 'Ask the orchestrator — hunk context attaches automatically'}
                            spellCheck={false}
                            className="flex-1 min-w-0 bg-transparent text-[11px] text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none px-1"
                          />
                          <button
                            className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)] disabled:opacity-40"
                            disabled={!askText.trim()}
                            onClick={() =>
                              handleAskOrchestrator(activeFile.path, hunk.header, hunk.bodyLines.join('\n'))
                            }
                          >
                            {t('diff.ask') || 'Ask'}
                          </button>
                        </div>
                      )}
                      <div className="px-2 py-1">
                        <HunkBody bodyLines={hunk.bodyLines} />
                      </div>
                      {/* F10: 이 hunk 헤더에 매칭된 코멘트 인라인 표시. */}
                      <CommentList comments={fileComments.byHunk.get(hunk.header) ?? []} />
                    </div>
                  );
                })}
              {/* F10: hunkHeader 불일치(위치 이동됨) 코멘트 그룹 — 파일 하단. */}
              {activeFile && fileComments.moved.length > 0 && (
                <div className="mb-2 border border-[var(--accent-red,#f87171)] rounded overflow-hidden">
                  <div className="px-2 py-1 bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]">
                    {t('diff.commentMoved', { count: fileComments.moved.length })}
                  </div>
                  <CommentList comments={fileComments.moved} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
