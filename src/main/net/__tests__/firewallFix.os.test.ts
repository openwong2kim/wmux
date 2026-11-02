import { describe, it, expect, vi } from 'vitest';
import { FirewallFixer, INBOUND_STATUS_RPC_TIMEOUT_MS, type FirewallFixDeps } from '../firewallFix';
import { inapplicableStatus, type InboundStatus } from '../../../shared/netFirewall';
import { firewallRuleIds, type RuleScope } from '../../../shared/netFirewallScripts';
import type { ShellRunResult } from '../elevate';

const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe';
const SCOPE: RuleScope = { dataSuffix: '', user: 'DESK\\me', group: 'wmux' };
const IDS = firewallRuleIds('a2a', EXE, SCOPE);

function status(over: Partial<InboundStatus> = {}): InboundStatus {
  return {
    ...inapplicableStatus('a2a', 'win32', EXE, 1),
    applicable: true,
    port: 45660,
    verdict: 'not-covered',
    ruleIds: { allow: IDS.allow, pubblock: IDS.pubblock },
    ...over,
  };
}

function setup(opts: {
  probes?: InboundStatus[];
  target?: Record<string, unknown>;
  elevate?: () => Promise<ShellRunResult>;
  selfExe?: string;
  stagedExe?: string | null;
  scope?: () => RuleScope;
} = {}) {
  const probes = [...(opts.probes ?? [status(), status({ verdict: 'covered' })])];
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  const scripts: string[] = [];
  const deps: FirewallFixDeps = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>, o?: { timeoutMs?: number }) => {
      calls.push({ method, params, ...(o?.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      if (method === 'net.inboundStatus') return probes.length > 1 ? probes.shift() : probes[0];
      if (method === 'net.firewallTarget') return { listener: 'a2a', platform: 'win32', exe: EXE, applicable: true, port: 45660, tailnet: false, ...opts.target };
      if (method === 'net.firewallRecord') return { ok: true };
      throw new Error(`unexpected ${method}`);
    }),
    elevateWindows: vi.fn(async (script: string) => {
      scripts.push(script);
      return opts.elevate ? opts.elevate() : { started: true, lastError: null, exitCode: 0 };
    }),
    elevateMac: vi.fn(async () => ({ kind: 'ok' as const })),
    facts: { exists: () => true, onLocalFixedDrive: () => true },
    scope: opts.scope ?? (() => SCOPE),
    selfExe: opts.selfExe ?? EXE,
    stagedExe: () => opts.stagedExe ?? null,
    platform: 'win32',
    tokenType: () => 3,
    selfElevated: () => false,
  };
  return { fixer: new FirewallFixer(deps), deps, calls, scripts, records: () => calls.filter((c) => c.method === 'net.firewallRecord').map((c) => c.params['op']) };
}

describe('FirewallFixer.status', () => {
  it('asks the daemon with a deadline above the probe\'s and adds the prompt kind', async () => {
    const { fixer, calls } = setup();
    const s = await fixer.status('a2a');
    expect(calls[0]).toEqual({ method: 'net.inboundStatus', params: { listener: 'a2a' }, timeoutMs: INBOUND_STATUS_RPC_TIMEOUT_MS });
    expect(s.elevation).toBe('consent');
  });

  it('an older answer that arrives after a newer one is not what the Fix acts on', async () => {
    const answers: Array<(s: InboundStatus) => void> = [];
    const t = setup();
    (t.deps.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === 'net.inboundStatus') return new Promise((r) => answers.push(r));
      if (method === 'net.firewallTarget') return { listener: 'a2a', platform: 'win32', exe: EXE, applicable: true, port: 45660, tailnet: false };
      return { ok: true };
    });
    const older = t.fixer.status('a2a');
    const newer = t.fixer.status('a2a');
    await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 5_000 });
    answers[1](status({ verdict: 'covered' }));
    await newer;
    answers[0](status());
    await older;
    // The newest check said covered: a Fix is refused, not run for the stale not-covered.
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(t.deps.elevateWindows).not.toHaveBeenCalled();
  });

  it('a fresh check asks for a probe that starts now', async () => {
    const { fixer, calls } = setup();
    await fixer.status('a2a', { fresh: true });
    expect(calls[0].params).toEqual({ listener: 'a2a', fresh: true });
  });
});

