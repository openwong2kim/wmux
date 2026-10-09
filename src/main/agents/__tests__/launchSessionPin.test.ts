import { describe, expect, it } from 'vitest';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';
import { withLaunchSessionPin } from '../launchSessionPin';

const U = '7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90';
const mint = () => U;

describe('withLaunchSessionPin (A1)', () => {
  it('pins a typed fresh claude launch', () => {
    expect(withLaunchSessionPin({ initialCommand: 'claude --model opus' }, mint)?.initialCommand).toBe(`claude --session-id ${U} --model opus`);
  });
  it('keeps a leading worker model-env marker', () => {
    expect(withLaunchSessionPin({ initialCommand: `${MODEL_ENV_MARKER}claude "go"` }, mint)?.initialCommand)
      .toBe(`${MODEL_ENV_MARKER}claude --session-id ${U} "go"`);
  });
  it('returns the same options for anything it does not pin', () => {
    for (const options of [{ initialCommand: 'claude --resume' }, { initialCommand: 'codex' }, { initialCommand: 'npm test' }, {}]) {
      expect(withLaunchSessionPin(options, mint)).toBe(options);
    }
    expect(withLaunchSessionPin(undefined, mint)).toBeUndefined();
  });
  it('never touches an exec unit', () => {
    const options = { exec: 'claude', initialCommand: undefined };
    expect(withLaunchSessionPin(options, mint)).toBe(options);
  });
  it('mints a real UUID by default', () => {
    expect(withLaunchSessionPin({ initialCommand: 'claude' })?.initialCommand).toMatch(/^claude --session-id [0-9a-f-]{36}$/);
  });
});
