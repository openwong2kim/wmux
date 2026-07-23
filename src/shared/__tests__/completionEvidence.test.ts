import { describe, it, expect } from 'vitest';
import type { CompletionEvidence, EvidenceItem } from '../types';
import {
  validateCompletionEvidence,
  isVerifiedItem,
  isSafeRelPath,
  normalizeCompletionEvidenceWire,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_STR_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_MAX_FILE_PATH_BYTES,
} from '../completionEvidence';

const passedCmd: EvidenceItem = {
  kind: 'command',
  status: 'passed',
  summary: 'tests passed',
  command: 'npm test',
};
const unverifiedInspection: EvidenceItem = {
  kind: 'inspection',
  status: 'unverified',
  summary: 'claude CLI run exited success (self-reported)',
};

function ev(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return { summary: 'work complete', items: [passedCmd], ...overrides };
}

describe('validateCompletionEvidence — acceptance criteria (roadmap :446)', () => {
  it('T-gate-missing: completed without evidence → completion_evidence_missing rejection', () => {
    expect(validateCompletionEvidence('completed', undefined)).toEqual({
      ok: false,
      code: 'completion_evidence_missing',
    });
  });
});

describe('validateCompletionEvidence — gate invariants (E9: gate=structure, verified=grade)', () => {
  it('completed + verified items → pass, honest verifiedItemCount', () => {
    const r = validateCompletionEvidence(
      'completed',
      ev({ items: [passedCmd, unverifiedInspection, { kind: 'artifact', status: 'verified', summary: 'artifact verified' }] }),
    );
    expect(r).toEqual({ ok: true, verifiedItemCount: 2 });
  });

  it('completed + well-formed but verified 0 (unverified self-report only) → pass + count 0 (E9 grade model)', () => {
    const r = validateCompletionEvidence('completed', ev({ items: [unverifiedInspection] }));
    expect(r).toEqual({ ok: true, verifiedItemCount: 0 });
  });

  it('no laundering (CL1): ClaudeWorker (A′) honest evidence is not counted verified', () => {
    // Label run-success as inspection/unverified — does not promote to command+passed
    expect(isVerifiedItem(unverifiedInspection)).toBe(false);
    expect(isVerifiedItem(passedCmd)).toBe(true);
    expect(isVerifiedItem({ kind: 'command', status: 'failed', summary: 's', command: 'c' })).toBe(false);
  });

  it('completed + empty/whitespace summary → completion_evidence_empty_summary', () => {
    expect(validateCompletionEvidence('completed', ev({ summary: '' }))).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
    expect(validateCompletionEvidence('completed', ev({ summary: '   ' }))).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
  });

  it('completed + empty items → completion_evidence_no_items', () => {
    expect(validateCompletionEvidence('completed', ev({ items: [] }))).toEqual({
      ok: false,
      code: 'completion_evidence_no_items',
    });
  });

  it('command item missing/blank command → completion_evidence_invalid_item', () => {
    const noCmd = { kind: 'command', status: 'passed', summary: 's' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [noCmd] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
    const blankCmd = { kind: 'command', status: 'passed', summary: 's', command: '  ' } as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [blankCmd] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });

  it('non-array items/files ({}) yields fail-closed verdict without throw (gate exception collapse guard)', () => {
    const nonArrayItems = { summary: 's', items: {} } as unknown as CompletionEvidence;
    expect(validateCompletionEvidence('completed', nonArrayItems)).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
    const nonArrayFiles = { summary: 's', items: [passedCmd], files: {} } as unknown as CompletionEvidence;
    expect(validateCompletionEvidence('completed', nonArrayFiles)).toEqual({
      ok: false,
      code: 'completion_evidence_bad_file_path',
    });
  });

  it('unknown kind / disguised status per kind (command+verified) → completion_evidence_invalid_item (G6 closed enum)', () => {
    const unknownKind = { kind: 'vibe', status: 'passed', summary: 's' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [unknownKind] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
    const disguised = { kind: 'command', status: 'verified', summary: 's', command: 'c' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [disguised] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });
});

describe('validateCompletionEvidence — failed asymmetry + X8 shape validation shared', () => {
  it('failed + reason (summary) only, no items → pass (verification invariant not applied)', () => {
    expect(validateCompletionEvidence('failed', { summary: 'spawn error', items: [] })).toEqual({
      ok: true,
      verifiedItemCount: 0,
    });
  });

  it('failed + missing evidence/summary → failure_reason_missing', () => {
    expect(validateCompletionEvidence('failed', undefined)).toEqual({ ok: false, code: 'failure_reason_missing' });
    expect(validateCompletionEvidence('failed', { summary: ' ', items: [] })).toEqual({
      ok: false,
      code: 'failure_reason_missing',
    });
  });

  it('failed + diagnostic item (command+failed) → pass / malformed item → reject (X8: audit log residue block)', () => {
    expect(
      validateCompletionEvidence('failed', {
        summary: 'build failed',
        items: [{ kind: 'command', status: 'failed', summary: 'build', command: 'npm run build' }],
      }),
    ).toEqual({ ok: true, verifiedItemCount: 0 });
    const malformed = { kind: 'command', status: 'exploded', summary: 's', command: 'c' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('failed', { summary: 'failure', items: [malformed] })).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });
});

describe('validateCompletionEvidence — DoS cap (E12)', () => {
  it(`items ${EVIDENCE_MAX_ITEMS + 1} → completion_evidence_too_large`, () => {
    const items = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, () => ({ ...passedCmd }));
    expect(validateCompletionEvidence('completed', ev({ items }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it('string field over 4KiB (multibyte counted in bytes) → too_large', () => {
    // Hangul syllable (3 UTF-8 bytes) — 1366 chars * 3 = 4098 bytes > 4096
    const big = '한'.repeat(Math.ceil((EVIDENCE_MAX_STR_BYTES + 1) / 3));
    expect(validateCompletionEvidence('completed', ev({ summary: big }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
    const bigOutput = { ...passedCmd, output: 'x'.repeat(EVIDENCE_MAX_STR_BYTES + 1) } as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [bigOutput] }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it(`files ${EVIDENCE_MAX_FILES + 1} → too_large`, () => {
    const files = Array.from({ length: EVIDENCE_MAX_FILES + 1 }, (_, i) => `src/f${i}.ts`);
    expect(validateCompletionEvidence('completed', ev({ files }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it('serialized total over 64KiB → too_large (each per-field cap passes individually)', () => {
    // 20 items × 3.9KiB output ≈ 78KiB — under per-field caps, over total cap
    const items = Array.from({ length: 20 }, () => ({ ...passedCmd, output: 'y'.repeat(3900) }) as EvidenceItem);
    expect(validateCompletionEvidence('completed', ev({ items }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });
});

describe('isSafeRelPath — sanitization (X7+G5 variant matrix)', () => {
  const reject = [
    '/etc/x', // POSIX absolute
    'C:\\x', // drive absolute
    '\\\\host\\x', // UNC
    '\\\\?\\C:\\x', // NT namespace
    'C:foo', // drive-relative
    'a.txt:ads', // NTFS ADS
    'file://x', // URL scheme
    'a/../b', // parent escape
    '..', // parent escape alone
    'a\\..\\b', // backslash separator escape
    'a\u0000b', // null byte
    'a\nb', // C0 control char
    '', // empty string
    'x'.repeat(EVIDENCE_MAX_FILE_PATH_BYTES + 1), // overlong
  ];
  it.each(reject)('rejects: %j', (p) => {
    expect(isSafeRelPath(p)).toBe(false);
  });

  const accept = [
    'src/a.ts',
    'docs/한글.md', // multibyte filename (test data)
    'a\\b/c.txt', // mixed-separator relative path
    '%2e%2e%2f', // mojibake policy: pass as literal segment (consumer must not decode)
    './a.ts', // '.' segment is harmless
  ];
  it.each(accept)('accepts: %j', (p) => {
    expect(isSafeRelPath(p)).toBe(true);
  });

  it('non-string → reject', () => {
    expect(isSafeRelPath(null)).toBe(false);
    expect(isSafeRelPath(42)).toBe(false);
  });
});

describe('normalizeCompletionEvidenceWire — wire guard (X6: plain+hasOwn+normalize)', () => {
  const validWire = {
    summary: 'done',
    items: [{ kind: 'command', status: 'passed', summary: 'tests', command: 'npm test' }],
    files: ['src/a.ts'],
  };

  it('valid input → copies known fields into new object (separate from original)', () => {
    const out = normalizeCompletionEvidenceWire(validWire);
    expect(out).toEqual({
      summary: 'done',
      items: [{ kind: 'command', status: 'passed', summary: 'tests', command: 'npm test' }],
      files: ['src/a.ts'],
    });
    expect(out).not.toBe(validWire);
    expect(out!.items).not.toBe(validWire.items);
    expect(out!.files).not.toBe(validWire.files);
  });

  it('recordedBy/recordedAt·unknown key smuggling → dropped (server-only stamp protection)', () => {
    const out = normalizeCompletionEvidenceWire({
      ...validWire,
      recordedBy: 'ws-forged',
      recordedAt: '2020-01-01T00:00:00Z',
      smuggle: { evil: true },
    });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('recordedBy');
    expect(out).not.toHaveProperty('recordedAt');
    expect(out).not.toHaveProperty('smuggle');
  });

  it('JSON.parse __proto__ own-key → no pollution in output (prototype pollution block)', () => {
    const wire = JSON.parse(
      '{"summary":"s","items":[],"__proto__":{"polluted":"yes"}}',
    ) as unknown;
    const out = normalizeCompletionEvidenceWire(wire);
    expect(out).not.toBeNull();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out as object, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('non-plain object (class instance·inherited fields) → null', () => {
    class Fake {
      summary = 's';
      items: unknown[] = [];
    }
    expect(normalizeCompletionEvidenceWire(new Fake())).toBeNull();
    // Object with summary only on prototype chain — rejected by hasOwn check
    expect(normalizeCompletionEvidenceWire(Object.create({ summary: 's', items: [] }))).toBeNull();
  });

  it('null-prototype object (normal wire product) → pass', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.summary = 's';
    o.items = [];
    expect(normalizeCompletionEvidenceWire(o)).toEqual({ summary: 's', items: [] });
  });

  it('malformed shape → null: non-array items / unknown kind / disguised status / non-string files', () => {
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: 'nope' })).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'vibe', status: 'ok', summary: 'x' }] })).toBeNull();
    expect(
      normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'command', status: 'verified', summary: 'x', command: 'c' }] }),
    ).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: [42] })).toBeNull();
    expect(normalizeCompletionEvidenceWire('str')).toBeNull();
    expect(normalizeCompletionEvidenceWire(null)).toBeNull();
    expect(normalizeCompletionEvidenceWire([])).toBeNull();
  });

  it('wire enforces file path sanitization — non-relative paths → null (additive-inert window protection)', () => {
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: ['/etc/passwd'] })).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: ['a/../b'] })).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: ['C:foo'] })).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: ['src/ok.ts'] })).toEqual({
      summary: 's',
      items: [],
      files: ['src/ok.ts'],
    });
  });

  it('shape-only: empty summary passes wire; authority validator rejects (role separation)', () => {
    const out = normalizeCompletionEvidenceWire({ summary: '', items: [] });
    expect(out).toEqual({ summary: '', items: [] });
    expect(validateCompletionEvidence('completed', out!)).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
  });

  it('cap exceeded → null (independently enforced on wire too)', () => {
    const items = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, () => ({
      kind: 'command',
      status: 'passed',
      summary: 's',
      command: 'c',
    }));
    expect(normalizeCompletionEvidenceWire({ summary: 's', items })).toBeNull();
  });
});
