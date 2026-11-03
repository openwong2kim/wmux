import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import * as pty from 'node-pty';
import { buildShimCmd } from '../../main/cliShim';

// The real CLI, run through the generated wmux.cmd in a real console (a ConPTY,
// as in a wmux pane) under code page 949, where a byte-wise UTF-8 write garbles
// Korean. Two commands that need no daemon carry Korean on each stream:
const STDERR_LINE = 'Unknown command: "한글명령". Run \'wmux --help\' for usage.';
const STDOUT_ERROR = '"error": "unknown subcommand: 한글"';
const ON_STDERR = '한글명령';
const ON_STDOUT = 'daemon 한글 --json';

const repo = nodePath.join(__dirname, '..', '..', '..');

type Run = { exitCode: number; screen: string; file: string | null };

/**
 * A Squirrel-shaped root: `<root>\app-1.0.0\wmux.exe`, the CLI bundle (beside
 * the koffi it ships with, unless `koffi` is false) and `<root>\bin\wmux.cmd`.
 * The bundle directory also holds consoleStdio.ts on its own, for probes.
 */
function makeRoot(parent: string, installExe: (app: string) => void, koffi = true): string {
  const root = nodeFs.mkdtempSync(nodePath.join(parent, 'wmux console (a&b) '));
  const app = nodePath.join(root, 'app-1.0.0');
  const bundle = nodePath.join(app, 'resources', 'cli-bundle');
  nodeFs.mkdirSync(nodePath.join(bundle, 'node_modules', '@koromix'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'bin'));
  nodeFs.writeFileSync(nodePath.join(root, 'bin', 'wmux.cmd'), buildShimCmd());
  installExe(app);
  // As package.json's build:cli and forge.config.ts ship it.
  for (const [entry, out] of [['index.ts', 'index.js'], ['consoleStdio.ts', 'consoleStdio.cjs']]) {
    buildSync({
      entryPoints: [nodePath.join(repo, 'src', 'cli', entry)], bundle: true, platform: 'node', format: 'cjs',
      outfile: nodePath.join(bundle, out), external: ['koffi'], logLevel: 'silent',
    });
  }
  if (koffi) {
    nodeFs.cpSync(nodePath.join(repo, 'node_modules', 'koffi'), nodePath.join(bundle, 'node_modules', 'koffi'), { recursive: true });
    const koromix = `koffi-win32-${process.arch}`;
    nodeFs.cpSync(nodePath.join(repo, 'node_modules', '@koromix', koromix), nodePath.join(bundle, 'node_modules', '@koromix', koromix), { recursive: true });
  }
  return root;
}

/** `line` in a console of its own under code page 949; FILE in it names a file the result reads back. */
function runLine(root: string, line: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const file = nodePath.join(root, 'redirected.txt');
  nodeFs.rmSync(file, { force: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(wmux_|electron_run_as_node$|electron_no_attach_console$)/i.test(key)) env[key] = value;
  }
  // No daemon to reach: another data suffix, and a profile with no token or port file.
  Object.assign(env, { WMUX_DATA_SUFFIX: `-console-test-${process.pid}`, USERPROFILE: root, HOME: root }, extraEnv);
  const command = `chcp 949 >nul & ${line.replace('FILE', `"${file}"`)}`;
  return new Promise((resolve) => {
    const term = pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${command}"`, { cols: 400, rows: 30, cwd: root, env, useConpty: true });
    let out = '';
    term.onData((data) => { out += data; });
    // node-pty emits exit once the output pipe has closed: every byte is in.
    term.onExit(({ exitCode }) => resolve({
      exitCode,
      // eslint-disable-next-line no-control-regex -- stripping the console's escape sequences is the point
      screen: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''),
      file: nodeFs.existsSync(file) ? nodeFs.readFileSync(file, 'utf8') : null,
    }));
  });
}

/** `wmux <args>` through the shim, with `redirect` appended. */
function run(root: string, args: string, redirect = '', extraEnv: Record<string, string> = {}): Promise<Run> {
  return runLine(root, `"${nodePath.join(root, 'bin', 'wmux.cmd')}" ${args} ${redirect}`, extraEnv);
}

