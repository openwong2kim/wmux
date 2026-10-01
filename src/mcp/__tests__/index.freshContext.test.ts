import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FRESH_CONTEXT_TIMEOUT_MS,
  NEW_TASK_SEND_CLIENT_TIMEOUT_MS,
  NEW_TASK_SEND_MAIN_TIMEOUT_MS,
  TERMINAL_SEND_NEW_TASK_TIMEOUT_MS,
} from '../../shared/freshContext';

// #1680 — terminal_send `new_task` and the new-task timeouts. Source-level,
// like the other invariants over src/mcp/index.ts: the shapes and handlers are
// module-private.
describe('MCP fresh context per task (#1680)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const between = (from: string, to: string): string => {
    const start = src.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    return src.slice(start, src.indexOf(to, start));
  };

  it('terminal_send takes new_task, described as a new-task-only signal that needs submit', () => {
    const shape = between('const TERMINAL_SEND_SHAPE', 'const TERMINAL_SEND_KEY_SHAPE');
    expect(shape).toMatch(/new_task: z\.boolean\(\)\.optional\(\)/);
    expect(shape).toMatch(/with submit/);
    expect(shape).toMatch(/never for a follow-up/);
    expect(shape).toMatch(/NOT sent/);
  });

  it('terminal_send forwards newTask and waits out the fresh-context step', () => {
    const handler = between("'terminal_send',", "'terminal_send_key',");
    expect(handler).toMatch(/base\.newTask = true/);
    expect(handler).toMatch(/callRpc\('input\.send', base, TERMINAL_SEND_NEW_TASK_TIMEOUT_MS\)/);
  });

  it('send_message gets no new param; a new task (no task_id) gets the longer client budget', () => {
    const shape = between('const SEND_MESSAGE_SHAPE', 'export function createWmuxServer');
    expect(shape).not.toMatch(/new_task/);
    expect(src).toMatch(/!task_id\s*\?\s*callRpc\('a2a\.task\.send', params, NEW_TASK_SEND_CLIENT_TIMEOUT_MS\)/);
  });

  it('every layer outwaits the one below it', () => {
    // The step itself plus the reads around it and the paste after it.
    expect(NEW_TASK_SEND_MAIN_TIMEOUT_MS).toBeGreaterThan(FRESH_CONTEXT_TIMEOUT_MS + 5_000);
    expect(NEW_TASK_SEND_CLIENT_TIMEOUT_MS).toBeGreaterThan(NEW_TASK_SEND_MAIN_TIMEOUT_MS);
    // input.send: the step plus the ordinary 2 s submit receipt.
    expect(TERMINAL_SEND_NEW_TASK_TIMEOUT_MS).toBeGreaterThan(FRESH_CONTEXT_TIMEOUT_MS + 5_000);
  });
});
