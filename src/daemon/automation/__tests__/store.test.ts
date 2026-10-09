import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveMode, modeRaises, needsRegrant, validateAllowedTools, validateDraft } from '../draft';
import {
  AUTOMATIONS_FILE,
  AUTOMATION_RUNS_FILE,
  cleanSnapshotText,
  coerceRun,
  recordedRunPtyIds,
  loadAutomations,
  pruneRuns,
  snapshotPath,
  writeSnapshot,
} from '../store';
import type { AutomationRun } from '../../../shared/automation';

const draft = {
  name: 'Morning triage',
  trigger: { kind: 'schedule', weekdays: [5, 1, 1], time: '08:30', graceMinutes: 60 },
  action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'triage issues' },
};

describe('draft validation', () => {
  it('rebuilds from validated fields only — smuggled permission/revision keys are dropped', () => {
    const out = validateDraft({ ...draft, permission: { mode: 'bypass', grantedRevision: 1 }, revision: 9, enabled: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({
      name: 'Morning triage',
      trigger: { kind: 'schedule', weekdays: [1, 5], time: '08:30', graceMinutes: 60 },
      action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'triage issues' },
      policy: {},
    });
  });

  it('rejects bad time, relative folder, empty weekdays, unknown agent', () => {
    expect(validateDraft({ ...draft, trigger: { ...draft.trigger, time: '24:00' } }).ok).toBe(false);
    expect(validateDraft({ ...draft, action: { ...draft.action, cwd: 'repo' } }).ok).toBe(false);
    expect(validateDraft({ ...draft, trigger: { ...draft.trigger, weekdays: [] } }).ok).toBe(false);
    expect(validateDraft({ ...draft, action: { ...draft.action, agent: 'bash' } }).ok).toBe(false);
    expect(validateDraft({ ...draft, action: { ...draft.action, model: 'opus; rm' } }).ok).toBe(false);
  });

  it('tool names: bare names only', () => {
    expect(validateAllowedTools(['Read', 'Read', 'Edit'])).toEqual({ ok: true, value: ['Read', 'Edit'] });
    expect(validateAllowedTools(['Bash(git:*)']).ok).toBe(false);
    expect(validateAllowedTools([]).ok).toBe(false);
  });

  it('a non-approval grant is honoured only at its revision', () => {
    expect(effectiveMode({ revision: 2, permission: { mode: 'bypass', grantedRevision: 2 } })).toBe('bypass');
    expect(effectiveMode({ revision: 3, permission: { mode: 'bypass', grantedRevision: 2 } })).toBe('approval');
    expect(effectiveMode({ revision: 3, permission: { mode: 'scoped' } })).toBe('approval');
  });

  it('needsRegrant is computed from the revision; approval never needs one', () => {
    expect(needsRegrant({ revision: 2, permission: { mode: 'auto', grantedRevision: 2 } })).toBe(false);
    expect(needsRegrant({ revision: 3, permission: { mode: 'auto', grantedRevision: 2 } })).toBe(true);
    expect(needsRegrant({ revision: 3, permission: { mode: 'scoped' } })).toBe(true);
    expect(needsRegrant({ revision: 3, permission: { mode: 'approval' } })).toBe(false);
  });

  it('auto ranks between scoped and bypass', () => {
    expect(modeRaises('approval', 'auto')).toBe(true);
    expect(modeRaises('scoped', 'auto')).toBe(true);
    expect(modeRaises('auto', 'bypass')).toBe(true);
    expect(modeRaises('bypass', 'auto')).toBe(false);
  });
});

describe('store', () => {
  it('drops a corrupt record and keeps the rest; an unreadable file is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-auto-'));
    fs.writeFileSync(path.join(dir, AUTOMATIONS_FILE), JSON.stringify({
      version: 1,
      automations: [
        { ...draft, id: 'a1', enabled: true, revision: 1, createdAt: 1, permission: { mode: 'bypass' } },
        { ...draft, id: 'a2', revision: 0, createdAt: 1 },
        { id: 'a3' },
      ],
    }));
    const state = loadAutomations(dir);
    expect(state.automations.map((a) => a.id)).toEqual(['a1']);
    // A bypass without a grant revision is not a grant.
    expect(state.automations[0].permission).toEqual({ mode: 'approval' });
    fs.writeFileSync(path.join(dir, AUTOMATIONS_FILE), '{not json');
    expect(loadAutomations(dir).automations).toEqual([]);
  });

  it('restores auto (claude only) and codex scoped grants; drops auto for codex', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-auto-'));
    const codex = { ...draft.action, agent: 'codex' };
    fs.writeFileSync(path.join(dir, AUTOMATIONS_FILE), JSON.stringify({
      version: 1,
      automations: [
        { ...draft, id: 'a1', revision: 2, createdAt: 1, permission: { mode: 'auto', grantedRevision: 2 } },
        { ...draft, action: codex, id: 'a2', revision: 1, createdAt: 1, permission: { mode: 'scoped', grantedRevision: 1 } },
        { ...draft, action: codex, id: 'a3', revision: 1, createdAt: 1, permission: { mode: 'auto', grantedRevision: 1 } },
      ],
      attention: [{ id: 'x1', automationId: 'a1', automationName: 'n', kind: 'needs-regrant', at: 1 }],
    }));
    const state = loadAutomations(dir);
    expect(state.automations.map((a) => a.permission)).toEqual([
      { mode: 'auto', grantedRevision: 2 },
      { mode: 'scoped', grantedRevision: 1 },
      { mode: 'approval' },
    ]);
    expect(state.attention.map((x) => x.kind)).toEqual(['needs-regrant']);
  });

  it('a needs_regrant skip survives coerceRun', () => {
    expect(coerceRun({
      id: 'r1', automationId: 'a1', revision: 2, effectiveMode: 'auto', scheduledFor: 1, state: 'skipped', reason: 'needs_regrant',
    })).toMatchObject({ effectiveMode: 'auto', state: 'skipped', reason: 'needs_regrant' });
  });

  it('snapshot text: control characters stripped, tail kept under the cap, file is 0600', () => {
    expect(cleanSnapshotText('a\u0007b\u001b[31mc\r\n\n\n')).toBe('ab[31mc');
    expect(cleanSnapshotText('x'.repeat(10) + 'END', 5)).toBe('xxEND');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-snap-'));
    expect(writeSnapshot(dir, 'run1', 'hello')).toBe(true);
    const file = snapshotPath(dir, 'run1')!;
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(snapshotPath(dir, '../escape')).toBeNull();
  });

  it('recovery ownership comes from the runs file, not the auto- prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-own-'));
    fs.writeFileSync(path.join(dir, AUTOMATION_RUNS_FILE), JSON.stringify({
      version: 1,
      runs: [
        { id: 'r1', automationId: 'a1', revision: 1, effectiveMode: 'approval', scheduledFor: 1, trigger: 'scheduled', state: 'running', ptyId: 'auto-r1' },
        { id: 'r2', automationId: 'a1', revision: 1, effectiveMode: 'approval', scheduledFor: 2, trigger: 'scheduled', state: 'completed' },
      ],
    }));
    const owned = recordedRunPtyIds(dir);
    expect(owned.has('auto-r1')).toBe(true);
    // A user session that merely carries the prefix is not a scheduled run.
    expect(owned.has('auto-user-pane')).toBe(false);
    expect(recordedRunPtyIds(path.join(dir, 'missing')).size).toBe(0);
  });

  it('prunes final runs to the per-automation cap and drops orphans', () => {
    const run = (id: string, automationId: string, state: AutomationRun['state'], endedAt: number): AutomationRun =>
      ({ id, automationId, revision: 1, effectiveMode: 'approval', scheduledFor: endedAt, trigger: 'scheduled', state, endedAt });
    const runs = [
      run('r1', 'a', 'completed', 1), run('r2', 'a', 'completed', 2), run('r3', 'a', 'completed', 3),
      run('r4', 'a', 'running', 4), run('r5', 'gone', 'failed', 5),
    ];
    const { kept, dropped } = pruneRuns(runs, new Set(['a']), 2);
    expect(kept.map((r) => r.id).sort()).toEqual(['r2', 'r3', 'r4']);
    expect(dropped.sort()).toEqual(['r1', 'r5']);
  });
});
