import { afterEach, describe, expect, it } from 'vitest';
import {
  MOA_L0_REFUSED_METHODS,
  commanderLevelRefusal,
  commanderScopeRefusal,
  moaGoalSendScope,
  moaScopeRefusal,
  moaLevelRefusal,
  setMoaLevelGate,
  type MoaLevelGateDeps,
} from '../moaLevelGate';
import { COMMANDER_RPC_METHODS } from '../../../shared/commanderSurface';
import type { MoaLevel } from '../../../shared/moa';

const HQ = 'ws-hq';

function deps(level: MoaLevel, goal: { goalId: string; humanOnly: string[] } | null = null): MoaLevelGateDeps {
  return { hqWorkspaceId: () => HQ, level: () => level, activeGoal: () => goal };
}

afterEach(() => setMoaLevelGate(null));

describe('moa level gate', () => {
  it('every L0-refused method is a real commander method', () => {
    const surface = new Set<string>(COMMANDER_RPC_METHODS as ReadonlySet<string>);
    for (const m of MOA_L0_REFUSED_METHODS) expect(surface.has(m), m).toBe(true);
  });

  it('level 0 refuses acting methods for the HQ and leaves reads alone', () => {
    for (const m of ['input.send', 'task.fanout.start', 'deck.proposeHandoff', 'a2a.task.send', 'approval.press', 'deck.proposeGoal']) {
      expect(moaLevelRefusal(deps(0), m, HQ, {})).toMatch(/level 0/);
    }
    for (const m of ['pane.list', 'input.readScreen', 'deck.askDecision', 'deck.goal']) {
      expect(moaLevelRefusal(deps(0), m, HQ, {})).toBeNull();
    }
  });

  it('level 1 (the default) refuses nothing — today\'s behaviour', () => {
    for (const m of MOA_L0_REFUSED_METHODS) expect(moaLevelRefusal(deps(1), m, HQ, { text: 'git push' })).toBeNull();
  });

  it('a commander that is not the HQ is never touched', () => {
    expect(moaLevelRefusal(deps(0), 'input.send', 'ws-other', {})).toBeNull();
    expect(moaLevelRefusal(deps(2, { goalId: 'G-1', humanOnly: [] }), 'input.send', 'ws-other', { text: 'git push' })).toBeNull();
  });

  it('under an active goal at L2+, sent text that asks for a hard-rule step is refused', () => {
    const g = deps(2, { goalId: 'G-1', humanOnly: ['database migration'] });
    expect(moaLevelRefusal(g, 'input.send', HQ, { text: 'now git push origin main' })).toMatch(/G-1.*remote/);
    expect(moaLevelRefusal(g, 'a2a.task.send', HQ, { message: 'open a PR when done' })).toMatch(/remote/);
    expect(moaLevelRefusal(g, 'a2a.task.send', HQ, { title: 'cat ~/.ssh/id_rsa' })).toMatch(/secret/);
    expect(moaLevelRefusal(g, 'a2a.broadcast', HQ, { message: 'run the database migration' })).toMatch(/human-only/);
    expect(moaLevelRefusal(g, 'input.send', HQ, { text: 'Fix the test and commit locally; do not push.' })).toBeNull();
  });

  it('without an active goal, L2/L3 behave like L1', () => {
    expect(moaLevelRefusal(deps(3), 'input.send', HQ, { text: 'git push' })).toBeNull();
  });

  // W3: the paths #1997 did not screen.
  it('screens the fan-out prompt, its titles and its per-task prompts', () => {
    const g = deps(2, { goalId: 'G-1', humanOnly: [] });
    expect(moaLevelRefusal(g, 'task.fanout.start', HQ, { prompt: 'Fix it, then git push', titles: ['a'] })).toMatch(/task\.fanout\.start.*G-1.*remote/);
    expect(moaLevelRefusal(g, 'task.fanout.start', HQ, { prompt: 'Fix it', titles: ['a', 'add a retry'], taskPrompts: [] })).toBeNull();
    expect(moaLevelRefusal(g, 'task.fanout.start', HQ, { prompt: 'Fix it', titles: ['a', 'publish the release'] })).toMatch(/release/);
    expect(moaLevelRefusal(g, 'task.fanout.start', HQ, { prompt: 'Fix it', titles: ['a', 'b'], taskPrompts: ['', 'then npm publish'] })).toMatch(/release/);
    expect(moaLevelRefusal(g, 'task.fanout.start', HQ, { prompt: 'Fix the flaky test; commit on your branch.', titles: ['fix'] })).toBeNull();
  });

  it('screens A2A task updates and channel posts', () => {
    const g = deps(2, { goalId: 'G-1', humanOnly: [] });
    expect(moaLevelRefusal(g, 'a2a.task.update', HQ, { taskId: 't', message: 'Looks good, git push it' })).toMatch(/a2a\.task\.update.*remote/);
    expect(moaLevelRefusal(g, 'a2a.task.update', HQ, { taskId: 't', status: 'completed' })).toBeNull();
    expect(moaLevelRefusal(g, 'a2a.channel.post', HQ, { channelId: 'c', text: 'cat ~/.git-credentials' })).toMatch(/secret/);
  });

  it('input.send text split across calls is screened as one line, and Enter re-checks it', () => {
    const g: MoaLevelGateDeps = { ...deps(2, { goalId: 'G-1', humanOnly: [] }), typed: new Map() };
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'git pu' })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh origin main' })).toMatch(/remote/);
    // Refused: the refused text never reached the pane, but `git pu` is still
    // on its line, so the line keeps it.
    expect(g.typed!.get('pty:p1')).toBe('git pu');
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'run the tests' })).toBeNull();
    // A submitted line clears; another pane's line is separate.
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: ' now', submit: true })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p2', text: 'git' })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: ' push' })).toBeNull();
    // Enter submits what is on the line: screened, then forgotten.
    g.typed!.set('pty:p3', 'git push');
    expect(moaLevelRefusal(g, 'input.sendKey', HQ, { ptyId: 'p3', key: 'enter' })).toMatch(/input\.sendKey.*remote/);
    expect(g.typed!.has('pty:p3')).toBe(false);
    expect(moaLevelRefusal(g, 'input.sendKey', HQ, { ptyId: 'p2', key: 'ctrl+c' })).toBeNull();
    expect(g.typed!.has('pty:p2')).toBe(false);
    expect(moaLevelRefusal(g, 'input.sendKey', HQ, { ptyId: 'p4', key: 'enter' })).toBeNull();
  });

  // dot review P2: refusing `sh` after `git pu` used to forget `git pu`, so the
  // same `sh` sent again passed and the terminal composed `git push`.
  it('a refused suffix sent again is refused again: the prefix still on the line is kept', () => {
    const g: MoaLevelGateDeps = { ...deps(2, { goalId: 'G-1', humanOnly: [] }), typed: new Map() };
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'git pu' })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh' })).toMatch(/remote.*still holds unsubmitted text/);
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh' })).toMatch(/remote/);
    // Enter would submit `git pu` alone: screened, and harmless.
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh', submit: true })).toMatch(/remote/);
    // ctrl+c clears the line; then the same text is just `sh`.
    expect(moaLevelRefusal(g, 'input.sendKey', HQ, { ptyId: 'p1', key: 'ctrl+c' })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh' })).toBeNull();
  });

  // Owner decision 4: Escape does not clear a bash line (it is a meta prefix),
  // so it must not make the gate forget what is still typed there.
  it.each(['escape', 'ctrl+d', 'ctrl+z'])('%s does not discard the typed line: git pu, the key, then sh is refused', (key) => {
    const g: MoaLevelGateDeps = { ...deps(2, { goalId: 'G-1', humanOnly: [] }), typed: new Map() };
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'git pu' })).toBeNull();
    expect(moaLevelRefusal(g, 'input.sendKey', HQ, { ptyId: 'p1', key })).toBeNull();
    expect(moaLevelRefusal(g, 'input.send', HQ, { ptyId: 'p1', text: 'sh' })).toMatch(/remote/);
  });

  // Live dogfood 2026-10-10: a goal worker's shell died, the pane came back as
  // a plain shell, and Moa typed `claude "…"` into it. That claude had no goal
  // deny rules and the shell no goal env, so its `git push` went through.
  it('under a goal, typing an agent CLI launch into a pane is refused', () => {
    const g = () => ({ ...deps(2, { goalId: 'G-1', humanOnly: [] }), typed: new Map<string, string>() });
    for (const text of [
      'claude "run steps 1-6 of PROBE.md"',
      'claude',
      '  codex exec "fix it"',
      '& claude --permission-mode auto',
      String.raw`& 'C:\Users\x\AppData\Roaming\npm\claude.cmd' "go"`,
      '/usr/local/bin/agy --prompt x',
      'cd D:/w/task; claude "go"',
      'git status && claude -c',
    ]) {
      expect(moaLevelRefusal(g(), 'input.send', HQ, { ptyId: 'p1', text, submit: true }), text).toMatch(/G-1.*agent/);
    }
    // Split across calls and submitted with Enter: still one launch line.
    const split = g();
    expect(moaLevelRefusal(split, 'input.send', HQ, { ptyId: 'p1', text: 'cla' })).toBeNull();
    expect(moaLevelRefusal(split, 'input.send', HQ, { ptyId: 'p1', text: 'ude "go"', submit: true })).toMatch(/agent/);
    const enter = g();
    expect(moaLevelRefusal(enter, 'input.send', HQ, { ptyId: 'p1', text: 'codex' })).toBeNull();
    expect(moaLevelRefusal(enter, 'input.sendKey', HQ, { ptyId: 'p1', key: 'enter' })).toMatch(/agent/);
    expect(moaLevelRefusal(g(), 'input.send', HQ, { ptyId: 'p1', text: 'npx @anthropic-ai/claude-code "go"', submit: true })).toMatch(/agent/);
    // A follow-up typed into a running agent's prompt is prose, not a launch.
    for (const text of ['Claude, please run the tests again.', 'Please continue with step 2.', 'the claude CLI printed an error; read it']) {
      expect(moaLevelRefusal(g(), 'input.send', HQ, { ptyId: 'p1', text, submit: true }), text).toBeNull();
    }
    // Without a goal, or below level 2: today's lane.
    expect(moaLevelRefusal(deps(2), 'input.send', HQ, { ptyId: 'p1', text: 'claude "go"', submit: true })).toBeNull();
    expect(moaLevelRefusal(deps(1, { goalId: 'G-1', humanOnly: [] }), 'input.send', HQ, { ptyId: 'p1', text: 'claude "go"' })).toBeNull();
  });

  it('the installed gate keeps its own typed-line memory', () => {
    setMoaLevelGate(deps(2, { goalId: 'G-1', humanOnly: [] }));
    expect(commanderLevelRefusal('input.send', HQ, { ptyId: 'p1', text: 'git pu' })).toBeNull();
    expect(commanderLevelRefusal('input.send', HQ, { ptyId: 'p1', text: 'sh' })).toMatch(/remote/);
  });

  it('the router hook: uninstalled = null, a throwing gate fails closed', () => {
    expect(commanderLevelRefusal('input.send', HQ, {})).toBeNull();
    setMoaLevelGate({ hqWorkspaceId: () => { throw new Error('boom'); }, level: () => 1, activeGoal: () => null });
    expect(commanderLevelRefusal('input.send', HQ, {})).toMatch(/could not be read/);
    setMoaLevelGate(deps(0));
    expect(commanderLevelRefusal('task.fanout.start', HQ, {})).toMatch(/level 0/);
  });
});

