import { describe, expect, it } from 'vitest';
import { safeParseJson } from '../helpers';

describe('safeParseJson', () => {
  it('reads a file that starts with a byte order mark', () => {
    const warnings: string[] = [];
    expect(safeParseJson('c.json', '﻿{"mcpServers":{"a":{}}}', warnings)).toEqual({ mcpServers: { a: {} } });
    expect(warnings).toEqual([]);
  });
});
