import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteMemoryStore, getSiteMemoryDir } from '../SiteMemoryStore';
import {
  SITE_MEMORY_DECAY_MS,
  SITE_MEMORY_DELETE_MS,
  buildFailureEntry,
  buildNoteEntry,
} from '../../../shared/browserMemory/siteMemory';
import { memoryNamespaceKey } from '../../../shared/browserMemoryNamespace';

const NOW = 1_800_000_000_000;
let dir: string;
let store: SiteMemoryStore;

function fileFor(workspaceId: string, slug: string): string {
  return path.join(getSiteMemoryDir(dir), workspaceId, `${slug}.json`);
}

function failureEntry(over: { what?: string; cause?: string; urlKey?: string } = {}) {
  const built = buildFailureEntry(
    {
      urlKey: over.urlKey ?? 'https://example.com/login',
      what: over.what ?? 'login flow, step 2',
      cause: over.cause ?? 'no element matched the stored axis',
      tryInstead: 're-record this page',
      source: 'replay',
    },
    NOW,
  );
  if (!built.ok) throw new Error(`fixture refused: ${built.reason}`);
  return built.entry;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sitemem-'));
  store = new SiteMemoryStore(dir);
});

afterEach(async () => {
  await store.drain();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SiteMemoryStore', () => {
  it('keeps a protected namespace apart from the legacy workspace tree, in both directions', async () => {
    const ns = memoryNamespaceKey('ws-1', 'Work', '0123456789abcdef') as string;
    await store.recordFailure('ws-1', 'example.com', failureEntry(), NOW);
    const legacyBytes = fs.readFileSync(fileFor('ws-1', 'example.com'), 'utf8');
    // A protected namespace starts empty.
    expect(store.get(ns, 'example.com', NOW)).toBeNull();
    expect(await store.recordFailure(ns, 'example.com', failureEntry({ what: 'account step' }), NOW)).toBe(true);
    expect(store.get(ns, 'example.com', NOW)?.workspaceId).toBe(ns);
    // The legacy record is byte-for-byte what it was.
    expect(fs.readFileSync(fileFor('ws-1', 'example.com'), 'utf8')).toBe(legacyBytes);
    // A file copied between namespaces fails the self-check either way.
    fs.copyFileSync(fileFor('ws-1', 'example.com'), fileFor(ns, 'example.com'));
    expect(store.get(ns, 'example.com', NOW)).toBeNull();
    const other = memoryNamespaceKey('ws-1', 'Work', 'fedcba9876543210') as string;
    fs.mkdirSync(path.dirname(fileFor(other, 'x')), { recursive: true });
    fs.copyFileSync(fileFor(ns, 'example.com'), fileFor(other, 'example.com'));
    expect(store.get(other, 'example.com', NOW)).toBeNull();
  });

  it('never serves a record whose workspaceId disagrees with its directory', async () => {
    await store.recordFailure('ws-1', 'example.com', failureEntry(), NOW);
    const file = fileFor('ws-1', 'example.com');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The file was moved or copied from another workspace's tree.
    fs.writeFileSync(file, JSON.stringify({ ...record, workspaceId: 'ws-2' }));

    expect(store.get('ws-1', 'example.com', NOW)).toBeNull();
    expect(store.list('ws-1', NOW)).toHaveLength(0);
    // And it is not writable through the mismatched identity either.
    expect(await store.recordFailure('ws-1', 'example.com', failureEntry(), NOW)).toBe(false);
  });

  it('does not recreate a file that was forgotten mid-session', async () => {
    await store.recordFailure('ws-1', 'example.com', failureEntry(), NOW);
    expect(await store.forget('ws-1', 'example.com')).toEqual({ removed: 1 });
    expect(fs.existsSync(fileFor('ws-1', 'example.com'))).toBe(false);

    // A success counter on a domain with no record must not resurrect one.
    expect(await store.recordSuccess('ws-1', 'example.com', NOW)).toBe(false);
    expect(fs.existsSync(fileFor('ws-1', 'example.com'))).toBe(false);
    expect(store.get('ws-1', 'example.com', NOW)).toBeNull();
  });

  it('sweeps entries past the decay window and deletes the file past the delete window', async () => {
    await store.recordFailure('ws-1', 'example.com', failureEntry(), NOW);

    // Past the decay window: the entry is gone from what is served, but the
    // file is still there — decay is a read-path drop, not a delete.
    const afterDecay = NOW + SITE_MEMORY_DECAY_MS + 1;
    expect(store.get('ws-1', 'example.com', afterDecay)).toBeNull();
    expect(fs.existsSync(fileFor('ws-1', 'example.com'))).toBe(true);

    // The timer-registered sweep is what actually removes it.
    const afterDelete = NOW + SITE_MEMORY_DELETE_MS + 1;
    expect(await store.sweep(afterDelete)).toEqual({ removed: 1 });
    expect(fs.existsSync(fileFor('ws-1', 'example.com'))).toBe(false);
  });

  it('forget removes one entry, and the whole record when no entryId is given', async () => {
    const first = failureEntry({ what: 'login flow, step 2' });
    const second = failureEntry({ what: 'checkout flow, step 5' });
    const note = buildNoteEntry('the search box needs two clicks to focus', NOW);
    expect(note.ok).toBe(true);
    if (!note.ok) return;

    await store.recordFailure('ws-1', 'example.com', first, NOW);
    await store.recordFailure('ws-1', 'example.com', second, NOW);
    await store.recordNote('ws-1', 'example.com', note.entry, NOW);

    expect(await store.forget('ws-1', 'example.com', first.id)).toEqual({ removed: 1 });
    const left = store.get('ws-1', 'example.com', NOW);
    expect(left?.failures.map((e) => e.id)).toEqual([second.id]);
    expect(left?.notes).toHaveLength(1);

    expect(await store.forget('ws-1', 'example.com')).toEqual({ removed: 1 });
    expect(store.get('ws-1', 'example.com', NOW)).toBeNull();
    expect(fs.existsSync(fileFor('ws-1', 'example.com'))).toBe(false);
    // The backups atomicWriteJSON left behind go with it, or a forget would
    // leave the failure text readable in a sidecar.
    expect(fs.existsSync(`${fileFor('ws-1', 'example.com')}.bak`)).toBe(false);
  });
});
