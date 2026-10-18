// What a bot's profile says it can do comes from the shared surface alone:
// every surface tool has a phrase or is a listed event feed, every bot shows
// the same powers, and only a Coordinator adds reads in every workspace.

import { describe, expect, it } from 'vitest';
import { SHARED_SURFACE } from '../../../../shared/botSurface';
import { en } from '../../../i18n/locales/en';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BOT_ROLES, DEFAULT_BOT_BUDGETS, type BotEngine, type BotProfile } from '../../../../shared/bot';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { BrainModelLine } from '../BotModelLines';
import { CAN_DO_COORDINATOR, CAN_DO_PHRASES, CAN_DO_UNLISTED, botCanDo, botModelSummary, brainEngine, unusableBrainModel, workerAgentPick } from '../botsProfile';

describe('bot profile: can do', () => {
  it('every tool on the surface has an owner phrase or is an event feed', () => {
    const phrased = new Set(CAN_DO_PHRASES.flatMap((p) => p.tools as readonly string[]));
    for (const tool of SHARED_SURFACE.tools) {
      expect(phrased.has(tool) || CAN_DO_UNLISTED.has(tool as never), tool).toBe(true);
    }
  });

  it('shows the same powers for every role tag, each phrase backed by a surface tool and an English string', () => {
    const lead = botCanDo({ role: 'lead' });
    for (const role of BOT_ROLES.filter((r) => r !== 'moa')) expect(botCanDo({ role })).toEqual(lead);
    for (const key of lead) {
      const phrase = CAN_DO_PHRASES.find((p) => p.key === key);
      expect(phrase?.tools.some((t) => SHARED_SURFACE.tools.has(t)), key).toBe(true);
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
    for (const key of ['botsPage.canDo.fanout', 'botsPage.canDo.verdict', 'botsPage.canDo.plan', 'botsPage.canDo.ask', 'botsPage.canDo.approval', 'botsPage.canDo.secrets']) {
      expect(lead).toContain(key);
    }
  });

  it('only a Coordinator (template, or a legacy Moa) reads every workspace', () => {
    expect(en[CAN_DO_COORDINATOR as keyof typeof en]).toBeTruthy();
    expect(botCanDo({ role: 'lead' })).not.toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'lead', template: 'coordinator' })).toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'moa' })).toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'moa', template: 'developer' })).not.toContain(CAN_DO_COORDINATOR);
  });
});

