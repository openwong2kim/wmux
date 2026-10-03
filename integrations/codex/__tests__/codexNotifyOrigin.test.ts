import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// The notify bridge is plain .mjs (Codex spawns it with `node`); it exports
// its pure origin rules so they can be checked without a process tree.
import {
  classifyNotifierOrigin, isSharedServerArgv, claimsPaneIdentity, tokenizeCommandLine, parseProcEntry, parsePsEntry,
  parseHandedArgv,
} from '../bin/wmux-codex-notify.mjs';

// #1523: Codex 0.157+ spawns `notify` from a shared, detached app-server that
// keeps the environment of whichever pane started it. The bridge must refuse
// such a notification instead of attributing it to that pane — and must not
// refuse anything else: a dropped turn-complete is invisible to the user.

const BRIDGE = path.join(__dirname, '..', 'bin', 'wmux-codex-notify.mjs');
const SERVER_FLAGS = ['--listen', 'unix://', '--managed-daemon'];
const SERVER_ARGV = ['app-server', ...SERVER_FLAGS];
const THREAD_ID = '11111111-2222-4333-8444-555555555555';

describe('isSharedServerArgv', () => {
  it('names the managed daemon and any server listening beyond stdio', () => {
    for (const argv of [
      ['/usr/local/bin/codex', ...SERVER_ARGV],
      ['codex', 'app-server', '--managed-daemon'],
      ['codex', 'app-server', '--listen', 'unix:///tmp/codex.sock'],
      ['codex', 'app-server', '--listen=ws://127.0.0.1:4222'],
      ['codex', '-c', 'model="o3"', '--enable', 'x', 'app-server', '--listen', 'unix://'],
    ]) {
      expect(isSharedServerArgv(argv), argv.join(' ')).toBe(true);
    }
  });

  it('leaves a stdio server alone: it serves the one client that started it', () => {
    // wmux's own Chat composer runs exactly this, per pane, with the pane's env
    // (src/daemon/chat/CodexChatAdapter.ts).
    for (const argv of [
      ['codex', 'app-server', '--listen', 'stdio://'],
      ['codex', 'app-server', '--listen=stdio://'],
      ['codex', 'app-server', '--stdio'],
      ['codex', 'app-server'],
    ]) {
      expect(isSharedServerArgv(argv), argv.join(' ')).toBe(false);
    }
  });

  it('reads `app-server` only as the subcommand, never as an option value', () => {
    for (const argv of [
      ['codex', '--cd', 'app-server'],
      ['codex', '-C', 'app-server', 'exec', 'fix tests'],
      ['codex', '--add-dir', 'app-server', '--listen', 'unix://'],
      ['codex', '--no-daemon', '-C', 'app-server', 'exec', 'fix tests'],
      ['codex', '-m', 'app-server', 'resume', THREAD_ID],
    ]) {
      expect(isSharedServerArgv(argv), argv.join(' ')).toBe(false);
    }
  });

  it('never reads a prompt as a server', () => {
    for (const argv of [
      ['codex', 'exec', 'restart the app-server --listen unix://'],
      // `ps` prints argv unquoted, so on macOS a prompt splits into words.
      ['codex', 'exec', 'restart', 'the', 'app-server', '--listen', 'unix://'],
      ['codex', '--', 'app-server', '--listen', 'unix://'],
      // `-i` takes any number of files; what follows cannot be placed.
      ['codex', '-i', 'shot.png', 'app-server', '--listen', 'unix://'],
      ['codex', '--app-server-url=unix://x'],
    ]) {
      expect(isSharedServerArgv(argv), argv.join(' ')).toBe(false);
    }
  });

  it('still names the managed daemon when `ps` splits a spaced executable path', () => {
    expect(isSharedServerArgv(['/Applications/Codex', 'App/codex', ...SERVER_ARGV])).toBe(true);
  });
});

