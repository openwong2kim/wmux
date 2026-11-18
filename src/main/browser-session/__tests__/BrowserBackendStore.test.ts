import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

    it('an operator edit to the file takes effect without a restart, and a backend write keeps it', () => {
      // The setting is operator-only and deliberately lives in the file; an
      // edit there must be honoured by the next RPC, not by the next launch —
      // and the next Settings change must not overwrite it with the boot value.
      const store = new BrowserBackendStore(dir);
      expect(store.liveWriteScope()).toBe('agent');
      writeFileSync(
        join(dir, 'browser-backend.json'),
        JSON.stringify({ backend: 'chrome', liveWriteScope: 'all' }),
      );
      expect(store.liveWriteScope()).toBe('all');
      store.set('chrome');
      expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({
        backend: 'chrome',
        liveWriteScope: 'all',
      });
      // Removing the key narrows the grant again, on the next read.
      writeFileSync(join(dir, 'browser-backend.json'), JSON.stringify({ backend: 'chrome' }));
      expect(store.liveWriteScope()).toBe('agent');
    });

    it('writes no scope key while the default stands (the file keeps its shape)', () => {
      new BrowserBackendStore(dir).set('external');
      expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({
        backend: 'external',
      });
    });
  });

  // Settings → Browser → Allow private network addresses. It widens what an
  // agent may reach, so only a literal true opts in.
  describe('allowPrivateNetwork', () => {
    it('defaults to off with no file', () => {
      expect(new BrowserBackendStore(dir).allowPrivateNetwork()).toBe(false);
    });

    it('reads only a literal true as on', () => {
      for (const value of [true, 'true', 1, 'yes', null]) {
        writeFileSync(join(dir, 'browser-backend.json'), JSON.stringify({ backend: 'builtin', allowPrivateNetwork: value }));
        expect(new BrowserBackendStore(dir).allowPrivateNetwork(), JSON.stringify(value)).toBe(value === true);
      }
    });

    it('takes effect at once and persists across a restart', () => {
      const store = new BrowserBackendStore(dir);
      store.setAllowPrivateNetwork(true);
      expect(store.allowPrivateNetwork()).toBe(true);
      expect(new BrowserBackendStore(dir).allowPrivateNetwork()).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({
        backend: 'builtin',
        allowPrivateNetwork: true,
      });

      store.setAllowPrivateNetwork(false);
      expect(store.allowPrivateNetwork()).toBe(false);
      expect(new BrowserBackendStore(dir).allowPrivateNetwork()).toBe(false);
      // Off is the default, so the key is gone again.
      expect(JSON.parse(readFileSync(join(dir, 'browser-backend.json'), 'utf8'))).toEqual({ backend: 'builtin' });
    });

    // A directory where the temp file goes makes every write fail, the way a
    // full disk or a locked file would.
    function breakWrites(): void {
      mkdirSync(join(dir, 'browser-backend.json.tmp'));
    }

    it('reports a failed write; turning off still applies for this session', () => {
      const store = new BrowserBackendStore(dir);
      expect(store.setAllowPrivateNetwork(true)).toBe(true);
      breakWrites();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(store.setAllowPrivateNetwork(false)).toBe(false);
      expect(store.allowPrivateNetwork()).toBe(false);
      expect(errors).toHaveBeenCalledWith('[BrowserBackendStore] persist failed:', expect.anything());
      // The file still says on: a restart would bring it back, which is why
      // the caller has to be told.
      expect(new BrowserBackendStore(dir).allowPrivateNetwork()).toBe(true);
      errors.mockRestore();
    });

    it('reports a failed write; turning on does not apply at all', () => {
      const store = new BrowserBackendStore(dir);
      breakWrites();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(store.setAllowPrivateNetwork(true)).toBe(false);
      expect(store.allowPrivateNetwork()).toBe(false);
      errors.mockRestore();
    });

    it('survives the other settings in the same file being written', () => {
      const store = new BrowserBackendStore(dir);
      store.setAllowPrivateNetwork(true);
      store.set('chrome');
      store.setLiveWriteScope('all');
      const reloaded = new BrowserBackendStore(dir);
      expect(reloaded.allowPrivateNetwork()).toBe(true);
      expect(reloaded.get()).toBe('chrome');
      expect(reloaded.liveWriteScope()).toBe('all');
    });
  });

  describe('protectedPortTransport', () => {
    const file = () => join(dir, 'browser-backend.json');

    it('is off with no file, and on only for a literal true', () => {
      expect(new BrowserBackendStore(dir).protectedPortTransport()).toBe(false);
      writeFileSync(file(), JSON.stringify({ backend: 'chrome', protectedPortTransport: 'true' }));
      expect(new BrowserBackendStore(dir).protectedPortTransport()).toBe(false);
      writeFileSync(file(), JSON.stringify({ backend: 'chrome', protectedPortTransport: 1 }));
      expect(new BrowserBackendStore(dir).protectedPortTransport()).toBe(false);
      writeFileSync(file(), JSON.stringify({ backend: 'chrome', protectedPortTransport: true }));
      expect(new BrowserBackendStore(dir).protectedPortTransport()).toBe(true);
    });

    it('an operator edit takes effect on the next read, and a backend write keeps it', () => {
      const store = new BrowserBackendStore(dir);
      expect(store.protectedPortTransport()).toBe(false);
      writeFileSync(file(), JSON.stringify({ backend: 'chrome', protectedPortTransport: true }));
      expect(store.protectedPortTransport()).toBe(true);
      store.set('chrome');
      expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ backend: 'chrome', protectedPortTransport: true });
      store.setAllowPrivateNetwork(true);
      expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ protectedPortTransport: true });
      // Removing the key turns it off again, on the next read.
      writeFileSync(file(), JSON.stringify({ backend: 'chrome' }));
      expect(store.protectedPortTransport()).toBe(false);
    });

    it('writes no key while it is off (the file keeps its shape)', () => {
      new BrowserBackendStore(dir).set('external');
      expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ backend: 'external' });
    });
  });
});
