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
export type AgentResumeSpec = AgentResumeSpecBase & (
  | { readonly idFormat: 'uuid'; readonly exact: string }
  /** wmux binds no id for this agent (it names its own sessions, with no
   *  launch flag to set one): there is no exact form, so a stored id is never
   *  offered or typed, and only the picker is. */
  | { readonly idFormat: 'picker-only'; readonly exact?: never; readonly pin?: never }
);

interface AgentResumeSpecBase {
  /** Inserted after the launcher to open the agent's own session picker, which
   *  lists the folder's conversations and lets the user choose. Typed by the
   *  resume pill, chip and Deck when no exact session is bound. There is no
   *  "latest in this folder" form: several panes can share a folder, and a
   *  guess would reopen the same conversation in each (#1946). */
  readonly picker: string;
  /** The launch flag that names a NEW session's id up front (Claude
   *  `--session-id <id>`), when the agent has one. wmux pins fresh launches
   *  with it, and drops it from a relaunch: the id may already be in use. */
  readonly pin?: string;
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

/** Another documented install line for one platform ({@link AgentSetupSpec}). */
export interface AgentInstallAlternative {
  readonly platform: 'posix' | 'win32';
  readonly via: 'winget' | 'npm' | 'pnpm' | 'brew';
  readonly command: string;
  readonly requires: readonly string[];
  readonly source: string;
}

/**
 * How the first-run "Agent ready" card finds, checks and signs in an agent
 * (src/main/firstRun/AgentSetupDetector.ts, resolveClaudeExecutable
 * `agentCandidates`). Paths are segments, joined per platform.
 */
export interface AgentSetupSpec {
  /** Executable name searched for on PATH and in the install folders. */
  readonly binary: string;
  /** Where the agent's own native installer puts it. `home` = the user's home
   *  folder; otherwise the environment variable naming the base folder. */
  readonly native: {
    readonly posix: readonly string[];
    readonly win32: { readonly root: 'home' | 'LOCALAPPDATA'; readonly path: readonly string[] };
  };
  /** The npm package (scope and name segments) and, on Windows, its
   *  spawnable entrypoints (the `.cmd` shim npm puts on PATH is not). Absent
   *  for an agent whose vendor documents no npm install. */
  readonly npm?: {
    readonly package: readonly string[];
    readonly winEntries: readonly (readonly string[])[];
    /** Also look for the package next to a `<binary>.cmd` shim in any PATH
     *  folder (a custom npm prefix). */
    readonly besideShim?: true;
  };
  /**
   * The documented status subcommand that says whether the agent is signed in.
   * `json-logged-in`: JSON with a `loggedIn` boolean that agrees with the exit
   * code (0 / 1). `exit-code`: 0 is signed in, 1 with `signedOutText` in the
   * output is signed out. `none`: the vendor documents no such subcommand
   * (the agent signs in on its own first run and keeps the result in its own
   * store), so wmux does not check it; the card says so. `accountEnv` names the
   * variable that points the agent (and its status command) at one account's
   * folder; an agent with both is one whose lost sign-in wmux reports per
   * account (shared/agentAuthLost). `unseenCredentials` are ways the agent
   * runs that its status command does not report (an API key in the
   * environment, another model provider in its config): while one is present a
   * "signed out" answer is read as "cannot tell".
   */
  readonly loginStatus:
    | { readonly args: readonly string[]; readonly read: 'json-logged-in'; readonly accountEnv?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; readonly unseenCredentials?: UnseenCredentials }
    | { readonly args: readonly string[]; readonly read: 'exit-code'; readonly signedOutText: string; readonly accountEnv?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; readonly unseenCredentials?: UnseenCredentials }
    | { readonly read: 'none' };
  /** Below this version the card says "update recommended" (never forced). */
  readonly updateFloor: string;
  /**
   * The vendor's documented native installer, verbatim, with where it was
   * copied from. Bundled with the app, never fetched (src/shared/agentInstall.ts).
   * `posix` runs in the user's own shell; `win32` in PowerShell. `requires`
   * lists programs the line calls that are checked before it is offered.
   */
  readonly install: {
    readonly posix: { readonly command: string; readonly requires: readonly string[] };
    readonly win32: { readonly command: string };
    readonly source: string;
    /** Opened when an install fails or cannot run here. */
    readonly officialPage: string;
    /** The vendor's other documented ways on one platform, each verbatim with
     *  its own source, offered after the line above. On Windows each runs in
     *  PowerShell. `requires` as above. */
    readonly more?: readonly AgentInstallAlternative[];
  };
  /** The agent's own first-run screens have a guide card
   *  (src/shared/claudeFirstRun.ts `claudeSetupScreen`). */
  readonly firstRunScreens?: 'claude';
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
  /** Its transcript marks a turn that ended on an API error
   *  (`isApiErrorMessage`), read when the StopFailure hook is not installed
   *  (daemon/transcript/apiErrorTurnEnd). */
  readonly apiErrorTurnEnd?: true;
  /** Agent Teams teammates write their own transcripts in the session's
   *  `subagents/` folder (daemon/transcript/teammateActivity). */
  readonly teammateTranscripts?: true;
  /** MCP registration target (src/shared/mcpTargets.ts). */
  readonly mcp?: AgentMcpTargetSpec;
  /** Per-session local connector launch syntax (shared/connectorTerminal). */
  readonly connectorLaunch?: 'mcp-json' | 'mcp-toml';
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
  /** A conversation can continue on another account-store account: its
   *  transcript is one `<configDir>/projects/<project>/<id>.jsonl`, and the
   *  exact resume under that account's CLAUDE_CONFIG_DIR picks the copy up
   *  (src/daemon/continueOnAccount.ts). */
  readonly continueOnAccount?: true;
  /** A double ESC at rest, with an empty composer, opens the agent's own
   *  Rewind picker (src/daemon/transcript/openClaudeRewind.ts). */
  readonly rewindPicker?: true;
  /** Listed in Settings -> Token usage (activeProviders). */
  readonly tokenUsage?: true;
  /** Has a model discovery source (modelCatalog). */
  readonly modelCatalog?: true;
  /** A pane whose hooks do not report reads running while the tracked
   *  process is alive and its window title shows the agent's running title
   *  (agentTitleRules RUNNING_TITLE; DaemonPTYBridge noteCodexTitleSpinner).
   *  Claude's spinner has its own path in the bridge, so it is not listed. */
  readonly titleRunning?: true;
  /** First-run "Agent ready" card; see {@link AgentSetupSpec}. */
  readonly setup?: AgentSetupSpec;
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
    connectorLaunch: 'mcp-json',
    modelFlag: '--model',
    resume: { picker: '--resume', exact: '--resume {id}', pin: '--session-id', idFormat: 'uuid' },
    permissions: 'permission-mode',
    process: { packages: ['claude-code', '@anthropic-ai/claude-code'] },
    detect: 'screen',
    hooks: 'claude',
    apiErrorTurnEnd: true,
    teammateTranscripts: true,
    mcp: { format: 'json', configPath: ['.claude.json'], createIfMissing: true, verified: true, autoRegister: true },
    tuiComposer: true,
    dialogs: 'claude',
    sendQueue: true,
    terminalChat: { send: true, cancel: true, images: true, queue: true },
    accounts: 'account-store',
    continueOnAccount: true,
    rewindPicker: true,
    tokenUsage: true,
    modelCatalog: true,
    setup: {
      binary: 'claude',
      // Native installer: https://code.claude.com/docs/en/setup (~/.local/bin).
      native: { posix: ['.local', 'bin', 'claude'], win32: { root: 'home', path: ['.local', 'bin', 'claude.exe'] } },
      npm: { package: ['@anthropic-ai', 'claude-code'], winEntries: [['bin', 'claude.exe'], ['cli.js']] },
      // `claude auth status --help`: "--json  Output as JSON (default)".
      // Measured on 2.1.305: exit 0 + "loggedIn": true / exit 1 + false.
      loginStatus: { args: ['auth', 'status', '--json'], read: 'json-logged-in', accountEnv: 'CLAUDE_CONFIG_DIR' },
      // The interrupt / Stop hook findings the hook bridge is built on
      // (src/shared/hooks/interruptKeystroke.ts, HookSignalRouter.ts).
      updateFloor: '2.1.236',
      // https://code.claude.com/docs/en/setup, "Native Install (Recommended)":
      // macOS, Linux, WSL / Windows PowerShell ("You do not need to run as
      // Administrator"). Checked 2026-10-21.
      install: {
        posix: { command: 'curl -fsSL https://claude.ai/install.sh | bash', requires: ['curl', 'bash'] },
        win32: { command: 'irm https://claude.ai/install.ps1 | iex' },
        source: 'https://code.claude.com/docs/en/setup',
        officialPage: 'https://code.claude.com/docs/en/setup',
      },
      firstRunScreens: 'claude',
    },
  },
  {
    slug: 'codex',
    display: 'Codex CLI',
    connectorLaunch: 'mcp-toml',
    modelFlag: '--model',
    resume: { picker: 'resume', exact: 'resume {id}', idFormat: 'uuid' },
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
    titleRunning: true,
    setup: {
      binary: 'codex',
      // Standalone installers: https://chatgpt.com/codex/install.sh
      // (`$HOME/.local/bin`) and https://chatgpt.com/codex/install.ps1
      // (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`).
      native: {
        posix: ['.local', 'bin', 'codex'],
        win32: { root: 'LOCALAPPDATA', path: ['Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'] },
      },
      npm: { package: ['@openai', 'codex'], winEntries: [['bin', 'codex.js']], besideShim: true },
      // `codex login --help`: "status  Show login status". Measured on
      // codex-cli 0.163.0: exit 0 signed in, exit 1 + "Not logged in".
      // `codex login status` says "Not logged in" (exit 1) with only an API key
      // in the environment or another model_provider configured (checked on
      // codex-cli 0.142.5, 2026-10-24), and Codex runs with either.
      loginStatus: {
        args: ['login', 'status'], read: 'exit-code', signedOutText: 'not logged in', accountEnv: 'CODEX_HOME',
        unseenCredentials: { env: ['OPENAI_API_KEY', 'CODEX_API_KEY'], configKey: { dir: '.codex', file: 'config.toml', key: 'model_provider', ownValue: 'openai', profile: { key: 'profile', table: 'profiles' } } },
      },
      // One background server per account, which pane identity relies on
      // (src/mcp/codexThreadIdentity.ts).
      updateFloor: '0.157.0',
      // https://github.com/openai/codex README, "Mac or Linux" / "Windows"
      // (also https://learn.chatgpt.com/docs/codex/cli). `-ExecutionPolicy
      // ByPass` is the vendor's own text, kept verbatim. Checked 2026-10-21.
      install: {
        posix: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', requires: ['curl', 'sh'] },
        win32: { command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
        source: 'https://github.com/openai/codex#readme',
        officialPage: 'https://learn.chatgpt.com/docs/codex/cli',
      },
    },
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
    setup: {
      binary: 'grok',
      // Both installers put it in ~/.grok/bin (install.sh BIN_DIR; the
      // getting-started guide: "The PowerShell installer automatically adds
      // `%USERPROFILE%\.grok\bin` to your User PATH").
      native: { posix: ['.grok', 'bin', 'grok'], win32: { root: 'home', path: ['.grok', 'bin', 'grok.exe'] } },
      // Grok signs in on its first run (browser OAuth, or XAI_API_KEY) and
      // documents `grok login` / `grok logout`, but no status subcommand.
      loginStatus: { read: 'none' },
      // `--model` (modelFlag above) verified on 1.0.x.
      updateFloor: '1.0.0',
      // https://docs.x.ai/build/overview, "Install"; the same two lines in
      // https://github.com/xai-org/grok-build README, "Installing the released
      // binary". Checked 2026-10-23.
      install: {
        posix: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', requires: ['curl', 'bash'] },
        win32: { command: 'irm https://x.ai/cli/install.ps1 | iex' },
        source: 'https://docs.x.ai/build/overview',
        officialPage: 'https://docs.x.ai/build/overview',
        more: [{
          // The package id from the vendor's own WinGet note ("winget upgrade
          // --id xAI.GrokBuild -e"); the manifest's publisher is xAI Corp.
          platform: 'win32',
          via: 'winget',
          command: 'winget install --id xAI.GrokBuild -e',
          // winget.exe is an app execution alias (a reparse point a file check
          // cannot read), so it is not checked: a missing winget fails the line,
          // and the card then opens the official page.
          requires: [],
          source: 'https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md',
        }],
      },
    },
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
    setup: {
      binary: 'agy',
      // "Default install paths": ~/.local/bin/agy, and
      // C:\Users\<username>\AppData\Local\agy\bin (agy.exe).
      native: { posix: ['.local', 'bin', 'agy'], win32: { root: 'LOCALAPPDATA', path: ['agy', 'bin', 'agy.exe'] } },
      // agy signs in from its own first run (Google sign-in, kept in the OS
      // keyring; `/logout` inside the session) and documents no status
      // subcommand.
      loginStatus: { read: 'none' },
      // `-i` and `--model` (promptFlag, modelFlag above) verified on 1.2.13.
      updateFloor: '1.2.13',
      // https://antigravity.google/docs/getting-started (CLI tab), also on
      // https://antigravity.google/download. Checked 2026-10-23.
      install: {
        posix: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', requires: ['curl', 'bash'] },
        win32: { command: 'irm https://antigravity.google/cli/install.ps1 | iex' },
        source: 'https://antigravity.google/docs/getting-started',
        officialPage: 'https://antigravity.google/docs/getting-started',
      },
    },
  },
  {
    // Qwen Code. Options from the official CLI (QwenLM/qwen-code
    // packages/cli/src/config/top-level-options.ts, checked 2026-10-23):
    // `--resume` "Use without an ID to show session picker", `--resume <id>`
    // resumes that session, `--session-id` "Specify a session ID for this run"
    // (a UUID). The conversation is `<projects>/<cwd>/chats/<id>.jsonl`
    // (src/daemon/transcript/qwenTranscript.ts).
    slug: 'qwen',
    display: 'Qwen Code',
    resume: { picker: '--resume', exact: '--resume {id}', pin: '--session-id', idFormat: 'uuid' },
    process: { packages: ['@qwen-code/qwen-code'] },
    setup: {
      binary: 'qwen',
      // The standalone installers (install-qwen-standalone.sh: ~/.local/bin;
      // the Windows .bat: %LOCALAPPDATA%\qwen-code). On Windows that is the
      // archive's own `bin\qwen.cmd`, which runs its bundled node.exe and sets
      // the launcher path Qwen reads to call itself again (QwenLM/qwen-code
      // scripts/create-standalone-package.js `writeShims`), so the card runs
      // the shim rather than its script (resolveClaudeLaunch wraps a .cmd).
      native: {
        posix: ['.local', 'bin', 'qwen'],
        win32: { root: 'LOCALAPPDATA', path: ['qwen-code', 'qwen-code', 'bin', 'qwen.cmd'] },
      },
      // package.json `bin`: { "qwen": "cli-entry.js" }.
      npm: { package: ['@qwen-code', 'qwen-code'], winEntries: [['cli-entry.js']], besideShim: true },
      // Qwen signs in inside a session (`/auth`); the standalone `qwen auth`
      // command was removed, so there is no status subcommand to read.
      loginStatus: { read: 'none' },
      // The version whose `--resume` / `--session-id` were checked (above).
      updateFloor: '0.26.0',
      // https://github.com/QwenLM/qwen-code README, "Installation" (the
      // standalone script first, then "NPM / Homebrew"). Checked 2026-10-23.
      install: {
        posix: {
          command: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
          requires: ['curl', 'bash'],
        },
        win32: { command: 'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex' },
        source: 'https://github.com/QwenLM/qwen-code#installation',
        officialPage: 'https://github.com/QwenLM/qwen-code#installation',
        more: [
          {
            platform: 'posix',
            via: 'npm',
            command: 'npm install -g @qwen-code/qwen-code@latest',
            requires: ['npm'],
            source: 'https://github.com/QwenLM/qwen-code#installation',
          },
          {
            platform: 'win32',
            via: 'npm',
            command: 'npm install -g @qwen-code/qwen-code@latest',
            requires: ['npm'],
            source: 'https://github.com/QwenLM/qwen-code#installation',
          },
          {
            platform: 'posix',
            via: 'brew',
            command: 'brew install qwen-code',
            requires: ['brew'],
            source: 'https://github.com/QwenLM/qwen-code#installation',
          },
        ],
      },
    },
  },
  {
    // Kimi Code CLI. https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command
    // (checked 2026-10-23): `--session` with no id opens a selector, `--session
    // <id>` opens that session. Its ids are its own (not UUIDs) and no launch
    // flag sets one, so wmux offers the picker only. npm package from
    // https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html.
    slug: 'kimi',
    display: 'Kimi Code CLI',
    resume: { picker: '--session', idFormat: 'picker-only' },
    process: { packages: ['@moonshot-ai/kimi-code'] },
    setup: {
      binary: 'kimi',
      // install.sh / install.ps1: KIMI_INSTALL_DIR defaults to ~/.kimi-code
      // (%USERPROFILE%\.kimi-code), the binary in its bin folder.
      native: { posix: ['.kimi-code', 'bin', 'kimi'], win32: { root: 'home', path: ['.kimi-code', 'bin', 'kimi.exe'] } },
      // package.json `bin`: { "kimi": "dist/main.mjs" }.
      npm: { package: ['@moonshot-ai', 'kimi-code'], winEntries: [['dist', 'main.mjs']], besideShim: true },
      // Kimi signs in inside a session (`/login`) and documents no status
      // subcommand.
      loginStatus: { read: 'none' },
      // The 2.x CLI whose `--session` was checked (above); a 1.x `kimi` is the
      // older Python agent.
      updateFloor: '2.3.0',
      // https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html,
      // "Installation" (the install script first, then npm and pnpm). Checked
      // 2026-10-23.
      install: {
        posix: { command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', requires: ['curl', 'bash'] },
        win32: { command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex' },
        source: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
        officialPage: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
        more: [
          {
            platform: 'posix',
            via: 'npm',
            command: 'npm install -g @moonshot-ai/kimi-code',
            requires: ['npm'],
            source: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
          },
          {
            platform: 'win32',
            via: 'npm',
            command: 'npm install -g @moonshot-ai/kimi-code',
            requires: ['npm'],
            source: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
          },
          // macOS / Linux only: pnpm's Windows global folder is not one the
          // card can find the package in afterwards.
          {
            platform: 'posix',
            via: 'pnpm',
            command: 'pnpm add -g @moonshot-ai/kimi-code',
            requires: ['pnpm'],
            source: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
          },
        ],
      },
    },
  },
] as const satisfies readonly AgentIdentityRow[];

/** SLUG-form agent identifier. Derived, so it can never drift from the table. */
export type AgentSlug = (typeof AGENT_IDENTITIES)[number]['slug'];

/**
 * See `loginStatus.unseenCredentials`. `configKey.dir` is the account folder's
 * default under the home folder; `ownValue` is the value that still means the
 * agent's own sign-in (Codex's default provider), so it is not another
 * credential. `profile` names the top-level key that selects a profile and the
 * table the profiles live in: the selected profile's value wins over the
 * top-level one, and a profile nobody selected does not count.
 */
export interface UnseenCredentials {
  readonly env: readonly string[];
  readonly configKey?: {
    readonly dir: string; readonly file: string; readonly key: string; readonly ownValue: string;
    readonly profile?: { readonly key: string; readonly table: string };
  };
}

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
