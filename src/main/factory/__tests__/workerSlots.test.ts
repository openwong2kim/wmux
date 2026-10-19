// Each task's launch generation and its panes, on disk (#2393).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { WORKER_SLOTS_FILENAME, WORKER_SLOTS_MAX, WORKER_SLOTS_VERSION, WorkerSlots, beginPaneRelaunch, launchStillCurrent, setWorkerSlotsForTests, startsAgent, taskOfPane } from '../workerSlots';
import { AGENT_GONE_FILENAME, AgentGoneFacts } from '../agentGoneFacts';
import { __resetWorkspaceMirrorForTest, getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { FanOutGuards, recordFanoutTaskPane, setFanOutGuardsForTests, stampFanoutTaskPane, taskOfWorkspace } from '../../worktask/fanoutGuards';

const BOT = 'bot-0000000a';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worker-slots-'));

function store(dir: string, opts: { rows?: LedgerEntry[]; now?: () => number; warn?: string[] } = {}): WorkerSlots {
  const s = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => opts.rows ?? [], (l) => opts.warn?.push(l), opts.now ?? Date.now);
  s.load();
  return s;
}

const row = (id: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: 1, id, taskWorkspaceId: `ws-${id}`, ownerWorkspaceId: 'ws-owner', title: id, status: 'working', rev: 4,
  updatedAt: 1_000, updatedBy: { kind: 'worker', workspaceId: `ws-${id}` }, dispatch: { origin: { kind: 'bot', botId: BOT } }, ...over,
});

afterEach(() => {
  setWorkerSlotsForTests(null);
  setFanOutGuardsForTests(null);
  __resetWorkspaceMirrorForTest();
});

describe('WorkerSlots', () => {
  it('a restart keeps each task\'s generation and each pane\'s task', () => {
    const dir = tmp();
    const s = store(dir);
    const { gen } = s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    expect(gen).toBe(1);
    expect(s.launched('t1', gen, 'ws-t1', 'pty-1')).toBe(true);
    s.flushForTests();
    const again = store(dir);
    expect(again.launchOf('t1')).toMatchObject({ taskId: 't1', gen: 1, origin: 'owner', state: 'launched' });
    expect(again.paneOf('pty-1')).toEqual({ taskId: 't1', gen: 1, workspaceId: 'ws-t1' });
  });

  it('a respawn bumps the generation, and a late answer of the older one changes nothing', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    expect(second).toBe(first + 1);
    expect(s.launched('t', first, 'ws-old', 'pty-old')).toBe(false);
    expect(s.released('t', first)).toBe(false);
    expect(s.paneOf('pty-old')).toBeNull();
    expect(s.launchOf('t')).toMatchObject({ gen: second, state: 'launching' });
    expect(s.launched('t', second, 'ws-new', 'pty-new')).toBe(true);
    expect(s.launchOf('t')?.state).toBe('launched');
  });

  it('a pane keeps its task wherever it moves; the pane create reads its launch from the token its spawn carried', () => {
    const dir = tmp();
    const s = store(dir);
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    // The pane's create stamps its workspace with the task.
    const guards = new FanOutGuards({ dir, ledgerTaskOwner: () => null, ledgerBotTask: () => null });
    stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', fanoutLaunch: { taskId: 't', gen } }, guards, () => s);
    expect(guards.taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
    s.launched('t', gen, 'ws-t', 'pty-t');
    // Adopted into another workspace: the pane's own record still names it,
    // and the stamp survives a restart.
    expect(taskOfPane('pty-t')).toEqual({ taskId: 't', gen });
    expect(new FanOutGuards({ dir, ledgerTaskOwner: () => null }).taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
    // A re-mark records a newer generation, never an older one.
    guards.markTask('ws-t', 'ws-owner', undefined, { taskId: 't', gen: gen + 1 });
    guards.markTask('ws-t', 'ws-owner', undefined, { taskId: 't', gen });
    expect(guards.taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen: gen + 1 });
  });

  it('a stamp written before stamps named tasks loads with no task', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fanout-lineage.json'), JSON.stringify({ version: 1, tasks: { 'ws-old': { owner: 'ws-owner', at: 5 } } }));
    expect(new FanOutGuards({ dir, ledgerTaskOwner: () => null }).taskOfWorkspace('ws-old')).toBeNull();
  });

  it('a launch that cannot be written is refused and leaves nothing behind', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'factory'), 'not a folder');
    const s = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
    s.load();
    expect(() => s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' })).toThrow(/could not be recorded/);
    expect(s.launchOf('t')).toBeNull();
  });

  it('with no file, the entries are rebuilt from the ledger rows and written', () => {
    const dir = tmp();
    const s = store(dir, { rows: [row('open'), row('done', { status: 'completed', dispatch: { origin: { kind: 'pane' } } })] });
    expect(s.launchOf('open')).toMatchObject({ gen: 1, launchedAt: 1_000, origin: 'bot', botId: BOT, state: 'launched' });
    expect(s.launchOf('done')).toMatchObject({ gen: 1, origin: 'owner', state: 'released' });
    expect(fs.existsSync(path.join(dir, 'factory', WORKER_SLOTS_FILENAME))).toBe(true);
    // The next launch of a rebuilt task is its second.
    expect(s.beginLaunch({ taskId: 'open', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen).toBe(2);
  });

  it('a file a newer version wrote is never written over: entries live in memory and launches go on', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: WORKER_SLOTS_VERSION + 1, tasks: [], future: true });
    fs.writeFileSync(file, newer);
    const warn: string[] = [];
    const s = store(dir, { warn, rows: [row('x')] });
    expect(warn.join('\n')).toMatch(/kept in memory only/);
    expect(s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
    // Seeded from the ledger in memory: its tasks' workspaces are known.
    expect(s.workspaceOf('ws-x')).toEqual({ taskId: 'x', gen: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });

  it('a file no version can read is moved aside, and the entries are rebuilt', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ torn');
    const s = store(dir, { rows: [row('r')], now: () => 42 });
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(`${WORKER_SLOTS_FILENAME}.unreadable-`))).toBe(true);
    expect(s.launchOf('r')?.gen).toBe(1);
    expect(store(dir).launchOf('r')?.gen).toBe(1);
  });
});

