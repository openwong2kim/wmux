// ─── J1 §4 C9 gate: does sanitizePtyText preserve shell syntax in initialCommand? ──
//
// This test is the verdict for the entire J1 D4 design (file-backed prompt +
// `{agentCmd} "$(cat {promptPath})"` one-liner) (spec §4·§8 "required first
// implementation step"). initialCommand via pty.handler.ts:490 passes through
// sanitizePtyText — if `$()` command substitution, double quotes, or backslashes
// are altered or truncated, the prompt never reaches the shell and D4 collapses.
//
// sanitizePtyText contract: strip only NULL (\x00) and C1 controls (U+0080~U+009F);
// preserve everything else (shared/types.ts). Below pins only the characters a D4
// command line actually encounters.

import { describe, it, expect } from 'vitest';
import { sanitizePtyText } from '../types';

describe('sanitizePtyText — J1 §4 initialCommand shell syntax preservation', () => {
  it('preserves `$(cat path)` command substitution unchanged', () => {
    const cmd = 'claude "$(cat /Users/x/.wmux/worktrees/abc/.meta/slug/prompt.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('preserves double quotes·backslashes·dollar signs', () => {
    const cmd = 'claude "$(cat \\"/tmp/p p/prompt.md\\")" # $HOME';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('preserves PowerShell equivalent (Get-Content -Raw) command line', () => {
    const cmd = 'claude "$(Get-Content -Raw C:\\Users\\x\\.wmux\\prompt.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('preserves all individual shell metacharacters', () => {
    const metas = '$ ( ) " \\ \' ` | & ; < > * ? [ ] { } ~ #';
    expect(sanitizePtyText(metas)).toBe(metas);
  });

  it('preserves spaces·unicode·Hangul inside paths', () => {
    const cmd = 'claude "$(cat /경로 with space/프롬프트.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('strips only NULL·C1 controls; leaves rest intact (contract check)', () => {
    const cmd = 'claude "$(cat p.md)"';
    // Even with \x00 (NULL) and \x85 (C1 NEL) mixed in, the command body must stay intact.
    expect(sanitizePtyText(`\x00${cmd}\x85`)).toBe(cmd);
  });
});
