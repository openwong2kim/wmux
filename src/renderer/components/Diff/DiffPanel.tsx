// J2 — DiffPanel: task output diff review·hunk adopt·comments (spec §1·§3·§4)
//
// §6.J literal compliance: "read·comment·checkout 3 actions only — no full IDE diff editor."
// File tree (numstat) + unified diff (+/- colors only) + hunk checkboxes + adopt button +
// failed hunk display + "applied"/"cannot adopt" badges + comment button.
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

// gpui button recipes (theme-safe color-mix on tokens; primary/danger keep the
// rgba sheen the DESIGN spec calls for). Reused across this panel's header.
const BTN_RAISED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--bg-surface)_72%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] hover:bg-[var(--bg-surface)] hover:border-[color-mix(in_srgb,var(--text-main)_16%,transparent)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.25)]';
const BTN_PRIMARY_WARM =
  'rounded-[5px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,0,0,0.3)] hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--text-main))] transition-colors';
const BTN_DANGER_TINTED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)] border-[color-mix(in_srgb,var(--accent-red)_32%,transparent)] text-[color-mix(in_srgb,var(--accent-red)_70%,var(--text-main))] hover:bg-[color-mix(in_srgb,var(--accent-red)_22%,transparent)]';

/**
 * diff target union — existing task worktree (J2, hunk adopt·comments·PR included) and
 * workspace repo (read-only: git diff HEAD + untracked) rendered by one component.
 * Union instead of fork: avoids duplicating diffParse render·cap·truncated logic.
 * Workspace mode guards all task-coupled parts (mission channel comments·adopt·PR·close) —
 * pure read surface within §6.J "read·comment·checkout 3 actions" contract.
 */
export type DiffPanelSource =
  | { kind: 'task'; taskId: string }
  | { kind: 'workspace'; repoPath: string };

interface DiffPanelProps {
  source: DiffPanelSource;
  isActive: boolean;
  surfaceId: string;
  /** Renderer identity anchor (for channel posts). */
  verifiedWorkspaceId: string;
}

// Task meta (reverse reference from task.mission.list).
interface TaskMeta {
  worktreePath: string;
  branch: string;
  missionChannelId: string;
  channelArchived: boolean;
  /** F11 — hide close/PR buttons when closed (worktree removed·nothing to close). */
  status: 'open' | 'closed';
}

// F10 — diff comment reverse lookup (mission channel diff-comment anchor messages).
interface DiffComment {
  file: string;
  hunkHeader: string;
  author: string;
  text: string;
  postedAt: number;
}

// Extract only this task's diff-comment anchors from channel messages (§4 data.kind match).
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

// J4 §S2 — text anchor attached to diff comment post. So agents know file·hunk from body alone
// even when CLI/MCP read does not render data payload. Truncate hunkHeader on text side only
// (data anchor kept intact — extractDiffComments reads it); omit `@ ...` part when empty.
export const DIFF_COMMENT_HEADER_MAX = 80;

export function formatDiffCommentText(file: string, hunkHeader: string, comment: string): string {
  const head =
    hunkHeader.length > DIFF_COMMENT_HEADER_MAX
      ? hunkHeader.slice(0, DIFF_COMMENT_HEADER_MAX)
      : hunkHeader;
  const anchor = head ? `[diff: ${file} @ ${head}]` : `[diff: ${file}]`;
  return `${anchor} ${comment}`;
}

// J4 §S1 — resolve auto-mention targets for diff comment post. Among mission channel members,
// exclude human (HUMAN_WORKSPACE_ID) and commenter self (selfWorkspaceId — mission channel
// createdBy is owner workspace so always member); mention rest one per workspace.
//
// Intentionally workspace-level (no memberId): daemon mentionUnread aggregation
// (ChannelService.unreadFor) counts mentions without memberId for all member rows in that workspace,
// so all agent fans in one WS (e.g. Claude+Codex in same WS) wake. Conversely attaching memberId
// makes post RPC dedup key (workspaceId, paneId) collapse sibling mentions — only first row survives,
// rest silently lost. Pre-truncate with CHANNEL_MENTIONS_MAX (excess rejected by post RPC as
// CHANNEL_MENTIONS_TOO_MANY anyway).
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

// diff.read/applyHunks bridge (preload exposed).
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

