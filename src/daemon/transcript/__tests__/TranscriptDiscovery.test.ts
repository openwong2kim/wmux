// TranscriptDiscovery — the bounded, name-based search that makes Chat View
// available before the first turn ends (F9).
//
// What these cover: the scan finds `<agentSessionId>.jsonl` one level under the
// projects root and NOTHING else — not a same-named file outside the root, not
// a differently-named file inside it, and never through a recursive walk. The
// containment guard is still the trust boundary, so a symlinked project
// directory that resolves outside the root is refused even though the scan
// walked into it. Windows-shaped paths are exercised as pure-function cases.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TranscriptDiscovery, scanForTranscript } from '../TranscriptDiscovery';
import { checkTranscriptPath } from '../../hooks/transcriptPathGuard';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let home: string;
let root: string;
let env: Record<string, string>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-discovery-'));
  root = path.join(home, 'config', 'projects');
  fs.mkdirSync(root, { recursive: true });
  // The scan resolves its roots from the PANE's env, so a tmp tree can stand in
  // for a relocated Claude config dir.
  env = { CLAUDE_CONFIG_DIR: path.join(home, 'config') };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeTranscript(dir: string, name = `${ID}.jsonl`): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}\n', 'utf8');
  return file;
}

describe('scanForTranscript', () => {
  it('finds the transcript by name in a project directory', () => {
    const file = writeTranscript(path.join(root, '-synthetic-repo'));
    expect(scanForTranscript(ID, env)).toEqual([file]);
  });

  it('refuses a same-named file OUTSIDE the projects root', () => {
    writeTranscript(path.join(home, 'elsewhere'));
    expect(scanForTranscript(ID, env)).toEqual([]);
  });

  it('refuses a differently-named file inside the root', () => {
    writeTranscript(path.join(root, '-synthetic-repo'), 'someone-elses-session.jsonl');
    writeTranscript(path.join(root, '-synthetic-repo'), `${ID}.jsonl.bak`);
    expect(scanForTranscript(ID, env)).toEqual([]);
  });

  it('does not recurse: a transcript two levels down is not adopted', () => {
    writeTranscript(path.join(root, '-synthetic-repo', 'nested'));
    expect(scanForTranscript(ID, env)).toEqual([]);
  });

  it('reads only the roots themselves — never a project directory', () => {
    writeTranscript(path.join(root, '-a', 'nested'));
    writeTranscript(path.join(root, '-b'));
    const readdir = vi.spyOn(fs, 'readdirSync');
    scanForTranscript(ID, env);
    // One level: every listing is a ROOT, so a project directory is only ever
    // touched by the single candidate stat.
    for (const call of readdir.mock.calls) {
      expect(path.basename(String(call[0]))).toBe('projects');
    }
  });

  it('refuses a traversal-shaped agent session id', () => {
    writeTranscript(path.join(home, 'elsewhere'));
    expect(scanForTranscript(`../elsewhere/${ID}`, env)).toEqual([]);
    expect(scanForTranscript(`sub/${ID}`, env)).toEqual([]);
    expect(scanForTranscript('', env)).toEqual([]);
  });

  it('returns nothing when the root does not exist', () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(scanForTranscript(ID, env)).toEqual([]);
  });
});

describe('the containment guard is still the trust boundary', () => {
  it('refuses a symlinked project directory that resolves outside the root', () => {
    const outside = path.join(home, 'outside');
    const escaped = writeTranscript(outside);
    try {
      fs.symlinkSync(outside, path.join(root, '-escape'), 'dir');
    } catch {
      return; // No symlink privilege (Windows CI); nothing to assert.
    }
    // The scan walks into it — that is exactly why the guard runs afterwards.
    expect(scanForTranscript(ID, env)).toEqual([path.join(root, '-escape', `${ID}.jsonl`)]);
    expect(checkTranscriptPath(escaped, ID, env).ok).toBe(false);

    const found: string[] = [];
    const discovery = new TranscriptDiscovery({
      getSessionEnv: () => env,
      onFound: (f) => found.push(f.transcriptPath),
      deadlineMs: 50,
    });
    discovery.start('pty-1', ID, '/repo');
    discovery.dispose();
    expect(found).toEqual([]);
  });

  it('accepts a discovered path only when checkTranscriptPath does', () => {
    const file = writeTranscript(path.join(root, '-synthetic-repo'));
    expect(checkTranscriptPath(file, ID, env).ok).toBe(true);
    expect(checkTranscriptPath(file, 'a-different-id', env).ok).toBe(false);
  });
});

describe('Windows-shaped paths (pure function)', () => {
  const winEnv = { CLAUDE_CONFIG_DIR: 'C:\\Users\\dev\\.claude' };

  it('accepts a backslash path inside the configured root', () => {
    expect(
      checkTranscriptPath(`C:\\Users\\dev\\.claude\\projects\\D--repo\\${ID}.jsonl`, ID, winEnv).ok,
    ).toBe(true);
  });

  it('refuses a backslash path outside the configured root', () => {
    expect(
      checkTranscriptPath(`C:\\Users\\dev\\secrets\\${ID}.jsonl`, ID, winEnv).ok,
    ).toBe(false);
  });

  it('refuses a backslash path whose basename is not the session id', () => {
    expect(
      checkTranscriptPath('C:\\Users\\dev\\.claude\\projects\\D--repo\\other.jsonl', ID, winEnv).ok,
    ).toBe(false);
  });

  it('refuses a Windows-separated agent session id outright', () => {
    expect(scanForTranscript(`..\\elsewhere\\${ID}`, env)).toEqual([]);
  });
});
