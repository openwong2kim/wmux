import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCwd } from '../pty.handler';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWindowsPath(target: string, exists = true, directory = true): void {
  vi.spyOn(path, 'resolve').mockReturnValue(target);
  vi.spyOn(fs, 'existsSync').mockReturnValue(exists);
  vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => directory } as fs.Stats);
}

describe('validateCwd host UNC handling', () => {
  it.each([
    '\\\\wsl$\\Ubuntu\\home\\me',
    '\\\\WSL.LOCALHOST\\Ubuntu\\home\\me',
  ])('accepts an existing WSL UNC directory: %s', (cwd) => {
    mockWindowsPath(cwd);
    expect(validateCwd(cwd, 'pwsh.exe')).toBe(cwd);
  });

  it('continues to reject an ordinary UNC path', () => {
    const cwd = '\\\\server\\share';
    mockWindowsPath(cwd);
    expect(validateCwd(cwd, 'pwsh.exe')).toBeUndefined();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it.each([
    { exists: false, directory: true },
    { exists: true, directory: false },
  ])('still validates WSL UNC existence and directory type: %o', ({ exists, directory }) => {
    const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\me';
    mockWindowsPath(cwd, exists, directory);
    expect(validateCwd(cwd, 'pwsh.exe')).toBeUndefined();
  });
});
