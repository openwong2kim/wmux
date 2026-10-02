import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { computerUseConfigPath, readComputerUseEnabled } from '../../../shared/computer/config';
import { getConfigPath } from '../../../daemon/config';
import { helperStatus, writeComputerUseEnabled } from '../settings';

function tempConfig(content?: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cu-')), 'computer-use.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

describe('computer use settings', () => {
  it('reads anything but a literal true as off', () => {
    expect(readComputerUseEnabled(tempConfig())).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{ nope'))).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{"enabled":"true"}'))).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{"enabled":true}'))).toBe(true);
  });

  it('writes the switch atomically and keeps other keys', () => {
    const file = tempConfig(JSON.stringify({ enabled: false, note: 'kept' }));
    expect(writeComputerUseEnabled(true, file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabled: true, note: 'kept' });
    expect(writeComputerUseEnabled(false, file)).toBe(false);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('creates a missing file and replaces an unreadable one', () => {
    const missing = tempConfig();
    expect(writeComputerUseEnabled(true, missing)).toBe(true);
    const broken = tempConfig('{ nope');
    expect(writeComputerUseEnabled(true, broken)).toBe(true);
    expect(JSON.parse(fs.readFileSync(broken, 'utf8'))).toEqual({ enabled: true });
  });

  it('lives beside the daemon config, never in it, under any data suffix', () => {
    // The daemon rewrites config.json from the copy it loaded at boot, so the
    // switch must not share that file — and main and the MCP server must both
    // resolve the same suffixed directory.
    const prev = process.env.WMUX_DATA_SUFFIX;
    try {
      for (const suffix of ['', '-cu']) {
        process.env.WMUX_DATA_SUFFIX = suffix;
        expect(computerUseConfigPath()).toBe(path.join(os.homedir(), `.wmux${suffix}`, 'computer-use.json'));
        expect(computerUseConfigPath()).not.toBe(getConfigPath());
        expect(path.dirname(computerUseConfigPath())).toBe(path.dirname(getConfigPath()));
      }
    } finally {
      if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX;
      else process.env.WMUX_DATA_SUFFIX = prev;
    }
  });

  it('reports the helper as ready, missing, or unsupported', () => {
    const present = tempConfig('');
    fs.chmodSync(present, 0o755);
    expect(helperStatus(present)).toBe('ready');
    expect(helperStatus(path.join(os.tmpdir(), 'no-such-helper'))).toBe('missing');
    expect(helperStatus(null)).toBe('unsupported');
  });

  it.skipIf(process.platform === 'win32')('treats a helper without the exec bit as missing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cu-')), 'helper');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    expect(helperStatus(file)).toBe('missing');
    fs.chmodSync(file, 0o755);
    expect(helperStatus(file)).toBe('ready');
    expect(helperStatus(`${file}-nope`)).toBe('missing');
    expect(helperStatus(null)).toBe('unsupported');
  });
});
