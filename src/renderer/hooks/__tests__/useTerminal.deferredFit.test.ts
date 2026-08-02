import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

describe('useTerminal deferred resize fit wiring', () => {
  it('routes ResizeObserver work through the deferred fit scheduler', () => {
    expect(source).toMatch(
      /const resizeObserver = new ResizeObserver\(\(\) => \{\s*resizeFit\.requestFit\(\);\s*\}\);/,
    );
  });

  it('retries pending resize work from the selection-change callback', () => {
    expect(source).toMatch(
      /terminal\.onSelectionChange\(\(\) => \{[\s\S]*?resizeFit\.onSelectionChange\(\);\s*\}\);/,
    );
  });

  it('records every non-observer fit skipped for an active selection', () => {
    const deferredCalls = source.match(/deferUntilSelectionClears\(\)/g) ?? [];
    expect(deferredCalls).toHaveLength(3);
  });
});
