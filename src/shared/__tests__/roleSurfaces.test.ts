import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_TOOL_SURFACE } from '../coreSurface';
import { ORCH_ROLES } from '../orchestratorRole';
import { UNLISTED_TOOLS_SET } from '../unlistedTools';
import { ROLE_TOOL_SURFACES, parseRoleArg, roleArgValue, roleMcpArgv, toolSurfaceShellFlags, wmuxServerArgs } from '../roleSurfaces';

const baseline = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../scripts/mcp-protocol-baseline.json'), 'utf8'),
) as { profiles: { core: { toolNames: string[] } } };

describe('role surfaces', () => {
  it('has one entry per orchestrator role', () => {
    expect(Object.keys(ROLE_TOOL_SURFACES).sort()).toEqual([...ORCH_ROLES].sort());
  });

  it('every name is a LISTED core tool (no stale or unlisted name)', () => {
    const core = new Set(CORE_TOOL_SURFACE);
    const listedCore = new Set(baseline.profiles.core.toolNames);
    for (const [role, names] of Object.entries(ROLE_TOOL_SURFACES)) {
      for (const name of names) {
        expect(core.has(name), `${role}: ${name} not in CORE_TOOL_SURFACE`).toBe(true);
        expect(listedCore.has(name), `${role}: ${name} not in the core tools/list baseline`).toBe(true);
        expect(UNLISTED_TOOLS_SET.has(name), `${role}: ${name} is unlisted`).toBe(false);
      }
      expect(new Set(names).size, `${role} has duplicates`).toBe(names.length);
    }
  });

  it('parses --role=<Role>; last one wins; unknown names are reported', () => {
    expect(parseRoleArg(['node', 'x'])).toEqual({ kind: 'none' });
    expect(parseRoleArg(['--role=Reviewer'])).toEqual({ kind: 'role', role: 'Reviewer' });
    expect(parseRoleArg(['--role=Planner', '--role=Builder'])).toEqual({ kind: 'role', role: 'Builder' });
    expect(parseRoleArg(['--role=reviewer'])).toEqual({ kind: 'unknown', value: 'reviewer' });
    expect(parseRoleArg(['--role=toString'])).toEqual({ kind: 'unknown', value: 'toString' });
    expect(parseRoleArg(['--role='])).toEqual({ kind: 'none' });
    expect(roleArgValue(['--core', '--role=Tester'])).toBe('Tester');
  });
});

describe('fan-out worker surfaces', () => {
  it('give Builder and Tester every wmux tool the worker preamble names', async () => {
    const { WORKER_DELIVERY_PREAMBLE } = await import('../../main/worktask/FanOutService');
    const { FANOUT_WORKER_DISALLOWED_TOOLS } = await import('../workerLaunch');
    // `send_message` is named only to say how tasks arrive; workers may not call it.
    const forbidden = new Set(FANOUT_WORKER_DISALLOWED_TOOLS.map((t) => t.replace('mcp__wmux__', '')));
    const named = [...WORKER_DELIVERY_PREAMBLE.matchAll(/`([a-z0-9_]+)`/g)]
      .map((m) => m[1])
      .filter((n) => CORE_TOOL_SURFACE.includes(n) && !forbidden.has(n));
    expect(named.length).toBeGreaterThan(0);
    for (const role of ['Builder', 'Tester'] as const) {
      expect(named.filter((n) => !ROLE_TOOL_SURFACES[role].includes(n))).toEqual([]);
    }
  });
});

// A codex `-c mcp_servers.wmux.args=…` override replaces the args and keeps the
// command the config registered, so with the native launcher registered the
// args must be the launcher's, not a script path it would take for a command.
describe('tool-level overrides with the native launcher', () => {
  const native = { kind: 'native' as const, binary: '/Users/u/.wmux/mcp/wmux-native' };
  it('writes mcp-shim where a node entry has its script', () => {
    expect(wmuxServerArgs(native, 'role', 'Reviewer')).toEqual(['mcp-shim', '--role=Reviewer']);
    expect(wmuxServerArgs(native, 'core')).toEqual(['mcp-shim', '--core']);
    expect(wmuxServerArgs('/x/index.js', 'core')).toEqual(['/x/index.js', '--core']);
  });
  it('codex argv and shell flags carry the launcher\'s args', () => {
    expect(roleMcpArgv('codex', 'Reviewer', native)).toEqual(['-c', 'mcp_servers.wmux.args=["mcp-shim","--role=Reviewer"]']);
    expect(toolSurfaceShellFlags('codex', 'core', native, undefined, '')).toBe(`-c "mcp_servers.wmux.args=['mcp-shim','--core']"`);
  });
  it('claude\'s --mcp-config names the launcher as the command', () => {
    const argv = roleMcpArgv('claude', 'Reviewer', native) as string[];
    expect(JSON.parse(argv[0].replace(/^--mcp-config=/, ''))).toEqual({
      mcpServers: { wmux: { command: native.binary, args: ['mcp-shim', '--role=Reviewer'] } },
    });
  });
});
