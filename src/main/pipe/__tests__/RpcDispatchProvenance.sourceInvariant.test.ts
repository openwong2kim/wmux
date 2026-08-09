// The external-wire marker is a main-process capability: production code may
// mint it only at the authenticated/rate-limited PipeServer boundary. Pin the
// sole positive writer so a future transport or nested call cannot widen the
// trust boundary without an explicit security-review test change.

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_DIR = path.resolve(__dirname, '..', '..');

function collectProductionTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionTsFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

describe('RPC dispatch provenance source invariant', () => {
  it('keeps PipeServer as the sole production writer of externalWire: true', () => {
    const writers: string[] = [];

    for (const file of collectProductionTsFiles(MAIN_DIR)) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        const writesPositiveMarker =
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === 'externalWire' &&
          node.initializer.kind === ts.SyntaxKind.TrueKeyword;
        const forwardsPositiveMarker =
          ts.isShorthandPropertyAssignment(node) && node.name.text === 'externalWire';
        if (writesPositiveMarker || forwardsPositiveMarker) {
          writers.push(path.relative(MAIN_DIR, file).replaceAll('\\', '/'));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(writers).toEqual(['pipe/PipeServer.ts']);
  });
});
