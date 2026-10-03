import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  AUTOMATION_DEFAULTS,
  type Automation,
  type AutomationAgent,
  type AutomationPermissionMode,
} from '../../../shared/automation';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';
import SegmentedControl from '../ui/SegmentedControl';
import Popover from '../ui/Popover';
import { Icon, IconChevron, IconClock } from '../icons';
import { FOCUS_RING } from '../focusRing';
import {
  DAILY,
  daysForPreset,
  effectivePreset,
  toggleDay,
  deriveName,
  draftFromForm,
  emptyForm,
  formFromAutomation,
  grantNeeded,
  parseToolNames,
  presetOf,
  shouldWarnPermissionReset,
  usesToolList,
  validateForm,
  type FormProblem,
  type SchedulePreset,
  type ScheduleForm,
} from './scheduleModel';
import { BYPASS_DECLINED, agentLabel, describeDays, folderName, weekdayName } from './format';
import type { AccountOption } from './useAccounts';

type Chip = 'schedule' | 'folder' | 'agent';

/** Which part of the composer a validation problem is shown under. */
const PROBLEM_PLACE: Record<FormProblem, 'prompt' | Chip | 'more'> = {
  name: 'prompt',
  prompt: 'prompt',
  promptTooLong: 'prompt',
  cwd: 'folder',
  weekdays: 'schedule',
  time: 'schedule',
  grace: 'more',
  awaitTimeout: 'more',
  tools: 'more',
};

function FolderIcon() {
  return <Icon size={14}><path d="M1.5 4.5v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H7L5.5 3h-3a1 1 0 0 0-1 1.5Z" /></Icon>;
}

function AgentIcon() {
  return <Icon size={14}><rect x="2" y="3" width="10" height="8" rx="2" /><path d="M5 6.5h.01M9 6.5h.01M5.5 9h3" /></Icon>;
}

/**
 * The schedule composer — one prompt box and a row of chips, in the
 * Schedules page's right pane. The name follows the prompt's first line until
 * it is typed over; the schedule, folder and agent chips each open a small
 * popover; model, effort, permission and the run limits wait behind More
 * options at their defaults. Permission is never part of the draft: saving
 * updates the schedule first and then calls automation.grant, so the grant
 * lands on the revision the update produced.
 */
