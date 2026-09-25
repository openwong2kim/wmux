import { describe, expect, it } from 'vitest';
import { AgentProcessTracker, isVerifiedPassiveHelper, type ProcessTreeEntry } from '../AgentProcessTracker';

const SHELL = 100;
const ENV = { HOME: '/Users/me' };
const CACHE = '/Users/me/.cache/gitstatus/gitstatusd-darwin-arm64';
const ARGS = '-G v1.5.4 -s -1 -u -1 -c -1 -d -1 -m -1 -v FATAL -t 16';
const shell: ProcessTreeEntry = { pid: SHELL, ppid: 1, name: '-zsh', cmdline: '-zsh' };
const helper = (image = CACHE, args = ARGS, ppid = SHELL, pid = 200): ProcessTreeEntry => ({ pid, ppid, name: image, cmdline: `${image} ${args}` });
const tracker = (table: ProcessTreeEntry[]) => new AgentProcessTracker({ watch: () => undefined, unwatch: () => undefined }, async () => table);

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

  it('accepts the plugin checkout and custom cache locations', () => {
    expect(isVerifiedPassiveHelper(helper('/opt/homebrew/share/powerlevel10k/gitstatus/usrbin/gitstatusd'), SHELL, [], ENV)).toBe(true);
    expect(isVerifiedPassiveHelper(helper('/data/gs/gitstatusd-linux-x86_64'), SHELL, [], { ...ENV, GITSTATUS_CACHE_DIR: '/data/gs' })).toBe(true);
    expect(isVerifiedPassiveHelper(helper('/xdg/gitstatus/gitstatusd-linux-aarch64'), SHELL, [], { ...ENV, XDG_CACHE_HOME: '/xdg' })).toBe(true);
  });

  it('refuses spoofed helpers', () => {
    const refused: [string, ProcessTreeEntry, ProcessTreeEntry[]][] = [
      ['name only, outside an install location', helper('/tmp/gitstatusd-darwin-arm64'), []],
      ['relative image', helper('gitstatusd-darwin-arm64'), []],
      ['non-normalized path', helper('/Users/me/.cache/gitstatus/../gitstatus/gitstatusd-darwin-arm64'), []],
      ['usrbin image with a platform name', helper('/opt/p10k/gitstatus/usrbin/gitstatusd-darwin-arm64'), []],
      ['other binary in the cache dir', helper('/Users/me/.cache/gitstatus/bash'), []],
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
      expect(isVerifiedPassiveHelper(candidate, SHELL, [shell, candidate, ...extra], ENV), label).toBe(false);
    }
  });
});
