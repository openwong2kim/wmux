/**
 * shell.handler — `detect-apps` / `open-with` ("Open with…" submenu).
 *
 * Two things are pinned here.
 *
 * Detection must stay cheap: it probes one launcher per candidate editor every
 * time a workspace context menu opens. Doing that with execFileSync would block
 * the main process event loop for the sum of every probe (seconds when AV
 * intercepts process creation), stalling PTY pumping and every other IPC
 * channel.
 *
 * Launching must actually work: since the CVE-2024-27980 hardening, Node throws
 * EINVAL on `spawn('code.cmd')`, and CreateProcess never walks PATHEXT for a
 * bare name. So the handler has to keep the absolute path where.exe reported and
 * route batch shims through cmd.exe — with quoting that survives folder names
 * containing spaces and cmd metacharacters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
    app: { isPackaged: false, getAppMetrics: () => [] },
    __handlers: handlers,
  };
});

vi.mock('../../../../shared/ShellDetector', () => ({
  ShellDetector: class {
    detect() {
      return Promise.resolve([]);
    }
  },
}));

// execFile is captured so we can inspect how many probes were issued and when
// their callbacks run. Callbacks are held until the test releases them, which is
// what makes the "issued in parallel" assertion meaningful.
type Probe = { file: string; args: string[]; done: (err: Error | null, stdout?: string) => void };
const execFileCalls: Probe[] = [];

type SpawnCall = { file: string; args: string[]; opts: Record<string, unknown> };
const spawnCalls: SpawnCall[] = [];
// What the next spawn() should do: emit 'spawn', emit 'error', or throw.
let spawnOutcome: { kind: 'spawn' } | { kind: 'error'; message: string } | { kind: 'throw'; message: string } =
  { kind: 'spawn' };

vi.mock('child_process', () => ({
  execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
    execFileCalls.push({ file, args, done: cb });
    return {};
  }),
  spawn: vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ file, args, opts });
    if (spawnOutcome.kind === 'throw') throw new Error(spawnOutcome.message);
    const listeners = new Map<string, (arg?: unknown) => void>();
    const child = {
      once: (evt: string, fn: (arg?: unknown) => void) => {
        listeners.set(evt, fn);
        return child;
      },
      unref: vi.fn(),
    };
    // Fire on the next turn so the handler has both listeners attached.
    queueMicrotask(() => {
      if (spawnOutcome.kind === 'spawn') listeners.get('spawn')?.();
      else listeners.get('error')?.(new Error(spawnOutcome.message));
    });
    return child;
  }),
}));

// Bundle presence on macOS is checked with fs.access rather than a subprocess,
// so the darwin tests drive this set instead of the execFile queue.
const presentPaths = new Set<string>();
vi.mock('fs/promises', () => ({
  access: vi.fn((p: string) => (presentPaths.has(p)
    ? Promise.resolve()
    : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))),
}));

vi.mock('os', () => ({
  homedir: () => '/Users/me',
}));

import * as electron from 'electron';
import { registerShellHandlers } from '../shell.handler';
import { IPC } from '../../../../shared/constants';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({} as unknown, payload) as Promise<T>;
}

const detectApps = () => invoke<{ id: string; name: string }[]>(IPC.SHELL_DETECT_APPS);
const openWith = (appId: string, folderPath: string) =>
  invoke<{ ok: boolean; error?: string }>(IPC.SHELL_OPEN_WITH, { appId, folderPath });

/** Answer every outstanding probe; `found` maps a probe name to its resolved path. */
function resolveProbes(found: Record<string, string>): void {
  for (const call of execFileCalls.splice(0)) {
    const hit = found[call.args[0]];
    if (hit) call.done(null, `${hit}\r\n`);
    else call.done(new Error('not found'));
  }
}

/** Swap process.platform for one test; restored in afterEach. */
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const REAL_PLATFORM = process.platform;
const CODE_CMD = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd';
const WT_EXE = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

