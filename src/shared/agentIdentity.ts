// Single source of truth for agent identity: the slug, its display name, the
// two lookups between them, and each agent's declared capabilities.
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
// dependency here would be a cycle waiting to happen. For the same reason a row
// holds data only, never functions.
//
// Adding an agent
// ---------------
// Add one row below. For an agent wmux only LAUNCHES (no hooks, chat or resume)
// that is the whole change: the union type, the runtime set, both lookups, the
// hook-envelope allowlist, the resume-binding allowlist, the channel-candidate
// allowlist, the role-binding launcher set and every capability table named on
// `AgentIdentityRow` derive from this array.
//
// Each optional field on a row is a declared capability (#1904). A consumer
// that varies per agent reads the field instead of comparing the slug, so a new
// row that sets the field gets the behaviour, and a row without it is treated
// the way an unknown slug always was. `agentSlugBranches.guard.test.ts` keeps
// new `slug === '<literal>'` branches from appearing outside the files that
// already have them.
//
// A row is NOT sufficient to make wmux *detect* the agent on screen -- that
// needs a profile in `src/main/pty/AgentDetector.ts`, whose patterns must be
// captured from a live TUI rather than guessed (see the header there); `detect`
// records that one exists. Nor does it wire hook signals; those need a bridge
// under `integrations/`, which lives outside this build and stays hand-written
// (`hooks` names the dialect an agent's hooks speak).

/**
 * The hook DIALECT an agent speaks: its hook config file, event names and
 * payload shape -- not which bridge script reads them (several dialects can
 * share one bridge). Absent on a row means wmux knows no hook dialect for the
 * agent, and its status comes from the screen only. The shared hook path
 * (`src/shared/hooks/hookFlavours.ts`, #1904 item 2) serves a subset of these.
 */
export type AgentHooksFlavour = 'claude' | 'openclaude' | 'codex' | 'opencode' | 'kiro' | 'gemini' | 'copilot';

/**
 * The family of terminal dialogs an agent draws: Claude Code's permission
 * dialog and its AskUserQuestion select, whose keystrokes wmux can type.
 * openclaude is a Claude Code fork and draws the same ones.
 */
export type AgentDialogFamily = 'claude';

/**
 * How wmux keeps several logins of an agent apart. `account-store`: the shared
 * account store (`src/main/account/accountStore.ts`, its `Vendor` union).
 * `agy-service`: Antigravity's own account service.
 */
export type AgentAccountsKind = 'account-store' | 'agy-service';

/** Where wmux writes its MCP server into an agent CLI's own config. */
export interface AgentMcpTargetSpec {
  /** Config file syntax; picks the `configIO` adapter. */
  readonly format: 'json' | 'toml';
  /** Path segments under the user's home directory, joined with `path.join`. */
  readonly configPath: readonly string[];
  /** See `McpTarget.createIfMissing` (src/shared/mcpTargets.ts). */
  readonly createIfMissing: boolean;
  /** See `McpTarget.verified`. */
  readonly verified: boolean;
  /** See `McpTarget.autoRegister`. */
  readonly autoRegister: boolean;
}

/** Session resume grammar as data. `{id}` in `exact` stands for the session id. */
export interface AgentResumeSpec {
  /** Inserted after the launcher when no exact session applies (latest in cwd).
   *  Used only where no person is at the keyboard (supervised replay, phone
   *  launches); a pane the user resumes by hand gets `picker` instead (#1946). */
  readonly latest: string;
  /** Inserted after the launcher to open the agent's own session picker, which
   *  lists the folder's conversations and lets the user choose. Typed by the
   *  resume pill, chip and Deck when no exact session is bound, because several
   *  panes can share a folder and `latest` would reopen the same one in each
   *  (#1946). */
  readonly picker: string;
  /** Inserted after the launcher to resume one exact session. */
  readonly exact: string;
  /** The shape a stored session id must have before it is offered. */
  readonly idFormat: 'uuid';
}

/** What the file-transcript chat route (nativeChatBridge) can do for an agent. */
export interface AgentTerminalChatSpec {
  readonly send?: true;
  readonly cancel?: true;
  readonly images?: true;
  /** The agent's own composer queues a prompt typed mid-turn, so a queued
   *  phone message can also be steered into the running turn. */
  readonly queue?: true;
}

/**
 * One registry row. Every field after `display` is optional and declares a
 * capability; its comment names the consumer that reads it.
 */
