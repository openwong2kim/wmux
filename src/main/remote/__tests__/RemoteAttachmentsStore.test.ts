import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteAttachmentsStore } from '../RemoteAttachmentsStore';
import type { RemoteAttachmentDescriptor } from '../../../shared/remoteHosts';

function descriptor(overrides: Partial<RemoteAttachmentDescriptor> = {}): RemoteAttachmentDescriptor {
  return {
    key: 'h1:ws-1',
    hostId: 'h1',
    hostLabel: 'office-mac',
    workspaceId: 'ws-1',
    name: 'Remote WS',
    ...overrides,
  };
}

describe('RemoteAttachmentsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-attachments-'));
    filePath = path.join(dir, 'remote-attachments.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('add → list roundtrips across a fresh construct (survives restart)', () => {
    const store = new RemoteAttachmentsStore(filePath);
    store.add(descriptor());
    store.add(descriptor({ key: 'h1:ws-2', workspaceId: 'ws-2', name: 'Second' }));

    // A second construct reads what the first wrote — this is the reload /
    // app-restart path the renderer's boot restore depends on.
    const reloaded = new RemoteAttachmentsStore(filePath);
    expect(reloaded.list()).toEqual([
      descriptor(),
      descriptor({ key: 'h1:ws-2', workspaceId: 'ws-2', name: 'Second' }),
    ]);
  });

  it('never persists a pane list, even when handed one', () => {
    const store = new RemoteAttachmentsStore(filePath);
    store.add({
      ...descriptor(),
      // Callers may hand over a full AttachedRemoteWorkspace shape.
      panes: [{ sessionId: 's1' }],
    } as RemoteAttachmentDescriptor & { panes: unknown });

    expect(store.list()[0]).toEqual(descriptor());
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown[];
    expect(onDisk[0]).toEqual(descriptor());
  });

  it('add dedups by key and refreshes the stored snapshot in place', () => {
    const store = new RemoteAttachmentsStore(filePath);
    store.add(descriptor());
    store.add(descriptor({ name: 'Renamed', hostLabel: 'renamed-host' }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe('Renamed');
    expect(store.list()[0].hostLabel).toBe('renamed-host');
  });

  it('remove drops one key and reports whether it existed', () => {
    const store = new RemoteAttachmentsStore(filePath);
    store.add(descriptor());
    expect(store.remove('h1:missing')).toBe(false);
    expect(store.remove('h1:ws-1')).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(new RemoteAttachmentsStore(filePath).list()).toHaveLength(0);
  });

  it('removeByHost drops every descriptor for that host and leaves others', () => {
    const store = new RemoteAttachmentsStore(filePath);
    store.add(descriptor());
    store.add(descriptor({ key: 'h1:ws-2', workspaceId: 'ws-2' }));
    store.add(descriptor({ key: 'h2:ws-9', hostId: 'h2', workspaceId: 'ws-9' }));

    expect(store.removeByHost('h1')).toBe(2);
    expect(store.list().map((a) => a.key)).toEqual(['h2:ws-9']);
    expect(store.removeByHost('h-none')).toBe(0);
  });

  it('tolerates a corrupt file on construct', () => {
    fs.writeFileSync(filePath, '{ not json at all');
    const store = new RemoteAttachmentsStore(filePath);
    expect(store.list()).toEqual([]);
    // And is still writable afterwards.
    store.add(descriptor());
    expect(new RemoteAttachmentsStore(filePath).list()).toHaveLength(1);
  });

  it('tolerates a structurally foreign file on construct', () => {
    fs.writeFileSync(filePath, JSON.stringify([{ key: 1, hostId: null }]));
    expect(new RemoteAttachmentsStore(filePath).list()).toEqual([]);
  });

  it('treats a missing file as an empty list', () => {
    expect(new RemoteAttachmentsStore(path.join(dir, 'nope.json')).list()).toEqual([]);
  });
});