describe('shell.handler "Open with"', () => {
  let dispose: () => void;

  beforeEach(() => {
    execFileCalls.length = 0;
    spawnCalls.length = 0;
    presentPaths.clear();
    spawnOutcome = { kind: 'spawn' };
    dispose = registerShellHandlers();
  });

  afterEach(() => {
    dispose();
    setPlatform(REAL_PLATFORM);
  });

  describe('detection', () => {
    it('never uses a synchronous child_process call on the detection path', () => {
      // execFileSync blocks the event loop until the spawned process exits; with
      // one probe per candidate editor that is the whole main process frozen for
      // as long as the context menu takes to open.
      const src = fs.readFileSync(nodePath.join(__dirname, '..', 'shell.handler.ts'), 'utf8');
      // Matches call sites only, so a comment explaining why the sync variant
      // was dropped does not trip the guard.
      expect(src).not.toMatch(/\b(execFileSync|execSync|spawnSync)\s*\(/);
    });

    it('issues every Windows probe before any of them resolves', async () => {
      setPlatform('win32');
      const pending = detectApps();

      // All probes were fired in one batch — none of the callbacks has run yet,
      // so a serialized implementation would show exactly 1 here.
      expect(execFileCalls.length).toBeGreaterThan(1);
      const issued = execFileCalls.length;

      resolveProbes({});
      const apps = await pending;
      // Nothing else was queued afterwards: the fan-out was one round, not a chain.
      expect(execFileCalls).toHaveLength(0);
      expect(issued).toBeGreaterThan(1);
      expect(apps.map(a => a.id)).toEqual(['explorer']);
    });

    it('probes with an absolute where.exe path, never a PATH-resolved name', async () => {
      setPlatform('win32');
      const pending = detectApps();
      for (const call of execFileCalls) {
        expect(nodePath.win32.isAbsolute(call.file)).toBe(true);
        expect(call.file.toLowerCase()).toContain('where.exe');
      }
      resolveProbes({});
      await pending;
    });

    it('reports the launchers whose probe succeeded, Explorer first', async () => {
      setPlatform('win32');
      const pending = detectApps();
      resolveProbes({ 'code.cmd': CODE_CMD, wt: WT_EXE });
      const apps = await pending;
      expect(apps.map(a => a.id)).toEqual(['explorer', 'code', 'wt']);
    });

    it('does not leak resolved launcher paths to the renderer', async () => {
      setPlatform('win32');
      const pending = detectApps();
      resolveProbes({ 'code.cmd': CODE_CMD });
      const apps = await pending;
      expect(Object.keys(apps[1]).sort()).toEqual(['id', 'name']);
    });

    it('ignores a where.exe hit that is not an absolute path', async () => {
      setPlatform('win32');
      const pending = detectApps();
      // A relative or garbage line must not become a spawn target.
      for (const call of execFileCalls.splice(0)) call.done(null, 'code.cmd\r\n');
      const apps = await pending;
      expect(apps.map(a => a.id)).toEqual(['explorer']);
    });

    it('names the always-present entry after the platform file manager', async () => {
      setPlatform('win32');
      const win = detectApps();
      resolveProbes({});
      expect((await win)[0]).toEqual({ id: 'explorer', name: 'File Explorer' });

      setPlatform('darwin');
      expect((await detectApps())[0]).toEqual({ id: 'explorer', name: 'Finder' });

      setPlatform('linux');
      expect((await detectApps())[0]).toEqual({ id: 'explorer', name: 'File manager' });
    });

    it('returns the file manager alone on Linux without probing', async () => {
      setPlatform('linux');
      const apps = await detectApps();
      expect(apps.map(a => a.id)).toEqual(['explorer']);
      expect(execFileCalls).toHaveLength(0);
    });
  });

  describe('detection on macOS', () => {
    // PATH is unusable here: a GUI app launched from Finder or the Dock never
    // runs a login shell, so /usr/local/bin and /opt/homebrew/bin are absent and
    // probing PATH would report an empty machine. Detection is bundle presence.
    it('finds bundles in /Applications and spawns no probe at all', async () => {
      setPlatform('darwin');
      presentPaths.add('/Applications/Visual Studio Code.app');
      presentPaths.add('/Applications/iTerm.app');
      const apps = await detectApps();
      expect(apps.map(a => a.id)).toEqual(['explorer', 'code', 'iterm']);
      expect(execFileCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
    });

    it('also looks in the per-user ~/Applications', async () => {
      setPlatform('darwin');
      presentPaths.add('/Users/me/Applications/Cursor.app');
      const apps = await detectApps();
      expect(apps.map(a => a.id)).toEqual(['explorer', 'cursor']);
    });

    it('finds Terminal.app at its post-Catalina /System location', async () => {
      setPlatform('darwin');
      presentPaths.add('/System/Applications/Utilities/Terminal.app');
      const apps = await detectApps();
      expect(apps.map(a => a.id)).toEqual(['explorer', 'terminal']);
    });

    it('falls back to the pre-Catalina Terminal.app location', async () => {
      setPlatform('darwin');
      presentPaths.add('/Applications/Utilities/Terminal.app');
      const apps = await detectApps();
      expect(apps.map(a => a.id)).toEqual(['explorer', 'terminal']);
    });

    it('launches through `open -a <bundle>`, not the executable inside it', async () => {
      setPlatform('darwin');
      const bundle = '/Applications/Visual Studio Code.app';
      presentPaths.add(bundle);
      const folder = '/Users/me/my project & repo';
      const res = await openWith('code', folder);
      expect(res).toEqual({ ok: true });
      expect(spawnCalls).toHaveLength(1);
      const { file, args, opts } = spawnCalls[0];
      // LaunchServices reuses a running instance; spawning the inner Mach-O
      // directly would start a second copy of the editor.
      expect(file).toBe('/usr/bin/open');
      // Plain argv — no shell, so the space and the `&` need no escaping and
      // none of the Windows quoting rules apply.
      expect(args).toEqual(['-a', bundle, folder]);
      expect(opts.windowsVerbatimArguments).toBe(false);
      expect(opts.detached).toBe(true);
    });

    it('never routes through cmd.exe on macOS', async () => {
      setPlatform('darwin');
      presentPaths.add('/Applications/Cursor.app');
      await openWith('cursor', '/Users/me/repo');
      expect(spawnCalls[0].file.toLowerCase()).not.toContain('cmd.exe');
    });
  });

  describe('launching', () => {
    /** Run open-with for `appId`, answering the detection probes it triggers. */
    async function open(appId: string, folder: string, found: Record<string, string>) {
      setPlatform('win32');
      const pending = openWith(appId, folder);
      // openWith re-runs detection to find the entry; let those probes settle.
      await Promise.resolve();
      resolveProbes(found);
      return pending;
    }

    it('routes a .cmd shim through cmd.exe with every token quoted', async () => {
      const res = await open('code', 'D:\\my project\\a & b', { 'code.cmd': CODE_CMD });
      expect(res).toEqual({ ok: true });
      expect(spawnCalls).toHaveLength(1);
      const { file, args, opts } = spawnCalls[0];
      expect(file.toLowerCase()).toContain('cmd.exe');
      expect(nodePath.win32.isAbsolute(file)).toBe(true);
      // /d blocks the registry AutoRun command; /s fixes the quote-stripping rule.
      expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      // One outer quote pair, each token quoted inside it — that quoting is what
      // makes `&` literal instead of a command separator.
      expect(args[3]).toBe(`""${CODE_CMD}" "D:\\my project\\a & b""`);
      // Node must not re-escape the line we just built.
      expect(opts.windowsVerbatimArguments).toBe(true);
      expect(opts.detached).toBe(true);
      expect(opts.stdio).toBe('ignore');
    });

    it('spawns a real .exe directly, with no shell involved', async () => {
      const res = await open('wt', 'D:\\my project', { wt: WT_EXE });
      expect(res).toEqual({ ok: true });
      const { file, args, opts } = spawnCalls[0];
      expect(file).toBe(WT_EXE);
      // Per-app args are preserved and the folder is a plain argv entry.
      expect(args).toEqual(['-d', 'D:\\my project']);
      expect(opts.windowsVerbatimArguments).toBe(false);
    });

    it('refuses a path holding a quote instead of building a broken command line', async () => {
      // A double quote would close our quoting early; Windows paths cannot
      // contain one, so refusing is strictly better than escaping.
      const res = await open('code', 'D:\\a"b', { 'code.cmd': CODE_CMD });
      expect(res).toEqual({ ok: false, error: 'PATH_NOT_QUOTABLE' });
      expect(spawnCalls).toHaveLength(0);
    });

    it('refuses a path cmd.exe would rewrite through %-expansion', async () => {
      process.env.WMUX_TEST_EXPAND = 'x';
      try {
        const res = await open('code', 'D:\\%WMUX_TEST_EXPAND%\\repo', { 'code.cmd': CODE_CMD });
        expect(res).toEqual({ ok: false, error: 'PATH_HAS_ENV_SYNTAX:WMUX_TEST_EXPAND' });
        expect(spawnCalls).toHaveLength(0);
      } finally {
        delete process.env.WMUX_TEST_EXPAND;
      }
    });

    it('allows a lone % — it has no closing partner, so cmd leaves it alone', async () => {
      const res = await open('code', 'D:\\100%done', { 'code.cmd': CODE_CMD });
      expect(res).toEqual({ ok: true });
      expect(spawnCalls[0].args[3]).toContain('D:\\100%done');
    });

    it('allows %-syntax naming a variable that is not defined', async () => {
      delete process.env.WMUX_DEFINITELY_UNSET;
      const res = await open('code', 'D:\\%WMUX_DEFINITELY_UNSET%\\repo', { 'code.cmd': CODE_CMD });
      expect(res).toEqual({ ok: true });
    });

    it('reports the spawn error event rather than claiming success', async () => {
      spawnOutcome = { kind: 'error', message: 'EACCES' };
      const res = await open('wt', 'D:\\repo', { wt: WT_EXE });
      expect(res).toEqual({ ok: false, error: 'EACCES' });
    });

    it('reports a synchronous spawn throw', async () => {
      spawnOutcome = { kind: 'throw', message: 'spawn EINVAL' };
      const res = await open('code', 'D:\\repo', { 'code.cmd': CODE_CMD });
      expect(res).toEqual({ ok: false, error: 'spawn EINVAL' });
    });

    it('rejects an app id that detection did not report', async () => {
      await expect(open('notepad', 'D:\\repo', { 'code.cmd': CODE_CMD })).rejects.toThrow(/Unknown app/);
      expect(spawnCalls).toHaveLength(0);
    });

    it('rejects a relative folder path before any detection happens', async () => {
      setPlatform('win32');
      await expect(openWith('code', 'relative\\path')).rejects.toThrow(/absolute/);
      expect(execFileCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
    });

    it('judges absoluteness by the platform it runs as, not by the build host', async () => {
      // The handler branches on process.platform for batch dispatch and bundle
      // probing; if the path flavour came from the compile host instead, a drive
      // path would stop looking absolute the moment the same code ran on a POSIX
      // machine — which is exactly how these tests run on Linux CI.
      setPlatform('win32');
      const pending = openWith('code', 'D:\\repo');
      await Promise.resolve();
      resolveProbes({ 'code.cmd': CODE_CMD });
      await expect(pending).resolves.toEqual({ ok: true });

      // ...and a Windows drive path is not absolute for a macOS run.
      setPlatform('darwin');
      await expect(openWith('code', 'D:\\repo')).rejects.toThrow(/absolute/);
    });
  });
});