describe('bot profile: models', () => {
  const t = (key: string, vars?: Record<string, string | number>) => {
    const text = (en as Record<string, string>)[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`));
  };

  it('every model string is in en, ko, pl and zh', async () => {
    const { ko } = await import('../../../i18n/locales/ko');
    const { pl } = await import('../../../i18n/locales/pl');
    const { zh } = await import('../../../i18n/locales/zh');
    const keys = Object.keys(en).filter((k) => k.startsWith('botsPage.models.'));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const locale of [ko, pl, zh] as Record<string, string>[]) for (const k of keys) expect(locale[k], k).toBeTruthy();
  });

  it('the brain picker saves a claude-sdk engine; it refuses a model id fan-out would refuse', () => {
    expect(brainEngine('haiku', 'low')).toEqual({ ok: true, engine: { kind: 'claude-sdk', model: 'haiku', effort: 'low' } });
    expect(brainEngine('  ', '')).toEqual({ ok: true, engine: { kind: 'claude-sdk' } });
    expect(brainEngine('opus', 'turbo')).toEqual({ ok: true, engine: { kind: 'claude-sdk', model: 'opus' } });
    expect(brainEngine('--dangerously-skip-permissions', '')).toEqual({ ok: false, model: '--dangerously-skip-permissions' });
    expect(brainEngine('claude opus', 'high')).toEqual({ ok: false, model: 'claude opus' });
    // The bot's own model is an SDK option, so a variant suffix is kept; workers' stays strict.
    expect(brainEngine('sonnet[1m]', '')).toEqual({ ok: true, engine: { kind: 'claude-sdk', model: 'sonnet[1m]' } });
    expect(brainEngine('sonnet[1m', '')).toEqual({ ok: false, model: 'sonnet[1m' });
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0';
    expect(brainEngine(arn, '')).toEqual({ ok: true, engine: { kind: 'claude-sdk', model: arn } });
    expect(brainEngine('claude-opus-5-5@20260901', '')).toEqual({ ok: true, engine: { kind: 'claude-sdk', model: 'claude-opus-5-5@20260901' } });
    expect(workerAgentPick('', 'sonnet[1m]', '')).toMatchObject({ ok: false, model: 'sonnet[1m]' });
  });

  it('the workers picker: the default agent with nothing pinned is null, a model alone pins Claude, a bad id is refused', () => {
    expect(workerAgentPick('', '', '')).toEqual({ ok: true, workerAgent: null });
    expect(workerAgentPick('', 'opus', '')).toEqual({ ok: true, workerAgent: { agent: 'claude', model: 'opus' } });
    expect(workerAgentPick('codex', 'gpt-6.1-sol', 'high')).toEqual({ ok: true, workerAgent: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
    expect(workerAgentPick('codex', '', '')).toEqual({ ok: true, workerAgent: { agent: 'codex' } });
    expect(workerAgentPick('claude', '-m', '')).toMatchObject({ ok: false, model: '-m' });
    expect(workerAgentPick('grok', '', '')).toMatchObject({ ok: false, error: expect.stringMatching(/bot-worker guard/) });
  });

  it('the list and roster note: only what is set, briefly', () => {
    expect(botModelSummary({ engine: { kind: 'claude-sdk' } }, t)).toBe('');
    expect(botModelSummary({ engine: { kind: 'claude-sdk', model: 'haiku' } }, t)).toBe('haiku (latest)');
    // A stored id is kept as written; the profile shows it trimmed.
    expect(botModelSummary({ engine: { kind: 'claude-sdk', model: '  haiku  ' } }, t)).toBe('haiku (latest)');
    expect(botModelSummary({ engine: { kind: 'claude-sdk' }, workerAgent: { agent: 'codex', model: ' gpt-6.1-sol ' } }, t)).toBe('workers gpt-6.1-sol');
    expect(botModelSummary({ engine: { kind: 'claude-sdk' }, workerAgent: { agent: 'claude', model: 'claude-opus-5-5' } }, t)).toBe('workers Opus 5.5');
    expect(botModelSummary({ engine: { kind: 'claude-sdk', model: 'sonnet' }, workerAgent: { agent: 'codex', model: 'gpt-6.1-sol' } }, t)).toBe('sonnet (latest) · workers gpt-6.1-sol');
    expect(botModelSummary({ engine: { kind: 'claude-sdk' }, workerAgent: { agent: 'codex' } }, t)).toBe('workers Codex');
    expect(botModelSummary({ engine: { kind: 'claude-sdk' }, workerAgent: { agent: 'claude' } }, t)).toBe('');
  });
  it('a stored model the bot cannot run on is ignored, left out of the note, and the profile warns of it (#2272)', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0';
    expect(unusableBrainModel({ kind: 'claude-sdk' })).toBeNull();
    expect(unusableBrainModel({ kind: 'claude-sdk', model: arn })).toBeNull();
    expect(unusableBrainModel({ kind: 'claude-sdk', model: 'opus; rm -rf ~' })).toBe('opus; rm -rf ~');
    expect(botModelSummary({ engine: { kind: 'claude-sdk', model: 'opus; rm -rf ~' } }, t)).toBe('');
    const render = (engine: BotEngine) => {
      const bot: BotProfile = {
        version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'moa', template: 'coordinator', name: 'Coordinator',
        engine, triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1,
      };
      return renderToStaticMarkup(createElement(BrainModelLine, { row: { bot, status: null } as unknown as FactoryBotRow, t }));
    };
    const bad = render({ kind: 'claude-sdk', model: 'opus; rm -rf ~' });
    expect(bad).toContain('data-testid="bots-profile-brain-warning"');
    expect(bad).toContain('The saved model');
    expect(bad).toContain('Default model');
    const good = render({ kind: 'claude-sdk', model: arn });
    expect(good).not.toContain('bots-profile-brain-warning');
    expect(good).toContain(arn);
  });
});
