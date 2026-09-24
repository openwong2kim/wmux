// ─── 루프 설정 모달 — objective / steps(스킬 픽커) / done-when / 고급 ─────────
//
// 도크 인라인 폼(248~320px)은 컨트롤 4개가 한 줄에서 넘쳐 Start 버튼이 화면
// 밖으로 밀리는 실사용 결함이 있었다. 설정은 이 오버레이 모달로 승격하고,
// 도크에는 루프 상태 카드만 남는다(DeckLoopPanel).
//
// 3축 모델:
//   objective — 왜(방향). 필수.
//   steps     — 매 iteration의 절차(선택). 각 step은 자유 텍스트이며 "/"로
//               시작하면 pane 에이전트의 스킬/커맨드 카탈로그(.claude/skills·
//               commands 스캔)에서 자동완성된다. 스킬 실행의 의미는 "pane에
//               그 커맨드를 타이핑"(그라운딩 규칙) — 여기서 고르는 건 절차의
//               표기이지 오케 권한이 아니다.
//   done-when — 종료 조건(선택, 사람이 체크).
// 고급 행(tier/iterations/cadence)은 모달 폭에서 여유 있게 배치된다.
//
// 순수 UI: 모든 IPC는 주입된 api로만(jsdom 테스트 가능). Esc/백드롭 닫기.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Badge from '../ui/Badge';
import { IconCheck, IconPlus, IconWarning, IconX } from '../icons';
import type { LoopTier } from '../../../main/deck/deckLoopStateStore';
import type { SkillCatalogEntry } from '../../../main/deck/skillCatalogScan';
import type { AgentMode } from '../../../main/deck/deckAutonomyStore';
import type { AgentModeApi } from './AgentModeChip';
import type { DeckLoopApi } from './DeckLoopPanel';

const CADENCE_OPTIONS: { minutes: number; labelKey: string; fallback: string }[] = [
  { minutes: 0, labelKey: 'deck.loopCadenceOff', fallback: 'Events only' },
  { minutes: 30, labelKey: 'deck.loopCadence30m', fallback: 'Every 30 min' },
  { minutes: 60, labelKey: 'deck.loopCadence1h', fallback: 'Every hour' },
  { minutes: 360, labelKey: 'deck.loopCadence6h', fallback: 'Every 6 hours' },
  { minutes: 1440, labelKey: 'deck.loopCadence24h', fallback: 'Every day' },
];

/** "/qa" 류 step 입력에 대한 스킬 자동완성 후보(순수 — 테스트 대상). */
export function filterSkillSuggestions(
  catalog: readonly SkillCatalogEntry[],
  input: string,
  max = 8,
): SkillCatalogEntry[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const q = trimmed.slice(1).toLowerCase();
  return catalog
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, max);
}

