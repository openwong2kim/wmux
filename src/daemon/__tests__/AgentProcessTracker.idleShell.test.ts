import { spawn } from 'child_process';
import os from 'os';
import { describe, expect, it } from 'vitest';
import { AgentProcessTracker, gitstatusPackageDirs, isHelperImage, isVerifiedPassiveHelper, readExecutableImage, type ProcessTreeEntry } from '../AgentProcessTracker';

const SHELL = 100;
const HOME = '/Users/me';
const ENV = {};
const CACHE = `${HOME}/.cache/gitstatus/gitstatusd-darwin-arm64`;
const ARGS = '-G v1.5.4 -s -1 -u -1 -c -1 -d -1 -m -1 -v FATAL -t 16';
const BREW_ARM = '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/gitstatusd';
/** The fixed Homebrew roots with nothing installed, independent of the test host. */
const PACKAGES = gitstatusPackageDirs(() => { throw new Error('ENOENT'); });
const shell: ProcessTreeEntry = { pid: SHELL, ppid: 1, name: '-zsh', cmdline: '-zsh' };
const helper = (image = CACHE, args = ARGS, ppid = SHELL, pid = 200): ProcessTreeEntry => ({ pid, ppid, name: image, cmdline: `${image} ${args}` });
/** By default the real image is what argv[0] claims; `exe` overrides it. */
const tracker = (table: ProcessTreeEntry[], exe?: (pid: number) => Promise<string | undefined>) =>
  new AgentProcessTracker({ watch: () => undefined, unwatch: () => undefined }, async () => table,
    exe ?? (async (pid) => table.find(entry => entry.pid === pid)?.name), HOME);

