// The built-in bot presets: each role preset exists, runs unattended on a
// worktree (research: a scratch folder), and only verify takes a checkout —
// a detached one of one commit.
import { describe, expect, it } from 'vitest';
import { ROLE_SURFACES } from '../../../shared/botSurface';
import { BOT_ROLES } from '../../../shared/bot';
import {
  BOT_FANOUT_PRESETS,
  BOT_FANOUT_PRESET_NAMES,
  botFanoutPreset,
  botFanoutPresetList,
  botPresetCheckoutRefusal,
  composeBotWorkerPrompt,
} from '../botFanoutPresets';

const SHA = 'a'.repeat(40);

describe('bot fan-out presets', () => {
  it('every preset a role surface names exists, and every built-in belongs to a role', () => {
    const named = new Set(BOT_ROLES.flatMap((r) => [...ROLE_SURFACES[r].fanoutPresets]));
    for (const name of named) expect(botFanoutPreset(name)).not.toBeNull();
    expect([...named].sort()).toEqual([...BOT_FANOUT_PRESET_NAMES].sort());
  });

  it('runs unattended, on claude, on a worktree for every preset but research', () => {
    for (const p of botFanoutPresetList()) {
      expect(p.worktree).toBe(p.name !== 'research');
      expect(p.items.length).toBe(BOT_FANOUT_PRESETS[p.name as keyof typeof BOT_FANOUT_PRESETS].maxTasks);
      expect(p.items.every((i) => i.agent === 'claude')).toBe(true);
    }
    for (const name of BOT_FANOUT_PRESET_NAMES) expect(BOT_FANOUT_PRESETS[name].permissionMode).toBe('bypassPermissions');
    expect(BOT_FANOUT_PRESETS.verify.maxTasks).toBe(1);
  });

  it('verify refuses a missing, non-detached or non-commit checkout', () => {
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: true })).toBeNull();
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: true, fetchRef: 'pull/3/head' })).toBeNull();
    expect(botPresetCheckoutRefusal('verify', undefined)).toMatch(/needs checkout/);
    expect(botPresetCheckoutRefusal('verify', { sha: SHA, detached: false })).toMatch(/detached/);
    for (const sha of ['HEAD', 'main', 'a'.repeat(39), 'A'.repeat(40), `${SHA}0`]) {
      expect(botPresetCheckoutRefusal('verify', { sha, detached: true })).toMatch(/40-hex/);
    }
  });

  it('the other presets refuse any checkout; an unknown preset is refused', () => {
    for (const name of ['repro', 'maintain', 'default', 'research']) {
      expect(botPresetCheckoutRefusal(name, undefined)).toBeNull();
      expect(botPresetCheckoutRefusal(name, { sha: SHA, detached: true })).toMatch(/checkout is for verify/);
    }
    expect(botPresetCheckoutRefusal('Image', undefined)).toMatch(/unknown bot preset/);
  });

  it('the worker prompt goes first, the bot\'s own after it; verify names the head', () => {
    const p = composeBotWorkerPrompt('verify', 'look at the IPC change', { sha: SHA, detached: true });
    expect(p.startsWith('# Verify worker')).toBe(true);
    expect(p).toContain(SHA);
    expect(p.endsWith('## Your task\n\nlook at the IPC change')).toBe(true);
    expect(composeBotWorkerPrompt('repro', '')).toMatch(/^# Repro worker[\s\S]*DRAFT pull request[\s\S]*`gh pr ready <number>`/);
    expect(composeBotWorkerPrompt('nope', 'x')).toBe('x');
  });

  it('worker prompts state powers and outputs, without prohibitions', () => {
    for (const name of BOT_FANOUT_PRESET_NAMES) {
      const text = BOT_FANOUT_PRESETS[name].workerPrompt({ checkout: { sha: SHA, detached: true } });
      expect(text).toMatch(/What you hand back/);
      expect(text.split('\n').filter((l) => /\b(never|don't|do not|must not)\b/i.test(l))).toEqual([]);
    }
  });
});
