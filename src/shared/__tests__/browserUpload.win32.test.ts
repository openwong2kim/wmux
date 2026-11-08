// @wmux-lane unit — 'win32' here is the path flavour under test (node:path is mocked to path.win32), not this machine's platform.
import * as nodePath from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * checkUploadPath's Windows-only refusals, run on any host: node:path is
 * path.win32 and process.platform reads 'win32'. Like the lexical refusals,
 * they are made from the string alone, before any filesystem call.
 */

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});

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

const win = nodePath.win32;
const ROOT = 'C:\\Users\\me\\.wmux\\uploads';
const root = { spelled: ROOT, real: ROOT };
const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

beforeAll(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});
beforeEach(() => {
  touched.length = 0;
});

describe('checkUploadPath on Windows: a colon past the drive is refused before any file is touched', () => {
  const streams: Array<[string, string]> = [
    ['f::$DATA', 'f::$DATA'],
    ['f:named', 'f:named'],
    ['link::$INDEX_ALLOCATION\\f', 'link::$INDEX_ALLOCATION'],
    ['link:$I30:$INDEX_ALLOCATION\\f', 'link:$I30:$INDEX_ALLOCATION'],
  ];
  for (const [rel, name] of streams) {
    it(`refuses ${rel}`, () => {
      expect(checkUploadPath(win.join(ROOT, rel), root)).toEqual({ ok: false, reason: 'aliased', name });
      expect(touched).toEqual([]);
    });
  }

  it('still takes a plain drive path to the filesystem check', () => {
    const plain = win.join(ROOT, 'ok.txt');
    // The trap answers as an unreadable path would: the lexical pass let it through.
    expect(checkUploadPath(plain, root)).toEqual({ ok: false, reason: 'unresolvable' });
    expect(touched).toEqual([`realpathSync(${plain})`]);
  });

  it('does not read the drive designator of a \\\\?\\ path as a colon past the drive', () => {
    const verbatim = `\\\\?\\${win.join(ROOT, 'ok.txt')}`;
    expect(checkUploadPath(verbatim, root)).not.toMatchObject({ reason: 'aliased' });
  });
});
