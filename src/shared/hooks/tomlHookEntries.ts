// Line-level edits of a `[hooks]` table in a user's TOML config (jcode's
// ~/.jcode/config.toml), for `wmux setup-hooks --agent jcode`.
//
// The file is the user's: it holds their own hooks and comments, and no TOML
// library writes comments back. So nothing here re-serialises the file. Each
// edit touches one line: a key line inserted under the `[hooks]` header, a
// single-line value rewritten with its trailing comment kept, a line dropped,
// or a `[hooks]` table appended at the end. Every planned text is parsed again
// and must equal the intended data, with everything else unchanged; any shape
// the planner cannot edit that way (a multi-line array, an inline `hooks`
// table, dotted keys) yields `manual`, and the caller prints the lines to add
// instead of writing.

import { parse } from 'smol-toml';

/** One event key's wmux entry state. */
export type TomlHookKeyState = 'absent' | 'current' | 'stale';

export type TomlHookPlan =
  /** The text to write (null: already as wanted, nothing to write). */
  | { readonly kind: 'edit'; readonly text: string | null }
  /** The file cannot be edited safely; these lines, under `[hooks]`, are the target. */
  | { readonly kind: 'manual'; readonly lines: readonly string[] }
  /** Not TOML, or `hooks` is not a table: never touched. */
  | { readonly kind: 'malformed' };

type Parsed = Record<string, unknown>;

function tryParse(text: string): Parsed | null {
  try {
    return parse(text) as Parsed;
  } catch {
    return null;
  }
}

/** The commands under one key: a string or an array of strings, else null. */
function commandsOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return null;
}

function hooksTable(parsed: Parsed): Record<string, unknown> | null | undefined {
  const hooks = parsed.hooks;
  if (hooks === undefined) return undefined;
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? (hooks as Record<string, unknown>) : null;
}

/** A TOML basic string. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlArray(items: readonly string[]): string {
  return `[${items.map(tomlString).join(', ')}]`;
}

/** Each key's state for `wanted`, given an ownership test. Null when malformed. */
export function inspectTomlHooks(
  text: string | null,
  keys: readonly string[],
  wanted: string,
  isOwned: (command: string) => boolean,
): Record<string, TomlHookKeyState> | null {
  const out: Record<string, TomlHookKeyState> = {};
  const parsed = text === null ? {} : tryParse(text);
  if (!parsed) return null;
  const hooks = hooksTable(parsed);
  if (hooks === null) return null;
  for (const key of keys) {
    const commands = commandsOf(hooks?.[key]);
    if (commands === null) return null;
    out[key] = commands.includes(wanted) ? 'current' : commands.some(isOwned) ? 'stale' : 'absent';
  }
  return out;
}

