// ─── A bot skill's SKILL.md front matter (shared/botSkill.ts) ──────────────
//
// Read the way Claude Code 2.1.302's skill loader reads it, then vetted to
// exactly name, description and version; and written again from those fields
// for a worker's copy. Main only: it pulls in the `yaml` parser, which the
// MCP bundle and the renderer never need.

import { isMap, isScalar, isSeq, parseAllDocuments, parseDocument } from 'yaml';
import {
  SKILL_FRONTMATTER_KEYS,
  SKILL_LIMITS,
  SKILL_NAME_RE,
  SKILL_VERSION_RE,
  type SkillFrontmatter,
} from '../../shared/botSkill';

/** Claude Code 2.1.302's front matter block: after one byte-order mark is
 *  dropped, it ends at the first `---` anywhere after the opening line (not
 *  at a line of its own), and any whitespace after that `---`, line breaks
 *  included, belongs to the marker. */
export const CLAUDE_CODE_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** Claude Code's fallback when a front matter does not parse: a plain value
 *  holding one of these is quoted, and the block parsed again. */
const CLAUDE_CODE_LOSSY_VALUE_RE = /[{}[\]*&#!|>%@`]|: /;

/** YAML 1.2 with the core schema (what Claude Code's Bun parser reads) and
 *  no merge keys. A key given twice parses, as it does for Bun, and the
 *  vetting refuses it: only a syntax error may start Claude Code's fallback. */
const YAML_OPTIONS = { version: '1.2', schema: 'core', merge: false, uniqueKeys: false } as const;

/** Characters a parsed value never holds: line breaks (a description is one
 *  line of the wake's skill list), other C0 and C1 controls, bidi overrides,
 *  the YAML 1.1 line breaks and a byte-order mark. A tab is text. */
// eslint-disable-next-line no-control-regex
const VALUE_CONTROL_RE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

/** A UTF-16 surrogate that is not half of a pair. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Claude Code's quoting of the lossy plain values (its fallback), line by
 *  line, as 2.1.302 does it. */
function quoteLossyValues(text: string): string {
  return text.split('\n').map((line) => {
    const m = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line);
    if (!m) return line;
    const [, key, value] = m;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) return line;
    if (value.startsWith('[') && value.endsWith(']')) {
      const list = parseDocument(value, YAML_OPTIONS);
      if (list.errors.length === 0 && isSeq(list.contents)) return line;
    }
    if (!CLAUDE_CODE_LOSSY_VALUE_RE.test(value)) return line;
    return `${key}: "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }).join('\n');
}

type Vetted = { ok: true; fields: Record<string, string> } | { ok: false; error: string; parsed: boolean };

/** One YAML reading of a front matter block, vetted: one document, a block
 *  mapping of plain keys, each one of SKILL_FRONTMATTER_KEYS at most once,
 *  each value a string scalar; no anchor, alias, tag or merge key. A
 *  directive is a YAML error here (the block holds no `---` to end it). */
function vetYaml(text: string): Vetted {
  const docs = parseAllDocuments(text, YAML_OPTIONS);
  if (docs.length === 0) return { ok: true, fields: {} };
  if (docs.length > 1) return { ok: false, parsed: true, error: 'the front matter is one YAML document (no ... or --- inside it)' };
  const doc = docs[0];
  // An error is what makes Bun's parser throw; a warning (an unknown tag)
  // does not, so it is refused below, never a reason for the fallback.
  const error = doc.errors[0];
  if (error) return { ok: false, parsed: false, error: `the front matter is not YAML: ${error.message.split('\n')[0]}` };
  const root = doc.contents;
  if (root === null) return { ok: true, fields: {} };
  if (!isMap(root) || root.flow || root.anchor || root.tag) {
    return { ok: false, parsed: true, error: 'the front matter is name, description and version, one "key: value" line each' };
  }
  const fields: Record<string, string> = {};
  for (const pair of root.items) {
    const { key, value } = pair;
    if (!isScalar(key) || key.type !== 'PLAIN' || typeof key.value !== 'string' || key.anchor || key.tag) {
      return { ok: false, parsed: true, error: 'a front matter key is a plain word (not quoted, no anchor or tag)' };
    }
    const name = key.value;
    if (name === '<<') return { ok: false, parsed: true, error: 'the front matter takes no merge key (<<)' };
    // An explicit `? key` would start past column 0.
    const at = key.range?.[0] ?? -1;
    if (at !== 0 && text[at - 1] !== '\n') return { ok: false, parsed: true, error: 'a front matter key starts its line (no ? key)' };
    if (!(SKILL_FRONTMATTER_KEYS as readonly string[]).includes(name)) {
      return { ok: false, parsed: true, error: `front matter key ${name} is not one of ${SKILL_FRONTMATTER_KEYS.join(', ')}` };
    }
    if (name in fields) return { ok: false, parsed: true, error: `front matter key ${name} is given twice` };
    if (!isScalar(value)) {
      return { ok: false, parsed: true, error: `front matter ${name} is a text value (no list, map, anchor or alias *)` };
    }
    if (value.anchor || value.tag) return { ok: false, parsed: true, error: `front matter ${name} has no anchor (&) or tag (!)` };
    if (typeof value.value !== 'string') return { ok: false, parsed: true, error: `front matter ${name} is text; quote it` };
    fields[name] = value.value;
  }
  const warning = doc.warnings[0];
  if (warning) return { ok: false, parsed: true, error: `the front matter is not plain YAML: ${warning.message.split('\n')[0]}` };
  return { ok: true, fields };
}

/** The front matter of a SKILL.md, read the way Claude Code 2.1.302 reads
 *  it: one byte-order mark dropped, then CLAUDE_CODE_FRONTMATTER_RE, then the
 *  block as YAML 1.2, and when that fails, again with Claude Code's quoting
 *  of lossy values and tabs as spaces. The parsed fields are then vetted:
 *  exactly SKILL_FRONTMATTER_KEYS, each once, as plain keys with string
 *  values, and no anchor, alias, tag, merge key, directive or second
 *  document. Returns the fields and the body after the block (\r\n read as
 *  \n), or why not. Pure. */
export function parseSkillFrontmatter(content: string): { ok: true; frontmatter: SkillFrontmatter; body: string } | { ok: false; error: string } {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const m = CLAUDE_CODE_FRONTMATTER_RE.exec(text);
  if (!m) return { ok: false, error: 'SKILL.md starts with a --- line, and its front matter ends at the next ---' };
  let read = vetYaml(m[1]);
  if (!read.ok && !read.parsed) {
    const fallback = vetYaml(quoteLossyValues(m[1]).replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length)));
    // A fallback that does not parse either reports the first reading.
    if (fallback.ok || fallback.parsed) read = fallback;
  }
  if (!read.ok) return { ok: false, error: read.error };
  const fields = read.fields;
  for (const key of SKILL_FRONTMATTER_KEYS) {
    if (!fields[key]) return { ok: false, error: `front matter needs ${key}` };
  }
  if (!SKILL_NAME_RE.test(fields.name)) return { ok: false, error: 'front matter name is a lowercase slug (a-z, 0-9, -), not a Windows device name' };
  if (fields.description.length > SKILL_LIMITS.DESCRIPTION_MAX) return { ok: false, error: `description is at most ${SKILL_LIMITS.DESCRIPTION_MAX} characters` };
  if (VALUE_CONTROL_RE.test(fields.description) || LONE_SURROGATE_RE.test(fields.description)) {
    return { ok: false, error: 'description is one line of plain text (no line break or control character)' };
  }
  if (!SKILL_VERSION_RE.test(fields.version)) return { ok: false, error: 'version is MAJOR.MINOR.PATCH (1.0.0)' };
  return {
    ok: true,
    frontmatter: { name: fields.name, description: fields.description, version: fields.version },
    body: text.slice(m[0].length).split(/\r?\n/).join('\n'),
  };
}

/** One value as a YAML double-quoted scalar: a JSON string (every JSON
 *  escape is a YAML one), with the last dash of each `---` written as a
 *  YAML unicode escape, so the front matter never holds a `---` that would
 *  end Claude Code's block early. */
function quoteValue(value: string): string {
  return JSON.stringify(value).replace(/---/g, '--\\u002d');
}

/** The front matter a worker's Claude Code reads, written from the parsed
 *  fields (never the bytes the bot wrote). Its only `---` are its first
 *  and last three characters. Pure. */
export function serializeSkillFrontmatter(fm: SkillFrontmatter): string {
  return ['---', ...SKILL_FRONTMATTER_KEYS.map((k) => `${k}: ${quoteValue(fm[k])}`), '---'].join('\n');
}

/** The SKILL.md a worker's copy holds: the front matter written again from
 *  its parsed fields, then the body. Null when the file does not parse.
 *  Pure. */
export function workerSkillFile(content: string): string | null {
  const fm = parseSkillFrontmatter(content);
  if (!fm.ok) return null;
  return `${serializeSkillFrontmatter(fm.frontmatter)}\n${fm.body}`;
}
