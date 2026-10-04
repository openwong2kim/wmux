// The Moa proposal gate: the HQ terminal brain may Write/Edit only `.md` files
// directly inside `<memoryRoot>/_proposals/`. Covered twice: main's copy of the
// check, and the generated hook script run by a real node process against real
// folders (the script is what actually guards the brain).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildProposalGateScript,
  evaluateProposalWrite,
  PROPOSAL_MAX_BYTES,
} from '../commanderToolSandbox';

let root: string;
let proposals: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-gate-')));
  proposals = path.join(root, 'memory', '_proposals');
  outside = path.join(root, 'outside');
  fs.mkdirSync(proposals, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (file_path: string, content = 'x') => ({ file_path, content });
const check = (tool: string, input: unknown, caseInsensitive = false) =>
  evaluateProposalWrite(tool, input, { proposalsDir: proposals, caseInsensitive });

describe('evaluateProposalWrite', () => {
  it('allows a .md file directly inside the proposals folder (Write and Edit)', () => {
    expect(check('Write', write(path.join(proposals, 'triage-ci.md')))).toEqual({ behavior: 'allow' });
    fs.writeFileSync(path.join(proposals, 'triage-ci.md'), 'old');
    expect(check('Edit', { file_path: path.join(proposals, 'triage-ci.md'), old_string: 'old', new_string: 'new' }))
      .toEqual({ behavior: 'allow' });
  });

  it('denies traversal, a sibling sharing the prefix, the folder itself and subfolders', () => {
    for (const p of [
      path.join(proposals, '..', '_global', 'x.md'),
      path.join(proposals, '..', '..', 'brains', 'hq', '.claude', 'skills', 'x', 'SKILL.md'),
      `${proposals}-evil${path.sep}x.md`,
      path.join(proposals, 'sub', 'x.md'),
      proposals,
    ]) {
      expect(check('Write', write(p)).behavior, p).toBe('deny');
    }
  });

  it('denies relative paths, non-.md files, hidden names and other tools', () => {
    expect(check('Write', write('_proposals/x.md')).behavior).toBe('deny');
    expect(check('Write', write(path.join(proposals, 'x.sh'))).behavior).toBe('deny');
    expect(check('Write', write(path.join(proposals, '.hidden.md'))).behavior).toBe('deny');
    expect(check('Bash', { command: 'ls' }).behavior).toBe('deny');
    expect(check('MultiEdit', write(path.join(proposals, 'x.md'))).behavior).toBe('deny');
    expect(check('Write', null).behavior).toBe('deny');
    expect(check('Write', { file_path: path.join(proposals, 'x.md') }).behavior).toBe('deny');
  });

  it('denies a symlinked file, a symlinked proposals folder, and a hard link', () => {
    const target = path.join(outside, 'target.md');
    fs.writeFileSync(target, 'outside');
    fs.symlinkSync(target, path.join(proposals, 'link.md'));
    expect(check('Write', write(path.join(proposals, 'link.md'))).behavior).toBe('deny');

    fs.linkSync(target, path.join(proposals, 'hard.md'));
    expect(check('Write', write(path.join(proposals, 'hard.md'))).behavior).toBe('deny');

    // The proposals folder swapped for a link to somewhere else.
    const swapped = path.join(root, 'memory2', '_proposals');
    fs.mkdirSync(path.dirname(swapped), { recursive: true });
    fs.symlinkSync(outside, swapped);
    expect(
      evaluateProposalWrite('Write', write(path.join(swapped, 'x.md')), { proposalsDir: swapped, caseInsensitive: false }).behavior,
    ).toBe('deny');
  });

  it('caps the size, counting the existing file for an Edit', () => {
    expect(check('Write', write(path.join(proposals, 'big.md'), 'a'.repeat(PROPOSAL_MAX_BYTES + 1))).behavior).toBe('deny');
    fs.writeFileSync(path.join(proposals, 'grow.md'), 'a'.repeat(PROPOSAL_MAX_BYTES - 2));
    expect(check('Edit', { file_path: path.join(proposals, 'grow.md'), old_string: 'a', new_string: 'bbbb' }).behavior).toBe('deny');
  });

  it('compares case-insensitively only in win32 mode', () => {
    const upper = path.join(path.dirname(proposals), '_PROPOSALS', 'x.md');
    expect(check('Write', write(upper), false).behavior).toBe('deny');
    // In win32 mode the case-folded parent matches; the lstat of the folder
    // still runs against the real (lowercase) path the operator configured.
    expect(check('Write', write(upper), true)).toEqual({ behavior: 'allow' });
  });
});

describe('the generated hook script', () => {
  function runGate(payload: unknown, raw?: string): { status: number | null; stdout: string; stderr: string } {
    const script = path.join(root, 'gate.cjs');
    fs.writeFileSync(script, buildProposalGateScript({ proposalsDir: proposals, caseInsensitive: false }));
    const r = spawnSync(process.execPath, [script], {
      input: raw ?? JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('prints an explicit allow for a proposal file', () => {
    const r = runGate({ tool_name: 'Write', tool_input: write(path.join(proposals, 'x.md')) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
  });

  it('blocks (exit 2 with a reason) an escape, a direct skill write, and a symlink', () => {
    const skill = path.join(root, 'brains', 'hq', '.claude', 'skills', 'x', 'SKILL.md');
    fs.symlinkSync(path.join(outside, 't.md'), path.join(proposals, 'link.md'));
    for (const p of [path.join(proposals, '..', 'x.md'), skill, path.join(proposals, 'link.md')]) {
      const r = runGate({ tool_name: 'Write', tool_input: write(p) });
      expect(r.status, p).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    }
  });

  it('fails closed on unreadable input', () => {
    expect(runGate(undefined, 'not json').status).toBe(2);
    expect(runGate(undefined, '').status).toBe(2);
    expect(runGate({ tool_name: 'Write' }).status).toBe(2);
  });
});
