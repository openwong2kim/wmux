// Keeps raw C0 control bytes out of tracked text files.
//
// With default settings, ripgrep treats a file containing a NUL as binary and
// stops searching it, so a directory search can miss everything in it. A NUL
// within git's first 8000 bytes also makes `git diff` and GitHub's PR view
// show "Binary files differ". Other control bytes (ESC, BEL, ...) are
// invisible in editors and diffs. Spell them as escapes instead: `\u0000`,
// `\x1b`, `\x07`.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html',
  '.svg', '.xml', '.plist', '.yml', '.yaml', '.toml', '.ps1', '.sh', '.cmd', '.bat',
  '.rs', '.cs', '.swift', '.patch', '.diff',
]);
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc']);

// Upstream package patches carry the patched package's own bytes verbatim.
const EXEMPT_PREFIXES = ['patches/'];

/**
 * Tab, LF and CR are ordinary text; every other C0 byte is a finding. Columns
 * count UTF-16 code units, as editors and TypeScript report them.
 */
function findControlBytes(text) {
  const findings = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      line += 1;
      lineStart = i + 1;
    } else if (code < 0x20 && code !== 0x09 && code !== 0x0d) {
      findings.push({ line, column: i - lineStart + 1, code });
    }
  }
  return findings;
}

function isScanned(file) {
  const textual = TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
    || TEXT_NAMES.has(path.basename(file));
  return textual && !EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

// ignoreBOM keeps a leading U+FEFF in a file name instead of stripping it.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Paths of regular files in raw `git ls-files -s -z` output. Symlinks (120000)
 * and submodules (160000) recorded in the index are skipped: reading through a
 * link would scan its target, and a checkout with `core.symlinks=false` holds
 * the link text instead. A path that is not valid UTF-8 throws, because a
 * lossy decode would name a file that does not exist and the scan would skip it.
 */
function regularFiles(stageOutput) {
  const files = [];
  let start = 0;
  for (let end = stageOutput.indexOf(0, start); end !== -1; end = stageOutput.indexOf(0, start)) {
    const entry = stageOutput.subarray(start, end);
    start = end + 1;
    const space = entry.indexOf(0x20);
    const tab = entry.indexOf(0x09);
    if (space === -1 || tab === -1) throw new Error(`unexpected git ls-files entry: ${entry.toString('hex')}`);
    const mode = entry.subarray(0, space).toString('latin1');
    if (mode !== '100644' && mode !== '100755') continue;
    try {
      files.push(strictUtf8.decode(entry.subarray(tab + 1)));
    } catch {
      throw new Error(`tracked path is not valid UTF-8: ${entry.subarray(tab + 1).toString('hex')}`);
    }
  }
  return files;
}

/** File text, or null when the file is gone from the working tree; any other read error throws. */
function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`could not read ${file}: ${err?.code ?? err}`);
  }
}

function trackedRegularFiles() {
  return regularFiles(execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }));
}

const hex = (code) => `\\x${code.toString(16).padStart(2, '0')}`;

describe('allowlisted tracked text files', () => {
  it('contain no raw control bytes', () => {
    const violations = [];
    for (const file of trackedRegularFiles().filter(isScanned)) {
      const text = readIfPresent(path.join(REPO_ROOT, file));
      if (text === null) continue; // deleted in the working tree but still in the index
      for (const { line, column, code } of findControlBytes(text)) {
        violations.push(`${file}:${line}:${column} raw ${hex(code)}`);
      }
    }
    expect(
      violations,
      'write control characters as escapes (`\\u0000`, `\\x1b`, `\\x07`) so search tools and diffs can read the file',
    ).toEqual([]);
  });
});

describe('findControlBytes', () => {
  const nul = String.fromCharCode(0);
  const esc = String.fromCharCode(0x1b);

  it('reports the position of each raw control byte', () => {
    expect(findControlBytes(`a${nul}b\nc${esc}`)).toEqual([
      { line: 1, column: 2, code: 0x00 },
      { line: 2, column: 2, code: 0x1b },
    ]);
  });

  it('counts columns in UTF-16 code units, like editors do', () => {
    expect(findControlBytes(`\u{1F600}${nul}`)).toEqual([{ line: 1, column: 3, code: 0x00 }]);
  });

  it('accepts tabs, CRLF line endings and escape spellings', () => {
    expect(findControlBytes('\tindented\r\nconst nul = "\\u0000", esc = "\\x1b";\r\n')).toEqual([]);
  });
});

describe('isScanned', () => {
  it('covers source, docs, patches and dotfiles, but not package patches or binary assets', () => {
    expect(isScanned('src/daemon/web/deviceAudit.ts')).toBe(true);
    expect(isScanned('docs/phone-client-contract.md')).toBe(true);
    expect(isScanned('.gitignore')).toBe(true);
    expect(isScanned('docs/upstream-fix.patch')).toBe(true);
    expect(isScanned('patches/@xterm+xterm+6.0.0.patch')).toBe(false);
    expect(isScanned('src/renderer/assets/media/statusline-poster.webp')).toBe(false);
  });
});

describe('regularFiles', () => {
  const sha = 'a'.repeat(40);
  const entry = (mode, file) => Buffer.concat([Buffer.from(`${mode} ${sha} 0\t`), Buffer.from(file), Buffer.from([0])]);

  it('keeps regular and executable files, and skips symlinks and submodules', () => {
    const output = Buffer.concat([
      entry('100644', 'src/a b.ts'),
      entry('100755', 'scripts/run.sh'),
      entry('120000', 'docs/link.md'),
      entry('160000', 'vendor/module'),
      entry('100644', 'docs/été.md'),
      entry('100644', '﻿probe.md'),
    ]);
    expect(regularFiles(output)).toEqual(['src/a b.ts', 'scripts/run.sh', 'docs/été.md', '﻿probe.md']);
  });

  it('refuses an entry it cannot parse', () => {
    expect(() => regularFiles(Buffer.from('garbage\u0000'))).toThrow(/unexpected git ls-files entry/);
  });

  it('refuses a path that is not valid UTF-8 instead of skipping it', () => {
    const output = entry('100644', Buffer.from([0x64, 0x6f, 0x63, 0x2f, 0xff, 0x2e, 0x6d, 0x64]));
    expect(() => regularFiles(output)).toThrow(/not valid UTF-8/);
  });
});

describe('readIfPresent', () => {
  it('returns null only for a missing file, and throws on any other read error', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-control-bytes-'));
    try {
      expect(readIfPresent(path.join(dir, 'missing.ts'))).toBeNull();
      // Reading a directory fails (EISDIR on POSIX, EPERM on Windows).
      expect(() => readIfPresent(dir)).toThrow(/could not read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