describe('owner decision 2 — under an active goal, direct sends stay inside the contract', () => {
  const owners: Record<string, string> = { 'pty-task': 'ws-task', 'pty-ops': 'ws-ops', 'pty-named': 'ws-named' };
  const counterparts: Record<string, string> = { 'task-in': 'ws-task', 'task-out': 'ws-ops' };
  function scoped(level: MoaLevel = 2, active = true, extra: Partial<MoaLevelGateDeps> = {}): MoaLevelGateDeps {
    return {
      hqWorkspaceId: () => HQ,
      level: () => level,
      activeGoal: () => (active ? { goalId: 'G-abc123', humanOnly: [], scope: ['ws-named', 'ws-task'] } : null),
      ptyOwner: async (p) => owners[p] ?? null,
      taskCounterparty: async (_hq, t) => counterparts[t] ?? null,
      ...extra,
    };
  }

  it('keystrokes and text to the goal\'s own panes pass; another workspace\'s pane is refused', async () => {
    for (const m of ['input.send', 'input.sendKey']) {
      expect(await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-task', text: 'use fixture A', key: 'enter' })).toBeNull();
      expect(await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-named', text: 'x', key: 'enter' })).toBeNull();
      const r = await moaScopeRefusal(scoped(), m, HQ, { ptyId: 'pty-ops', text: 'use fixture A', key: 'enter' });
      expect(r).toMatch(/refused under goal G-abc123: workspace ws-ops is outside the goal's contract/);
      expect(r).toMatch(/moa_propose_handoff/);
    }
  });

  it('fails closed when the pane\'s owner or the target cannot be told', async () => {
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { ptyId: 'pty-gone', text: 'x' })).toMatch(/could not be resolved/);
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { text: 'x' })).toMatch(/no pane or workspace was named/);
    expect(await moaScopeRefusal(scoped(2, true, { ptyOwner: undefined }), 'input.send', HQ, { ptyId: 'pty-task', text: 'x' })).toMatch(/could not be resolved/);
    expect(await moaScopeRefusal(scoped(2, true, { ptyOwner: async () => { throw new Error('renderer gone'); } }), 'input.sendKey', HQ, { ptyId: 'pty-task', key: 'enter' })).toMatch(/could not be resolved/);
    // a named workspace with no pane: its own id decides
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { workspaceId: 'ws-task', text: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'input.send', HQ, { workspaceId: 'ws-ops', text: 'x' })).toMatch(/ws-ops is outside/);
  });

  it('A2A replies and follow-ups go by the task\'s other side; a status move sends nothing', async () => {
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-in', message: 'ok' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-out', message: 'ok' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { taskId: 'task-unknown', message: 'ok' })).toMatch(/could not be read/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.update', HQ, { taskId: 'task-out', message: 'more work' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.update', HQ, { taskId: 'task-out', status: 'completed' })).toBeNull();
    // a new task naming a workspace id literally is checked here; names go to the renderer's narrowed list
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'ws-ops', message: 'x' })).toMatch(/ws-ops is outside/);
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'ws-task', message: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.task.send', HQ, { to: 'Workspace 1', message: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.broadcast', HQ, { message: 'x' })).toMatch(/broadcast reaches workspaces outside/);
  });

  it('with no active goal, at level 1, or for another commander: today\'s lane, nothing refused', async () => {
    for (const d of [scoped(2, false), scoped(1, true), scoped(3, false)]) {
      expect(await moaScopeRefusal(d, 'input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toBeNull();
      expect(await moaScopeRefusal(d, 'a2a.broadcast', HQ, { message: 'x' })).toBeNull();
    }
    expect(await moaScopeRefusal(scoped(), 'input.send', 'ws-other', { ptyId: 'pty-ops', text: 'x' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'pane.list', HQ, {})).toBeNull();
  });

  it('the installed gate answers RpcRouter and the a2a handler; uninstalled it is silent', async () => {
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toBeNull();
    expect(moaGoalSendScope(HQ)).toBeNull();
    setMoaLevelGate(scoped());
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-ops', text: 'x' })).toMatch(/outside the goal's contract/);
    expect(await commanderScopeRefusal('input.send', HQ, { ptyId: 'pty-task', text: 'x' })).toBeNull();
    expect(moaGoalSendScope(HQ)).toEqual([HQ, 'ws-named', 'ws-task']);
    expect(moaGoalSendScope('ws-other')).toBeNull();
  });
});