describe('classifyNotifierOrigin', () => {
  it('decides on the process that spawned the notification', () => {
    expect(classifyNotifierOrigin([['/usr/local/bin/codex', ...SERVER_ARGV]])).toBe('shared-server');
    for (const argv of [
      ['/usr/local/bin/codex'],
      ['/usr/local/bin/codex', 'resume', THREAD_ID],
      ['/usr/local/bin/codex', '--no-daemon', '-c', 'features.daemon_auto_start=false'],
      ['/usr/local/bin/codex', 'exec', 'fix the tests'],
      ['/usr/local/bin/codex', 'app-server', '--listen', 'stdio://'],
    ]) {
      expect(classifyNotifierOrigin([argv]), argv.join(' ')).toBe('process');
    }
  });

  it('skips wrappers that re-run this script and decides on the process above them', () => {
    const shim = ['node', '/Users/u/.wmux/hooks/wmux-codex-notify.mjs', '{"type":"agent-turn-complete"}'];
    expect(classifyNotifierOrigin([shim, ['/usr/local/bin/codex', ...SERVER_ARGV]])).toBe('shared-server');
    expect(classifyNotifierOrigin([shim, ['/usr/local/bin/codex', 'resume', THREAD_ID]])).toBe('process');
    // Windows paths compare case-insensitively.
    const winShim = ['C:\\volta\\node.exe', 'C:\\Users\\U\\.wmux\\hooks\\WMUX-CODEX-NOTIFY.MJS', '{}'];
    expect(classifyNotifierOrigin([winShim, ['codex.exe', ...SERVER_ARGV]])).toBe('shared-server');
  });

  it('is unknown when no ancestor could be read, or only wrappers were', () => {
    expect(classifyNotifierOrigin([])).toBe('unknown');
    expect(classifyNotifierOrigin([[]])).toBe('unknown');
    expect(classifyNotifierOrigin([['node', '/x/wmux-codex-notify.mjs', '{}']])).toBe('unknown');
  });

  it('classifies Windows command lines once tokenized', () => {
    const server = tokenizeCommandLine(
      '"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe" app-server --listen unix:// --managed-daemon',
    );
    expect(classifyNotifierOrigin([server])).toBe('shared-server');
    // An odd number of escaped quotes used to flip the tokenizer's quoting and
    // leave `app-server` standing alone.
    for (const line of [
      '"C:\\Program Files\\codex\\codex.exe" "restart the app-server"',
      '"C:\\Program Files\\codex\\codex.exe" exec "say \\"hi app-server --listen unix://"',
      '"C:\\Program Files\\codex\\codex.exe" --no-daemon -C app-server exec "fix \\"tests\\""',
    ]) {
      expect(classifyNotifierOrigin([tokenizeCommandLine(line)]), line).toBe('process');
    }
  });
});

describe('claimsPaneIdentity', () => {
  it('is true only when a wmux pane or instance is named', () => {
    expect(claimsPaneIdentity({})).toBe(false);
    expect(claimsPaneIdentity({ WMUX_PTY_ID: '', WMUX_MEMBER_ID: 'pty-1', HOME: '/home/u' })).toBe(false);
    for (const key of ['WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX']) {
      expect(claimsPaneIdentity({ [key]: 'x' }), key).toBe(true);
    }
  });
});

describe('tokenizeCommandLine', () => {
  it('keeps quoted paths with spaces whole', () => {
    expect(tokenizeCommandLine(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\A B\\.wmux\\hooks\\wmux-codex-notify.mjs"  x',
    )).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\A B\\.wmux\\hooks\\wmux-codex-notify.mjs', 'x']);
  });

  it('follows the CommandLineToArgvW backslash and quote rules', () => {
    expect(tokenizeCommandLine('a\\"b')).toEqual(['a"b']);
    expect(tokenizeCommandLine('a\\\\"b c"')).toEqual(['a\\b c']);
    expect(tokenizeCommandLine('C:\\dir\\ x')).toEqual(['C:\\dir\\', 'x']);
    expect(tokenizeCommandLine('"x""y" ""')).toEqual(['x"y', '']);
    // Single quotes are ordinary characters on Windows.
    expect(tokenizeCommandLine("'two words'")).toEqual(["'two", "words'"]);
  });

  it('returns no tokens for an empty or missing command line', () => {
    expect(tokenizeCommandLine('')).toEqual([]);
    expect(tokenizeCommandLine(undefined)).toEqual([]);
  });
});

describe('ancestor entry parsers', () => {
  it('reads argv and the parent from Linux /proc, even with a hostile comm', () => {
    expect(parseProcEntry(
      '/usr/bin/codex\0app-server\0--listen\0unix://\0--managed-daemon\0',
      '4242 (codex (x) y) S 1 4242 4242 0 -1 4194560',
    )).toEqual({ argv: ['/usr/bin/codex', ...SERVER_ARGV], ppid: 1 });
    expect(parseProcEntry('', 'garbage')).toEqual({ argv: [], ppid: 0 });
  });

  it('reads the parent and argv from a `ps -o ppid=,args=` line', () => {
    expect(parsePsEntry('    1 /opt/homebrew/bin/codex app-server --listen unix:// --managed-daemon\n'))
      .toEqual({ argv: ['/opt/homebrew/bin/codex', ...SERVER_ARGV], ppid: 1 });
    expect(parsePsEntry('')).toBeNull();
  });

  it('reads the argv the WSL launcher hands over, /proc terminators and all', () => {
    // Every argument ends with U+001F, as every /proc argument ends with NUL.
    expect(parseHandedArgv('/usr/bin/codex\x1fapp-server\x1f--listen\x1funix://\x1f--managed-daemon\x1f'))
      .toEqual(['/usr/bin/codex', ...SERVER_ARGV]);
    // An empty last argument survives; a value cut short keeps its tail.
    expect(parseHandedArgv('codex\x1fexec\x1f\x1f')).toEqual(['codex', 'exec', '']);
    expect(parseHandedArgv('codex\x1fexe')).toEqual(['codex', 'exe']);
  });
});

