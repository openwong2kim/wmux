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

const BASH = ['/bin/bash', '/usr/bin/bash'].find((b) => fs.existsSync(b));
const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((b) => fs.existsSync(b));
const posix = process.platform !== 'win32';

const FAKE_CODEX = `#!/bin/sh
case "$1" in
  --version) echo "codex-cli \${FAKE_CODEX_VER:-1.0.0}"; exit 0 ;;
  --help)
    echo x >> "$FAKE_CODEX_DIR/help.count"
    if [ "\${FAKE_CODEX_NO_ND:-}" = 1 ]; then echo "Usage: codex [OPTIONS]"; else echo "      --no-daemon"; fi
    exit 0 ;;
esac
n=$(ls "$FAKE_CODEX_DIR" | grep -c '^call\\..*\\.argv$')
f="$FAKE_CODEX_DIR/call.$n"
for a in "$@"; do printf '%s\\0' "$a"; done > "$f.argv"
env | grep '^WMUX_' > "$f.env"
exit 0
`;

interface Call { argv: string[]; wmux: Record<string, string> }
interface Run { calls: Call[]; out: string; helpCount: number }

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
  const help = path.join(rec, 'help.count');
  const helpCount = fs.existsSync(help) ? fs.readFileSync(help, 'utf-8').split('\n').filter(Boolean).length : 0;
  return { calls, out: `${r.stdout}${r.stderr}`, helpCount };
}

const shells: Array<['bash' | 'zsh', string | undefined]> = [['bash', BASH], ['zsh', ZSH]];

for (const [shell, bin] of shells) {
  describe.skipIf(!posix || !bin)(`${shell}: codex seed guard (v12)`, () => {
    it('fan-out launch line: interactive, keeps the pane env, gets --no-daemon', () => {
      const { calls } = run(shell, `codex --model x "$(cat '${path.join(dir, 'prompt.md')}')"\n`);
      expect(calls).toHaveLength(1);
      expect(calls[0].argv).toEqual(['--no-daemon', '--model', 'x', 'fix the bug\nsecond line "quoted"']);
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
        ['--no-daemon'],
        ['--no-daemon', '-m', 'x', 'a prompt'],
        ['--no-daemon', '-c', 'k=v', 'resume', '--last'],
        ['--no-daemon', 'fork', '--last'],
        ['--no-daemon', '--', 'resume'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('exec / e / review run unchanged WITH the pane env (hooks routing)', () => {
      const { calls } = run(shell, 'codex exec --json hi\ncodex e hi\ncodex -c a=b review --uncommitted\n');
      expect(calls.map((c) => c.argv)).toEqual([
        ['exec', '--json', 'hi'],
        ['e', 'hi'],
        ['-c', 'a=b', 'review', '--uncommitted'],
      ]);
      for (const c of calls) expect(c.wmux.WMUX_PTY_ID).toBe('pane-A');
    });

    it('server-side and other subcommands run with no WMUX_* at all', () => {
      const { calls } = run(shell, 'codex agents\ncodex app-server daemon start\ncodex queue x\ncodex remote-control\n');
      expect(calls.map((c) => c.argv)).toEqual([
        ['agents'], ['app-server', 'daemon', 'start'], ['queue', 'x'], ['remote-control'],
      ]);
      for (const c of calls) expect(Object.keys(c.wmux)).toEqual([]);
    });

    it('a codex without --no-daemon runs interactive forms with no WMUX_*', () => {
      const { calls } = run(shell, 'codex hi\n', { env: { FAKE_CODEX_NO_ND: '1' } });
      expect(calls[0].argv).toEqual(['hi']);
      expect(Object.keys(calls[0].wmux)).toEqual([]);
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

    it("a user's `alias codex=` still reaches the function, with the alias applied once", () => {
      const { calls } = run(shell, 'codex hi\n', { userRc: "alias codex='codex --alias-flag'\n" });
      expect(calls[0].argv).toEqual(['--no-daemon', '--alias-flag', 'hi']);
    });

    it("a user-defined codex function is left alone", () => {
      const { calls, out } = run(shell, 'codex hi\n', { userRc: 'codex() { echo "USERFN:$*"; }\n' });
      expect(out).toContain('USERFN:hi');
      expect(calls).toHaveLength(0);
    });

    it('asks codex --help once per binary+version, and again after an upgrade', () => {
      const { calls, helpCount } = run(shell, 'codex p1\ncodex p2\n');
      expect(calls).toHaveLength(2);
      expect(helpCount).toBe(1);
      const upgraded = run(shell, 'codex p1\nexport FAKE_CODEX_VER=2.0.0\ncodex p2\n');
      expect(upgraded.helpCount).toBe(1 + 2);
    });

    it('works under set -u, and with no codex on PATH falls through to the normal error', () => {
      const ok = run(shell, 'set -u\ncodex hi\n');
      expect(ok.calls[0].argv).toEqual(['--no-daemon', 'hi']);
      const missing = run(shell, 'codex hi\necho "rc=$?"\n', { noCodex: true });
      expect(missing.out).toContain('rc=127');
    });

    it('WMUX_SHELL_INTEGRATION=0 turns the function off', () => {
      const { calls } = run(shell, 'codex hi\n', { env: { WMUX_SHELL_INTEGRATION: '0' } });
      expect(calls[0].argv).toEqual(['hi']);
    });
  });
}
