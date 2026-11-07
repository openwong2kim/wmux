import { describe, expect, it, vi } from 'vitest';
import { buildMcpSection, type McpDoctorDeps } from '../doctor';
import type { TargetRegStatus } from '../../../shared/mcpRegistration';
import type { McpSessionsSummary } from '../../../shared/mcpSessions';

const HOME = '/home/alice';

function target(id: string, path: string | null, profile: 'full' | 'core' | 'commander' | null = 'full'): TargetRegStatus {
  return {
    id,
    displayName: id,
    format: 'json',
    configPath: `${HOME}/.${id}.json`,
    configExists: path !== null,
    configModified: null,
    verified: true,
    wmux: { registered: path !== null, path, profile: path === null ? null : profile },
  };
}

const summary: McpSessionsSummary = {
  broker: { enabled: true, running: true, pid: 4321, uptimeS: 3725, connections: 2, crashExits: 1, spawnFailures: 3, standDowns: 0, standingDown: false, downReason: null },
  bundle: { recent: 3, capped: false, ttlS: 600 },
};

function deps(over: Partial<McpDoctorDeps> = {}): McpDoctorDeps {
  return {
    home: HOME,
    targets: () => [
      target('claude', `${HOME}/.wmux/mcp/wmux-native`, 'core'),
      target('cursor', `${HOME}/.wmux/mcp/shim.js`),
      target('codex', `${HOME}/.wmux/mcp/index.js`, 'commander'),
      target('gemini', '/opt/tools/other.js'),
      target('windsurf', null),
    ],
    recordedVerdict: () => 'pass',
    sessions: () => Promise.resolve({ id: '1', ok: true, result: summary }),
    ...over,
  };
}

