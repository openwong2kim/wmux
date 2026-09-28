// Durability for scheduled runs: automations.json, automation-runs.json and
// per-run plain-text output snapshots, all in the suffix-aware wmux data dir.
//
// Same rules as approvalStore: records are coerced field by field on read, a
// record missing an identity field is dropped (never half-invented), an
// unreadable file degrades to empty, and saves never throw — they report
// false so the caller can decide (the launch path refuses to spawn when its
// claim could not be persisted).
//
// Threat model: a same-user process that edits these files directly is out of
// scope (crontab-equivalent). The permission grant is still bound to the
// revision, so an edited prompt without a matching grant runs in approval mode.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../util/atomicWrite';
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_FINAL_RUN_STATES,
  type Automation,
  type AutomationAttention,
  type AutomationRun,
  type AutomationRunReason,
  type AutomationRunState,
} from '../../shared/automation';
import { isPermissionMode, validateAllowedTools, validateDraft } from './draft';

export const AUTOMATIONS_FILE = 'automations.json';
export const AUTOMATION_RUNS_FILE = 'automation-runs.json';
export const AUTOMATION_SNAPSHOT_DIR = 'automation-snapshots';
export const ATTENTION_CAP = 50;

export interface AutomationsFileState {
  version: 1;
  automations: Automation[];
  attention: AutomationAttention[];
}

export interface AutomationRunsFileState {
  version: 1;
  runs: AutomationRun[];
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_STATES: ReadonlySet<string> = new Set<AutomationRunState>([
  'launching', 'running', 'awaiting', 'completed', 'failed', 'skipped', 'unknown',
]);
const RUN_REASONS: ReadonlySet<string> = new Set<AutomationRunReason>([
  'overlap', 'missed', 'daemon_down', 'first_run_blocked', 'launch_failed', 'account_missing',
  'await_timeout', 'timeout', 'agent_error', 'process_exit', 'interrupted', 'cancelled',
]);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function coerceAutomation(raw: unknown): Automation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' && ID_RE.test(o['id']) ? o['id'] : null;
  const revision = num(o['revision']);
  const createdAt = num(o['createdAt']);
  if (!id || revision === undefined || !Number.isInteger(revision) || revision < 1 || createdAt === undefined) return null;
  const draft = validateDraft(o);
  if (!draft.ok) return null;
  const perm = (o['permission'] ?? {}) as Record<string, unknown>;
  let permission: Automation['permission'] = { mode: 'approval' };
  if (isPermissionMode(perm['mode']) && perm['mode'] !== 'approval') {
    const granted = num(perm['grantedRevision']);
    const tools = perm['mode'] === 'scoped' ? validateAllowedTools(perm['allowedTools']) : null;
    if (granted !== undefined && (perm['mode'] === 'bypass' || tools?.ok)) {
      permission = {
        mode: perm['mode'],
        grantedRevision: granted,
        ...(tools?.ok ? { allowedTools: tools.value } : {}),
      };
    }
  }
  const nextRunAt = num(o['nextRunAt']);
  return {
    id,
    name: draft.value.name,
    enabled: o['enabled'] === true,
    ...(o['proposed'] === true ? { proposed: true } : {}),
    revision,
    trigger: draft.value.trigger,
    action: draft.value.action,
    permission,
    policy: { overlap: 'skip_if_active', ...draft.value.policy },
    nextRunAt: nextRunAt ?? null,
    createdAt,
    updatedAt: num(o['updatedAt']) ?? createdAt,
    createdBy: o['createdBy'] === 'mcp-proposal' ? 'mcp-proposal' : 'desktop-ui',
  };
}

export function coerceRun(raw: unknown): AutomationRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' && ID_RE.test(o['id']) ? o['id'] : null;
  const automationId = typeof o['automationId'] === 'string' && ID_RE.test(o['automationId']) ? o['automationId'] : null;
  const revision = num(o['revision']);
  const scheduledFor = num(o['scheduledFor']);
  const state = typeof o['state'] === 'string' && RUN_STATES.has(o['state']) ? (o['state'] as AutomationRunState) : null;
  if (!id || !automationId || revision === undefined || scheduledFor === undefined || !state) return null;
  const trigger = o['trigger'] === 'manual' || o['trigger'] === 'test' ? o['trigger'] : 'scheduled';
  const reason = typeof o['reason'] === 'string' && RUN_REASONS.has(o['reason']) ? (o['reason'] as AutomationRunReason) : undefined;
  const ptyId = typeof o['ptyId'] === 'string' && ID_RE.test(o['ptyId']) ? o['ptyId'] : undefined;
  const agentSessionId = typeof o['agentSessionId'] === 'string' && o['agentSessionId'].length <= 256 ? o['agentSessionId'] : undefined;
  const startedAt = num(o['startedAt']);
  const endedAt = num(o['endedAt']);
  return {
    id,
    automationId,
    revision,
    effectiveMode: isPermissionMode(o['effectiveMode']) ? o['effectiveMode'] : 'approval',
    scheduledFor,
    trigger,
    state,
    ...(reason ? { reason } : {}),
    ...(ptyId ? { ptyId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(o['hasSnapshot'] === true ? { hasSnapshot: true } : {}),
  };
}

function coerceAttention(raw: unknown): AutomationAttention | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const at = num(o['at']);
  if (typeof o['id'] !== 'string' || !ID_RE.test(o['id']) || typeof o['automationId'] !== 'string' ||
      typeof o['automationName'] !== 'string' || at === undefined ||
      (o['kind'] !== 'proposed' && o['kind'] !== 'grant-raised')) return null;
  return { id: o['id'], automationId: o['automationId'], automationName: o['automationName'].slice(0, 120), kind: o['kind'], at };
}

