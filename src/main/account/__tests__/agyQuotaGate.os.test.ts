import { describe, expect, it, vi } from 'vitest';
import { withAccountQuota, withAgyAccountQuota, type QuotaLaunchOptions } from '../accountQuotaGate';
import { MODEL_ENV_MARKER, workerLaunchFlags } from '../../../shared/workerLaunch';
import { buildInitialCommand, workerLaunchCommand } from '../../worktask/FanOutService';
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

  it('says only the active account is out when wmux may not switch away and another has quota', async () => {
    const held = await gate({ ok: false, reason: 'active-exhausted', availableAtMs: null }, 'agy').run;
    expect(held?.initialCommand).toMatch(/the active agy account is out of quota/);
    expect(held?.initialCommand).not.toMatch(/every registered/);
    expect((await gate(OUT, 'agy').run)?.initialCommand).toMatch(/every registered agy account is out of quota/);
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

  it.each([
    ['agy -i "fix it"', 'gemini'],
    ['agy --model gemini-3.8-flash-low -i "x"', 'gemini'],
    ['agy --model claude-sonnet-4-5 -i "x"', '3p'],
    ['agy --model="gpt-oss-120b-medium"', '3p'],
  ])('asks about the quota of the family %s launches', async (line, family) => {
    const { prepareLaunch, run } = gate(OK, line);
    await run;
    expect(prepareLaunch).toHaveBeenCalledWith(family);
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

// A fan-out task's line reads its prompt file with command substitution. That is wmux's own argument,
// not a chain the user typed, so a hold must still apply. Lines come from the real builder.
describe('account quota gate — fan-out lines with a prompt file', () => {
  const posixPath = "/tmp/wmux tasks/it's $HOME `x`/prompt.md";
  const winPath = "C:\\Users\\o'brien\\wmux $env:X\\prompt.md";

  it.each([
    ['linux', posixPath],
    ['win32', winPath],
  ] as const)('holds an agy fan-out launch on %s when every account is out', async (platform, promptPath) => {
    const line = buildInitialCommand('agy', promptPath, platform);
    expect(line).toContain('$(');
    const { run } = gate(OUT, line);
    expect((await run)?.initialCommand).toMatch(/^echo "wmux: agy was not started/);
  });

  it('holds a claude fan-out worker line (model-env marker, prompt file, permission flags)', async () => {
    const line = `${workerLaunchCommand('claude', posixPath, { platform: 'linux' }).command} ${workerLaunchFlags('auto')}`;
    expect(line.startsWith(MODEL_ENV_MARKER)).toBe(true);
    const prepareLaunch = vi.fn(async () => ({ kind: 'hold' as const, availableAtMs: null }));
    const out = await withAccountQuota<QuotaLaunchOptions>({ workspaceId: 'ws', initialCommand: line }, { prepareLaunch });
    expect(out?.initialCommand).toBe(`${MODEL_ENV_MARKER}echo "wmux: claude was not started - every registered claude account is out of quota."`);
  });

  it.each([
    ['linux', posixPath],
    ['win32', winPath],
  ] as const)('still never drops a command chained after a %s fan-out line', async (platform, promptPath) => {
    const line = `${buildInitialCommand('agy', promptPath, platform)} && ./build.sh`;
    const { run } = gate(OUT, line);
    expect((await run)?.initialCommand).toBe(line);
  });

  it.each([
    `agy -i "$(cat 'p.md'; rm -rf x)"`,
    `agy -i "$(cat 'p.md')" ; ./build.sh`,
    `agy -i "$(cat "p.md")"`,
    `agy -i "$(cat 'a')" && ./build.sh "$(cat 'b')"`,
  ])('treats a substitution that is not wmux\'s exact prompt read as a chain: %s', async (line) => {
    const { run } = gate(OUT, line);
    expect((await run)?.initialCommand).toBe(line);
  });
});
