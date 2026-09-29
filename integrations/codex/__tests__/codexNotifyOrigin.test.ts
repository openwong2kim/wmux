import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// The notify bridge is plain .mjs (Codex spawns it with `node`); it exports
// its pure origin classifier so the rules can be checked without a process tree.
import {
  classifyNotifierOrigin, tokenizeCommandLine, parseProcEntry, parsePsEntry,
} from '../bin/wmux-codex-notify.mjs';

// #1523: Codex 0.157+ spawns `notify` from a shared, detached app-server that
// keeps the environment of whichever pane started it. The bridge must refuse
// such a notification instead of attributing it to that pane.

const BRIDGE = path.join(__dirname, '..', 'bin', 'wmux-codex-notify.mjs');
const SERVER_ARGV = ['app-server', '--listen', 'unix://', '--managed-daemon'];
const THREAD_ID = '11111111-2222-4333-8444-555555555555';

describe('classifyNotifierOrigin', () => {
  it('names a shared app-server parent', () => {
    expect(classifyNotifierOrigin([['/usr/local/bin/codex', ...SERVER_ARGV]])).toBe('shared-server');
  });

  it('trusts a Codex process that runs the turn itself', () => {
    for (const argv of [
      ['/usr/local/bin/codex'],
      ['/usr/local/bin/codex', 'resume', THREAD_ID],
      ['/usr/local/bin/codex', '--no-daemon', '-c', 'features.daemon_auto_start=false'],
      ['/usr/local/bin/codex', 'exec', 'fix the tests'],
    ]) {
      expect(classifyNotifierOrigin([argv])).toBe('process');
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

  it('matches `app-server` only as a whole token', () => {
    expect(classifyNotifierOrigin([['codex', '--app-server-url=unix://x']])).toBe('process');
    expect(classifyNotifierOrigin([['codex', 'exec', 'restart the app-server']])).toBe('process');
    // `ps` prints argv unquoted, so on macOS a prompt holding the word splits
    // into a matching token. That only drops the signal — the safe side.
    expect(classifyNotifierOrigin([['codex', 'exec', 'restart', 'the', 'app-server']])).toBe('shared-server');
  });

  it('classifies Windows command lines once tokenized', () => {
    const server = tokenizeCommandLine(
      '"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe" app-server --listen unix:// --managed-daemon',
    );
    expect(classifyNotifierOrigin([server])).toBe('shared-server');
    const prompt = tokenizeCommandLine('"C:\\Program Files\\codex\\codex.exe" "restart the app-server"');
    expect(classifyNotifierOrigin([prompt])).toBe('process');
  });
});

describe('tokenizeCommandLine', () => {
  it('keeps quoted paths with spaces whole', () => {
    expect(tokenizeCommandLine(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\A B\\.wmux\\hooks\\wmux-codex-notify.mjs"  x',
    )).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\A B\\.wmux\\hooks\\wmux-codex-notify.mjs', 'x']);
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
    // way Codex spawns `notify`. Its own argv is what the bridge inspects.
    fs.writeFileSync(path.join(dir, 'parent.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      'const [cmd, ...args] = JSON.parse(process.env.WMUX_TEST_CHILD);',
      "process.exit(spawnSync(cmd, args, { stdio: 'ignore' }).status ?? 1);",
    ].join('\n'));
    // A version-manager style shim: re-runs `node <bridge> <payload>` as a child.
    fs.writeFileSync(path.join(dir, 'shim.mjs'), [
      "import { spawnSync } from 'node:child_process';",
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

  function run(parentArgv: string[], opts: { shim?: boolean } = {}): Promise<number | null> {
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': THREAD_ID, 'turn-id': 'turn-1', cwd: dir });
    const child = opts.shim
      ? [process.execPath, path.join(dir, 'shim.mjs'), BRIDGE, payload]
      : [process.execPath, BRIDGE, payload];
    const env: NodeJS.ProcessEnv = { ...process.env };
    // This suite may itself run inside a wmux pane.
    for (const key of Object.keys(env)) if (key.startsWith('WMUX_')) delete env[key];
    Object.assign(env, {
      USERPROFILE: home,
      HOME: home,
      WMUX_PIPE_NAME: pipe,
      // The identity of the pane that happened to start the shared server.
      WMUX_PTY_ID: 'pty-starter',
      WMUX_WORKSPACE_ID: 'ws-starter',
      WMUX_SURFACE_ID: 'surface-starter',
      WMUX_TEST_CHILD: JSON.stringify(child),
    });
    const proc = spawn(process.execPath, [path.join(dir, 'parent.mjs'), ...parentArgv], { env, stdio: 'ignore' });
    return new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  }

  it('refuses a notification from a shared app-server: nothing sent, nothing spooled', async () => {
    writeToken();
    expect(await run(SERVER_ARGV)).toBe(0);
    expect(received).toEqual([]);
    expect(spoolFiles()).toEqual([]);
    expect(logLines()).toEqual([
      expect.objectContaining({ outcome: 'refused-shared-server', sessionId: THREAD_ID, claimedPtyId: 'pty-starter' }),
    ]);
  }, 20_000);

  it('sees through a wrapper that re-runs the bridge', async () => {
    writeToken();
    expect(await run(SERVER_ARGV, { shim: true })).toBe(0);
    expect(received).toEqual([]);
    expect(logLines().map((l) => l.outcome)).toEqual(['refused-shared-server']);
  }, 20_000);

  it('does not spool under the inherited pane id when no wmux endpoint exists', async () => {
    // No auth token: the send is skipped and the bridge used to spool the
    // resume binding under WMUX_PTY_ID straight away.
    expect(await run(SERVER_ARGV)).toBe(0);
    expect(spoolFiles()).toEqual([]);
  }, 20_000);

  it('still attributes a turn run by the Codex process itself (older builds, --no-daemon)', async () => {
    writeToken();
    expect(await run(['--no-daemon', 'resume', THREAD_ID])).toBe(0);
    expect(received).toEqual([
      expect.objectContaining({
        method: 'hooks.signal',
        params: expect.objectContaining({
          kind: 'agent.stop',
          agent: 'codex',
          agentSessionId: THREAD_ID,
          ptyId: 'pty-starter',
          workspaceId: 'ws-starter',
          surfaceId: 'surface-starter',
        }),
      }),
    ]);
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'ok', origin: 'process' })]);
  }, 20_000);

  it('still spools under the pane id for a Codex process when no endpoint exists', async () => {
    expect(await run(['resume', THREAD_ID])).toBe(0);
    expect(spoolFiles()).toEqual(['pty-starter.json']);
  }, 20_000);
});