function readJson(file: string): unknown {
  try {
    return atomicReadJSONSync<unknown>(file);
  } catch {
    return null;
  }
}

export function loadAutomations(wmuxDir: string): AutomationsFileState {
  const raw = readJson(path.join(wmuxDir, AUTOMATIONS_FILE)) as Record<string, unknown> | null;
  const automations: Automation[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw?.['automations']) ? raw['automations'] : []) {
    const a = coerceAutomation(entry);
    if (!a || seen.has(a.id) || automations.length >= AUTOMATION_DEFAULTS.maxAutomations) continue;
    seen.add(a.id);
    automations.push(a);
  }
  const attention = (Array.isArray(raw?.['attention']) ? raw['attention'] : [])
    .map(coerceAttention)
    .filter((x): x is AutomationAttention => x !== null)
    .slice(-ATTENTION_CAP);
  return { version: 1, automations, attention };
}

export function loadRuns(wmuxDir: string): AutomationRunsFileState {
  const raw = readJson(path.join(wmuxDir, AUTOMATION_RUNS_FILE)) as Record<string, unknown> | null;
  const runs: AutomationRun[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw?.['runs']) ? raw['runs'] : []) {
    const r = coerceRun(entry);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    runs.push(r);
  }
  return { version: 1, runs };
}

async function saveJson(file: string, data: unknown): Promise<boolean> {
  try {
    await atomicWriteJSON(file, data);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort (Windows ACLs) */ }
    return true;
  } catch {
    return false;
  }
}

export function saveAutomations(wmuxDir: string, state: AutomationsFileState): Promise<boolean> {
  return saveJson(path.join(wmuxDir, AUTOMATIONS_FILE), state);
}

export function saveRuns(wmuxDir: string, state: AutomationRunsFileState): Promise<boolean> {
  return saveJson(path.join(wmuxDir, AUTOMATION_RUNS_FILE), state);
}

export function isFinalRunState(state: AutomationRunState): boolean {
  return AUTOMATION_FINAL_RUN_STATES.includes(state);
}

/**
 * Keep every non-final run and the newest N final runs per automation; runs
 * whose automation is gone are dropped once final. Returns the kept runs and
 * the ids dropped (so their snapshots can be deleted).
 */
export function pruneRuns(
  runs: readonly AutomationRun[],
  liveAutomationIds: ReadonlySet<string>,
  perAutomation: number = AUTOMATION_DEFAULTS.runHistoryPerAutomation,
): { kept: AutomationRun[]; dropped: string[] } {
  const byAutomation = new Map<string, AutomationRun[]>();
  const kept: AutomationRun[] = [];
  const dropped: string[] = [];
  for (const run of runs) {
    if (!isFinalRunState(run.state)) {
      kept.push(run);
      continue;
    }
    if (!liveAutomationIds.has(run.automationId)) {
      dropped.push(run.id);
      continue;
    }
    const list = byAutomation.get(run.automationId) ?? [];
    list.push(run);
    byAutomation.set(run.automationId, list);
  }
  for (const list of byAutomation.values()) {
    list.sort((a, b) => (b.endedAt ?? b.scheduledFor) - (a.endedAt ?? a.scheduledFor));
    kept.push(...list.slice(0, perAutomation));
    dropped.push(...list.slice(perAutomation).map((r) => r.id));
  }
  kept.sort((a, b) => a.scheduledFor - b.scheduledFor);
  return { kept, dropped };
}

// ── Output snapshots ────────────────────────────────────────────────────────

/**
 * Plain text for a snapshot: control characters removed (tab and newline
 * kept), trailing blank lines trimmed, and at most `maxBytes` UTF-8 bytes —
 * the TAIL is kept, since the end of a run is what explains it.
 */
export function cleanSnapshotText(text: string, maxBytes: number = AUTOMATION_DEFAULTS.snapshotMaxBytes): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
  const buf = Buffer.from(cleaned, 'utf8');
  if (buf.length <= maxBytes) return cleaned;
  // Cut on a character boundary: drop leading continuation bytes.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

export function snapshotPath(wmuxDir: string, runId: string): string | null {
  if (!ID_RE.test(runId)) return null;
  return path.join(wmuxDir, AUTOMATION_SNAPSHOT_DIR, `${runId}.txt`);
}

/** Write a run's snapshot with 0600 in a 0700 dir. Never throws. */
export function writeSnapshot(wmuxDir: string, runId: string, text: string): boolean {
  const file = snapshotPath(wmuxDir, runId);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, cleanSnapshotText(text), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function readSnapshot(wmuxDir: string, runId: string): string | null {
  const file = snapshotPath(wmuxDir, runId);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function deleteSnapshot(wmuxDir: string, runId: string): void {
  const file = snapshotPath(wmuxDir, runId);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
