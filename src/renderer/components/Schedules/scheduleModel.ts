import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_TOOL_NAME_RE,
  type Automation,
  type AutomationAgent,
  type AutomationDraft,
  type AutomationPermissionMode,
} from '../../../shared/automation';

/** The editor's working copy. Strings where the user types numbers. */
export interface ScheduleForm {
  name: string;
  prompt: string;
  cwd: string;
  agent: AutomationAgent;
  accountId: string;
  weekdays: number[];
  time: string;
  model: string;
  effort: string;
  graceMinutes: string;
  awaitTimeoutMinutes: string;
  /** Not editable in v1, but carried through an edit: the daemon replaces the
   *  whole policy on update, so dropping it would reset it to the default. */
  maxRunMinutes: string;
  mode: AutomationPermissionMode;
  toolsText: string;
}

export const DAILY = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function emptyForm(): ScheduleForm {
  return {
    name: '', prompt: '', cwd: '', agent: 'claude', accountId: '',
    weekdays: WEEKDAYS.slice(), time: '09:00', model: '', effort: '',
    graceMinutes: String(AUTOMATION_DEFAULTS.graceMinutes), awaitTimeoutMinutes: '', maxRunMinutes: '',
    mode: 'approval', toolsText: '',
  };
}

export function formFromAutomation(a: Automation): ScheduleForm {
  return {
    name: a.name,
    prompt: a.action.prompt,
    cwd: a.action.cwd,
    agent: a.action.agent,
    accountId: a.action.accountId ?? '',
    weekdays: a.trigger.weekdays.slice(),
    time: a.trigger.time,
    model: a.action.model ?? '',
    effort: a.action.effort ?? '',
    graceMinutes: String(a.trigger.graceMinutes),
    awaitTimeoutMinutes: a.policy.awaitTimeoutMinutes !== undefined ? String(a.policy.awaitTimeoutMinutes) : '',
    maxRunMinutes: a.policy.maxRunMinutes !== undefined ? String(a.policy.maxRunMinutes) : '',
    mode: a.permission.mode,
    toolsText: (a.permission.allowedTools ?? []).join(', '),
  };
}

/** Scoped mode takes bare tool names only (no `Bash(...)` rule patterns). */
export function parseToolNames(text: string): { tools: string[]; invalid: string[] } {
  const tools: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    if (AUTOMATION_TOOL_NAME_RE.test(token)) {
      if (!tools.includes(token)) tools.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { tools, invalid };
}

/**
 * Scoped mode takes a tool list for Claude only. Codex scoped is a fixed
 * sandbox (writes inside the folder, no prompts); the daemon rejects a tool
 * list for it, so none is ever sent.
 */
export function usesToolList(form: Pick<ScheduleForm, 'agent' | 'mode'>): boolean {
  return form.mode === 'scoped' && form.agent === 'claude';
}

export type FormProblem = 'name' | 'prompt' | 'promptTooLong' | 'cwd' | 'weekdays' | 'time' | 'grace' | 'awaitTimeout' | 'tools';

export function validateForm(form: ScheduleForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!form.name.trim()) problems.push('name');
  if (!form.prompt.trim()) problems.push('prompt');
  if (form.prompt.length > AUTOMATION_DEFAULTS.maxPromptChars) problems.push('promptTooLong');
  if (!form.cwd.trim()) problems.push('cwd');
  if (form.weekdays.length === 0) problems.push('weekdays');
  if (!TIME_RE.test(form.time)) problems.push('time');
  if (!/^\d{1,4}$/.test(form.graceMinutes)) problems.push('grace');
  if (form.awaitTimeoutMinutes && !/^[1-9]\d{0,3}$/.test(form.awaitTimeoutMinutes)) problems.push('awaitTimeout');
  if (usesToolList(form)) {
    const { tools, invalid } = parseToolNames(form.toolsText);
    if (invalid.length > 0 || tools.length === 0) problems.push('tools');
  }
  return problems;
}