export interface AgentIdentityRow {
  readonly slug: string;
  readonly display: string;
  /** Launcher stem typed in a pane, when it differs from the slug (kiro ships
   *  `kiro-cli`). Read by `KNOWN_AGENT_STEMS` and the model-flag table. */
  readonly launcher?: string;
  /** `false` keeps the launcher out of the role-binding rewrite
   *  (`KNOWN_AGENT_STEMS`): fan-out may launch it, a role binding never does. */
  readonly roleBinding?: false;
  /** The CLI refuses a positional first prompt: `flag` goes right before it,
   *  and any of `accepts` already on the line means none is needed
   *  (orchestratorRole). */
  readonly promptFlag?: { readonly flag: string; readonly accepts: readonly string[] };
  /** The CLI's verified model flag, `<flag> <model>` (orchestratorRole). */
  readonly modelFlag?: string;
  /** Session resume grammar (agentResume `resumeGrammarFor`). */
  readonly resume?: AgentResumeSpec;
  /** Claude Code's permission-mode launch flags can be re-applied on resume
   *  (agentResume `agentSupportsPermissionFlag`). */
  readonly permissions?: 'permission-mode';
  /** Names a process tracker sees for this agent besides the slug: npm package
   *  names it runs under, and native executable names (AgentProcessTracker). */
  readonly process?: { readonly packages?: readonly string[]; readonly executables?: readonly string[] };
  /** A screen profile exists in `src/main/pty/AgentDetector.ts`. */
  readonly detect?: 'screen';
  /** Hook bridge flavour; see {@link AgentHooksFlavour}. */
  readonly hooks?: AgentHooksFlavour;
  /** MCP registration target (src/shared/mcpTargets.ts). */
  readonly mcp?: AgentMcpTargetSpec;
  /** The pane is a TUI chat box: a pasted line lands in a composer, not a
   *  shell, so a channel wake nudge may carry the message body
   *  (channelWakeWorker `mayCarryBody`). */
  readonly tuiComposer?: true;
  /** Terminal dialog family; see {@link AgentDialogFamily}. */
  readonly dialogs?: AgentDialogFamily;
  /** The daemon send queue can hold this agent's sends (web chatWire). */
  readonly sendQueue?: true;
  /** File-transcript chat capabilities (nativeChatBridge). */
  readonly terminalChat?: AgentTerminalChatSpec;
  /** Multi-account support; see {@link AgentAccountsKind}. */
  readonly accounts?: AgentAccountsKind;
  /** Listed in Settings -> Token usage (activeProviders). */
  readonly tokenUsage?: true;
  /** Has a model discovery source (modelCatalog). */
  readonly modelCatalog?: true;
}

/**
 * The canonical agent table. `slug` is the routing key: lowercase, no
 * whitespace, and never containing `:` -- `HookSignalRouter.key()` builds
 * `${slug}:${ptyId}:${kind}` and `dropPty` scans for the `:${ptyId}:`
 * substring, so a slug carrying a colon would make that scan ambiguous.
 *
 * `display` is what a human sees (sidebar label, pane badge). It travels on
 * the `agent.event` wire instead of the slug, because main reads that payload
 * straight into the sidebar and back through `agentDisplayToSlug`.
 *
 * Row order is load-bearing: the lists derived from it (MCP targets, token
 * usage providers, model catalog agents) keep it.
 */
