// Per-bot models: the template defaults name only catalog ids, the worker
// pick fills the preset rows' model and effort without overriding a row's
// own pin, and one model rule serves fan-out and bots.

import { describe, expect, it } from 'vitest';
import { TEMPLATE_MODEL_DEFAULTS } from '../bot';
import { CLAUDE_MODEL_OPTIONS } from '../claudeModels';
import { validateBotBrainModel, validateFanoutAgentChoice, validateFanoutModel } from '../fanoutPreset';
import { validateBotWorkerAgent, withBotWorkerAgent } from '../botWorkerAgent';

describe('per-bot models', () => {
  it('template defaults use model ids the catalog offers, and validate as a worker pick', () => {
    const catalog = new Set(CLAUDE_MODEL_OPTIONS.map((o) => o.value).filter(Boolean));
    for (const d of Object.values(TEMPLATE_MODEL_DEFAULTS)) {
      if (d?.brain) expect(catalog.has(d.brain.model)).toBe(true);
      if (d?.worker) {
        expect(catalog.has(d.worker.model ?? '')).toBe(true);
        expect(validateBotWorkerAgent(d.worker, 'win32')).toEqual({ ok: true, value: d.worker });
      }
    }
    expect(Object.keys(TEMPLATE_MODEL_DEFAULTS).sort()).toEqual(['coordinator', 'developer', 'issue', 'researcher', 'reviewer']);
  });

  it('the worker default fills every row that pins nothing', () => {
    expect(withBotWorkerAgent([{ agent: 'claude' }, { agent: 'claude' }], { agent: 'claude', model: 'opus', effort: 'high' })).toEqual([
      { agent: 'claude', model: 'opus', effort: 'high' },
      { agent: 'claude', model: 'opus', effort: 'high' },
    ]);
    expect(withBotWorkerAgent([{ agent: 'claude' }], undefined)).toEqual([{ agent: 'claude' }]);
  });

  it('a row\'s own model and effort win over the bot\'s default; another agent\'s pin does not cross over', () => {
    const pick = { agent: 'claude', model: 'opus', effort: 'high' };
    expect(withBotWorkerAgent([{ agent: 'claude', model: 'sonnet' }, { agent: 'claude', effort: 'low' }], pick)).toEqual([
      { agent: 'claude', model: 'sonnet', effort: 'high' },
      { agent: 'claude', model: 'opus', effort: 'low' },
    ]);
    expect(withBotWorkerAgent([{ agent: 'claude', model: 'sonnet' }], { agent: 'codex', model: 'gpt-6.1-sol' })).toEqual([{ agent: 'codex', model: 'gpt-6.1-sol' }]);
    expect(withBotWorkerAgent([{ agent: 'claude', model: 'sonnet' }], { agent: 'codex' })).toEqual([{ agent: 'codex' }]);
  });

  it('one model rule: what fan-out refuses as agents[k].model, a bot model refuses too', () => {
    for (const model of ['opus', 'claude-opus-5-5', 'gpt-6.1-sol', 'claude-haiku-4-5-20251001']) {
      expect(validateFanoutModel(model)).toEqual({ ok: true, model });
      expect(validateFanoutAgentChoice({ agent: 'claude', model })).toMatchObject({ ok: true });
    }
    for (const model of ['--yolo', '-m', 'claude opus', 'x'.repeat(65), '']) {
      expect(validateFanoutModel(model)).toMatchObject({ ok: false, code: 'model-invalid' });
    }
    expect(validateFanoutModel(42)).toMatchObject({ ok: false, code: 'model-not-string' });
    expect(validateFanoutAgentChoice({ agent: 'claude', model: '--yolo' })).toMatchObject({ ok: false, code: 'model-invalid' });
  });

  it('a bot\'s own model takes Bedrock / Vertex ids and ARNs up to 256, and still refuses shell words (#2272)', () => {
    for (const model of [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-20260901-v1:0',
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5-v1:0',
      'us.anthropic.claude-sonnet-5-5-v1:0',
      'claude-opus-5-5@20260901',
      'publishers/anthropic/models/claude-opus-5-5@20260901',
      'sonnet[1m]',
      'glm-5.3',
      `m${'x'.repeat(255)}`,
    ]) {
      expect(validateBotBrainModel(model)).toEqual({ ok: true, model });
    }
    expect(validateBotBrainModel('  opus  ')).toEqual({ ok: true, model: 'opus' });
    for (const model of [
      '', '-m', '--model', '--dangerously-skip-permissions', '/abs/path', '@x', 'claude opus', 'opus\tx', 'opus\nid', 'opus\u0000', 'opus\u001b',
      'a;b', 'a&b', 'a|b', 'a$b', 'a`id`', "a'b", 'a"b', 'a<b', 'a>b', 'a(b)', 'a{b}', 'a*', 'a?', 'a~', 'a#b', 'a!b', 'a\\b', 'a,b', 'a=b',
      `m${'x'.repeat(256)}`,
    ]) {
      expect(validateBotBrainModel(model)).toEqual({ ok: false });
    }
    expect(validateBotBrainModel(42)).toEqual({ ok: false });
    // Workers keep fan-out's strict rule: their model lands on a shell line.
    expect(validateFanoutModel('claude-opus-5-5@20260901')).toMatchObject({ ok: false });
    expect(validateFanoutModel('arn:aws:bedrock:us-east-1::foundation-model/x')).toMatchObject({ ok: false });
  });
});