// wmux.exe is Electron run as Node, a GUI-subsystem program. With nothing
// redirected Electron attaches to the console itself and, since Electron 45
// (Chromium 156), hands Node console handles it can read, so Node sees a TTY;
// with a stream redirected it does not attach, and the other stream arrives as
// no handle at all. A GUI-subsystem copy of Node cannot stand
// in: Node fills a missing std handle with NUL at startup, which is
// indistinguishable from a real `>nul`. Since Electron 42 `require('electron')`
// downloads a missing binary, so the installed one is looked up without it; CI's
// integration lane installs it with `npx install-electron`.
const electron = (() => {
  try {
    const dir = nodePath.dirname(createRequire(__filename).resolve('electron/package.json'));
    return nodePath.join(dir, 'dist', nodeFs.readFileSync(nodePath.join(dir, 'path.txt'), 'utf8').trim());
  } catch { return ''; }
})();

/** Electron's files as `<app>\wmux.exe` and its siblings: hard links where they can be. */
function installElectron(app: string): void {
  const dist = nodePath.dirname(electron);
  for (const entry of nodeFs.readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const to = nodePath.join(app, entry.name === nodePath.basename(electron) ? 'wmux.exe' : entry.name);
    try { nodeFs.linkSync(nodePath.join(dist, entry.name), to); } catch { nodeFs.copyFileSync(nodePath.join(dist, entry.name), to); }
  }
}

// What the routed streams must keep of Node's own stdio, written to argv[2] as
// JSON. The probe ends by returning, not by process.exit: the console only
// closes if the routed streams leave the event loop free.
const PROBE = `
const fs = require('fs');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const { routeConsoleStdio, childStdio } = require('./consoleStdio.cjs');
routeConsoleStdio();
const out = process.stdout;
const err = process.stderr;
const facts = { isStdio: [out._isStdio, err._isStdio], isTTY: [!!out.isTTY, !!err.isTTY] };
err.emit('error', new Error('the console stopped taking writes'));
err.write('AFTER ERROR 한글\\n');
Readable.from(['PIPED 한글\\n']).pipe(err).on('unpipe', () => {
  err.write('AFTER PIPE 한글\\n');
  spawnSync(process.env.ComSpec, ['/d', '/c', 'echo CHILD OUT& echo CHILD ERR 1>&2'], { stdio: childStdio() });
  err.end();
  err.destroy();
  facts.fdOpenAfterEnd = (() => { try { fs.fstatSync(err.fd); return true; } catch { return false; } })();
  fs.writeFileSync(process.argv[2], JSON.stringify(facts));
});
`;

