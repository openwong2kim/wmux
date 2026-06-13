import { describe, it, expect } from 'vitest';
import { toResumeCommand, isResumableLaunchCommand } from '../agentResume';

describe('toResumeCommand (X6)', () => {
  describe('rewrites known agent launchers', () => {
    it('claude → claude --continue', () => {
      expect(toResumeCommand('claude')).toBe('claude --continue');
    });

    it('preserves trailing args after the launcher', () => {
      expect(toResumeCommand('claude --dangerously-skip-permissions')).toBe(
        'claude --continue --dangerously-skip-permissions',
      );
    });

    it('preserves a quoted prompt argument verbatim', () => {
      expect(toResumeCommand('claude "do the thing"')).toBe('claude --continue "do the thing"');
    });

    it('matches a Windows .exe / .cmd basename', () => {
      expect(toResumeCommand('claude.cmd')).toBe('claude.cmd --continue');
      expect(toResumeCommand('claude.exe --foo')).toBe('claude.exe --continue --foo');
    });

    it('matches a quoted absolute path launcher', () => {
      expect(toResumeCommand('"C:\\tools\\claude\\claude.exe" --foo')).toBe(
        '"C:\\tools\\claude\\claude.exe" --continue --foo',
      );
    });

    it('normalizes a POSIX absolute path launcher', () => {
      expect(toResumeCommand('/usr/local/bin/claude')).toBe('/usr/local/bin/claude --continue');
    });

    it('tolerates leading whitespace (preserved verbatim)', () => {
      expect(toResumeCommand('  claude')).toBe('  claude --continue');
    });
  });

  describe('idempotency — never double-adds / leaves resume+oneshot unchanged', () => {
    it('already --continue → unchanged', () => {
      const c = 'claude --continue';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('re-applying is a fixpoint', () => {
      const once = toResumeCommand('claude --foo');
      expect(toResumeCommand(once)).toBe(once);
    });
    it('--resume <id> → unchanged (would double-resume)', () => {
      const c = 'claude --resume abc-123';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('-c → unchanged', () => {
      expect(toResumeCommand('claude -c')).toBe('claude -c');
    });
    it('-p / --print one-shot → unchanged (semantics differ)', () => {
      expect(toResumeCommand('claude -p "hi"')).toBe('claude -p "hi"');
      expect(toResumeCommand('claude --print "hi"')).toBe('claude --print "hi"');
    });
    it('short-flag cluster containing c/r/p → unchanged', () => {
      expect(toResumeCommand('claude -cp')).toBe('claude -cp');
    });
    it('a flag inside a QUOTED prompt is NOT treated as a resume flag', () => {
      // The prompt mentions --continue but the command itself is fresh.
      expect(toResumeCommand('claude "explain the --continue flag"')).toBe(
        'claude --continue "explain the --continue flag"',
      );
    });
  });

  describe('leaves non-agent / ambiguous commands unchanged', () => {
    it('unknown launcher (node, bash) → unchanged', () => {
      expect(toResumeCommand('node server.js')).toBe('node server.js');
      expect(toResumeCommand('bash -lc "loop.sh"')).toBe('bash -lc "loop.sh"');
    });
    it('false-positive prefix (claude-foo) → unchanged', () => {
      expect(toResumeCommand('claude-foo')).toBe('claude-foo');
      expect(toResumeCommand('claudette')).toBe('claudette');
    });
    it('env-assignment prefix → unchanged', () => {
      expect(toResumeCommand('FOO=claude claude')).toBe('FOO=claude claude');
    });
    it('empty / whitespace → unchanged', () => {
      expect(toResumeCommand('')).toBe('');
      expect(toResumeCommand('   ')).toBe('   ');
    });
  });

  describe('isResumableLaunchCommand', () => {
    it('true for a fresh claude launch', () => {
      expect(isResumableLaunchCommand('claude')).toBe(true);
    });
    it('false for already-resuming or non-agent', () => {
      expect(isResumableLaunchCommand('claude --continue')).toBe(false);
      expect(isResumableLaunchCommand('node x.js')).toBe(false);
    });
  });
});
