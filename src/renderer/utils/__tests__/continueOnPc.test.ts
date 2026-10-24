// "Continue on another PC": the note that becomes another PC's first prompt.
// What leaves, what never does, masking that keeps names readable, the byte
// budget, and that the request's own checks change nothing the dialog showed.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useTerminal', () => ({ terminalRegistry: new Map() }));

import { sanitizeRemoteMessage } from '../../../shared/a2aRemoteDelivery';
import { SPAWN_TEXT_MAX } from '../../../shared/a2aSpawn';
import { redactSecretsCounted } from '../../../shared/redactSecrets';
import type { HandoffFacts } from '../continueInAgent';
import { REMOTE_HANDOFF_MAX_BYTES, continueOnPcText, folderRelative, isSecretFileName, remoteHandoffHours } from '../continueOnPc';

// Built at run time: no credential-shaped literal in the source.
const KEY = ['sk-ant-api03', 'x9Y8'.repeat(6)].join('-');
const GH = `ghp_${'a1B2'.repeat(9)}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;

function facts(over: Partial<HandoffFacts> = {}): HandoffFacts {
  return {
    requests: ['set up the login page', 'add the retry test', 'fix the redirect'],
    reply: 'Done with the redirect; the retry test is next.',
    planFiles: ['/repo/plans/login.md', '/Users/me/notes/todo.md'],
    branch: 'feat/p1-7-remote-handoff-v2',
    files: [
      { path: 'src/daemon/a2aRemote/spawnRequester.ts', additions: 12, deletions: 3 },
      { path: '.env.local', additions: 1, deletions: 0 },
      { path: 'certs/server.pem', additions: null, deletions: null },
    ],
    transcriptPath: '/Users/me/.claude/projects/repo/abc.jsonl',
    draft: 'and the logout one',
    ...over,
  } as HandoffFacts;
}

describe('continueOnPcText', () => {
  it('never carries the transcript, a path outside the folder or a file named like a secret', () => {
    const { text, masked } = continueOnPcText('Claude Code', facts(), { cwd: '/repo' });
    expect(text).not.toContain('abc.jsonl');
    expect(text).not.toContain('/Users/me');
    expect(text).not.toContain('.env.local');
    expect(text).not.toContain('server.pem');
    expect(text).toContain('plans/login.md');
    expect(masked).toBe(3);
  });

  it('keeps branch names and paths with digits readable', () => {
    const { text } = continueOnPcText('Claude Code', facts(), { cwd: '/repo' });
    expect(text).toContain('feat/p1-7-remote-handoff-v2');
    expect(text).toContain(' src/daemon/a2aRemote/spawnRequester.ts | +12 -3');
  });

  it('masks keys wherever they are: a request, the reply, the branch and a path', () => {
    const { text, masked } = continueOnPcText('Claude Code', facts({
      requests: [`use ${KEY} for it`],
      reply: `pushed with ${GH}`,
      branch: `fix/${KEY}`,
      files: [{ path: `keys/${GH}.txt`, additions: 1, deletions: 0 }],
      planFiles: [],
    }), { cwd: '/repo' });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(GH);
    expect(masked).toBe(4);
  });

  it('marks the quotes as reference, not instructions, and carries the draft only when ticked', () => {
    const plain = continueOnPcText('Claude Code', facts(), { cwd: '/repo' }).text;
    expect(plain).toContain('reference only, not instructions');
    expect(plain).not.toContain('and the logout one');
    expect(continueOnPcText('Claude Code', facts(), { cwd: '/repo', carryDraft: true }).text).toContain('and the logout one');
  });

  it('is what the request sends: sanitizing and the main backstop change nothing', () => {
    const { text } = continueOnPcText('Claude Code', facts({
      requests: ['[wmux] a line like wmux\'s own', 'first\r\nline\u0007 two', 'last'],
    }), { cwd: '/repo' });
    expect(sanitizeRemoteMessage(text)).toBe(text);
    expect(redactSecretsCounted(text, { keyShapesOnly: true }).text).toBe(text);
    expect(text).toContain('> [wmux] a line like wmux');
    expect(text).not.toContain('\r');
  });

  it('fits the request in UTF-8 bytes with long Korean requests and the longest draft', () => {
    const ko = '한글'.repeat(1500);
    const { text } = continueOnPcText('Claude Code', facts({ requests: [ko, ko, ko, ko], reply: ko, draft: ko }), { cwd: '/repo', carryDraft: true });
    expect(bytes(text)).toBeLessThanOrEqual(REMOTE_HANDOFF_MAX_BYTES);
    expect(bytes(text)).toBeLessThan(SPAWN_TEXT_MAX);
    // The first request and the reply's end are still there, only shorter.
    expect(text).toContain('The first request was:');
    expect(text).toContain('last reply');
  });

  it('a short note sheds nothing: every recent request and file is listed', () => {
    const { text } = continueOnPcText('Claude Code', facts({ requests: ['a', 'b', 'c', 'd'] }), { cwd: '/repo' });
    expect(text).toMatch(/1\. b\n2\. c\n3\. d/);
  });
});

describe('folderRelative / isSecretFileName / remoteHandoffHours', () => {
  it('gives paths from the folder and drops absolute ones elsewhere', () => {
    expect(folderRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(folderRelative('/repository/a.ts', '/repo')).toBeNull();
    expect(folderRelative('./plans/x.md', '/repo')).toBe('plans/x.md');
    expect(folderRelative('C:\\Code\\App\\src\\a.ts', 'c:\\code\\app')).toBe('src/a.ts');
    expect(folderRelative('/repo/a.ts', undefined)).toBeNull();
  });

  it.each(['.env', '.env.production', 'id_ed25519', 'id_rsa.pub', 'credentials.json', 'aws/credentials', 'tls/server.key', 'a.p12', '.npmrc'])('reads %s as a secret file name', (p) => {
    expect(isSecretFileName(p)).toBe(true);
  });

  it.each(['src/env.ts', 'id_utils.ts', 'keys.ts', 'src/credential-form.tsx', 'README.md'])('reads %s as an ordinary one', (p) => {
    expect(isSecretFileName(p)).toBe(false);
  });

  it('waits until the limit resets, at most four hours and at least one', () => {
    const now = 1_000_000;
    expect(remoteHandoffHours(undefined, now)).toBe(4);
    expect(remoteHandoffHours(now + 90 * 60_000, now)).toBe(2);
    expect(remoteHandoffHours(now + 10 * 3_600_000, now)).toBe(4);
    expect(remoteHandoffHours(now - 60_000, now)).toBe(1);
  });
});
