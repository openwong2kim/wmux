import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileNamespaceStore } from '../ProfileNamespaceStore';
import { MEMORY_NAMESPACE_KEY_RE, memoryNamespaceKey } from '../../../shared/browserMemoryNamespace';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-memns-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProfileNamespaceStore', () => {
  it('assigns a durable generation once and keeps it for the same binding', async () => {
    const store = new ProfileNamespaceStore(dir);
    const key = await store.namespaceFor('ws-1', 'pane-a', 'Work');
    expect(key).toMatch(MEMORY_NAMESPACE_KEY_RE);
    expect(await store.namespaceFor('ws-1', 'pane-a', 'work')).toBe(key);
    // Written before it was handed out: a new process reads the same one.
    expect(await new ProfileNamespaceStore(dir).namespaceFor('ws-1', 'pane-a', 'Work')).toBe(key);
  });

  it('a rebind or a move gets a fresh generation, never an old one back', async () => {
    const store = new ProfileNamespaceStore(dir);
    const first = await store.namespaceFor('ws-1', 'pane-a', 'work');
    const rebound = await store.namespaceFor('ws-1', 'pane-a', 'other');
    const back = await store.namespaceFor('ws-1', 'pane-a', 'work');
    const moved = await store.namespaceFor('ws-2', 'pane-a', 'work');
    expect(new Set([first, rebound, back, moved]).size).toBe(4);
  });

  it('an unreadable file refuses every namespace and is not overwritten', async () => {
    const file = path.join(dir, 'browser-memory-namespaces.json');
    fs.writeFileSync(file, '{ torn');
    expect(await new ProfileNamespaceStore(dir).namespaceFor('ws-1', 'pane-a', 'work')).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ torn');
  });

  it('never writes anything until a protected namespace is asked for', () => {
    new ProfileNamespaceStore(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a namespace key never collides with a workspace id', () => {
    const key = memoryNamespaceKey('ws-1', 'work', '0123456789abcdef');
    expect(key).not.toBeNull();
    expect(/^[A-Za-z0-9_-]{1,128}$/.test(key as string)).toBe(false);
    expect(memoryNamespaceKey('ws/../x', 'work', '0123456789abcdef')).toBeNull();
    expect(memoryNamespaceKey('ws-1', 'work', 'not-a-generation')).toBeNull();
  });
});