export const AGENT_IDENTITIES = [
  {
    slug: 'claude',
    display: 'Claude Code',
    modelFlag: '--model',
    resume: { latest: '--continue', picker: '--resume', exact: '--resume {id}', idFormat: 'uuid' },
    permissions: 'permission-mode',
    process: { packages: ['claude-code', '@anthropic-ai/claude-code'] },
    detect: 'screen',
    hooks: 'claude',
    mcp: { format: 'json', configPath: ['.claude.json'], createIfMissing: true, verified: true, autoRegister: true },
    tuiComposer: true,
    dialogs: 'claude',
    sendQueue: true,
    terminalChat: { send: true, cancel: true, images: true, queue: true },
    accounts: 'account-store',
    tokenUsage: true,
    modelCatalog: true,
  },
  {
    slug: 'codex',
    display: 'Codex CLI',
    modelFlag: '--model',
    resume: { latest: 'resume --last', picker: 'resume', exact: 'resume {id}', idFormat: 'uuid' },
    detect: 'screen',
    hooks: 'codex',
    mcp: {
      format: 'toml',
      configPath: ['.codex', 'config.toml'],
      createIfMissing: false,
      verified: true,
      autoRegister: true,
    },
    tuiComposer: true,
    sendQueue: true,
    terminalChat: { send: true, cancel: true },
    accounts: 'account-store',
    tokenUsage: true,
    modelCatalog: true,
  },
  {
    slug: 'gemini',
    display: 'Gemini CLI',
    process: { packages: ['gemini-cli', '@google/gemini-cli'] },
    detect: 'screen',
    hooks: 'gemini',
    mcp: {
      format: 'json',
      configPath: ['.gemini', 'settings.json'],
      createIfMissing: false,
      verified: false,
      autoRegister: true,
    },
    tuiComposer: true,
  },
  { slug: 'aider', display: 'Aider', detect: 'screen', tuiComposer: true },
  { slug: 'opencode', display: 'OpenCode', detect: 'screen', hooks: 'opencode', tuiComposer: true, sendQueue: true },
  { slug: 'copilot', display: 'GitHub Copilot CLI', detect: 'screen', hooks: 'copilot', tuiComposer: true },
  { slug: 'openclaude', display: 'OpenClaude', detect: 'screen', hooks: 'openclaude', dialogs: 'claude' },
  {
    slug: 'kiro',
    display: 'Kiro CLI',
    launcher: 'kiro-cli',
    process: { executables: ['kiro-cli'] },
    detect: 'screen',
    hooks: 'kiro',
  },
  {
    // A fan-out-only launcher (src/shared/fanoutPreset.ts). `grok --model <id>`
    // verified 2026-09-26 (grok 1.0.x); an unknown id is refused.
    slug: 'grok',
    display: 'Grok',
    roleBinding: false,
    modelFlag: '--model',
    detect: 'screen',
  },
  {
    slug: 'agy',
    display: 'Antigravity CLI',
    // agy answers a bare argument with "Prompts are read only from -p/--print,
    // -i/--prompt-interactive, or stdin", while `agy -i "<prompt>"` runs the
    // prompt and keeps the session open. Verified 2026-09-30, agy 1.2.14.
    promptFlag: { flag: '-i', accepts: ['-i', '--prompt-interactive', '-p', '--print'] },
    // Verified 2026-09-29 (agy 1.2.13): the id must be a full `agy models` id
    // (effort suffix included); an unknown id is refused with the model list.
    modelFlag: '--model',
    detect: 'screen',
    // Antigravity (Google's successor to the Gemini CLI) reads MCP servers from
    // `~/.gemini/config/mcp_config.json` (the `mcpServers` JSON shape `agy mcp
    // add` writes). Opt-in only: agy is commonly a restricted worker, so wmux
    // never adds its tools on its own.
    mcp: {
      format: 'json',
      configPath: ['.gemini', 'config', 'mcp_config.json'],
      createIfMissing: false,
      verified: false,
      autoRegister: false,
    },
    tuiComposer: true,
    accounts: 'agy-service',
    tokenUsage: true,
    modelCatalog: true,
  },
] as const satisfies readonly AgentIdentityRow[];

/** SLUG-form agent identifier. Derived, so it can never drift from the table. */
export type AgentSlug = (typeof AGENT_IDENTITIES)[number]['slug'];

/** Human-facing agent name. */
export type AgentDisplayName = (typeof AGENT_IDENTITIES)[number]['display'];

/**
 * The slugs whose row declares capability `K`, as a type. Lets a consumer's
 * closed union (`McpTarget.id`, `ActiveProviderId`) follow the table.
 */
export type AgentSlugWith<K extends keyof AgentIdentityRow> =
  Extract<(typeof AGENT_IDENTITIES)[number], { readonly [P in K]: unknown }>['slug'];

/**
 * The table widened to the row interface. Read capabilities through this:
 * `AGENT_IDENTITIES[number]` is a union of literal row shapes, and a field one
 * shape lacks cannot be read off the union.
 */
export const AGENT_ROWS: readonly (AgentIdentityRow & { readonly slug: AgentSlug })[] = AGENT_IDENTITIES;

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

const ROW_BY_SLUG: ReadonlyMap<string, AgentIdentityRow & { readonly slug: AgentSlug }> = new Map(
  AGENT_ROWS.map((a) => [a.slug, a]),
);

/**
 * The registry row for a slug, or `undefined` for anything unrecognised. A Map,
 * not an object index, so a slug from another machine such as `constructor`
 * cannot answer with something off a prototype (#1342).
 */
export function agentRow(slug: string | null | undefined): (AgentIdentityRow & { readonly slug: AgentSlug }) | undefined {
  return typeof slug === 'string' ? ROW_BY_SLUG.get(slug) : undefined;
}

/** The slugs whose row declares capability `key`, in table order. */
export function agentSlugsWith<K extends keyof AgentIdentityRow>(key: K): AgentSlugWith<K>[] {
  return AGENT_ROWS.filter((a) => a[key] !== undefined).map((a) => a.slug as AgentSlugWith<K>);
}

/** The stem a pane types to launch this agent (the slug unless the row says otherwise). */
export function agentLauncherStem(row: AgentIdentityRow): string {
  return row.launcher ?? row.slug;
}

/** The hook bridge an agent reports through, or undefined when it has none. */
export function agentHooksFlavour(slug: string | null | undefined): AgentHooksFlavour | undefined {
  return agentRow(slug)?.hooks;
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
