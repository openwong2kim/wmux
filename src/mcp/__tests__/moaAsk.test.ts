import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { MOA_ASK_STATUS_TOOL, MOA_ASK_TOOL, parseMoaAskInput } from '../../shared/moaAsk';
import { MOA_ASK_DESCRIPTION, MOA_ASK_INPUT_SHAPE, MOA_ASK_STATUS_DESCRIPTION, MOA_ASK_STATUS_INPUT_SHAPE } from '../moaAsk';

const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scripts/mcp-protocol-baseline.json'), 'utf8')) as {
  profiles: Record<string, { maxListBytes: number; toolNames: string[] }>;
};

describe('moa_ask MCP schema (unregistered contract)', () => {
  it('is absent from every published profile', () => {
    for (const [profile, p] of Object.entries(BASELINE.profiles)) {
      expect(p.toolNames, profile).not.toContain(MOA_ASK_TOOL);
      expect(p.toolNames, profile).not.toContain(MOA_ASK_STATUS_TOOL);
    }
  });

  it('both tools together stay under 2 KB of tools/list when registered', () => {
    const entry = (name: string, description: string, shape: z.ZodRawShape): string =>
      JSON.stringify({ name, description, inputSchema: z.toJSONSchema(z.object(shape)) });
    const bytes = Buffer.byteLength(entry(MOA_ASK_TOOL, MOA_ASK_DESCRIPTION, MOA_ASK_INPUT_SHAPE), 'utf8')
      + Buffer.byteLength(entry(MOA_ASK_STATUS_TOOL, MOA_ASK_STATUS_DESCRIPTION, MOA_ASK_STATUS_INPUT_SHAPE), 'utf8');
    expect(bytes).toBeLessThan(2048);
  });

  it('accepts every input main accepts (main stays the stricter check)', () => {
    const schema = z.object(MOA_ASK_INPUT_SHAPE);
    const inputs = [
      { question: 'Reuse it?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No', description: 'd' }], kind: 'approach', askId: 'a1', context: 'c' },
      { action: { type: 'merge', prNumber: 12, expectHead: 'a'.repeat(40) }, askId: 'a2' },
    ];
    for (const input of inputs) {
      expect(parseMoaAskInput(input).ok).toBe(true);
      expect(schema.safeParse(input).success).toBe(true);
    }
  });
});
