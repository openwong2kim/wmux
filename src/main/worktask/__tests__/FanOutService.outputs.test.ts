// ─── worktree:false fan-out — output folders instead of git worktrees ────────
//
// A preset may skip the worktree: each task gets its own folder under
// `<outputs>/<folder>/<batch>/`. These pin what that path must hold: two tasks
// (even on the same agent) never share a folder and are both created, no git
// is touched, the daemon gets `outputDir` instead of branch/worktreePath, and
// nothing that closes or scans tasks ever deletes an output folder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FanOutService } from '../FanOutService';
import type { FanOutDaemonPort, FanOutRendererPort } from '../FanOutService';
import { FanOutGuards, setFanOutGuardsForTests } from '../fanoutGuards';
import { TaskCloseService } from '../TaskCloseService';
import { WorktaskScanService } from '../WorktaskScanService';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-out-'));
  setFanOutGuardsForTests(new FanOutGuards({ dir: root, countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
});
afterEach(() => {
  setFanOutGuardsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function daemonFake() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const port: FanOutDaemonPort = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'task.mission.start') {
        seq++;
        return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
      }
      return { ok: true, taskId: params['taskId'] };
    }),
  };
  return { port, calls };
}

function rendererFake() {
  const spawned: Array<Parameters<FanOutRendererPort['spawnWorkspace']>[0]> = [];
  let seq = 0;
  const port: FanOutRendererPort = {
    spawnWorkspace: vi.fn(async (p) => {
      spawned.push(p);
      seq++;
      return { workspaceId: `ws-task-${seq}`, ptyId: `pty-${seq}` };
    }),
  };
  return { port, spawned };
}

/** A worktree manager that fails the test if touched: worktree:false has no repo. */
function noGit() {
  const fail = vi.fn(async () => {
    throw new Error('worktree:false must not touch git');
  });
  return { preflight: fail, createWorktree: fail, removeWorktree: fail, resolveBase: fail } as never;
}

function service(daemon: FanOutDaemonPort, renderer: FanOutRendererPort) {
  return new FanOutService({
    daemon,
    renderer,
    worktrees: noGit(),
    autonomy: async () => undefined,
    outputsRoot: path.join(root, 'outputs'),
  });
}

