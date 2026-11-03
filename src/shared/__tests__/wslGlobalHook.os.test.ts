// The global WSL hook script (shared/wslGlobalHook.ts) run by a real `sh` in a
// temp dir, with stubs for wslpath, tmux and the wmux runtime: its guards,
// what it hands the bridge, and that it never fails claude. Skipped where no
// `sh` is on PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  refreshWslHookAtBoot,
  writeWslHookScript,
  writeWslRuntimePointer,
  wslGlobalHookScript,
  WSL_GLOBAL_HOOK_SCRIPT,
  WSL_RUNTIME_POINTER,
} from '../wslGlobalHook';

const hasSh = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** Forward slashes: MSYS sh takes `C:/x/y` (and `${0%/*}` needs a `/`). */
const posix = (p: string) => p.replace(/\\/g, '/');

interface Rig {
  dir: string;
  script: string;
  out: string;
  exe: string;
  bridge: string;
  binfmt: string;
  bin: string;
}

function rig(suffix = ''): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslhook-')); dirs.push(dir);
  const hooks = path.join(dir, 'hooks');
  const bin = path.join(dir, 'bin');
  const binfmt = path.join(dir, 'binfmt');
  for (const d of [hooks, bin, binfmt]) fs.mkdirSync(d);
  const out = path.join(dir, 'out.txt');
  const exe = path.join(dir, 'fake-wmux');
  const bridge = path.join(dir, 'bridge.mjs');
  fs.writeFileSync(exe, `#!/bin/sh
{
  printf 'ARGS=%s\\n' "$*"
  printf 'BRIDGE_ARG=%s\\n' "$1"
  printf 'WSLENV=%s\\n' "$WSLENV"
  printf 'ERAN=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"
  printf 'TARGET=%s\\n' "\${WMUX_TMUX_TARGET-unset}"
  printf 'SUFFIX=%s\\n' "\${WMUX_DATA_SUFFIX-unset}"
  printf 'STDIN=%s\\n' "$(cat)"
} > '${posix(out)}'
echo bridge-stdout
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(bridge, '// bridge\n');
  // wslpath -u <p> → <p>: the stub paths are already what this sh can open.
  fs.writeFileSync(path.join(bin, 'wslpath'), '#!/bin/sh\n[ "$1" = -u ] && shift\nprintf \'%s\\n\' "$1"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nprintf \'%s\\n\' "${FAKE_TMUX:-work:2}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binfmt, 'WSLInterop'), 'enabled\ninterpreter /init\n');
  const script = path.join(hooks, WSL_GLOBAL_HOOK_SCRIPT);
  fs.writeFileSync(script, wslGlobalHookScript(suffix, { binfmtDir: posix(binfmt) }), { mode: 0o755 });
  // CRLF on purpose: a pointer edited by a Windows tool still works.
  fs.writeFileSync(path.join(hooks, WSL_RUNTIME_POINTER), `${posix(exe)}\r\n${posix(bridge)}\r\n`);
  return { dir, script, out, exe, bridge, binfmt, bin };
}

function run(r: Rig, args: string[], env: Record<string, string> = {}, input = '{"cwd":"/home/dev/app"}') {
  const result = spawnSync('sh', [posix(r.script), ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: `${r.bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...env,
    },
  });
  const ran = fs.existsSync(r.out);
  const fields: Record<string, string> = {};
  if (ran) {
    for (const line of fs.readFileSync(r.out, 'utf8').split('\n')) {
      const cut = line.indexOf('=');
      if (cut > 0) fields[line.slice(0, cut)] = line.slice(cut + 1);
    }
    fs.rmSync(r.out);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ran, fields };
}

