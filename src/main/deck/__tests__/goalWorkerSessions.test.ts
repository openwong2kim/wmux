import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  clearGoalWorkerSessions,
  forgetGoalWorkerSession,
  isGoalWorkerSession,
  isGoalWorkerSpawn,
  noteGoalWorkerSpawn,
} from '../goalWorkerSessions';
import { goalWorkerDenyRules, goalWorkerEnv } from '../../../shared/moaGoalWorker';
import { applyWorkerPermissionFlags } from '../../../shared/workerLaunch';
import { moaScopeRefusal, type MoaLevelGateDeps } from '../moaLevelGate';

const profiledEnv = { PATH: 'x', ...goalWorkerEnv('C:/meta/goal-gh-config') };
const profiledLine = applyWorkerPermissionFlags('claude', 'auto', goalWorkerDenyRules());
const plainLine = applyWorkerPermissionFlags('claude', 'auto', []);

afterEach(() => clearGoalWorkerSessions());

describe('isGoalWorkerSpawn', () => {
  it('needs both the profile env and every deny rule on the launch line', () => {
    expect(isGoalWorkerSpawn(profiledEnv, profiledLine)).toBe(true);
    expect(isGoalWorkerSpawn(profiledEnv, plainLine)).toBe(false);
    expect(isGoalWorkerSpawn({ PATH: 'x' }, profiledLine)).toBe(false);
    expect(isGoalWorkerSpawn({ ...profiledEnv, GIT_CONFIG_VALUE_1: 'https://github.com/x/y.git' }, profiledLine)).toBe(false);
    expect(isGoalWorkerSpawn({ ...profiledEnv, GIT_CONFIG_VALUE_0: undefined }, profiledLine)).toBe(false);
    expect(isGoalWorkerSpawn(profiledEnv, undefined)).toBe(false);
    expect(isGoalWorkerSpawn(undefined, profiledLine)).toBe(false);
  });
});

// Live dogfood 2026-10-10: a goal pane's shell died during a renderer OOM
// crash, the renderer recreated the pane as a plain shell (dead-session path:
// no fan-out stamp, no goal env, no launch line), and Moa typed into it.
describe('a recovered goal pane loses Moa write access; the profiled one keeps it', () => {
  const HQ = 'ws-hq';
  const owners: Record<string, string> = { 'daemon-goal': 'ws-task', 'daemon-recovered': 'ws-task', 'daemon-named': 'ws-named' };
  const deps = (extra: Partial<MoaLevelGateDeps> = {}): MoaLevelGateDeps => ({
    hqWorkspaceId: () => HQ,
    level: () => 2,
    activeGoal: () => ({ goalId: 'G-abc123', humanOnly: [], scope: ['ws-named', 'ws-task'], tasks: ['ws-task'] }),
    ptyOwner: async (p) => owners[p] ?? null,
    goalWorkerSession: isGoalWorkerSession,
    ...extra,
  });

  it('refuses typing into a dead-session recreation of a goal pane', async () => {
    // The goal fan-out spawn, as pty.handler records it.
    noteGoalWorkerSpawn('daemon-goal', { env: profiledEnv, initialCommand: profiledLine, fanoutTaskOf: HQ });
    // Its shell dies; the renderer self-creates a plain shell in the same pane.
    forgetGoalWorkerSession('daemon-goal');
    noteGoalWorkerSpawn('daemon-recovered', { env: { PATH: 'x' }, initialCommand: undefined, fanoutTaskOf: undefined });

    for (const m of ['input.send', 'input.sendKey']) {
      const r = await moaScopeRefusal(deps(), m, HQ, { ptyId: 'daemon-recovered', text: 'claude "go"', key: 'enter' });
      expect(r).toMatch(/refused under goal G-abc123/);
      expect(r).toMatch(/not the goal worker session/);
      expect(r).toMatch(/deck_ask_decision/);
    }
    expect(await moaScopeRefusal(deps(), 'input.send', HQ, { ptyId: 'daemon-goal', text: 'continue' })).toMatch(/not the goal worker session/);
  });

  it('a live profiled goal pane still takes Moa\'s text and keys', async () => {
    noteGoalWorkerSpawn('daemon-goal', { env: profiledEnv, initialCommand: profiledLine, fanoutTaskOf: HQ });
    expect(await moaScopeRefusal(deps(), 'input.send', HQ, { ptyId: 'daemon-goal', text: 'use fixture A', submit: true })).toBeNull();
    expect(await moaScopeRefusal(deps(), 'input.sendKey', HQ, { ptyId: 'daemon-goal', key: 'enter' })).toBeNull();
  });

  it('a task workspace named without a pane, or with no session lookup, fails closed', async () => {
    noteGoalWorkerSpawn('daemon-goal', { env: profiledEnv, initialCommand: profiledLine, fanoutTaskOf: HQ });
    expect(await moaScopeRefusal(deps(), 'input.send', HQ, { workspaceId: 'ws-task', text: 'x' })).toMatch(/not the goal worker session|name the pane/i);
    expect(await moaScopeRefusal(deps({ goalWorkerSession: undefined }), 'input.send', HQ, { ptyId: 'daemon-goal', text: 'x' })).toMatch(/not the goal worker session/);
  });

  it('a workspace the goal names (not a task it created) keeps today\'s lane', async () => {
    expect(await moaScopeRefusal(deps(), 'input.send', HQ, { ptyId: 'daemon-named', text: 'x' })).toBeNull();
  });

  it('a profiled spawn not stamped as a fan-out task, or a plain fan-out, is not a goal worker', () => {
    noteGoalWorkerSpawn('a', { env: profiledEnv, initialCommand: profiledLine, fanoutTaskOf: undefined });
    noteGoalWorkerSpawn('b', { env: { PATH: 'x' }, initialCommand: plainLine, fanoutTaskOf: 'ws-hq' });
    expect(isGoalWorkerSession('a')).toBe(false);
    expect(isGoalWorkerSession('b')).toBe(false);
  });
});

// pty.handler is wired to the daemon client and electron, so (like its other
// locks) the wiring is pinned at the source level.
describe('pty.handler and main record and drop goal worker sessions (source lock)', () => {
  const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), 'utf8');
  const pty = read('src/main/ipc/handlers/pty.handler.ts');
  const main = read('src/main/index.ts');

  it('records a session from the env main hands the daemon and the line it types, after the create', () => {
    const create = pty.indexOf("daemonClient.rpc('daemon.createSession'");
    const note = pty.indexOf('noteGoalWorkerSpawn(sessionId, { env: resolvedEnv, initialCommand: options?.initialCommand, fanoutTaskOf: options?.fanoutTaskOf })');
    expect(create).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(create);
  });

  it('drops a session that died or restarted, and everything when the daemon connection changes', () => {
    expect(pty).toMatch(/forgetPtyShell\(payload\.sessionId\);\s+forgetGoalWorkerSession\(payload\.sessionId\);/);
    expect(pty).toMatch(/onDaemonSessionRestarted = \(payload\) => \{[\s\S]{0,200}forgetGoalWorkerSession\(payload\.sessionId\)/);
    expect(main).toMatch(/handler swap \(daemon connect\): cleanup begin'\);[\s\S]{0,200}clearGoalWorkerSessions\(\);/);
    expect(main).toMatch(/handler swap \(daemon disconnect\): cleanup begin'\);\s+clearGoalWorkerSessions\(\);/);
  });
});
