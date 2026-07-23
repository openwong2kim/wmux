import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserExportPath } from '../utility';

describe('resolveBrowserExportPath', () => {
  let testHome: string;
  let exportRoot: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;

  beforeAll(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-browser-export-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    process.env.USERPROFILE = testHome;
    process.env.HOME = testHome;
    exportRoot = path.join(testHome, '.fmux', 'exports');
  });

  afterAll(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it('resolves default exports under the fmux export root', () => {
    expect(resolveBrowserExportPath(undefined, 'output.pdf')).toBe(
      path.join(exportRoot, 'output.pdf'),
    );
  });

  it('rejects absolute output paths', () => {
    expect(() => resolveBrowserExportPath(path.join(exportRoot, 'secret.pdf'), 'output.pdf')).toThrow(
      'Absolute output paths are not allowed',
    );
  });

  it('rejects traversal outside the export root', () => {
    expect(() => resolveBrowserExportPath('../outside.zip', 'trace.zip')).toThrow(
      'Output path escapes the export root',
    );
  });

  it('allows nested relative paths inside the export root', () => {
    expect(resolveBrowserExportPath('reports/run-1/trace.zip', 'trace.zip')).toBe(
      path.join(exportRoot, 'reports', 'run-1', 'trace.zip'),
    );
  });
});
