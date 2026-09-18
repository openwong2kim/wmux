import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBackendStore } from '../BrowserBackendStore';

describe('BrowserBackendStore (#517)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-backend-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to builtin when no file exists', () => {
    expect(new BrowserBackendStore(dir).get()).toBe('builtin');
  });

  it('reads a persisted value synchronously at construction', () => {
    writeFileSync(join(dir, 'browser-backend.json'), JSON.stringify({ backend: 'external' }));
    expect(new BrowserBackendStore(dir).get()).toBe('external');
  });

  it('set persists and a fresh instance sees it (restart survival)', () => {
    new BrowserBackendStore(dir).set('external');
    expect(new BrowserBackendStore(dir).get()).toBe('external');
    expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({ backend: 'external' });
  });

  it('falls back to builtin on corrupt JSON', () => {
    writeFileSync(join(dir, 'browser-backend.json'), '{not json');
    expect(new BrowserBackendStore(dir).get()).toBe('builtin');
  });

  it('falls back to builtin on an unknown value', () => {
    writeFileSync(join(dir, 'browser-backend.json'), JSON.stringify({ backend: 'chrome-extension' }));
    expect(new BrowserBackendStore(dir).get()).toBe('builtin');
  });

  // Live-Chrome agent window: 'all' is the LARGER grant (every logged-in tab in
  // the user's browser), so every unclear input has to land on 'agent'.
  describe('liveWriteScope', () => {
    it("defaults to 'agent' — the narrow grant — with no file", () => {
      expect(new BrowserBackendStore(dir).liveWriteScope()).toBe('agent');
    });

    it('reads a persisted opt-out', () => {
      writeFileSync(
        join(dir, 'browser-backend.json'),
        JSON.stringify({ backend: 'chrome', liveWriteScope: 'all' }),
      );
      expect(new BrowserBackendStore(dir).liveWriteScope()).toBe('all');
    });

    it("an unknown value falls back to 'agent', not to the wider grant", () => {
      writeFileSync(
        join(dir, 'browser-backend.json'),
        JSON.stringify({ backend: 'chrome', liveWriteScope: 'everything' }),
      );
      expect(new BrowserBackendStore(dir).liveWriteScope()).toBe('agent');
    });

    it('persists across a restart, and keeps the backend with it', () => {
      const store = new BrowserBackendStore(dir);
      store.set('chrome');
      store.setLiveWriteScope('all');
      const reloaded = new BrowserBackendStore(dir);
      expect(reloaded.get()).toBe('chrome');
      expect(reloaded.liveWriteScope()).toBe('all');
    });

    it('a later backend write does not silently drop the scope', () => {
      const store = new BrowserBackendStore(dir);
      store.setLiveWriteScope('all');
      store.set('builtin');
      expect(new BrowserBackendStore(dir).liveWriteScope()).toBe('all');
    });

    it('writes no scope key while the default stands (the file keeps its shape)', () => {
      new BrowserBackendStore(dir).set('external');
      expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({
        backend: 'external',
      });
    });
  });
});
