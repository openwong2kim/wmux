import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Terminal viewport bounds', () => {
  it('clips xterm rounding overflow inside the terminal surface', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'Terminal.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).toContain("minHeight: 0,\n        position: 'relative',\n        overflow: 'hidden'");
    expect(source).toContain("padding: '4px', overflow: 'hidden'");
  });
});