describe.skipIf(!hasSh)('global WSL hook script', () => {
  it('runs the bridge in node mode with the tmux target and only the env that is set', () => {
    const r = rig();
    const got = run(r, ['SessionStart'], { WSL_DISTRO_NAME: 'Ubuntu', TMUX: '/tmp/tmux-1000/default,9,0', TMUX_PANE: '%1' });
    expect(got.status).toBe(0);
    expect(got.ran).toBe(true);
    expect(got.fields.ARGS).toBe(`${posix(r.bridge)} SessionStart`);
    expect(got.fields.ERAN).toBe('1');
    expect(got.fields.TARGET).toBe('work:2');
    expect(got.fields.SUFFIX).toBe('unset');
    expect(got.fields.STDIN).toBe('{"cwd":"/home/dev/app"}');
    expect(got.fields.WSLENV.split(':')).toEqual([
      'ELECTRON_RUN_AS_NODE/w', 'WSL_DISTRO_NAME/w', 'TMUX/w', 'TMUX_PANE/w', 'WMUX_TMUX_TARGET/w',
    ]);
    // The bridge's own answer (a permission decision) still reaches claude.
    expect(got.stdout).toBe('bridge-stdout\n');
  });

  it('keeps the caller\'s WSLENV and lists STY / the entrypoint only when set', () => {
    const r = rig();
    const got = run(r, ['Stop'], { WSLENV: 'USERPROFILE/p', STY: '42.build', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(got.fields.WSLENV.split(':')).toEqual(['USERPROFILE/p', 'ELECTRON_RUN_AS_NODE/w', 'STY/w', 'CLAUDE_CODE_ENTRYPOINT/w']);
  });

  it('asks tmux only at a session or turn start, and drops an inherited target', () => {
    const r = rig();
    const got = run(r, ['Stop'], { TMUX: 'x', TMUX_PANE: '%1', WMUX_TMUX_TARGET: 'stale:9' });
    expect(got.fields.TARGET).toBe('unset');
    expect(got.fields.WSLENV).not.toContain('WMUX_TMUX_TARGET');
    const turn = run(r, ['UserPromptSubmit'], { TMUX: 'x', FAKE_TMUX: 'api:dev:3' });
    expect(turn.fields.TARGET).toBe('api:dev:3');
  });

  it('a suffixed instance\'s script sets its suffix itself and lists it', () => {
    const r = rig('-wslhook');
    const got = run(r, ['Stop']);
    expect(got.fields.SUFFIX).toBe('-wslhook');
    expect(got.fields.WSLENV.split(':')).toContain('WMUX_DATA_SUFFIX/w');
  });

  it('a production script never lists WMUX_DATA_SUFFIX, even when Linux has one', () => {
    const r = rig();
    const got = run(r, ['Stop'], { WMUX_DATA_SUFFIX: '-other' });
    expect(got.fields.WSLENV).not.toContain('WMUX_DATA_SUFFIX');
  });

  it('exits 0 at once inside a wmux pane (WMUX_WSL_HOOK set)', () => {
    const r = rig();
    const got = run(r, ['SessionStart'], { WMUX_WSL_HOOK: '/mnt/c/x/hook.sh' });
    expect(got).toMatchObject({ status: 0, ran: false, stdout: '' });
  });

  it('exits 0 when interop is off or unknown; WSLInterop-late counts', () => {
    const r = rig();
    fs.writeFileSync(path.join(r.binfmt, 'WSLInterop'), 'disabled\n');
    expect(run(r, ['Stop'])).toMatchObject({ status: 0, ran: false, stdout: '' });
    fs.rmSync(path.join(r.binfmt, 'WSLInterop'));
    expect(run(r, ['Stop'])).toMatchObject({ status: 0, ran: false, stdout: '' });
    fs.writeFileSync(path.join(r.binfmt, 'WSLInterop-late'), 'enabled\n');
    expect(run(r, ['Stop']).ran).toBe(true);
  });

  it('exits 0 with no pointer, an empty one, or a runtime / bridge that is not there', () => {
    const r = rig();
    const pointer = path.join(path.dirname(r.script), WSL_RUNTIME_POINTER);
    const quiet = { status: 0, ran: false, stdout: '' };
    fs.rmSync(pointer);
    expect(run(r, ['Stop'])).toMatchObject(quiet);
    fs.writeFileSync(pointer, '');
    expect(run(r, ['Stop'])).toMatchObject(quiet);
    fs.writeFileSync(pointer, `${posix(r.exe)}-gone\n${posix(r.bridge)}\n`);
    expect(run(r, ['Stop'])).toMatchObject(quiet);
    fs.writeFileSync(pointer, `${posix(r.exe)}\n${posix(r.bridge)}-gone\n`);
    expect(run(r, ['Stop'])).toMatchObject(quiet);
  });

  it('exits 0 when the runtime is not executable', () => {
    const r = rig();
    // No shebang and no x bit: not executable under Linux or MSYS.
    fs.writeFileSync(r.exe, 'not a program\n', { mode: 0o644 });
    fs.chmodSync(r.exe, 0o644);
    expect(run(r, ['Stop'])).toMatchObject({ status: 0, ran: false, stdout: '' });
  });

  it('exits 0 without wslpath, and when the bridge fails', () => {
    const r = rig();
    expect(run(r, ['Stop'], { FAKE_EXIT: '3' })).toMatchObject({ status: 0, ran: true });
    fs.rmSync(path.join(r.bin, 'wslpath'));
    // Keep only the stub dir and the shell's own tools on PATH.
    const result = spawnSync('sh', ['-c', 'command -v wslpath >/dev/null 2>&1 && echo has || echo none'], { encoding: 'utf8', windowsHide: true });
    if (result.stdout.trim() === 'none') expect(run(r, ['Stop'])).toMatchObject({ status: 0, ran: false, stdout: '' });
  });

  it('refuses a suffix it cannot carry verbatim', () => {
    expect(() => wslGlobalHookScript("-a'b")).toThrow();
    expect(() => wslGlobalHookScript('-a b')).toThrow();
  });
});

describe('WSL runtime pointer', () => {
  it('writes runtime and bridge atomically, once, and rewrites on change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslptr-')); dirs.push(dir);
    const hooks = path.join(dir, 'hooks');
    expect(writeWslRuntimePointer(hooks, 'C:\\a\\wmux.exe', 'C:\\a\\bridge.mjs')).toBe(true);
    expect(fs.readFileSync(path.join(hooks, WSL_RUNTIME_POINTER), 'utf8')).toBe('C:\\a\\wmux.exe\nC:\\a\\bridge.mjs\n');
    expect(writeWslRuntimePointer(hooks, 'C:\\a\\wmux.exe', 'C:\\a\\bridge.mjs')).toBe(false);
    expect(writeWslRuntimePointer(hooks, 'C:\\b\\wmux.exe', 'C:\\b\\bridge.mjs')).toBe(true);
    expect(fs.readdirSync(hooks)).toEqual([WSL_RUNTIME_POINTER]);
    expect(() => writeWslRuntimePointer(hooks, 'C:\\a\nb', 'x')).toThrow();
  });

  it('at boot: production and suffixed instances write into the dir they are given; an unsuffixed dev run and non-Windows never write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslptr-')); dirs.push(dir);
    const prod = path.join(dir, '.wmux', 'hooks');
    const isolated = path.join(dir, '.wmux-wslhook', 'hooks');
    const base = { runtimePath: 'C:\\app\\wmux.exe', bridgePath: 'C:\\app\\bridge.mjs' };
    const boot = (patch: Partial<Parameters<typeof refreshWslHookAtBoot>[0]>) =>
      refreshWslHookAtBoot({ ...base, platform: 'win32', isPackaged: true, suffix: '', hooksDir: prod, ...patch });
    expect(boot({ isPackaged: false })).toEqual({ pointer: 'skipped', script: 'skipped' });
    expect(boot({ platform: 'darwin' })).toEqual({ pointer: 'skipped', script: 'skipped' });
    expect(fs.existsSync(prod)).toBe(false);
    expect(boot({ isPackaged: false, suffix: '-wslhook', hooksDir: isolated }).pointer).toBe('written');
    expect(fs.existsSync(prod)).toBe(false);
    // Never opted in: the pointer only, no script appears.
    expect(boot({})).toEqual({ pointer: 'written', script: 'not-installed' });
    expect(fs.existsSync(path.join(prod, WSL_GLOBAL_HOOK_SCRIPT))).toBe(false);
    expect(boot({})).toEqual({ pointer: 'up-to-date', script: 'not-installed' });
    expect(boot({ bridgePath: null }).pointer).toBe('no-bridge');
  });

  it('at boot: an installed script from an older build is brought up to this one, in its own suffix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslptr-')); dirs.push(dir);
    const isolated = path.join(dir, '.wmux-wslhook', 'hooks');
    const script = writeWslHookScript(isolated, '-wslhook');
    fs.writeFileSync(script, '#!/bin/sh\n# an older build\nexit 0\n');
    const base = { platform: 'win32', isPackaged: false, suffix: '-wslhook', hooksDir: isolated, runtimePath: 'C:\\a.exe', bridgePath: 'C:\\b.mjs' };
    expect(refreshWslHookAtBoot(base).script).toBe('refreshed');
    expect(fs.readFileSync(script, 'utf8')).toBe(wslGlobalHookScript('-wslhook'));
    expect(refreshWslHookAtBoot(base).script).toBe('up-to-date');
    expect(fs.readdirSync(isolated).sort()).toEqual([WSL_GLOBAL_HOOK_SCRIPT, WSL_RUNTIME_POINTER].sort());
  });
});
