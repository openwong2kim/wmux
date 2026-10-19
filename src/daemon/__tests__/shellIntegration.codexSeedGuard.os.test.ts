/**
 * The `codex` function in the bash and zsh integrations (v12), run in REAL
 * shells against a fake `codex` that records its argv and its WMUX_* keys.
 *
 * Codex CLI 0.157+ starts one shared per-account background server the first
 * time a TUI runs; typed in a pane, that server inherited the pane's WMUX_*
 * keys and every later Codex thread on the account acted as that pane. The
 * function keeps interactive Codex in-process (`--no-daemon`, pane env kept),
 * leaves `exec`/`review` alone (they run in-process and the hooks bridge needs
 * WMUX_PTY_ID), and strips WMUX_* from everything else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASH_INIT, ZSH_RC } from '../shell-integration';
import { WSL_CODEX_SHIM } from '../../shared/wslIntegration';

const BASH = ['/bin/bash', '/usr/bin/bash'].find((b) => fs.existsSync(b));
const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((b) => fs.existsSync(b));
const posix = process.platform !== 'win32';

const FAKE_CODEX = `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 1.0.0"; exit 0 ;;
  --help)
    echo x >> "$FAKE_CODEX_DIR/probe.count"
    env | grep '^WMUX_' >> "$FAKE_CODEX_DIR/probe.env"
    if [ "\${FAKE_CODEX_NO_ND:-}" = 1 ]; then echo "Usage: codex [OPTIONS]"; else echo "      --no-daemon"; fi
    exit 0 ;;
  features)
    env | grep '^WMUX_' >> "$FAKE_CODEX_DIR/probe.env"
    if [ "\${FAKE_CODEX_NO_GUARD:-}" = 1 ]; then echo "other_feature stable true"; else echo "daemon_auto_start stable true"; fi
    exit 0 ;;
esac
n=$(ls "$FAKE_CODEX_DIR" | grep -c '^call\\..*\\.argv$')
f="$FAKE_CODEX_DIR/call.$n"
for a in "$@"; do printf '%s\\0' "$a"; done > "$f.argv"
env | grep '^WMUX_' > "$f.env"
exit 0
`;

const G = ['-c', 'features.daemon_auto_start=false'];
const ND = '--no-daemon';

interface Call { argv: string[]; wmux: Record<string, string> }
interface Run { calls: Call[]; out: string; helpCount: number; probeEnv: string }

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-guard-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'rec'));
  fs.mkdirSync(path.join(dir, 'user'));
  fs.mkdirSync(path.join(dir, 'zdot'));
  fs.writeFileSync(path.join(dir, 'bin', 'codex'), FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'fix the bug\nsecond line "quoted"\n');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(
  shell: 'bash' | 'zsh',
  script: string,
  opts: { userRc?: string; env?: Record<string, string>; noCodex?: boolean } = {},
): Run {
  const rec = path.join(dir, 'rec');
  // Each run is a fresh shell; start its record empty.
  for (const f of fs.readdirSync(rec)) fs.rmSync(path.join(rec, f));
  const env: Record<string, string> = {
    PATH: `${opts.noCodex ? '' : `${path.join(dir, 'bin')}:`}/usr/bin:/bin`,
    TERM: 'dumb',
    FAKE_CODEX_DIR: rec,
    WMUX_PTY_ID: 'pane-A',
    WMUX_WORKSPACE_ID: 'ws-1',
    WMUX_SHELL_INTEGRATION: '1',
    ...opts.env,
  };
  let r;
  if (shell === 'bash') {
    const home = path.join(dir, 'user');
    if (opts.userRc !== undefined) fs.writeFileSync(path.join(home, '.bashrc'), opts.userRc);
    const rc = path.join(dir, 'init.bash');
    fs.writeFileSync(rc, BASH_INIT);
    r = spawnSync(BASH as string, ['--rcfile', rc, '-i'], {
      input: script, encoding: 'utf-8', env: { ...env, HOME: home }, timeout: 10_000,
    });
  } else {
    const user = path.join(dir, 'user');
    if (opts.userRc !== undefined) fs.writeFileSync(path.join(user, '.zshrc'), opts.userRc);
    fs.writeFileSync(path.join(dir, 'zdot', '.zshrc'), ZSH_RC);
    r = spawnSync(ZSH as string, ['-i'], {
      input: script,
      encoding: 'utf-8',
      env: { ...env, HOME: user, ZDOTDIR: path.join(dir, 'zdot'), WMUX_USER_ZDOTDIR: user },
      timeout: 10_000,
    });
  }
  const files = fs.readdirSync(rec);
  const n = files.filter((f) => /^call\.\d+\.argv$/.test(f)).length;
  const calls: Call[] = [];
  for (let i = 0; i < n; i++) {
    const raw = fs.readFileSync(path.join(rec, `call.${i}.argv`), 'utf-8');
    const argv = raw === '' ? [] : raw.slice(0, -1).split('\0');
    const wmux: Record<string, string> = {};
    for (const line of fs.readFileSync(path.join(rec, `call.${i}.env`), 'utf-8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) wmux[line.slice(0, eq)] = line.slice(eq + 1);
    }
    calls.push({ argv, wmux });
  }
  const help = path.join(rec, 'probe.count');
  const helpCount = fs.existsSync(help) ? fs.readFileSync(help, 'utf-8').split('\n').filter(Boolean).length : 0;
  const pe = path.join(rec, 'probe.env');
  const probeEnv = fs.existsSync(pe) ? fs.readFileSync(pe, 'utf-8') : '';
  return { calls, out: `${r.stdout}${r.stderr}`, helpCount, probeEnv };
}

const shells: Array<['bash' | 'zsh', string | undefined]> = [['bash', BASH], ['zsh', ZSH]];

for (const [shell, bin] of shells) {
  describe.skipIf(!posix || !bin)(`${shell}: codex seed guard (v12)`, () => {
    it('fan-out launch line: interactive, keeps the pane env, gets the guard and --no-daemon', () => {
      const { calls } = run(shell, `codex --model x "$(cat '${path.join(dir, 'prompt.md')}')"\n`);
      expect(calls).toHaveLength(1);
      expect(calls[0].argv).toEqual([...G, ND, '--model', 'x', 'fix the bug\nsecond line "quoted"']);
      expect(calls[0].wmux.WMUX_PTY_ID).toBe('pane-A');
      expect(calls[0].wmux.WMUX_WORKSPACE_ID).toBe('ws-1');
    });

    it('interactive forms: bare, -m prompt, -c resume, fork, `-- resume` (a prompt)', () => {
      const { calls } = run(shell, [
        'codex',
        'codex -m x "a prompt"',
        'codex -c k=v resume --last',
        'codex fork --last',
        'codex -- resume',
      ].join('\n') + '\n');
      expect(calls.map((c) => c.argv)).toEqual([
        [...G, ND],
        [...G, ND, '-m', 'x', 'a prompt'],
        [...G, ND, '-c', 'k=v', 'resume', '--last'],
        [...G, ND, 'fork', '--last'],
        [...G, ND, '--', 'resume'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('exec / e / review keep the pane env (hooks routing) and get only the guard', () => {
      const { calls } = run(shell, 'codex exec --json hi\ncodex e hi\ncodex -c a=b review --uncommitted\n');
      expect(calls.map((c) => c.argv)).toEqual([
        [...G, 'exec', '--json', 'hi'],
        [...G, 'e', 'hi'],
        [...G, '-c', 'a=b', 'review', '--uncommitted'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('other subcommands run guarded with no WMUX_* at all', () => {
      const { calls } = run(shell, 'codex agents\ncodex app-server daemon start\ncodex queue x\ncodex remote-control\n');
      expect(calls.map((c) => c.argv)).toEqual([
        [...G, 'agents'], [...G, 'app-server', 'daemon', 'start'], [...G, 'queue', 'x'], [...G, 'remote-control'],
      ]);
      for (const c of calls) expect(Object.keys(c.wmux)).toEqual([]);
    });

    it('a server word anywhere on the line drops the pane identity (bypass: `codex hello app-server daemon start`)', () => {
      const { calls } = run(shell, [
        'codex hello app-server daemon start',
        'codex exec please restart the daemon',
        'codex -m x -- talk about exec-server',
        'codex --no-daemon remote-control',
      ].join('\n') + '\n');
      expect(calls.map((c) => c.argv)).toEqual([
        [...G, 'hello', 'app-server', 'daemon', 'start'],
        [...G, 'exec', 'please', 'restart', 'the', 'daemon'],
        [...G, '-m', 'x', '--', 'talk', 'about', 'exec-server'],
        [...G, '--no-daemon', 'remote-control'],
      ]);
      for (const c of calls) expect(Object.keys(c.wmux)).toEqual([]);
    });

    it('-i/--image is interactive-only: never read as a subcommand (bypass: `codex -i shot.png review the UI`)', () => {
      const { calls } = run(shell, [
        'codex -i shot.png review the UI',
        'codex --image a.png exec',
        'codex --image=a.png agents',
        'codex -ia.png queue',
      ].join('\n') + '\n');
      expect(calls.map((c) => c.argv)).toEqual([
        [...G, ND, '-i', 'shot.png', 'review', 'the', 'UI'],
        [...G, ND, '--image', 'a.png', 'exec'],
        [...G, ND, '--image=a.png', 'agents'],
        [...G, ND, '-ia.png', 'queue'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('an unknown option keeps identity only behind the guard, and is scrubbed without it', () => {
      const guarded = run(shell, 'codex --future-flag agents\ncodex --future=1 exec\n');
      expect(guarded.calls.map((c) => c.argv)).toEqual([
        [...G, ND, '--future-flag', 'agents'],
        [...G, ND, '--future=1', 'exec'],
      ]);
      for (const c of guarded.calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
      const bare = run(shell, 'codex --future-flag agents\n', { env: { FAKE_CODEX_NO_GUARD: '1' } });
      expect(bare.calls[0].argv).toEqual(['--future-flag', 'agents']);
      expect(Object.keys(bare.calls[0].wmux)).toEqual([]);
    });

    it('without the feature guard: interactive keeps identity via --no-daemon; with neither it is scrubbed', () => {
      const nd = run(shell, 'codex hi\ncodex exec hi\n', { env: { FAKE_CODEX_NO_GUARD: '1' } });
      expect(nd.calls.map((c) => c.argv)).toEqual([[ND, 'hi'], ['exec', 'hi']]);
      for (const c of nd.calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
      const neither = run(shell, 'codex hi\n', { env: { FAKE_CODEX_NO_GUARD: '1', FAKE_CODEX_NO_ND: '1' } });
      expect(neither.calls[0].argv).toEqual(['hi']);
      expect(Object.keys(neither.calls[0].wmux)).toEqual([]);
    });

    it('steps aside for --remote, --no-daemon and WMUX_CODEX_WRAP=0', () => {
      const { calls } = run(shell, [
        'codex --remote unix:///tmp/x.sock -- hi',
        'codex resume --remote=ws://h:1 --last',
        'codex --no-daemon hi',
        'WMUX_CODEX_WRAP=0 codex hi',
      ].join('\n') + '\n');
      expect(calls.map((c) => c.argv)).toEqual([
        ['--remote', 'unix:///tmp/x.sock', '--', 'hi'],
        ['resume', '--remote=ws://h:1', '--last'],
        ['--no-daemon', 'hi'],
        ['hi'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('WSL: a scrubbed call goes to the real codex, not the wmux shim (no re-exec loop)', () => {
      const shimDir = path.join(dir, 'wslbin');
      fs.mkdirSync(shimDir);
      fs.writeFileSync(path.join(shimDir, 'codex'), WSL_CODEX_SHIM, { mode: 0o755 });
      const { calls, out } = run(shell, 'codex agents\ncodex hi\n', {
        env: { PATH: `${shimDir}:${path.join(dir, 'bin')}:/usr/bin:/bin`, WMUX_WSL_BIN: shimDir },
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].argv).toEqual([...G, 'agents']);
      expect(Object.keys(calls[0].wmux)).toEqual([]);
      // The identity-keeping call still goes through the shim (hook capture).
      expect(calls[1].argv).toEqual([...G, ND, 'hi']);
      expect(calls[1].wmux.WMUX_PTY_ID).toBe('pane-A');
      expect(out).toContain('launching Codex unchanged');
    });

    it("a user's `alias codex=` still reaches the function, with the alias applied once", () => {
      const { calls } = run(shell, 'codex hi\n', { userRc: "alias codex='codex --search'\n" });
      expect(calls[0].argv).toEqual([...G, ND, '--search', 'hi']);
    });

    it('a user-defined codex function is left alone', () => {
      const { calls, out } = run(shell, 'codex hi\n', { userRc: 'codex() { echo "USERFN:$*"; }\n' });
      expect(out).toContain('USERFN:hi');
      expect(calls).toHaveLength(0);
    });

    it('probes once per binary with WMUX_* removed, again when the binary is replaced', () => {
      const { calls, helpCount, probeEnv } = run(shell, 'codex p1\ncodex p2\ncodex exec x\n');
      expect(calls).toHaveLength(3);
      expect(helpCount).toBe(1);
      expect(probeEnv).toBe('');
      const fake = path.join(dir, 'bin', 'codex');
      const replaced = run(shell, `codex p1\ncp '${fake}' '${fake}.new' && mv '${fake}.new' '${fake}'\ncodex p2\n`);
      expect(replaced.helpCount).toBe(2);
    });

    it('works under set -u, and with no codex on PATH falls through to the normal error', () => {
      const ok = run(shell, 'set -u\ncodex hi\n');
      expect(ok.calls[0].argv).toEqual([...G, ND, 'hi']);
      const missing = run(shell, 'codex hi\necho "rc=$?"\n', { noCodex: true });
      expect(missing.out).toContain('rc=127');
    });

    it('WMUX_SHELL_INTEGRATION=0 turns the function off', () => {
      const { calls } = run(shell, 'codex hi\n', { env: { WMUX_SHELL_INTEGRATION: '0' } });
      expect(calls[0].argv).toEqual(['hi']);
    });
  });
}
