import { describe, expect, it, vi } from 'vitest';
import { withAccountQuota, withAgyAccountQuota, type QuotaLaunchOptions } from '../accountQuotaGate';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';
import type { AgyLaunchDecision } from '../../../shared/agyAccounts';

const OUT: AgyLaunchDecision = { ok: false, reason: 'all-exhausted', availableAtMs: null };
const OK: AgyLaunchDecision = { ok: true, account: null, switched: false };

const gate = (decision: AgyLaunchDecision, initialCommand: string) => {
  const prepareLaunch = vi.fn(async () => decision);
  return { prepareLaunch, run: withAgyAccountQuota<QuotaLaunchOptions>({ workspaceId: 'ws', initialCommand }, { prepareLaunch }) };
};

describe('withAgyAccountQuota', () => {
  it('holds a new agy session when every account is out', async () => {
    const { prepareLaunch, run } = gate(OUT, 'agy -i "fix it"');
    expect((await run)?.initialCommand).toMatch(/^echo "wmux: agy was not started/);
    expect(prepareLaunch).toHaveBeenCalledTimes(1);
  });

  it('lets the launch through when the service says ok', async () => {
    const { run } = gate(OK, 'agy');
    expect((await run)?.initialCommand).toBe('agy');
  });

  it.each([
    'agy --continue',
    'agy -c',
    'agy --conversation abc123',
    'agy mcp list',
    'agy models',
    'agy update',
    'claude',
    'echo agy',
  ])('leaves %s alone and reads nothing', async (line) => {
    const { prepareLaunch, run } = gate(OUT, line);
    expect((await run)?.initialCommand).toBe(line);
    expect(prepareLaunch).not.toHaveBeenCalled();
  });

  it('never drops commands chained after the launch', async () => {
    const { run } = gate(OUT, 'agy -i "x" && ./build.sh');
    expect((await run)?.initialCommand).toBe('agy -i "x" && ./build.sh');
  });

  it('keeps a fan-out worker line\'s model-env marker when holding', async () => {
    const { run } = gate(OUT, `${MODEL_ENV_MARKER}agy -i "task"`);
    const line = (await run)?.initialCommand ?? '';
    expect(line.startsWith(MODEL_ENV_MARKER)).toBe(true);
    expect(line.slice(MODEL_ENV_MARKER.length)).toMatch(/^echo "wmux: agy was not started/);
  });

  it('launches unchanged when the service throws', async () => {
    const prepareLaunch = vi.fn(async () => { throw new Error('boom'); });
    const out = await withAgyAccountQuota<QuotaLaunchOptions>({ initialCommand: 'agy' }, { prepareLaunch });
    expect(out?.initialCommand).toBe('agy');
  });

  it('is reached through withAccountQuota, the one gate pty.handler calls', async () => {
    const prepareAgyLaunch = vi.fn(async () => OUT);
    const prepareLaunch = vi.fn();
    const out = await withAccountQuota<QuotaLaunchOptions>({ initialCommand: 'agy' }, { prepareAgyLaunch, prepareLaunch });
    expect(out?.initialCommand).toMatch(/^echo "wmux: agy was not started/);
    expect(prepareLaunch).not.toHaveBeenCalled();
  });
});
