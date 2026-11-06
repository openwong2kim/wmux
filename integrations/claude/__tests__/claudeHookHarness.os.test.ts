/**
 * The characterisation harness's own normalisation: what it masks has to be
 * exactly the volatile part, or a golden could hide a real difference.
 */
import { describe, expect, it } from 'vitest';
import { childEnv, normaliseStderr, normaliseString, withPrefix, type HomeChoice, type Sandbox } from './support/claudeHookHarness';

const winBox: Sandbox = {
  root: 'C:\\T\\wch-ab12',
  home: 'C:\\T\\wch-ab12\\home',
  cwd: 'C:\\T\\wch-ab12\\cwd',
  wmuxHome: 'C:\\T\\wch-ab12\\home\\.wmux-c0ffee',
  suffix: '-c0ffee',
};

describe('withPrefix', () => {
  const box: Sandbox = { root: '/tmp/wch-ab12', home: '/tmp/wch-ab12/home', cwd: '/tmp/wch-ab12/cwd', wmuxHome: '/tmp/wch-ab12/home/.wmux-c0ffee', suffix: '-c0ffee' };

  it('expands "<prefix>" into the prefix arguments, masked as the log they are compared with', () => {
    const prefix = ['/tmp/wch-ab12/stage/wmux-bridge.mjs', process.execPath, 'claude-hook'];
    expect(withPrefix({ argv: ['<impl>', '<prefix>', 'Bogus'] }, prefix, box)).toEqual({
      argv: ['<impl>', '<sandbox>/stage/wmux-bridge.mjs', '<node>', 'claude-hook', 'Bogus'],
    });
  });
});

describe('normaliseString', () => {
  it('turns separators into / only inside the sandbox path', () => {
    expect(normaliseString('at C:\\T\\wch-ab12\\home\\.wmux-c0ffee\\bridge.log: a\\nb "x\\"y"', winBox))
      .toBe('at <sandbox>/home/.wmux<sfx>/bridge.log: a\\nb "x\\"y"');
  });

  it('masks the forward-slash and JSON-escaped forms of the sandbox', () => {
    expect(normaliseString('{"cwd":"C:\\\\T\\\\wch-ab12\\\\cwd","q":"a\\\\b"} C:/T/wch-ab12/home', winBox))
      .toBe('{"cwd":"<sandbox>/cwd","q":"a\\\\b"} <sandbox>/home');
  });
});

describe('normaliseStderr', () => {
  const pidField = process.platform === 'darwin' ? `"agentPid":${process.pid},` : '';

  it('keeps the debug line byte for byte apart from ts and agentPid', () => {
    const problems: string[] = [];
    const line = `WMUX_BRIDGE_DEBUG_ENVELOPE={"kind":"agent.stop", "b":1.0,${pidField}"cwd":"/w","ts":1793947312161}`;
    expect(normaliseStderr(`${line}\nother\n`, problems))
      .toBe('WMUX_BRIDGE_DEBUG_ENVELOPE={"kind":"agent.stop", "b":1.0,"cwd":"/w","ts":"<ts>"}\nother\n');
    expect(problems).toEqual([]);
  });

  it('reports a debug line without a numeric ts', () => {
    const problems: string[] = [];
    normaliseStderr(`WMUX_BRIDGE_DEBUG_ENVELOPE={${pidField}"ts":"x"}`, problems);
    expect(problems).toContain('debug line has no numeric ts');
  });
  const masked = (trace: string): string => {
    const problems: string[] = [];
    const out = normaliseStderr(trace, problems);
    expect(problems).toEqual([]);
    return out;
  };

  it('collapses each run of node-internal frames, named, unnamed or aliased, and masks the version', () => {
    expect(masked([
      'RangeError: Maximum call stack size exceeded',
      '    at JSON.stringify (<anonymous>)',
      '    at Socket.<anonymous> (file://<bridge>:945:23)',
      '    at Socket.emit (node:events:531:35)',
      '    at PipeConnectWrap.afterConnect [as oncomplete] (node:net:1623:10)',
      '    at node:internal/process/task_queues:105:5',
      '    at async node:internal/modules/esm/loader:640:26',
      '    at main (file://<bridge>:1640:3)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      '',
      'Node.js v24.11.0',
    ].join('\n'))).toBe([
      'RangeError: Maximum call stack size exceeded',
      '    at JSON.stringify (<anonymous>)',
      '    at Socket.<anonymous> (file://<bridge>:945:23)',
      '    at <node internals>',
      '    at main (file://<bridge>:1640:3)',
      '    at <node internals>',
      '',
      'Node.js <version>',
    ].join('\n'));
  });

  it('leaves everything else as written', () => {
    const text = 'wait\n    at nothing\nNode.js is great\n';
    expect(masked(text)).toBe(text);
  });
});

describe('childEnv', () => {
  const homeDir = (choice: HomeChoice): string => (choice === 'alt' ? 'C:\\T\\wch-ab12\\alt' : winBox.home);
  const profileKeys = (env: NodeJS.ProcessEnv): string[] => Object.keys(env).filter((k) => /^userprofile$/i.test(k));

  it('leaves USERPROFILE out entirely, in any case, when the fixture unsets it', () => {
    const before = process.env.Userprofile;
    process.env.Userprofile = 'C:\\Users\\real';
    try {
      const env = childEnv({ homes: { USERPROFILE: 'unset' } }, winBox, homeDir);
      expect(profileKeys(env)).toEqual([]);
      expect(env.HOME).toBe(winBox.home);
    } finally {
      if (before === undefined) delete process.env.Userprofile;
      else process.env.Userprofile = before;
    }
  });

  it('passes an empty USERPROFILE through as set-but-empty', () => {
    const env = childEnv({ homes: { USERPROFILE: '' } }, winBox, homeDir);
    expect(profileKeys(env)).toEqual(['USERPROFILE']);
    expect(env.USERPROFILE).toBe('');
  });

  it('builds the env from nothing but the variables it names', () => {
    const env = childEnv({ homes: { HOME: 'alt' }, env: { X: '<wmux>' } }, winBox, homeDir, 'p');
    const allowed = ['PATH', 'HOME', 'USERPROFILE', 'WMUX_DATA_SUFFIX', 'WMUX_PIPE_NAME', 'X', 'SystemRoot', 'TEMP', 'TMP'];
    expect(Object.keys(env).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(env).toMatchObject({ HOME: 'C:\\T\\wch-ab12\\alt', USERPROFILE: winBox.home, WMUX_PIPE_NAME: 'p', X: '.wmux-c0ffee' });
  });
});
