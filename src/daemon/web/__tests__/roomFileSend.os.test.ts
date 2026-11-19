import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { roomFileResponse, sendRoomFile } from '../rooms';
import { PHONE_ROOM_FILE_COMMAND } from '../../../shared/phoneRooms';
import { FAR_IDS, fakeFileIds } from '../../../test-utils/fileIds';

/**
 * sendRoomFile against a real socket: a phone that leaves mid-download and
 * one that stops reading. Either way the stream ends before the handle is
 * closed, and the server keeps answering.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-file-send-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SIZE = 8 * 1024 * 1024;
const file = path.join(tmp, 'video.bin');
fs.writeFileSync(file, crypto.randomBytes(SIZE));

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise((r) => server?.close(r));
  server = undefined;
});

/** A server whose every request streams `file`; `sent` holds each sendRoomFile run and the stream it read. */
async function serve(opts: { stallMs?: number } = {}) {
  const sent: Array<{ done: Promise<void>; handle: fs.promises.FileHandle; stream: () => fs.ReadStream | undefined }> = [];
  server = http.createServer((_req, res) => {
    void fs.promises.open(file).then((handle) => {
      let stream: fs.ReadStream | undefined;
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (o) => (stream = create(o));
      sent.push({ done: sendRoomFile(res, { status: 200, handle, size: SIZE, name: 'video.mp4', contentType: 'video/mp4' }, {}, opts), handle, stream: () => stream });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { sent, url };
}

describe('sendRoomFile', () => {
  it('a download the phone leaves: the stream closes before the handle, a late read error is heard, and the next download is whole', async () => {
    const { sent, url } = await serve();
    const req = http.get(url);
    const [res] = await once(req, 'response') as [http.IncomingMessage];
    // Its own nosniff, whatever headers the server passes in (none here).
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await once(res, 'data');
    req.destroy();
    await sent[0].done;
    const stream = sent[0].stream();
    expect(stream?.closed).toBe(true);
    await expect(sent[0].handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    // A read that was in flight and fails late finds a listener.
    expect(() => stream?.emit('error', Object.assign(new Error('read'), { code: 'EBADF' }))).not.toThrow();
    const whole = await fetch(url);
    expect((await whole.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('cuts a download the phone stopped reading once its socket has been quiet for the stall time', async () => {
    const { sent, url } = await serve({ stallMs: 300 });
    const req = http.get(url);
    const [res] = await once(req, 'response') as [http.IncomingMessage];
    res.pause();
    await sent[0].done;
    req.destroy();
    // Cut short: far less than the file was read before the socket went quiet.
    expect(sent[0].stream()?.bytesRead).toBeLessThan(SIZE);
    expect(sent[0].stream()?.closed).toBe(true);
    await expect(sent[0].handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });
});

describe('roomFileResponse', () => {
  const store = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-files-')));
  const folder = path.join(store, 'ws-1');
  const fileId = 'a'.repeat(32);
  const stored = path.join(folder, fileId);
  fs.mkdirSync(folder);
  fs.writeFileSync(stored, 'hello');
  afterAll(() => { fs.rmSync(store, { recursive: true, force: true }); });
  afterEach(() => { vi.restoreAllMocks(); });
  const desktop = {
    supports: (command: string) => command === PHONE_ROOM_FILE_COMMAND,
    request: async () => ({ file: { name: 'notes.txt', mediaType: 'text/plain', bytes: 5 } }),
  };
  const open = async () => {
    const res = await roomFileResponse('ws-1', fileId, { allowTranscript: true, desktop, roomFilesDir: store });
    if ('handle' in res) await res.handle.close();
    return res.status;
  };

  it('serves the stored copy', async () => {
    expect(await open()).toBe(200);
  });

  it('refuses an opened file whose 64-bit ID differs from the checked one only below Number precision', async () => {
    fakeFileIds({ [stored]: { byPath: () => FAR_IDS[0], byHandle: () => FAR_IDS[1] } });
    expect(await open()).toBe(404);
  });

  it("refuses when the room's folder after the open differs from before only below Number precision", async () => {
    let opened = false;
    fakeFileIds({
      [folder]: { byPath: () => (opened ? FAR_IDS[1] : FAR_IDS[0]) },
      [stored]: { byPath: () => 2n ** 61n, byHandle: () => { opened = true; return 2n ** 61n; } },
    });
    expect(await open()).toBe(404);
  });
});
