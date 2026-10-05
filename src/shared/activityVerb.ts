// Reads back the glyph line `summarizeActivity` produces ("✎ foo.ts",
// "$ npm test", "→ x.ts", "⌕ pat", …) as a verb and its object, so a reader
// can phrase it as a sentence ("Edited foo.ts"). The glyph format stays the
// shared one — chat rows render it as is — and this never changes it.
//
// Dependency-free, like activitySummary.ts, so main and renderer can import it.

export type ActivityVerb =
  | 'edited'
  | 'ran'
  | 'read'
  | 'searched'
  | 'delegated'
  | 'skill'
  | 'browsed'
  | 'called'
  | 'used';

export interface ParsedActivity {
  verb: ActivityVerb;
  /** What the verb acted on: a file, a command, a pattern, a tool name. */
  target: string;
}

const PREFIXES: ReadonlyArray<readonly [string, ActivityVerb]> = [
  ['✎ ', 'edited'],
  ['$ ', 'ran'],
  ['→ ', 'read'],
  ['⌕ ', 'searched'],
  ['⇲ ', 'delegated'],
  ['🌐 ', 'browsed'],
];

/** The verb and target of an activity line; null for an empty line. */
export function parseActivity(summary: string | undefined | null): ParsedActivity | null {
  const line = (summary ?? '').trim();
  if (!line) return null;
  for (const [prefix, verb] of PREFIXES) {
    // A glyph with nothing after it names nothing.
    if (line === prefix.trim()) return null;
    if (line.startsWith(prefix)) {
      const target = line.slice(prefix.length).trim();
      return target ? { verb, target } : null;
    }
  }
  // "/skill" is a Skill call; "server:tool" an MCP tool; anything else is the
  // bare tool name summarizeActivity falls back to.
  if (line.startsWith('/') && line.length > 1) return { verb: 'skill', target: line };
  if (/^[^\s:]+:[^\s:]+$/.test(line)) return { verb: 'called', target: line };
  return { verb: 'used', target: line };
}
