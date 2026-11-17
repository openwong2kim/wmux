// @wmux-lane unit — 'win32' here is a host OS value under test; the one process.platform check only skips an assertion about a POSIX host.
// `transcript_path` arrives on an authenticated but untrusted hook envelope, is
// persisted, and is then opened and rendered as a pane's conversation. These are
// the cases that decide whether that is a projection or an arbitrary-file-read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkTranscriptPath, claudeProjectRoots, isHostAbsolute, isWslOwnTranscriptPath, keepOwnWslTranscriptPath } from '../transcriptPathGuard';
import { wslAccountHomeKey } from '../../../shared/wslAccountHome';

const SID = '920b9112-1111-4222-8333-444455556666';
const root = path.join(os.homedir(), '.claude', 'projects');

describe('checkTranscriptPath', () => {
  it('accepts the real shape: inside the projects root, named after the session', () => {
    const p = path.join(root, '-Users-dev-repo', `${SID}.jsonl`);
    // Not on disk here, so also pending (see the not-yet-written case below).
    expect(checkTranscriptPath(p, SID)).toEqual({ ok: true, reason: '', pending: true });
  });

  it('marks pending only a path with nothing at it yet, never an existing file, a link or a dot segment', () => {
    // A bare launch: SessionStart names the transcript Claude writes on its
    // first prompt. Pending is what lets the projector serve it as empty.
    // Resolved, so macOS's /var alias cannot refuse a case for the wrong reason.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guard-')));
    try {
      const projects = path.join(dir, 'projects', '-repo');
      const elsewhere = path.join(dir, 'elsewhere');
      fs.mkdirSync(projects, { recursive: true });
      fs.mkdirSync(elsewhere);
      const env = { CLAUDE_CONFIG_DIR: dir };
      const file = path.join(projects, `${SID}.jsonl`);
      expect(checkTranscriptPath(file, SID, env)).toEqual({ ok: true, reason: '', pending: true });
      // Missing parents are fine while each one is truly absent.
      expect(checkTranscriptPath(path.join(dir, 'projects', '-new', `${SID}.jsonl`), SID, env)).toEqual({ ok: true, reason: '', pending: true });
      // A link at the name, dangling or not, is not a file Claude has yet to write.
      fs.symlinkSync(path.join(dir, 'nowhere'), file);
      expect(checkTranscriptPath(file, SID, env).ok).toBe(false);
      fs.unlinkSync(file);
      const other = path.join(projects, 'other.jsonl');
      fs.writeFileSync(other, '{}\n');
      fs.symlinkSync(other, file);
      expect(checkTranscriptPath(file, SID, env).ok).toBe(false);
      fs.unlinkSync(file);
      // A dangling link as a missing directory, or a directory linked out of the root.
      fs.symlinkSync(path.join(elsewhere, 'gone'), path.join(dir, 'projects', '-dangling'));
      expect(checkTranscriptPath(path.join(dir, 'projects', '-dangling', `${SID}.jsonl`), SID, env).ok).toBe(false);
      fs.symlinkSync(elsewhere, path.join(dir, 'projects', '-out'));
      expect(checkTranscriptPath(path.join(dir, 'projects', '-out', `${SID}.jsonl`), SID, env).ok).toBe(false);
      expect(checkTranscriptPath(`${projects}/missing/../${SID}.jsonl`, SID, env).ok).toBe(false);
      // Once written, a regular file: no longer pending.
      fs.writeFileSync(file, '');
      expect(checkTranscriptPath(file, SID, env)).toEqual({ ok: true, reason: '' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    // Off Windows it is the other OS's path: judged lexically, never pending (an empty conversation).
    if (process.platform !== 'win32') expect(checkTranscriptPath(good, SID, env)).toEqual({ ok: true, reason: '' });
    const wrongName = 'C:\\Users\\dev\\.claude\\projects\\C--Users-dev-repo\\other.jsonl';
    expect(checkTranscriptPath(wrongName, SID, env).ok).toBe(false);
    const outside = `C:\\Windows\\Temp\\${SID}.jsonl`;
    expect(checkTranscriptPath(outside, SID, env).ok).toBe(false);
  });

  it('reads a path as this host\'s own only in its syntax', () => {
    expect(isHostAbsolute('/Users/dev/x.jsonl', 'darwin')).toBe(true);
    expect(isHostAbsolute('C:\\Users\\dev\\x.jsonl', 'darwin')).toBe(false);
    expect(isHostAbsolute('C:\\Users\\dev\\x.jsonl', 'win32')).toBe(true);
    for (const p of ['/home/u/x.jsonl', '\\\\server\\share\\x.jsonl', 'relative\\x.jsonl']) expect(isHostAbsolute(p, 'win32')).toBe(false);
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
      expect(checkTranscriptPath(notYet, SID, env)).toEqual({ ok: true, reason: '', pending: true });
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

  // A bound workspace's Claude account runs on its own home in the distro (shared/wslAccountHome.ts).
  describe('a pane on a bound account', () => {
    const folder = 'C:\\accounts\\work';
    const env = { CLAUDE_CONFIG_DIR: folder, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR', WMUX_DATA_SUFFIX: '-s1' };
    const accountFile = `/home/dev/.wmux-s1/accounts/claude-${wslAccountHomeKey(folder)}/projects/-home-dev-repo/${SID}.jsonl`;

    it('accepts the account home\'s projects file, and still the default one', () => {
      expect(isWslOwnTranscriptPath(accountFile, SID, dev, env)).toBe(true);
      expect(isWslOwnTranscriptPath(own, SID, dev, env)).toBe(true);
      expect(keepOwnWslTranscriptPath({ agent: 'claude', sessionId: SID, wslTranscriptPath: accountFile }, dev, env).dropped).toBe(false);
    });

    it('refuses it without the mark, for another account, suffix or user, and outside projects/', () => {
      expect(isWslOwnTranscriptPath(accountFile, SID, dev)).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile, SID, dev, { ...env, WMUX_WSL_ACCOUNT_KEYS: '' })).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile, SID, dev, { ...env, CLAUDE_CONFIG_DIR: 'C:\\accounts\\other' })).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile, SID, dev, { ...env, WMUX_DATA_SUFFIX: '' })).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile.replace('/home/dev/', '/home/other/'), SID, { distribution: 'Ubuntu', user: 'dev' }, env)).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile.replace('/projects/', '/sessions/'), SID, dev, env)).toBe(false);
      expect(isWslOwnTranscriptPath(accountFile, SID, dev, { ...env, WMUX_DATA_SUFFIX: '/../x' })).toBe(false);
    });
  });
});