export default function ScheduleEditor({ original, review, accounts, initial, onClose, onSaved }: {
  original: Automation | null;
  /** A draft an agent proposed: saving also turns it on. */
  review: boolean;
  accounts: AccountOption[];
  /** A new schedule's starting values (a template, the current folder). */
  initial?: ScheduleForm;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<ScheduleForm>(() => (original ? formFromAutomation(original) : initial ?? emptyForm()));
  // A new schedule's name follows its prompt until the user writes one.
  const [nameTouched, setNameTouched] = useState(() => original !== null || Boolean(initial?.name));
  const [permissionTouched, setPermissionTouched] = useState(false);
  // The schedule chip's mode as the user picked it (null: read from the days).
  const [pickedPreset, setPickedPreset] = useState<SchedulePreset | null>(null);
  // Set once create succeeded: a failed grant/enable retry must update this
  // schedule, never create a second one.
  const [created, setCreated] = useState<Automation | null>(null);
  const [more, setMore] = useState(false);
  const [chip, setChip] = useState<Chip | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);
  const api = window.electronAPI?.automation;

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setPrompt = (prompt: string) =>
    setForm((f) => ({ ...f, prompt, ...(nameTouched ? {} : { name: deriveName(prompt) }) }));
  const problems = validateForm(form);
  const tools = parseToolNames(form.toolsText);
  const warnReset = shouldWarnPermissionReset(original, form, permissionTouched);
  const vendorAccounts = accounts.filter((a) => a.vendor === form.agent);
  const shown = (place: 'prompt' | Chip | 'more') => (showProblems
    ? problems.filter((p) => PROBLEM_PLACE[p] === place).map((p) => t(`schedules.problem.${p}`)).join(' ')
    : '');

  // A chip's popover closes on a click outside the chip row, or on Escape.
  useEffect(() => {
    if (!chip) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!chipsRef.current?.contains(e.target as Node)) setChip(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [chip]);

  // Bypass is confirmed by main at grant time (a native prompt no renderer
  // path can skip), so picking it here only records the choice.
  const pickMode = (mode: AutomationPermissionMode) => {
    setPermissionTouched(true);
    set('mode', mode);
  };

  const pickFolder = async () => {
    const picked = await window.electronAPI?.dialog?.pickFolder?.();
    if (picked && picked[0]) set('cwd', picked[0]);
  };

  const setAgent = (agent: AutomationAgent) =>
    setForm((f) => ({
      ...f,
      agent,
      accountId: accounts.some((a) => a.id === f.accountId && a.vendor === agent) ? f.accountId : '',
    }));

  const save = async () => {
    if (problems.length > 0) {
      setShowProblems(true);
      if (problems.some((p) => PROBLEM_PLACE[p] === 'more')) setMore(true);
      return;
    }
    if (!api) return;
    setSaving(true);
    setError(null);
    const fail = (message: string, raw = true) => {
      setError(raw ? t('schedules.error', { error: message }) : message);
      void useStore.getState().refreshSchedules();
    };
    try {
      const draft = draftFromForm(form);
      const base = original ?? created;
      const needsGrant = grantNeeded(base, form, permissionTouched);
      let id: string;
      if (base) {
        const saved = await api.update(base.id, draft);
        if (!saved.ok) return fail(saved.error);
        id = saved.automation.id;
      } else {
        // Created disabled (atomically, no nextRunAt): it cannot fire before
        // its grant lands, and turns on only once everything succeeded.
        const saved = await api.create(draft, false);
        if (!saved.ok) return fail(saved.error);
        id = saved.automation.id;
        setCreated(saved.automation);
      }
      if (needsGrant) {
        const granted = await api.grant(id, form.mode, usesToolList(form) ? tools.tools : undefined);
        if (!granted.ok && granted.error === BYPASS_DECLINED) {
          // The human declined main's Bypass prompt. A new schedule stays
          // saved and off; an edit keeps whatever permission it had.
          if (!original) {
            useStore.getState().pushToast({ level: 'info', message: t('schedules.bypassDeclinedNew') });
            void useStore.getState().refreshSchedules();
            onSaved(id);
            return;
          }
          return fail(t('schedules.bypassDeclinedEdit'), false);
        }
        if (!granted.ok) return fail(granted.error);
      }
      // A new schedule is saved to run; a reviewed draft is enabled by the
      // human here, which is what clears its proposed mark.
      if (!original || review) {
        const enabled = await api.setEnabled(id, true);
        if (!enabled.ok) return fail(enabled.error);
      }
      void useStore.getState().refreshSchedules();
      onSaved(id);
    } finally {
      setSaving(false);
    }
  };

  const title = review ? t('schedules.editorReview') : original ? t('schedules.editorEdit') : t('schedules.editorNew');
  const preset = effectivePreset(pickedPreset, form.weekdays);
  const scheduleText = `${preset === 'weekly' ? `${t('schedules.weekly')} · ${weekdayName(form.weekdays[0] ?? 1)}` : describeDays(form.weekdays) || t('schedules.customDays')} · ${form.time}`;
  const account = vendorAccounts.find((a) => a.id === form.accountId)?.name;
  const promptProblem = shown('prompt');
  const chipProblem = [shown('schedule'), shown('folder'), shown('agent')].filter(Boolean).join(' ');
  const moreProblem = shown('more');

  const chipButton = (id: Chip, icon: ReactNode, label: string, testId: string) => (
    <button
      type="button"
      className={`wmux-schedule-chip ${FOCUS_RING}`}
      aria-expanded={chip === id}
      aria-haspopup="dialog"
      data-invalid={showProblems && problems.some((p) => PROBLEM_PLACE[p] === id) ? 'true' : undefined}
      onClick={() => setChip(chip === id ? null : id)}
      {...{ [testId]: '' }}
    >
      {icon}
      <span className="truncate">{label}</span>
      <span className="wmux-schedule-chip-caret" aria-hidden="true"><IconChevron size={11} /></span>
    </button>
  );

  return (
    <section
      className="wmux-schedule-composer"
      aria-label={title}
      data-testid="schedule-editor"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // Escape closes the open chip first, then the composer — never the page.
        e.preventDefault();
        if (chip) setChip(null);
        else if (!saving) onClose();
      }}
    >
      <h2 className="wmux-schedule-pane-title">{title}</h2>
      <div className="wmux-schedule-box">
        <input
          className="wmux-schedule-name"
          value={form.name}
          maxLength={80}
          placeholder={t('schedules.namePlaceholder')}
          aria-label={t('schedules.name')}
          onChange={(e) => { setNameTouched(true); set('name', e.target.value); }}
          data-schedule-name
        />
        <textarea
          className="wmux-schedule-prompt"
          value={form.prompt}
          maxLength={AUTOMATION_DEFAULTS.maxPromptChars}
          placeholder={t('schedules.promptPlaceholder')}
          aria-label={t('schedules.prompt')}
          aria-invalid={promptProblem ? true : undefined}
          onChange={(e) => setPrompt(e.target.value)}
          data-schedule-prompt
        />
        <div ref={chipsRef} className="wmux-schedule-chips">
          {chipButton('schedule', <IconClock size={14} />, scheduleText, 'data-schedule-chip-schedule')}
          {chipButton('folder', <FolderIcon />, form.cwd ? folderName(form.cwd) : t('schedules.chipFolderEmpty'), 'data-schedule-chip-folder')}
          {chipButton('agent', <AgentIcon />, `${agentLabel(form.agent)} · ${account ?? t('schedules.defaultAccount')}`, 'data-schedule-chip-agent')}
          {chip && (
            <Popover padded className="wmux-schedule-popover" aria-label={t(`schedules.${chip === 'schedule' ? 'schedule' : chip === 'folder' ? 'folder' : 'agent'}`)}>
              {chip === 'schedule' && (
                <div className="flex flex-col gap-3" data-schedule-popover="schedule">
                  <SegmentedControl<SchedulePreset>
                    value={preset}
                    ariaLabel={t('schedules.schedule')}
                    options={[
                      { value: 'daily', label: t('schedules.daily') },
                      { value: 'weekdays', label: t('schedules.weekdays') },
                      { value: 'weekly', label: t('schedules.weekly') },
                      { value: 'custom', label: t('schedules.customDays') },
                    ]}
                    onValueChange={(p) => { setPickedPreset(p); set('weekdays', daysForPreset(p, form.weekdays)); }}
                  />
                  {(preset === 'weekly' || preset === 'custom') && (
                    <div className="flex flex-wrap gap-1" role="group" aria-label={t('schedules.customDays')}>
                      {DAILY.map((d) => {
                        const on = form.weekdays.includes(d);
                        return (
                          <Button
                            key={d}
                            size="sm"
                            variant={on ? 'secondary' : 'ghost'}
                            aria-pressed={on}
                            onClick={() => set('weekdays', toggleDay(preset, form.weekdays, d))}
                          >
                            {weekdayName(d)}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                  <Input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} aria-label={t('schedules.time')} data-schedule-time />
                </div>
              )}
              {chip === 'folder' && (
                <div className="flex gap-2" data-schedule-popover="folder">
                  <Input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} className="flex-1" spellCheck={false}
                    aria-label={t('schedules.folder')} data-schedule-cwd />
                  <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>{t('schedules.chooseFolder')}</Button>
                </div>
              )}
              {chip === 'agent' && (
                <div className="flex flex-col gap-2" data-schedule-popover="agent">
                  <SegmentedControl<AutomationAgent>
                    value={form.agent}
                    ariaLabel={t('schedules.agent')}
                    options={[
                      { value: 'claude', label: t('schedules.agentClaude') },
                      { value: 'codex', label: t('schedules.agentCodex') },
                    ]}
                    onValueChange={setAgent}
                  />
                  <Select value={form.accountId} onChange={(e) => set('accountId', e.target.value)} aria-label={t('schedules.account')}>
                    <option value="">{t('schedules.defaultAccount')}</option>
                    {vendorAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
              )}
            </Popover>
          )}
        </div>
      </div>
      {promptProblem && <p className="ui-row-error" role="alert" data-schedule-problem="prompt">{promptProblem}</p>}
      {chipProblem && <p className="ui-row-error" role="alert" data-schedule-problem="chips">{chipProblem}</p>}

      <button
        type="button"
        className={`wmux-schedule-more ${FOCUS_RING}`}
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
        data-schedule-more
      >
        <span className="wmux-schedule-more-caret" aria-hidden="true"><IconChevron size={12} /></span>
        {t('schedules.moreOptions')}
      </button>
      {more && (
        <div className="wmux-schedule-more-body" data-schedule-more-body>
          <Field label={t('schedules.permission')} description={form.mode === 'scoped' && form.agent === 'codex'
              ? t('schedules.modeDesc.scopedCodex')
              : t(`schedules.modeDesc.${form.mode}`)} layout="stacked">
            <SegmentedControl<AutomationPermissionMode>
              value={form.mode}
              ariaLabel={t('schedules.permission')}
              options={[
                { value: 'approval', label: t('schedules.mode.approval') },
                { value: 'scoped', label: t('schedules.mode.scoped') },
                { value: 'bypass', label: t('schedules.mode.bypass') },
              ]}
              onValueChange={pickMode}
            />
          </Field>
          {usesToolList(form) && (
            <Field label={t('schedules.tools')} description={t('schedules.toolsHint')} layout="stacked">
              <Input
                value={form.toolsText}
                spellCheck={false}
                onChange={(e) => { setPermissionTouched(true); set('toolsText', e.target.value); }}
                aria-invalid={tools.invalid.length > 0}
                data-schedule-tools
              />
            </Field>
          )}
          {usesToolList(form) && tools.invalid.length > 0 && (
            <p className="ui-row-error" data-schedule-tools-error>
              {t('schedules.toolsInvalid', { names: tools.invalid.join(', ') })}
            </p>
          )}
          <div className="wmux-schedule-more-grid">
            <Field label={t('schedules.model')} description={t('schedules.modelHint')} layout="stacked">
              <Input value={form.model} onChange={(e) => set('model', e.target.value)} spellCheck={false} data-schedule-model />
            </Field>
            <Field label={t('schedules.effort')} description={t('schedules.modelHint')} layout="stacked">
              <Input value={form.effort} onChange={(e) => set('effort', e.target.value)} spellCheck={false} data-schedule-effort />
            </Field>
            <Field label={t('schedules.grace')} layout="stacked">
              <Input inputMode="numeric" value={form.graceMinutes} onChange={(e) => set('graceMinutes', e.target.value)} data-schedule-grace />
            </Field>
            <Field label={t('schedules.awaitTimeout')} description={t('schedules.awaitTimeoutHint')} layout="stacked">
              <Input inputMode="numeric" value={form.awaitTimeoutMinutes} onChange={(e) => set('awaitTimeoutMinutes', e.target.value)} data-schedule-await />
            </Field>
          </div>
          {moreProblem && <p className="ui-row-error" role="alert" data-schedule-problem="more">{moreProblem}</p>}
        </div>
      )}

      {warnReset && <p className="ui-note" role="status" data-schedule-reset-warning>{t('schedules.resetWarning')}</p>}
      {error && <p className="ui-row-error" role="alert" data-schedule-error>{error}</p>}
      <div className="wmux-schedule-actions">
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t('schedules.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !api} data-schedule-save>
          {review ? t('schedules.saveAndEnable') : original ? t('schedules.save') : t('schedules.create')}
        </Button>
      </div>
    </section>
  );
}

