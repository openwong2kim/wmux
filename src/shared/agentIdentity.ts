// Single source of truth for agent identity: the slug, its display name, and
// the two lookups between them.
//
// Why this file exists
// --------------------
// The eight agent slugs used to be written out by hand in SEVEN places, and the
// slug<->display maps in two more, each carrying a comment telling the next
// person to keep the others in lock-step. That is exactly as reliable as it
// sounds: `src/renderer/channels/agentCandidateSeed.ts` shipped with SEVEN of
// the eight (`openclaude` missing) and nothing caught it, because
// `] satisfies AgentSlug[]` rejects EXTRA members but never OMISSIONS.
//
// The duplication used to have a stated reason -- "src/shared is the only
// directory the daemon's tsconfig includes, importing from main/ would invert
// the layering". Only the first half is true. `src/daemon/DaemonPTYBridge.ts`
// already imports `AgentDetector` straight out of `src/main/pty/`, so
// `rootDir: src` was never the constraint; only `integrations/` is genuinely
// out of reach. Putting the table here satisfies every consumer -- main,
// daemon, preload and renderer all import `src/shared` -- with no layering
// inversion and no second place to forget.
//
// This module imports NOTHING, deliberately: every layer depends on it, so a
// dependency here would be a cycle waiting to happen.
//
// Adding an agent
// ---------------
// Add one row below. That is the whole change: the union type, the runtime set,
// both lookups, the hook-envelope allowlist, the resume-binding allowlist and
// the channel-candidate allowlist all derive from this array.
//
// A row is NOT sufficient to make wmux *detect* the agent -- that needs a
// profile in `src/main/pty/AgentDetector.ts`, whose patterns must be captured
// from a live TUI rather than guessed (see the header there). Nor does it wire
// hook signals; those need `integrations/<agent>/`, which lives outside this
// build and stays hand-written.

/**
 * The canonical agent table. `slug` is the routing key: lowercase, no
 * whitespace, and never containing `:` -- `HookSignalRouter.key()` builds
 * `${slug}:${ptyId}:${kind}` and `dropPty` scans for the `:${ptyId}:`
 * substring, so a slug carrying a colon would make that scan ambiguous.
 *
 * `display` is what a human sees (sidebar label, pane badge). It travels on
 * the `agent.event` wire instead of the slug, because main reads that payload
 * straight into the sidebar and back through `agentDisplayToSlug`.
 */
export const AGENT_IDENTITIES = [
  { slug: 'claude', display: 'Claude Code' },
  { slug: 'codex', display: 'Codex CLI' },
  { slug: 'gemini', display: 'Gemini CLI' },
  { slug: 'aider', display: 'Aider' },
  { slug: 'opencode', display: 'OpenCode' },
  { slug: 'copilot', display: 'GitHub Copilot CLI' },
  { slug: 'openclaude', display: 'OpenClaude' },
  { slug: 'kiro', display: 'Kiro CLI' },
  { slug: 'grok', display: 'Grok' },
] as const;

/** SLUG-form agent identifier. Derived, so it can never drift from the table. */
export type AgentSlug = (typeof AGENT_IDENTITIES)[number]['slug'];

/** Human-facing agent name. */
export type AgentDisplayName = (typeof AGENT_IDENTITIES)[number]['display'];

/** Every slug, in table order. */
export const AGENT_SLUGS: readonly AgentSlug[] = AGENT_IDENTITIES.map((a) => a.slug);

/**
 * Runtime membership test set. Several boundaries need a closed set rather than
 * a type: the daemon RPC envelope guard (`isAgentSignal`), the resume-binding
 * validator, and the channel candidate seeder all receive untrusted strings.
 */
export const AGENT_SLUG_SET: ReadonlySet<string> = new Set<string>(AGENT_SLUGS);

/** Narrow an untrusted string to a known slug. */
export function isAgentSlug(value: unknown): value is AgentSlug {
  return typeof value === 'string' && AGENT_SLUG_SET.has(value);
}

const DISPLAY_BY_SLUG: ReadonlyMap<string, string> = new Map(
  AGENT_IDENTITIES.map((a) => [a.slug, a.display]),
);

const SLUG_BY_DISPLAY: ReadonlyMap<string, AgentSlug> = new Map(
  AGENT_IDENTITIES.map((a) => [a.display, a.slug]),
);

/**
 * slug -> display name.
 *
 * Total over `AgentSlug`, so the non-null assertion is sound: the map is built
 * from the same array the type is derived from.
 */
export function agentSlugToDisplay(slug: AgentSlug): string {
  return DISPLAY_BY_SLUG.get(slug) as string;
}

/**
 * display name -> slug, or `undefined` for anything unrecognised.
 *
 * Callers pass whatever a pane reported, including `''` for "no agent detected
 * yet", so an unknown value is an ordinary outcome and not an error.
 */
export function agentDisplayToSlug(display: string): AgentSlug | undefined {
  return SLUG_BY_DISPLAY.get(display);
}
