// A dropped file is read through one descriptor: a regular local file only,
// not a link, a folder or a network path, and never over the host's cap.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readDroppedFiles } from '../remoteFileSend';
import { REMOTE_UPLOAD_LIMITS } from '../../../shared/remoteUpload';
import { FAR_IDS, fakeFileIds } from '../../../test-utils/fileIds';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-drop-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('readDroppedFiles', () => {
  it('reads a regular file', async () => {
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, 'abc');
    const read = await readDroppedFiles([p]);
    expect(Array.isArray(read) && Buffer.from(read[0].bytes).toString()).toBe('abc');
  });

  it('refuses a relative path, a network path and a folder', async () => {
    expect(await readDroppedFiles(['shot.png'])).toEqual({ reason: 'not-a-file' });
    expect(await readDroppedFiles(['\\\\server\\share\\shot.png'])).toEqual({ reason: 'not-a-file' });
    expect(await readDroppedFiles(['//server/share/shot.png'])).toEqual({ reason: 'not-a-file' });
    expect(await readDroppedFiles([dir])).toEqual({ reason: 'not-a-file' });
  });

  it.skipIf(process.platform === 'win32')('refuses a path that starts like a network share, even when it resolves locally', async () => {
    const p = path.join(dir, 'local.txt');
    fs.writeFileSync(p, 'x');
    expect(await readDroppedFiles([`/${p}`])).toEqual({ reason: 'not-a-file' });
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic link, even to a regular file', async () => {
    const target = path.join(dir, 'real.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, link);
    expect(await readDroppedFiles([link])).toEqual({ reason: 'not-a-file' });
  });

  it('refuses an opened file whose 64-bit ID differs from the checked one only below Number precision', async () => {
    const p = path.join(dir, 'far.png');
    fs.writeFileSync(p, 'abc');
    fakeFileIds({ [p]: { byPath: () => FAR_IDS[0], byHandle: () => FAR_IDS[1] } });
    expect(await readDroppedFiles([p])).toEqual({ reason: 'not-a-file' });
  });

  it('refuses a file over the host\'s cap without reading it', async () => {
    const p = path.join(dir, 'big.bin');
    fs.writeFileSync(p, '');
    fs.truncateSync(p, REMOTE_UPLOAD_LIMITS.MAX_BYTES + 1);
    expect(await readDroppedFiles([p])).toEqual({ reason: 'too-large' });
  });
});
