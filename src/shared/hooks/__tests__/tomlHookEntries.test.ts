// #3067 — line-level edits of jcode's [hooks] table: the user's commands and
// comments survive, and a shape that cannot be edited that way is never written.

import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { inspectTomlHooks, planTomlHooksInstall, planTomlHooksRemove } from '../tomlHookEntries';

const KEYS = ['session_start', 'turn_end'];
const CMD = 'node "/h/.wmux/hooks/wmux-jcode-bridge.mjs"';
const owned = (c: string) => c.includes('wmux-jcode-bridge.mjs');

function edited(text: string | null): string {
  const plan = planTomlHooksInstall(text, KEYS, CMD, owned);
  if (plan.kind !== 'edit' || plan.text === null) throw new Error(`expected an edit, got ${JSON.stringify(plan)}`);
  return plan.text;
}

describe('planTomlHooksInstall', () => {
  it('creates a [hooks] table in a missing file', () => {
    expect(parse(edited(null))).toEqual({ hooks: { session_start: [CMD], turn_end: [CMD] } });
  });

  it('appends [hooks] after the user config, keeping its comments', () => {
    const text = edited('# mine\nmodel = "x"\n');
    expect(text.startsWith('# mine\nmodel = "x"\n')).toBe(true);
    expect(parse(text)).toEqual({ model: 'x', hooks: { session_start: [CMD], turn_end: [CMD] } });
  });

  it("adds wmux's command alongside an existing entry, string or array, and keeps the trailing comment", () => {
    const text = edited('[hooks]\n# hooks\nturn_end = "~/bin/notify" # ping me\nsession_start = ["a", "b"]\n[other]\nk = 1\n');
    expect(text).toContain('# hooks\n');
    expect(text).toContain(`turn_end = ["~/bin/notify", ${JSON.stringify(CMD)}] # ping me`);
    expect(parse(text)).toEqual({ hooks: { turn_end: ['~/bin/notify', CMD], session_start: ['a', 'b', CMD] }, other: { k: 1 } });
  });

  it('replaces an older wmux command, and writes nothing once current', () => {
    const text = edited('[hooks]\nturn_end = ["node \\"/old/wmux-jcode-bridge.mjs\\""]\n');
    expect(parse(text)).toEqual({ hooks: { session_start: [CMD], turn_end: [CMD] } });
    expect(planTomlHooksInstall(text, KEYS, CMD, owned)).toEqual({ kind: 'edit', text: null });
  });

  it('keeps a trailing comment after a value with characters outside the BMP', () => {
    expect(edited('[hooks]\nturn_end = "😀😀" # keep\n')).toContain(`turn_end = ["😀😀", ${JSON.stringify(CMD)}] # keep`);
  });

  it('keeps CRLF line endings', () => {
    expect(edited('[hooks]\r\nturn_end = "x"\r\n')).toBe(`[hooks]\r\nsession_start = [${JSON.stringify(CMD)}]\r\nturn_end = ["x", ${JSON.stringify(CMD)}]\r\n`);
  });

  it('prints the lines instead for a multi-line array or an inline table', () => {
    const multi = planTomlHooksInstall('[hooks]\nturn_end = [\n  "a", # first\n  "b",\n]\n', KEYS, CMD, owned);
    expect(multi).toEqual({ kind: 'manual', lines: [`session_start = [${JSON.stringify(CMD)}]`, `turn_end = ["a", "b", ${JSON.stringify(CMD)}]`] });
    expect(planTomlHooksInstall('hooks = { turn_end = "a" }\n', KEYS, CMD, owned).kind).toBe('manual');
  });

  it('never touches a file that is not TOML, or whose hook value is not commands', () => {
    expect(planTomlHooksInstall('[hooks\n', KEYS, CMD, owned)).toEqual({ kind: 'malformed' });
    expect(planTomlHooksInstall('[hooks]\nturn_end = 3\n', KEYS, CMD, owned)).toEqual({ kind: 'malformed' });
  });
});

describe('planTomlHooksRemove and inspectTomlHooks', () => {
  it('reports stale when the wanted command sits beside an older wmux one', () => {
    const both = `[hooks]\nsession_start = [${JSON.stringify(CMD)}]\nturn_end = [${JSON.stringify(CMD)}, "node \\"/old/wmux-jcode-bridge.mjs\\""]\n`;
    expect(inspectTomlHooks(both, KEYS, CMD, owned)).toEqual({ session_start: 'current', turn_end: 'stale' });
  });

  it("removes only wmux's commands; a key left empty goes", () => {
    const installed = edited('[hooks]\nturn_end = "~/bin/notify" # ping me\n');
    expect(inspectTomlHooks(installed, KEYS, CMD, owned)).toEqual({ session_start: 'current', turn_end: 'current' });
    const plan = planTomlHooksRemove(installed, KEYS, owned);
    expect(plan).toEqual({ kind: 'edit', text: '[hooks]\nturn_end = ["~/bin/notify"] # ping me\n' });
    expect(inspectTomlHooks((plan as { text: string }).text, KEYS, CMD, owned)).toEqual({ session_start: 'absent', turn_end: 'absent' });
  });
});
