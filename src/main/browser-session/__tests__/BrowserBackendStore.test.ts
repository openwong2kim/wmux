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
});