export function draftFromForm(form: ScheduleForm): AutomationDraft {
  const model = form.model.trim();
  const effort = form.effort.trim();
  return {
    name: form.name.trim(),
    trigger: {
      kind: 'schedule',
      weekdays: [...new Set(form.weekdays)].sort((a, b) => a - b),
      time: form.time,
      graceMinutes: Number(form.graceMinutes),
    },
    action: {
      kind: 'launch',
      cwd: form.cwd.trim(),
      agent: form.agent,
      ...(form.accountId ? { accountId: form.accountId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      prompt: form.prompt,
    },
    ...(form.awaitTimeoutMinutes || form.maxRunMinutes ? {
      policy: {
        ...(form.awaitTimeoutMinutes ? { awaitTimeoutMinutes: Number(form.awaitTimeoutMinutes) } : {}),
        ...(form.maxRunMinutes ? { maxRunMinutes: Number(form.maxRunMinutes) } : {}),
      },
    } : {}),
  };
}

/** The fields whose change bumps the schedule's revision (daemon rule). */
export function revisionFieldsChanged(original: Automation, form: ScheduleForm): boolean {
  const a = original.action;
  return a.cwd !== form.cwd.trim()
    || a.agent !== form.agent
    || (a.accountId ?? '') !== form.accountId
    || a.prompt !== form.prompt
    || (a.model ?? '') !== form.model.trim()
    || (a.effort ?? '') !== form.effort.trim();
}

/**
 * Show "saving resets permission to Approval" before save: the schedule holds
 * a non-approval grant, the edit bumps the revision, and the user has not
 * picked a permission again in this edit (a fresh pick is granted after the
 * update, at the new revision).
 */
export function shouldWarnPermissionReset(
  original: Automation | null,
  form: ScheduleForm,
  permissionTouched: boolean,
): boolean {
  if (!original || permissionTouched) return false;
  if (original.permission.mode === 'approval') return false;
  return revisionFieldsChanged(original, form);
}

/**
 * Whether saving must call automation.grant: a new schedule with a
 * non-approval mode, or a permission the user picked in this edit.
 */
export function grantNeeded(original: Automation | null, form: ScheduleForm, permissionTouched: boolean): boolean {
  if (!original) return form.mode !== 'approval';
  if (!permissionTouched) return false;
  // A pick is granted at the revision the update just produced — including
  // the same non-approval mode picked again after a revision-bumping edit.
  return form.mode !== 'approval' || original.permission.mode !== 'approval';
}

// ─── Composer helpers ───────────────────────────────────────────────────────

/** How the schedule chip reads a day set. `weekly` is exactly one day. */
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'custom';

export function presetOf(days: readonly number[]): SchedulePreset {
  const key = [...new Set(days)].sort((a, b) => a - b).join(',');
  if (key === DAILY.join(',')) return 'daily';
  if (key === WEEKDAYS.join(',')) return 'weekdays';
  if (days.length === 1) return 'weekly';
  return 'custom';
}

/** The day set a preset picks; `weekly` keeps the current first day (Monday if none). */
export function daysForPreset(preset: SchedulePreset, current: readonly number[]): number[] {
  if (preset === 'daily') return DAILY.slice();
  if (preset === 'weekdays') return WEEKDAYS.slice();
  if (preset === 'weekly') return [current.length === 1 ? current[0] : 1];
  return current.slice();
}

/** A schedule's name, until the user writes one: the prompt's first line. */
export function deriveName(prompt: string): string {
  const first = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}

/** A starting point offered on the empty Schedules page. */
export interface ScheduleTemplate {
  id: string;
  /** i18n keys: `schedules.tpl.<id>.title` / `.desc` / `.prompt`. */
  weekdays: number[];
  time: string;
}

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  { id: 'briefing', weekdays: DAILY, time: '09:00' },
  { id: 'nightlyTests', weekdays: DAILY, time: '02:00' },
  { id: 'depAudit', weekdays: [1], time: '10:00' },
  { id: 'flakyHunt', weekdays: [5], time: '10:00' },
  { id: 'changelog', weekdays: [5], time: '17:00' },
  { id: 'triage', weekdays: WEEKDAYS, time: '09:30' },
];

export function formFromTemplate(template: ScheduleTemplate, name: string, prompt: string, cwd: string): ScheduleForm {
  return {
    ...emptyForm(),
    name,
    prompt,
    cwd,
    weekdays: template.weekdays.slice(),
    time: template.time,
  };
}
