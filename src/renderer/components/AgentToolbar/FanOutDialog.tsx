// J1 §7 Multi Task (parallel work) dialog. Opens N(1~8) isolated tasks at once.
//
// mode toggle (compete/parallel) is a pure UI emphasis switch — service always combines
// shared+individual prompts when firing (compete only hides individual fields, same combine rule),
// so toggle does not grow state machine. Does not reject when all prompts empty (§7 "environment-only"
// — open worktree·agent pane only, human enters prompt).
//
// Input: shared prompt, per-task title+prompt (auto-derived + editable), N (click 1~8),
// repo path (default: active ws cwd), agentCmd (default claude), branch prefix preview, idempotency key
// issued once on submit. No isolation-off toggle (§6 C10 — broadcast is separate entry).

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

// Review finding (Codex+GLM+Claude 3/3 consensus) — in compete mode putting inline array literal
// like `mode === 'parallel' ? taskPrompts : []` in useEffect deps creates new reference every render
// causing infinite effect loop (effect→setState(new array)→re-render→new []→
// effect... "Maximum update depth exceeded"). Pin reference with module constant.
const EMPTY_TASK_PROMPTS: readonly string[] = [];

/** Auto-derived title: "{first 24 chars of prompt} #k" (§7 G6). */
function deriveTitle(prompt: string, k: number): string {
  const head = prompt.trim().slice(0, 24).replace(/\s+/g, ' ').trim();
  return head.length > 0 ? `${head} #${k + 1}` : `task #${k + 1}`;
}

/** Slug for branch preview (same shape as TaskWorktreeManager.titleToSlug — preview only). */
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
  /** Anchor alignment — right-align in narrow deck control bar to prevent left overflow. */
  align?: 'left' | 'right';
}

