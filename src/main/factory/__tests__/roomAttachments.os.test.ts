import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ nativeImage: {} }));

import { ROOM_ATTACHMENT_RETAIN_MS, RoomAttachmentStore, cardImages, type RoomImageNormalizer } from '../roomAttachments';
import { RoomWriter } from '../roomWriter';
import { ROOM_ATTACHMENT_LIMITS, parseRoomAttachments, sniffRoomImage, UPLOAD_NAME_RE } from '../../../shared/roomAttachments';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const UPLOAD = 'photo-2026-10-18T01-02-03-456Z-0a1b2c3d.jpg';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** The normaliser stand-in: a fixed small JPEG for any decodable input. */
const fakeNormalize: RoomImageNormalizer = (source) => (sniffRoomImage(source) ? { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), source.subarray(0, 16)]), width: 1568, height: 1176 } : null);

let dir = '';
let now = 0;
let store: RoomAttachmentStore;
const uploads = () => path.join(dir, 'uploads', 'phone');
const root = () => path.join(dir, 'factory', 'room-attachments');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-photos-'));
  fs.mkdirSync(uploads(), { recursive: true });
  now = Date.now();
  store = new RoomAttachmentStore({ root: root(), uploadsDir: uploads(), normalize: fakeNormalize, now: () => now, log: () => undefined });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared rules', () => {
  it('sniffs PNG and JPEG only, and parses stored lists strictly', () => {
    expect(sniffRoomImage(JPEG)).toBe('image/jpeg');
    expect(sniffRoomImage(PNG)).toBe('image/png');
    expect(sniffRoomImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffRoomImage(Buffer.from('RIFF....WEBP'))).toBeNull();
    expect(sniffRoomImage(Buffer.alloc(0))).toBeNull();
    const id = 'a'.repeat(32);
    expect(parseRoomAttachments([{ id, mediaType: 'image/jpeg', bytes: 10, width: 4, extra: 1 }])).toEqual([{ id, mediaType: 'image/jpeg', bytes: 10, width: 4 }]);
    expect(parseRoomAttachments([{ id: '../x', mediaType: 'image/jpeg', bytes: 10 }])).toBeUndefined();
    expect(parseRoomAttachments([{ id, mediaType: 'image/png', bytes: 10 }])).toBeUndefined();
    expect(parseRoomAttachments([{ id, mediaType: 'image/jpeg', bytes: 10 }, { id, mediaType: 'image/jpeg', bytes: 10 }])).toHaveLength(1);
    const many = Array.from({ length: 6 }, (_, i) => ({ id: String(i).repeat(32), mediaType: 'image/jpeg', bytes: 1 }));
    expect(parseRoomAttachments(many)).toHaveLength(ROOM_ATTACHMENT_LIMITS.PER_MESSAGE);
    // The phone never sees the upload name.
    expect(parseRoomAttachments([{ id, mediaType: 'image/jpeg', bytes: 1, upload: UPLOAD }], { keepUpload: false })).toEqual([{ id, mediaType: 'image/jpeg', bytes: 1 }]);
    expect(UPLOAD_NAME_RE.test(UPLOAD)).toBe(true);
    expect(UPLOAD_NAME_RE.test('photo-vacation.jpg')).toBe(false);
  });
});

