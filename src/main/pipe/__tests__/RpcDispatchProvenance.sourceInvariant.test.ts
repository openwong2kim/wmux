// Dispatch markers are main-process capabilities. Pin each positive production
// writer so a future transport or nested call cannot widen a trust boundary
// without an explicit security-review test change.

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
  function markerWriters(marker: string): string[] {
    const writers: string[] = [];

    for (const file of collectProductionTsFiles(MAIN_DIR)) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        // Record every object-literal write, not just a literal `true`. A
        // transport must not evade this boundary with `true as const`, a
        // shorthand, ternary, or computed boolean.
        const writesMarker =
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === marker;
        const forwardsMarker =
          ts.isShorthandPropertyAssignment(node) && node.name.text === marker;
        if (writesMarker || forwardsMarker) {
          writers.push(path.relative(MAIN_DIR, file).replaceAll('\\', '/'));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    return writers.sort();
  }

  it('keeps externalWire writes inside PipeServer and the router context constructor', () => {
    expect(markerWriters('externalWire')).toEqual([
      'pipe/PipeServer.ts',
      'pipe/RpcRouter.ts',
    ]);
  });

  it('keeps operator writes inside the renderer bridge and router context constructor', () => {
    expect(markerWriters('operator')).toEqual([
      'index.ts',
      'pipe/RpcRouter.ts',
    ]);
  });
});
