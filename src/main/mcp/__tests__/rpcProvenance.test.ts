import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isLocalExternalWireContext } from '../rpcProvenance';

const MAIN_DIR = path.resolve(__dirname, '..', '..');

function collectProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...collectProductionTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function writesExternalWireTrue(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'externalWire' &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('local external-wire provenance', () => {
  it('requires the positive PipeServer marker and excludes other sources', () => {
    expect(
      isLocalExternalWireContext({ origin: 'local', externalWire: true }),
    ).toBe(true);
    expect(isLocalExternalWireContext({ origin: 'local' })).toBe(false);
    expect(
      isLocalExternalWireContext({ origin: 'remote', externalWire: true }),
    ).toBe(false);
    expect(
      isLocalExternalWireContext({
        origin: 'local',
        externalWire: true,
        firstParty: true,
      }),
    ).toBe(false);
    expect(
      isLocalExternalWireContext({
        origin: 'local',
        externalWire: true,
        operator: true,
      }),
    ).toBe(false);
  });

  it('keeps PipeServer as the only production writer of externalWire authority', () => {
    const writers = collectProductionTsFiles(MAIN_DIR)
      .filter(writesExternalWireTrue)
      .map((file) => path.relative(MAIN_DIR, file).replaceAll('\\', '/'))
      .sort();

    expect(writers).toEqual(['pipe/PipeServer.ts']);
  });
});
