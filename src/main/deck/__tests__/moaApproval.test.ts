// #1772 — the desktop's read and answer of Moa's own permission prompt, and
// the boundary that keeps every other caller off the daemon RPCs behind it.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { answerMoaApproval, MOA_ANSWER_PROMPT_RPC, MOA_PROMPT_RPC, readMoaApproval } from '../moaApproval';
import { ALL_RPC_METHODS } from '../../../shared/rpc';
import { METHOD_CAPABILITY } from '../../mcp/methodCapabilityMap';

const FP = 'f'.repeat(32);
const client = (answer: unknown) => ({ rpc: vi.fn(async () => answer) });

describe('readMoaApproval', () => {
  it('maps the daemon\'s view, keeping only known fields', async () => {
    const c = client({ ok: true, prompt: {
      id: 'ap-1', toolName: 'Bash', summary: 'ls', question: 'Do you want to proceed?', reason: 'rule',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No', extra: 1 }], promptFingerprint: FP,
      answerable: true, answered: false, createdAt: 5, secret: 'x',
    } });
    expect(await readMoaApproval(c)).toEqual({
      id: 'ap-1', toolName: 'Bash', summary: 'ls', question: 'Do you want to proceed?', reason: 'rule',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], promptFingerprint: FP,
      answerable: true, answered: false, createdAt: 5,
    });
    expect(c.rpc).toHaveBeenCalledWith(MOA_PROMPT_RPC, {});
  });

  it('is null with no daemon, no record, a refusal or a throw; answerable needs choices and a fingerprint', async () => {
    expect(await readMoaApproval(null)).toBeNull();
    expect(await readMoaApproval(client({ ok: true, prompt: null }))).toBeNull();
    expect(await readMoaApproval(client({ ok: false, error: 'first-party only' }))).toBeNull();
    expect(await readMoaApproval({ rpc: async () => { throw new Error('pipe closed'); } })).toBeNull();
    expect(await readMoaApproval(client({ ok: true, prompt: { id: 'ap-1', answerable: true } }))).toMatchObject({ answerable: false });
  });
});

describe('answerMoaApproval', () => {
  const args = { approvalId: 'ap-1', choiceKey: '1', promptFingerprint: FP };

  it('sends the three fields only, and says ok on a press', async () => {
    const c = client({ ok: true, state: 'pending' });
    expect(await answerMoaApproval(c, { ...args, resolvedBy: 'mcp', decision: 'approve' })).toEqual({ ok: true });
    expect(c.rpc).toHaveBeenCalledWith(MOA_ANSWER_PROMPT_RPC, args);
  });

  it.each([
    ['already-answered', 'not_pending'],
    ['already-resolved', 'not_pending'],
    ['expired', 'not_pending'],
    ['not-pending', 'not_pending'],
    ['unauthorized', 'not_pending'],
    ['answer-too-soon', 'answer_too_soon'],
    ['invalid-choice', 'invalid'],
    ['prompt-changed', 'error'],
    ['answer-in-terminal', 'error'],
  ])('%s → %s', async (reason, code) => {
    expect(await answerMoaApproval(client({ ok: false, reason }), args)).toMatchObject({ ok: false, code });
  });

  it('refuses malformed args without asking the daemon; no daemon is an error', async () => {
    const c = client({ ok: true });
    expect(await answerMoaApproval(c, { approvalId: 'ap-1' })).toEqual({ ok: false, code: 'invalid' });
    expect(c.rpc).not.toHaveBeenCalled();
    expect(await answerMoaApproval(null, args)).toMatchObject({ ok: false, code: 'error' });
  });
});

describe('the Moa prompt RPCs are reachable from the renderer IPC only', () => {
  const methods = [MOA_PROMPT_RPC, MOA_ANSWER_PROMPT_RPC];

  it('are not RPC methods main routes, nor in the MCP capability map', () => {
    for (const method of methods) {
      expect((ALL_RPC_METHODS as readonly string[]).includes(method)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, method)).toBe(false);
    }
  });

  it('no pipe handler, MCP tool or CLI command names them', () => {
    const root = path.resolve(__dirname, '../../../..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    for (const dir of ['src/main/pipe', 'src/mcp', 'src/cli']) walk(path.join(root, dir));
    expect(files.length).toBeGreaterThan(10);
    const named = files.filter((file) => methods.some((m) => fs.readFileSync(file, 'utf8').includes(m)));
    expect(named).toEqual([]);
  });
});
