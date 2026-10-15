// `wmux secrets check-staged` — the check behind the pre-commit hook wmux
// installs (main/git/secretHook.ts). Reads what is staged in the current
// repository and refuses (exit 1) when it adds a secret file or a key-shaped
// value, or when the check itself cannot run (fail closed). Same rules as the
// Git page, Moa delivery and log redaction (shared/secretGuard.ts,
// shared/redactSecrets.ts). Never prints a value.
import { execFileSync } from 'child_process';
import { scanDiff, type GitLines } from '../../main/git/secretScan';
import type { SecretFinding } from '../../shared/secretGuard';

const KIND_WORDS: Record<SecretFinding['kind'], string> = {
  env: 'passwords and keys', credentials: 'login credentials', 'private-key': 'a private key',
  anthropic: 'an AI service API key', openai: 'an AI service API key', github: 'a GitHub token', gitlab: 'a GitLab token',
  aws: 'an AWS access key', stripe: 'a Stripe secret key', slack: 'a Slack token',
  npm: 'an npm token', twilio: 'a Twilio key', random: 'what looks like a password or key',
};

/** The message a blocked commit prints: plain words, one line per finding. */
export function formatBlockedCommit(findings: readonly SecretFinding[]): string {
  const lines = ['', 'wmux stopped this commit: it would save a password or key into git.', ''];
  for (const f of findings) {
    lines.push(f.what === 'file'
      ? `  - ${f.path}: this file holds ${KIND_WORDS[f.kind]}.`
      : `  - ${f.path}${f.line ? ` line ${f.line}` : ''}: this looks like ${f.kind === 'random' ? 'a password or key' : KIND_WORDS[f.kind]}.`);
  }
  lines.push(
    '',
    'Take it out of the commit (git restore --staged <file>), keep files like .env in .gitignore,',
    'and keep keys out of code. Then commit again.',
    '',
  );
  return lines.join('\n');
}

export const SCAN_FAILED_MESSAGE = '\nwmux could not check this commit for passwords and keys, so it stopped the commit. Try again; if it keeps failing, commit fewer files at a time.\n';

/** Exit code: 0 clean, 1 blocked or the check failed. */
export async function checkStaged(cwd: string, git: (args: string[]) => Promise<string | null>, err: (s: string) => void): Promise<number> {
  // Feed git's whole output to the line-streaming scanner, split the way
  // spawnGitLines splits it (on \n, no trailing empty line).
  const run: GitLines = async (a, onLine) => {
    const out = await git(a);
    if (out === null) return false;
    const lines = out.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) onLine(l);
    return true;
  };
  const scan = await scanDiff(run, ['--cached']);
  if (!scan.ok) {
    err(SCAN_FAILED_MESSAGE);
    return 1;
  }
  if (scan.findings.length) {
    err(formatBlockedCommit(scan.findings));
    return 1;
  }
  return 0;
}

export async function handleSecrets(args: string[]): Promise<void> {
  if (args[0] !== 'check-staged') {
    console.error('usage: wmux secrets check-staged');
    process.exit(2);
  }
  const cwd = process.cwd();
  const git = async (a: string[]) => {
    try {
      return execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  process.exit(await checkStaged(cwd, git, (s) => process.stderr.write(s)));
}
