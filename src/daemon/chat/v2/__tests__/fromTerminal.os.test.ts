// Terminal → chat (fromTerminal): the TUI is stopped and proved gone before a
// chat-v2 driver resumes the same session id, the pane is reserved meanwhile,
// and a failed start drops its record only once that process is proved gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeBinding } from '../../../../shared/agentResume';
import type { ProcessTreeEntry } from '../../../AgentProcessTracker';
import type { AgentStopResult } from '../../../agentStop';
import { continueOnAccount } from '../../../continueOnAccount';
import { ChildBackend } from '../childBackend';
import { ClaudeDriver } from '../claude/claudeDriver';
import { createChatV2Host } from '../host';
import { beginPaneMove, endPaneMove } from '../paneClaims';
import type { ChatV2Host, ChatV2HostDeps, ChatV2TerminalDeps } from '../types';
import { STOPPED_PREFIX } from '../fromTerminal';
import { FakeClaude, until } from './fakeClaude';

// The login-shell PATH probe would run the user's real shell. `onExecEnv` lets
// a test act in the gap between the pane check and the spawn.
const execEnvHook = vi.hoisted(() => ({ onExecEnv: null as null | (() => void) }));
vi.mock('../../../../shared/execEnv', () => ({
  agentExecEnv: async (env: NodeJS.ProcessEnv) => {
    execEnvHook.onExecEnv?.();
    return { ...env, PATH: `${env.PATH ?? ''}:/opt/login/bin` };
  },
}));