describe('RoomAttachmentStore', () => {
  it('copies a phone upload as the normalised JPEG, 0600 in a 0700 folder', () => {
    fs.writeFileSync(path.join(uploads(), UPLOAD), JPEG);
    const r = store.importUpload('ws-1', { uploadId: UPLOAD, bytes: JPEG.length, sha256: sha(JPEG) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachment).toMatchObject({ mediaType: 'image/jpeg', width: 1568, height: 1176, upload: UPLOAD });
    expect(r.attachment.id).toMatch(/^[0-9a-f]{32}$/);
    const file = path.join(root(), 'ws-1', `${r.attachment.id}.jpg`);
    expect(fs.readFileSync(file)).toEqual(fakeNormalize(JPEG)!.data);
    expect(r.attachment.bytes).toBe(fs.statSync(file).size);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(store.read('ws-1', r.attachment.id)).toEqual(fs.readFileSync(file));
  });

  it('refuses a traversal name, a link, other bytes, a bad type and an oversize source', () => {
    fs.writeFileSync(path.join(uploads(), UPLOAD), JPEG);
    expect(store.importUpload('ws-1', { uploadId: '../uploads/phone/x.jpg', bytes: 1, sha256: sha(JPEG) })).toEqual({ ok: false, reason: 'missing' });
    // The daemon read other bytes: not the file it checked.
    expect(store.importUpload('ws-1', { uploadId: UPLOAD, bytes: JPEG.length, sha256: sha(PNG) })).toEqual({ ok: false, reason: 'changed' });
    const gif = 'photo-2026-10-18T01-02-03-456Z-0a1b2c3e.png';
    const gifBytes = Buffer.from('GIF89a-not-a-png');
    fs.writeFileSync(path.join(uploads(), gif), gifBytes);
    expect(store.importUpload('ws-1', { uploadId: gif, bytes: gifBytes.length, sha256: sha(gifBytes) })).toEqual({ ok: false, reason: 'type' });
    if (process.platform !== 'win32') {
      const link = 'photo-2026-10-18T01-02-03-456Z-0a1b2c3f.jpg';
      const outside = path.join(dir, 'secret.jpg');
      fs.writeFileSync(outside, JPEG);
      fs.symlinkSync(outside, path.join(uploads(), link));
      expect(store.importUpload('ws-1', { uploadId: link, bytes: JPEG.length, sha256: sha(JPEG) })).toEqual({ ok: false, reason: 'missing' });
      expect(store.importFile('ws-1', path.join(uploads(), link))).toEqual({ ok: false, reason: 'missing' });
    }
    const big = path.join(dir, 'big.jpg');
    fs.writeFileSync(big, Buffer.concat([JPEG, Buffer.alloc(ROOM_ATTACHMENT_LIMITS.SOURCE_MAX_BYTES)]));
    expect(store.importFile('ws-1', big)).toEqual({ ok: false, reason: 'size' });
    expect(store.importFile('ws-1', 'relative.jpg')).toEqual({ ok: false, reason: 'missing' });
    expect(store.importFile('../ws', path.join(uploads(), UPLOAD))).toEqual({ ok: false, reason: 'missing' });
    // Nothing was stored by any refusal.
    expect(fs.existsSync(root()) ? fs.readdirSync(root()).flatMap((ws) => fs.readdirSync(path.join(root(), ws))) : []).toEqual([]);
  });

  it('refuses past the room quota', () => {
    const wsDir = path.join(root(), 'ws-1');
    fs.mkdirSync(wsDir, { recursive: true });
    for (let i = 0; i < ROOM_ATTACHMENT_LIMITS.ROOM_MAX_FILES; i++) fs.writeFileSync(path.join(wsDir, `${i.toString(16).padStart(32, '0')}.jpg`), 'x');
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, PNG);
    expect(store.importFile('ws-1', file)).toEqual({ ok: false, reason: 'full' });
    // Another room has its own quota.
    expect(store.importFile('ws-2', file).ok).toBe(true);
  });

  it('sweeps by age only: a card rewritten by an older build without the field keeps its photo', () => {
    const file = path.join(dir, 'a.jpg');
    fs.writeFileSync(file, JPEG);
    const r = store.importFile('ws-1', file);
    if (!r.ok) throw new Error('import failed');
    const rooms = path.join(dir, 'factory', 'rooms');
    const writer = new RoomWriter({ dir: rooms, log: () => undefined });
    const posted = writer.post({ workspaceId: 'ws-1', kind: 'human', actor: { kind: 'human' }, title: 'see', attachments: [r.attachment] });
    expect(posted.ok && posted.card.attachments).toEqual([r.attachment]);
    // An older build compacts the room through its own whitelist: the field is gone.
    const lines = fs.readFileSync(path.join(rooms, 'ws-1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.writeFileSync(path.join(rooms, 'ws-1.jsonl'), `${lines.map(({ attachments: _a, ...rest }) => JSON.stringify(rest)).join('\n')}\n`);
    // The new build starts: the sweep keeps the young file whatever the cards say.
    store.sweep();
    expect(store.read('ws-1', r.attachment.id)).not.toBeNull();
    // Past the room's retention plus a day it goes, with stray temp files.
    fs.writeFileSync(path.join(root(), 'ws-1', `${'b'.repeat(32)}.jpg.tmp`), 'x');
    const old = new Date(now - ROOM_ATTACHMENT_RETAIN_MS - 1000);
    for (const n of fs.readdirSync(path.join(root(), 'ws-1'))) fs.utimesSync(path.join(root(), 'ws-1', n), old, old);
    fs.writeFileSync(path.join(root(), 'ws-1', 'notes.txt'), 'mine');
    store.sweep();
    expect(fs.readdirSync(path.join(root(), 'ws-1'))).toEqual(['notes.txt']);
  });

  it('a linked room folder is never read, written or swept', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(dir, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, `${'d'.repeat(32)}.jpg`);
    fs.writeFileSync(victim, JPEG);
    const old = new Date(now - ROOM_ATTACHMENT_RETAIN_MS - 1000);
    fs.utimesSync(victim, old, old);
    fs.mkdirSync(root(), { recursive: true });
    fs.symlinkSync(outside, path.join(root(), 'ws-link'));
    store.sweep();
    expect(fs.existsSync(victim)).toBe(true);
    expect(store.read('ws-link', 'd'.repeat(32))).toBeNull();
    const file = path.join(dir, 'a.jpg');
    fs.writeFileSync(file, JPEG);
    expect(store.importFile('ws-link', file)).toEqual({ ok: false, reason: 'missing' });
    expect(fs.readdirSync(outside)).toEqual([path.basename(victim)]);
  });

  it('cardImages: base64 of each stored copy, and how many are gone', () => {
    const file = path.join(dir, 'a.jpg');
    fs.writeFileSync(file, JPEG);
    const r = store.importFile('ws-1', file);
    if (!r.ok) throw new Error('import failed');
    const gone = { ...r.attachment, id: 'c'.repeat(32) };
    const out = cardImages(store, 'ws-1', [r.attachment, gone]);
    expect(out.missing).toBe(1);
    expect(out.images).toEqual([{ mediaType: 'image/jpeg', data: store.read('ws-1', r.attachment.id)!.toString('base64') }]);
  });
});
