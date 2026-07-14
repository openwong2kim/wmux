// J1 §7 fan-out 다이얼로그. 프롬프트 1개 → N(1~8) 격리 태스크.
//
// 입력: 프롬프트(textarea), N, 태스크별 title(자동 파생 + 편집), repo 경로(기본:
// 활성 ws cwd), agentCmd(기본 claude), 브랜치 접두 미리보기, 멱등키 발급(제출 1회).
// 격리 해제 토글은 두지 않는다(§6 C10 — broadcast는 별개 진입).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { generateId } from '../../../shared/types';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';
import { useT } from '../../hooks/useT';
import { t } from '../../i18n';

/** title 자동 파생: "{프롬프트 앞 24자} #k"(§7 G6). */
function deriveTitle(prompt: string, k: number): string {
  const head = prompt.trim().slice(0, 24).replace(/\s+/g, ' ').trim();
  return head.length > 0 ? `${head} #${k + 1}` : `task #${k + 1}`;
}

/** branch 미리보기용 slug(TaskWorktreeManager.titleToSlug 규칙 동형 — 미리보기 전용). */
function previewSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

interface FanOutDialogProps {
  onClose: () => void;
}

export default function FanOutDialog({ onClose }: FanOutDialogProps) {
  const t = useT();
  const activeWorkspace = useStore(selectActiveWorkspace);
  const pushToast = useStore((s) => s.pushToast);

  const defaultRepo = activeWorkspace?.metadata?.cwd ?? '';

  const [prompt, setPrompt] = useState('');
  const [n, setN] = useState(2);
  const [titles, setTitles] = useState<string[]>([]);
  const [titlesEdited, setTitlesEdited] = useState<boolean[]>([]);
  const [repoPath, setRepoPath] = useState(defaultRepo);
  const [agentCmd, setAgentCmd] = useState('claude');
  const [submitting, setSubmitting] = useState(false);

  // repo 기본값이 늦게 로드되면 반영.
  useEffect(() => {
    if (!repoPath && defaultRepo) setRepoPath(defaultRepo);
  }, [defaultRepo, repoPath]);

  // N·프롬프트 변경 시 미편집 title만 자동 파생(편집분은 보존).
  useEffect(() => {
    setTitles((prev) => {
      const next = [...prev];
      const edited = titlesEdited;
      for (let k = 0; k < n; k++) {
        if (!edited[k] || next[k] === undefined) next[k] = deriveTitle(prompt, k);
      }
      next.length = n;
      return next;
    });
    setTitlesEdited((prev) => {
      const next = [...prev];
      next.length = n;
      return next.map((v) => v ?? false);
    });
  }, [n, prompt]); // eslint-disable-line react-hooks/exhaustive-deps

  const promptBytes = useMemo(() => new TextEncoder().encode(prompt).length, [prompt]);
  const promptOverCap = promptBytes > FANOUT_PROMPT_MAX_BYTES;

  const setTitleAt = useCallback((k: number, v: string) => {
    setTitles((prev) => {
      const next = [...prev];
      next[k] = v;
      return next;
    });
    setTitlesEdited((prev) => {
      const next = [...prev];
      next[k] = true;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (prompt.trim().length === 0) {
      pushToast({ level: 'warn', message: t('fanout.errPromptRequired') });
      return;
    }
    if (promptOverCap) {
      pushToast({ level: 'warn', message: t('fanout.errPromptTooLarge', { max: FANOUT_PROMPT_MAX_BYTES }) });
      return;
    }
    if (!repoPath.trim()) {
      pushToast({ level: 'warn', message: t('fanout.errRepoRequired') });
      return;
    }
    setSubmitting(true);
    // 호출 단위 멱등키 1회 발급(§2 G1) — 더블클릭·재시도가 N배 worktree를 못 찍는다.
    const idempotencyKey = generateId('fanout');
    try {
      const res = await window.electronAPI.fanout.start({
        idempotencyKey,
        prompt,
        titles: titles.slice(0, n),
        repoPath: repoPath.trim(),
        agentCmd: agentCmd.trim() || 'claude',
        // 렌더러 신뢰 신원(§2 — channelLocal과 동일 trust basis). owner = 생성자
        // (스펙 §5.1 born-owned=createdBy)라 활성 워크스페이스로 고정한다. CEO 자동
        // 승격은 하지 않는다(생성자 소유권을 CEO로 뭉개면 born-owned 계약 위반).
        verifiedWorkspaceId: activeWorkspace?.id ?? '',
      });
      // owner(부모) ws id = fan-out을 실행한 활성 워크스페이스(§5.1 born-owned).
      reportResult(res, pushToast, activeWorkspace?.id ?? '');
      // fan-out 완료 직후 미션 캐시 즉시 refetch(순수 pull이라 push가 없다 —
      // 배경 폴링을 기다리지 않고 사이드바 "Missions" 섹션을 바로 채운다).
      const parentId = activeWorkspace?.id;
      if (parentId) void useStore.getState().refreshMissions(parentId);
      onClose();
    } catch (err) {
      pushToast({ level: 'error', message: t('fanout.failed', { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, prompt, promptOverCap, repoPath, titles, n, agentCmd, activeWorkspace, pushToast, t]);

  const field = 'w-full px-2 py-1 rounded border border-[var(--bg-overlay)] bg-[var(--bg-surface)] text-[12px] text-[var(--text-main)]';
  const label = 'text-[11px] text-[var(--text-sub)] mb-1 block';

  return (
    <div className="absolute bottom-full mb-2 left-2 z-50 w-[420px] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl" data-testid="fanout-dialog">
      <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">{t('fanout.title')}</div>

      <label className={label}>{t('fanout.promptLabel')}</label>
      <textarea
        className={`${field} h-24 resize-none font-mono`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('fanout.promptPlaceholder')}
        data-testid="fanout-prompt"
      />
      <div className={`text-[10px] mb-2 ${promptOverCap ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
        {t('fanout.bytes', { bytes: promptBytes, max: FANOUT_PROMPT_MAX_BYTES })}
      </div>

      <label className={label}>{t('fanout.taskCount', { n })}</label>
      <input
        type="range"
        min={1}
        max={FANOUT_MAX_TASKS}
        value={n}
        onChange={(e) => setN(Number(e.target.value))}
        className="w-full mb-2"
        data-testid="fanout-n"
      />

      <label className={label}>{t('fanout.titlesLabel')}</label>
      <div className="space-y-1 mb-2">
        {Array.from({ length: n }, (_, k) => (
          <div key={k} className="flex items-center gap-2">
            <input
              className={`${field} flex-1`}
              value={titles[k] ?? ''}
              onChange={(e) => setTitleAt(k, e.target.value)}
              data-testid={`fanout-title-${k}`}
            />
            <span className="text-[9px] text-[var(--text-muted)] font-mono shrink-0">
              wtask/{previewSlug(titles[k] ?? '') || '…'}
            </span>
          </div>
        ))}
      </div>

      <label className={label}>{t('fanout.repoLabel')}</label>
      <input className={`${field} mb-2 font-mono`} value={repoPath} onChange={(e) => setRepoPath(e.target.value)} data-testid="fanout-repo" />

      <label className={label}>{t('fanout.agentLabel')}</label>
      <input className={`${field} mb-3 font-mono`} value={agentCmd} onChange={(e) => setAgentCmd(e.target.value)} data-testid="fanout-agent" />

      <div className="flex items-center justify-end gap-2">
        <button className="px-3 py-1 rounded text-[11px] text-[var(--text-sub)] hover:text-[var(--text-main)]" onClick={onClose}>
          {t('fanout.cancel')}
        </button>
        <button
          className="px-3 py-1 rounded text-[11px] bg-[var(--accent-blue)] text-white disabled:opacity-40"
          disabled={submitting || promptOverCap}
          onClick={handleSubmit}
          data-testid="fanout-submit"
        >
          {submitting ? t('fanout.spawning') : t('fanout.spawn', { n })}
        </button>
      </div>
    </div>
  );
}

/** 결과 리포트 → 토스트(미물질화·채널 미연결·프롬프트 미발사 구분 — §7). */
interface FanOutResultLike {
  ok?: boolean;
  error?: string;
  tasks?: Array<{
    ok?: boolean;
    title?: string;
    error?: string;
    unmaterialized?: boolean;
    channelDisconnected?: boolean;
    // F5 — diff 진입 재료(FanOutTaskResult에서 반환).
    taskId?: string;
    workspaceId?: string;
    worktreePath?: string;
    // J3 §3 — onExhausted 토스트 매핑 재료(ptyId→태스크).
    ptyId?: string;
    // F2 — 재발사용 원래 initialCommand(에이전트 기동+프롬프트 주입).
    initialCommand?: string;
  }>;
}

type PushToast = (t: {
  level: 'info' | 'warn' | 'error';
  message: string;
  action?: { label: string; onClick: () => void };
}) => string;

// F5 — 태스크 워크스페이스의 첫 leaf 페인에 diff 서피스를 연다. 워크스페이스가
// 아직 없거나 leaf가 없으면(레이스) 조용히 무시. F1: owner(부모) ws id를 서피스에
// 실어 close/PR/resolveTaskMeta가 owner 스코프 RPC를 올바른 신원으로 부르게 한다.
function openTaskDiff(taskId: string, workspaceId: string, title: string, ownerWorkspaceId: string): void {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const leaf = findLeafPanes(ws.rootPane)[0];
  if (!leaf) return;
  st.addDiffSurface(leaf.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
  // 태스크 워크스페이스로 전환해 방금 연 diff가 바로 보이게.
  st.setActiveWorkspace(workspaceId);
}

function reportResult(res: unknown, pushToast: PushToast, ownerWorkspaceId: string): void {
  const r = (res ?? {}) as FanOutResultLike;
  if (r.error) {
    pushToast({ level: 'error', message: t('fanout.rejected', { error: r.error }) });
    return;
  }
  const tasks = r.tasks ?? [];

  // J3 §3 — onExhausted 토스트가 소비할 ptyId→태스크 매핑을 등록(발사 실패 통지는
  // fan-out 반환 이후 비동기로 오므로 store에 남겨둔다). ptyId 없는 태스크는 생략.
  // F2: 재발사가 원문 프롬프트가 아니라 원래 initialCommand(에이전트 기동+프롬프트
  // 주입)를 재전송해야 하므로 initialCommand도 함께 싣는다.
  const ptyEntries = tasks
    .filter((t) => t.ptyId && t.taskId)
    .map((t) => ({
      ptyId: t.ptyId as string,
      taskId: t.taskId as string,
      title: t.title ?? (t.taskId as string),
      ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
      ...(t.initialCommand ? { initialCommand: t.initialCommand } : {}),
    }));
  if (ptyEntries.length > 0) useStore.getState().registerTaskPtys(ptyEntries);

  const ok = tasks.filter((t) => t.ok).length;
  const fail = tasks.length - ok;
  const unmaterialized = tasks.filter((t) => t.unmaterialized).length;
  const disconnected = tasks.filter((t) => t.ok && t.channelDisconnected).length;

  const parts: string[] = [t('fanout.summarySuccess', { ok }) + (fail > 0 ? ` · ${t('fanout.summaryFailed', { fail })}` : '')];
  if (unmaterialized > 0) parts.push(t('fanout.summaryUnmaterialized', { count: unmaterialized }));
  if (disconnected > 0) parts.push(t('fanout.summaryDisconnected', { count: disconnected }));
  pushToast({
    level: fail > 0 ? 'error' : disconnected > 0 || unmaterialized > 0 ? 'warn' : 'info',
    message: parts.join(' · '),
  });

  // F5 — 물질화된 성공 태스크마다 "diff 열기" 액션 토스트. 워크스페이스가 있어야
  // 서피스를 열 수 있으므로 workspaceId·taskId가 채워진 태스크만 대상.
  for (const task of tasks) {
    if (!task.ok || !task.taskId || !task.workspaceId) continue;
    const taskId = task.taskId;
    const workspaceId = task.workspaceId;
    const title = task.title ?? taskId;
    pushToast({
      level: 'info',
      message: t('fanout.taskReady', { title }),
      action: {
        label: t('fanout.openDiff'),
        onClick: () => openTaskDiff(taskId, workspaceId, title, ownerWorkspaceId),
      },
    });
  }
}