describe('FirewallFixer.fix', () => {
  it('runs one elevation, re-probes, and records a rule the re-probe confirmed', async () => {
    const { fixer, scripts, records, calls } = setup();
    await fixer.status('a2a');
    const r = await fixer.fix('a2a');
    expect(r.outcome).toEqual({ kind: 'ok' });
    expect(r.status?.verdict).toBe('covered');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`NetSecurity\\New-NetFirewallRule -Name '${IDS.allow}'`);
    expect(records()).toEqual(['set']);
    // The re-probe never joins a probe that began before the rules existed.
    expect(calls.filter((c) => c.method === 'net.inboundStatus').map((c) => c.params)).toEqual([{ listener: 'a2a' }, { listener: 'a2a', fresh: true }]);
  });

  it('a declined prompt is cancelled; the probe still runs and nothing is recorded', async () => {
    const { fixer, records, calls } = setup({ probes: [status(), status()], elevate: async () => ({ started: false, lastError: 1223, exitCode: null }) });
    await fixer.status('a2a');
    const r = await fixer.fix('a2a');
    expect(r.outcome).toEqual({ kind: 'cancelled' });
    expect(calls.filter((c) => c.method === 'net.inboundStatus')).toHaveLength(2);
    expect(records()).toEqual([]);
  });

  it('a failed stage is reported by name, and the re-probe decides the rest', async () => {
    const { fixer, records } = setup({ probes: [status(), status()], elevate: async () => ({ started: true, lastError: null, exitCode: 11 }) });
    await fixer.status('a2a');
    const r = await fixer.fix('a2a');
    expect(r.outcome).toEqual({ kind: 'failed', stage: 'allow', code: 11 });
    expect(r.status?.verdict).toBe('not-covered');
    expect(records()).toEqual([]);
  });

  it('refuses without a check the person saw, for an explain-only verdict, or a refused program', async () => {
    const none = setup();
    expect((await none.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
    for (const [over, refusal] of [
      [{ verdict: 'public-network' }, 'changed'],
      [{ verdict: 'covered' }, 'changed'],
      [{ refusal: 'node-daemon' }, 'node-daemon'],
    ] as const) {
      const t = setup({ probes: [status(over)] });
      await t.fixer.status('a2a');
      expect((await t.fixer.fix('a2a')).outcome, JSON.stringify(over)).toEqual({ kind: 'refused', refusal });
      expect(t.deps.elevateWindows).not.toHaveBeenCalled();
    }
  });

  it('refuses a program that is not main\'s own, even when the daemon\'s two answers agree', async () => {
    // Same install root, so the same rule IDs: only the program tells them apart (a daemon left from another version).
    const other = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.9.0\\wmux.exe';
    const t = setup({ probes: [status({ exe: other })], target: { exe: other } });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(t.deps.elevateWindows).not.toHaveBeenCalled();
    // The same file in another case is main's own (Windows paths).
    const upper = setup({ selfExe: EXE.toUpperCase() });
    await upper.fixer.status('a2a');
    expect((await upper.fixer.fix('a2a')).outcome).toEqual({ kind: 'ok' });
  });

  it('accepts the staged copy this build\'s daemon runs from, and no other copy', async () => {
    const staged = 'C:\\Users\\me\\.wmux\\daemon-runtime\\4.10.0-1793650000123\\wmux.exe';
    const ids = firewallRuleIds('a2a', staged, SCOPE);
    const stagedStatus = (over: Partial<InboundStatus> = {}) => status({ exe: staged, ruleIds: { allow: ids.allow, pubblock: ids.pubblock }, ...over });
    const t = setup({ stagedExe: staged, probes: [stagedStatus(), stagedStatus({ verdict: 'covered' })], target: { exe: staged } });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'ok' });
    // An older build's copy is not this build's.
    const old = 'C:\\Users\\me\\.wmux\\daemon-runtime\\4.9.0-1793640000000\\wmux.exe';
    const o = setup({ stagedExe: staged, probes: [status({ exe: old, ruleIds: { allow: ids.allow, pubblock: ids.pubblock } })], target: { exe: old } });
    await o.fixer.status('a2a');
    expect((await o.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(o.deps.elevateWindows).not.toHaveBeenCalled();
  });

  it('reads the rule scope at each click, not when the fixer was made', async () => {
    let scope: RuleScope = { ...SCOPE, dataSuffix: '-dev' };
    const t = setup({ scope: () => scope, probes: [status(), status(), status({ verdict: 'covered' })] });
    await t.fixer.status('a2a');
    // The probe showed IDs for the default instance; the scope still says -dev: refused.
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
    scope = SCOPE;
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'ok' });
  });

  it('refuses when the daemon now reports another program, port or rule ID', async () => {
    for (const target of [{ exe: EXE.replace('4.10.0', '4.11.0') }, { port: 45661 }, { applicable: false }]) {
      const t = setup({ target });
      await t.fixer.status('a2a');
      expect((await t.fixer.fix('a2a')).outcome, JSON.stringify(target)).toEqual({ kind: 'refused', refusal: 'changed' });
      expect(t.deps.elevateWindows).not.toHaveBeenCalled();
    }
    const t = setup({ probes: [status({ ruleIds: { allow: 'wmux-a2a-00000000-allow', pubblock: 'wmux-a2a-00000000-pubblock' } })] });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
  });

  it('one elevation at a time: a second click while one runs is busy', async () => {
    let release: (r: ShellRunResult) => void = () => undefined;
    const t = setup({ elevate: () => new Promise((r) => { release = r; }) });
    await t.fixer.status('a2a');
    const first = t.fixer.fix('a2a');
    await vi.waitFor(() => expect(t.deps.elevateWindows).toHaveBeenCalled(), { timeout: 5_000 });
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'busy' });
    release({ started: true, lastError: null, exitCode: 0 });
    expect((await first).outcome).toEqual({ kind: 'ok' });
  });

  it('an elevated child that outlived the wait keeps the slot until it exits', async () => {
    let exited: () => void = () => undefined;
    const stillRunning = new Promise<void>((r) => { exited = r; });
    const t = setup({ probes: [status(), status(), status(), status()], elevate: async () => ({ started: true, lastError: null, exitCode: null, stillRunning }) });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'running' });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'busy' });
    expect(t.deps.elevateWindows).toHaveBeenCalledTimes(1);
    exited();
    await stillRunning;
    await new Promise((r) => setTimeout(r, 0));
    await t.fixer.status('a2a');
    await t.fixer.fix('a2a');
    expect(t.deps.elevateWindows).toHaveBeenCalledTimes(2);
  });
});

