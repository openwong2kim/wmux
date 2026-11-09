import { describe, it, expect } from 'vitest';
import { editJsonKeys, JsonEditError } from '../jsonEdit';

describe('editJsonKeys', () => {
  it('round-trip with no edits is byte-identical: 2 spaces', () => {
    const json = '{\n  "a": 1,\n  "b": 2\n}\n';
    expect(editJsonKeys(json, [])).toBe(json);
  });

  it('round-trip with no edits is byte-identical: 4 spaces', () => {
    const json = '{\n    "a": 1,\n    "b": 2\n}\n';
    expect(editJsonKeys(json, [])).toBe(json);
  });

  it('round-trip with no edits is byte-identical: tab', () => {
    const json = '{\n\t"a": 1,\n\t"b": 2\n}\n';
    expect(editJsonKeys(json, [])).toBe(json);
  });

  it('round-trip with no edits is byte-identical: CRLF', () => {
    const json = '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
    expect(editJsonKeys(json, [])).toBe(json);
  });

  it('round-trip with no edits is byte-identical: no trailing newline', () => {
    const json = '{\n  "a": 1,\n  "b": 2\n}';
    expect(editJsonKeys(json, [])).toBe(json);
  });

  it('sets and deletes nested keys while preserving indentation and CRLF', () => {
    const input = '{\r\n  "permissions": {\r\n    "deny": [\r\n      "Bash"\r\n    ]\r\n  },\r\n  "enabled": true\r\n}\r\n';
    const edited = editJsonKeys(input, [
      { path: ['permissions', 'deny'], op: 'set', value: ['Bash', 'WebSearch'] },
      { path: ['enabled'], op: 'delete' },
    ]);
    expect(JSON.parse(edited)).toEqual({
      permissions: {
        deny: ['Bash', 'WebSearch'],
      },
    });
    expect(edited).toContain('\r\n');
    expect(edited).toMatch(/^  "permissions"/m);
  });

  it('preserves key order when modifying an existing key', () => {
    const input = '{\n  "alpha": 1,\n  "beta": 2,\n  "gamma": 3\n}\n';
    const edited = editJsonKeys(input, [
      { path: ['beta'], op: 'set', value: 99 },
    ]);
    expect(edited).toBe('{\n  "alpha": 1,\n  "beta": 99,\n  "gamma": 3\n}\n');
    expect(Object.keys(JSON.parse(edited))).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('creates missing parent objects for set operations', () => {
    const input = '{\n  "existing": true\n}\n';
    const edited = editJsonKeys(input, [
      { path: ['deeply', 'nested', 'config', 'flag'], op: 'set', value: 'yes' },
    ]);
    expect(JSON.parse(edited)).toEqual({
      existing: true,
      deeply: {
        nested: {
          config: {
            flag: 'yes',
          },
        },
      },
    });
  });

  it('rejects invalid JSON with trailing commas', () => {
    const invalid = '{\n  "a": 1,\n}\n';
    expect(() => editJsonKeys(invalid, [])).toThrow(JsonEditError);
  });

  it('rejects invalid JSON with comments', () => {
    const invalid = '{\n  // comment\n  "a": 1\n}\n';
    expect(() => editJsonKeys(invalid, [])).toThrow(JsonEditError);
  });

  it('handles array index mutations and deletions', () => {
    const input = '{\n  "items": [10, 20, 30]\n}\n';
    const edited1 = editJsonKeys(input, [
      { path: ['items', 1], op: 'set', value: 25 },
    ]);
    expect(JSON.parse(edited1)).toEqual({ items: [10, 25, 30] });

    const edited2 = editJsonKeys(edited1, [
      { path: ['items', 0], op: 'delete' },
    ]);
    expect(JSON.parse(edited2)).toEqual({ items: [25, 30] });
  });

  it('ignores delete on nonexistent paths', () => {
    const input = '{\n  "a": 1\n}\n';
    expect(editJsonKeys(input, [{ path: ['nonexistent', 'nested'], op: 'delete' }])).toBe(input);
  });

  it('reads past a byte order mark and keeps it', () => {
    const input = '\uFEFF{\n  "a": 1\n}\n';
    expect(editJsonKeys(input, [])).toBe(input);
    expect(editJsonKeys(input, [{ path: ['a'], op: 'set', value: 1 }])).toBe(input);
    expect(editJsonKeys(input, [{ path: ['b'], op: 'set', value: 2 }])).toBe('\uFEFF{\n  "a": 1,\n  "b": 2\n}\n');
  });
});
