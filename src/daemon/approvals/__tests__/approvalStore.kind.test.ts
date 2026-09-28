// approvals.json keeps each record's kind (from a closed set) and its bounded
// tool fields across a daemon restart, instead of reading every record back
// as `awaiting_input`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { coerceApprovalState, getApprovalStatePath } from '../approvalStore';
import { ApprovalRegistry } from '../ApprovalRegistry';

const base = { sessionId: 's', agent: 'claude', createdAt: 1, state: 'expired' };

describe('coerceApprovalState — kind and tool fields', () => {
  it('keeps every known kind and reads anything else as awaiting_input', () => {
    const { requests } = coerceApprovalState({
      version: 1,
      requests: [
        { ...base, id: 'a', kind: 'awaiting_input' },
        { ...base, id: 'b', kind: 'awaiting_permission' },
        { ...base, id: 'c', kind: 'terminal_prompt' },
        { ...base, id: 'd', kind: 'root_shell' },
        { ...base, id: 'e' },
      ],
    });
    expect(requests.map((r) => [r.id, r.kind])).toEqual([
      ['a', 'awaiting_input'],
      ['b', 'awaiting_permission'],
      ['c', 'terminal_prompt'],
      ['d', 'awaiting_input'],
      ['e', 'awaiting_input'],
    ]);
  });

  it('keeps toolName and summary, cleaned and bounded', () => {
    const [record] = coerceApprovalState({
      version: 1,
      requests: [{
        ...base,
        id: 'a',
        kind: 'terminal_prompt',
        toolName: 'Bash\n',
        summary: `line\u0000one ${'x'.repeat(500)}`,
      }],
    }).requests;
    expect(record?.toolName).toBe('Bash');
    expect(record?.summary).toHaveLength(201);
    expect(record?.summary?.endsWith('…')).toBe(true);
    expect(record?.summary).not.toContain('\u0000');
  });

  it('drops a summary or toolName that is not a usable string', () => {
    const [record] = coerceApprovalState({
      version: 1,
      requests: [{ ...base, id: 'a', kind: 'terminal_prompt', toolName: 42, summary: '   ' }],
    }).requests;
    expect(record).not.toHaveProperty('toolName');
    expect(record).not.toHaveProperty('summary');
  });
});

describe('ApprovalRegistry restart — kind survives invalidation', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approval-kind-test-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('a pending terminal_prompt comes back expired, still a terminal_prompt', () => {
    fs.writeFileSync(getApprovalStatePath(tmpDir), JSON.stringify({
      version: 1,
      requests: [{
        id: 'req-1', sessionId: 'pty-a', agent: 'claude', createdAt: 1, state: 'pending',
        kind: 'terminal_prompt', toolName: 'Bash', summary: 'npm test',
      }],
    }));
    const registry = new ApprovalRegistry({
      wmuxDir: tmpDir,
      readScreenTail: async () => null,
      writeToSession: () => false,
      now: () => 5,
    });
    expect(registry.list().pending).toEqual([]);
    expect(registry.list().recentlyResolved).toMatchObject([
      { id: 'req-1', kind: 'terminal_prompt', state: 'expired', toolName: 'Bash', summary: 'npm test' },
    ]);
  });
});
