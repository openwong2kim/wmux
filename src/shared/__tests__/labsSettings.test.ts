import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-labs-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('labs settings', () => {
  it('reads off when the file is missing, unreadable or holds anything but true', async () => {
    const labs = await import('../labsSettings');
    const file = path.join(dir, 'labs.json');
    expect(labs.readLabsSettings(file)).toEqual({ ringCompression: false });
    for (const body of ['not json', '{"ringCompression":"yes"}', '{"ringCompression":1}', 'null']) {
      fs.writeFileSync(file, body);
      expect(labs.readLabsSettings(file)).toEqual({ ringCompression: false });
    }
    expect(() => labs.writeLabsSettings({ ringCompression: 'on' } as never, file)).toThrow();
  });

  it('sees compression already turned on in config.json', async () => {
    const labs = await import('../labsSettings');
    const config = path.join(dir, 'config.json');
    expect(labs.ringCompressionInConfig(config)).toBe(false);
    fs.writeFileSync(config, '{"session":{"ringCompression":false}}');
    expect(labs.ringCompressionInConfig(config)).toBe(false);
    fs.writeFileSync(config, '{"session":{"ringCompression":true}}');
    expect(labs.ringCompressionInConfig(config)).toBe(true);
  });

  it('saves to this instance\'s data dir and the terminal host keeps its startup value', async () => {
    const labs = await import('../labsSettings');
    expect(labs.labsSettingsPath()).toBe(path.join(dir, '.wmux-test', 'labs.json'));
    expect(labs.labsSettingsAtStartup()).toEqual({ ringCompression: false });
    fs.mkdirSync(path.join(dir, '.wmux-test'));
    labs.writeLabsSettings({ ringCompression: true });
    expect(labs.readLabsSettings()).toEqual({ ringCompression: true });
    expect(labs.labsSettingsAtStartup()).toEqual({ ringCompression: false });
  });
});