export default function FanOutDialog({ onClose, align = 'left' }: FanOutDialogProps) {
  const t = useT();
  const activeWorkspace = useStore(selectActiveWorkspace);
  const pushToast = useStore((s) => s.pushToast);

  const defaultRepo = activeWorkspace?.metadata?.cwd ?? '';

  // 'compete' = same work N times (compete — shared prompt only), 'parallel' = N different works
  // (parallel — per-task prompts). Not mutually exclusive UI (service always combines shared+individual);
  // dialog only changes which fields are emphasized·shown (§7 review).
  const [mode, setMode] = useState<'compete' | 'parallel'>('parallel');
  const [prompt, setPrompt] = useState('');
  const [n, setN] = useState(2);
  const [titles, setTitles] = useState<string[]>([]);
  const [titlesEdited, setTitlesEdited] = useState<boolean[]>([]);
  const [taskPrompts, setTaskPrompts] = useState<string[]>([]);
  const [repoPath, setRepoPath] = useState(defaultRepo);
  const [agentCmd, setAgentCmd] = useState('claude');
  const [submitting, setSubmitting] = useState(false);

  // Reflect when repo default loads late.
  useEffect(() => {
    if (!repoPath && defaultRepo) setRepoPath(defaultRepo);
  }, [defaultRepo, repoPath]);

  // In compete mode hide per-task fields so do not send to service either (values entered in
  // parallel mode stay in state — revive on switch back). Review finding
  // (3/3 consensus): must not create new [] every render — pin stable reference (EMPTY_TASK_PROMPTS).
  const effectiveTaskPrompts = mode === 'parallel' ? taskPrompts : EMPTY_TASK_PROMPTS;

  // On N·prompt change auto-derive unedited titles only (preserve edits). When per-task prompt
  // exists derive from it (individual prompt is source of truth for task identity).
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
  // Per-task effective prompt = shared + individual (omit empty side) — same as FanOutService combine rule.
  const effectiveBytes = useMemo(() => {
    const enc = new TextEncoder();
    return Array.from({ length: n }, (_, k) => {
      const combined = [prompt.trim(), (effectiveTaskPrompts[k] ?? '').trim()].filter((p) => p.length > 0).join('\n\n');
      return enc.encode(combined).length;
    });
  }, [n, prompt, effectiveTaskPrompts]);
  const promptOverCap = effectiveBytes.some((b) => b > FANOUT_PROMPT_MAX_BYTES);
  // Informational hint only — does not block submit (§7 — environment-only is valid).
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
    // §7: do not reject when all prompts empty — "environment-only"(worktree·agent
    // pane only, human enters prompt) is valid. Client also blocks only cap exceed.
    if (promptOverCap) {
      pushToast({ level: 'warn', message: t('fanout.errPromptTooLarge', { max: FANOUT_PROMPT_MAX_BYTES }) });
      return;
    }
    if (!repoPath.trim()) {
      pushToast({ level: 'warn', message: t('fanout.errRepoRequired') });
      return;
    }
    setSubmitting(true);
    // Issue per-call idempotency key once (§2 G1) — double-click·retry cannot stamp N worktrees.
    const idempotencyKey = generateId('fanout');
    try {
      const res = await window.electronAPI.fanout.start({
        idempotencyKey,
        prompt,
        titles: titles.slice(0, n),
        taskPrompts: Array.from({ length: n }, (_, k) => effectiveTaskPrompts[k] ?? ''),
        repoPath: repoPath.trim(),
        agentCmd: agentCmd.trim() || 'claude',
        // Renderer-trusted identity (§2 — same trust basis as channelLocal). owner = creator
        // (spec §5.1 born-owned=createdBy) so pinned to active workspace. No CEO auto
        // promotion (merging creator ownership into CEO violates born-owned contract).
        verifiedWorkspaceId: activeWorkspace?.id ?? '',
      });
      // owner (parent) ws id = active workspace that ran fan-out (§5.1 born-owned).
      reportResult(res, pushToast, activeWorkspace?.id ?? '');
      // Immediate mission cache refetch after fan-out (pure pull, no push —
      // fill sidebar "Missions" without waiting for background poll).
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
    <div
      // Fixed 420px width clips in 248–320px deck control bar → viewport clamp.
      className={`absolute bottom-full mb-2 ${align === 'right' ? 'right-2' : 'left-2'} z-50 max-h-[70vh] overflow-y-auto rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl`}
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

/** Result report → toast (distinguish unmaterialized·channel disconnected·prompt not fired — §7). */
interface FanOutResultLike {
  ok?: boolean;
  error?: string;
  tasks?: Array<{
    ok?: boolean;
    title?: string;
    error?: string;
    unmaterialized?: boolean;
    channelDisconnected?: boolean;
    // F5 — diff entry material (returned from FanOutTaskResult).
    taskId?: string;
    workspaceId?: string;
    worktreePath?: string;
    // J3 §3 — onExhausted toast mapping material (ptyId→task).
    ptyId?: string;
    // F2 — original initialCommand for retry (agent launch+prompt injection).
    initialCommand?: string;
  }>;
}

type PushToast = (t: {
  level: 'info' | 'warn' | 'error';
  message: string;
  action?: { label: string; onClick: () => void };
}) => string;

// F5 — open diff surface on first leaf pane of task workspace. Silently ignore when workspace
// not yet present or no leaf (race). F1: carry owner (parent) ws id on surface so
// close/PR/resolveTaskMeta call owner-scoped RPC with correct identity.
function openTaskDiff(taskId: string, workspaceId: string, title: string, ownerWorkspaceId: string): void {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const leaf = findLeafPanes(ws.rootPane)[0];
  if (!leaf) return;
  st.addDiffSurface(leaf.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
  // Switch to task workspace so opened diff is immediately visible.
  st.setActiveWorkspace(workspaceId);
}

function reportResult(res: unknown, pushToast: PushToast, ownerWorkspaceId: string): void {
  const r = (res ?? {}) as FanOutResultLike;
  if (r.error) {
    pushToast({ level: 'error', message: t('fanout.rejected', { error: r.error }) });
    return;
  }
  const tasks = r.tasks ?? [];

  // J3 §3 — register ptyId→task mapping for onExhausted toast (fire failure notice arrives
  // async after fan-out return so keep in store). Skip tasks without ptyId.
  // F2: retry must resend original initialCommand (agent launch+prompt injection) not raw prompt
  // so carry initialCommand too.
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

  // F5 — "open diff" action toast per materialized success task. Only tasks with
  // workspaceId·taskId filled (need workspace to open surface).
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
