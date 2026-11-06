import { describe, expect, it, vi } from 'vitest';
import { chooseLauncher, type LauncherChoiceInputs } from '../mcpLauncher';

const base: LauncherChoiceInputs = {
  packaged: false,
  brokerEnabled: true,
  nativeBinary: '/h/.wmux/mcp/wmux-native',
  brokerReady: async () => true,
  shimScript: '/h/.wmux/mcp/shim.js',
  bundleScript: '/h/.wmux/mcp/index.js',
};

describe('chooseLauncher', () => {
  it('takes the healthy native launcher without asking whether the broker is ready', async () => {
    const brokerReady = vi.fn(async () => false);
    expect(await chooseLauncher({ ...base, brokerReady })).toEqual({
      launcher: { kind: 'native', binary: base.nativeBinary }, lane: 'native',
    });
    expect(brokerReady).not.toHaveBeenCalled();
  });

  it('takes the node shim only while the broker answers', async () => {
    expect(await chooseLauncher({ ...base, nativeBinary: null })).toMatchObject({ lane: 'node-shim', launcher: { kind: 'node', script: base.shimScript } });
    expect(await chooseLauncher({ ...base, nativeBinary: null, brokerReady: async () => false })).toMatchObject({ lane: 'bundle' });
    expect(await chooseLauncher({ ...base, nativeBinary: null, shimScript: null })).toMatchObject({ lane: 'bundle' });
  });

  it('never takes the node shim in a packaged build: its native launcher, else the bundle', async () => {
    const brokerReady = vi.fn(async () => true);
    expect(await chooseLauncher({ ...base, packaged: true, nativeBinary: null, brokerReady })).toEqual({
      launcher: { kind: 'node', script: base.bundleScript }, lane: 'bundle',
    });
    expect(brokerReady).not.toHaveBeenCalled();
    expect(await chooseLauncher({ ...base, packaged: true })).toMatchObject({ lane: 'native' });
  });

  it('takes the bundle with the broker off, whatever else is there', async () => {
    const brokerReady = vi.fn(async () => true);
    expect(await chooseLauncher({ ...base, brokerEnabled: false, brokerReady })).toEqual({
      launcher: { kind: 'node', script: base.bundleScript }, lane: 'bundle',
    });
    expect(brokerReady).not.toHaveBeenCalled();
  });

  it('has nothing to offer without a bundle once native and shim are out', async () => {
    expect(await chooseLauncher({ ...base, nativeBinary: null, brokerReady: async () => false, bundleScript: null })).toBeNull();
  });
});