describe('doctor mcp section', () => {
  it('names each registered launcher and profile without printing the home path', async () => {
    const section = await buildMcpSection(deps());
    const byLabel = Object.fromEntries(section.lines.map((l) => [l.label, l]));
    expect(byLabel['registered (claude)']).toMatchObject({ value: 'native, core (~/.wmux/mcp/wmux-native)', verdict: 'OK' });
    expect(byLabel['registered (cursor)']).toMatchObject({ value: 'node-shim, full (~/.wmux/mcp/shim.js)', verdict: 'OK' });
    expect(byLabel['registered (codex)']).toMatchObject({ value: 'bundle, commander (~/.wmux/mcp/index.js)', verdict: 'OK' });
    expect(byLabel['registered (gemini)']).toMatchObject({ value: 'other node script, full', verdict: 'OK' });
    expect(byLabel['registered (windsurf)']).toMatchObject({ value: 'not registered', verdict: 'OK' });
    expect(JSON.stringify(section)).not.toContain(HOME);
  });

  it('does not relativize against a root home', async () => {
    const section = await buildMcpSection(deps({ home: '/', targets: () => [target('cursor', '/opt/wmux/.wmux/mcp/shim.js')] }));
    expect(section.lines[0].value).toBe('node-shim, full (/opt/wmux/.wmux/mcp/shim.js)');
  });

  it('warns when the registered native copy is recorded as failing its self-test', async () => {
    const recordedVerdict = vi.fn(() => 'fail' as const);
    const section = await buildMcpSection(deps({ recordedVerdict }));
    expect(recordedVerdict).toHaveBeenCalledWith(`${HOME}/.wmux/mcp/wmux-native`);
    expect(section.lines.find((l) => l.label === 'registered (claude)')).toMatchObject({ verdict: 'WARN' });
    expect(section.verdict).toBe('WARN');
  });

  it('reads the recorded verdict of one native copy once, however many agents point at it', async () => {
    const recordedVerdict = vi.fn(() => 'pass' as const);
    const native = `${HOME}/.wmux/mcp/wmux-native`;
    await buildMcpSection(deps({ recordedVerdict, targets: () => [target('a', native), target('b', native), target('c', native)] }));
    expect(recordedVerdict).toHaveBeenCalledTimes(1);
  });

  it('reports the broker and the recent bundle sessions from the app', async () => {
    const section = await buildMcpSection(deps());
    const byLabel = Object.fromEntries(section.lines.map((l) => [l.label, l]));
    expect(byLabel['broker']).toMatchObject({
      value: 'running pid 4321, up 1h 2m 5s, connections 2, crash exits 1, spawn failures 3, stand-downs 0',
      verdict: 'OK',
    });
    expect(byLabel['bundle sessions (last 10 min)']).toMatchObject({ value: '3', verdict: 'OK' });
    expect(section.verdict).toBe('OK');
  });

  it('says off, standing down, or warns when the broker is on but down', async () => {
    const line = async (broker: Partial<McpSessionsSummary['broker']>) => {
      const result = { ...summary, broker: { ...summary.broker, ...broker } };
      const s = await buildMcpSection(deps({ sessions: () => Promise.resolve({ id: '1', ok: true, result }) }));
      return s.lines.find((l) => l.label === 'broker');
    };
    expect(await line({ enabled: false, running: false, pid: null })).toMatchObject({ value: 'off', verdict: 'OK' });
    expect(await line({ running: false, pid: null, standingDown: true })).toMatchObject({ verdict: 'OK' });
    expect(await line({ running: false, pid: null })).toMatchObject({ verdict: 'WARN' });
  });

  describe('a broker that is on but down', () => {
    const down = async (downReason: unknown, kinds: string[], extra: Record<string, unknown> = {}) => {
      const result = { ...summary, broker: { ...summary.broker, running: false, pid: null, uptimeS: null, downReason, ...extra } };
      const targets = () => kinds.map((k, i) => target(`t${i}`, `${HOME}/.wmux/mcp/${k}`));
      const s = await buildMcpSection(deps({ targets, sessions: () => Promise.resolve({ id: '1', ok: true, result }) }));
      return s.lines.find((l) => l.label === 'broker') as { value: string; verdict: string; hint?: string };
    };

    it('promises a restart only when one is scheduled', async () => {
      const line = await down('restarting', ['wmux-native']);
      expect(line).toMatchObject({ verdict: 'WARN', value: 'not running: restarting after an exit (crash exits 1, spawn failures 3)' });
      expect(line.hint).toMatch(/restarts it/);
      expect(line.hint).toMatch(/native launcher start the full bundle themselves/);
    });

    it('says a crash loop keeps it off until wmux restarts, and which tools the last crash cut off', async () => {
      const line = await down('crash-loop', ['wmux-native'], { lastCrashTools: ['browser_click', 'a b/../x'] });
      expect(line).toMatchObject({ verdict: 'WARN', value: 'not running: it kept failing (crash exits 1, spawn failures 3), off until wmux restarts' });
      expect(line.hint).toMatch(/Last crash during: browser_click\./);
      expect(line.hint).not.toMatch(/a b/);
      expect(line.hint).toMatch(/native launcher start the full bundle themselves/);
    });

    it('says a missing script will not start, and that Node-shim agents cannot connect', async () => {
      const line = await down('script-missing', ['shim.js']);
      expect(line.value).toBe('not running: this build has no broker script');
      expect(line.hint).toMatch(/Node shim cannot start a session/);
      expect(line.hint).not.toMatch(/restart|full bundle/);
    });

    it('says the app stopped it, with no promise', async () => {
      const line = await down('stopped', ['wmux-native', 'shim.js']);
      expect(line.value).toBe('not running: stopped by the app');
      expect(line.hint).not.toMatch(/restart/);
      expect(line.hint).toMatch(/native launcher/);
      expect(line.hint).toMatch(/Node shim/);
    });

    it('promises nothing for a state it cannot name', async () => {
      for (const reason of [null, 'not-started', 'something-new']) {
        const line = await down(reason, ['wmux-native', 'shim.js']);
        expect(line.value).toBe('not running');
        expect(line.hint ?? '').not.toMatch(/restart|full bundle|cannot start/);
      }
    });
  });

  it('marks a capped bundle count as a lower bound', async () => {
    const result = { ...summary, bundle: { recent: 256, capped: true, ttlS: 600 } };
    const s = await buildMcpSection(deps({ sessions: () => Promise.resolve({ id: '1', ok: true, result }) }));
    expect(s.lines.find((l) => l.label.startsWith('bundle sessions'))?.value).toBe('≥256');
  });

  it('skips the live lines when the app is down or does not know the method', async () => {
    for (const sessions of [
      () => Promise.reject(new Error('ECONNREFUSED')),
      () => Promise.resolve({ id: '1', ok: false as const, error: 'Unknown method: mcp.sessions.summary' }),
      () => Promise.resolve({ id: '1', ok: true as const, result: { broker: 'nope' } }),
    ]) {
      const s = await buildMcpSection(deps({ sessions }));
      const live = s.lines.filter((l) => !l.label.startsWith('registered'));
      expect(live).toEqual([expect.objectContaining({ label: 'live sessions', verdict: 'SKIP' })]);
    }
  });

  it('tells an older app from one that did not answer', async () => {
    const value = async (sessions: McpDoctorDeps['sessions']) =>
      (await buildMcpSection(deps({ sessions }))).lines.at(-1)?.value;
    expect(await value(() => Promise.resolve({ id: '1', ok: false, error: 'Unknown method: mcp.sessions.summary' })))
      .toBe('unavailable (this app version does not report them)');
    expect(await value(() => Promise.resolve({ id: '1', ok: false, error: 'permission denied' })))
      .toBe('unavailable (the app did not answer: permission denied)');
    expect(await value(() => Promise.reject(new Error('RPC timeout: mcp.sessions.summary (5000ms)'))))
      .toBe('unavailable (the app did not answer: RPC timeout: mcp.sessions.summary (5000ms))');
    expect(await value(() => Promise.resolve({ id: '1', ok: true, result: { broker: 'nope' } })))
      .toBe('unavailable (the app answered in a shape this doctor does not read)');
  });

  it('does not ask a main process the probe already found down', async () => {
    const sessions = vi.fn(() => Promise.resolve({ id: '1', ok: true as const, result: summary }));
    const s = await buildMcpSection(deps({ sessions }), false);
    expect(sessions).not.toHaveBeenCalled();
    expect(s.lines.at(-1)).toMatchObject({ label: 'live sessions', value: 'unavailable (the app is not running)' });
  });
});

