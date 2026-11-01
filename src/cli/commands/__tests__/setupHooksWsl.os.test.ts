// `wmux setup-hooks --wsl`: the settings merge through a fake wsl.exe (no
// distro is ever started), and the in-distro read / write scripts run by a
// real `sh` against a temp HOME. Skips the sh part where no `sh` is on PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installWslHooks,
  parseWslArgs,
  spawnRunner,
  stripWslHooks,
  uninstallWslHooks,
  wslHookMarker,
  WSL_SETTINGS_READ_SCRIPT,
  WSL_SETTINGS_WRITE_SCRIPT,
  type WslRunner,
} from '../setupHooksWsl';
import { specsFor } from '../setupHooks';
import { WSL_GLOBAL_HOOK_SCRIPT, WSL_RUNTIME_POINTER } from '../../../shared/wslGlobalHook';

const hasSh = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const hasSha256sum = hasSh && spawnSync('sh', ['-c', 'command -v sha256sum'], { windowsHide: true }).status === 0;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslsettings-')); dirs.push(dir);
  return dir;
}

/** What `wslpath -u` makes of a Windows path (a POSIX host's path is already Linux). */
function fakeWslpath(p: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : p;
}

interface FakeDistro {
  files: Map<string, string>;
  calls: Array<{ kind: 'read' | 'write'; args: string[] }>;
  runner: WslRunner;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A distro whose files live in a Map; CLAUDE_CONFIG_DIR as Claude Code would see it. */
function fakeDistro(initial: Record<string, string> = {}, configDir?: string): FakeDistro {
  const files = new Map(Object.entries(initial));
  const calls: FakeDistro['calls'] = [];
  const runner: WslRunner = (args, input) => {
    const at = args.indexOf('-c');
    const script = args[at + 1];
    const positional = args.slice(at + 3);
    if (script === WSL_SETTINGS_READ_SCRIPT) {
      calls.push({ kind: 'read', args });
      const file = `${configDir ?? '/home/dev/.claude'}/settings.json`;
      const head = `${file}\0${fakeWslpath(positional[0])}\0`;
      const content = files.get(file);
      return { status: 0, stdout: content === undefined ? `${head}absent\0absent\0` : `${head}present\0${sha256(content)}\0${content}`, stderr: '' };
    }
    if (script === WSL_SETTINGS_WRITE_SCRIPT) {
      calls.push({ kind: 'write', args });
      // As the script does: refuse when the file is not what was read.
      const now = files.has(positional[0]) ? sha256(files.get(positional[0]) ?? '') : 'absent';
      if (now !== positional[1]) return { status: 7, stdout: '', stderr: '' };
      files.set(positional[0], input ?? '');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected script' };
  };
  return { files, calls, runner };
}

function hooksDirFor(root: string, suffix = ''): string {
  return path.join(root, `.wmux${suffix}`, 'hooks');
}

const SETTINGS = '/home/dev/.claude/settings.json';
const read = (d: FakeDistro, file = SETTINGS) => JSON.parse(d.files.get(file) ?? '{}');

describe('setup-hooks --wsl: settings merge', () => {
  it('installs the signals-only events, SessionEnd included, through the script\'s /mnt path, and writes the script', () => {
    const root = tempDir();
    const hooksDir = hooksDirFor(root);
    const distro = fakeDistro();
    const out = installWslHooks({ hooksDir, suffix: '', runner: distro.runner });
    expect(out).toMatchObject({ ok: true, changed: true, settingsPath: SETTINGS, error: null });
    const settings = read(distro);
    const wanted = specsFor('signals-only');
    expect(out.events).toEqual(wanted.map((s) => s.event));
    expect(out.events).toContain('SessionEnd');
    expect(out.events).not.toContain('PreToolUse --permission-gate');
    const script = fakeWslpath(path.join(hooksDir, WSL_GLOBAL_HOOK_SCRIPT));
    expect(settings.hooks.SessionEnd).toEqual([{ matcher: '', hooks: [{ type: 'command', command: `/bin/sh '${script}' SessionEnd`, timeout: 10 }] }]);
    // No wide gate: every PreToolUse entry is scoped to AskUserQuestion.
    expect(settings.hooks.PreToolUse.map((g: { matcher: string }) => g.matcher)).toEqual(['AskUserQuestion']);
    expect(fs.readFileSync(path.join(hooksDir, WSL_GLOBAL_HOOK_SCRIPT), 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    // No runtime recorded yet: the install says so.
    expect(out.warning).toMatch(/start wmux once/);
  });

  it('quotes a script path with spaces and quotes so sh reads it as one word', () => {
    const root = path.join(tempDir(), "it's a dir");
    const distro = fakeDistro();
    installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
    const command: string = read(distro).hooks.Stop[0].hooks[0].command;
    expect(command).toMatch(/^\/bin\/sh '.*it'\\''s a dir\/\.wmux\/hooks\/wmux-wsl-hook\.sh' Stop$/);
  });

  it('keeps the user\'s keys and hooks, including a leaf sharing a group with ours', () => {
    const root = tempDir();
    const hooksDir = hooksDirFor(root);
    const ours = `/bin/sh '${fakeWslpath(path.join(hooksDir, WSL_GLOBAL_HOOK_SCRIPT))}' Stop`;
    const distro = fakeDistro({
      [SETTINGS]: JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] },
            { matcher: '', hooks: [{ type: 'command', command: ours }, { type: 'command', command: 'echo mine' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        },
      }),
    });
    expect(installWslHooks({ hooksDir, suffix: '', runner: distro.runner }).ok).toBe(true);
    const settings = read(distro);
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] },
      { matcher: '', hooks: [{ type: 'command', command: ours, timeout: 10 }] },
    ]);
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] });
  });

  it('a re-run is idempotent: one read, no write, same file', () => {
    const root = tempDir();
    const hooksDir = hooksDirFor(root);
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, WSL_RUNTIME_POINTER), 'C:\\a\\wmux.exe\nC:\\a\\bridge.mjs\n');
    const distro = fakeDistro({ [SETTINGS]: '{"theme":"dark"}' });
    expect(installWslHooks({ hooksDir, suffix: '', runner: distro.runner })).toMatchObject({ ok: true, changed: true, warning: null });
    const first = distro.files.get(SETTINGS);
    distro.calls.length = 0;
    expect(installWslHooks({ hooksDir, suffix: '', runner: distro.runner })).toMatchObject({ ok: true, changed: false });
    expect(distro.calls.map((c) => c.kind)).toEqual(['read']);
    expect(distro.files.get(SETTINGS)).toBe(first);
  });

  it('a re-run leaves ours where they are when the user added entries after them', () => {
    const root = tempDir();
    const hooksDir = hooksDirFor(root);
    const distro = fakeDistro();
    installWslHooks({ hooksDir, suffix: '', runner: distro.runner });
    const settings = read(distro);
    settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'echo later' }] });
    distro.files.set(SETTINGS, JSON.stringify(settings));
    distro.calls.length = 0;
    expect(installWslHooks({ hooksDir, suffix: '', runner: distro.runner })).toMatchObject({ ok: true, changed: false });
    expect(distro.calls.map((c) => c.kind)).toEqual(['read']);
    // A changed entry (an older timeout) is rewritten.
    settings.hooks.Stop[0].hooks[0].timeout = 5;
    distro.files.set(SETTINGS, JSON.stringify(settings));
    expect(installWslHooks({ hooksDir, suffix: '', runner: distro.runner })).toMatchObject({ ok: true, changed: true });
    expect(read(distro).hooks.Stop.map((g: { hooks: Array<{ command: string; timeout?: number }> }) => g.hooks[0].timeout ?? null)).toEqual([null, 10]);
  });

  it('uninstall removes only our entries and leaves the user\'s, the keys and the script', () => {
    const root = tempDir();
    const hooksDir = hooksDirFor(root);
    const distro = fakeDistro({
      [SETTINGS]: JSON.stringify({ env: { A: '1' }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] }] } }),
    });
    installWslHooks({ hooksDir, suffix: '', runner: distro.runner });
    const out = uninstallWslHooks({ hooksDir, suffix: '', runner: distro.runner });
    expect(out).toMatchObject({ ok: true, changed: true, removed: specsFor('signals-only').length });
    expect(read(distro)).toEqual({ env: { A: '1' }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] }] } });
    expect(fs.existsSync(path.join(hooksDir, WSL_GLOBAL_HOOK_SCRIPT))).toBe(true);
    distro.calls.length = 0;
    expect(uninstallWslHooks({ hooksDir, suffix: '', runner: distro.runner })).toMatchObject({ ok: true, changed: false, removed: 0 });
    expect(distro.calls.map((c) => c.kind)).toEqual(['read']);
  });

  it('an isolated instance\'s entries and the production ones never touch each other', () => {
    const root = tempDir();
    const distro = fakeDistro();
    installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
    const production = distro.files.get(SETTINGS);
    installWslHooks({ hooksDir: hooksDirFor(root, '-wslhook'), suffix: '-wslhook', runner: distro.runner });
    const both = read(distro);
    expect(both.hooks.Stop).toHaveLength(2);
    expect(fs.readFileSync(path.join(hooksDirFor(root, '-wslhook'), WSL_GLOBAL_HOOK_SCRIPT), 'utf8')).toContain("WMUX_DATA_SUFFIX='-wslhook'");
    expect(fs.readFileSync(path.join(hooksDirFor(root), WSL_GLOBAL_HOOK_SCRIPT), 'utf8')).not.toContain('WMUX_DATA_SUFFIX=');
    uninstallWslHooks({ hooksDir: hooksDirFor(root, '-wslhook'), suffix: '-wslhook', runner: distro.runner });
    expect(distro.files.get(SETTINGS)).toBe(production);
    expect(wslHookMarker('')).toBe('/.wmux/hooks/wmux-wsl-hook.sh');
    expect(wslHookMarker('-x').includes(wslHookMarker(''))).toBe(false);
  });

  it('writes into $CLAUDE_CONFIG_DIR/settings.json when the distro resolves it there', () => {
    const root = tempDir();
    const distro = fakeDistro({}, '/tmp/wmux-wslhook-test');
    const out = installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
    expect(out.settingsPath).toBe('/tmp/wmux-wslhook-test/settings.json');
    expect([...distro.files.keys()]).toEqual(['/tmp/wmux-wslhook-test/settings.json']);
  });

  it('names the distro first on every wsl.exe call, and refuses a bad name before any call', () => {
    const root = tempDir();
    const distro = fakeDistro();
    installWslHooks({ distro: 'Ubuntu-24.04', hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
    expect(distro.calls.map((c) => c.args.slice(0, 5))).toEqual([
      ['-d', 'Ubuntu-24.04', '--exec', '/bin/sh', '-c'],
      ['-d', 'Ubuntu-24.04', '--exec', '/bin/sh', '-c'],
    ]);
    const none = fakeDistro();
    expect(installWslHooks({ distro: '--exec', hooksDir: hooksDirFor(root), suffix: '', runner: none.runner }).ok).toBe(false);
    expect(installWslHooks({ hooksDir: hooksDirFor(root), suffix: "-'", runner: none.runner }).ok).toBe(false);
    expect(none.calls).toEqual([]);
  });

  it('a settings file that is not JSON is never overwritten', () => {
    const root = tempDir();
    const distro = fakeDistro({ [SETTINGS]: '{ broken' });
    const out = installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not valid JSON/);
    expect(distro.calls.map((c) => c.kind)).toEqual(['read']);
    expect(uninstallWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner }).ok).toBe(false);
    expect(distro.files.get(SETTINGS)).toBe('{ broken');
  });

  it('a hooks value that is not an object, or an event that is not a list, is refused, not dropped', () => {
    const root = tempDir();
    for (const bad of ['{"hooks":[]}', '{"hooks":{"Stop":{"command":"mine"}}}']) {
      const distro = fakeDistro({ [SETTINGS]: bad });
      const out = installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/aborting to avoid dropping it/);
      expect(uninstallWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: distro.runner }).ok).toBe(false);
      expect(distro.files.get(SETTINGS)).toBe(bad);
      expect(distro.calls.map((c) => c.kind)).toEqual(['read', 'read']);
    }
  });

  it('a file claude saved between the read and the write is not overwritten', () => {
    const root = tempDir();
    const distro = fakeDistro({ [SETTINGS]: '{"theme":"dark"}' });
    const racing: WslRunner = (args, input) => {
      // claude saves a setting just before wmux writes.
      if (args.includes(WSL_SETTINGS_WRITE_SCRIPT)) distro.files.set(SETTINGS, '{"theme":"dark","permissions":{"allow":["Bash(ls)"]}}');
      return distro.runner(args, input);
    };
    const out = installWslHooks({ hooksDir: hooksDirFor(root), suffix: '', runner: racing });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/changed while wmux was updating it/);
    expect(read(distro)).toEqual({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } });
  });

  it('a failed wsl.exe call is reported, not written past', () => {
    const root = tempDir();
    const out = installWslHooks({
      hooksDir: hooksDirFor(root), suffix: '',
      runner: () => ({ status: 1, stdout: '', stderr: 'There is no distribution with the supplied name.' }),
    });
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch(/no distribution/);
  });

  it('strip leaves nothing empty behind', () => {
    const marker = wslHookMarker('');
    const settings: Record<string, unknown> = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `/bin/sh '/mnt/c/u${marker}' Stop` }] }] } };
    expect(stripWslHooks(settings, marker)).toBe(1);
    expect(settings).toEqual({});
  });
});