// task.mission.list reverse reference taskId → worktree·channel.
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
    // Channel archived (comment button gating). F9 fail-safe: when channel get fails
    // assume archived=true and disable comments — allowing comment fire when lookup impossible
    // could misfire to lost·archived channels so fail closed.
    let channelArchived = true;
    const channelId = task.missionChannelId ?? '';
    if (channelId) {
      try {
        const chRes = (await api.rpc.invoke('a2a.channel.get', {
          verifiedWorkspaceId,
          channelId,
        })) as { ok?: boolean; channel?: { status?: string }; error?: unknown };
        // Trust actual status only on get success. Otherwise (ok:false·unknown shape) keep closed.
        if (chRes && chRes.ok === true && chRes.channel) {
          channelArchived = chRes.channel.status === 'archived';
        }
      } catch {
        /* lookup failure → keep channelArchived=true (comments disabled) */
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

// F10 — reverse lookup diff-comment anchors from mission channel (reuse §4 read RPC).
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

// Mission channel roster row (minimal fields for mention target resolution + commenter sender identity).
interface MissionMemberRow {
  workspaceId: string;
  memberId: string;
  memberName?: string;
}

// J4 §S1 — fetch mission channel roster. Reuse existing channel member read RPC (a2a.channel.getMembers) —
// same transport·identity as loadDiffComments (verifiedWorkspaceId). From one roster fetch derive
// mention targets (resolveDiffMentionTargets) and sender self-row (post identity). Failure·invisible
// (private channel non-member → empty roster) → empty array → post without mentions
// (no self-row → post fails daemon membership gate and F9 surfaces reason).
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

// F10 — comment list render (author·body·time — minimal).
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

// Color hunk lines +/- only (no syntax highlighting — non-goal).
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

// No chrome emoji (DESIGN.md) — comment action uses monochrome speech bubble glyph.
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
  // source may be new object each render (inline at call site) — decompose to primitives for
  // load callback deps — putting object identity in deps causes refetch loop every render.
  const isTask = source.kind === 'task';
  const taskId = source.kind === 'task' ? source.taskId : '';
  const repoPath = source.kind === 'workspace' ? source.repoPath : '';
  const [meta, setMeta] = useState<TaskMeta | null>(null);
  const [data, setData] = useState<DiffReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // path → Set of selected hunk indices.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [failedProbes, setFailedProbes] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // F10: diff comments reverse-looked up from mission channel.
  const [comments, setComments] = useState<DiffComment[]>([]);
  // J3 §1·§2: close·PR in-progress state (prevent double click).
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
      // F10: comment reverse lookup (failure → empty list — do not block diff render).
      setComments(await loadDiffComments(m.missionChannelId, taskId, verifiedWorkspaceId));
      readPath = m.worktreePath;
    } else {
      // Workspace mode — no task reverse reference·comments. repoPath is worktree toplevel
      // normalized by diff:resolveRepo.
      readPath = repoPath;
    }
    const bridge = getDiffBridge();
    if (!bridge) {
      setError(t('diff.bridgeUnavailable'));
      setLoading(false);
      return;
    }
    // Workspace mode passed explicitly — uncommitted vs own HEAD only (no main repo mapping).
    // Prevents branch commits in linked worktree leaking into diff (Codex P2).
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

  // Workspace diff is derived data — re-read on tab reactivation (inactive→active transition).
  // Task mode keeps manual Reload contract (adopt selection must not be lost on refetch).
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
      // Re-read: adopted hunks still visible in task worktree diff with "applied" badge.
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

  // Fire comment (§4·J4): post diff-comment anchor to mission channel (renderer channelLocal path).
  const handleComment = useCallback(
    async (file: string, hunkHeader: string) => {
      if (!meta || meta.channelArchived || !meta.missionChannelId) return;
      const comment = window.prompt(t('diff.commentPrompt', { file }));
      if (!comment) return;
      const api = (window as unknown as {
        electronAPI?: { rpc?: { mutateChannelLocal: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
      }).electronAPI;
      if (!api?.rpc) return;
      // Fetch mission channel roster once to derive mention targets and sender self-row together.
      const roster = await loadMissionRoster(meta.missionChannelId, verifiedWorkspaceId);
      // J4 §S1: commenting on hunk itself means "agent please apply this" so always mention
      // task agents in mission channel (all members except human·self) — this mention rides
      // existing mention→wake loop to wake agents with feedback. When zero targets
      // (all agents leave/kick) post without mentions (comment record itself is valid).
      const mentions = resolveDiffMentionTargets(roster, verifiedWorkspaceId);
      // Sender identity = commenter's roster row. Daemon post gate pins sender.workspaceId ===
      // verifiedWorkspaceId and rejects non-members, so compose sender with verifiedWorkspaceId
      // as mission channel owner (= diff owner workspace, always member). memberName is
      // re-derived by daemon from roster row — display fallback only.
      const self = roster.find((m) => m.workspaceId === verifiedWorkspaceId);
      const sender = {
        workspaceId: verifiedWorkspaceId,
        memberId: self?.memberId ?? '',
        memberName: self?.memberName ?? self?.memberId ?? '',
      };
      // J4 §S2: stamp anchor in body too — context remains when CLI/MCP read does not render data.
      const text = formatDiffCommentText(file, hunkHeader, comment);
      // F9: do not swallow post failure (channel lost·auth·IPC error) — surface as error message.
      try {
        const res = (await api.rpc.mutateChannelLocal('a2a.channel.post', {
          verifiedWorkspaceId,
          channelId: meta.missionChannelId,
          // sender: daemon post requires sender (+ sender.workspaceId===verifiedWorkspaceId pin).
          // Without this field NOT_AUTHORIZED rejection (J2 gap fix).
          sender,
          text,
          // data anchor for renderer inline mapping — hunkHeader kept intact (§S2, truncate text only).
          data: { kind: 'diff-comment', taskId, file, hunkHeader, side: 'new', line: 0 },
          ...(mentions.length > 0 ? { mentions } : {}),
        })) as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false) {
          setApplyMsg(t('diff.commentFailed', { error: res.error ?? t('diff.unknownError') }));
          return;
        }
        setApplyMsg(t('diff.commentFired', { count: mentions.length }));
        // F10: refresh reverse lookup right after fire — comment appears inline immediately.
        setComments(await loadDiffComments(meta.missionChannelId, taskId, verifiedWorkspaceId));
      } catch (e) {
        setApplyMsg(t('diff.commentFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [meta, taskId, verifiedWorkspaceId, t],
  );

  // J3 §1 — close (remove success→close order). One confirm then toast distinguishes result
  // (dirty=preserved/unpushed=warn+PR suggest/archivePending). main reverse-references
  // materialization fields from daemon projection so pass taskId only.
  const handleClose = useCallback(async () => {
    if (lifecycleBusy) return;
    const api = (window as unknown as { electronAPI?: { workTask?: import('../../../preload/preload').ElectronAPI['workTask'] } }).electronAPI;
    if (!api?.workTask) return;
    if (!window.confirm(t('diff.closeConfirm'))) return;
    setLifecycleBusy('close');
    try {
      const res = await api.workTask.close(taskId, verifiedWorkspaceId);
      if (res.ok) {
        // Align with F11: close committed so set local meta closed too — hide PR/close buttons
        // immediately so they are not clicked again against removed worktree.
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

  // diff→orchestrator question: assemble hunk context block + question into single message,
  // load on pendingBrainPrompt relay and switch to Orchestrator tab
  // (CommanderView fires via normal send path — watch turn immediately).
  // Inline form input: window.prompt unsupported in Electron renderer (dogfood measured
  // — call throws so question silently failed).
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
      // Open deck and switch tab if collapsed or on other tab — fired turn must be visible.
      st.setChannelDockVisible(true);
      st.setActiveDeckTab('commander');
    },
    [askText, isTask, meta, taskId, repoPath, data],
  );

  // J3 §2 — 1-click PR (includes one confirm). gh 4-gate·idempotent re-entry handled by main.
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

  // Paths shown in file tree — parsed files + numstat-only paths (untracked
  // binary·large·symlink display-only). Even when files empty, such changes mean
  // not "clean" and must show in tree (Codex P2 — prevent hidden change misjudgment).
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

  // F10 — group active file comments by hunkHeader. Comments matching current diff hunk headers
  // go under that hunk; mismatches (header changed by line drift) demoted to file bottom
  // "moved" group. (v1 anchor precision = hunkHeader unit — §4.)
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
        {/* Workspace mode — branch from snapshot (no task meta). */}
        {!isTask && data && (
          <span className="text-[var(--text-muted)] text-[10px]">{data.snapshot.targetBranch}</span>
        )}
        <div className="flex-1" />
        <button
          className={`px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${BTN_RAISED}`}
          onClick={() => void load()}
        >
          Reload
        </button>
        {/* Adopt is task-mode only — workspace mode targets own repo (read-only, meaningless). */}
        {isTask && (
          <button
            className={`px-2 py-0.5 text-[10px] ${BTN_PRIMARY_WARM} disabled:opacity-40`}
            onClick={() => void handleAdopt()}
            disabled={applying || selectedCount === 0}
            title={t('diff.adoptTitle')}
          >
            {applying ? t('diff.adopting') : t('diff.adopt', { count: selectedCount })}
          </button>
        )}
        {/* J3 §2·§1 — one-click PR·close. F11: hidden for closed tasks (worktree removed). */}
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
            {/* File tree (numstat) — union of files + numstat-only (display-only) paths. */}
            <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--bg-mantle)] text-[11px]">
              {displayPaths.map((path) => {
                const f = filesByPath.get(path);
                const num = data.numstat.find((n) => n.path === path);
                const isTrunc = data.truncated.includes(path);
                const isUnsupported = (data.unsupported ?? []).includes(path);
                // numstat-only path (no parsed file) = binary·large·symlink etc.
                // display-only. Click shows "display only" notice — no hunks.
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

            {/* Unified diff view + hunk checkboxes */}
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
                        {/* diff→orchestrator question — both modes (hunk context attached). */}
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
                      {/* Inline ask form — Enter sends, Esc closes. */}
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
                              // Enter during IME composition (ko/ja/zh) confirms composition not submit —
                              // guard isComposing/keyCode 229 (Codex P2).
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
                      {/* F10: inline comments matching this hunk header. */}
                      <CommentList comments={fileComments.byHunk.get(hunk.header) ?? []} />
                    </div>
                  );
                })}
              {/* F10: hunkHeader mismatch (moved) comment group — bottom of file. */}
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
