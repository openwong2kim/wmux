// The renderer build's wongtty factory plugin (vite.renderer.config.ts) must
// recognise factory.ts under every id Vite can hand it: the real path, the
// path through a symlinked checkout, with a query, and on win32 with the drive
// letter in either case, and name the chunk that holds it after the package.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath } from 'vite';

// Imported at run time, outside this typecheck program: the config's .mjs
// plugins have no types here.
const CONFIG = '../../../../../vite.renderer.config';
type Config = {
  wongttyFactory: () => { load(id: string): Promise<string | null> };
  default: { build: { rollupOptions: { output: { chunkFileNames: (chunk: { moduleIds: string[] }) => string } } } };
};
const config = async () => (await import(/* @vite-ignore */ CONFIG)) as Config;
const load = async (id: string) => (await config()).wongttyFactory().load(id);
const chunkName = async (moduleIds: string[]) => (await config()).default.build.rollupOptions.output.chunkFileNames({ moduleIds });
const WONGTTY_CHUNK = 'assets/wongtty-[hash].js';

const FACTORY_DIR = path.resolve(__dirname, '..');
const isFactory = (code: string | null) => typeof code === 'string' && code.startsWith('export function createWongtty() {');

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('wongtty factory plugin', { timeout: 60_000 }, () => {
  it('builds factory.ts from its real path, with or without a query', async () => {
    const id = normalizePath(path.join(FACTORY_DIR, 'factory.ts'));
    expect(isFactory(await load(id))).toBe(true);
    expect(isFactory(await load(`${id}?v=1a2b3c`))).toBe(true);
  });

  it('builds factory.ts reached through a symlinked directory', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wongtty-factory-'));
    const link = path.join(tmp, 'wongtty');
    fs.symlinkSync(FACTORY_DIR, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isFactory(await load(normalizePath(path.join(link, 'factory.ts'))))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('builds factory.ts whatever the case of the drive letter', async () => {
    const id = normalizePath(path.join(FACTORY_DIR, 'factory.ts'));
    for (const drive of [id[0].toLowerCase(), id[0].toUpperCase()]) {
      expect(isFactory(await load(drive + id.slice(1)))).toBe(true);
    }
  });

  it('leaves every other module alone', async () => {
    expect(await load(normalizePath(path.join(FACTORY_DIR, 'load.ts')))).toBeNull();
    expect(await load('/elsewhere/terminal/wongtty/factory.ts')).toBeNull();
  });

  it('names the chunk that holds factory.ts after the package, under the ids load takes', async () => {
    const id = normalizePath(path.join(FACTORY_DIR, 'factory.ts'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wongtty-factory-'));
    const link = path.join(tmp, 'wongtty');
    fs.symlinkSync(FACTORY_DIR, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const factory of [id, normalizePath(path.join(link, 'factory.ts'))]) {
      expect(await chunkName([normalizePath(path.join(FACTORY_DIR, 'load.ts')), factory])).toBe(WONGTTY_CHUNK);
    }
    expect(await chunkName([normalizePath(path.join(FACTORY_DIR, 'load.ts'))])).toBe('assets/[name]-[hash].js');
    expect(await chunkName(['/elsewhere/terminal/wongtty/factory.ts'])).toBe('assets/[name]-[hash].js');
  });

  it.runIf(process.platform === 'win32')('names the factory chunk whatever the case of the drive letter', async () => {
    const id = normalizePath(path.join(FACTORY_DIR, 'factory.ts'));
    for (const drive of [id[0].toLowerCase(), id[0].toUpperCase()]) {
      expect(await chunkName([drive + id.slice(1)])).toBe(WONGTTY_CHUNK);
    }
  });
});
