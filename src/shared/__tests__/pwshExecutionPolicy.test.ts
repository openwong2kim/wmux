import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
const execFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => execFileSync(...a),
  execFile: (...a: unknown[]) => execFile(...a),
}));

import {
  FACTORY_DEFAULT_SCOPES,
  POLICY_QUERIES,
  REMOTE_SIGNED_ARGS,
  __setPolicyProbeForTests,
  isFactoryDefault,
  isWindowsPowerShell,
  parseRegQuery,
  windowsPowerShellPolicyArgs,
  type PolicyScopes,
} from '../pwshExecutionPolicy';

const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

// Real `reg query` output shapes, captured on Windows 11 (the value lines are
// not localized even on a Korean-locale machine).
const SHELL_IDS_WITH_POLICY =
  '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell\r\n' +
  '    ExecutionPolicy    REG_SZ    RemoteSigned\r\n\r\n';
const SHELL_IDS_PATH_ONLY =
  '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell\r\n' +
  '    Path    REG_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n\r\n';

function regMissing(): Error {
  return Object.assign(new Error('key missing'), { status: 1 });
}

describe('isWindowsPowerShell', () => {
  it('matches Windows PowerShell 5.1 in any path form', () => {
    expect(isWindowsPowerShell(PS51)).toBe(true);
    expect(isWindowsPowerShell('powershell.exe')).toBe(true);
    expect(isWindowsPowerShell('POWERSHELL.EXE')).toBe(true);
    expect(isWindowsPowerShell('powershell')).toBe(true);
  });

  it('never matches pwsh 7, which ships RemoteSigned and has no bug to fix', () => {
    expect(isWindowsPowerShell(PS7)).toBe(false);
    expect(isWindowsPowerShell('pwsh')).toBe(false);
  });

  it('does not match other shells', () => {
    expect(isWindowsPowerShell('cmd.exe')).toBe(false);
    expect(isWindowsPowerShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
    expect(isWindowsPowerShell('')).toBe(false);
  });
});

describe('parseRegQuery', () => {
  it('reads an explicit policy as set', () => {
    expect(parseRegQuery(SHELL_IDS_WITH_POLICY, ['ExecutionPolicy'])).toBe('set');
  });

  it('ignores unrelated values in the same key', () => {
    expect(parseRegQuery(SHELL_IDS_PATH_ONLY, ['ExecutionPolicy'])).toBe('unset');
  });

  it('treats a literal Undefined value as unset', () => {
    const out = '    ExecutionPolicy    REG_SZ    Undefined\r\n';
    expect(parseRegQuery(out, ['ExecutionPolicy'])).toBe('unset');
  });

  it('counts a Group Policy EnableScripts value as set', () => {
    const out = '    EnableScripts    REG_DWORD    0x0\r\n';
    expect(parseRegQuery(out, ['EnableScripts', 'ExecutionPolicy'])).toBe('set');
  });
});

describe('isFactoryDefault', () => {
  const base = FACTORY_DEFAULT_SCOPES;
  it('is true only when every scope is positively unset', () => {
    expect(isFactoryDefault(base)).toBe(true);
  });
  it.each(['machinePolicy', 'userPolicy', 'currentUser', 'localMachine'] as const)(
    'is false when %s is set',
    (scope) => {
      expect(isFactoryDefault({ ...base, [scope]: 'set' })).toBe(false);
    },
  );
  it('is false when any scope is unknown, so a failed probe changes nothing', () => {
    expect(isFactoryDefault({ ...base, localMachine: 'unknown' })).toBe(false);
  });
});

describe('windowsPowerShellPolicyArgs (pinned probe)', () => {
  afterEach(() => __setPolicyProbeForTests(null));

  it('adds RemoteSigned for 5.1 on a factory-default Windows client', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);
  });

  it('leaves an explicit CurrentUser policy alone', () => {
    __setPolicyProbeForTests({ scopes: { ...FACTORY_DEFAULT_SCOPES, currentUser: 'set' }, platform: 'win32' });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('leaves Group Policy alone', () => {
    __setPolicyProbeForTests({ scopes: { ...FACTORY_DEFAULT_SCOPES, machinePolicy: 'set' }, platform: 'win32' });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('never touches pwsh 7, even on a factory-default machine', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    expect(windowsPowerShellPolicyArgs(PS7)).toEqual([]);
  });

  it('is a no-op off Windows', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'darwin' });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('returns a fresh array each call so callers cannot mutate the constant', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    const a = windowsPowerShellPolicyArgs(PS51);
    a.push('x');
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);
  });
});

describe('windowsPowerShellPolicyArgs (real probe, reg.exe mocked)', () => {
  // The real probe only runs on win32; pin the platform without pinning scopes
  // by temporarily faking process.platform.
  const realPlatform = process.platform;
  beforeEach(() => {
    __setPolicyProbeForTests(null);
    execFileSync.mockReset();
    execFile.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    __setPolicyProbeForTests(null);
    vi.useRealTimers();
  });

  function respond(answers: Partial<Record<keyof PolicyScopes, string | Error>>): void {
    execFileSync.mockImplementation((_exe: string, args: string[]) => {
      const q = POLICY_QUERIES.find((x) => x.key === args[1]);
      const a = q ? answers[q.scope] : undefined;
      if (a === undefined) throw regMissing();
      if (a instanceof Error) throw a;
      return a;
    });
  }

  it('queries all four scopes and adds the flag when every key is missing', () => {
    respond({});
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);
    expect(execFileSync.mock.calls.map((c) => c[1][1])).toEqual(POLICY_QUERIES.map((q) => q.key));
  });

  it('treats a key that exists without a policy value as unset', () => {
    respond({ localMachine: SHELL_IDS_PATH_ONLY });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);
  });

  it('respects a CurrentUser policy found in the registry', () => {
    respond({ currentUser: SHELL_IDS_WITH_POLICY });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('fails closed on a timeout: no flag, today\'s behavior', () => {
    respond({ userPolicy: Object.assign(new Error('ETIMEDOUT'), { killed: true, signal: 'SIGTERM' }) });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('fails closed on a spawn failure', () => {
    respond({ machinePolicy: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });

  it('probes once and serves later spawns from the cache', () => {
    respond({});
    windowsPowerShellPolicyArgs(PS51);
    windowsPowerShellPolicyArgs(PS51);
    windowsPowerShellPolicyArgs(PS51);
    expect(execFileSync).toHaveBeenCalledTimes(POLICY_QUERIES.length);
  });

  it('does not probe at all for pwsh 7 or off-family shells', () => {
    respond({});
    windowsPowerShellPolicyArgs(PS7);
    windowsPowerShellPolicyArgs('cmd.exe');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('after the TTL, serves the cached answer and refreshes in the background', async () => {
    vi.useFakeTimers();
    respond({});
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);

    // The user runs Set-ExecutionPolicy -Scope CurrentUser AllSigned.
    execFile.mockImplementation((_exe: string, args: string[], _o: unknown, cb: (e: unknown, out?: string) => void) => {
      const q = POLICY_QUERIES.find((x) => x.key === args[1]);
      if (q?.scope === 'currentUser') cb(null, SHELL_IDS_WITH_POLICY);
      else cb(regMissing());
    });
    vi.advanceTimersByTime(61_000);

    // Stale answer now, no synchronous re-probe on the spawn path.
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([...REMOTE_SIGNED_ARGS]);
    expect(execFileSync).toHaveBeenCalledTimes(POLICY_QUERIES.length);

    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(windowsPowerShellPolicyArgs(PS51)).toEqual([]);
  });
});
