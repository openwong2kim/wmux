// `transcript_path` arrives on an authenticated but untrusted hook envelope, is
// persisted, and is then opened and rendered as a pane's conversation. These are
// the cases that decide whether that is a projection or an arbitrary-file-read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkTranscriptPath, claudeProjectRoots, isWslOwnTranscriptPath } from '../transcriptPathGuard';

const SID = '920b9112-1111-4222-8333-444455556666';
const root = path.join(os.homedir(), '.claude', 'projects');

describe('checkTranscriptPath', () => {
  it('accepts the real shape: inside the projects root, named after the session', () => {
    const p = path.join(root, '-Users-dev-repo', `${SID}.jsonl`);
    expect(checkTranscriptPath(p, SID)).toEqual({ ok: true, reason: '' });
  });

  it('refuses a path outside the projects root', () => {
    // The whole point: a forged payload must not be able to name a secrets file.
    const check = checkTranscriptPath(`/etc/${SID}.jsonl`, SID);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('outside');
  });

  it('refuses a traversal that climbs back out of the root', () => {
    const p = path.join(root, '..', '..', '.ssh', `${SID}.jsonl`);
    expect(checkTranscriptPath(p, SID).ok).toBe(false);
  });

  it('refuses a basename that is not the agent session id', () => {
    // Without this, any pane's hook could point the projector at ANOTHER pane's
    // conversation inside the same (legitimate) root.
    const p = path.join(root, '-repo', 'somebody-elses-session.jsonl');
    const check = checkTranscriptPath(p, SID);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('!=');
  });

  it('refuses a non-jsonl sibling in the root', () => {
    expect(checkTranscriptPath(path.join(root, '-repo', SID), SID).ok).toBe(false);
  });

  it('refuses an empty path, a NUL byte, and a missing session id', () => {
    expect(checkTranscriptPath('', SID)).toEqual({ ok: false, reason: 'empty' });
    expect(checkTranscriptPath(`${root}/\u0000${SID}.jsonl`, SID).reason).toBe('nul-byte');
    expect(checkTranscriptPath(path.join(root, `${SID}.jsonl`), '').reason)
      .toBe('no-agent-session-id');
  });

  it('honours a CLAUDE_CONFIG_DIR relocation from the pane env', () => {
    const env = { CLAUDE_CONFIG_DIR: '/opt/cfg' };
    expect(checkTranscriptPath(`/opt/cfg/projects/-repo/${SID}.jsonl`, SID, env).ok).toBe(true);
    // …and the relocation does not widen anything else.
    expect(checkTranscriptPath(`/opt/cfg/${SID}.jsonl`, SID, env).ok).toBe(false);
  });

  it('treats a Windows-style path the same way on either platform', () => {
    // A path relayed from a Windows host (or replayed from a state file written
    // there) must be split on backslashes, not handed back whole.
    const env = { CLAUDE_CONFIG_DIR: 'C:\\Users\\dev\\.claude' };
    const good = `C:\\Users\\dev\\.claude\\projects\\C--Users-dev-repo\\${SID}.jsonl`;
    expect(checkTranscriptPath(good, SID, env).ok).toBe(true);
    const wrongName = 'C:\\Users\\dev\\.claude\\projects\\C--Users-dev-repo\\other.jsonl';
    expect(checkTranscriptPath(wrongName, SID, env).ok).toBe(false);
    const outside = `C:\\Windows\\Temp\\${SID}.jsonl`;
    expect(checkTranscriptPath(outside, SID, env).ok).toBe(false);
  });

  it('accepts a not-yet-created transcript under a SYMLINKED root', () => {
    // SessionStart fires before the `.jsonl` exists, so the path cannot be
    // realpath'd — but the root often can be (macOS resolves /var → /private/var,
    // and a symlinked home is common). Comparing the raw path against a resolved
    // root would refuse a legitimate provisional capture and silently disable
    // Chat View, so the nearest EXISTING ancestor is what gets resolved.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guard-'));
    try {
      const projects = path.join(dir, 'projects', '-repo');
      fs.mkdirSync(projects, { recursive: true });
      const env = { CLAUDE_CONFIG_DIR: dir };
      const notYet = path.join(projects, `${SID}.jsonl`);
      expect(fs.existsSync(notYet)).toBe(false);
      expect(checkTranscriptPath(notYet, SID, env)).toEqual({ ok: true, reason: '' });
      // The ancestor walk must not widen containment.
      expect(checkTranscriptPath(path.join(dir, `${SID}.jsonl`), SID, env).ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('always offers the home-directory root, plus the configured one', () => {
    expect(claudeProjectRoots()[0]).toBe(root);
    expect(claudeProjectRoots({ CLAUDE_CONFIG_DIR: '/opt/cfg' }))
      .toContain(path.join('/opt/cfg', 'projects'));
  });
});

// #2270 — a WSL pane's Claude reports its transcript as a Linux path inside the
// distro. Only that user's own projects file is recognized; anything else is
// left to checkTranscriptPath's refusal.
describe('isWslOwnTranscriptPath', () => {
  const dev = { distribution: 'Ubuntu', user: 'dev' };
  const own = `/home/dev/.claude/projects/-home-dev-repo/${SID}.jsonl`;

  it('recognizes the distro user\'s own projects file', () => {
    expect(isWslOwnTranscriptPath(own, SID, dev)).toBe(true);
    expect(isWslOwnTranscriptPath(`/root/.claude/projects/-root-repo/${SID}.jsonl`, SID, { distribution: 'Ubuntu', user: 'root' })).toBe(true);
  });

  it('refuses another user, another directory or another session', () => {
    expect(isWslOwnTranscriptPath(`/home/other/.claude/projects/-repo/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(`/etc/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(`/home/dev/.claude/projects/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(`/home/dev/.claude/projects/-repo/sub/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(own.replace(SID, 'other-session'), SID, dev)).toBe(false);
  });

  it('refuses dot segments, backslashes and a missing pane user', () => {
    expect(isWslOwnTranscriptPath(`/home/dev/.claude/projects/../../../etc/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(`/home/dev/.claude/projects/-repo/../${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(`/home/dev/.claude/projects/a\\b/${SID}.jsonl`, SID, dev)).toBe(false);
    expect(isWslOwnTranscriptPath(own, SID, undefined)).toBe(false);
    expect(isWslOwnTranscriptPath(own, SID, { user: '' })).toBe(false);
  });
});
