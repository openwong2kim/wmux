import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  AUTOMATION_DEFAULTS,
  type Automation,
  type AutomationAgent,
  type AutomationPermissionMode,
} from '../../../shared/automation';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field, { useFieldWiring } from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';
import SegmentedControl from '../ui/SegmentedControl';
import {
  DAILY,
  WEEKDAYS,
  draftFromForm,
  emptyForm,
  formFromAutomation,
  grantNeeded,
  parseToolNames,
  shouldWarnPermissionReset,
  usesToolList,
  validateForm,
  type ScheduleForm,
} from './scheduleModel';
import { weekdayName } from './format';
import type { AccountOption } from './useAccounts';

type DayPreset = 'daily' | 'weekdays' | 'custom';

function presetOf(days: readonly number[]): DayPreset {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === DAILY.join(',')) return 'daily';
  if (key === WEEKDAYS.join(',')) return 'weekdays';
  return 'custom';
}

function PromptArea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const wiring = useFieldWiring();
  return (
    <textarea
      id={wiring.id}
      aria-describedby={wiring['aria-describedby']}
      className="ui-input h-[30vh] min-h-[120px] flex-1 resize-none text-[13px] leading-5 min-[640px]:h-auto min-[640px]:min-h-[360px]"
      value={value}
      maxLength={AUTOMATION_DEFAULTS.maxPromptChars}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      data-schedule-prompt
    />
  );
}

/**
 * Create / edit / review a schedule. Left: the prompt. Right: folder → agent
 * and account → days and time → permission. Permission is never part of the
 * draft: saving updates the schedule first and then calls automation.grant,
 * so the grant lands on the revision the update produced.
 */
