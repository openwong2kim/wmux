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
 *  they trust it. */
export function dubiousOwnershipMessage(path: string, command: string): string {
  return `git refuses to use ${path} because another user owns it ("dubious ownership"; Git for Windows sees every repository inside WSL that way). `
    + `If you trust this repository, run \`${command}\` and try again. wmux does not add this exception itself.`;
}
