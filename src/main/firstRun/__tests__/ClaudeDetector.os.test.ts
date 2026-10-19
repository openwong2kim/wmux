import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { ClaudeDetector } from '../ClaudeDetector';

const FAKE_HOME = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test';
const EXPECTED_JSON = path.join(FAKE_HOME, '.claude.json');

function makeFsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('ClaudeDetector', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(FAKE_HOME);
    vi.mocked(fs.stat).mockReset();
    vi.mocked(fs.readFile).mockReset();
  });

  it('returns claudeFound + mcpRegistered when ~/.claude exists and ~/.claude.json has mcpServers.wmux', async () => {
    const detector = new ClaudeDetector(() => '/usr/local/bin/claude');
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { wmux: { command: 'wmux', args: ['mcp'] } } }),
    );

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: true,
      claudeJsonPath: EXPECTED_JSON,
    });
    expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith(EXPECTED_JSON, 'utf8');
  });

  it('returns mcpRegistered:false when ~/.claude.json parses but lacks mcpServers.wmux', async () => {
    const detector = new ClaudeDetector(() => '/usr/local/bin/claude');
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }),
    );

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns mcpRegistered:false when ~/.claude.json is missing (ENOENT)', async () => {
    const detector = new ClaudeDetector(() => '/usr/local/bin/claude');
    vi.mocked(fs.readFile).mockRejectedValueOnce(makeFsError('ENOENT'));

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('swallows SyntaxError when ~/.claude.json is malformed', async () => {
    const detector = new ClaudeDetector(() => '/usr/local/bin/claude');
    vi.mocked(fs.readFile).mockResolvedValueOnce('{not valid json');

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns mcpRegistered:false when ~/.claude.json read throws EACCES', async () => {
    const detector = new ClaudeDetector(() => '/usr/local/bin/claude');
    vi.mocked(fs.readFile).mockRejectedValueOnce(makeFsError('EACCES'));

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns claudeFound:false when no claude executable resolves', async () => {
    const detector = new ClaudeDetector(() => null);

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: false,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
    // Must short-circuit — never opens the JSON when claude is not installed.
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });

  it('returns claudeFound:false when the resolver throws EACCES (treat as not found, no crash)', async () => {
    const detector = new ClaudeDetector(() => { throw makeFsError('EACCES'); });

    const result = await detector.detect();

    expect(result).toEqual({
      claudeFound: false,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });

  it('reports claude found from the executable even before ~/.claude exists (first run)', async () => {
    const detector = new ClaudeDetector(() => '/opt/homebrew/bin/claude');
    vi.mocked(fs.readFile).mockRejectedValueOnce(makeFsError('ENOENT'));
    const result = await detector.detect();
    expect(result.claudeFound).toBe(true);
  });
});
