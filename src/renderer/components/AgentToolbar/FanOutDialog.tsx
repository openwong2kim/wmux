// J1 §7 fan-out 다이얼로그. 프롬프트 1개 → N(1~8) 격리 태스크.
//
// 입력: 프롬프트(textarea), N, 태스크별 title(자동 파생 + 편집), repo 경로(기본:
// 활성 ws cwd), agentCmd(기본 claude), 브랜치 접두 미리보기, 멱등키 발급(제출 1회).
// 격리 해제 토글은 두지 않는다(§6 C10 — broadcast는 별개 진입).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { generateId } from '../../../shared/types';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';

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
      pushToast({ level: 'warn', message: 'fan-out: 프롬프트를 입력하세요' });
      return;
    }
    if (promptOverCap) {
      pushToast({ level: 'warn', message: `fan-out: 프롬프트가 ${FANOUT_PROMPT_MAX_BYTES}바이트를 초과합니다` });
      return;
    }
    if (!repoPath.trim()) {
      pushToast({ level: 'warn', message: 'fan-out: repo 경로가 필요합니다' });
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
      reportResult(res, pushToast);
      // fan-out 완료 직후 미션 캐시 즉시 refetch(순수 pull이라 push가 없다 —
      // 배경 폴링을 기다리지 않고 사이드바 "Missions" 섹션을 바로 채운다).
      const parentId = activeWorkspace?.id;
      if (parentId) void useStore.getState().refreshMissions(parentId);
      onClose();
    } catch (err) {
      pushToast({ level: 'error', message: `fan-out 실패: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, prompt, promptOverCap, repoPath, titles, n, agentCmd, activeWorkspace, pushToast, onClose]);

  const field = 'w-full px-2 py-1 rounded border border-[var(--bg-overlay)] bg-[var(--bg-surface)] text-[12px] text-[var(--text-main)]';
  const label = 'text-[11px] text-[var(--text-sub)] mb-1 block';

  return (
    <div className="absolute bottom-full mb-2 left-2 z-50 w-[420px] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl" data-testid="fanout-dialog">
      <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">Fan-out — 프롬프트 1개 → N 격리 태스크</div>

      <label className={label}>프롬프트</label>
      <textarea
        className={`${field} h-24 resize-none font-mono`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="모든 태스크가 받을 프롬프트…"
        data-testid="fanout-prompt"
      />
      <div className={`text-[10px] mb-2 ${promptOverCap ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
        {promptBytes} / {FANOUT_PROMPT_MAX_BYTES} bytes
      </div>

      <label className={label}>태스크 수 (N): {n}</label>
      <input
        type="range"
        min={1}
        max={FANOUT_MAX_TASKS}
        value={n}
        onChange={(e) => setN(Number(e.target.value))}
        className="w-full mb-2"
        data-testid="fanout-n"
      />

      <label className={label}>태스크별 제목 (편집 가능 — 브랜치·slug 식별)</label>
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

      <label className={label}>repo 경로</label>
      <input className={`${field} mb-2 font-mono`} value={repoPath} onChange={(e) => setRepoPath(e.target.value)} data-testid="fanout-repo" />

      <label className={label}>agent 명령</label>
      <input className={`${field} mb-3 font-mono`} value={agentCmd} onChange={(e) => setAgentCmd(e.target.value)} data-testid="fanout-agent" />

      <div className="flex items-center justify-end gap-2">
        <button className="px-3 py-1 rounded text-[11px] text-[var(--text-sub)] hover:text-[var(--text-main)]" onClick={onClose}>
          취소
        </button>
        <button
          className="px-3 py-1 rounded text-[11px] bg-[var(--accent-blue)] text-white disabled:opacity-40"
          disabled={submitting || promptOverCap}
          onClick={handleSubmit}
          data-testid="fanout-submit"
        >
          {submitting ? '스폰 중…' : `${n}개 스폰`}
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
  }>;
}

function reportResult(
  res: unknown,
  pushToast: (t: { level: 'info' | 'warn' | 'error'; message: string }) => string,
): void {
  const r = (res ?? {}) as FanOutResultLike;
  if (r.error) {
    pushToast({ level: 'error', message: `fan-out 거부: ${r.error}` });
    return;
  }
  const tasks = r.tasks ?? [];
  const ok = tasks.filter((t) => t.ok).length;
  const fail = tasks.length - ok;
  const unmaterialized = tasks.filter((t) => t.unmaterialized).length;
  const disconnected = tasks.filter((t) => t.ok && t.channelDisconnected).length;

  const parts: string[] = [`fan-out: 성공 ${ok}` + (fail > 0 ? ` · 실패 ${fail}` : '')];
  if (unmaterialized > 0) parts.push(`미물질화 ${unmaterialized}`);
  if (disconnected > 0) parts.push(`채널 미연결 ${disconnected}`);
  pushToast({
    level: fail > 0 ? 'error' : disconnected > 0 || unmaterialized > 0 ? 'warn' : 'info',
    message: parts.join(' · '),
  });
}