// The real thing: the bridge runs under a fake Codex parent, reads its actual
// ancestors (`/proc`, `ps` or PowerShell, per platform) and talks to a fake
// wmux main pipe.
describe('wmux-codex-notify under a fake Codex parent', () => {
  let dir: string;
  let home: string;
  let pipe: string;
  let server: net.Server;
  let received: Array<{ method?: string; params?: Record<string, unknown> }>;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cn-origin-')));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    // A parent that runs the command in WMUX_TEST_CHILD and waits for it, the
    // way Codex spawns `notify`. Its own argv is what the bridge inspects. The
    // copy named `app-server` runs as `node app-server --listen …`, so what
    // follows the executable is exactly what a real Codex server has there.
    // CommonJS, because an extensionless file is loaded as CommonJS.
    const parent = [
      "const { spawnSync } = require('node:child_process');",
      'const [cmd, ...args] = JSON.parse(process.env.WMUX_TEST_CHILD);',
      "process.exit(spawnSync(cmd, args, { stdio: 'ignore' }).status ?? 1);",
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'app-server'), parent);
    fs.writeFileSync(path.join(dir, 'parent.cjs'), parent);
    // A version-manager style shim: re-runs `node <bridge> <payload>` as a child.
    fs.writeFileSync(path.join(dir, 'shim.cjs'), [
      "const { spawnSync } = require('node:child_process');",
      "process.exit(spawnSync(process.execPath, process.argv.slice(2), { stdio: 'ignore' }).status ?? 1);",
    ].join('\n'));
    received = [];
    // Short on POSIX: a macOS temp dir alone nears the 104-byte socket limit.
    pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\wmux-codex-notify-test-${randomUUID()}`
      : path.join(os.tmpdir(), `wmux-cn-${randomUUID().slice(0, 8)}.sock`);
    server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const request = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          received.push(request);
          socket.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + '\n');
        }
      });
      socket.on('error', () => { /* the bridge closes first */ });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeToken = () => fs.writeFileSync(path.join(home, '.wmux-auth-token'), 'test-token');
  const spoolFiles = () => {
    const spool = path.join(home, '.wmux', 'resume-spool');
    return fs.existsSync(spool) ? fs.readdirSync(spool).filter((f) => f.endsWith('.json')) : [];
  };
  const logLines = () => {
    const log = path.join(home, '.wmux', 'codex-notify.log');
    return fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  };

  /** `parentArgv[0]` is the parent script, relative to the fixture directory. */
  function run(
    parentArgv: string[],
    opts: { shim?: boolean; identity?: boolean; handed?: string[]; agentProc?: string } = {},
  ): Promise<number | null> {
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': THREAD_ID, 'turn-id': 'turn-1', cwd: dir });
    const child = opts.shim
      ? [process.execPath, path.join(dir, 'shim.cjs'), BRIDGE, payload]
      : [process.execPath, BRIDGE, payload];
    const env: NodeJS.ProcessEnv = { ...process.env };
    // This suite may itself run inside a wmux pane.
    for (const key of Object.keys(env)) if (key.startsWith('WMUX_')) delete env[key];
    Object.assign(env, {
      USERPROFILE: home,
      HOME: home,
      WMUX_PIPE_NAME: pipe,
      WMUX_TEST_CHILD: JSON.stringify(child),
    });
    if (opts.identity !== false) {
      // The identity of the pane that happened to start the shared server.
      Object.assign(env, { WMUX_PTY_ID: 'pty-starter', WMUX_WORKSPACE_ID: 'ws-starter', WMUX_SURFACE_ID: 'surface-starter' });
    }
    // The launcher's form: /proc/<pid>/cmdline with each NUL turned into U+001F.
    if (opts.handed) env.WMUX_CODEX_NOTIFIER_ARGV = opts.handed.map((arg) => `${arg}\x1f`).join('');
    if (opts.agentProc !== undefined) env.WMUX_WSL_AGENT_PROC = opts.agentProc;
    const proc = spawn(process.execPath, parentArgv, { cwd: dir, env, stdio: 'ignore' });
    return new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  }

  const delivered = (claims: Record<string, unknown>) => expect.objectContaining({
    method: 'hooks.signal',
    params: expect.objectContaining({ kind: 'agent.stop', agent: 'codex', agentSessionId: THREAD_ID, ...claims }),
  });
  const PANE = { ptyId: 'pty-starter', workspaceId: 'ws-starter', surfaceId: 'surface-starter' };

  it('refuses a shared server whose environment claims a pane: nothing sent, nothing spooled', async () => {
    writeToken();
    expect(await run(SERVER_ARGV)).toBe(0);
    expect(received).toEqual([]);
    expect(spoolFiles()).toEqual([]);
    expect(logLines()).toEqual([
      expect.objectContaining({ outcome: 'refused-shared-server', sessionId: THREAD_ID, claimedPtyId: 'pty-starter' }),
    ]);
  }, 20_000);

  it('does not spool under the inherited pane id when no wmux endpoint exists', async () => {
    // No auth token: the send is skipped and the bridge used to spool the
    // resume binding under WMUX_PTY_ID straight away.
    expect(await run(SERVER_ARGV)).toBe(0);
    expect(spoolFiles()).toEqual([]);
    expect(logLines().map((l) => l.outcome)).toEqual(['refused-shared-server']);
  }, 20_000);

  it('sees through a wrapper that re-runs the bridge', async () => {
    writeToken();
    expect(await run(SERVER_ARGV, { shim: true })).toBe(0);
    expect(received).toEqual([]);
    expect(logLines().map((l) => l.outcome)).toEqual(['refused-shared-server']);
  }, 20_000);

  it('sends a clean shared server\'s notification without a pane, as before', async () => {
    // What wmux itself starts (codexSharedRuntime): every WMUX_* removed. The
    // daemon places the signal by cwd; it feeds the status dot and webhooks.
    writeToken();
    expect(await run(SERVER_ARGV, { identity: false })).toBe(0);
    expect(received).toEqual([delivered({})]);
    const params = received[0].params ?? {};
    expect(['ptyId', 'workspaceId', 'surfaceId'].filter((k) => k in params)).toEqual([]);
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'ok', origin: 'unclaimed' })]);
  }, 20_000);

  it('attributes a per-pane stdio server (the Chat composer) to its pane', async () => {
    writeToken();
    expect(await run(['app-server', '--listen', 'stdio://'])).toBe(0);
    expect(received).toEqual([delivered(PANE)]);
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'ok', origin: 'process' })]);
  }, 20_000);

  it('attributes a Codex process that runs the turn itself, whatever words it was given', async () => {
    // The review's regression: this parent used to be refused on every turn.
    // A node script name sits where Codex's subcommand would, so the
    // option-value rules themselves are proven by the pure fixtures above.
    writeToken();
    expect(await run(['parent.cjs', '--no-daemon', '-C', 'app-server', 'exec', 'fix tests'])).toBe(0);
    expect(received).toEqual([delivered(PANE)]);
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'ok', origin: 'process' })]);
  }, 20_000);

  it('still spools under the pane id for a Codex process when no endpoint exists', async () => {
    expect(await run(['parent.cjs', 'resume', THREAD_ID])).toBe(0);
    expect(spoolFiles()).toEqual(['pty-starter.json']);
  }, 20_000);

  it('decides on the argv the WSL launcher hands over instead of its own parent', async () => {
    writeToken();
    expect(await run(['parent.cjs', 'resume', THREAD_ID], { handed: ['/usr/bin/codex', ...SERVER_ARGV] })).toBe(0);
    expect(received).toEqual([]);
    expect(await run(['parent.cjs', 'resume', THREAD_ID], {
      handed: ['/usr/bin/codex', '--no-daemon', '-C', 'app-server', 'exec', 'fix tests'],
    })).toBe(0);
    expect(received).toEqual([delivered(PANE)]);
    expect(logLines().map((l) => l.outcome)).toEqual(['refused-shared-server', 'ok']);
  }, 20_000);

  // #1727 — the WSL Codex hook's report of which Linux process this Codex is.
  const AGENT_PROC = '1:0f6a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b\x1e4321:991739:/usr/bin/codex\x1f--no-daemon';

  it("carries the WSL hook's agent-process report on its own pane's notification", async () => {
    writeToken();
    expect(await run(['parent.cjs', 'resume', THREAD_ID], { agentProc: AGENT_PROC })).toBe(0);
    expect(received).toEqual([delivered({ ...PANE, wslAgentProcess: AGENT_PROC })]);
  }, 20_000);

  it('never sends a report a shared server carries', async () => {
    writeToken();
    expect(await run(SERVER_ARGV, { agentProc: AGENT_PROC })).toBe(0);
    expect(received).toEqual([]);
  }, 20_000);

  it('drops an oversized report and still sends the notification', async () => {
    writeToken();
    expect(await run(['parent.cjs', 'resume', THREAD_ID], { agentProc: 'x'.repeat(9000) })).toBe(0);
    expect(received).toEqual([delivered(PANE)]);
    expect('wslAgentProcess' in (received[0].params ?? {})).toBe(false);
  }, 20_000);
});