describe('setup-hooks --wsl: arguments', () => {
  it('takes an optional distro right after --wsl and --uninstall (or --remove)', () => {
    expect(parseWslArgs(['--wsl'])).toEqual({ uninstall: false });
    expect(parseWslArgs(['--wsl', 'Ubuntu'])).toEqual({ distro: 'Ubuntu', uninstall: false });
    expect(parseWslArgs(['--wsl', 'Ubuntu', '--uninstall'])).toEqual({ distro: 'Ubuntu', uninstall: true });
    expect(parseWslArgs(['--uninstall', '--wsl'])).toEqual({ uninstall: true });
    expect(parseWslArgs(['--wsl', '--remove'])).toEqual({ uninstall: true });
  });

  it('refuses anything else rather than installing', () => {
    expect(parseWslArgs(['--wsl', 'Ubuntu', 'Debian'])).toHaveProperty('usage');
    expect(parseWslArgs(['--wsl', '--status'])).toHaveProperty('usage');
    expect(parseWslArgs(['--wsl', '--signals-only'])).toHaveProperty('usage');
  });
});

describe.skipIf(!hasSh)('setup-hooks --wsl: the in-distro scripts under a real sh', () => {
  const posix = (p: string) => p.replace(/\\/g, '/');

  function sh(script: string, args: string[], env: Record<string, string>, input = '') {
    const bin = path.join(env.HOME, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // As wslpath -u does: `C:\x\y` → `/mnt/c/x/y`.
    fs.writeFileSync(path.join(bin, 'wslpath'), [
      '#!/bin/sh',
      '[ "$1" = -u ] && shift',
      'printf \'%s\\n\' "$1" | sed -e \'s#\\\\#/#g\' -e \'s#^[Cc]:#/mnt/c#\' -e \'s#^\\([A-Za-z]\\):#/mnt/\\1#\'',
      '',
    ].join('\n'), { mode: 0o755 });
    return spawnSync('sh', ['-c', script, 'wmux-test', ...args], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...env,
      },
    });
  }

  function parse(stdout: string) {
    const [file, script, state, hash, ...rest] = stdout.split('\0');
    return { file, script, state, hash, content: rest.join('\0') };
  }

  /** A stand-in for the user's interactive shell: prints what its startup files would export. */
  function fakeShell(home: string, dir: string): string {
    const file = path.join(home, 'fakeshell');
    fs.writeFileSync(file, `#!/bin/sh\necho banner from rc\nprintf '\\nWMUX_CLAUDE_CONFIG_DIR=%s\\n' '${dir}'\n`, { mode: 0o755 });
    return posix(file);
  }

  it('reads $CLAUDE_CONFIG_DIR/settings.json, ~ expanded, and hands back the script\'s Linux path', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, 'cfg'));
    fs.writeFileSync(path.join(home, 'cfg', 'settings.json'), '{"a":1}');
    const out = sh(WSL_SETTINGS_READ_SCRIPT, ['C:\\hooks\\wmux-wsl-hook.sh'], { HOME: posix(home), CLAUDE_CONFIG_DIR: '~/cfg' });
    expect(out.status).toBe(0);
    const got = parse(out.stdout);
    expect(got.file.endsWith('/cfg/settings.json')).toBe(true);
    expect(got.script).toBe('/mnt/c/hooks/wmux-wsl-hook.sh');
    expect(got.state).toBe('present');
    expect(got.hash).toBe(hasSha256sum ? sha256('{"a":1}') : 'nohash');
    expect(got.content).toBe('{"a":1}');
  });

  it('without it in the environment, asks the user\'s interactive shell, then falls back to ~/.claude', () => {
    const home = tempDir();
    const viaShell = sh(WSL_SETTINGS_READ_SCRIPT, ['C:\\x.sh'], { HOME: posix(home), SHELL: fakeShell(home, '/opt/claude-cfg') });
    expect(parse(viaShell.stdout)).toMatchObject({ file: '/opt/claude-cfg/settings.json', state: 'absent' });
    const fallback = sh(WSL_SETTINGS_READ_SCRIPT, ['C:\\x.sh'], { HOME: posix(home), SHELL: fakeShell(home, '') });
    const got = parse(fallback.stdout);
    expect(got.file.endsWith('/.claude/settings.json')).toBe(true);
    expect(got.state).toBe('absent');
  });

  it('refuses a relative CLAUDE_CONFIG_DIR', () => {
    const home = tempDir();
    const out = sh(WSL_SETTINGS_READ_SCRIPT, ['C:\\x.sh'], { HOME: posix(home), CLAUDE_CONFIG_DIR: 'relative/dir' });
    expect(out.status).toBe(5);
    expect(out.stdout).toBe('');
  });

  it('writes stdin over the file through a temp file, creating its folder, leaving no temp behind', () => {
    const home = tempDir();
    const file = path.join(home, 'new', 'settings.json');
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [posix(file), 'absent'], { HOME: posix(home) }, '{"b":2}\n').status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"b":2}\n');
    const was = hasSha256sum ? sha256('{"b":2}\n') : 'nohash';
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [posix(file), was], { HOME: posix(home) }, '{"b":3}\n').status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"b":3}\n');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('replaces nothing when the file is not what was read (exit 7), and leaves no temp behind', () => {
    const home = tempDir();
    const file = path.join(home, 'settings.json');
    fs.writeFileSync(file, '{"saved":"by claude"}');
    // Read as absent, but it exists now.
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [posix(file), 'absent'], { HOME: posix(home) }, '{}\n').status).toBe(7);
    if (hasSha256sum) {
      expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [posix(file), sha256('{"old":1}')], { HOME: posix(home) }, '{}\n').status).toBe(7);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('{"saved":"by claude"}');
    expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never makes the settings readable by others: a new file is owner-only, an existing one keeps its mode', () => {
    const home = tempDir();
    const fresh = path.join(home, 'fresh.json');
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [fresh, 'absent'], { HOME: home }, '{}\n').status).toBe(0);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
    const shared = path.join(home, 'shared.json');
    fs.writeFileSync(shared, '{}', { mode: 0o640 });
    fs.chmodSync(shared, 0o640);
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [shared, hasSha256sum ? sha256('{}') : 'nohash'], { HOME: home }, '{"x":1}\n').status).toBe(0);
    // GNU / busybox stat (every WSL distro) carries the mode over; BSD stat
    // (a macOS host) has no `-c %a`, and the file stays owner-only instead.
    const statC = spawnSync('sh', ['-c', 'stat -c %a / >/dev/null 2>&1'], { windowsHide: true }).status === 0;
    expect(fs.statSync(shared).mode & 0o777).toBe(statC ? 0o640 : 0o600);
  });

  it('the spawn runner hands stdin over as UTF-8 and reports the exit status', () => {
    const run = spawnRunner('sh');
    expect(run(['-c', 'cat'], '{"é":"✓"}\n')).toMatchObject({ status: 0, stdout: '{"é":"✓"}\n' });
    expect(run(['-c', 'exit 4'])).toMatchObject({ status: 4 });
  });

  it('a whole install and uninstall, both scripts under sh: the user entry and keys survive, a re-run writes nothing', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, 'cfg'));
    fs.writeFileSync(path.join(home, 'cfg', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'true user-hook' }] }] } }));
    sh('exit 0', [], { HOME: posix(home) }); // writes the wslpath stub
    const env = {
      HOME: posix(home), CLAUDE_CONFIG_DIR: '~/cfg',
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    };
    const writes: string[] = [];
    // wsl.exe's own arguments dropped: `-d <distro> --exec /bin/sh -c …` → `sh -c …`.
    const local: WslRunner = (args, input) => {
      const at = args.indexOf('-c');
      if (args[at + 1] === WSL_SETTINGS_WRITE_SCRIPT) writes.push(args[at + 3]);
      const out = spawnSync('sh', args.slice(at), { input: Buffer.from(input ?? '', 'utf8'), windowsHide: true, env });
      return { status: out.status, stdout: out.stdout.toString('utf8'), stderr: out.stderr.toString('utf8') };
    };
    const hooksDir = path.join(home, '.wmux', 'hooks');
    expect(installWslHooks({ distro: 'Ubuntu', hooksDir, suffix: '', runner: local })).toMatchObject({ ok: true, changed: true });
    expect(installWslHooks({ distro: 'Ubuntu', hooksDir, suffix: '', runner: local })).toMatchObject({ ok: true, changed: false });
    expect(writes).toHaveLength(1);
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'cfg', 'settings.json'), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop[0]).toEqual({ matcher: '', hooks: [{ type: 'command', command: 'true user-hook' }] });
    // The stub maps a drive path to /mnt/c/…; a POSIX host's temp path is already Linux.
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/^\/bin\/sh '\/.*\/\.wmux\/hooks\/wmux-wsl-hook\.sh' SessionEnd$/);
    expect(uninstallWslHooks({ distro: 'Ubuntu', hooksDir, suffix: '', runner: local })).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'cfg', 'settings.json'), 'utf8'))).toEqual({
      model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'true user-hook' }] }] },
    });
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings file, keeping the link', () => {
    const home = tempDir();
    const real = path.join(home, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, '{}');
    const link = path.join(home, 'settings.json');
    fs.symlinkSync(real, link);
    expect(sh(WSL_SETTINGS_WRITE_SCRIPT, [link, hasSha256sum ? sha256('{}') : 'nohash'], { HOME: home }, '{"c":1}\n').status).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"c":1}\n');
  });
});