describe('round 1 review (#2393 identity)', () => {
  it('a file that can neither be read nor moved aside refuses launches only while it cannot be moved', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ torn');
    const rename = fs.renameSync;
    let tries = 0;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
      tries++;
      throw new Error('EBUSY');
    };
    let s: WorkerSlots;
    try {
      s = store(dir, { rows: [row('r')] });
      // A few tries at load, then one at each launch.
      expect(tries).toBe(3);
      expect(() => s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' })).toThrow(/could not be recorded/);
      expect(tries).toBe(4);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = rename;
    }
    // The lock is gone: the next launch moves it aside, rebuilds and is recorded.
    expect(s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen).toBe(1);
    expect(s.launchOf('r')?.gen).toBe(1);
    expect(store(dir).launchOf('t')?.gen).toBe(1);
  });

  it('a pane\'s create records the pane and its workspace before any renderer reply; a write that fails fails the create', () => {
    const dir = tmp();
    const s = store(dir);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', fanoutLaunch: { taskId: 't', gen } }, 'pty-t', () => s);
    // A crash here: the records are on disk.
    const after = store(dir);
    expect(after.paneOf('pty-t')).toEqual({ taskId: 't', gen, workspaceId: 'ws-t' });
    expect(after.workspaceOf('ws-t')).toEqual({ taskId: 't', gen });
    // A pane whose spawn carried no launch is not recorded.
    recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-x' }, 'pty-x', () => s);
    expect(s.paneOf('pty-x')).toBeNull();
    const failing = { recordCreate: () => { throw new Error('PTY_CREATE: the task pane could not be recorded: disk full'); } };
    expect(() => recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', fanoutLaunch: { taskId: 't', gen } }, 'pty-2', () => failing)).toThrow(/could not be recorded/);
  });

  it('a resume in the pane moves its workspace to the new generation too', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', first, 'ws-t', 'pty-t');
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', second, 'ws-t', 'pty-t');
    expect(s.workspaceOf('ws-t')).toEqual({ taskId: 't', gen: second });
    expect(s.paneOf('pty-t')?.gen).toBe(second);
  });

  it('an older build rewriting the lineage store does not lose a workspace\'s task', () => {
    const dir = tmp();
    const s = store(dir);
    setWorkerSlotsForTests(s);
    const guards = new FanOutGuards({ dir, ledgerTaskOwner: () => null });
    setFanOutGuardsForTests(guards);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', fanoutLaunch: { taskId: 't', gen } }, guards, () => s);
    s.launched('t', gen, 'ws-t', 'pty-t');
    s.flushForTests();
    // An older build rewrites the stamps without the task fields.
    fs.writeFileSync(path.join(dir, 'fanout-lineage.json'), JSON.stringify({ version: 1, tasks: { 'ws-t': { owner: 'ws-owner', at: 1 } } }));
    setFanOutGuardsForTests(new FanOutGuards({ dir, ledgerTaskOwner: () => null }));
    setWorkerSlotsForTests(store(dir));
    expect(taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
  });

  it('a generation never goes back, even after its entry was dropped', () => {
    const s = store(tmp());
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    s.launched('t', gen, 'ws-t', 'pty-t');
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', second, 'ws-t', 'pty-t');
    // Its entry dropped by the bound (simulated): its pane still names gen 2.
    (s as unknown as { tasks: Map<string, unknown> }).tasks.delete('t');
    expect(s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen).toBe(second + 1);
  });
});

