import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearedLaunchLine,
  BOT_WORKER_DENY,
  beginBotWorkerSpawn,
  botWorkerForCreate,
  botWorkerSessionsPath,
  botWorkerSettingsPath,
  forgetBotWorkerSession,
  guardRefireLine,
  guardSessionLaunch,
  isBotWorkerSession,
  isQuotable,
  isSingleCommand,
  noteBotWorkerSession,
  reloadBotWorkerSessionsForTests,
  spliceSettingsFlag,
  withBotWorkerMergeGuard,
  writeBotWorkerSettings,
} from '../botWorkerMergeGuard';
import { MODEL_ENV_MARKER, applyWorkerPermissionFlags, reattachModelEnvMarker, splitModelEnvMarker } from '../../../shared/workerLaunch';
import { applyRoleAgent } from '../../../shared/orchestratorRole';
import { FANOUT_EXTRA_AGENT_STEMS, applyFanoutAgentFlags, fanoutChoiceBinding } from '../../../shared/fanoutPreset';
import { withRoleBinding } from '../../../renderer/utils/ptyCreateOptions';
import { workerLaunchCommand } from '../../worktask/FanOutService';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { toWslPath } from '../../../shared/imagePaste';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-botguard-'));
  reloadBotWorkerSessionsForTests();
});
afterEach(() => {
  reloadBotWorkerSessionsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BOT = { kind: 'bot', botId: 'bot-lead-1' };
const ENTRY = '/opt/wmux/mcp/index.js';
/** The guard's resolvers as pty.handler sets them. */
const mcp = () => ({ mcpEntry: () => ENTRY, registeredLevel: () => null, isolatedBridge: () => null });
/** The three words a strict claude launch carries, read back from a line. */
function strictFiles(line: string): { settings: string; mcp: string } {
  const m = /--settings="([^"]+)" --mcp-config="([^"]+)" --strict-mcp-config/.exec(line);
  if (!m) throw new Error(`not a strict launch: ${line}`);
  return { settings: m[1], mcp: m[2] };
}
const LINE = `claude --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`;

describe('writeBotWorkerSettings', () => {
  it('writes the deny rules under factory/, owner-only, and leaves an unchanged file alone', () => {
    const file = writeBotWorkerSettings(dir);
    expect(file).toBe(path.join(dir, 'factory', 'worker-settings.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ permissions: { deny: [...BOT_WORKER_DENY] } });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.utimesSync(file, new Date(0), new Date(0));
    writeBotWorkerSettings(dir);
    expect(fs.statSync(file).mtimeMs).toBe(0); // not rewritten
  });

  it('restores a file that drifted by replacing it whole, leaving no temporary file', () => {
    const file = writeBotWorkerSettings(dir);
    fs.writeFileSync(file, '{"permissions":{"deny":[]}}');
    const before = fs.statSync(file).ino;
    writeBotWorkerSettings(dir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.deny).toEqual([...BOT_WORKER_DENY]);
    if (process.platform !== 'win32') expect(fs.statSync(file).ino).not.toBe(before); // renamed over, not rewritten in place
    expect(fs.readdirSync(path.dirname(file))).toEqual(['worker-settings.json']);
  });
});

describe('spliceSettingsFlag', () => {
  const P = '/home/u/.wmux/factory/worker-settings.json';

  it('puts the flag right after the claude launcher, keeping the model-env marker', () => {
    expect(spliceSettingsFlag(LINE, P)).toBe(`claude --settings="${P}" --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
    expect(spliceSettingsFlag(MODEL_ENV_MARKER + LINE, P)).toBe(`${MODEL_ENV_MARKER}claude --settings="${P}" --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
    expect(spliceSettingsFlag('/usr/local/bin/claude.exe', P)).toBe(`/usr/local/bin/claude.exe --settings="${P}"`);
  });

  it('guards the line fan-out really sends', () => {
    const { command } = workerLaunchCommand('claude', '/w/.wtask/prompt.md', { platform: 'darwin' });
    const spliced = spliceSettingsFlag(command, P);
    expect(spliced).toContain(`claude --settings="${P}"`);
    expect(spliced!.endsWith(command.slice(command.indexOf('claude') + 'claude'.length))).toBe(true);
  });

  it('guards the line the renderer launches for a bot preset (claude, flags after the prompt)', () => {
    // The renderer's chain for an agent choice (useRpcBridge.fanoutAgentChoice.test.ts).
    const main = workerLaunchCommand('claude', '/w/.wtask/prompt.md', { platform: 'darwin' }).command;
    const binding = fanoutChoiceBinding({ agent: 'claude' });
    const { marker, command: bare } = splitModelEnvMarker(main);
    const swap = applyRoleAgent(bare, binding, { extraAgents: FANOUT_EXTRA_AGENT_STEMS });
    const bound = withRoleBinding({ initialCommand: swap.command }, binding, undefined, FANOUT_EXTRA_AGENT_STEMS);
    const flagged = applyFanoutAgentFlags(bound.initialCommand as string, { agent: 'claude' }, '/w', 'darwin');
    for (const mode of ['auto', 'manual'] as const) {
      const line = reattachModelEnvMarker(marker, applyWorkerPermissionFlags(flagged, mode), '/bin/zsh').command;
      const spliced = spliceSettingsFlag(line, P);
      expect(spliced, line).not.toBeNull();
      expect(splitModelEnvMarker(spliced!).command.startsWith(`claude --settings="${P}" `)).toBe(true);
    }
  });

  it('is idempotent for its own flag, and refuses another settings file', () => {
    const once = spliceSettingsFlag(LINE, P)!;
    expect(spliceSettingsFlag(once, P)).toBe(once);
    // Ours anywhere but right after the launcher is not taken as applied.
    expect(spliceSettingsFlag(`claude -p hi --settings="${P}"`, P)).toBeNull();
    expect(spliceSettingsFlag(`claude --settings="/tmp/other.json" -p hi`, P)).toBeNull();
    expect(spliceSettingsFlag(`claude --settings /tmp/other.json`, P)).toBeNull();
    expect(spliceSettingsFlag(`claude "--settings=/tmp/other.json"`, P)).toBeNull();
    expect(spliceSettingsFlag(`${once} --settings="/tmp/other.json"`, P)).toBeNull();
  });

  it('refuses another launcher, an empty line and a path it cannot quote', () => {
    expect(spliceSettingsFlag('codex --yolo "$(cat p)"', P)).toBeNull();
    expect(spliceSettingsFlag('echo held until 10:00', P)).toBeNull();
    expect(spliceSettingsFlag('   ', P)).toBeNull();
    expect(spliceSettingsFlag(LINE, '/home/$USER/x.json')).toBeNull();
  });

  it('refuses a line that is more than one plain command, or ends the options', () => {
    for (const bad of [
      `claude -p hi; gh pr merge 1`,
      `claude -p hi && gh pr merge 1`,
      `claude -p hi | tee x`,
      `claude -p hi & gh pr merge 1`,
      `claude -p hi # --settings="${P}"`,
      `claude $(echo -p) hi`,
      'claude `echo hi`',
      `claude -p hi\ngh pr merge 1`,
      `claude "unterminated`,
      `claude -- --settings="${P}"`,
    ]) expect(spliceSettingsFlag(bad, P), bad).toBeNull();
    expect(isSingleCommand(`claude --allowedTools "a,b" "$(cat '/w/p.md')"`)).toBe(true);
    expect(isSingleCommand(`claude "$(Get-Content -Raw -LiteralPath 'C:\\w\\p.md' | Out-String)"`)).toBe(true);
  });

  it('refuses every command or process substitution but the prompt-file argument fan-out builds', () => {
    for (const bad of [
      `claude "$(claude x)"`,
      `claude <(claude x)`,
      'claude "`claude x`"',
      `claude >(tee x)`,
      `claude "<(claude x)"`,
      `claude '$(claude x)'`,
      `claude "$(cat '/w/p.md')$(claude x)"`,
      `claude "$(cat '/w/p.md'; claude x)"`,
    ]) expect(spliceSettingsFlag(bad, P), bad).toBeNull();
    // The prompt argument itself, POSIX and PowerShell, as buildInitialCommand writes it.
    expect(spliceSettingsFlag(LINE, P)).not.toBeNull();
    expect(spliceSettingsFlag(workerLaunchCommand('claude', 'C:\\w\\.wtask\\prompt.md', { platform: 'win32' }).command, P)).not.toBeNull();
  });

  it('a prompt that merely mentions the flag is not a settings flag', () => {
    expect(spliceSettingsFlag(`claude "use --settings later"`, P)).toBe(`claude --settings="${P}" "use --settings later"`);
  });
});

describe('isQuotable', () => {
  it('refuses quotes, shell expansions and backslash runs', () => {
    expect(isQuotable('/a/b c/settings.json')).toBe(true);
    expect(isQuotable('C:\\Users\\me\\.wmux\\factory\\worker-settings.json')).toBe(true);
    for (const bad of ['/a/"b', "/a/'b", '/a/$b', '/a/`b`', 'C:\\%TEMP%', '/a!b', '\\\\server\\share']) expect(isQuotable(bad)).toBe(false);
  });
});

describe('which creates are a bot\'s workers: main\'s records, never the renderer\'s echo', () => {
  let NOT_BOT: { dir: string; isBotTaskWorkspace: (ws: string) => boolean };
  let BOT_WS: { dir: string; isBotTaskWorkspace: (ws: string) => boolean };
  beforeEach(() => {
    NOT_BOT = { dir, isBotTaskWorkspace: () => false };
    BOT_WS = { dir, isBotTaskWorkspace: (ws: string) => ws === 'ws-task' };
  });

  it('the echoed origin alone decides nothing', () => {
    const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', fanoutOrigin: BOT, cwd: '/w', workspaceId: 'ws-task' };
    expect(botWorkerForCreate(opts, NOT_BOT)).toBeNull();
    expect(withBotWorkerMergeGuard(opts, botWorkerForCreate(opts, NOT_BOT), { dir })).toBe(opts);
  });

  it('the fan-out create main is running for a bot is guarded whatever origin the renderer echoes', () => {
    const release = beginBotWorkerSpawn('ws-owner', '/w/task');
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', fanoutOrigin: { kind: 'pane', paneId: 'p1' }, cwd: '/w/task/', workspaceId: 'ws-task' };
      const worker = botWorkerForCreate(opts, NOT_BOT);
      expect(worker).toEqual({ workspaceId: 'ws-task', strict: true });
      const guarded = withBotWorkerMergeGuard(opts, worker, { dir, ...mcp() })!.initialCommand!;
      const files = strictFiles(guarded);
      expect(guarded).toBe(`claude --settings="${files.settings}" --mcp-config="${files.mcp}" --strict-mcp-config --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
      expect(path.dirname(files.settings)).toBe(path.join(dir, 'factory', 'worker-settings'));
      expect(JSON.parse(fs.readFileSync(files.settings, 'utf8')).permissions.deny).toEqual([...BOT_WORKER_DENY]);
      expect(JSON.parse(fs.readFileSync(files.mcp, 'utf8'))).toEqual({ mcpServers: { wmux: { type: 'stdio', command: 'node', args: [ENTRY] } } });
      // A WSL shell keeps the worker settings file alone, as before.
      expect(withBotWorkerMergeGuard(opts, worker, { dir, ...mcp() }, { wsl: true })!.initialCommand).toBe(`claude --settings="${toWslPath(botWorkerSettingsPath(dir)) ?? botWorkerSettingsPath(dir)}" --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
      // On Windows the file is handed to Linux claude by its /mnt path.
      const winSettings = 'C:\\Users\\me\\.wmux-e2e\\factory\\worker-settings.json';
      expect(withBotWorkerMergeGuard(opts, worker, { dir, ...mcp(), writeSettings: () => winSettings }, { wsl: true })!.initialCommand)
        .toBe(`claude --settings="/mnt/c/Users/me/.wmux-e2e/factory/worker-settings.json" --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
      // Another owner, or another folder, is not that spawn.
      expect(botWorkerForCreate({ ...opts, fanoutTaskOf: 'ws-other' }, NOT_BOT)).toBeNull();
      expect(botWorkerForCreate({ ...opts, cwd: '/w/other' }, NOT_BOT)).toBeNull();
    } finally {
      release();
    }
    expect(botWorkerForCreate({ fanoutTaskOf: 'ws-owner', cwd: '/w/task', workspaceId: 'ws-task' }, NOT_BOT)).toBeNull();
  });

  it('a later pane in a bot\'s task workspace (the ledger) guards a claude line and leaves a shell alone', () => {
    const worker = botWorkerForCreate({ workspaceId: 'ws-task', cwd: '/w' }, BOT_WS);
    expect(worker).toEqual({ workspaceId: 'ws-task', strict: false });
    const resume = withBotWorkerMergeGuard({ initialCommand: 'claude --resume 11111111-2222-3333-4444-555555555555', cwd: dir }, worker, { dir, ...mcp() })!;
    expect(resume.initialCommand).toMatch(/^claude --settings="[^"]+" --mcp-config="[^"]+" --strict-mcp-config --resume/);
    const shell = {};
    expect(withBotWorkerMergeGuard(shell, worker, { dir, ...mcp() })).toBe(shell);
    // Codex runs in a bot's worker pane only as the fan-out's own first launch.
    expect(() => withBotWorkerMergeGuard({ initialCommand: 'codex resume --last', cwd: dir }, worker, { dir, ...mcp() })).toThrow(/only as the fan-out's own first launch/);
    expect(() => withBotWorkerMergeGuard({ initialCommand: 'cd /w && claude --resume x', cwd: dir }, worker, { dir, ...mcp() })).toThrow(/cannot carry/);
    expect(botWorkerForCreate({ workspaceId: 'ws-elsewhere' }, BOT_WS)).toBeNull();
  });

  it('reads the task ledger row main registered at dispatch, not the pane\'s claim', async () => {
    const ledger = new TaskLedger({ dir, log: () => undefined });
    await ledger.register({ id: 'task-b', taskWorkspaceId: 'ws-bot-task', ownerWorkspaceId: 'ws-hq', title: 't', dispatch: { origin: { kind: 'bot', botId: 'bot-00000001' } } });
    await ledger.register({ id: 'task-h', taskWorkspaceId: 'ws-human-task', ownerWorkspaceId: 'ws-hq', title: 't', dispatch: { origin: { kind: 'pane', botId: undefined } } });
    setTaskLedgerForTests(ledger);
    try {
      const pane = { workspaceId: 'ws-bot-task', fanoutOrigin: { kind: 'pane' } };
      const claimsBot = { workspaceId: 'ws-human-task', fanoutOrigin: BOT };
      expect(botWorkerForCreate(pane, { dir })).toEqual({ workspaceId: 'ws-bot-task', strict: false });
      expect(botWorkerForCreate(claimsBot, { dir })).toBeNull();
    } finally {
      setTaskLedgerForTests(null);
    }
  });

  it('fails closed: no worker without the guard', () => {
    const strict = { workspaceId: 'ws-task', strict: true };
    const failing = { dir, writeSettings: () => { throw new Error('EACCES'); } };
    expect(() => withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, strict, failing, { wsl: true })).toThrow(/merge-lane guard.*could not be written.*EACCES/);
    // Without the wmux bundle a worker could not report: it does not start.
    expect(() => withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, strict, { dir, mcpEntry: () => null })).toThrow(/MCP bundle was not found/);
    expect(() => withBotWorkerMergeGuard({ initialCommand: 'codex --yolo', cwd: dir }, strict, { dir, ...mcp() })).toThrow(/codex worker guard did not build/);
    for (const foreign of [`claude --settings="/tmp/x.json"`, `claude --mcp-config=/tmp/m.json`, 'claude --strict-mcp-config', `claude --mcp-config={"mcpServers":{}}`]) {
      expect(() => withBotWorkerMergeGuard({ initialCommand: foreign, cwd: dir }, strict, { dir, ...mcp() }), foreign).toThrow(/cannot carry/);
    }
    expect(() => withBotWorkerMergeGuard({}, strict, { dir, ...mcp() })).toThrow(/no launch line/);
    expect(() => withBotWorkerMergeGuard({ initialCommand: LINE, exec: 'claude', cwd: dir }, strict, { dir, ...mcp() })).toThrow(/exec unit/);
    expect(() => withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, strict, { dir: path.join(dir, 'a$b'), ...mcp() })).toThrow(/cannot carry/);
    // An unreadable ledger is not read as "not a bot".
    expect(() => botWorkerForCreate({ workspaceId: 'ws-task' }, { dir, isBotTaskWorkspace: () => { throw new Error('torn'); } })).toThrow(/ledger could not be read/);
  });
});

describe('bot worker sessions survive a restart', () => {
  it('a re-fire after a restart is guarded from the recorded session, and refused when it cannot be', () => {
    noteBotWorkerSession('daemon-bot1', 'ws-task', dir, { cwd: dir });
    expect(JSON.parse(fs.readFileSync(botWorkerSessionsPath(dir), 'utf8')).sessions['daemon-bot1'].workspaceId).toBe('ws-task');
    reloadBotWorkerSessionsForTests(); // the app restarts: nothing in memory
    expect(isBotWorkerSession('daemon-bot1', dir)).toBe(true);
    // A record from before per-launch files: a wmux-only strict launch.
    const refired = guardRefireLine('daemon-bot1', LINE, { dir, ...mcp() });
    expect(JSON.parse(fs.readFileSync(strictFiles(refired).mcp, 'utf8')).mcpServers).toEqual({ wmux: { type: 'stdio', command: 'node', args: [ENTRY] } });
    expect(() => guardRefireLine('daemon-bot1', 'codex x', { dir, ...mcp() })).toThrow(/worktask:refire.*merge-lane guard/);
    expect(guardRefireLine('daemon-human', 'codex x', { dir })).toBe('codex x');
  });

  it('a resume typed into a bot worker\'s pane after a restart is guarded; a staged suffix and other panes pass', () => {
    noteBotWorkerSession('daemon-bot2', 'ws-task', dir, { cwd: dir });
    reloadBotWorkerSessionsForTests();
    const resume = 'claude --resume 11111111-2222-3333-4444-555555555555';
    const typed = guardSessionLaunch('daemon-bot2', resume, { dir, ...mcp() });
    expect(typed).toBe(`claude --settings="${strictFiles(typed).settings}" --mcp-config="${strictFiles(typed).mcp}" --strict-mcp-config --resume 11111111-2222-3333-4444-555555555555`);
    expect(guardSessionLaunch('daemon-bot2', 'claude --permission-mode acceptEdits', { dir, ...mcp() })).toContain('--strict-mcp-config');
    expect(guardSessionLaunch('daemon-bot2', ' --resume 11111111-2222-3333-4444-555555555555', { dir, ...mcp() })).toBe(' --resume 11111111-2222-3333-4444-555555555555');
    expect(() => guardSessionLaunch('daemon-bot2', `cd '/w' && ${resume}`, { dir, ...mcp() })).toThrow(/pty:write-launch.*merge-lane guard/);
    expect(() => guardSessionLaunch('daemon-bot2', `claude "$(claude x)"`, { dir, ...mcp() })).toThrow(/cannot carry/);
    // Every claude launcher in the line is guarded, wherever it is written:
    // next to an operator the line is not one plain command, so it is refused.
    for (const glued of ['true;claude --resume x', 'true&&claude', 'x|claude', '(claude)', 'echo hi;claude.exe']) {
      expect(() => guardSessionLaunch('daemon-bot2', glued, { dir, ...mcp() }), glued).toThrow(/pty:write-launch/);
    }
    expect(guardSessionLaunch('daemon-human', resume, { dir })).toBe(resume);
  });

  it('a workspace whose ledger row is gone is still known from its recorded sessions', () => {
    noteBotWorkerSession('daemon-bot5', 'ws-task', dir);
    reloadBotWorkerSessionsForTests();
    expect(botWorkerForCreate({ workspaceId: 'ws-task' }, { dir, isBotTaskWorkspace: () => false })).toEqual({ workspaceId: 'ws-task', strict: false });
    expect(botWorkerForCreate({ workspaceId: 'ws-other' }, { dir, isBotTaskWorkspace: () => false })).toBeNull();
  });

  it('an unreadable record guards every pane (a re-fire is refused) and records nothing over it', () => {
    for (const bad of ['{not json', JSON.stringify({ version: 2, sessions: {} }), JSON.stringify({ version: 1, sessions: { 'daemon-x': { at: 1 } } })]) {
      fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
      fs.writeFileSync(botWorkerSessionsPath(dir), bad);
      reloadBotWorkerSessionsForTests();
      expect(isBotWorkerSession('daemon-anyone', dir)).toBe(true);
      // No folder on record to check: nothing is re-fired.
      expect(() => guardRefireLine('daemon-anyone', LINE, { dir, ...mcp() })).toThrow(/no folder on record/);
      expect(() => guardSessionLaunch('daemon-anyone', 'codex resume && claude', { dir })).toThrow(/codex is not started again/);
      expect(() => guardRefireLine('daemon-anyone', 'codex "$(cat \'/p\')"', { dir })).toThrow(/codex is not re-fired/);
      expect(botWorkerForCreate({ workspaceId: 'ws-any' }, { dir, isBotTaskWorkspace: () => false })).toEqual({ workspaceId: 'ws-any', strict: false });
      expect(() => noteBotWorkerSession('daemon-new', 'ws-task', dir)).toThrow(/sessions record is unreadable/);
      expect(fs.readFileSync(botWorkerSessionsPath(dir), 'utf8')).toBe(bad);
    }
  });

  it('a closed pane is forgotten, on disk too', () => {
    noteBotWorkerSession('daemon-bot3', 'ws-task', dir);
    forgetBotWorkerSession('daemon-bot3', dir);
    reloadBotWorkerSessionsForTests();
    expect(isBotWorkerSession('daemon-bot3', dir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a session that cannot be recorded fails the create and is not remembered', () => {
    noteBotWorkerSession('daemon-bot6', 'ws-task', dir);
    const factory = path.join(dir, 'factory');
    fs.chmodSync(factory, 0o500);
    try {
      expect(() => noteBotWorkerSession('daemon-bot4', 'ws-task', dir)).toThrow(/session could not be recorded/);
      expect(isBotWorkerSession('daemon-bot4', dir)).toBe(false);
      expect(isBotWorkerSession('daemon-bot6', dir)).toBe(true);
    } finally {
      fs.chmodSync(factory, 0o700);
    }
  });
});

describe('pty:create applies the guard (source-level lock)', () => {
  it('both create paths guard after the lineage stamp and before the session pin', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');
    const line = 'const staged = await stageCreate(options, botWorker);';
    expect(src.split(line).length - 1).toBe(2);
    // The stages, in order: quota, the tool level (or, for a bot worker's
    // claude line, the guard's own wmux server), codex guard, merge guard, pin.
    expect(src).toContain('let staged = await withAccountQuota(options);');
    expect(src).toContain('const wsl = isWslShell(createShell(options));');
    expect(src).toMatch(/withBotWorkerMergeGuard\(await guardCodexBotWorker\(staged, botWorker\), botWorker, \{\}, \{ wsl,/);
    expect(src).toContain('return { options: withLaunchSessionPin(guarded), launch: { ...launchOfCodex(guarded), ...guardedLaunchOf(guarded) } };');
    expect(src.split('stampFanoutTaskPane(options);').length - 1).toBe(2);
    for (let at = src.indexOf('stampFanoutTaskPane(options);'); at !== -1; at = src.indexOf('stampFanoutTaskPane(options);', at + 1)) {
      expect(src.indexOf(line, at)).toBeGreaterThan(at);
    }
    // The session is recorded (before the daemon creates it), and forgotten with the pane.
    expect(src.indexOf('if (botWorker) noteBotWorkerSession(sessionId, botWorker.workspaceId, undefined, staged.launch);')).toBeLessThan(src.indexOf("daemonClient.rpc('daemon.createSession'"));
    expect(src).toContain('noteBotWorkerSession(instance.id, botWorker.workspaceId, undefined, staged.launch);');
    // The record carries a guarded codex launch's folder as well as a claude launch's files.
    expect(src).toContain('launch: { ...launchOfCodex(guarded), ...guardedLaunchOf(guarded) }');
    expect(src.split('forgetBotWorkerSession(id);').length - 1).toBe(2);
    // A resume line typed through main gets the session guard.
    expect(src).toMatch(/IPC\.PTY_WRITE_LAUNCH[\s\S]{0,1400}const shaped = promptFileArgumentForShell\(text, \{ wsl: isWslShell\(getPtyShell\(id\)\) \}\);\s+const line = sanitizePtyText\(await guardBotWorkerSessionText\(id, shaped, 'write-launch', folders/);
  });

  it('the resume writers type through main, and fan-out marks a bot\'s spawn around the renderer round trip', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
    const pane = read('src/renderer/components/Pane/Pane.tsx');
    expect(pane).toContain('window.electronAPI.pty.writeLaunch(ptyId, line, true)');
    expect(pane).toContain('window.electronAPI.pty.writeLaunch(ptyId, text, false)');
    expect(pane).not.toMatch(/pty\.write\(ptyId, `\$\{line\}\\r`\)/);
    expect(read('src/renderer/components/Pane/ResumeInfoChip.tsx')).toContain('window.electronAPI.pty.writeLaunch(ptyId, command, false)');
    const fanout = read('src/main/worktask/FanOutService.ts');
    expect(fanout).toMatch(/ctx\.requester\?\.kind === 'bot'\s*\?\s*beginBotWorkerSpawn\(ctx\.verifiedWorkspaceId, cwd,/);
    expect(fanout).toMatch(/releaseAgyTrust\(\);\s*releaseBotSpawn\(\);/);
  });
});

describe('clearedLaunchLine', () => {
  it('clears the screen before a bot worker\'s line in a POSIX shell, and leaves the line itself as it is', () => {
    const line = 'ANTHROPIC_BASE_URL=x claude --session-id 1 --dangerously-skip-permissions';
    expect(clearedLaunchLine(line, '/bin/zsh', 'darwin')).toBe(`clear; ${line}`);
    expect(clearedLaunchLine(line, '/usr/bin/bash', 'linux')).toBe(`clear; ${line}`);
    expect(clearedLaunchLine(line, 'fish', 'linux')).toBe(`clear; ${line}`);
    // Windows shells, unknown shells and no line: unchanged.
    expect(clearedLaunchLine(line, 'pwsh.exe', 'win32')).toBe(line);
    expect(clearedLaunchLine(line, '/usr/bin/nu', 'linux')).toBe(line);
    expect(clearedLaunchLine(undefined, '/bin/zsh', 'darwin')).toBeUndefined();
    expect(clearedLaunchLine('  ', '/bin/zsh', 'darwin')).toBe('  ');
  });
});
