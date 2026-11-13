// changedFiles, the change verify.sh counts, on a temporary git repository.
// It runs git, so it sits in the integration lane.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedFiles } from '../lib/verify-source-readers.mjs';

describe('changedFiles', () => {
  it('counts a rename as its old path deleted and its new one added', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-verify-readers-'));
    try {
      const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
      git('init', '-q');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      git('mv', 'src/old.ts', 'src/new.ts');
      git('commit', '-q', '-m', 'rename');
      expect(changedFiles(root, base)).toEqual(['src/new.ts', 'src/old.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