describe('owner decision 3 — channel posts, pane focus and new panes stay inside an active goal', () => {
  const paneWs: Record<string, string> = { 'pane-task': 'ws-task', 'pane-ops': 'ws-ops', 'pane-hq': HQ };
  const channels: Record<string, string[]> = { 'ch-in': [HQ, 'ws-task'], 'ch-out': [HQ, 'ws-task', 'ws-ops'], 'ch-empty': [] };
  function scoped(level: MoaLevel = 2, active = true, extra: Partial<MoaLevelGateDeps> = {}): MoaLevelGateDeps {
    return {
      hqWorkspaceId: () => HQ,
      level: () => level,
      activeGoal: () => (active ? { goalId: 'G-abc123', humanOnly: [], scope: ['ws-task'] } : null),
      paneOwner: async (p) => paneWs[p] ?? null,
      channelMembers: async (_hq, c) => channels[c] ?? null,
      ...extra,
    };
  }
  const OUT = /refused under goal G-abc123: workspace ws-ops is outside the goal's contract.*moa_propose_handoff/s;

  it('a channel post is refused when a member or a mention is outside the contract', async () => {
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { channelId: 'ch-in', text: 'status?' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { channelId: 'ch-out', text: 'status?' })).toMatch(OUT);
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { channelId: 'ch-in', text: 'x', mentions: [{ workspaceId: 'ws-ops', name: 'ops' }] })).toMatch(OUT);
  });

  it('a channel post fails closed when its members cannot be read', async () => {
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { channelId: 'ch-empty', text: 'x' })).toMatch(/could not be read/);
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { channelId: 'ch-unknown', text: 'x' })).toMatch(/could not be read/);
    expect(await moaScopeRefusal(scoped(2, true, { channelMembers: undefined }), 'a2a.channel.post', HQ, { channelId: 'ch-in', text: 'x' })).toMatch(/could not be read/);
    expect(await moaScopeRefusal(scoped(), 'a2a.channel.post', HQ, { text: 'x' })).toMatch(/no channel was named/);
  });

  it('pane.focus goes by the pane\'s workspace and fails closed when unknown', async () => {
    expect(await moaScopeRefusal(scoped(), 'pane.focus', HQ, { id: 'pane-task' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'pane.focus', HQ, { id: 'pane-hq' })).toBeNull();
    expect(await moaScopeRefusal(scoped(), 'pane.focus', HQ, { id: 'pane-ops' })).toMatch(OUT);
    expect(await moaScopeRefusal(scoped(), 'pane.focus', HQ, { id: 'pane-gone' })).toMatch(/could not be resolved/);
    expect(await moaScopeRefusal(scoped(2, true, { paneOwner: async () => { throw new Error('x'); } }), 'pane.focus', HQ, { id: 'pane-task' })).toMatch(/could not be resolved/);
  });

  it('creating panes outside the contract is refused; omitted workspace means the HQ itself', async () => {
    for (const m of ['pane.split', 'surface.new']) {
      expect(await moaScopeRefusal(scoped(), m, HQ, { direction: 'horizontal' })).toBeNull();
      expect(await moaScopeRefusal(scoped(), m, HQ, { direction: 'horizontal', workspaceId: 'ws-task' })).toBeNull();
      expect(await moaScopeRefusal(scoped(), m, HQ, { direction: 'horizontal', workspaceId: 'ws-ops' })).toMatch(OUT);
    }
  });

  it('no active goal, level 1, or another commander: unchanged', async () => {
    for (const d of [scoped(2, false), scoped(1, true)]) {
      expect(await moaScopeRefusal(d, 'a2a.channel.post', HQ, { channelId: 'ch-out', text: 'x' })).toBeNull();
      expect(await moaScopeRefusal(d, 'pane.focus', HQ, { id: 'pane-ops' })).toBeNull();
      expect(await moaScopeRefusal(d, 'surface.new', HQ, { workspaceId: 'ws-ops' })).toBeNull();
    }
    expect(await moaScopeRefusal(scoped(), 'pane.split', 'ws-other', { workspaceId: 'ws-ops' })).toBeNull();
  });
});
