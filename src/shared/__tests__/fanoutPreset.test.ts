import { describe, it, expect } from 'vitest';
import {
  FANOUT_AGENTS,
  FANOUT_PRESET_TEMPLATES,
  applyFanoutAgentFlags,
  normalizeFanoutPreset,
  normalizeFanoutPresets,
  validateFanoutAgentChoice,
} from '../fanoutPreset';
import { applyRoleAgent, applyRoleBinding, KNOWN_AGENT_STEMS } from '../orchestratorRole';

describe('validateFanoutAgentChoice', () => {
  it.each(['--dangerously-skip-permissions', '-m', 'a;b', 'x y', '$(id)', '`id`', 'a'.repeat(65)])(
    'refuses model %j (first char alphanumeric, one token, capped)',
    (model) => {
      const r = validateFanoutAgentChoice({ agent: 'codex', model });
      expect(r.ok).toBe(false);
    },
  );

  it('accepts real model ids', () => {
    for (const model of ['gpt-5.5', 'grok-4.7-build-fast', 'claude-opus-4-8', 'us.anthropic.claude:1', 'o3']) {
      expect(validateFanoutAgentChoice({ agent: 'codex', model })).toEqual({ ok: true, choice: { agent: 'codex', model } });
    }
  });

  it('refuses free commands, paths and unknown fields', () => {
    for (const agent of ['bash', 'codex --yolo', '/usr/bin/codex', 'rm -rf /', '']) {
      expect(validateFanoutAgentChoice({ agent }).ok).toBe(false);
    }
    expect(validateFanoutAgentChoice({ agent: 'codex', args: '--x' }).ok).toBe(false);
    expect(validateFanoutAgentChoice({ agent: 'codex', unattended: true }).ok).toBe(false);
    expect(validateFanoutAgentChoice({ agent: 'codex', unattended: true }, { allowUnattended: true })).toEqual({
      ok: true,
      choice: { agent: 'codex', unattended: true },
    });
  });

  it('refuses an unverified CLI with its reason instead of launching it', () => {
    const r = validateFanoutAgentChoice({ agent: 'gemini' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/not verified end to end/);
  });

  it('every selectable CLI that pins a model has a model grammar on the rewrite path', () => {
    for (const a of FANOUT_AGENTS.filter((x) => x.selectable && x.modelFlag)) {
      const out = applyRoleBinding(`${a.stem} "$(cat '/p')"`, { agent: a.stem, model: 'm1' }, {
        extraAgents: new Set([a.stem]),
      });
      expect(out.modelInjected).toBe(true);
    }
  });

  it('grok is a fan-out-only launcher, not a new agent identity', () => {
    expect(KNOWN_AGENT_STEMS.has('grok')).toBe(false);
    expect(applyRoleAgent(`claude "$(cat '/p')"`, { agent: 'grok' }).changed).toBe(false);
    expect(applyRoleAgent(`claude "$(cat '/p')"`, { agent: 'grok' }, { extraAgents: new Set(['grok']) }).command).toBe(
      `grok "$(cat '/p')"`,
    );
  });
});

describe('applyFanoutAgentFlags', () => {
  it('codex: trusts exactly the task folder for this session, flags after the launcher', () => {
    const out = applyFanoutAgentFlags(`codex --model m "$(cat '/meta/prompt.md')"`, { agent: 'codex' }, '/data/outputs/b/1-codex-x');
    expect(out).toBe(
      `codex -c 'projects={"/data/outputs/b/1-codex-x"={trust_level="trusted"}}' --model m "$(cat '/meta/prompt.md')"`,
    );
  });

  it('codex: quotes a folder with an apostrophe or a double quote', () => {
    const out = applyFanoutAgentFlags(`codex "p"`, { agent: 'codex' }, `/Users/o'neil/a"b`);
    expect(out).toBe(`codex -c 'projects={"/Users/o'\\''neil/a\\"b"={trust_level="trusted"}}' "p"`);
  });

  it('unattended adds the per-CLI flag only when the row asks for it', () => {
    expect(applyFanoutAgentFlags(`grok "p"`, { agent: 'grok' }, '/c')).toBe(`grok "p"`);
    expect(applyFanoutAgentFlags(`grok "p"`, { agent: 'grok', unattended: true }, '/c')).toBe(
      `grok --permission-mode bypassPermissions "p"`,
    );
    expect(applyFanoutAgentFlags(`codex "p"`, { agent: 'codex', unattended: true }, '')).toBe(
      `codex -a never -s workspace-write "p"`,
    );
  });

  it('never touches a command whose launcher is a different CLI', () => {
    expect(applyFanoutAgentFlags(`claude "p"`, { agent: 'codex', unattended: true }, '/c')).toBe(`claude "p"`);
  });
});

describe('presets', () => {
  it('ships Image and Video with agents filled, models blank, unattended off, no worktree', () => {
    expect(FANOUT_PRESET_TEMPLATES.map((p) => p.name)).toEqual(['Image', 'Video']);
    for (const p of FANOUT_PRESET_TEMPLATES) {
      expect(p.worktree).toBe(false);
      expect(p.items.every((i) => i.model === undefined && i.unattended === undefined)).toBe(true);
      expect(normalizeFanoutPreset(p)).toEqual({ ok: true, preset: p });
    }
  });

  it('refuses a row it cannot honour instead of dropping it', () => {
    expect(normalizeFanoutPreset({ name: 'X', items: [{ agent: 'codex', model: '--yolo' }] })).toMatchObject({ ok: false });
    expect(normalizeFanoutPreset({ name: 'X', items: [{ agent: 'codex', args: 'x' }] })).toMatchObject({ ok: false });
    expect(normalizeFanoutPreset({ name: 'X', items: [] })).toMatchObject({ ok: false });
    expect(normalizeFanoutPreset({ name: 'X', items: [{ agent: 'codex' }], worktree: false, outputFolder: '../up' })).toMatchObject({ ok: false });
  });

  it('drops duplicate names (first wins) when loading', () => {
    const list = normalizeFanoutPresets([
      { name: 'Image', items: [{ agent: 'codex' }] },
      { name: 'image', items: [{ agent: 'grok' }] },
      { name: 'bad', items: [{ agent: 'nope' }] },
    ]);
    expect(list.map((p) => p.items[0].agent)).toEqual(['codex']);
  });
});
