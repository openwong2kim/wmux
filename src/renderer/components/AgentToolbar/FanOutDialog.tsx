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
import { ORCH_ROLES } from '../../../shared/orchestratorRole';
import { useT } from '../../hooks/useT';
import { t } from '../../i18n';
import Button from '../ui/Button';
import Input from '../ui/Input';
import {
  SKIP_PERMISSIONS_FLAG,
  applySkipPermissions,
  hasSkipPermissions,
  fanoutAgentStem,
  hasStaleSkipPermissions,
  loadLastAgentCmd,
  saveLastAgentCmd,
  supportsSkipPermissions,
} from './fanoutAgentCmd';

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
  /** Workspace this spawn belongs to. Falls back to the active workspace. */
  workspaceId?: string;
  /** 앵커 정렬 — 좁은 덱 컨트롤 바에서는 우측 정렬해 왼쪽 오버플로를 막는다. */
  align?: 'left' | 'right';
}

export default function FanOutDialog({ onClose, workspaceId, align = 'left' }: FanOutDialogProps) {
  const t = useT();
  const workspace = useStore((s) => {
    if (workspaceId) return s.workspaces.find((w) => w.id === workspaceId);
    return selectActiveWorkspace(s);
  });
  const pushToast = useStore((s) => s.pushToast);

  const defaultRepo = workspace?.metadata?.cwd ?? '';

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
  // Prefilled with the command the last fan-out actually launched. wmux only
  // knows Claude Code's bypass flag, so a Codex (or other CLI) user types their
  // own flag once and it survives into the next fan-out.
  const [agentCmd, setAgentCmd] = useState(() => loadLastAgentCmd() || 'claude');
  // Per-task role, index-aligned with titles. '' = launch on agentCmd as typed.
  const [roles, setRoles] = useState<string[]>([]);
  const roleBindings = useStore((s) => s.orchestratorRoleBindings);
  const [submitting, setSubmitting] = useState(false);
  // Two-step launch for the all-empty case (see handleSubmit). Not a modal: the
  // dialog is already a popover, and a second popover over it would be a worse
  // place to read a warning than the button you are about to press again.
  const [confirmEmpty, setConfirmEmpty] = useState(false);

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

  // Typing a prompt withdraws the question — a stale "are you sure it's empty?"
  // sitting over a filled form is worse than no warning at all.
  useEffect(() => {
    if (!promptAllEmpty) setConfirmEmpty(false);
  }, [promptAllEmpty]);

  // The checkbox is a projection of the agentCmd string, not a second state:
  // typing the flag by hand ticks it, unchecking strips it. That is what keeps
  // the preview below identical to what the task pane will launch.
  const effectiveAgentCmd = agentCmd.trim() || 'claude';
  const canSkipPermissions = supportsSkipPermissions(effectiveAgentCmd);
  const skipPermissions = hasSkipPermissions(effectiveAgentCmd);
  // Switching `claude --dangerously-skip-permissions` over to another launcher
  // would otherwise hide the checkbox with the Claude-only flag still on the
  // line — and fire it at a CLI that rejects it (panel review, GLM).
  const staleSkipPermissions = hasStaleSkipPermissions(effectiveAgentCmd);

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

  const setRoleAt = useCallback((k: number, v: string) => {
    setRoles((prev) => {
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
    // §7 still holds — N environments with no prompt is a legitimate use — but
    // it is almost never what someone means when they have just filled in
    // titles and roles and forgotten the prompt. So it is confirmed, not
    // refused: press Launch again and it goes.
    if (promptAllEmpty && !confirmEmpty) {
      setConfirmEmpty(true);
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
        roles: Array.from({ length: n }, (_, k) => roles[k] ?? ''),
        repoPath: repoPath.trim(),
        agentCmd: effectiveAgentCmd,
        // 렌더러 신뢰 신원(§2 — channelLocal과 동일 trust basis). owner = 생성자
        // (스펙 §5.1 born-owned=createdBy)라 활성 워크스페이스로 고정한다. CEO 자동
        // 승격은 하지 않는다(생성자 소유권을 CEO로 뭉개면 born-owned 계약 위반).
        verifiedWorkspaceId: workspace?.id ?? '',
      });
      // Remember the command that actually launched (next dialog prefills it).
      // Only when a task really started: a preflight rejection launches nothing,
      // and overwriting the memory with it would lose a working command.
      if (didLaunch(res)) saveLastAgentCmd(effectiveAgentCmd);
      // owner(부모) ws id = fan-out을 실행한 대상 워크스페이스(§5.1 born-owned).
      reportResult(res, pushToast, workspace?.id ?? '');
      // fan-out 완료 직후 미션 캐시 즉시 refetch(순수 pull이라 push가 없다 —
      // 배경 폴링을 기다리지 않고 사이드바 "Missions" 섹션을 바로 채운다).
      const parentId = workspace?.id;
      if (parentId) void useStore.getState().refreshMissions(parentId);
      onClose();
    } catch (err) {
      pushToast({ level: 'error', message: t('fanout.failed', { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, prompt, promptOverCap, promptAllEmpty, confirmEmpty, repoPath, titles, effectiveTaskPrompts, roles, n, effectiveAgentCmd, workspace, pushToast, t]);

  const label = 'text-[11px] text-[var(--text-sub)] mb-1 block';

  return (
    <div
      // Portaled by ComposeHost — relative so the host's fixed position owns placement.
      // overflow-x-hidden is explicit: the sticky footer's `-mx-3` reaches past
      // the padding box, and `overflow-y-auto` alone computes overflow-x to
      // `auto` — which would hand a 420px dialog a horizontal scrollbar.
      className={`${align === 'right' ? 'ml-auto' : ''} relative z-50 max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl`}
      style={{ width: 'min(420px, calc(100vw - 24px))' }}
      data-testid="fanout-dialog"
    >
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
            {/* Title + role on one row, the derived branch name on its own line
                below. All three competed for a 420px dialog: the title Input
                was `flex-1` WITHOUT `min-w-0` (so its `min-width: auto` refused
                to shrink), the role select sizes to its longest option text,
                and the slug was `shrink-0` — the row overflowed the card, the
                title field collapsed to a sliver, and the slug left the dialog
                entirely. The slug is derived feedback, not an input, so it does
                not belong in the same competition. */}
            <div className="flex items-center gap-2 mb-1">
              <Input
                className="min-w-0 flex-1 text-[12px]"
                value={titles[k] ?? ''}
                onChange={(e) => setTitleAt(k, e.target.value)}
                data-testid={`fanout-title-${k}`}
              />
              {/* Per-task role. The agent + model each role launches on is the
                  operator's own binding (Settings → role bindings), so the
                  option text names the bound agent: picking "Reviewer" here is
                  how one fan-out puts its review task on a different CLI than
                  its build tasks. Unbound roles stay selectable — the task then
                  launches on the command above, unchanged. */}
              {/* Bounded at both ends. The old floor (92px) was narrow enough
                  that a bound role — "Reviewer — claude" — was cut mid-word in
                  the closed select, which is the one state you read it in; the
                  ceiling stays so it cannot squeeze the title field. */}
              <select
                aria-label={t('fanout.roleLabel', { k: k + 1 })}
                className="ui-input shrink-0 text-[11px] py-0.5"
                style={{ minWidth: 132, maxWidth: 168 }}
                value={roles[k] ?? ''}
                onChange={(e) => setRoleAt(k, e.target.value)}
                data-testid={`fanout-role-${k}`}
              >
                <option value="">{t('fanout.roleNone')}</option>
                {ORCH_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleBindings[r]?.agent ? `${r} — ${roleBindings[r]?.agent}` : r}
                  </option>
                ))}
              </select>
            </div>
            <div
              className="mb-1 truncate text-[10px] text-[var(--text-muted)] font-mono"
              title={`wtask/${previewSlug(titles[k] ?? '')}`}
              data-testid={`fanout-slug-${k}`}
            >
              wtask/{previewSlug(titles[k] ?? '') || '…'}
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
      <Input className="mb-2 font-mono text-[12px]" value={agentCmd} onChange={(e) => setAgentCmd(e.target.value)} data-testid="fanout-agent" />

      {canSkipPermissions ? (
        <label className="mb-1 flex items-center gap-2 cursor-pointer select-none text-[11px] text-[var(--text-sub)]">
          <input
            type="checkbox"
            checked={skipPermissions}
            // Toggle the EFFECTIVE command, not the raw field: with the field
            // empty the preview already reads `claude`, so toggling the raw ''
            // silently did nothing (panel review, Codex).
            onChange={(e) => setAgentCmd(applySkipPermissions(effectiveAgentCmd, e.target.checked))}
            style={{ accentColor: 'var(--accent-cursor)', cursor: 'pointer', margin: 0 }}
            data-testid="fanout-skip-permissions"
          />
          <span className="font-mono">{SKIP_PERMISSIONS_FLAG}</span>
        </label>
      ) : staleSkipPermissions ? (
        <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--accent-red)]" data-testid="fanout-skip-permissions-stale">
          <span>{t('fanout.skipPermissionsStale', { agent: fanoutAgentStem(effectiveAgentCmd) })}</span>
          <button
            type="button"
            className="shrink-0 rounded-[4px] border border-[var(--bg-overlay)] px-1.5 py-0.5 text-[10px] text-[var(--text-sub)] hover:border-[var(--text-muted)]"
            onClick={() => setAgentCmd(applySkipPermissions(effectiveAgentCmd, false))}
            data-testid="fanout-skip-permissions-strip"
          >
            {t('fanout.skipPermissionsStrip')}
          </button>
        </div>
      ) : (
        <div className="mb-1 text-[10px] text-[var(--text-muted)]" data-testid="fanout-skip-permissions-unsupported">
          {t('fanout.skipPermissionsUnsupported')}
        </div>
      )}
      {skipPermissions && canSkipPermissions && (
        <div className="mb-1 text-[10px] text-[var(--accent-red)]">{t('fanout.skipPermissionsWarning')}</div>
      )}

      {/* Launch command — the line the task pane fires, and the value remembered
          for the next fan-out. main appends the prompt file as one argument
          (FanOutService.buildInitialCommand), so show that too rather than
          claiming a bare agent command is the whole line (panel review, 2/2). */}
      <label className={label}>{t('fanout.commandPreviewLabel')}</label>
      <code
        className="mb-3 block rounded-[4px] border border-[var(--bg-overlay)] bg-[var(--bg-base)] px-1.5 py-1 font-mono text-[11px] text-[var(--text-sub)] select-text"
        style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
        data-testid="fanout-command-preview"
      >
        {effectiveAgentCmd}
        {!promptAllEmpty && (
          <span className="text-[var(--text-muted)]"> {t('fanout.commandPreviewPromptArg')}</span>
        )}
      </code>

      {confirmEmpty && (
        <div
          className="mb-2 rounded-[4px] border border-[var(--accent-amber,var(--accent))] px-2 py-1 text-[10px] text-[var(--text-sub)]"
          role="alert"
          data-testid="fanout-confirm-empty"
        >
          {t('fanout.confirmEmpty', { n })}
        </div>
      )}

      {/* Pinned footer. The dialog is a 70vh scroll container, so with the
          actions in normal flow the primary action sat below the fold — you
          had to scroll a form to find out how to submit it. Sticky keeps
          Launch reachable at every scroll position; the negative margins undo
          the dialog's own padding so the bar spans the full width and content
          scrolls under it rather than beside it. */}
      <div className="sticky bottom-0 -mx-3 -mb-3 flex items-center justify-end gap-2 border-t border-[var(--bg-overlay)] bg-[var(--bg-mantle)] px-3 py-2">
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

/** Whether the call actually started a task — a rejected or all-failed fan-out
 *  must not overwrite the remembered command. */
function didLaunch(res: unknown): boolean {
  const r = (res ?? {}) as FanOutResultLike;
  if (r.error) return false;
  return (r.tasks ?? []).some((task) => task.ok);
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

  // F5 — ONE toast for the diff entry point, not one per task. A fan-out of 8
  // pushed 8 identical-looking cards on top of the summary that had just been
  // posted, so the summary was off-screen before it could be read and the
  // "open diff" action was 8 races to click the right card. The action now
  // opens the first ready task's diff; the rest are one click away in the
  // sidebar's task list, which is where they live permanently anyway.
  const ready = tasks.filter((task) => task.ok && task.taskId && task.workspaceId);
  const first = ready[0];
  if (!first) return;
  const taskId = first.taskId as string;
  const workspaceId = first.workspaceId as string;
  const title = first.title ?? taskId;
  pushToast({
    level: 'info',
    message: ready.length === 1 ? t('fanout.taskReady', { title }) : t('fanout.tasksReady', { count: ready.length }),
    action: {
      label: ready.length === 1 ? t('fanout.openDiff') : t('fanout.openFirstDiff'),
      onClick: () => openTaskDiff(taskId, workspaceId, title, ownerWorkspaceId),
    },
  });
}
