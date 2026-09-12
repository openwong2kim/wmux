// Type declarations for wmuxHooks.mjs — the bridge-side source of truth that
// src/ mirrors under a lockstep test (src/ cannot require() the ESM directly).
// Keep in sync with the exported functions in wmuxHooks.mjs.

/** Render the marker-bracketed [[hooks.*]] bridge block for config.toml. */
export function renderCodexHooksToml(commandPath: string): string;

/** Bisected version floor: codex-cli >= 0.141.0 carries working hooks. */
export function codexSupportsHooks(version: string | undefined | null): boolean;