describe('doctor identity section', () => {
  const withIdentity = (identity: unknown) => deps({ sessions: () => Promise.resolve({ id: '1', ok: true, result: { ...summary, identity } }) });
  const zero = { 'no-peer': 0, 'other-pid': 0, 'start-unread': 0, restarted: 0, 'broker-unverified': 0 };
  const lines = async (identity: unknown) => {
    const section = (await buildMcpSection(withIdentity(identity))).identity;
    return section && Object.fromEntries(section.lines.map((l) => [l.label, l]));
  };

  it('shows the counts main reports, by reason, from the claims it refused', async () => {
    const { checkClaim, identitySummary, notePeerReadCheck, resetClaimChecks, setClaimStartTimeSource } = await import('../../../main/pipe/handlers/peerPidShadow');
    resetClaimChecks();
    try {
      notePeerReadCheck('available');
      setClaimStartTimeSource(() => 5n);
      const quiet = { platform: 'darwin' as const, log: () => undefined };
      const ctx = (peerPid?: number, peerStartedAt?: string) => ({ externalWire: true, ...(peerPid && { peerPid }), ...(peerStartedAt && { peerStartedAt }) }) as never;
      checkClaim('callerPid', ctx(), 10, quiet);
      checkClaim('callerPid', ctx(11, '5'), 10, quiet);
      checkClaim('callerPid', ctx(11, '5'), 10, quiet);
      checkClaim('callerPid', ctx(10, '4'), 10, quiet);
      checkClaim('callerPid', ctx(10, '5'), 10, quiet);
      const byLabel = await lines(identitySummary('darwin'));
      expect(byLabel?.['peer read']).toMatchObject({ value: 'ok', verdict: 'OK' });
      expect(byLabel?.['start times']).toMatchObject({ value: 'ok', verdict: 'OK' });
      expect(byLabel?.['refused claims']).toMatchObject({ value: 'no-peer 1, other-pid 2, restarted 1', verdict: 'WARN' });
      expect(byLabel).not.toHaveProperty('claims over TCP');
    } finally {
      resetClaimChecks();
    }
  });

  it('tells a peer read that is down apart from refused callers', async () => {
    const byLabel = await lines({ peerRead: { state: 'unavailable', reason: 'koffi unavailable: no binary' }, startTimes: 'ok', refusals: { ...zero, 'no-peer': 4 } });
    expect(byLabel?.['peer read']).toMatchObject({ value: 'unavailable (koffi unavailable: no binary)', verdict: 'WARN' });
    expect(byLabel?.['peer read'].hint).toMatch(/every pid claim is refused/);
    expect(byLabel?.['refused claims']).toMatchObject({ value: 'no-peer 4', verdict: 'WARN' });
  });

  it('reports no refusals as OK, and an unchecked read as skipped', async () => {
    const byLabel = await lines({ peerRead: { state: 'unknown' }, startTimes: 'ok', refusals: zero });
    expect(byLabel?.['peer read']).toMatchObject({ value: 'not checked yet', verdict: 'SKIP' });
    expect(byLabel?.['refused claims']).toMatchObject({ value: 'none', verdict: 'OK' });
  });

  it('shows claims over TCP on Windows only, where no peer is read', async () => {
    const byLabel = await lines({ peerRead: { state: 'not-read' }, startTimes: 'not-read', refusals: zero, tcpClaims: 7 });
    expect(byLabel?.['peer read']).toMatchObject({ verdict: 'OK' });
    expect(byLabel).not.toHaveProperty('start times');
    expect(byLabel?.['claims over TCP']).toMatchObject({ value: '7', verdict: 'OK' });
  });

  it('has no section for an app that does not report it, or reports another shape', async () => {
    expect((await buildMcpSection(deps())).identity).toBeUndefined();
    expect(await lines({ peerRead: { state: 'ok' }, startTimes: 'ok', refusals: { 'no-peer': 'x' } })).toBeUndefined();
  });
});
