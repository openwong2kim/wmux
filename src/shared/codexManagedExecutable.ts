import {realpathSync, statSync} from 'node:fs';
import path from 'node:path';

/** Use the account's installed native binary, never a shell/npm shim. */
export function resolveCodexManagedExecutable(codeHome:string):string {
  const install = realpathSync(path.join(codeHome,'packages','app-server-daemon'));
  const executable = realpathSync(path.join(install,'current','bin','codex.exe'));
  const relative = path.relative(install,executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !statSync(executable).isFile()) {
    throw new Error('Invalid Codex managed executable');
  }
  return executable;
}
