// Validation of client-supplied drafts and the permission/revision rules.
//
// Everything a client sends is rebuilt field by field from validated values:
// unknown keys (a `permission`, a `grantedRevision`, an `enabled`) never reach
// the store, because the output object is constructed here rather than spread
// from the input.

import path from 'node:path';
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_TOOL_NAME_RE,
  type Automation,
  type AutomationDraft,
  type AutomationPermissionMode,
} from '../../shared/automation';
import { SCHEDULE_TIME_RE } from '../../shared/automationSchedule';

export const AUTOMATION_NAME_MAX = 120;
export const AUTOMATION_CWD_MAX = 4096;
export const AUTOMATION_MAX_ALLOWED_TOOLS = 64;
/** accounts.json ids, CLI model aliases and effort levels: one plain token. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MINUTES_MAX = 24 * 60;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): Checked<T> {
  return { ok: false, error };
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= AUTOMATION_NAME_MAX ? name : null;
}

function optionalMinutes(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MINUTES_MAX ? raw : null;
}

function optionalToken(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return typeof raw === 'string' && TOKEN_RE.test(raw) ? raw : null;
}

function isAbsoluteAnyPlatform(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** Rebuild a draft from untrusted input. */
export function validateDraft(raw: unknown): Checked<AutomationDraft> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid draft');
  const d = raw as Record<string, unknown>;
  const name = cleanName(d['name']);
  if (!name) return fail('Name is required (1-120 characters)');

  const t = d['trigger'] as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object' || t['kind'] !== 'schedule') return fail('Unsupported trigger');
  const rawDays = t['weekdays'];
  if (!Array.isArray(rawDays) || rawDays.length === 0 || rawDays.length > 7 ||
      !rawDays.every((w) => typeof w === 'number' && Number.isInteger(w) && w >= 0 && w <= 6)) {
    return fail('Pick at least one weekday');
  }
  const weekdays = [...new Set(rawDays as number[])].sort((a, b) => a - b);
  if (typeof t['time'] !== 'string' || !SCHEDULE_TIME_RE.test(t['time'])) return fail('Time must be HH:MM');
  const grace = t['graceMinutes'] === undefined ? AUTOMATION_DEFAULTS.graceMinutes : optionalMinutes(t['graceMinutes']);
  if (grace === null || grace === undefined) return fail('Grace must be 1-1440 minutes');

  const a = d['action'] as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object' || a['kind'] !== 'launch') return fail('Unsupported action');
  const cwd = a['cwd'];
  if (typeof cwd !== 'string' || !cwd || cwd.length > AUTOMATION_CWD_MAX || cwd.includes('\0') || !isAbsoluteAnyPlatform(cwd)) {
    return fail('Folder must be an absolute path');
  }
  const agent = a['agent'];
  if (agent !== 'claude' && agent !== 'codex') return fail('Unsupported agent');
  const accountId = optionalToken(a['accountId']);
  const model = optionalToken(a['model']);
  const effort = optionalToken(a['effort']);
  if (accountId === null) return fail('Invalid account');
  if (model === null) return fail('Invalid model');
  if (effort === null) return fail('Invalid effort');
  const prompt = a['prompt'];
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > AUTOMATION_DEFAULTS.maxPromptChars) {
    return fail(`Prompt is required (at most ${AUTOMATION_DEFAULTS.maxPromptChars} characters)`);
  }

  const p = (d['policy'] ?? {}) as Record<string, unknown>;
  if (typeof p !== 'object') return fail('Invalid policy');
  const awaitTimeoutMinutes = optionalMinutes(p['awaitTimeoutMinutes']);
  const maxRunMinutes = optionalMinutes(p['maxRunMinutes']);
  if (awaitTimeoutMinutes === null) return fail('Await timeout must be 1-1440 minutes');
  if (maxRunMinutes === null) return fail('Run limit must be 1-1440 minutes');

  return {
    ok: true,
    value: {
      name,
      trigger: { kind: 'schedule', weekdays, time: t['time'], graceMinutes: grace },
      action: {
        kind: 'launch',
        cwd,
        agent,
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        prompt,
      },
      policy: {
        ...(awaitTimeoutMinutes !== undefined ? { awaitTimeoutMinutes } : {}),
        ...(maxRunMinutes !== undefined ? { maxRunMinutes } : {}),
      },
    },
  };
}

/** scoped mode v1: bare tool names only, deduplicated, bounded. */
export function validateAllowedTools(raw: unknown): Checked<string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AUTOMATION_MAX_ALLOWED_TOOLS) {
    return fail('Scoped mode needs 1-64 tool names');
  }
  for (const tool of raw) {
    if (typeof tool !== 'string' || !AUTOMATION_TOOL_NAME_RE.test(tool)) {
      return fail('Tool names must be bare names like Read or Edit');
    }
  }
  return { ok: true, value: [...new Set(raw as string[])] };
}

export function isPermissionMode(raw: unknown): raw is AutomationPermissionMode {
  return raw === 'approval' || raw === 'scoped' || raw === 'auto' || raw === 'bypass';
}

/** The fields whose change means a different thing runs — and so a new revision. */
export function changesWhatRuns(before: AutomationDraft['action'], after: AutomationDraft['action']): boolean {
  return before.cwd !== after.cwd ||
    before.agent !== after.agent ||
    (before.accountId ?? '') !== (after.accountId ?? '') ||
    before.prompt !== after.prompt ||
    (before.model ?? '') !== (after.model ?? '') ||
    (before.effort ?? '') !== (after.effort ?? '');
}

/**
 * A non-approval mode whose grant predates the current revision. Computed,
 * never stored: such a schedule's runs are skipped (`needs_regrant`) until a
 * human grants it again — it never runs in a weaker mode instead.
 */
export function needsRegrant(automation: Pick<Automation, 'permission' | 'revision'>): boolean {
  const { mode, grantedRevision } = automation.permission;
  return mode !== 'approval' && grantedRevision !== automation.revision;
}

/**
 * A non-approval mode is honoured only at the revision it was granted at;
 * otherwise this reads `approval`. The engine checks `needsRegrant` first and
 * does not launch such a schedule at all.
 */
export function effectiveMode(automation: Pick<Automation, 'permission' | 'revision'>): AutomationPermissionMode {
  const { mode, grantedRevision } = automation.permission;
  if (mode === 'approval') return 'approval';
  return grantedRevision === automation.revision ? mode : 'approval';
}

/** auto ranks above scoped: Claude may approve tools beyond a scoped list. */
const MODE_RANK: Record<AutomationPermissionMode, number> = { approval: 0, scoped: 1, auto: 2, bypass: 3 };

export function modeRaises(from: AutomationPermissionMode, to: AutomationPermissionMode): boolean {
  return MODE_RANK[to] > MODE_RANK[from];
}
