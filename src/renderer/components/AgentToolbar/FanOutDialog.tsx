// J1 §7 Multi Task(병렬 작업) 다이얼로그. N(1~8) 격리 태스크를 동시에 연다.
//
// mode 토글(경쟁/병렬)은 순수 UI 강조 스위치다 — 서비스는 항상 공통+개별 프롬프트를
// 결합해서 발사하므로(compete는 개별 필드를 숨길 뿐 결합 규칙 자체는 동일), 토글이
// 상태 기계를 늘리지 않는다. 프롬프트가 전부 비어도 거부하지 않는다(§7 "환경만
// 조성" — worktree·에이전트 페인만 열고 사람이 직접 입력).
//
// 입력: 공통 프롬프트, 태스크별 title+프롬프트(자동 파생 + 편집), N(클릭형 1~8),
// repo 경로(기본: 활성 ws cwd), agentCmd(기본 claude), 브랜치 접두 미리보기, 멱등키
// 발급(제출 1회). 격리 해제 토글은 두지 않는다(§6 C10 — broadcast는 별개 진입).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { generateId } from '../../../shared/types';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';
import { useT } from '../../hooks/useT';
import { t } from '../../i18n';
import Button from '../ui/Button';
import Input from '../ui/Input';

// 리뷰 발견(Codex+GLM+Claude 3/3 합의) — compete 모드에서 `mode === 'parallel' ?
// taskPrompts : []`처럼 인라인 배열 리터럴을 useEffect 의존성에 넣으면 매 렌더마다
// 새 참조가 생겨 이펙트가 무한 재실행된다(effect→setState(새 배열)→리렌더→새 []→
// effect... "Maximum update depth exceeded"). 모듈 상수로 참조를 고정해 방지.
const EMPTY_TASK_PROMPTS: readonly string[] = [];

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

  // 'compete' = 같은 작업 N번(경쟁 — 공통 프롬프트만), 'parallel' = 서로 다른 작업
  // N개(병렬 — 태스크별 프롬프트). 상호배타 UI는 아니고(서비스는 항상 공통+개별을
  // 결합) 다이얼로그가 어느 필드를 강조·노출할지만 바꾼다(§7 리뷰).
  const [mode, setMode] = useState<'compete' | 'parallel'>('parallel');
  const [prompt, setPrompt] = useState('');
  const [n, setN] = useState(2);
  const [titles, setTitles] = useState<string[]>([]);
  const [titlesEdited, setTitlesEdited] = useState<boolean[]>([]);
  const [taskPrompts, setTaskPrompts] = useState<string[]>([]);
  const [repoPath, setRepoPath] = useState(defaultRepo);
  const [agentCmd, setAgentCmd] = useState('claude');
  const [submitting, setSubmitting] = useState(false);

  // repo 기본값이 늦게 로드되면 반영.
  useEffect(() => {
    if (!repoPath && defaultRepo) setRepoPath(defaultRepo);
  }, [defaultRepo, repoPath]);

  // 경쟁 모드에선 태스크별 필드를 숨기므로 서비스에도 보내지 않는다(사용자가 이전에
  // 병렬 모드에서 입력해둔 값은 state에 보존 — 다시 전환하면 되살아난다). 리뷰 발견
  // (3/3 합의): 매 렌더 새 []를 만들면 안 되므로 안정 참조(EMPTY_TASK_PROMPTS)로 고정.
  const effectiveTaskPrompts = mode === 'parallel' ? taskPrompts : EMPTY_TASK_PROMPTS;

  // N·프롬프트 변경 시 미편집 title만 자동 파생(편집분은 보존). 태스크별 프롬프트가
  // 있으면 그쪽에서 파생(개별 작업의 정체성은 개별 프롬프트가 정본).
  useEffect(() => {
    setTitles((prev) => {
      const next = [...prev];
      const edited = titlesEdited;
      for (let k = 0; k < n; k++) {
        if (!edited[k] || next[k] === undefined) {
          const src = (effectiveTaskPrompts[k] ?? '').trim().length > 0 ? effectiveTaskPrompts[k] : prompt;
          next[k] = deriveTitle(src, k);
        }
      }
      next.length = n;
      return next;
    });
    setTitlesEdited((prev) => {
      const next = [...prev];
      next.length = n;
      return next.map((v) => v ?? false);
    });
  }, [n, prompt, effectiveTaskPrompts]); // eslint-disable-line react-hooks/exhaustive-deps

  const promptBytes = useMemo(() => new TextEncoder().encode(prompt).length, [prompt]);
  // 태스크 유효 프롬프트 = 공통 + 개별(빈 쪽 생략) — FanOutService 결합 규칙과 동형.
  const effectiveBytes = useMemo(() => {
    const enc = new TextEncoder();
    return Array.from({ length: n }, (_, k) => {
      const combined = [prompt.trim(), (effectiveTaskPrompts[k] ?? '').trim()].filter((p) => p.length > 0).join('\n\n');
      return enc.encode(combined).length;
    });
  }, [n, prompt, effectiveTaskPrompts]);
  const promptOverCap = effectiveBytes.some((b) => b > FANOUT_PROMPT_MAX_BYTES);
  // 정보성 힌트일 뿐 제출을 막지 않는다(§7 — 환경만 조성도 정당한 사용).
  const promptAllEmpty = effectiveBytes.every((b) => b === 0);

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

  const setTaskPromptAt = useCallback((k: number, v: string) => {
    setTaskPrompts((prev) => {
      const next = [...prev];
      next[k] = v;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    // §7: 프롬프트가 전부 비어도 거부하지 않는다 — "환경만 조성"(worktree·에이전트
    // 페인만 열고 사람이 직접 입력)도 정당한 사용이다. 캡 초과만 클라에서도 막는다.
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
        taskPrompts: Array.from({ length: n }, (_, k) => effectiveTaskPrompts[k] ?? ''),
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
  }, [submitting, prompt, promptOverCap, repoPath, titles, effectiveTaskPrompts, n, agentCmd, activeWorkspace, pushToast, t]);

  const label = 'text-[11px] text-[var(--text-sub)] mb-1 block';

  return (
    <div className="absolute bottom-full mb-2 left-2 z-50 w-[420px] max-h-[70vh] overflow-y-auto rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl" data-testid="fanout-dialog">
      <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">{t('fanout.title')}</div>

      <div className="flex rounded-[5px] border border-[var(--bg-overlay)] p-0.5 mb-2" role="tablist" data-testid="fanout-mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'compete'}
          className={`flex-1 text-[11px] rounded-[4px] py-1 transition-colors ${mode === 'compete' ? 'bg-[var(--bg-overlay)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'}`}
          onClick={() => setMode('compete')}
          data-testid="fanout-mode-compete"
        >
          {t('fanout.modeCompete')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'parallel'}
          className={`flex-1 text-[11px] rounded-[4px] py-1 transition-colors ${mode === 'parallel' ? 'bg-[var(--bg-overlay)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'}`}
          onClick={() => setMode('parallel')}
          data-testid="fanout-mode-parallel"
        >
          {t('fanout.modeParallel')}
        </button>
      </div>
      <div className="text-[10px] text-[var(--text-muted)] mb-2">
        {mode === 'compete' ? t('fanout.modeCompeteHint') : t('fanout.modeParallelHint')}
      </div>

      <label className={label}>{t('fanout.promptLabel')}</label>
      <textarea
        className="ui-input h-20 resize-none font-mono text-[12px]"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('fanout.promptPlaceholder')}
        data-testid="fanout-prompt"
      />
      <div className={`text-[10px] mb-2 ${promptOverCap ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
        {t('fanout.bytes', { bytes: promptBytes, max: FANOUT_PROMPT_MAX_BYTES })}
      </div>

      <label className={label}>{t('fanout.taskCount', { n })}</label>
      <div className="flex gap-1 mb-2" data-testid="fanout-n">
        {Array.from({ length: FANOUT_MAX_TASKS }, (_, i) => i + 1).map((count) => (
          <button
            key={count}
            type="button"
            aria-pressed={n === count}
            className={`flex-1 h-7 rounded-[4px] text-[11px] border transition-colors ${
              n === count
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-base)]'
                : 'border-[var(--bg-overlay)] text-[var(--text-sub)] hover:border-[var(--text-muted)]'
            }`}
            onClick={() => setN(count)}
            data-testid={`fanout-n-${count}`}
          >
            {count}
          </button>
        ))}
      </div>

      <label className={label}>{t('fanout.titlesLabel')}</label>
      <div className="space-y-2 mb-2">
        {Array.from({ length: n }, (_, k) => (
          <div key={k} className="rounded-[5px] border border-[var(--bg-overlay)] p-1.5">
            <div className="flex items-center gap-2 mb-1">
              <Input
                className="flex-1 text-[12px]"
                value={titles[k] ?? ''}
                onChange={(e) => setTitleAt(k, e.target.value)}
                data-testid={`fanout-title-${k}`}
              />
              <span className="text-[9px] text-[var(--text-muted)] font-mono shrink-0">
                wtask/{previewSlug(titles[k] ?? '') || '…'}
              </span>
            </div>
            {mode === 'parallel' && (
              <>
                <textarea
                  className="ui-input h-14 resize-none font-mono text-[11px]"
                  value={taskPrompts[k] ?? ''}
                  onChange={(e) => setTaskPromptAt(k, e.target.value)}
                  placeholder={t('fanout.taskPromptPlaceholder', { k: k + 1 })}
                  data-testid={`fanout-task-prompt-${k}`}
                />
                {effectiveBytes[k] > FANOUT_PROMPT_MAX_BYTES && (
                  <div className="text-[10px] text-[var(--accent-red)]">
                    {t('fanout.bytes', { bytes: effectiveBytes[k], max: FANOUT_PROMPT_MAX_BYTES })}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {promptAllEmpty && (
        <div className="text-[10px] text-[var(--text-muted)] mb-2" data-testid="fanout-empty-hint">
          {t('fanout.envOnlyHint')}
        </div>
      )}

      <label className={label}>{t('fanout.repoLabel')}</label>
      <Input className="mb-2 font-mono text-[12px]" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} data-testid="fanout-repo" />

      <label className={label}>{t('fanout.agentLabel')}</label>
      <Input className="mb-3 font-mono text-[12px]" value={agentCmd} onChange={(e) => setAgentCmd(e.target.value)} data-testid="fanout-agent" />

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('fanout.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={submitting || promptOverCap}
          onClick={handleSubmit}
          data-testid="fanout-submit"
        >
          {submitting ? t('fanout.spawning') : t('fanout.spawn', { n })}
        </Button>
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
