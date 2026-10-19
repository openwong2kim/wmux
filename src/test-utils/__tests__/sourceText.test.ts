import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockAt, readSourceText } from '../sourceText';

describe('readSourceText', () => {
  it('reads a CRLF checkout as LF, so a CRLF and an LF checkout give the same text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-source-text-'));
    try {
      fs.writeFileSync(path.join(dir, 'crlf.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
      fs.writeFileSync(path.join(dir, 'lf.ts'), 'const a = 1;\nconst b = 2;\n');
      expect(readSourceText(path.join(dir, 'crlf.ts'))).toBe('const a = 1;\nconst b = 2;\n');
      expect(readSourceText(path.join(dir, 'crlf.ts'))).toBe(readSourceText(path.join(dir, 'lf.ts')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('blockAt', () => {
  const at = (src: string, anchor: string) => blockAt(src, src.indexOf(anchor));

  it('returns the anchor through the end of its body, however long the body is', () => {
    const src = 'const f = () => {\n  if (a) { b(); }\n  c();\n};\nconst g = () => { d(); };\n';
    expect(at(src, 'const f')).toBe('const f = () => {\n  if (a) { b(); }\n  c();\n}');
    expect(at(src, 'const g')).toBe('const g = () => { d(); }');
  });

  it('skips braces in comments, strings and template text, and counts a template ${} as code', () => {
    const src = [
      'const f = () => {',
      "  // a } in a comment",
      '  /* and { here */',
      "  const s = '}' + \"{\";",
      '  const t = `}${ { a: 1 }.a }{`;',
      '  done();',
      '};',
      'after();',
    ].join('\n');
    expect(at(src, 'const f').endsWith('  done();\n}')).toBe(true);
  });

  it('skips a destructuring pattern or object type before the body', () => {
    const src = 'const f = useCallback(({ id }: { id: string }): Promise<{ ok: boolean }> => {\n  run(id);\n}, []);';
    expect(at(src, 'const f').endsWith('{\n  run(id);\n}')).toBe(true);
  });

  it('throws on a missing anchor or a block that never closes', () => {
    expect(() => blockAt('const f = () => { a();', 0)).toThrow(/no complete block/);
    expect(() => blockAt('x', -1)).toThrow(/anchor not found/);
  });
});
