import { beforeEach, describe, expect, it, vi } from 'vitest';

const read = vi.fn();
vi.mock('electron', () => ({
  clipboard: { read: (...args: unknown[]) => read(...args) },
  nativeImage: { createFromBuffer: vi.fn() },
}));

import { clipboardHasImage, readClipboardPng } from '../clipboardImage';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const item = (types: string[], getType: (type: string) => Promise<Blob>) => ({ types, getType });

beforeEach(() => { read.mockReset(); });

describe('clipboard image', () => {
  it('reads a PNG as it is', async () => {
    read.mockResolvedValue([item(['image/png'], async () => new Blob([PNG]))]);
    expect(await readClipboardPng()).toEqual(PNG);
  });

  // The Win32 clipboard can be locked by another program while it is read.
  it('takes a busy clipboard as no image, whether listing or reading it fails', async () => {
    read.mockRejectedValue(new Error('clipboard is busy'));
    expect(await readClipboardPng()).toBeNull();
    expect(await clipboardHasImage()).toBe(false);
    read.mockResolvedValue([item(['image/png'], async () => { throw new Error('clipboard is busy'); })]);
    expect(await readClipboardPng()).toBeNull();
  });
});