export default function ScheduleEditor({ original, review, accounts, onClose, onSaved }: {
  original: Automation | null;
  /** A draft an agent proposed: saving also turns it on. */
  review: boolean;
  accounts: AccountOption[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<ScheduleForm>(() => (original ? formFromAutomation(original) : emptyForm()));
  const [permissionTouched, setPermissionTouched] = useState(false);
  // Set once create succeeded: a failed grant/enable retry must update this
  // schedule, never create a second one.
  const [created, setCreated] = useState<Automation | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const api = window.electronAPI?.automation;

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const problems = validateForm(form);
  const tools = parseToolNames(form.toolsText);
  const warnReset = shouldWarnPermissionReset(original, form, permissionTouched);
  const dirty = useMemo(() => {
    if (!original) return true;
    return permissionTouched
      || JSON.stringify(draftFromForm(form)) !== JSON.stringify(draftFromForm(formFromAutomation(original)));
  }, [form, original, permissionTouched]);
  const vendorAccounts = accounts.filter((a) => a.vendor === form.agent);

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
      return;
    }
    if (!api) return;
    setSaving(true);
    setError(null);
    const fail = (message: string) => {
      setError(message);
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

  const testRun = async () => {
    if (!api || !original) return;
    const r = await api.runNow(original.id, 'test');
    if (!r.ok) setError(r.error);
    else useStore.getState().pushToast({ level: 'info', message: t('schedules.testRunStarted') });
  };

  const title = review ? t('schedules.editorReview') : original ? t('schedules.editorEdit') : t('schedules.editorNew');
  const problemText = showProblems && problems.length > 0
    ? problems.map((p) => t(`schedules.problem.${p}`)).join(' ')
    : null;

  return createPortal(
    <>
    <Dialog onClose={onClose} width={880} data-testid="schedule-editor">
      <DialogHeader title={title} closeLabel={t('schedules.cancel')} closeDisabled={saving} />
      <DialogBody>
        {/* Two columns from 640px (the dialog fits them at a 725px window);
            below that one column, with the prompt height capped so the
            settings stay reachable. */}
        <div className="grid grid-cols-1 gap-6 min-[640px]:grid-cols-[minmax(0,1fr)_300px]">
          <Field label={t('schedules.prompt')} description={t('schedules.promptHint', { max: AUTOMATION_DEFAULTS.maxPromptChars })} layout="stacked" className="min-h-0">
            <PromptArea value={form.prompt} onChange={(v) => set('prompt', v)} placeholder={t('schedules.promptPlaceholder')} />
          </Field>
          <div className="flex flex-col gap-3">
            <Field label={t('schedules.name')} layout="stacked">
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} data-schedule-name />
            </Field>
            <Field label={t('schedules.folder')} layout="stacked">
              <div className="flex gap-2">
                <Input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} className="flex-1" spellCheck={false} data-schedule-cwd />
                <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>{t('schedules.chooseFolder')}</Button>
              </div>
            </Field>
            <Field label={t('schedules.agent')} layout="stacked">
              <div className="flex flex-col gap-2">
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
            </Field>
            <Field label={t('schedules.schedule')} layout="stacked">
              <div className="flex flex-col gap-2">
                <SegmentedControl<DayPreset>
                  value={presetOf(form.weekdays)}
                  ariaLabel={t('schedules.schedule')}
                  options={[
                    { value: 'daily', label: t('schedules.daily') },
                    { value: 'weekdays', label: t('schedules.weekdays') },
                    { value: 'custom', label: t('schedules.customDays') },
                  ]}
                  onValueChange={(p) => {
                    if (p === 'daily') set('weekdays', DAILY.slice());
                    else if (p === 'weekdays') set('weekdays', WEEKDAYS.slice());
                    else set('weekdays', []);
                  }}
                />
                {presetOf(form.weekdays) === 'custom' && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label={t('schedules.customDays')}>
                    {DAILY.map((d) => {
                      const on = form.weekdays.includes(d);
                      return (
                        <Button
                          key={d}
                          size="sm"
                          variant={on ? 'secondary' : 'ghost'}
                          aria-pressed={on}
                          onClick={() => set('weekdays', on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d])}
                        >
                          {weekdayName(d)}
                        </Button>
                      );
                    })}
                  </div>
                )}
                <Input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} aria-label={t('schedules.time')} data-schedule-time />
              </div>
            </Field>
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
            <button
              type="button"
              className="ui-note self-start underline-offset-2 hover:underline"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              {t('schedules.advanced')}
            </button>
            {advanced && (
              <div className="flex flex-col gap-3">
                <Field label={t('schedules.model')} description={t('schedules.modelHint')} layout="stacked">
                  <Input value={form.model} onChange={(e) => set('model', e.target.value)} spellCheck={false} />
                </Field>
                <Field label={t('schedules.grace')} layout="stacked">
                  <Input inputMode="numeric" value={form.graceMinutes} onChange={(e) => set('graceMinutes', e.target.value)} />
                </Field>
                <Field label={t('schedules.awaitTimeout')} description={t('schedules.awaitTimeoutHint')} layout="stacked">
                  <Input inputMode="numeric" value={form.awaitTimeoutMinutes} onChange={(e) => set('awaitTimeoutMinutes', e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        </div>
        {warnReset && <p className="ui-note mt-3" role="status" data-schedule-reset-warning>{t('schedules.resetWarning')}</p>}
        {original && !review && <p className="ui-note mt-3">{t('schedules.testRunHint')}</p>}
        {problemText && <p className="ui-row-error mt-3" role="alert">{problemText}</p>}
        {error && <p className="ui-row-error mt-3" role="alert">{t('schedules.error', { error })}</p>}
      </DialogBody>
      <DialogFooter>
        {original && !review && (
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={saving || dirty}
            title={dirty ? t('schedules.saveFirst') : undefined}
            onClick={() => void testRun()}
            data-schedule-editor-test-run
          >
            {t('schedules.testRun')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t('schedules.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !api} data-schedule-save>
          {review ? t('schedules.saveAndEnable') : t('schedules.save')}
        </Button>
      </DialogFooter>
    </Dialog>
    </>,
    document.body,
  );
}
