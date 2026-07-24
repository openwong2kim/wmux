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
const EXPECTED_DIR = path.join(FAKE_HOME, '.claude');
const EXPECTED_JSON = path.join(FAKE_HOME, '.claude.json');

function makeDirStat(): { isDirectory: () => boolean } {
  return { isDirectory: () => true };
}

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

  it('returns claudeFound + mcpRegistered when ~/.claude exists and ~/.claude.json has mcpServers.fmux', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { fmux: { command: 'fmux', args: ['mcp'] } } }),
    );

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: true,
      claudeJsonPath: EXPECTED_JSON,
    });
    expect(vi.mocked(fs.stat)).toHaveBeenCalledWith(EXPECTED_DIR);
    expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith(EXPECTED_JSON, 'utf8');
  });

  it('also treats a legacy mcpServers.wmux entry as registered', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['/old.js'] } } }),
    );

    const result = await new ClaudeDetector().detect();

    expect(result.mcpRegistered).toBe(true);
  });

  it('returns mcpRegistered:false when ~/.claude.json parses but lacks mcpServers.fmux', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }),
    );

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns mcpRegistered:false when ~/.claude.json is missing (ENOENT)', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockRejectedValueOnce(makeFsError('ENOENT'));

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('swallows SyntaxError when ~/.claude.json is malformed', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValueOnce('{not valid json');

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns mcpRegistered:false when ~/.claude.json read throws EACCES', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce(makeDirStat() as unknown as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockRejectedValueOnce(makeFsError('EACCES'));

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: true,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
  });

  it('returns claudeFound:false when ~/.claude is missing (ENOENT)', async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(makeFsError('ENOENT'));

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: false,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
    // Must short-circuit — never opens the JSON when the dir is gone.
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });

  it('returns claudeFound:false when stat throws EACCES (treat as not found, no crash)', async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(makeFsError('EACCES'));

    const result = await new ClaudeDetector().detect();

    expect(result).toEqual({
      claudeFound: false,
      mcpRegistered: false,
      claudeJsonPath: EXPECTED_JSON,
    });
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });
});
