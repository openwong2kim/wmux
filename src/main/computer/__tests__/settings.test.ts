import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { readComputerUseEnabled } from '../../../shared/computer/config';
import { helperStatus, writeComputerUseEnabled } from '../settings';

function tempConfig(content?: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cu-')), 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

describe('computer use settings', () => {
  it('reads anything but a literal true as off', () => {
    expect(readComputerUseEnabled(tempConfig())).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{ nope'))).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{"computerUse":{"enabled":"true"}}'))).toBe(false);
    expect(readComputerUseEnabled(tempConfig('{"computerUse":{"enabled":true}}'))).toBe(true);
  });

  it('writes the switch and keeps every other key in the file', () => {
    const file = tempConfig(JSON.stringify({ version: 1, daemon: { pipeName: 'p' }, mcp: { firstPartyClients: ['x'] } }));
    expect(writeComputerUseEnabled(true, file)).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after).toEqual({
      version: 1,
      daemon: { pipeName: 'p' },
      mcp: { firstPartyClients: ['x'] },
      computerUse: { enabled: true },
    });
    expect(writeComputerUseEnabled(false, file)).toBe(false);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('refuses to write a file the daemon would reset', () => {
    expect(() => writeComputerUseEnabled(true, tempConfig())).toThrow(/missing or not valid JSON/);
    const broken = tempConfig('{ nope');
    expect(() => writeComputerUseEnabled(true, broken)).toThrow();
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ nope');
  });

  it('reports the helper as ready, missing, or unsupported', () => {
    const present = tempConfig('');
    expect(helperStatus(present)).toBe('ready');
    expect(helperStatus(path.join(os.tmpdir(), 'no-such-helper'))).toBe('missing');
    expect(helperStatus(null)).toBe('unsupported');
  });
});
