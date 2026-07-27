import { describe, expect, it, vi } from 'vitest';
import type { SessionLocation } from '../sessionLocation';
import { SessionLocationEnricher } from '../sessionLocationEnrichment';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SessionLocationEnricher', () => {
  it('accepts a resolved distro into the current location', async () => {
    let current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
    };
    const accept = vi.fn((location: SessionLocation) => { current = location; });
    const enricher = new SessionLocationEnricher(async () => 'Ubuntu');

    await expect(enricher.enrich('pane-1', () => current, accept)).resolves.toBe(true);
    expect(current).toEqual({
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    });
  });

  it('preserves the latest cwd when resolution finishes', async () => {
    const result = deferred<string | undefined>();
    let current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/old',
      shell: 'wsl.exe',
    };
    const enricher = new SessionLocationEnricher(() => result.promise);
    const pending = enricher.enrich('pane-1', () => current, (location) => { current = location; });

    current = { ...current, cwd: '/home/me/new' };
    result.resolve('Ubuntu');

    await expect(pending).resolves.toBe(true);
    expect(current).toMatchObject({ cwd: '/home/me/new', distro: 'Ubuntu' });
  });

  it('does not resolve or overwrite an explicit distro', async () => {
    const resolve = vi.fn(async () => 'Debian');
    const current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const accept = vi.fn();
    const enricher = new SessionLocationEnricher(resolve);

    await expect(enricher.enrich('pane-1', () => current, accept)).resolves.toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('fails closed when the distro stays unresolved', async () => {
    const current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
    };
    const accept = vi.fn();
    const enricher = new SessionLocationEnricher(async () => undefined);

    await expect(enricher.enrich('pane-1', () => current, accept)).resolves.toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a result after the session closes', async () => {
    const result = deferred<string | undefined>();
    let current: SessionLocation | undefined = {
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
    };
    const accept = vi.fn();
    const enricher = new SessionLocationEnricher(() => result.promise);
    const pending = enricher.enrich('pane-1', () => current, accept);

    current = undefined;
    enricher.cancel('pane-1');
    result.resolve('Ubuntu');

    await expect(pending).resolves.toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a result from an older generation that reused the same id and shell', async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    const resolve = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    let current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/first',
      shell: 'wsl.exe',
    };
    const accepted: SessionLocation[] = [];
    const enricher = new SessionLocationEnricher(resolve);
    const oldPending = enricher.enrich('pane-1', () => current, (location) => {
      current = location;
      accepted.push(location);
    });

    current = { domain: 'wsl', cwd: '/home/me/second', shell: 'wsl.exe' };
    const newPending = enricher.enrich('pane-1', () => current, (location) => {
      current = location;
      accepted.push(location);
    });
    first.resolve('Stale');
    second.resolve('Ubuntu');

    await expect(oldPending).resolves.toBe(false);
    await expect(newPending).resolves.toBe(true);
    expect(accepted).toEqual([{
      domain: 'wsl',
      cwd: '/home/me/second',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    }]);
  });

  it('rejects a result after a newer explicit distro is registered', async () => {
    const result = deferred<string | undefined>();
    let current: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
    };
    const accept = vi.fn((location: SessionLocation) => { current = location; });
    const enricher = new SessionLocationEnricher(() => result.promise);
    const pending = enricher.enrich('pane-1', () => current, accept);

    current = { ...current, distro: 'Debian' };
    await enricher.enrich('pane-1', () => current, accept);
    result.resolve('Ubuntu');

    await expect(pending).resolves.toBe(false);
    expect(current.distro).toBe('Debian');
    expect(accept).not.toHaveBeenCalled();
  });
});
