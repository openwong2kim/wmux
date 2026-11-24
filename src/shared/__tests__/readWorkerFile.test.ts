import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkerFile } from '../readWorkerFile';
import { FAR_IDS, fakeFileIds } from '../../test-utils/fileIds';

let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worker-file-'))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('readWorkerFile', () => {
  it('refuses an opened file whose 64-bit ID differs from the checked one only below Number precision', async () => {
    const file = path.join(dir, 'HEAD');
    fs.writeFileSync(file, 'ref: refs/heads/main\n');
    expect(await readWorkerFile(file)).toBe('ref: refs/heads/main\n');
    fakeFileIds({ [file]: { byPath: () => FAR_IDS[0], byHandle: () => FAR_IDS[1] } });
    expect(await readWorkerFile(file)).toBeNull();
  });
});
