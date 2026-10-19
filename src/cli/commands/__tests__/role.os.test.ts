import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMcpEntry, defaultSessionPath, handleRole, resolveRole } from '../role';
import { dataSuffix } from '../../../shared/constants';
import type { RoleBinding } from '../../../shared/orchestratorRole';

const SESSION = JSON.stringify({
  orchestratorRoleBindings: {
    Builder: { agent: 'agy', model: 'gemini-3.8-flash-low', skipPermissions: true },
    Reviewer: { agent: 'codex', model: 'gpt-6-sol', effort: 'low' },
    Planner: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', args: '--verbose' },
    Tester: { agent: 'agy', model: 'bad model; rm -rf /' },
  },
});

async function run(args: string[], json = true, readFile: (p: string) => string = () => SESSION) {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  await handleRole(args, json, {
    sessionPath: '/fake/session.json',
    readFile,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    exit: (c) => {
      code = c;
    },
  });
  return { out, err, code };
}

describe('wmux role resolve', () => {
  it('prints exec-ready tokens for a bound agy role (effort from the model id)', async () => {
    const { out, code } = await run(['resolve', 'Builder']);
    expect(code).toBe(0);
    const r = JSON.parse(out[0]);
    expect(r).toMatchObject({ bound: true, agent: 'agy', model: 'gemini-3.8-flash-low', effort: 'low' });
    expect(r.argv).toEqual(['agy', '--model', 'gemini-3.8-flash-low', '--dangerously-skip-permissions']);
    expect(r.flags).toEqual(['--model', 'gemini-3.8-flash-low', '--dangerously-skip-permissions']);
  });

  it('uses each CLI grammar for effort and keeps extra args', async () => {
    expect(JSON.parse((await run(['resolve', 'Reviewer'])).out[0]).argv).toEqual([
      'codex', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=low',
    ]);
    expect(JSON.parse((await run(['resolve', 'Planner'])).out[0]).argv).toEqual([
      'claude', '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--verbose',
    ]);
  });

  // Review of #1681: `skipPermissions` said true for a launch whose argv has
  // no skip flag (the role's args make their own permission choice).
  it('reports skipPermissions as the argv launches it', () => {
    const cases: Array<[RoleBinding, boolean]> = [
      [{ agent: 'claude', skipPermissions: true }, true],
      [{ agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits' }, false],
      [{ agent: 'codex', skipPermissions: true, args: '-s workspace-write' }, false],
      [{ agent: 'codex', args: '--yolo' }, true],
      [{ agent: 'claude', model: 'haiku' }, false],
    ];
    for (const [binding, skips] of cases) {
      const r = resolveRole('R', binding);
      expect(r.skipPermissions).toBe(skips);
      const argvSkips = r.argv.some((v) =>
        ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo'].includes(v));
      expect(argvSkips).toBe(skips);
    }
  });

  it('drops an unsafe model through the app normalizer', async () => {
    const r = JSON.parse((await run(['resolve', 'Tester'])).out[0]);
    expect(r.model).toBeUndefined();
    expect(r.argv).toEqual(['agy']);
  });

  it('exits 2 for an unbound role and 1 for an unreadable file', async () => {
    const unbound = await run(['resolve', 'Nobody']);
    expect(unbound.code).toBe(2);
    expect(JSON.parse(unbound.out[0])).toEqual({ role: 'Nobody', bound: false });
    const missing = await run(['resolve', 'Builder'], true, () => {
      throw new Error('ENOENT');
    });
    expect(missing.code).toBe(1);
  });

  it('exits 1 (unreadable, not "not bound") when the JSON root is not an object', async () => {
    for (const root of ['5', '"x"', '[]', 'null', 'true']) {
      const r = await run(['resolve', 'Builder'], true, () => root);
      expect(r.code, root).toBe(1);
      expect(r.err[0], root).toMatch(/^wmux role: cannot read /);
      expect(r.out, root).toEqual([]);
    }
  });

  it('treats Object.prototype names as unbound roles (exit 2)', async () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = await run(['resolve', role]);
      expect(r.code, role).toBe(2);
      expect(JSON.parse(r.out[0]), role).toEqual({ role, bound: false });
    }
  });

  it('prints a plain command line without --json', async () => {
    expect((await run(['resolve', 'Reviewer'], false)).out[0]).toBe(
      'codex --model gpt-6-sol -c model_reasoning_effort=low',
    );
  });

  it('resolves the app userData session.json per platform', () => {
    expect(defaultSessionPath({ APPDATA: 'C:/Users/u/AppData/Roaming' }, 'win32')).toBe(
      path.join('C:/Users/u/AppData/Roaming', `wmux${dataSuffix()}`, 'session.json'),
    );
    expect(defaultSessionPath({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(path.join('/x', `wmux${dataSuffix()}`, 'session.json'));
  });

  // #1680 (owner decision 7) — resolve reports whether a new task starts fresh;
  // it is not a launch flag, so the argv is unchanged.
  it('reports freshContext as the role applies it, without touching the argv', async () => {
    const session = JSON.stringify({
      orchestratorRoleBindings: {
        Builder: { agent: 'claude', effort: 'low', freshContext: true },
        Reviewer: { agent: 'codex', freshContext: 'true' },
        Tester: { agent: 'gemini', args: '--x', freshContext: true },
      },
    });
    const builder = JSON.parse((await run(['resolve', 'Builder'], true, () => session)).out[0]);
    expect(builder.freshContext).toBe(true);
    expect(builder.argv).toEqual(['claude', '--effort', 'low']);
    // A non-boolean is not an opt-in; an agent without the command cannot apply it.
    expect(JSON.parse((await run(['resolve', 'Reviewer'], true, () => session)).out[0]).freshContext).toBe(false);
    expect(JSON.parse((await run(['resolve', 'Tester'], true, () => session)).out[0]).freshContext).toBe(false);
  });

  it('resolveRole reports fields without an agent', () => {
    expect(resolveRole('R', { model: 'm' })).toMatchObject({ role: 'R', model: 'm', argv: [], flags: [] });
  });

  it('prints the wmux tool level only when the binding picks one (opt-in, argv unchanged)', () => {
    const entry = 'C:\\u\\.wmux\\mcp\\index.js';
    const registered = () => true;
    expect(resolveRole('Planner', { agent: 'claude' }, entry).mcp).toBeUndefined();
    const planner = resolveRole('Planner', { agent: 'claude', tools: 'role' }, entry);
    expect(planner.argv).toEqual(['claude']);
    expect(planner.mcp?.level).toBe('role');
    expect(planner.mcp?.tools).toContain('terminal_send');
    expect(planner.mcp?.argv).toHaveLength(1);
    expect(JSON.parse(planner.mcp?.argv[0].replace(/^--mcp-config=/, '') ?? '')).toEqual({
      mcpServers: { wmux: { command: 'node', args: [entry, '--role=Planner'] } },
    });
    expect(resolveRole('Reviewer', { agent: 'codex', tools: 'role' }, entry, registered).mcp).toEqual({
      level: 'role',
      tools: ['terminal_read', 'workspace_list', 'pane_list', 'channel_join', 'channel_post'],
      argv: ['-c', 'mcp_servers.wmux.args=["C:\\\\u\\\\.wmux\\\\mcp\\\\index.js","--role=Reviewer"]'],
    });
    expect(resolveRole('Reviewer', { agent: 'codex', tools: 'core' }, entry, registered).mcp?.argv[1]).toContain('"--core"');
    expect(resolveRole('Reviewer', { agent: 'codex', tools: 'full' }, entry, registered).mcp?.tools).toEqual(['*']);
    // A fan-out worker keeps the tools its preamble asks for (ledger, mission channel).
    expect(resolveRole('Tester', { agent: 'codex', tools: 'role' }, entry, registered).mcp?.argv).toEqual(
      ['-c', 'mcp_servers.wmux.args=["C:\\\\u\\\\.wmux\\\\mcp\\\\index.js","--role=Tester"]'],
    );
    expect(resolveRole('Builder', { agent: 'agy', tools: 'role' }, entry).mcp).toEqual({
      level: 'role',
      tools: ['ledger_update', 'task_push', 'task_fetch', 'channel_read', 'channel_unread', 'channel_ack', 'channel_post', 'a2a_task_query'],
      argv: [],
    });
    expect(resolveRole('Builder', { agent: 'opencode', tools: 'role' }, entry).mcp).toBeUndefined();
    expect(resolveRole('Custom', { agent: 'claude', tools: 'role' }, entry).mcp).toBeUndefined();
    expect(resolveRole('Custom', { agent: 'claude', tools: 'core' }, entry).mcp?.level).toBe('core');
  });

  it('points mcp.argv at the unsuffixed stable bundle and drops it when that bundle is missing', async () => {
    expect(defaultMcpEntry(path.join('C:', 'h'))).toBe(path.join('C:', 'h', '.wmux', 'mcp', 'index.js'));
    const session = JSON.stringify({ orchestratorRoleBindings: { Planner: { agent: 'claude', tools: 'core' } } });
    const entry = path.join('C:', 'h', '.wmux', 'mcp', 'index.js');
    const resolveWith = async (exists: boolean) => {
      const out: string[] = [];
      await handleRole(['resolve', 'Planner'], true, {
        sessionPath: '/fake/session.json',
        readFile: () => session,
        mcpEntry: entry,
        exists: () => exists,
        log: (l) => out.push(l),
        error: () => undefined,
        exit: () => undefined,
      });
      return JSON.parse(out[0]);
    };
    expect((await resolveWith(true)).mcp.argv[0]).toContain(JSON.stringify(entry).slice(1, -1));
    const missing = await resolveWith(false);
    expect(missing.mcp).toBeUndefined();
    expect(missing.mcpUnavailable).toBe(`wmux MCP bundle not found at ${entry}`);
  });

  it('prints no codex override when codex has no wmux server registered (codex would refuse to start)', () => {
    const entry = 'C:\\u\\.wmux\\mcp\\index.js';
    for (const tools of ['full', 'core', 'role'] as const) {
      const r = resolveRole('Reviewer', { agent: 'codex', tools }, entry, () => false);
      expect(r.mcp).toBeUndefined();
      expect(r.mcpUnavailable).toMatch(/no wmux MCP server registered/);
      expect(r.argv).toEqual(['codex']);
    }
    // claude needs no prior registration: its --mcp-config file is complete.
    expect(resolveRole('Planner', { agent: 'claude', tools: 'role' }, entry, () => false).mcp?.level).toBe('role');
  });
});
