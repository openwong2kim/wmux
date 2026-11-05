import { describe, expect, it } from 'vitest';
import { localHostNameArgs, localHostNameFromArgv } from '../localHostName';

describe('localHostName', () => {
  it('round-trips a host name through the renderer arguments', () => {
    const argv = ['electron', '--other=1', ...localHostNameArgs('miniwongui-Macmini.local')];
    expect(localHostNameFromArgv(argv)).toBe('miniwongui-Macmini.local');
    expect(localHostNameFromArgv(localHostNameArgs('dev_box'))).toBe('dev_box');
  });

  it('passes nothing that is not a plain host name', () => {
    for (const bad of ['', 'a b', 'host/x', '\\\\srv', '-lead', 'a..b', 'x'.repeat(64)]) {
      expect(localHostNameArgs(bad)).toEqual([]);
    }
    expect(localHostNameFromArgv(['--wmux-host-name=srv\\share'])).toBeNull();
    expect(localHostNameFromArgv(undefined)).toBeNull();
  });
});
