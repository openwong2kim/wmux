import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ nativeImage: { createFromPath: (file: string) => {
  const empty = file.endsWith('.webp');
  const image = { isEmpty: () => empty, getSize: () => ({ width: 640, height: 320 }), toDataURL: () => 'data:image/png;base64,FULL',
    resize: vi.fn(({ width, height }: { width: number; height: number }) => ({ toDataURL: () => `data:image/png;base64,${width}x${height}` })) };
  return image;
} } }));
import { previewChatAttachment } from '../chatAttachment';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chat-attachment-'));
const file = (name: string, bytes: number) => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.alloc(bytes)); return p; };
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('chat composer attachment preview', () => {
  it('thumbnails an image to the chip edge and names it', async () => {
    const shot = file('shot one.png', 2048);
    expect(await previewChatAttachment(shot)).toEqual({ ok: true, path: shot, name: 'shot one.png', bytes: 2048, thumbnail: 'data:image/png;base64,160x80' });
  });
  it('keeps an image nativeImage cannot decode, without a picture', async () => {
    expect(await previewChatAttachment(file('a.webp', 10))).toMatchObject({ ok: true, thumbnail: '' });
  });
  it('says why a file is refused', async () => {
    expect(await previewChatAttachment(file('notes.txt', 10))).toEqual({ ok: false, reason: 'type' });
    expect(await previewChatAttachment(path.join(dir, 'gone.png'))).toEqual({ ok: false, reason: 'missing' });
    expect(await previewChatAttachment('relative.png')).toEqual({ ok: false, reason: 'missing' });
    const big = path.join(dir, 'big.png'); fs.writeFileSync(big, ''); fs.truncateSync(big, 10 * 1024 * 1024 + 1);
    expect(await previewChatAttachment(big)).toEqual({ ok: false, reason: 'size' });
  });
});
