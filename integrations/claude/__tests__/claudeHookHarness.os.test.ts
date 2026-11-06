/**
 * The characterisation harness's own normalisation: what it masks has to be
 * exactly the volatile part, or a golden could hide a real difference.
 */
import { describe, expect, it } from 'vitest';
import { normaliseStderr, normaliseString, type Sandbox } from './support/claudeHookHarness';

const winBox: Sandbox = {
  root: 'C:\\T\\wch-ab12',
  home: 'C:\\T\\wch-ab12\\home',
  cwd: 'C:\\T\\wch-ab12\\cwd',
  wmuxHome: 'C:\\T\\wch-ab12\\home\\.wmux-c0ffee',
  suffix: '-c0ffee',
};

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
});
