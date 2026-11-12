import { describe, expect, it, vi } from 'vitest';
import { withAccountQuota, type QuotaLaunchOptions } from '../accountQuotaGate';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';
import type { RotationDecision } from '../AccountRotationService';

const gate = (decision: RotationDecision, initialCommand: string) => {
  const prepareLaunch = vi.fn(async () => decision);
  return { prepareLaunch, run: withAccountQuota<QuotaLaunchOptions>({ workspaceId: 'ws', initialCommand }, { prepareLaunch, platform: 'darwin' }) };
};

describe('withAccountQuota on a fan-out worker line', () => {
  it('switches a marker-prefixed claude launch whose bound account is out', async () => {
    const { prepareLaunch, run } = gate({ kind: 'switch', accountId: 'b', env: { CLAUDE_CONFIG_DIR: '/acc/b' } }, `${MODEL_ENV_MARKER}claude --model opus "task"`);
    expect((await run)?.env).toEqual({ CLAUDE_CONFIG_DIR: '/acc/b' });
    expect(prepareLaunch).toHaveBeenCalledWith('claude', 'ws');
  });

  it('holds a marker-prefixed plain launch and keeps the marker', async () => {
    const { run } = gate({ kind: 'hold', availableAtMs: null }, `${MODEL_ENV_MARKER}codex "task"`);
    const line = (await run)?.initialCommand ?? '';
    expect(line.startsWith(`${MODEL_ENV_MARKER}echo "wmux: codex was not started`)).toBe(true);
  });
});

describe('withAccountQuota and agent-setup panes', () => {
  it('leaves an ignoreAccountBinding launch alone: no rotation, no hold', async () => {
    const prepareLaunch = vi.fn();
    const options = { initialCommand: "'/home/u/.local/bin/claude'", workspaceId: 'ws-1', ignoreAccountBinding: true };
    expect(await withAccountQuota(options, { prepareLaunch })).toBe(options);
    expect(prepareLaunch).not.toHaveBeenCalled();
  });

  it('every other spawn is unchanged: the same line without the flag (or with false) still rotates', async () => {
    const decision: RotationDecision = { kind: 'switch', accountId: 'b', env: { CLAUDE_CONFIG_DIR: '/acc/b' } } as RotationDecision;
    for (const flag of [undefined, false]) {
      const prepareLaunch = vi.fn(async () => decision);
      const options: QuotaLaunchOptions = {
        initialCommand: "'/home/u/.local/bin/claude'",
        workspaceId: 'ws-1',
        ...(flag === undefined ? {} : { ignoreAccountBinding: flag }),
      };
      const out = await withAccountQuota(options, { prepareLaunch, platform: 'darwin' });
      expect(prepareLaunch).toHaveBeenCalledWith('claude', 'ws-1');
      expect(out?.env).toEqual({ CLAUDE_CONFIG_DIR: '/acc/b' });
    }
  });
});

describe('withAccountQuota and the account a create names', () => {
  it('a switch names its account on the create, so the vault follows it', async () => {
    const { run } = gate({ kind: 'switch', accountId: 'b', env: { CLAUDE_CONFIG_DIR: '/acc/b' } }, 'claude');
    expect(await run).toMatchObject({ accountId: 'b', env: { CLAUDE_CONFIG_DIR: '/acc/b' } });
  });

  it('a create that already names its account is not rotated', async () => {
    const prepareLaunch = vi.fn();
    const options: QuotaLaunchOptions = { initialCommand: 'claude', workspaceId: 'ws', accountId: 'a' };
    expect(await withAccountQuota(options, { prepareLaunch, platform: 'darwin' })).toBe(options);
    expect(prepareLaunch).not.toHaveBeenCalled();
  });
});
