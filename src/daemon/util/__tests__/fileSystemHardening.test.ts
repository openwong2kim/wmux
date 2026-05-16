import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariants for the substrate filesystem hardening pass.
//
// The full behavior (icacls/attrib execution on a real NTFS volume) is a
// platform-integration concern that cannot be reliably asserted in a
// unit test on POSIX CI runners or sandboxed Windows agents. We lock
// the source contract here so refactors do not silently drop the
// hardening call or its required arguments. Mirrors the A4 source-
// invariant pattern from the Phase A test suite.

describe('fileSystemHardening — source invariants', () => {
  const helperPath = path.join(__dirname, '..', 'fileSystemHardening.ts');
  const indexPath = path.join(__dirname, '..', '..', 'index.ts');

  it('hardenWmuxDir is invoked from acquireLock startup path', () => {
    const indexSrc = fs.readFileSync(indexPath, 'utf-8');
    // Import is present.
    expect(indexSrc).toMatch(
      /import\s*\{\s*hardenWmuxDir\s*\}\s*from\s*['"]\.\/util\/fileSystemHardening['"]/,
    );
    // Awaited call site inside acquireLock (the dir-creation function).
    expect(indexSrc).toMatch(/await\s+hardenWmuxDir\(dir/);
  });

  it('POSIX path early-returns without invoking any system binary', () => {
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    expect(helperSrc).toMatch(/process\.platform\s*!==\s*'win32'/);
  });

  it('uses icacls to disable ACL inheritance + grant current user only', () => {
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    expect(helperSrc).toMatch(/icacls\.exe/);
    expect(helperSrc).toMatch(/'\/inheritance:r'/);
    expect(helperSrc).toMatch(/'\/grant:r'/);
    // Per-user grant uses (OI)(CI)F so inheritance flags propagate.
    expect(helperSrc).toMatch(/\(OI\)\(CI\)F/);
  });

  it('sets Hidden + System + NotIndexed attributes on dir and buffers/', () => {
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    expect(helperSrc).toMatch(/attrib\.exe/);
    expect(helperSrc).toMatch(/'\+H'/);
    expect(helperSrc).toMatch(/'\+S'/);
    expect(helperSrc).toMatch(/'\+I'/);
    // /D flag applies to directories.
    expect(helperSrc).toMatch(/'\/D'/);
    // Both the root dir and the buffers/ subdir get the attribute pass.
    expect(helperSrc).toMatch(/for\s*\(\s*const\s+target\s+of\s*\[\s*dir\s*,\s*buffersDir\s*\]/);
  });

  it('writes the no-cloud-sync notice file with substrate-specific wording', () => {
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    expect(helperSrc).toMatch(/\.no-cloud-sync\.txt/);
    expect(helperSrc).toMatch(/wmux substrate state directory/);
    expect(helperSrc).toMatch(/OneDrive, Dropbox, Google Drive/);
    expect(helperSrc).toMatch(/docs\/SECURITY\.md/);
    // Notice file uses 0o600.
    expect(helperSrc).toMatch(/mode:\s*0o600/);
  });

  it('every external call is wrapped in try/catch — daemon must boot even if icacls/attrib fail', () => {
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    // Counted: icacls /inheritance:r, icacls /grant:r, attrib (per target), notice write.
    // Each in its own try/catch with a warn callback. We assert the
    // helper text contains at least 4 distinct try blocks.
    const tryBlocks = helperSrc.match(/try\s*\{/g) ?? [];
    expect(tryBlocks.length).toBeGreaterThanOrEqual(4);
    // The warn parameter exists with a console.warn default.
    expect(helperSrc).toMatch(/warn:\s*WarnLogger\s*=\s*console\.warn/);
  });
});
