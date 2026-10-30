// The settings page's Save: only what changed, the starting job never
// written as the bot's own, a cleared job or hourly cap sent as null, and
// what wakes the bot in words.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_BUDGETS, HERMES_BOT_ENGINE, type BotProfile } from '../../../../shared/bot';
import { botWakesOn, changedFields, settingsForm, settingsSave } from '../botSettings';

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

function bot(over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'lead', template: 'coordinator', name: 'Lead',
    engine: { kind: 'claude-sdk', model: 'haiku' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS.lead, maxTurnsPerHour: 6 },
    enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('settingsSave', () => {
  it('sends only the changed fields; the starting job is never written and a cleared one is null', () => {
    const b = bot();
    const base = settingsForm(b, 'Coordinate the team.', null);
    expect(base.job).toBe('Coordinate the team.');
    expect(changedFields(base, { job: 'Coordinate the team.' })).toEqual([]);
    expect(settingsSave(b, base, { ...base, name: 'Boss' }, 'Coordinate the team.', t)).toEqual({ ok: true, patch: { name: 'Boss' } });
    expect(settingsSave(b, base, { ...base, job: ' Coordinate the team. ' }, 'Coordinate the team.', t)).toEqual({ ok: true, patch: {} });
    const own = bot({ job: 'Mine.' });
    const ownBase = settingsForm(own, 'Coordinate the team.', null);
    expect(settingsSave(own, ownBase, { ...ownBase, job: '' }, 'Coordinate the team.', t)).toEqual({ ok: true, patch: { job: null } });
    expect(settingsSave(b, base, { ...base, perHour: '' }, '', t)).toEqual({ ok: true, patch: { budget: { maxTurnsPerHour: null } } });
    expect(settingsSave(b, base, { ...base, perDay: '-1' }, '', t)).toEqual({ ok: false, error: 'botsPage.settings.limitInvalid' });
    expect(settingsSave(b, base, { ...base, name: '  ' }, '', t)).toEqual({ ok: false, error: 'botsPage.settings.nameInvalid' });
  });

  it('never sends an engine for a bot that is not on Claude, so Save cannot undo an engine switch', () => {
    const b = bot({ engine: HERMES_BOT_ENGINE });
    const base = settingsForm(b, '', null);
    expect(settingsSave(b, base, { ...base, brainModel: 'opus', name: 'H' }, '', t)).toEqual({ ok: true, patch: { name: 'H' } });
  });

  it('sends the picture and the commands switch beside the patch', () => {
    const b = bot();
    const base = settingsForm(b, '', true);
    expect(settingsSave(b, base, { ...base, picture: null, commands: false }, '', t)).toEqual({ ok: true, patch: {}, picture: null, commands: false });
  });
});

describe('botWakesOn', () => {
  it('names its messages always, then each kind of fact its triggers name, once', () => {
    expect(botWakesOn([])).toEqual(['botsPage.settings.wake.messages']);
    expect(botWakesOn([{ kind: 'ci.failed' }, { kind: 'pr.opened' }, { kind: 'pr.merged' }, { kind: 'task.done' }, { kind: 'human.message' }])).toEqual([
      'botsPage.settings.wake.messages', 'botsPage.settings.wake.pr', 'botsPage.settings.wake.ci', 'botsPage.settings.wake.workers',
    ]);
  });
});
