// scripts/verify.sh runs the tests that read a changed source file as text
// beside `vitest --changed`, which follows imports and so never picks them.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrNull, sourceReaders } from '../lib/verify-source-readers.mjs';

const pick = (changed, files) => sourceReaders({
  changed,
  tests: Object.keys(files),
  read: (file) => files[file] ?? null,
});

describe('sourceReaders', () => {
  it('picks a test that joins the file name to its own directory', () => {
    expect(pick(['src/renderer/hooks/useTerminal.ts'], {
      'src/renderer/hooks/__tests__/a.test.ts': "const src = readSourceText(path.join(__dirname, '..', 'useTerminal.ts'));",
      'src/renderer/hooks/__tests__/b.test.ts': "const src = fs.readFileSync(resolve(__dirname, '../useTerminal.ts'), 'utf8');",
      'src/renderer/hooks/__tests__/c.test.ts': 'const src = fs.readFileSync(`${__dirname}/../useTerminal.ts`, "utf8");',
    })).toEqual([
      'src/renderer/hooks/__tests__/a.test.ts',
      'src/renderer/hooks/__tests__/b.test.ts',
      'src/renderer/hooks/__tests__/c.test.ts',
    ]);
  });

  it('picks a path from the repository root and one joined from separate segments', () => {
    expect(pick(['src/daemon/index.ts', 'src/main/ipc/handlers/pty.handler.ts'], {
      'src/main/__tests__/root.test.ts': "readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8')",
      'src/main/__tests__/joined.test.ts': "const daemonIndexPath = path.join(__dirname, '..', '..', 'daemon', 'index.ts');",
    })).toEqual(['src/main/__tests__/joined.test.ts', 'src/main/__tests__/root.test.ts']);
  });

  it('leaves out a same-named file elsewhere, an import specifier, and a changed test', () => {
    expect(pick(['src/daemon/index.ts', 'src/renderer/hooks/useTerminal.ts', 'src/x/__tests__/y.test.ts'], {
      // index.ts of another directory.
      'src/main/__tests__/other.test.ts': "readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8')",
      // An import names the module without its extension.
      'src/renderer/hooks/__tests__/imports.test.ts': "import { useTerminal } from '../useTerminal';",
      // A changed test is not a source; `--changed` runs it already.
      'src/z/__tests__/reads-test.test.ts': "readFileSync(path.join(__dirname, '..', '..', 'x', '__tests__', 'y.test.ts'))",
    })).toEqual([]);
  });

  it('picks a test that pins a value in package.json', () => {
    expect(pick(['package.json'], {
      'scripts/__tests__/pin.test.mjs': "const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));\nconst root = path.join(__dirname, '..', '..');",
    })).toEqual(['scripts/__tests__/pin.test.mjs']);
  });

  it('picks nothing when no source changed', () => {
    expect(pick(['docs/a.md', 'assets/icon.png'], {
      'src/a/__tests__/a.test.ts': "readFileSync(path.join(__dirname, '..', 'a.md'))",
    })).toEqual([]);
  });

  // Suites that went red in CI after verify.sh had passed.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  it.each([
    ['src/renderer/hooks/useTerminal.ts', [
      // #3330: both slice useTerminal.ts by a character count.
      'src/renderer/hooks/__tests__/useTerminal.hiddenRetention.test.ts',
      'src/renderer/hooks/__tests__/useTerminal.webViewer.os.test.ts',
    ]],
    // #3336: the koffi packaging pins read broker.ts through a repository root kept in a variable.
    ['src/mcp/broker.ts', ['src/mcp/__tests__/brokerKoffiPackaging.test.ts']],
  ])('on this tree, a change to %s picks the suites that read it as text', (changed, suites) => {
    expect(sourceReaders({ changed: [changed], tests: suites, read: readOrNull(root) })).toEqual(suites);
  });
});