const HEADER_RE = /^\s*\[\s*hooks\s*\]\s*(#.*)?$/;
const ANY_HEADER_RE = /^\s*\[/;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Plan the text that sets each key's commands to `next(current)`. `next`
 * returns the new list; an empty list removes the key.
 */
function planTomlHooks(
  text: string | null,
  keys: readonly string[],
  next: (commands: readonly string[]) => string[],
): TomlHookPlan {
  const source = text ?? '';
  const parsed = tryParse(source);
  if (!parsed) return { kind: 'malformed' };
  const hooks = hooksTable(parsed);
  if (hooks === null) return { kind: 'malformed' };

  const wantedLists: Record<string, string[]> = {};
  for (const key of keys) {
    const commands = commandsOf(hooks?.[key]);
    if (commands === null) return { kind: 'malformed' };
    wantedLists[key] = next(commands);
  }
  const manual: TomlHookPlan = {
    kind: 'manual',
    lines: keys.filter((k) => wantedLists[k].length > 0).map((k) => `${k} = ${tomlArray(wantedLists[k])}`),
  };
  const changed = keys.filter((k) => !deepEqual(commandsOf(hooks?.[k]), wantedLists[k]));
  if (changed.length === 0) return { kind: 'edit', text: null };

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  let result: string[];
  if (headerIdx < 0) {
    // `hooks` defined some other way (inline table, dotted keys): not ours to reshape.
    if (hooks !== undefined) return manual;
    const added = changed.filter((k) => wantedLists[k].length > 0).map((k) => `${k} = ${tomlArray(wantedLists[k])}`);
    if (added.length === 0) return { kind: 'edit', text: null };
    const body = [...lines];
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    result = [...body, ...(body.length > 0 ? [''] : []), '[hooks]', ...added, ''];
  } else {
    let end = lines.findIndex((l, i) => i > headerIdx && ANY_HEADER_RE.test(l));
    if (end < 0) end = lines.length;
    result = [...lines];
    const inserts: string[] = [];
    // Highest line first, so earlier indices stay valid.
    const edits: { idx: number; line: string | null }[] = [];
    for (const key of changed) {
      const list = wantedLists[key];
      const keyRe = new RegExp(`^(\\s*)(${key}|"${key}")\\s*=(.*)$`);
      const matches: number[] = [];
      for (let i = headerIdx + 1; i < end; i++) if (keyRe.test(lines[i])) matches.push(i);
      if (hooks?.[key] === undefined) {
        if (matches.length > 0) return manual;
        if (list.length > 0) inserts.push(`${key} = ${tomlArray(list)}`);
        continue;
      }
      if (matches.length !== 1) return manual;
      const idx = matches[0];
      const [, indent, , rest] = lines[idx].match(keyRe) as RegExpMatchArray;
      const comment = trailingComment(rest, hooks[key]);
      if (comment === null) return manual;
      edits.push({ idx, line: list.length > 0 ? `${indent}${key} = ${tomlArray(list)}${comment}` : null });
    }
    edits.sort((a, b) => b.idx - a.idx);
    for (const { idx, line } of edits) {
      if (line === null) result.splice(idx, 1);
      else result[idx] = line;
    }
    result.splice(headerIdx + 1, 0, ...inserts);
  }
  const out = result.join(eol);
  // The safety net: the new text must parse to exactly the intended data.
  const check = tryParse(out);
  if (!check) return manual;
  const expected: Parsed = { ...parsed };
  const expectedHooks: Record<string, unknown> = { ...(hooks ?? {}) };
  for (const key of keys) {
    if (wantedLists[key].length === 0) delete expectedHooks[key];
    else expectedHooks[key] = deepEqual(commandsOf(hooks?.[key]), wantedLists[key]) ? hooks?.[key] : wantedLists[key];
  }
  if (hooks !== undefined || Object.keys(expectedHooks).length > 0) expected.hooks = expectedHooks;
  return deepEqual(normalise(check), normalise(expected)) ? { kind: 'edit', text: out } : manual;
}

/** Key order is not data. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalise((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/**
 * The trailing comment (with its leading space) after a single-line value,
 * '' when none, or null when `rest` is not one complete value equal to
 * `expected` (a multi-line array starts here and goes on).
 */
function trailingComment(rest: string, expected: unknown): string | null {
  const candidates = [rest.length, ...[...rest].flatMap((ch, i) => (ch === '#' ? [i] : []))];
  for (const cut of candidates.sort((a, b) => a - b)) {
    const parsed = tryParse(`v = ${rest.slice(0, cut)}`);
    if (parsed && deepEqual(parsed.v, expected)) {
      const tail = rest.slice(cut).trim();
      return tail ? ` ${tail}` : '';
    }
  }
  return null;
}

/** Add `wanted` to each key, dropping older wmux entries; other commands stay first. */
export function planTomlHooksInstall(
  text: string | null,
  keys: readonly string[],
  wanted: string,
  isOwned: (command: string) => boolean,
): TomlHookPlan {
  return planTomlHooks(text, keys, (commands) =>
    commands.includes(wanted) && commands.filter(isOwned).length === 1
      ? [...commands]
      : [...commands.filter((c) => !isOwned(c)), wanted]);
}

/** Remove every wmux entry from each key; a key left empty goes. */
export function planTomlHooksRemove(
  text: string | null,
  keys: readonly string[],
  isOwned: (command: string) => boolean,
): TomlHookPlan {
  return planTomlHooks(text, keys, (commands) => commands.filter((c) => !isOwned(c)));
}