describe('idleShellState', () => {
  it('reports each failed launch precondition', async () => {
    expect(await tracker([]).idleShellState(SHELL)).toEqual({ ok: false, reason: 'missing' });
    expect(await tracker([{ ...shell, name: 'fish' }]).idleShellState(SHELL)).toEqual({ ok: false, reason: 'unsupported-shell' });
    expect(await tracker([shell, { pid: 300, ppid: SHELL, name: 'vim', cmdline: 'vim notes.txt' }]).idleShellState(SHELL))
      .toEqual({ ok: false, reason: 'shell-has-children' });
    expect(await tracker([shell]).idleShellState(SHELL)).toEqual({ ok: true });
  });

  it('lets a verified gitstatusd child through, but not a second unknown child', async () => {
    expect(await tracker([shell, helper()]).idleShellState(SHELL, ENV)).toEqual({ ok: true });
    expect(await tracker([shell, helper(), { pid: 300, ppid: SHELL, name: 'sleep', cmdline: 'sleep 99' }]).idleShellState(SHELL, ENV))
      .toEqual({ ok: false, reason: 'shell-has-children' });
  });

  it('refuses a helper whose argv is right but whose real executable is not (exec -a spoof)', async () => {
    expect(await tracker([shell, helper()], async () => '/bin/sleep').idleShellState(SHELL, ENV))
      .toEqual({ ok: false, reason: 'shell-has-children' });
    expect(await tracker([shell, helper()], async () => '/tmp/gitstatusd-darwin-arm64').idleShellState(SHELL, ENV))
      .toEqual({ ok: false, reason: 'shell-has-children' });
  });

  it('refuses a helper whose real executable cannot be read', async () => {
    expect(await tracker([shell, helper()], async () => undefined).idleShellState(SHELL, ENV))
      .toEqual({ ok: false, reason: 'shell-has-children' });
    expect(await tracker([shell, helper()], async () => { throw new Error('lsof'); }).idleShellState(SHELL, ENV))
      .toEqual({ ok: false, reason: 'shell-has-children' });
  });

  it('accepts the plugin checkout and custom cache locations under home', () => {
    expect(isVerifiedPassiveHelper(helper(`${HOME}/powerlevel10k/gitstatus/usrbin/gitstatusd`), SHELL, [], ENV, HOME)).toBe(true);
    expect(isVerifiedPassiveHelper(helper(`${HOME}/gs/gitstatusd-linux-x86_64`), SHELL, [], { GITSTATUS_CACHE_DIR: `${HOME}/gs` }, HOME)).toBe(true);
    expect(isVerifiedPassiveHelper(helper(`${HOME}/xdg/gitstatus/gitstatusd-linux-aarch64`), SHELL, [], { XDG_CACHE_HOME: `${HOME}/xdg` }, HOME)).toBe(true);
  });

  it('accepts gitstatusd in the two fixed Homebrew package directories', () => {
    for (const image of [BREW_ARM, '/usr/local/share/powerlevel10k/gitstatus/usrbin/gitstatusd']) {
      expect(isHelperImage(image, {}, HOME, PACKAGES), image).toBe(true);
      expect(isVerifiedPassiveHelper(helper(image), SHELL, [], ENV, HOME), image).toBe(true);
    }
  });

  it('accepts the Cellar directory a Homebrew package root resolves to, and only that one', () => {
    const cellar = '/opt/homebrew/Cellar/powerlevel10k/1.20.0/share/powerlevel10k/gitstatus/usrbin';
    const dirs = gitstatusPackageDirs((dir) => {
      if (dir.startsWith('/opt/homebrew/')) return cellar;
      throw new Error('ENOENT');
    });
    expect(isHelperImage(`${cellar}/gitstatusd`, {}, HOME, dirs)).toBe(true);
    expect(isHelperImage('/opt/homebrew/Cellar/powerlevel10k/9.9.9/share/powerlevel10k/gitstatus/usrbin/gitstatusd', {}, HOME, dirs)).toBe(false);
    expect(isHelperImage(`${cellar}/gitstatusd`, {}, HOME, PACKAGES)).toBe(false);
  });

  it('refuses look-alikes of the Homebrew package directories', () => {
    for (const image of [
      '/tmp/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/gitstatusd',
      '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/../evil/gitstatusd',
      '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin//gitstatusd',
      '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/sub/gitstatusd',
      '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/gitstatusd-darwin-arm64',
      '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/sh',
      '/opt/homebrew/share/other/gitstatus/usrbin/gitstatusd',
      'opt/homebrew/share/powerlevel10k/gitstatus/usrbin/gitstatusd',
    ]) {
      expect(isHelperImage(image, {}, HOME, PACKAGES), image).toBe(false);
    }
  });

  it('refuses install roots outside home, whatever the pane env says', () => {
    expect(isHelperImage('/tmp/p10k/gitstatus/usrbin/gitstatusd', {}, HOME)).toBe(false);
    expect(isHelperImage('/data/gs/gitstatusd-linux-x86_64', { GITSTATUS_CACHE_DIR: '/data/gs' }, HOME)).toBe(false);
    expect(isHelperImage('/xdg/gitstatus/gitstatusd-linux-aarch64', { XDG_CACHE_HOME: '/xdg' }, HOME)).toBe(false);
    // A root home would put every path "under home".
    expect(isHelperImage('/.cache/gitstatus/gitstatusd-linux-x86_64', {}, '/')).toBe(false);
    expect(isHelperImage(undefined, {}, HOME)).toBe(false);
  });

  it('refuses spoofed helpers', () => {
    const refused: [string, ProcessTreeEntry, ProcessTreeEntry[]][] = [
      ['name only, outside an install location', helper('/tmp/gitstatusd-darwin-arm64'), []],
      ['relative image', helper('gitstatusd-darwin-arm64'), []],
      ['non-normalized path', helper(`${HOME}/.cache/gitstatus/../gitstatus/gitstatusd-darwin-arm64`), []],
      ['usrbin image with a platform name', helper(`${HOME}/p10k/gitstatus/usrbin/gitstatusd-darwin-arm64`), []],
      ['other binary in the cache dir', helper(`${HOME}/.cache/gitstatus/bash`), []],
      ['unknown flag', helper(CACHE, ARGS + ' -x'), []],
      ['shell command smuggled in argv', helper(CACHE, ARGS + ' ; sh'), []],
      ['missing -G version', helper(CACHE, '-s -1 -t 16'), []],
      ['bad flag value', helper(CACHE, '-G v1.5.4 -v fatal'), []],
      ['argv0 differs from the image', { ...helper(), cmdline: `/bin/sh ${ARGS}` }, []],
      ['not the shell child', helper(CACHE, ARGS, 999), []],
      ['has a child of its own', helper(), [{ pid: 201, ppid: 200, name: 'sh', cmdline: 'sh' }]],
      ['GITSTATUS_DAEMON style override', helper('/opt/custom/gitstatusd-darwin-arm64'), []],
    ];
    for (const [label, candidate, extra] of refused) {
      expect(isVerifiedPassiveHelper(candidate, SHELL, [shell, candidate, ...extra], ENV, HOME), label).toBe(false);
    }
  });
});

describe('readExecutableImage', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('reads the real image, not a spoofed argv[0]', async () => {
    const spoof = `${os.homedir()}/.cache/gitstatus/gitstatusd-darwin-arm64`;
    const child = spawn('sleep', ['30'], { argv0: spoof, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      let image: string | undefined;
      for (let i = 0; i < 50 && !image?.length; i++) {
        image = await readExecutableImage(child.pid!);
        if (!image) await new Promise((r) => setTimeout(r, 20));
      }
      expect(image).toBeDefined();
      expect(image).not.toBe(spoof);
      expect(isHelperImage(image)).toBe(false);
    } finally { child.kill(); }
  });

  it('answers undefined for a pid that does not exist', async () => {
    expect(await readExecutableImage(2 ** 22 + 12345)).toBeUndefined();
  });
});
