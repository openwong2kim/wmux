/**
 * The Claude hook bridge's contract, pinned.
 *
 * core/wmux-native/claude-hook.ported-from.sha256 holds the SHA-256 of
 * wmux-bridge.mjs with every CRLF read as LF (a lone CR is kept), so the pin
 * is the same on a Windows checkout, where core.autocrlf turns the index's LF
 * into CRLF. It is the one place that says which bridge the
 * characterisation cases and the constants snapshot were recorded from (and,
 * later, which bridge a native port follows). Changing the bridge fails this
 * test until the change has been carried through:
 *
 *   1. re-record the cases and review the diff:
 *        WMUX_UPDATE_CLAUDE_HOOK_GOLDENS=1 npx vitest run integrations/claude/__tests__/claudeHookCharacterisation.os.test.ts
 *   2. refresh the constants: node scripts/extract-claude-bridge-constants.mjs --write
 *   3. write the new hash into the pin file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE, SNAPSHOT, extractConstants } from '../../../scripts/extract-claude-bridge-constants.mjs';

const PIN = path.resolve(process.cwd(), 'core/wmux-native/claude-hook.ported-from.sha256');

function lfSha256(text: string): string {
  return createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

describe('Claude hook bridge contract', () => {
  it('the bridge is the one the cases were recorded from (PORTED_FROM_SHA256)', () => {
    const pinned = readFileSync(PIN, 'utf8').trim();
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(
      lfSha256(readFileSync(BRIDGE, 'utf8')),
      'wmux-bridge.mjs changed: re-record the cases, refresh the constants, then update the pin (steps in this file)',
    ).toBe(pinned);
  });

  it('lfSha256 reads only CRLF as LF: mixed files hash like LF, a lone CR is kept', () => {
    // sha256("a\nb\nc\n") and sha256("a\rb\n"), computed independently.
    const LF = '880553fca8fcea94e325ee2cfb48e5a985cc797f39a14cc6d3cedecfeb2ae4d2';
    const LONE_CR = '367d1c77eadc1495a7db4200f46a8b90ea1fa926282722d308c05a65098a4112';
    expect(lfSha256('a\r\nb\nc\r\n')).toBe(LF);
    expect(lfSha256('a\nb\nc\n')).toBe(LF);
    expect(lfSha256('a\rb\r\n')).toBe(LONE_CR);
    expect(lfSha256('a\rb\r\n')).not.toBe(lfSha256('a\nb\n'));
  });

  it('the literal constants match the snapshot', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as unknown;
    expect(extractConstants(readFileSync(BRIDGE, 'utf8'))).toEqual(snapshot);
  });

  it('the extractor reads literals only, and scopes a constant declared in a function', () => {
    const source = [
      'const A = 2 * 1_024;',
      'const B = new Set([\'x\', \'y\']);',
      'const lower = Date.now();',
      'function f() { const A = -1; }',
    ].join('\n');
    expect(extractConstants(source)).toEqual({ A: 2048, B: { set: ['x', 'y'] }, 'f.A': -1 });
    expect(() => extractConstants('const A = 1;\n{ const A = 2; }')).toThrow(/declared twice/);
  });

  it('the extractor refuses an UPPER_CASE constant it cannot read, unless it is listed as skipped', () => {
    expect(() => extractConstants('const NOW = Date.now();')).toThrow(/NOW/);
    expect(extractConstants('const NOW = Date.now();', { NOW: 'a clock reading' })).toEqual({});
  });

  it('the extractor evaluates a RegExp built from joined regex sources', () => {
    const source = "const RE = new RegExp([/^a\\s(\\d+)/.source, /b\\/c/.source].join('|'), 'i');";
    expect(extractConstants(source)).toEqual({ RE: { regex: String(new RegExp([/^a\s(\d+)/.source, /b\/c/.source].join('|'), 'i')) } });
  });
});
