import type { Automation, AutomationRun } from '../../../../shared/automation';

export function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Morning report',
    enabled: true,
    revision: 3,
    trigger: { kind: 'schedule', weekdays: [1, 2, 3, 4, 5], time: '08:30', graceMinutes: 180 },
    action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'Summarize open PRs' },
    permission: { mode: 'approval' },
    policy: { overlap: 'skip_if_active' },
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'desktop-ui',
    ...over,
  };
}

export function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1', automationId: 'a1', revision: 3, effectiveMode: 'approval',
    scheduledFor: 1_000, trigger: 'scheduled', state: 'running', ...over,
  };
}
