import { describe, expect, it } from 'vitest';
import { MODEL_ENV_MARKER } from '../workerLaunch';
import { withScreenReaderFlag } from '../screenReaderLaunch';

/** A claude new enough for its flag. */
const KNOWN = (): string | null => '2.1.316';

describe('withScreenReaderFlag', () => {
  it('adds claude\'s and gemini\'s own flag right after the launcher', () => {
    expect(withScreenReaderFlag('claude --model opus', true, KNOWN)).toBe('claude --ax-screen-reader --model opus');
    expect(withScreenReaderFlag('claude', true, KNOWN)).toBe('claude --ax-screen-reader');
    expect(withScreenReaderFlag('gemini "fix the build"', true, KNOWN)).toBe('gemini --screen-reader "fix the build"');
  });

  it('matches the launcher by its stem: a path, an extension, any case', () => {
    expect(withScreenReaderFlag('/abs/claude "go"', true, KNOWN)).toBe('/abs/claude --ax-screen-reader "go"');
    expect(withScreenReaderFlag('C:\\tools\\Gemini.exe', true, KNOWN)).toBe('C:\\tools\\Gemini.exe --screen-reader');
  });

  it('changes nothing while no screen reader is on', () => {
    expect(withScreenReaderFlag('claude', false, KNOWN)).toBe('claude');
  });

  it('leaves agents with no verified flag alone', () => {
    for (const line of ['codex', 'opencode', 'agy', 'aider', 'npm test', 'claude-foo', '']) {
      expect(withScreenReaderFlag(line, true, KNOWN)).toBe(line);
    }
  });

  it('does not add the flag twice', () => {
    expect(withScreenReaderFlag('claude --ax-screen-reader', true, KNOWN)).toBe('claude --ax-screen-reader');
    expect(withScreenReaderFlag('gemini --screen-reader=true', true, KNOWN)).toBe('gemini --screen-reader=true');
  });

  it('leaves a headless run alone', () => {
    for (const line of ['claude -p "hi"', 'claude --print "hi"', 'gemini -p "hi"', 'gemini --prompt "hi"', 'gemini --prompt=hi']) {
      expect(withScreenReaderFlag(line, true, KNOWN)).toBe(line);
    }
  });

  it('still adds it to gemini\'s interactive prompt, and to a quoted -p inside a prompt', () => {
    expect(withScreenReaderFlag('gemini -i "hi"', true, KNOWN)).toBe('gemini --screen-reader -i "hi"');
    expect(withScreenReaderFlag('claude "-p"', true, KNOWN)).toBe('claude --ax-screen-reader "-p"');
  });

  it('leaves a subcommand alone', () => {
    for (const line of ['claude auth login', 'claude mcp list', 'gemini extensions list']) {
      expect(withScreenReaderFlag(line, true, KNOWN)).toBe(line);
    }
  });

  it('adds it to a resumed or continued conversation', () => {
    expect(withScreenReaderFlag('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90', true, KNOWN))
      .toBe('claude --ax-screen-reader --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90');
    expect(withScreenReaderFlag('claude --continue', true, KNOWN)).toBe('claude --ax-screen-reader --continue');
  });

  it('keeps a leading worker model-env marker', () => {
    expect(withScreenReaderFlag(`${MODEL_ENV_MARKER}claude "go"`, true, KNOWN)).toBe(`${MODEL_ENV_MARKER}claude --ax-screen-reader "go"`);
    expect(withScreenReaderFlag(`${MODEL_ENV_MARKER}claude -p "go"`, true, KNOWN)).toBe(`${MODEL_ENV_MARKER}claude -p "go"`);
  });

  it('gives claude its flag from the first version that has it', () => {
    const asked: string[] = [];
    const at = (version: string | null) => (launcher: string) => { asked.push(launcher); return version; };
    expect(withScreenReaderFlag('claude', true, at('2.1.208'))).toBe('claude --ax-screen-reader');
    expect(withScreenReaderFlag('claude', true, at('3.0.0'))).toBe('claude --ax-screen-reader');
    expect(asked).toEqual(['claude', 'claude']);
  });

  it('gives an older claude none: it would refuse the unknown option', () => {
    expect(withScreenReaderFlag('claude', true, () => '2.1.207')).toBe('claude');
    expect(withScreenReaderFlag('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90', true, () => '2.0.999'))
      .toBe('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90');
  });

  it('gives a claude of unknown version none, and gemini its flag whatever the version', () => {
    expect(withScreenReaderFlag('claude "go"', true, () => null)).toBe('claude "go"');
    expect(withScreenReaderFlag('gemini', true, () => null)).toBe('gemini --screen-reader');
  });
});
