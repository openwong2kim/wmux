// The Codex `[hooks]` config block that carries wmux's lifecycle bridge.
//
// Codex hooks are TOML, not a hooks.json — they live under `[[hooks.<Event>]]`
// in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The schema is
// Claude Code's, transposed: an event name, a `matcher`, and a list of handlers
// with `type` / `command` / `commandWindows` / `timeout` / `async`.
//
// Verified on codex-cli 0.151.0 (2026-08-31) by writing this block and watching
// the bridge fire. Two things about it are not guessable from the schema:
//
//   1. TRUST. A hook Codex has not been told to trust does not run, and says
//      nothing about it — no warning, no "needs review" line, no non-zero exit.
//      Writing this block is therefore NOT installation; the operator must
//      approve the hooks in Codex before they do anything. That is why there is
//      no installer here, only a builder plus README instructions.
//   2. VERSION. 0.140.0 accepts this exact block, advertises `hooks` as a
//      stable feature, and fires nothing. 0.141.0 fires. Bisected; see
//      CODEX_HOOKS_MIN_VERSION.
//
// This module is data only — it writes nothing. `integrations/codex/README.md`
// owns the operator instructions.

/** Marks the block as wmux-owned so an installer never clobbers a user's. */
export const CODEX_HOOKS_MANAGED_MARKER = 'wmux-managed: codex-hooks-bridge';

/**
 * Lowest codex-cli that actually RUNS a configured hook.
 *
 * Bisected 2026-08-31 against a stub Responses endpoint, with
 * `--dangerously-bypass-hook-trust` so the trust gate could not confound it:
 *   0.135.0 — turn completed, zero hooks fired
 *   0.140.0 — turn completed, zero hooks fired
 *   0.141.0 — SessionStart + UserPromptSubmit + Stop all fired
 *   0.143.0, 0.145.0-alpha.2, 0.151.0 — same as 0.141.0
 *
 * Note what is NOT a usable capability probe: `codex features list` reports
 * `hooks  stable  true` on 0.135.0, and `--dangerously-bypass-hook-trust` is
 * present in its `--help`. Both lie. Only the version distinguishes them.
 */
export const CODEX_HOOKS_MIN_VERSION = '0.141.0';

/**
 * Codex's own hook timeout. The bridge caps itself at 2s (HOOK_TIMEOUT_MS), so
 * 2500 lets our cap fire first and leaves Codex a hard backstop that cannot
 * hold a turn open if the bridge wedges. Same reasoning as Kiro's.
 */
export const CODEX_HOOK_TIMEOUT_MS = 2500;

/**
 * The events wmux registers. Kept in lockstep with EVENT_TO_KIND in
 * bin/wmux-codex-hooks-bridge.mjs — registering an event the bridge drops
 * would spawn a process per occurrence to do nothing.
 */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

/**
 * Build the `hooks` value for config.toml as plain JS data.
 *
 * `commandWindows` is a sibling of `command` in Codex's own schema — that is
 * how a cross-platform hook gets a different invocation per OS. Both are
 * emitted with the same text here because `node "<abs path>"` is already
 * correct on every platform; the field is set anyway so a Windows Codex never
 * falls through to a POSIX-shaped default.
 */
export function buildCodexHooksConfig(bridgeScript) {
  const command = `node "${bridgeScript}"`;
  const hooks = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command,
            commandWindows: command,
            timeout: CODEX_HOOK_TIMEOUT_MS,
            // Synchronous. `async` would let Codex continue without waiting,
            // which sounds free until a `Stop` races the next turn's
            // `UserPromptSubmit` and the pane's state flips backwards. The
            // bridge's own 2s cap is what keeps sync cheap.
            async: false,
          },
        ],
      },
    ];
  }
  return hooks;
}

/**
 * Render the block as the TOML text an operator pastes into config.toml.
 *
 * Hand-rolled rather than via a TOML library: this file has to stay dependency
 * free for the same reason the bridge does, the shape is fixed and tiny, and
 * the only values interpolated are a path we control and integers.
 */
export function renderCodexHooksToml(bridgeScript) {
  const config = buildCodexHooksConfig(bridgeScript);
  const lines = [`# ${CODEX_HOOKS_MANAGED_MARKER}`];
  for (const event of CODEX_HOOK_EVENTS) {
    const [group] = config[event];
    const [handler] = group.hooks;
    lines.push(
      '',
      `[[hooks.${event}]]`,
      `matcher = ${JSON.stringify(group.matcher)}`,
      `[[hooks.${event}.hooks]]`,
      `type = ${JSON.stringify(handler.type)}`,
      `command = ${JSON.stringify(handler.command)}`,
      `commandWindows = ${JSON.stringify(handler.commandWindows)}`,
      `timeout = ${handler.timeout}`,
      `async = ${handler.async}`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * True when a codex-cli version string is at or above the hooks floor.
 *
 * Accepts what `codex --version` prints (`codex-cli 0.151.0`) and bare
 * versions, and tolerates a pre-release suffix: `0.145.0-alpha.2` is a build
 * of 0.145.0 and was measured firing, so the suffix is dropped rather than
 * ordered. A version it cannot parse is treated as TOO OLD — an unknown build
 * that silently runs no hooks is the failure this gate exists to prevent, and
 * falling back to the screen detector is the safe side of that call.
 */
export function codexSupportsHooks(versionOutput, floor = CODEX_HOOKS_MIN_VERSION) {
  const parse = (text) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const found = parse(versionOutput);
  const want = parse(floor);
  if (!found || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (found[i] > want[i]) return true;
    if (found[i] < want[i]) return false;
  }
  return true;
}