describe('FanOutService — worktree:false', () => {
  it('creates both tasks on the SAME agent, each in its own folder', async () => {
    const daemon = daemonFake();
    const renderer = rendererFake();
    const res = await service(daemon.port, renderer.port).start({
      idempotencyKey: 'k1',
      prompt: 'draw a cat',
      titles: ['cat one', 'cat two'],
      repoPath: '',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner',
      agents: [{ agent: 'codex' }, { agent: 'codex' }],
      worktree: false,
      outputFolder: 'image',
    });

    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    const [a, b] = res.tasks;
    expect(a.outputDir).toBeDefined();
    expect(b.outputDir).toBeDefined();
    expect(a.outputDir).not.toBe(b.outputDir);
    expect(a.branch).toBeUndefined();
    expect(a.worktreePath).toBeUndefined();
    expect(path.basename(a.outputDir!)).toBe('1-codex-10000000');
    expect(path.basename(b.outputDir!)).toBe('2-codex-20000000');
    // Both under one batch, under the preset's folder, under the outputs root.
    expect(path.dirname(a.outputDir!)).toBe(res.outputBatchDir);
    expect(path.dirname(res.outputBatchDir!)).toBe(path.join(fs.realpathSync(root), 'outputs', 'image'));
    expect(fs.statSync(a.outputDir!).isDirectory()).toBe(true);

    // The pane runs IN the folder, with the agent choice as data.
    expect(renderer.spawned[0].cwd).toBe(a.outputDir);
    expect(renderer.spawned[0].agentChoice).toEqual({ agent: 'codex' });
    expect(renderer.spawned[0].fanoutTaskOf).toBe('ws-owner');
    // Main still sends the default launcher; the renderer swaps it.
    // (POSIX `$(cat '…')`, win32 `$(Get-Content …)` — the same launch shape.)
    expect(renderer.spawned[0].initialCommand).toMatch(/claude "\$\((cat|Get-Content) /);
    // claude's first-run env keys on the REAL CLI — codex gets none.
    expect(renderer.spawned[0].env?.CLAUDE_CODE_SANDBOXED).toBeUndefined();

    // The daemon learns the folder, not a branch — so there is no
    // worktreePath for the one-open-task-per-path invariant to refuse twice.
    const updates = daemon.calls.filter((c) => c.method === 'task.mission.update').map((c) => c.params);
    expect(updates).toHaveLength(2);
    for (const [k, u] of updates.entries()) {
      expect(u.outputDir).toBe(res.tasks[k].outputDir);
      expect(u.branch).toBeUndefined();
      expect(u.worktreePath).toBeUndefined();
    }

    // prompt.md sits beside the folder, not in it, and tells the agent where to write.
    const meta = path.join(res.outputBatchDir!, '.meta', '1-codex-10000000');
    const prompt = fs.readFileSync(path.join(meta, 'prompt.md'), 'utf8');
    expect(prompt).toContain('draw a cat');
    expect(prompt).toContain(a.outputDir!);
    expect(fs.readdirSync(a.outputDir!)).toEqual([]);
  });

  it('a later task re-creates its batch folder when it is gone (an emptied batch is cleaned up)', async () => {
    const daemon = daemonFake();
    const renderer = rendererFake();
    const spawn = renderer.port.spawnWorkspace;
    renderer.port.spawnWorkspace = vi.fn(async (p) => {
      const r = await spawn(p);
      // The first task's folder and its batch are removed before the second starts.
      if (renderer.spawned.length === 1 && p.cwd) fs.rmSync(path.dirname(p.cwd), { recursive: true, force: true });
      return r;
    });
    const res = await service(daemon.port, renderer.port).start({
      idempotencyKey: 'k-gone', prompt: 'look into it', titles: ['one', 'two'], repoPath: '', agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner', agents: [{ agent: 'codex' }, { agent: 'codex' }], worktree: false, outputFolder: 'research',
    });
    expect(res.ok).toBe(true);
    expect(res.tasks[1].ok).toBe(true);
    expect(fs.statSync(res.tasks[1].outputDir!).isDirectory()).toBe(true);
    expect(path.dirname(res.tasks[1].outputDir!)).toBe(res.outputBatchDir);
    // An existing task folder is still a collision, not a merge.
    expect(fs.existsSync(res.tasks[0].outputDir!)).toBe(false);
  });

  it('a bot research task: its batch goes under the folder main named, and the bot\'s launch check still runs', async () => {
    const daemon = daemonFake();
    const renderer = rendererFake();
    const scratch = path.join(root, 'factory', 'bots', 'bot-0000000a', 'research');
    const mayLaunch = vi.fn((): string | null => null);
    const res = await service(daemon.port, renderer.port).start({
      idempotencyKey: 'k-research',
      prompt: 'compare',
      titles: ['q one', 'q two'],
      repoPath: scratch,
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner',
      worktree: false,
      outputFolder: 'research',
      outputRoot: scratch,
      preset: 'research',
      mayLaunch,
    });
    expect(res.ok).toBe(true);
    expect(path.dirname(res.outputBatchDir as string)).toBe(fs.realpathSync(scratch));
    expect(renderer.spawned.map((p) => path.dirname(p.cwd))).toEqual([res.outputBatchDir, res.outputBatchDir]);
    expect(mayLaunch).toHaveBeenCalledTimes(2);
    // Refused at launch: nothing spawns.
    const refused = await service(daemon.port, rendererFake().port).start({
      idempotencyKey: 'k-research-2', prompt: 'x', titles: ['q'], repoPath: scratch, agentCmd: 'claude', verifiedWorkspaceId: 'ws-owner',
      worktree: false, outputRoot: scratch, mayLaunch: () => 'the factory is off',
    });
    expect(refused.tasks[0]).toMatchObject({ ok: false, error: 'not launched: the factory is off' });
  });

  it('a claude row keeps claude first-run env', async () => {
    const renderer = rendererFake();
    await service(daemonFake().port, renderer.port).start({
      idempotencyKey: 'k2',
      prompt: 'x',
      titles: ['t'],
      repoPath: '',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner',
      agents: [{ agent: 'claude' }],
      worktree: false,
    });
    expect(renderer.spawned[0].env?.CLAUDE_CODE_SANDBOXED).toBe('1');
  });

  it('close, cleanup scan and the daemon projection all leave the output folder alone', async () => {
    const res = await service(daemonFake().port, rendererFake().port).start({
      idempotencyKey: 'k3',
      prompt: 'x',
      titles: ['a'],
      repoPath: '',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner',
      worktree: false,
    });
    const outputDir = res.tasks[0].outputDir!;
    fs.writeFileSync(path.join(outputDir, 'result.png'), 'png');

    // close: a task with no worktreePath is a close-only task.
    const closer = new TaskCloseService({
      daemon: { rpc: async () => ({ ok: true }) },
      worktrees: noGit(),
    });
    const closed = await closer.closeTask({ taskId: res.tasks[0].taskId!, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'result.png'))).toBe(true);

    // scan: an open output task is not "unmaterialized", and outputs/ is not scanned.
    const scan = await new WorktaskScanService({ worktreesRoot: path.join(root, 'worktrees') }).scan([
      { taskId: res.tasks[0].taskId!, title: 'a', outputDir },
    ]);
    expect(scan.entries).toEqual([]);
    expect(fs.existsSync(path.join(outputDir, 'result.png'))).toBe(true);
  });
});

describe('FanOutService — worktree:false folder failure', () => {
  it('fails with no task started when the outputs root cannot be created', async () => {
    const blocker = path.join(root, 'blocked');
    fs.writeFileSync(blocker, 'a file where the outputs root should be');
    const renderer = rendererFake();
    const svc = new FanOutService({
      daemon: daemonFake().port,
      renderer: renderer.port,
      worktrees: noGit(),
      autonomy: async () => undefined,
      outputsRoot: path.join(blocker, 'outputs'),
    });
    const res = await svc.start({
      idempotencyKey: 'k-fail',
      prompt: 'x',
      titles: ['a', 'b'],
      repoPath: '',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-owner',
      worktree: false,
    });
    expect(res.ok).toBe(false);
    expect(res.tasks).toEqual([]);
    expect(renderer.spawned).toHaveLength(0);
  });
});
