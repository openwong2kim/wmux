import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSessionPath, handleRole, resolveRole } from '../role';
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

  it('ignores a stale freshContext field in session.json', async () => {
    const session = JSON.stringify({
      orchestratorRoleBindings: { Builder: { agent: 'claude', effort: 'low', freshContext: true } },
    });
    const r = JSON.parse((await run(['resolve', 'Builder'], true, () => session)).out[0]);
    expect(r).not.toHaveProperty('freshContext');
    expect(r.argv).toEqual(['claude', '--effort', 'low']);
  });

  it('resolveRole reports fields without an agent', () => {
    expect(resolveRole('R', { model: 'm' })).toMatchObject({ role: 'R', model: 'm', argv: [], flags: [] });
  });
});
