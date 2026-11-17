// @wmux-lane unit
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROKER_SETTING_FILE, readBrokerSetting, writeBrokerSetting } from '../brokerSetting';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-broker-setting-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('mcp-broker.json', () => {
  it('no file reads as default, with nothing to report', () => {
    expect(readBrokerSetting(dir)).toEqual({ setting: 'default' });
  });

  it('writes {v: 1, broker} and reads it back', () => {
    for (const setting of ['on', 'off', 'default'] as const) {
      writeBrokerSetting(setting, dir);
      expect(JSON.parse(fs.readFileSync(path.join(dir, BROKER_SETTING_FILE), 'utf8'))).toEqual({ v: 1, broker: setting });
      expect(readBrokerSetting(dir)).toEqual({ setting });
    }
  });

  it('writes through a temp file and leaves none behind', () => {
    writeBrokerSetting('on', dir);
    expect(fs.readdirSync(dir)).toEqual([BROKER_SETTING_FILE]);
  });

  it.each([
    ['not JSON', '{', 'not valid JSON'],
    ['another version', JSON.stringify({ v: 2, broker: 'on' }), 'not a v1 setting'],
    ['an unknown value', JSON.stringify({ v: 1, broker: 'yes' }), 'not a v1 setting'],
    ['an array', '[]', 'not a v1 setting'],
  ])('a file holding %s reads as default and says why', (_name, body, why) => {
    fs.writeFileSync(path.join(dir, BROKER_SETTING_FILE), body);
    const read = readBrokerSetting(dir);
    expect(read.setting).toBe('default');
    expect(read.problem).toContain(why);
  });

  it('accepts a byte order mark', () => {
    fs.writeFileSync(path.join(dir, BROKER_SETTING_FILE), '\uFEFF' + JSON.stringify({ v: 1, broker: 'off' }));
    expect(readBrokerSetting(dir)).toEqual({ setting: 'off' });
  });
});
