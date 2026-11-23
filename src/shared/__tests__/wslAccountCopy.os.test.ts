// WSL_ACCOUNT_COPY_SH in a real bash (Linux and macOS CI: bash 3.2 and a BSD
// userland there). WSL itself runs it only in the Windows+WSL dogfood.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWslAccountScript, WSL_ACCOUNT_COPY_EXIT, WSL_ACCOUNT_COPY_SH } from '../wslIntegration';
import { wslAccountCopyArgs } from '../../daemon/wslAccountCopy';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const KEY = 'abcdef0123456789';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('WSL_ACCOUNT_COPY_SH', () => {
  function setup(opts: { project?: string; home?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux copy -')); dirs.push(root);
    const home = path.join(root, opts.home ?? 'home');
    const project = opts.project ?? '-home-me-repo';
    const projectDir = path.join(home, '.claude', 'projects', project);
    fs.mkdirSync(projectDir, { recursive: true });
    const source = path.join(projectDir, `${SID}.jsonl`);
    fs.writeFileSync(source, '{"turn":1}\n{"turn":2}\n');
    const script = ensureWslAccountScript(path.join(root, 'integration'));
    const run = (o: { suffix?: string; share?: boolean; src?: string } = {}) => spawnSync('bash', ['--noprofile', '--norc', '-c', WSL_ACCOUNT_COPY_SH,
      ...wslAccountCopyArgs({ key: KEY, share: o.share ?? false, suffix: o.suffix ?? '', source: o.src ?? source, project, sessionId: SID })], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, WMUX_WSL_ACCOUNT_SH: script },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const accountHome = (suffix = '') => path.join(home, `.wmux${suffix}`, 'accounts', `claude-${KEY}`);
    const target = (suffix = '') => path.join(accountHome(suffix), 'projects', project, `${SID}.jsonl`);
    return { home, source, projectDir, run, accountHome, target };
  }

  it('makes a missing home private and mirrored, as a spawn does, and copies through a temp file', () => {
    const s = setup();
    fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), '{"theme":"x"}');
    fs.mkdirSync(path.join(s.home, '.claude', 'skills'));
    const ran = s.run({ share: true });
    expect(ran.status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    expect(ran.stdout).toBe(`${s.accountHome()}\n`);
    expect(fs.statSync(s.accountHome()).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(s.accountHome(), 'settings.json'), 'utf8')).toBe('{"theme":"x"}');
    expect(fs.lstatSync(path.join(s.accountHome(), 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(s.target(), 'utf8')).toBe(fs.readFileSync(s.source, 'utf8'));
    expect(fs.readdirSync(path.dirname(s.target())).filter((n) => n.startsWith('.wmux-copy'))).toEqual([]);
    expect(fs.readFileSync(s.source, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it('replaces an earlier state of the same file (A → B → A) and refuses one that diverged', () => {
    const s = setup();
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    fs.appendFileSync(s.source, '{"turn":3}\n');
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    expect(fs.readFileSync(s.target(), 'utf8')).toBe(fs.readFileSync(s.source, 'utf8'));
    fs.writeFileSync(s.target(), '{"turn":1}\n{"other":2}\n');
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.diverged);
    fs.writeFileSync(s.target(), `${fs.readFileSync(s.source, 'utf8')}{"turn":4}\n`);
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.diverged);
    expect(fs.readFileSync(s.target(), 'utf8')).toContain('"turn":4');
  });

  it('answers same, and leaves the source alone, when the target project folder is the source\'s', () => {
    const s = setup();
    fs.mkdirSync(path.join(s.accountHome(), 'projects'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(s.projectDir, path.join(s.accountHome(), 'projects', '-home-me-repo'));
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.same);
    expect(fs.readFileSync(s.source, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it('refuses a source that is a link', () => {
    const s = setup();
    const link = path.join(s.projectDir, 'link.jsonl');
    fs.symlinkSync(s.source, link);
    const ran = s.run({ src: link });
    expect(ran.status).toBe(1);
    expect(fs.existsSync(s.accountHome())).toBe(false);
  });

  it('takes names with spaces or a leading dash as data, and honours the data suffix', () => {
    const s = setup({ project: '-my proj', home: 'my home' });
    const ran = s.run({ suffix: '-t1' });
    expect(ran.status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    expect(ran.stdout).toBe(`${s.accountHome('-t1')}\n`);
    expect(fs.existsSync(s.target('-t1'))).toBe(true);
  });

  it('copies the conversation\'s sibling folder without overwriting what is there', () => {
    const s = setup();
    const sibling = path.join(s.projectDir, SID);
    fs.mkdirSync(path.join(sibling, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(sibling, 'tool-results', 'a.txt'), 'new');
    fs.writeFileSync(path.join(sibling, 'b.txt'), 'b');
    const targetSibling = path.join(path.dirname(s.target()), SID);
    fs.mkdirSync(path.join(targetSibling, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(targetSibling, 'tool-results', 'a.txt'), 'kept');
    expect(s.run().status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    expect(fs.readFileSync(path.join(targetSibling, 'tool-results', 'a.txt'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(path.join(targetSibling, 'b.txt'), 'utf8')).toBe('b');
  });
});

describe.skipIf(process.platform === 'win32')('WSL_ACCOUNT_SH with a token sign-in', () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux token -')); dirs.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-r'), { recursive: true });
    const script = ensureWslAccountScript(path.join(root, 'integration'));
    const accountHome = path.join(home, '.wmux', 'accounts', `claude-${KEY}`);
    const flag = path.join(accountHome, '.claude.json');
    // A pane's spawn: the script sourced before the user's startup files.
    const spawn = (token: boolean) => spawnSync('bash', ['--noprofile', '--norc', '-c', '. "$WMUX_WSL_ACCOUNT_SH" interactive && printf %s "$CLAUDE_CONFIG_DIR"'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, WMUX_WSL_ACCOUNT_SH: script, WMUX_WSL_ACCOUNT_CLAUDE: KEY,
        ...(token ? { WMUX_WSL_ACCOUNT_CLAUDE_TOKEN: '1' } : {}),
      },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { home, script, accountHome, flag, spawn };
  }

  it('marks first-run setup done in a new home, privately, and says nothing about a missing sign-in', () => {
    const s = setup();
    const ran = s.spawn(true);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(s.accountHome);
    expect(JSON.parse(fs.readFileSync(s.flag, 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(fs.statSync(s.flag).mode & 0o777).toBe(0o600);
    expect(ran.stderr).not.toContain('no sign-in');
  });

  it('marks a home the conversation copy made first (copy, then the new pane spawns)', () => {
    const s = setup();
    const source = path.join(s.home, '.claude', 'projects', '-r', `${SID}.jsonl`);
    fs.writeFileSync(source, '{"turn":1}\n');
    // The copy runs with the flag in its env too: it never writes the mark.
    const copied = spawnSync('bash', ['--noprofile', '--norc', '-c', WSL_ACCOUNT_COPY_SH,
      ...wslAccountCopyArgs({ key: KEY, share: false, suffix: '', source, project: '-r', sessionId: SID })], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home, WMUX_WSL_ACCOUNT_SH: s.script, WMUX_WSL_ACCOUNT_CLAUDE_TOKEN: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(copied.status).toBe(WSL_ACCOUNT_COPY_EXIT.copied);
    expect(fs.existsSync(s.flag)).toBe(false);
    expect(s.spawn(true).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(s.flag, 'utf8'))).toEqual({ hasCompletedOnboarding: true });
  });

  it('leaves an existing .claude.json or a link there alone, and writes nothing without a token', () => {
    const s = setup();
    expect(s.spawn(false).status).toBe(0);
    expect(fs.existsSync(s.flag)).toBe(false);
    fs.writeFileSync(s.flag, '{"theme":"dark"}');
    expect(s.spawn(true).status).toBe(0);
    expect(fs.readFileSync(s.flag, 'utf8')).toBe('{"theme":"dark"}');
    fs.rmSync(s.flag);
    const elsewhere = path.join(s.home, 'elsewhere.json');
    fs.symlinkSync(elsewhere, s.flag);
    expect(s.spawn(true).status).toBe(0);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });
});
