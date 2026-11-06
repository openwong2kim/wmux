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
  broker: { enabled: true, running: true, pid: 4321, uptimeS: 3725, connections: 2, crashExits: 1, standDowns: 0, standingDown: false },
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

  it('reports the broker and the recent bundle sessions from the app', async () => {
    const section = await buildMcpSection(deps());
    const byLabel = Object.fromEntries(section.lines.map((l) => [l.label, l]));
    expect(byLabel['broker']).toMatchObject({
      value: 'running pid 4321, up 1h 2m 5s, connections 2, crash exits 1, stand-downs 0',
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

  it('does not ask a main process the probe already found down', async () => {
    const sessions = vi.fn(() => Promise.resolve({ id: '1', ok: true as const, result: summary }));
    const s = await buildMcpSection(deps({ sessions }), false);
    expect(sessions).not.toHaveBeenCalled();
    expect(s.lines.at(-1)).toMatchObject({ label: 'live sessions', value: 'unavailable (the app is not running)' });
  });
});
