// ─── git's "dubious ownership" refusal, told apart from "not a repository" ──
//
// Git refuses a repository owned by another user unless `safe.directory`
// names it. Git for Windows sees every repository inside WSL
// (`\\wsl.localhost\<distro>\…`) that way, and a task worktree whose gitdir is
// there too. The refusal reads like any other git failure to a caller that
// only looks at the exit code, so a WSL repository was reported as "not a git
// checkout" (#2231). This recognises it and names the exact command git itself
// suggests. wmux never adds the exception on its own: `safe.directory` is a
// security setting, and trusting another user's repository is the owner's call.

/** The stderr of a git refusal over ownership: the command git prints to
 *  add the exception (verbatim, so Git for Windows' `%(prefix)/` for a
 *  network path is kept), or one built from `path` when git printed none.
 *  Null for any other failure. Pure. */
export function dubiousOwnership(stderr: string, path: string): { command: string } | null {
  // The headline is translated in a localized git; the command line is not.
  const printed = /^\s*(git config --global --add safe\.directory .+?)\s*$/m.exec(stderr);
  if (printed) return { command: printed[1] };
  if (!/dubious ownership/i.test(stderr)) return null;
  return { command: `git config --global --add safe.directory '${path.replace(/\\/g, '/')}'` };
}

/** One sentence for the owner: why git refused `path`, and what to run if
 *  they trust it. `taskFolders`: wmux's task worktree root. Git for Windows
 *  checks a task worktree whose repository is inside WSL by the worktree's
 *  own path, so one `'<root>/*'` entry (git 2.46+ reads a trailing `/*` as
 *  "everything under") covers every task folder instead of one per task. */
export function dubiousOwnershipMessage(path: string, command: string, taskFolders?: string): string {
  const root = taskFolders ? `${taskFolders.replace(/\\/g, '/').replace(/\/+$/, '')}/*` : '';
  const all = root ? safeDirectoryFor(root) : '';
  return `git refuses to use ${path} because another user owns it ("dubious ownership"; Git for Windows sees every repository inside WSL that way). `
    + `If you trust this repository, run ${pasteable(command)} and try again.`
    + (all ? ` Its task folders need one more, once for all of them: ${all}.` : '')
    + ' wmux does not add this exception itself.';
}

const SAFE_DIRECTORY_ADD = 'git config --global --add safe.directory ';

/**
 * A safe.directory command the owner can paste into whichever shell they
 * use. Command Prompt keeps single quotes as part of the value, so a path
 * that needs no escaping anywhere (no `"`, `%`, `!`, `$` or backtick) is
 * given in double quotes, which cmd, PowerShell and Git Bash all read the
 * same way. Any other command is shown as it is, marked for PowerShell or Git
 * Bash. Returned in backticks. Pure.
 */
export function pasteable(command: string): string {
  const m = /^git config --global --add safe\.directory '([^']*)'$/.exec(command.trim());
  if (m) return safeDirectoryFor(m[1]) || `\`${command}\` (in PowerShell or Git Bash)`;
  return `\`${command}\``;
}

/** The command for one path, as pasteable says; '' when no quoting works. */
function safeDirectoryFor(dir: string): string {
  if (!/["%!$`\r\n]/.test(dir)) return `\`${SAFE_DIRECTORY_ADD}"${dir}"\``;
  if (!dir.includes("'")) return `\`${SAFE_DIRECTORY_ADD}'${dir}'\` (in PowerShell or Git Bash)`;
  return '';
}

/** A read git refused over ownership: its message is the explanation, so a
 *  caller puts it first. */
export class DubiousOwnershipError extends Error {}
