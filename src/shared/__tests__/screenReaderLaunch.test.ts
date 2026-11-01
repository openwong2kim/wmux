import { describe, expect, it } from 'vitest';
import { MODEL_ENV_MARKER } from '../workerLaunch';
import { withScreenReaderFlag } from '../screenReaderLaunch';

describe('withScreenReaderFlag', () => {
  it('adds claude\'s and gemini\'s own flag right after the launcher', () => {
    expect(withScreenReaderFlag('claude --model opus', true)).toBe('claude --ax-screen-reader --model opus');
    expect(withScreenReaderFlag('claude', true)).toBe('claude --ax-screen-reader');
    expect(withScreenReaderFlag('gemini "fix the build"', true)).toBe('gemini --screen-reader "fix the build"');
  });

  it('matches the launcher by its stem: a path, an extension, any case', () => {
    expect(withScreenReaderFlag('/abs/claude "go"', true)).toBe('/abs/claude --ax-screen-reader "go"');
    expect(withScreenReaderFlag('C:\\tools\\Gemini.exe', true)).toBe('C:\\tools\\Gemini.exe --screen-reader');
  });

  it('changes nothing while no screen reader is on', () => {
    expect(withScreenReaderFlag('claude', false)).toBe('claude');
  });

  it('leaves agents with no verified flag alone', () => {
    for (const line of ['codex', 'opencode', 'agy', 'aider', 'npm test', 'claude-foo', '']) {
      expect(withScreenReaderFlag(line, true)).toBe(line);
    }
  });

  it('does not add the flag twice', () => {
    expect(withScreenReaderFlag('claude --ax-screen-reader', true)).toBe('claude --ax-screen-reader');
    expect(withScreenReaderFlag('gemini --screen-reader=true', true)).toBe('gemini --screen-reader=true');
  });

  it('leaves a headless run alone', () => {
    for (const line of ['claude -p "hi"', 'claude --print "hi"', 'gemini -p "hi"', 'gemini --prompt "hi"', 'gemini --prompt=hi']) {
      expect(withScreenReaderFlag(line, true)).toBe(line);
    }
  });

  it('still adds it to gemini\'s interactive prompt, and to a quoted -p inside a prompt', () => {
    expect(withScreenReaderFlag('gemini -i "hi"', true)).toBe('gemini --screen-reader -i "hi"');
    expect(withScreenReaderFlag('claude "-p"', true)).toBe('claude --ax-screen-reader "-p"');
  });

  it('leaves a subcommand alone', () => {
    for (const line of ['claude auth login', 'claude mcp list', 'gemini extensions list']) {
      expect(withScreenReaderFlag(line, true)).toBe(line);
    }
  });

  it('adds it to a resumed or continued conversation', () => {
    expect(withScreenReaderFlag('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90', true))
      .toBe('claude --ax-screen-reader --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90');
    expect(withScreenReaderFlag('claude --continue', true)).toBe('claude --ax-screen-reader --continue');
  });

  it('keeps a leading worker model-env marker', () => {
    expect(withScreenReaderFlag(`${MODEL_ENV_MARKER}claude "go"`, true)).toBe(`${MODEL_ENV_MARKER}claude --ax-screen-reader "go"`);
    expect(withScreenReaderFlag(`${MODEL_ENV_MARKER}claude -p "go"`, true)).toBe(`${MODEL_ENV_MARKER}claude -p "go"`);
  });
});
