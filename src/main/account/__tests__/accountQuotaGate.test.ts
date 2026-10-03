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
