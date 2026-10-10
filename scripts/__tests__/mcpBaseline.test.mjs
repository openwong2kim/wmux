import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASELINE_HINT, createBaselineGuard, writeBaseline } from '../mcpBaseline.mjs';

describe('MCP protocol baseline guard', () => {
  it('check mode: a changed hash fails with the update instruction', () => {
    const g = createBaselineGuard();
    const config = { wireResultSha256: 'aaa', toolNames: ['a'] };
    expect(() => g.expect(config, 'wireResultSha256', 'bbb', 'commander: raw tool schemas changed')).toThrow(
      'MCP tool schema changed; run npm run mcp:baseline:update',
    );
    expect(() => g.expect(config, 'toolNames', ['a', 'b'], 'commander: tool surface changed')).toThrow(BASELINE_HINT);
    expect(config.wireResultSha256).toBe('aaa');
  });

  it('check mode: an unchanged value passes silently', () => {
    const g = createBaselineGuard();
    g.expect({ toolNames: ['a', 'b'] }, 'toolNames', ['a', 'b'], 'x');
    expect(g.changes).toEqual([]);
  });

  it('update mode: adopts the measured value and records it', () => {
    const g = createBaselineGuard({ update: true });
    const config = { wireResultSha256: 'aaa', instructionSha256: 'i' };
    g.expect(config, 'wireResultSha256', 'bbb', 'commander: raw tool schemas changed');
    g.expect(config, 'instructionSha256', 'i', 'same');
    expect(config.wireResultSha256).toBe('bbb');
    expect(g.changes).toEqual([{ label: 'commander: raw tool schemas changed', key: 'wireResultSha256' }]);
  });

  it('never rewrites a budget', () => {
    const g = createBaselineGuard({ update: true });
    expect(() => g.expect({ maxListBytes: 1 }, 'maxListBytes', 2, 'x')).toThrow(/not updatable/);
  });

  it('writes the baseline in the checked-in format', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-base-')), 'b.json');
    writeBaseline(f, { schemaVersion: 2, profiles: {} });
    expect(fs.readFileSync(f, 'utf8')).toBe('{\n  "schemaVersion": 2,\n  "profiles": {}\n}\n');
  });

  it('the checked-in baseline round-trips through writeBaseline unchanged', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-protocol-baseline.json');
    const raw = fs.readFileSync(file, 'utf8');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-base-')), 'b.json');
    writeBaseline(f, JSON.parse(raw));
    expect(fs.readFileSync(f, 'utf8')).toBe(raw);
  });
});