export function DeckLoopModal({
  api,
  workspaceId,
  cwd,
  modeApi,
  onClose,
  onStarted,
  t: tProp,
}: {
  api: DeckLoopApi;
  workspaceId?: string;
  /** 스킬 카탈로그 스캔 기준 cwd(활성 pane) — 없으면 사용자 전역만 나온다. */
  cwd?: string;
  /** Workspace agent-mode reader (same bridge AgentModeChip uses). Injected so
   *  the modal can PREVIEW the loop's effective authority — a loop's real caps
   *  are min(modeCeiling, tier), and the press capability lives on the mode, not
   *  this dialog. Absent (older container / pure jsdom parent) → no preview. */
  modeApi?: AgentModeApi;
  onClose: () => void;
  /** START 성공 후(도크 상태카드 갱신용). */
  onStarted: () => void;
  t?: (key: string) => string;
}): React.ReactElement {
  const t = tProp ?? (() => '');
  const [objective, setObjective] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [doneWhen, setDoneWhen] = useState('');
  // Default to `continue`: "Start a loop" is an action verb, and a report-only
  // loop reads as inert on first use ("it did nothing"). Safe to default active
  // because the dangerous caps are gated on the workspace MODE, not this tier
  // (min(modeCeiling, tier)) — a continue loop presses only under an auto mode.
  const [tier, setTier] = useState<LoopTier>('continue');
  const [cadence, setCadence] = useState(0);
  const [iterations, setIterations] = useState(25);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  /** 자동완성이 열려 있는 step index (없으면 -1). */
  const [suggestFor, setSuggestFor] = useState(-1);
  /** Workspace agent mode — snapshot at open, for the authority preview. */
  const [mode, setMode] = useState<AgentMode | null>(null);
  const objectiveRef = useRef<HTMLInputElement>(null);

  // Read the workspace mode once so the preview can show the loop's real reach
  // (caps compose as min(modeCeiling, tier)). Fail-soft: no api → no preview.
  useEffect(() => {
    if (!modeApi || !workspaceId) return;
    let alive = true;
    modeApi
      .get(workspaceId)
      .then((r) => { if (alive) setMode(r.mode ?? 'off'); })
      .catch(() => { if (alive) setMode(null); });
    return () => { alive = false; };
  }, [modeApi, workspaceId]);

  // 스킬 카탈로그 — 모달 열릴 때 1회 스캔(읽기 전용, fail-soft 빈 목록).
  useEffect(() => {
    let alive = true;
    if (api.skills) {
      api.skills(cwd ?? '').then((r) => {
        if (alive) setCatalog(r.skills);
      }).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [api, cwd]);

  const setStep = useCallback((idx: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? value : s)));
  }, []);
  const removeStep = useCallback((idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
    setSuggestFor(-1);
  }, []);

  const handleStart = async (): Promise<void> => {
    setError(null);
    if (!workspaceId) {
      setError(t('deck.loopNoWorkspace') || 'Open a workspace first — a loop belongs to a workspace.');
      return;
    }
    if (!objective.trim()) {
      setError(t('deck.loopNeedsObjective') || 'Give the loop an objective.');
      return;
    }
    const taskTexts = doneWhen
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const stepTexts = steps.map((s) => s.trim()).filter((s) => s.length > 0);
    const res = await api.start({
      workspaceId,
      objective,
      ...(stepTexts.length > 0 ? { steps: stepTexts } : {}),
      ...(taskTexts.length > 0 ? { taskTexts } : {}),
      tier,
      ...(cadence > 0 ? { intervalMinutes: cadence } : {}),
      ...(Number.isFinite(iterations) && iterations >= 1 ? { iterations: Math.floor(iterations) } : {}),
    });
    if (!res.ok) {
      setError(t('deck.loopStartFailed') || 'Could not start the loop.');
      return;
    }
    onStarted();
    onClose();
  };

  // Focus, Escape (never mid-IME) and the backdrop come from ui/Dialog; the
  // objective field takes focus on open.
  return (
    <div className="contents" data-deck-loop-modal>
      <Dialog
        onClose={onClose}
        closeOnBackdrop
        width={520}
        initialFocusRef={objectiveRef}
        zIndexClassName="z-50"
      >
        <DialogHeader
          title={t('deck.loopModalTitle') || 'Start a loop'}
          closeLabel={t('deck.loopModalClose') || 'Close'}
        />
        <DialogBody>
          <Field label={t('deck.loopObjective') || 'Objective'} layout="stacked">
            <Input
              ref={objectiveRef}
              type="text"
              data-deck-loop-objective-input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder={t('deck.loopObjectivePlaceholder') || 'What should this loop accomplish? e.g. keep CI green on this branch'}
              className="w-full text-[13px]"
            />
          </Field>

          {/* Steps — each iteration's procedure (optional) + skill autocomplete */}
          <section>
            <p className="ui-group-label">{t('deck.loopSteps') || 'Steps — each iteration (optional)'}</p>
            <div className="flex flex-col gap-2">
              {steps.map((step, idx) => {
                const suggestions = suggestFor === idx ? filterSkillSuggestions(catalog, step) : [];
                return (
                  <div key={idx} className="relative">
                    <div className="flex items-center gap-2">
                      <span className="w-4 text-right text-[11px] tabular-nums text-[var(--text-sub)]">{idx + 1}.</span>
                      <Input
                        type="text"
                        data-deck-loop-step
                        value={step}
                        onChange={(e) => {
                          setStep(idx, e.target.value);
                          setSuggestFor(idx);
                        }}
                        onFocus={() => setSuggestFor(idx)}
                        onBlur={() => window.setTimeout(() => setSuggestFor((v) => (v === idx ? -1 : v)), 150)}
                        placeholder={t('deck.loopStepPlaceholder') || 'e.g. run /qa, or: fix whatever the tests report'}
                        className="min-w-0 flex-1 font-mono text-[12px]"
                      />
                      <Button
                        variant="icon"
                        className="w-8 h-8 shrink-0"
                        onClick={() => removeStep(idx)}
                        aria-label={t('deck.loopStepRemove') || 'Remove step'}
                      >
                        <IconX size={12} />
                      </Button>
                    </div>
                    {/* "/..." shows the pane agent's skills and commands. */}
                    {suggestions.length > 0 && (
                      <div
                        data-deck-loop-skill-suggest
                        className="ui-popover absolute left-6 right-10 mt-1 z-10"
                      >
                        {suggestions.map((s) => (
                          <button
                            key={`${s.source}:${s.name}`}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault(); // select before the input blurs.
                              setStep(idx, `/${s.name}`);
                              setSuggestFor(-1);
                            }}
                            className="ui-section-row w-full text-left text-[12px]"
                          >
                            <span className="font-mono text-[var(--text-main)]">/{s.name}</span>
                            {s.description && (
                              <span className="min-w-0 flex-1 truncate text-[var(--text-sub)]">
                                {s.description.slice(0, 60)}
                              </span>
                            )}
                            <Badge className="ml-auto">
                              {s.source === 'project' ? (t('deck.loopSkillProject') || 'project') : (t('deck.loopSkillUser') || 'user')}
                            </Badge>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="ghost"
                className="self-start gap-1"
                data-deck-loop-step-add
                onClick={() => setSteps((prev) => [...prev, ''])}
              >
                <IconPlus size={12} />
                {t('deck.loopStepAdd') || 'Add step'}
              </Button>
              <p className="m-0 text-[11px] leading-4 text-[var(--text-sub)]">
                {t('deck.loopStepsHint') ||
                  'Steps starting with "/" pick from the pane agent\'s skills — running one means the orchestrator types it into the pane.'}
              </p>
            </div>
          </section>

          <Field label={t('deck.loopDoneWhen') || 'Done when (optional)'} layout="stacked">
            <textarea
              data-deck-loop-donewhen
              value={doneWhen}
              onChange={(e) => setDoneWhen(e.target.value)}
              rows={3}
              placeholder={t('deck.loopDoneWhenPlaceholder') || 'One item per line — you tick these off; the loop is done when all pass.'}
              className="ui-input w-full text-[13px] resize-y"
            />
          </Field>

          {/* Run settings — fit on one row at the modal's width. */}
          <div className="flex items-center gap-2 flex-wrap text-[13px]">
            <Select
              data-deck-loop-tier
              value={tier}
              onChange={(e) => setTier(e.target.value === 'continue' ? 'continue' : 'report')}
              aria-label={t('deck.loopTier') || 'Autonomy'}
            >
              <option value="report">{t('deck.loopTierReport') || 'Report only'}</option>
              <option value="continue">{t('deck.loopTierContinue') || 'Continue (may nudge panes)'}</option>
            </Select>
            <label
              className="flex items-center gap-1.5 whitespace-nowrap text-[var(--text-sub)]"
              title={t('deck.loopIterations') || 'How many times the loop may auto-wake to work before it pauses for you (one wake ≈ one iteration). Raise it for long unattended runs.'}
            >
              {t('deck.loopIterationsLabel') || 'pause after'}
              <Input
                type="number"
                data-deck-loop-iterations
                value={iterations}
                min={1}
                max={100}
                onChange={(e) => setIterations(Number(e.target.value))}
                className="text-[13px] tabular-nums"
                style={{ width: 64 }}
              />
              {t('deck.loopIterationsUnit') || 'auto-wakes'}
            </label>
            <Select
              data-deck-loop-cadence
              value={cadence}
              onChange={(e) => setCadence(Number(e.target.value))}
              aria-label={t('deck.loopCadence') || 'Cadence'}
            >
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>
                  {t(o.labelKey) || o.fallback}
                </option>
              ))}
            </Select>
          </div>

          {/* Effective-authority preview — a loop's real caps are
              min(modeCeiling, tier), and press lives on the workspace MODE, not
              this dialog. Spell out what THIS loop will actually be allowed to do
              so the mode↔loop dependency isn't invisible (dogfood: users set up a
              "continue" loop expecting unattended approvals, then it stalled on
              the first prompt because the workspace was only Assist). */}
          {mode && (() => {
            const driving = tier === 'continue';
            const drivePanes = driving && (mode === 'assist' || mode === 'danger');
            const pressApprovals = driving && mode === 'danger';
            const mark = (on: boolean) => (
              <span aria-hidden="true" className={on ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}>
                {on ? <IconCheck size={12} /> : <IconX size={12} />}
              </span>
            );
            return (
              <div
                data-deck-loop-authority
                data-mode={mode}
                className="ui-notice flex flex-col gap-1.5 px-3.5 py-3 text-[13px]"
              >
                <p className="m-0 text-[var(--text-sub)]">
                  {t('deck.loopAuthorityIntro') || 'This loop will'} · {t('deck.mode.label') || 'Mode'}: {t(`deck.mode.${mode}`) || mode}
                </p>
                <div className="flex items-center gap-4 text-[var(--text-main)]">
                  <span className="flex items-center gap-1.5" data-deck-loop-auth-drive={drivePanes ? 'on' : 'off'}>
                    {mark(drivePanes)} {t('deck.loopAuthDrive') || 'drive panes'}
                  </span>
                  <span className="flex items-center gap-1.5" data-deck-loop-auth-press={pressApprovals ? 'on' : 'off'}>
                    {mark(pressApprovals)} {t('deck.loopAuthPress') || 'press approvals'}
                  </span>
                </div>
                {mode === 'off' ? (
                  <p className="m-0 flex items-start gap-1.5 text-[11px] leading-4" style={{ color: 'var(--accent-yellow)' }}>
                    <span className="shrink-0 pt-0.5"><IconWarning size={12} /></span>
                    {t('deck.loopAuthModeOff') ||
                      'Workspace mode is Off — raise it to Assist or Danger, or the loop stays idle.'}
                  </p>
                ) : !driving ? (
                  <p className="m-0 text-[11px] leading-4 text-[var(--text-sub)]">
                    {t('deck.loopAuthReport') || 'Report only — it observes and summarizes; it won’t touch panes.'}
                  </p>
                ) : mode !== 'danger' ? (
                  <p className="m-0 text-[11px] leading-4 text-[var(--text-sub)]">
                    {t('deck.loopAuthRaiseAuto') ||
                      'Raise the workspace to Danger to let it press approvals unattended.'}
                  </p>
                ) : null}
              </div>
            );
          })()}

          {error && (
            <p role="alert" data-deck-loop-error className="ui-row-error text-[13px] leading-5 !m-0">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="md" variant="primary" data-deck-loop-start onClick={() => void handleStart()}>
            {t('deck.loopStart') || 'Start loop'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

export default DeckLoopModal;
