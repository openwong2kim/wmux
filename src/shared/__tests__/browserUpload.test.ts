import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * checkUploadPath refuses what it can from the string alone. A path outside
 * the root never reaches the filesystem, so a UNC share or another drive is
 * never opened from the main process just to be refused.
 */

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock('node:fs', () => {
  const trap = (name: string) => (...args: unknown[]) => {
    touched.push(`${name}(${String(args[0])})`);
    throw new Error(`fs.${name} called`);
  };
  const fs = {
    existsSync: trap('existsSync'),
    realpathSync: trap('realpathSync'),
    statSync: trap('statSync'),
    lstatSync: trap('lstatSync'),
    mkdirSync: trap('mkdirSync'),
  };
  return { ...fs, default: fs };
});

import { checkUploadPath } from '../browserUpload';

const ROOT = path.resolve('/srv/wmux-test/uploads');
const root = { spelled: ROOT, real: ROOT };

beforeEach(() => {
  touched.length = 0;
});

describe('checkUploadPath: lexical refusals touch no file', () => {
  const outside: Array<[string, string]> = [
    ['`..` out of the root', path.join(ROOT, '..', 'secrets', 'id_rsa')],
    ['a sibling that merely shares the prefix', `${ROOT}-evil${path.sep}x.png`],
    ['an absolute path elsewhere', path.resolve('/etc/passwd')],
    ['a UNC share', '\\\\attacker\\share\\x.png'],
    ['another drive', 'E:\\loot\\x.png'],
    ['the root itself', ROOT],
  ];
  for (const [label, input] of outside) {
    it(`refuses ${label}`, () => {
      expect(checkUploadPath(input, root)).toEqual({ ok: false, reason: 'outside' });
      expect(touched).toEqual([]);
    });
  }

  it('refuses an empty or non-string path', () => {
    expect(checkUploadPath('', root)).toEqual({ ok: false, reason: 'empty' });
    expect(checkUploadPath(42, root)).toEqual({ ok: false, reason: 'empty' });
    expect(touched).toEqual([]);
  });

  it('resolves only a path that names somewhere under the root', () => {
    // The trap answers as an unreadable path would; what matters is that the
    // first filesystem call is for the candidate, after the lexical pass.
    expect(checkUploadPath(path.join(ROOT, 'clip.mp4'), root)).toEqual({ ok: false, reason: 'unresolvable' });
    expect(touched).toEqual([`realpathSync(${path.join(ROOT, 'clip.mp4')})`]);
  });
});
