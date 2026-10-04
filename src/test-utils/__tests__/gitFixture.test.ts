import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { disableGitMaintenance } from '../gitFixture';
import { copyDirSync } from '../copyDirSync';

it('commits cannot start background maintenance in a template or its copy', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-fixture-'));
  const repo = path.join(base, 'repo');
  const trace = path.join(base, 'trace.json');
  fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TRACE2_EVENT: trace },
    stdio: 'pipe',
  });
  try {
    git(repo, 'init', '-q', '-b', 'main');
    disableGitMaintenance(repo);
    for (const dir of [repo, path.join(base, 'copy')]) {
      if (dir !== repo) copyDirSync(repo, dir);
      fs.writeFileSync(path.join(dir, 'f.txt'), dir);
      git(dir, 'add', '-A');
      git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
    }
    const children = fs.readFileSync(trace, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'child_start')
      .map((event) => event.argv as string[]);
    // Even an otherwise empty maintenance run briefly owns maintenance.lock.
    // A detached run can outlive commit, race copying objects, or leave a copied lock.
    expect(children.filter((argv) => argv.includes('maintenance') || argv.includes('gc'))).toEqual([]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