describe('FirewallFixer.remove', () => {
  it('only for our covering rule; forgets the record once the re-probe no longer sees it', async () => {
    const t = setup({ probes: [status({ verdict: 'covered' }), status({ verdict: 'not-covered' })] });
    await t.fixer.status('a2a');
    const r = await t.fixer.remove('a2a');
    expect(r.outcome).toEqual({ kind: 'ok' });
    expect(t.scripts[0]).toContain(`NetSecurity\\Remove-NetFirewallRule -Name '${IDS.allow}','${IDS.pubblock}' -ErrorAction SilentlyContinue }`);
    expect(t.records()).toEqual(['clear']);

    const n = setup({ probes: [status({ verdict: 'covered-by-prompt' })] });
    await n.fixer.status('a2a');
    expect((await n.fixer.remove('a2a')).outcome).toEqual({ kind: 'refused', refusal: 'changed' });
  });
});

describe('macOS (unverified on a Mac)', () => {
  it('runs the AppleScript for the reported program', async () => {
    const mac = status({ platform: 'darwin', exe: '/Applications/wmux.app/Contents/MacOS/wmux', ruleIds: null });
    const t = setup({
      probes: [mac, { ...mac, verdict: 'covered' }],
      target: { platform: 'darwin', exe: '/Applications/wmux.app/Contents/MacOS/wmux' },
      selfExe: '/Applications/wmux.app/Contents/MacOS/wmux',
    });
    await t.fixer.status('a2a');
    expect((await t.fixer.fix('a2a')).outcome).toEqual({ kind: 'ok' });
    expect(t.deps.elevateMac).toHaveBeenCalledWith(expect.stringContaining("--unblockapp '/Applications/wmux.app/Contents/MacOS/wmux'"));
    expect(t.deps.elevateWindows).not.toHaveBeenCalled();
  });
});
