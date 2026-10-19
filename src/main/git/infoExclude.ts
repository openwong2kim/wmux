// One line in a repository's `info/exclude`, added once (check, then
// append), one writer at a time across main: a bot's codex worker rules file
// (agents/codexWorkerGuard.ts) and a bot's skills copied into a worker's
// worktree (factory/botSkills.ts) both keep their files out of git this way,
// and a linked worktree's exclude file is the repository's common one.

import fs from 'node:fs';
import path from 'node:path';

let excludeLock: Promise<void> = Promise.resolve();

/** Append `line` to the exclude file at `file` unless it holds it already. */
export async function excludeLineOnce(file: string, line: string): Promise<void> {
  const run = async (): Promise<void> => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* missing: created below */
    }
    if (text.split(/\r?\n/).includes(line)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  };
  const next = excludeLock.then(run, run);
  excludeLock = next.catch(() => undefined);
  await next;
}
