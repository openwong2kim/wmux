// The Kiro agent config that carries wmux's hooks.
//
// Kiro's hooks can only live inside an agent config — there is no global hooks
// directory (measured: `~/.kiro/hooks/` is inert on 2.15.1) and no config-dir
// environment variable to redirect. The user's default agent is BUILT IN, so
// there is no file of theirs to add a hook to. wmux therefore ships its OWN
// agent and panes opt in with `kiro-cli chat --agent wmux`; nothing the user
// owns is ever written, and their default agent stays their default.
//
// THE RULE: equivalent to `kiro_default` except the prompt.
//
// Values below were read from a materialized built-in
// (`kiro-cli agent create --from kiro_default`) on 2.15.1:
//
//   tools ["*"]  allowedTools []  toolAliases {}  toolsSettings {}
//   mcpServers {}  model null  includeMcpJson true  prompt 1696 bytes
//   resources [AmazonQ.md, AGENTS.md, README.md, skills×2, steering]
//
// `allowedTools: []` is why approval behaviour cannot change: the built-in
// pre-approves nothing either, so omitting the key is not more restrictive.
//
// Two fields are NOT free to omit, and an earlier revision omitted both:
//   - `includeMcpJson` — without it the agent loads no MCP servers, so a
//     wmux-launched Kiro pane cannot reach wmux's own MCP tools.
//   - `resources` — without it AGENTS.md, README.md, skills and steering docs
//     stop being auto-loaded and the agent quietly loses project context.
// The measurement that cleared the empty prompt ran a synthetic task in a temp
// directory, where neither could have shown up. Hence `_kiro-equivalence.mjs`,
// which diffs this against the live built-in.
//
// The empty prompt IS deliberate. Measured 3x on the same tool-using task:
// thin and built-in both 3/3 correct, 17.4s vs 18.0s, thin slightly cheaper.
// Cloning the 1.7KB built-in prompt would freeze it at install time and drift
// as Kiro updates its own.

/** Marks the file as wmux-owned, so an installer never clobbers a user's. */
export const KIRO_AGENT_MANAGED_MARKER = 'wmux-managed: kiro-lifecycle-agent';

/** Kiro's hook timeout defaults to 10s. The bridge caps itself at 2s
 *  (HOOK_TIMEOUT_MS), so 2500 lets our cap fire first and leaves Kiro a hard
 *  backstop that cannot hold a turn for ten seconds if the bridge wedges. */
export const KIRO_HOOK_TIMEOUT_MS = 2500;

/** Fields this agent intends to differ on. Everything else must match the
 *  built-in — that is what the equivalence check enforces. */
export const INTENDED_DIFFERENCES = ['name', 'description', 'prompt', 'hooks'];

/**
 * Build the agent config.
 *
 * `home` is a parameter because the built-in bakes ABSOLUTE paths into
 * `resources` (`<home>/.kiro/skills`, `<home>/.kiro/steering`), so the list has
 * to be generated per machine rather than hardcoded. The separators below
 * reproduce what Kiro itself writes.
 */
export function buildKiroAgentConfig(
  bridgeScript,
  home,
  // Default from the PLATFORM, not a constant. A hardcoded `\\` bakes
  // backslash resources on POSIX whenever a caller omits the option, and Kiro
  // drops a resource path it cannot resolve without saying so — the same
  // silent loss of skills and steering this file exists to prevent. Callers
  // that need the other separator still pass it explicitly (the equivalence
  // check does).
  { sep = process.platform === 'win32' ? '\\' : '/' } = {},
) {
  const command = `node "${bridgeScript}"`;
  const hook = [{ command, timeout_ms: KIRO_HOOK_TIMEOUT_MS }];
  const kiroHome = `${home}${sep}.kiro`;
  return {
    name: 'wmux',
    description: KIRO_AGENT_MANAGED_MARKER,
    prompt: '',
    tools: ['*'],
    includeMcpJson: true,
    resources: [
      'file://AmazonQ.md',
      'file://AGENTS.md',
      'file://README.md',
      'skill://.kiro/skills/*/SKILL.md',
      `skill://${kiroHome}/skills/*/SKILL.md`,
      `file://${kiroHome}${sep}steering/**/*.md`,
    ],
    hooks: { stop: hook, agentSpawn: hook },
  };
}

/** True when a parsed agent config is one wmux wrote. */
export function isWmuxOwnedKiroAgent(parsed) {
  return (
    !!parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.description === KIRO_AGENT_MANAGED_MARKER
  );
}