describe('round 2 review (#2393 identity)', () => {
  it('a launch line typed into a task\'s pane is its next generation, the pane and workspace named before it is typed', () => {
    const s = store(tmp());
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    s.launched('t', gen, 'ws-t', 'pty-t');
    const settle = beginPaneRelaunch('pty-t');
    expect(s.paneOf('pty-t')?.gen).toBe(gen + 1);
    expect(s.workspaceOf('ws-t')?.gen).toBe(gen + 1);
    settle?.(true);
    expect(s.launchOf('t')).toMatchObject({ gen: gen + 1, state: 'launched', ownerWorkspaceId: 'ws-owner' });
    // A pane no task is known for: nothing to record.
    expect(beginPaneRelaunch('pty-plain')).toBeNull();
  });

  it('a pane created late for a launch that was abandoned or replaced is refused, never taken as the newer one\'s', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen;
    s.released('t', first);
    expect(() => s.recordCreate({ taskId: 't', gen: first }, 'ws-late', 'pty-late')).toThrow(/abandoned/);
    // A retry is generation 2: generation 1's late create is still refused.
    const second = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen;
    expect(() => s.recordCreate({ taskId: 't', gen: first }, 'ws-late', 'pty-late')).toThrow(/abandoned/);
    expect(() => stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-late', fanoutLaunch: { taskId: 't', gen: first } }, { markTask: () => undefined }, () => s)).toThrow(/abandoned/);
    expect(s.recordCreate({ taskId: 't', gen: second }, 'ws-t', 'pty-t')).toEqual({ taskId: 't', gen: second });
    expect(s.paneOf('pty-late')).toBeNull();
  });

  it('a pane from before panes were recorded is its workspace\'s task\'s, only where the record and the ledger agree', async () => {
    const dir = tmp();
    const ledger = new TaskLedger({ dir });
    setTaskLedgerForTests(ledger);
    await ledger.register({ id: 'old', taskWorkspaceId: 'ws-old', ownerWorkspaceId: 'ws-owner', title: 'old' });
    const s = store(dir, { rows: ledger.list({}) });
    setWorkerSlotsForTests(s);
    getWorkspaceMirror().setSnapshot({
      ts: 0,
      entries: [
        { id: 'ws-old', name: 'ws-old', ptyIds: ['pty-old'] },
        { id: 'ws-owner', name: 'owner', ptyIds: ['pty-owner'] },
        { id: 'ws-other', name: 'other', ptyIds: ['pty-moved'] },
      ],
      fleets: [],
    });
    const settle = beginPaneRelaunch('pty-old');
    expect(settle).not.toBeNull();
    settle?.(true);
    expect(s.launchOf('old')).toMatchObject({ gen: 2, state: 'launched' });
    expect(s.paneOf('pty-old')).toEqual({ taskId: 'old', gen: 2, workspaceId: 'ws-old' });
    // The owner's workspace is no task's; one whose record the ledger does
    // not confirm is not known either.
    expect(beginPaneRelaunch('pty-owner')).toBeNull();
    s.launched('other', s.beginLaunch({ taskId: 'other', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen, 'ws-other');
    expect(beginPaneRelaunch('pty-moved')).toBeNull();
    setTaskLedgerForTests(null);
  });

  it('the rebuild from the ledger names each task\'s workspace', () => {
    const s = store(tmp(), { rows: [row('a')] });
    expect(s.workspaceOf('ws-a')).toEqual({ taskId: 'a', gen: 1 });
  });
});

describe('round 3 review (#2393 identity)', () => {
  it('only a line that starts an agent is a launch of the pane\'s task', () => {
    expect(startsAgent('claude --resume 1234')).toBe(true);
    expect(startsAgent('ANTHROPIC_MODEL= env FOO=1 codex resume')).toBe(true);
    expect(startsAgent('"C:\\tools\\claude.cmd" --continue')).toBe(true);
    expect(startsAgent('Please review the diff below')).toBe(false);
    expect(startsAgent(' --dangerously-skip-permissions')).toBe(false);
    // A launch that pins its model starts with main's env marker.
    expect(startsAgent(`${MODEL_ENV_MARKER}claude "$(cat '/x/prompt.md')"`)).toBe(true);
  });
});

describe('round 4 review (#2393 identity)', () => {
  it('a task an older build started after a downgrade is seeded from the ledger at the next start', () => {
    const dir = tmp();
    store(dir, { rows: [row('a')] });
    const again = store(dir, { rows: [row('a'), row('b')] });
    expect(again.launchOf('b')).toMatchObject({ gen: 1 });
    expect(again.workspaceOf('ws-b')).toEqual({ taskId: 'b', gen: 1 });
  });

  it('a pane\'s launch line is typed only while its launch is the task\'s current one', () => {
    const s = store(tmp());
    setWorkerSlotsForTests(s);
    const first = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen;
    expect(launchStillCurrent({ taskId: 't', gen: first })).toBe(true);
    s.released('t', first);
    expect(launchStillCurrent({ taskId: 't', gen: first })).toBe(false);
    const second = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen;
    expect(launchStillCurrent({ taskId: 't', gen: first })).toBe(false);
    expect(launchStillCurrent({ taskId: 't', gen: second })).toBe(true);
    // A pane that named no launch.
    expect(launchStillCurrent(undefined)).toBe(true);
  });
});

describe('GLM review (#2411)', () => {
  it('only a launched entry, or a launch under way in this run, starts the grace', () => {
    const dir = tmp();
    const s = store(dir);
    const { gen, launchedAt } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    expect(s.liveLaunchAt('t')).toBe(launchedAt);
    // A crash leaves it launching: after the restart it starts nothing.
    expect(store(dir).liveLaunchAt('t')).toBeUndefined();
    s.released('t', gen);
    expect(s.liveLaunchAt('t')).toBeUndefined();
    const next = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    s.launched('t', next.gen, 'ws-t');
    expect(s.liveLaunchAt('t')).toBe(next.launchedAt);
  });

  it('the writes after a launch are coalesced into one; a launch writes at once', () => {
    const dir = tmp();
    const s = store(dir);
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    const written = fs.statSync(file).mtimeMs;
    s.launched('t', gen, 'ws-t', 'pty-t');
    expect(store(dir).launchOf('t')?.state).toBe('launching');
    s.flushForTests();
    expect(store(dir).launchOf('t')?.state).toBe('launched');
    expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(written);
  });

  it('a gating write that fails leaves an earlier coalesced write pending', () => {
    const dir = tmp();
    const s = store(dir);
    const a = s.beginLaunch({ taskId: 'a', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen;
    s.released('a', a);
    const mkdir = fs.mkdirSync;
    (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = (() => { throw new Error('ENOSPC'); }) as typeof fs.mkdirSync;
    try {
      expect(() => s.beginLaunch({ taskId: 'b', origin: 'owner', ownerWorkspaceId: 'ws-owner' })).toThrow(/could not be recorded/);
    } finally {
      (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = mkdir;
    }
    s.flushForTests();
    expect(store(dir).launchOf('a')?.state).toBe('released');
    expect(store(dir).launchOf('b')).toBeNull();
  });

  it('a gating write that fails puts back what the bound dropped for it', () => {
    const dir = tmp();
    const rows = Array.from({ length: WORKER_SLOTS_MAX }, (_, i) => row(`r${i}`, { updatedAt: 10 + i }));
    const s = store(dir, { rows });
    const mkdir = fs.mkdirSync;
    (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = (() => { throw new Error('ENOSPC'); }) as typeof fs.mkdirSync;
    try {
      expect(() => s.beginLaunch({ taskId: 'new', origin: 'owner', ownerWorkspaceId: 'ws-owner' })).toThrow(/could not be recorded/);
    } finally {
      (fs as { mkdirSync: typeof fs.mkdirSync }).mkdirSync = mkdir;
    }
    expect(s.launchOf('r0')).not.toBeNull();
    expect(s.launchOf('new')).toBeNull();
  });

  it('the ledger seed keeps every open row and the newest ended ones within the bound', () => {
    const rows = [row('open', { updatedAt: 1 }), ...Array.from({ length: WORKER_SLOTS_MAX + 5 }, (_, i) => row(`e${i}`, { status: 'completed', updatedAt: 10 + i }))];
    const s = store(tmp(), { rows });
    expect(s.launchOf('open')).not.toBeNull();
    expect(s.launchOf(`e${WORKER_SLOTS_MAX + 4}`)).not.toBeNull();
    expect(s.launchOf('e0')).toBeNull();
  });

  it('the seed inserts oldest first, so the bound drops the oldest open row, never the newest', () => {
    const rows = Array.from({ length: WORKER_SLOTS_MAX + 1 }, (_, i) => row(`o${i}`, { updatedAt: 10 + i }));
    const s = store(tmp(), { rows });
    expect(s.launchOf(`o${WORKER_SLOTS_MAX}`)).not.toBeNull();
    expect(s.workspaceOf(`ws-o${WORKER_SLOTS_MAX}`)).not.toBeNull();
    expect(s.launchOf('o0')).toBeNull();
  });
});

describe('readers of the recorded launch', () => {
  it('an agent-gone observation that started before the task\'s recorded launch adds no fact, after a restart too', () => {
    const dir = tmp();
    const launchedAt = 5_000;
    const facts = new AgentGoneFacts(path.join(dir, 'factory', AGENT_GONE_FILENAME), () => undefined, () => 9_000, (id) => (id === 't' ? launchedAt : undefined));
    facts.load();
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p'], at: launchedAt - 1 });
    expect(facts.get('t')).toBeNull();
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p'], at: launchedAt + 1 });
    expect(facts.get('t')).not.toBeNull();
  });

  it('a workspace recorded for one task is never reassigned to another; the refusal is logged once', () => {
    const warn: string[] = [];
    const s = store(tmp(), { warn });
    const a = s.beginLaunch({ taskId: 'a', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    s.recordCreate({ taskId: 'a', gen: a.gen }, 'ws-w', 'p-a');
    s.launched('a', a.gen, 'ws-w', 'p-a');
    // b's pane, adopted into ws-w, resumed where it is now.
    for (let i = 0; i < 2; i++) {
      const b = s.beginLaunch({ taskId: 'b', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner', pane: { sessionId: 'p-b', workspaceId: 'ws-w' } });
      s.launched('b', b.gen, 'ws-w', 'p-b');
    }
    expect(s.workspaceOf('ws-w')?.taskId).toBe('a');
    expect(s.paneOf('p-b')?.taskId).toBe('b');
    expect(warn.filter((l) => l.includes('ws-w'))).toHaveLength(1);
    // A create naming another task's workspace is refused the same way.
    const c = s.beginLaunch({ taskId: 'c', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    s.recordCreate({ taskId: 'c', gen: c.gen }, 'ws-w', 'p-c');
    expect(s.workspaceOf('ws-w')?.taskId).toBe('a');
  });

  it('a relaunch in a pane claims no workspace: the owner\'s stays unrecorded, the task\'s own is refreshed', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    s.recordCreate({ taskId: 't', gen: first.gen }, 'ws-t', 'p-t');
    s.launched('t', first.gen, 'ws-t', 'p-t');
    // Resumed in its pane, moved into the owner's workspace.
    const moved = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner', pane: { sessionId: 'p-t', workspaceId: 'ws-owner' } });
    s.launched('t', moved.gen, 'ws-owner', 'p-t');
    expect(s.workspaceOf('ws-owner')).toBeNull();
    expect(s.paneOf('p-t')).toMatchObject({ taskId: 't', gen: moved.gen });
    // Relaunched in its own workspace: that record names the new generation.
    const back = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner', pane: { sessionId: 'p-t', workspaceId: 'ws-t' } });
    s.launched('t', back.gen, 'ws-t', 'p-t');
    expect(s.workspaceOf('ws-t')).toEqual({ taskId: 't', gen: back.gen });
  });
});