const PANE = 'pty-tui-1';
const PANE2 = 'pty-tui-2';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-from-')); });
afterEach(() => {
  execEnvHook.onExecEnv = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  host: ChatV2Host;
  fakes: FakeClaude[];
  paneFree: { value: boolean };
  probe: { value: 'gone' | 'exists' | 'unknown' };
  identity: { value: { startTime: string; commandLine: string } | null };
  term: {
    live: string | undefined;
    binding: ResumeBinding | undefined;
    stop: () => Promise<AgentStopResult>;
    stops: number;
    holders: ProcessTreeEntry[];
  };
  configDir: string;
  transcript: string;
  wmuxDir: string;
}

const TREE = { root: { pid: 7001, ppid: 1, name: 'claude' }, descendants: [{ pid: 7002, ppid: 7001, name: 'node', cmdline: 'node github-mcp-server' }] };

interface RigOptions {
  stubborn?: boolean;
  paneConfigDir?: string;
  platform?: NodeJS.Platform;
  shell?: string;
  /** Look Claude up for real on the pane's `Path` instead of the stub, with these files present. */
  windowsPath?: { path: string; files: string[] };
}

function rig(options: RigOptions = {}): Rig {
  const configDir = path.join(dir, 'claude-home');
  const transcript = path.join(configDir, 'projects', '-repo', `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const r = {
    fakes: [] as FakeClaude[],
    paneFree: { value: true },
    probe: { value: 'gone' as const },
    identity: { value: null },
    configDir,
    transcript,
    wmuxDir: fs.mkdtempSync(path.join(dir, 'wmux-')),
    term: {
      live: 'claude' as string | undefined,
      binding: { agent: 'claude', sessionId: SESSION, cwd: dir, transcriptPath: transcript, permissionMode: 'default', ts: 1 } as ResumeBinding | undefined,
      stops: 0,
      holders: [] as ProcessTreeEntry[],
      stop: async (): Promise<AgentStopResult> => ({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 }),
    },
  } as unknown as Rig;
  const pane = {
    meta: {
      spawnCwd: dir,
      incarnationId: 'inc-1',
      env: { ...(options.windowsPath ? { Path: options.windowsPath.path } : { PATH: '/usr/bin' }), CLAUDE_CONFIG_DIR: options.paneConfigDir ?? configDir },
      cmd: options.shell ?? '/bin/zsh',
    },
    promptLog: { size: 1, isCommandRunning: () => false },
    bridge: { isEmptyShellPrompt: () => true, getInputRevision: () => 1 },
  };
  const terminal: ChatV2TerminalDeps = {
    holdKeyboard: () => () => undefined,
    binding: () => r.term.binding,
    unsupported: () => null,
    liveAgent: () => r.term.live,
    notAtRest: async () => null,
    stillIdle: () => true,
    tree: async () => (r.term.live === 'claude' ? TREE : null),
    stop: async () => {
      r.term.stops += 1;
      const result = await r.term.stop();
      if (result.ok && result.stopped) r.term.live = undefined;
      return result;
    },
    processesWithArg: async () => r.term.holders,
    otherOwners: () => [],
  };
  const deps: ChatV2HostDeps = {
    // Each host its own record store: a second rig in a test must not load the first one's records.
    wmuxDir: r.wmuxDir,
    log: () => undefined,
    now: () => 100_000,
    sessionManager: { getSession: ((id: string) => (id === PANE || id === PANE2 ? pane : undefined)) as unknown as ChatV2HostDeps['sessionManager']['getSession'] },
    approvals: () => null,
    paneFree: async () => r.paneFree.value,
    writeToPane: () => true,
    processProbe: () => r.probe.value,
    sendTo: () => true,
    processIdentity: async () => r.identity.value,
    killTree: async () => undefined,
    terminal,
    ...(options.windowsPath ? { fs: windowsFiles(options.windowsPath.files) } : { claudeOnPath: async () => '/usr/local/bin/claude' }),
    platform: options.platform ?? 'darwin',
    moveTiming: { quietMs: 1, freeWaitMs: 30 },
    drivers: () => {
      const fake = new FakeClaude();
      fake.stubborn = options.stubborn ?? false;
      r.fakes.push(fake);
      return new ClaudeDriver({ settingSources: 'project', command: 'claude', backend: fake.backend() as ChildBackend });
    },
  };
  r.host = createChatV2Host(deps);
  return r;
}

/** The real file system, plus the Windows `files` as regular files (names compared as Windows does, ignoring case). */
function windowsFiles(files: string[]): NonNullable<ChatV2HostDeps['fs']> {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return {
    stat: (file) => {
      if (present.has(file.toLowerCase())) return { size: 1, mtimeMs: 1, ino: 1 };
      try {
        const st = fs.statSync(file);
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : null;
      } catch {
        return null;
      }
    },
    isDirectory: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
    realpath: (p) => fs.realpathSync.native(p),
  };
}

const move = (r: Rig, paneId = PANE) => r.host.call('fromTerminal', { paneId }, 'main');
const records = (r: Rig) => fs.readdirSync(path.join(r.wmuxDir, 'chat-sessions', 'v2')).filter((f) => f.endsWith('.json'));

/** A handed-off chat on PANE whose TUI exited; the pane's binding names `sessionId` (its own, by default). */
async function tombstone(r: Rig, sessionId?: string) {
  r.term.live = undefined;
  const created = await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main');
  if (!created.ok) throw new Error(created.error.message);
  const handed = await r.host.call('toTerminal', { paneId: PANE, chatSessionId: created.binding.chatSessionId }, 'main');
  if (!handed.ok) throw new Error(handed.error.message);
  const id = sessionId ?? created.binding.providerSessionId!;
  const transcript = path.join(r.configDir, 'projects', '-repo', `${id}.jsonl`);
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  r.term.binding = { ...r.term.binding!, sessionId: id, transcriptPath: transcript };
  return created.binding;
}

describe('terminal → chat', () => {
  it('stops the TUI, then resumes its exact session id in a chat that has no turn yet', async () => {
    const r = rig();
    const preview = await r.host.call('fromTerminal', { paneId: PANE, preview: true }, 'main');
    expect(preview).toEqual({ ok: true, processes: [{ name: 'node', mcp: true }] });
    expect(r.term.stops).toBe(0);

    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(1);
    expect(res.binding).toMatchObject({ providerSessionId: SESSION, status: 'idle', mode: 'default' });
    const args = r.fakes[0].args;
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
    expect(args).not.toContain('--session-id');
    expect(r.fakes[0].cwd).toBe(dir);
    expect(r.host.sessionForPane(PANE)!.blocks.some((b) => b.role === 'user')).toBe(false);
    await r.host.dispose();
  });

  it('holds the pane between the stop and the record: create and launches are refused', async () => {
    const r = rig();
    let release!: () => void;
    r.term.stop = () => new Promise((resolve) => { release = () => resolve({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 }); });
    const pending = move(r);
    await until(() => r.term.stops === 1);
    // The TUI is stopping and no record exists yet: a create would start a fresh `--session-id`.
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(true);
    expect(await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main'))
      .toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    // Continue on another account shares the pane's move lock.
    expect(await continueOnAccount({} as Parameters<typeof continueOnAccount>[0], PANE, '/elsewhere')).toEqual({ ok: false, code: 'busy' });
    expect(await move(r)).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    release();
    expect((await pending).ok).toBe(true);
    expect(r.fakes).toHaveLength(1);
    expect(r.host.ownsPane(PANE)).toBe(true);
    await r.host.dispose();
  });

  it('refuses a stop that found nothing to signal, and a conversation in another account folder', async () => {
    const r = rig();
    r.term.stop = async () => ({ ok: true, stopped: false });
    expect(await move(r)).toMatchObject({ ok: false, error: { message: 'Could not find the Claude process to stop.' } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(false);

    const other = path.join(dir, 'other-account');
    fs.mkdirSync(path.join(other, 'projects'), { recursive: true });
    const s = rig({ paneConfigDir: other });
    expect(await move(s)).toMatchObject({ ok: false, error: { message: 'This conversation belongs to another Claude account folder than this pane uses.' } });
    expect(s.term.stops).toBe(0);

    // A `projects` folder that links to the conversation's is the same folder.
    const linked = path.join(dir, 'linked-account');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(dir, 'claude-home', 'projects'), path.join(linked, 'projects'));
    const t = rig({ paneConfigDir: linked });
    expect((await move(t)).ok).toBe(true);
    await t.host.dispose();
  });

  it('a process holding the session id after the stop keeps the chat from starting', async () => {
    const r = rig();
    r.term.stop = async () => {
      r.term.holders = [{ pid: 9100, ppid: 1, name: 'tail', cmdline: `tail -f ${SESSION}.jsonl` }];
      return { ok: true, stopped: true, pid: TREE.root.pid, killed: 2 };
    };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('Claude was stopped; reopen it with Resume. Another process holds this conversation: tail (pid 9100)') } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
  });

  it('a shell child that appears while the driver starts stops the driver', async () => {
    const r = rig();
    // After the pre-spawn check, before the spawn: `claude` typed into the shell.
    execEnvHook.onExecEnv = () => { if (r.term.stops > 0) r.paneFree.value = false; };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { code: 'handoff-refused', message: expect.stringContaining('Something started in this pane') } });
    expect(r.fakes).toHaveLength(1);
    // Its exit is proved (signal 0: gone), so the record went with it.
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(false);
  });

  it('a failed start keeps the record until the driver’s exit is proved', async () => {
    const r = rig({ stubborn: true });
    r.probe.value = 'exists';
    r.identity.value = { startTime: 'start-1', commandLine: `claude --resume ${SESSION}` };
    execEnvHook.onExecEnv = () => { if (r.term.stops > 0) r.paneFree.value = false; };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('the chat was kept so wmux can stop it') } });
    // Kept, stopped, still owning the pane: nothing may type a resume into it.
    expect(r.host.bindingForPane(PANE)).toMatchObject({ providerSessionId: SESSION });
    expect(r.host.ownsPane(PANE)).toBe(true);

    // A driver that reported its exit while the OS still shows it: kept too.
    const s = rig();
    s.probe.value = 'exists';
    s.identity.value = { startTime: 'start-1', commandLine: `claude --resume ${SESSION}` };
    execEnvHook.onExecEnv = () => { if (s.term.stops > 0) s.paneFree.value = false; };
    expect(await move(s)).toMatchObject({ ok: false, error: { message: expect.stringContaining('the chat was kept so wmux can stop it') } });
    // Shown as a failed start, with why.
    expect(s.host.bindingForPane(PANE)).toMatchObject({ providerSessionId: SESSION, status: 'failed', error: { message: expect.stringContaining('Something started in this pane') } });
  });

  it('a handed-off chat whose TUI already exited comes back under its own id', async () => {
    const r = rig();
    const created = await tombstone(r);
    expect(r.host.ownsPane(PANE)).toBe(false);
    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(0);
    expect(res.binding).toMatchObject({ chatSessionId: created.chatSessionId, providerSessionId: created.providerSessionId, status: 'idle' });
    expect(res.binding!.epoch).not.toBe(created.epoch);
    expect(r.fakes.at(-1)!.args).toContain('--resume');
    await r.host.dispose();
  });

  it('a tombstone the terminal moved on from gives way to a new record for the terminal’s conversation', async () => {
    const r = rig();
    const created = await tombstone(r, SESSION);
    // A start that fails before its spawn: the tombstone is the pane's record again.
    let calls = 0;
    execEnvHook.onExecEnv = () => { if (++calls === 2) throw new Error('no login shell'); };
    expect((await move(r)).ok).toBe(false);
    expect(r.host.bindingForPane(PANE)).toMatchObject({ chatSessionId: created.chatSessionId, status: 'handed-off' });
    expect(records(r)).toEqual([`${created.chatSessionId}.json`]);
    execEnvHook.onExecEnv = null;
    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.binding).toMatchObject({ providerSessionId: SESSION, status: 'idle' });
    expect(res.binding!.chatSessionId).not.toBe(created.chatSessionId);
    expect(records(r)).toEqual([`${res.binding!.chatSessionId}.json`]);
    await r.host.dispose();
  });

  it('a start that fails before its spawn puts the tombstone back, whatever an earlier driver left', async () => {
    const r = rig();
    const created = await tombstone(r);
    // The OS reuses every pid now: an earlier driver's pid must not decide the rollback.
    r.probe.value = 'exists';
    let calls = 0;
    // The move's env preflight is the first call, the driver start's the second.
    execEnvHook.onExecEnv = () => { if (++calls === 2) throw new Error('no login shell'); };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('no login shell') } });
    expect(res.ok ? '' : res.error.message).not.toContain('kept');
    expect(r.host.bindingForPane(PANE)).toMatchObject({ chatSessionId: created.chatSessionId, status: 'handed-off' });
    expect(r.host.ownsPane(PANE)).toBe(false);
    await r.host.dispose();
  });

  it('a conversation an active chat holds in another pane is not moved again', async () => {
    const r = rig();
    expect((await move(r)).ok).toBe(true);
    expect(r.host.activeSessionIds()).toEqual([SESSION]);
    r.term.live = 'claude';
    expect(await move(r, PANE2)).toMatchObject({ ok: false, error: { message: 'This conversation is open in another pane.' } });
    expect(r.term.stops).toBe(1);
    await r.host.dispose();

    // Both checked before either had a record: the second driver to start finds the first chat.
    const s = rig();
    let release!: () => void;
    s.term.stop = () => new Promise((resolve) => { release = () => resolve({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 }); });
    const second = move(s, PANE2);
    await until(() => s.term.stops === 1);
    s.term.live = 'claude';
    s.term.stop = async () => ({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 });
    expect((await move(s)).ok).toBe(true);
    release();
    expect(await second).toMatchObject({ ok: false, error: { message: expect.stringContaining('This conversation is open in a chat in another pane.') } });
    expect(s.host.bindingForPane(PANE2)).toBeNull();
    expect(s.host.activeSessionIds()).toEqual([SESSION]);
    await s.host.dispose();
  });

  it('another move on the pane (chat → terminal, another account) keeps create out', async () => {
    const r = rig();
    expect(beginPaneMove(PANE)).toBe(true);
    try {
      expect(await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main'))
        .toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    } finally {
      endPaneMove(PANE);
    }
    expect((await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main')).ok).toBe(true);
    await r.host.dispose();
  });
});

describe('terminal → chat on Windows', () => {
  // A bare image name: path.basename of a Windows path is the whole string on POSIX.
  const win = (options: RigOptions = {}) => rig({ platform: 'win32', shell: 'powershell.exe', ...options });

  it('stops the TUI and resumes its session id from a PowerShell pane', async () => {
    const r = win();
    expect(await r.host.call('fromTerminal', { paneId: PANE, preview: true }, 'main')).toEqual({ ok: true, processes: [{ name: 'node', mcp: true }] });
    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(1);
    expect(res.binding).toMatchObject({ providerSessionId: SESSION, status: 'idle' });
    expect(r.fakes[0].args).toContain('--resume');
    await r.host.dispose();
  });

  it('a cmd.exe pane is refused before anything is stopped: it has no resume line', async () => {
    const r = win({ shell: 'cmd.exe' });
    const refused = { ok: false, error: { code: 'handoff-refused', message: 'This pane’s shell cannot reopen the conversation afterwards. Use PowerShell.' } };
    expect(await r.host.call('fromTerminal', { paneId: PANE, preview: true }, 'main')).toMatchObject(refused);
    expect(await move(r)).toMatchObject(refused);
    expect(r.term.stops).toBe(0);
    expect(r.fakes).toHaveLength(0);
  });

  it('a tree that does not die is reported as stopped, with Resume to reopen it', async () => {
    const r = win();
    r.term.stop = async () => ({ ok: false, code: 'still_running', pid: TREE.root.pid });
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: `${STOPPED_PREFIX} It did not exit; it may still be running in the terminal.` } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
  });

  it('a pane without a session id wmux can resume is refused', async () => {
    const r = win();
    r.term.binding = undefined;
    expect(await move(r)).toMatchObject({ ok: false, error: { message: 'This pane has no Claude conversation wmux can resume.' } });
    const s = win();
    s.term.binding = { ...s.term.binding!, sessionId: 'not-a-session-id' };
    expect(await move(s)).toMatchObject({ ok: false, error: { message: 'This pane has no Claude conversation wmux can resume.' } });
    expect(r.term.stops + s.term.stops).toBe(0);
  });

  it('another process with the session id in its argv keeps the conversation where it is', async () => {
    const r = win();
    r.term.holders = [{ pid: 9100, ppid: 1, name: 'claude.exe', cmdline: `claude.exe --resume ${SESSION}` }];
    expect(await move(r)).toMatchObject({ ok: false, error: { message: 'Another process holds this conversation: claude.exe (pid 9100).' } });
    expect(r.term.stops).toBe(0);
  });

  it('an agent process whose command line wmux cannot read counts as holding it, before and after the stop', async () => {
    const r = win();
    r.term.holders = [{ pid: 9200, ppid: 4, name: 'node.exe' }];
    const message = 'A process wmux cannot read may hold this conversation: node.exe (pid 9200).';
    expect(await move(r)).toMatchObject({ ok: false, error: { message } });
    expect(r.term.stops).toBe(0);

    const s = win();
    s.term.stop = async () => {
      s.term.holders = [{ pid: 9200, ppid: 4, name: 'node.exe' }];
      return { ok: true, stopped: true, pid: TREE.root.pid, killed: 2 };
    };
    expect(await move(s)).toMatchObject({ ok: false, error: { message: `${STOPPED_PREFIX} ${message}` } });
    expect(s.fakes).toHaveLength(0);
    expect(s.host.bindingForPane(PANE)).toBeNull();
  });

  it('a stop whose read does not confirm Claude’s processes signals nothing and says so', async () => {
    const r = win();
    r.term.stop = async () => ({ ok: false, code: 'unverified' });
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: 'wmux could not confirm which processes are Claude’s, so nothing was stopped. Try again.' } });
    expect(res.ok ? '' : res.error.message).not.toContain(STOPPED_PREFIX);
    expect(r.fakes).toHaveLength(0);
  });

  it('names readable and unreadable holders apart', async () => {
    const r = win();
    r.term.holders = [{ pid: 9100, ppid: 1, name: 'claude.exe', cmdline: `claude.exe --resume ${SESSION}` }, { pid: 9200, ppid: 4, name: 'node.exe' }];
    expect(await move(r)).toMatchObject({ ok: false, error: { message: 'Another process holds this conversation: claude.exe (pid 9100). A process wmux cannot read may hold it too: node.exe (pid 9200).' } });
  });

  it('finds claude.exe on the pane’s Path the way the driver’s shell-less spawn will', async () => {
    const PATH = String.raw`C:\Windows\system32;;"D:\tools";C:\Users\u\.local\bin`;
    const r = win({ windowsPath: { path: PATH, files: [String.raw`C:\Users\u\.local\bin\claude.exe`] } });
    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(1);
    await r.host.dispose();

    // Only a shim a shell would run: not where the chat can run it, and nothing is stopped.
    const s = win({ windowsPath: { path: PATH, files: [String.raw`C:\Users\u\.local\bin\claude.cmd`, String.raw`D:\tools\claude.ps1`] } });
    expect(await move(s)).toMatchObject({ ok: false, error: { message: 'Claude Code is not installed where the chat can run it.' } });
    expect(s.term.stops).toBe(0);

    // A quoted entry, padded with spaces.
    const quoted = win({ windowsPath: { path: String.raw`C:\Windows; "C:\Program Files\Claude" ;`, files: [String.raw`C:\Program Files\Claude\claude.exe`] } });
    expect((await move(quoted)).ok).toBe(true);
    await quoted.host.dispose();
  });

  it('takes Claude from Path the way the spawn will: a shim in an earlier folder wins, so it is refused', async () => {
    // The spawn walks the folders in order, trying each extension in a folder:
    // A's claude.cmd comes before B's claude.exe.
    const shimFirst = win({ windowsPath: { path: String.raw`C:\A;C:\B`, files: [String.raw`C:\A\claude.cmd`, String.raw`C:\B\claude.exe`] } });
    expect(await move(shimFirst)).toMatchObject({ ok: false, error: { message: 'Claude Code is not installed where the chat can run it.' } });
    expect(shimFirst.term.stops).toBe(0);

    // The other way round: B's shim comes after A's claude.exe.
    const exeFirst = win({ windowsPath: { path: String.raw`C:\A;C:\B`, files: [String.raw`C:\A\claude.exe`, String.raw`C:\B\claude.cmd`] } });
    expect((await move(exeFirst)).ok).toBe(true);
    await exeFirst.host.dispose();
  });
});
