/**
 * PostToolUse kind promotion (#770).
 *
 * A locally-answered AskUserQuestion must reach the daemon as
 * `agent.input_answered` so the pending approval record — the card a phone is
 * still showing — is expired the moment the user answers on the PC, instead of
 * waiting for the `agent.stop` backstop at the end of a turn.
 *
 * This file exists because the first cut of the promotion additionally
 * required `payload.fired`, a field Claude Code's PostToolUse payload does not
 * carry, so the branch was unreachable and every AskUserQuestion still went out
 * as a plain activity stamp. Assert against payloads shaped like the real hook
 * contract (session_id / transcript_path / cwd / tool_name / tool_input /
 * tool_response) and nothing else.
 *
 * Both bridges are checked. They are separate hand-maintained JS files (the
 * OpenClaude one is a slimmed adaptation, not a byte copy), so a promotion
 * added to one silently skips the other unless something asserts on both.
 *
 * Same harness as bridgeActivityThrottle.test.ts: strip the CLI entrypoint,
 * re-export the function under test, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGES = [
  ['claude', 'integrations/claude/bin/wmux-bridge.mjs'],
  ['openclaude', 'integrations/openclaude/bin/wmux-bridge.mjs'],
] as const;
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
const kindOf: Record<string, (payload: unknown) => string> = {};

/** A PostToolUse payload with exactly the fields Claude Code sends. */
function postToolUsePayload(toolName: string) {
  return {
    session_id: 'c0ffee00-0000-4000-8000-000000000000',
    transcript_path: '/home/u/.claude/projects/p/c0ffee00-0000-4000-8000-000000000000.jsonl',
    cwd: '/home/u/project',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_response: {},
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-answered-'));
  for (const [name, rel] of BRIDGES) {
    const src = readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    const cut = src.indexOf(ENTRYPOINT_MARKER);
    expect(cut, `${rel} entrypoint marker`).toBeGreaterThan(-1);
    const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
      + '\nexport { getPostToolUseKind };\n';
    const mod = path.join(tmp, `${name}-under-test.mjs`);
    writeFileSync(mod, testable, 'utf8');
    ({ getPostToolUseKind: kindOf[name] } = await import(pathToFileURL(mod).href));
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.each(BRIDGES.map(([name]) => name))('%s bridge getPostToolUseKind', (name) => {
  it('promotes a completed AskUserQuestion to agent.input_answered', () => {
    expect(kindOf[name](postToolUsePayload('AskUserQuestion')))
      .toBe('agent.input_answered');
  });

  it('does not depend on any field beyond tool_name', () => {
    // Regression guard for the `payload.fired` predicate: the real payload
    // never carries it, so requiring it made the promotion dead code.
    expect(kindOf[name]({ tool_name: 'AskUserQuestion' }))
      .toBe('agent.input_answered');
  });

  it('leaves every other tool as a plain activity stamp', () => {
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Task', 'WebFetch']) {
      expect(kindOf[name](postToolUsePayload(tool))).toBe('agent.activity');
    }
  });

  it('falls back to activity for a missing or malformed payload', () => {
    expect(kindOf[name](undefined)).toBe('agent.activity');
    expect(kindOf[name](null)).toBe('agent.activity');
    expect(kindOf[name]({})).toBe('agent.activity');
  });

  it('is not fooled by a tool whose name merely contains AskUserQuestion', () => {
    expect(kindOf[name](postToolUsePayload('mcp__x__AskUserQuestion')))
      .toBe('agent.activity');
  });
});
