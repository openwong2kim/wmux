import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBrokerLimitsConfig } from '../brokerConfig';
import { NO_BROKER_LIMITS } from '../../../shared/brokerLimits';

let dir = '';
let cfg = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcfg-'));
  cfg = path.join(dir, 'config.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readBrokerLimitsConfig', () => {
  it('reads mcp.broker from config.json', () => {
    fs.writeFileSync(cfg, JSON.stringify({ mcp: { mode: 'enforce', broker: { maxSessions: 12, maxRssMb: 0 } } }));
    expect(readBrokerLimitsConfig(cfg)).toEqual({ limits: { ...NO_BROKER_LIMITS, maxSessions: 12 }, ignored: [] });
  });

  it('no file, no mcp.broker, or a file that does not parse: no limit', () => {
    expect(readBrokerLimitsConfig(cfg)).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
    fs.writeFileSync(cfg, JSON.stringify({ mcp: { mode: 'enforce' } }));
    expect(readBrokerLimitsConfig(cfg)).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
    fs.writeFileSync(cfg, '{ not json');
    expect(readBrokerLimitsConfig(cfg)).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
  });

  it('names a setting it ignores', () => {
    fs.writeFileSync(cfg, '﻿' + JSON.stringify({ mcp: { broker: { maxSessions: 'ten' } } }));
    expect(readBrokerLimitsConfig(cfg)).toEqual({ limits: NO_BROKER_LIMITS, ignored: ['mcp.broker.maxSessions'] });
  });
});