describe.skipIf(process.platform !== 'win32' || !electron || !nodeFs.existsSync(electron))('wmux CLI output on the console (Electron, code page 949)', () => {
  // Beside node_modules, so Electron's files can be hard links rather than copies.
  const parent = nodePath.join(repo, 'node_modules', '.cache');
  let root = '';
  let bare = '';
  beforeAll(() => {
    nodeFs.mkdirSync(parent, { recursive: true });
    root = makeRoot(parent, installElectron);
    nodeFs.writeFileSync(nodePath.join(root, 'app-1.0.0', 'resources', 'cli-bundle', 'probe.cjs'), PROBE);
    bare = makeRoot(parent, installElectron, false);
  }, 120_000);
  afterAll(() => {
    for (const dir of [root, bare]) if (dir) nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows Korean intact on stdout and stderr with nothing redirected', async () => {
    const err = await run(root, ON_STDERR);
    expect(err.exitCode).toBe(1);
    expect(err.screen).toContain(STDERR_LINE);
    const out = await run(root, ON_STDOUT);
    expect(out.exitCode).toBe(1);
    expect(out.screen).toContain(STDOUT_ERROR);
  }, 60_000);

  it('keeps stderr on the console when stdout goes to a file, a pipe or NUL', async () => {
    const toFile = await run(root, ON_STDERR, '>FILE');
    expect(toFile.exitCode).toBe(1);
    expect(toFile.screen).toContain(STDERR_LINE);
    expect(toFile.file).toBe('');
    // The redirect itself still gets stdout, as UTF-8, and nothing of it reaches the console.
    const json = await run(root, ON_STDOUT, '>FILE');
    expect(json.screen).not.toContain('unknown subcommand');
    expect(json.file).toContain(STDOUT_ERROR);
    expect((await run(root, ON_STDERR, '| more')).screen).toContain(STDERR_LINE);
    expect((await run(root, ON_STDERR, '>nul')).screen).toContain(STDERR_LINE);
    expect((await run(root, ON_STDOUT, '>nul')).screen).not.toContain('unknown subcommand');
  }, 60_000);

  it('keeps stdout on the console when stderr goes to a file', async () => {
    const out = await run(root, ON_STDOUT, '2>FILE');
    expect(out.exitCode).toBe(1);
    expect(out.screen).toContain(STDOUT_ERROR);
    const err = await run(root, ON_STDERR, '2>FILE');
    expect(err.screen).not.toContain('Unknown command');
    expect(err.file).toContain(STDERR_LINE);
  }, 60_000);

  it('does not attach to the console when ELECTRON_NO_ATTACH_CONSOLE is set', async () => {
    const noAttach = { ELECTRON_NO_ATTACH_CONSOLE: '1' };
    // Electron attached on its own: the streams are still put right.
    expect((await run(root, ON_STDERR, '', noAttach)).screen).toContain(STDERR_LINE);
    // Nothing attached: stderr stays where it was handed over, nowhere.
    const redirected = await run(root, ON_STDERR, '>FILE', noAttach);
    expect(redirected.exitCode).toBe(1);
    expect(redirected.screen).not.toContain('Unknown command');
  }, 60_000);

  it('keeps today\'s streams without koffi, and says why under WMUX_DEBUG', async () => {
    // Nothing redirected: Node's own TTY streams need no route.
    const bareTty = await run(bare, ON_STDERR);
    expect(bareTty.screen).toContain(STDERR_LINE);
    expect(bareTty.screen).not.toContain('koffi');
    // stderr to a file, so stdout arrives as no handle: only the route could show it.
    const quiet = await run(bare, ON_STDOUT, '2>FILE');
    expect(quiet.exitCode).toBe(1);
    expect(quiet.screen).not.toContain('unknown subcommand');
    expect(quiet.file).not.toContain('koffi');
    const debug = await run(bare, ON_STDOUT, '2>FILE', { WMUX_DEBUG: '1' });
    expect(debug.file).toContain('wmux: console output is not rerouted, koffi did not load');
  }, 60_000);

  describe('routed streams behave as Node\'s own stdio', () => {
    const probe = (redirect: string) => {
      const app = nodePath.join(root, 'app-1.0.0');
      const facts = nodePath.join(root, 'facts.json');
      nodeFs.rmSync(facts, { force: true });
      return runLine(root, `"${nodePath.join(app, 'wmux.exe')}" "${nodePath.join(app, 'resources', 'cli-bundle', 'probe.cjs')}" "${facts}" ${redirect}`, { ELECTRON_RUN_AS_NODE: '1' })
        .then((r) => ({ ...r, facts: JSON.parse(nodeFs.readFileSync(facts, 'utf8')) as Record<string, unknown> }));
    };

    it('survive an error, end(), destroy() and a pipe, and let the process end on its own', async () => {
      // stdout to a file, so stderr arrived as no handle and is the routed one.
      const r = await probe('>FILE');
      expect(r.facts.isStdio).toEqual([true, true]);
      expect(r.facts.isTTY).toEqual([false, true]);
      // An 'error' with no listener of the caller's would have thrown before this line was written.
      expect(r.screen).toContain('AFTER ERROR 한글');
      expect(r.facts.fdOpenAfterEnd).toBe(true);
      expect(r.screen).toContain('PIPED 한글');
      expect(r.screen).toContain('AFTER PIPE 한글');
      expect(r.exitCode).toBe(0);
    }, 60_000);

    it('hand a child the console the process writes to, not the fds it was given', async () => {
      // stdout to a file, so stderr arrived as no handle: 'inherit' would lose the child's stderr.
      // (A GUI-subsystem child, like the daemon, gets no console handle from Windows next to a redirected one.)
      const r = await probe('>FILE');
      expect(r.exitCode).toBe(0);
      expect(r.screen).toContain('CHILD ERR');
      expect(r.file).toContain('CHILD OUT');
    }, 60_000);
  });
});
