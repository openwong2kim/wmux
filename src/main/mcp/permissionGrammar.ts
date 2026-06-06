// wmuxPermissions grammar: `<capability>[:<path-glob>]`
//
// Substrate-side parser for the declared permission strings that plugins
// (external MCP clients) send via `mcp.declarePermissions`. Pattern is
// inspired by VS Code's `activationEvents` and Zellij's plugin-permission
// RFC: a finite capability whitelist plus an optional path/topic glob.
//
// This module is pure data → grammar validation only. Enforcement (matching
// declared permissions against incoming RPC calls) lives in the follow-up PR
// alongside the user-approval dialog.

const KNOWN_CAPABILITIES = new Set<string>([
  // Pane lifecycle and content
  'pane.read',
  'pane.write',
  'pane.create',
  'pane.delete',
  'pane.search',
  // Metadata
  'meta.read',
  'meta.write',
  // Events
  'events.subscribe',
  // Workspaces
  'workspace.read',
  'workspace.claim',
  // Terminal IO (input.send / terminal.readEvents)
  'terminal.send',
  'terminal.read',
  // Browser tools (Playwright)
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.screenshot',
  'browser.evaluate',
  'browser.read',
  // Raw cookie access via the CDP Network domain. Kept distinct from
  // browser.evaluate on purpose: CDP reads/writes HttpOnly cookies (and the
  // whole cookie jar) that document.cookie can never reach, so it grants
  // strictly more than page-JS execution and must be declared/approved on its
  // own rather than riding on browser.evaluate.
  'browser.cookies',
  // Browser-state emulation via CDP: offline mode, extra request headers,
  // timezone/locale/device overrides, and Browser.grantPermissions/
  // resetPermissions. These mutate browser state in ways page JS cannot, so it is
  // declared/approved on its own rather than riding on browser.evaluate.
  'browser.emulate',
  // Agent-to-agent
  'a2a.send',
  'a2a.execute',
  'a2a.read',
]);

// Reserved capability prefix — substrate-internal surface, never grantable
// to a plugin. Future hardening can extend this list (e.g. 'system.*').
const RESERVED_PREFIXES = ['wmux.'];

export interface ParsedPermission {
  capability: string;
  pathGlob?: string;
  pathRegex?: RegExp;
}

export type PermissionParseResult =
  | { ok: true; permission: ParsedPermission }
  | { ok: false; error: string };

export function listKnownCapabilities(): string[] {
  return Array.from(KNOWN_CAPABILITIES).sort();
}

// Convert a wmuxPermissions path-glob into a RegExp.
//
// Rules (intentionally narrow so substrate doesn't import a glob library):
//   - `*`  matches any run of characters except `.` (path separator stand-in)
//   - `**` matches any run of characters including `.`
//   - All other regex metacharacters are escaped — `.` is a literal separator
//   - Anchored to start and end (whole-path match)
const DOUBLE_STAR_SENTINEL = '__WMUX_GLOB_DOUBLESTAR__';

export function globToRegex(glob: string): RegExp {
  // 1. Escape regex metacharacters except `*` so the glob substitution below
  //    is the only thing that matters for star handling.
  let pattern = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // 2. Stash `**` behind a sentinel BEFORE single-star expansion, so the
  //    single-star pass below doesn't double-expand it.
  pattern = pattern.replace(/\*\*/g, DOUBLE_STAR_SENTINEL);
  // 3. Single-star: anything except `.`
  pattern = pattern.replace(/\*/g, '[^.]*');
  // 4. Restore double-star to `.*` (anything, including `.`)
  pattern = pattern.split(DOUBLE_STAR_SENTINEL).join('.*');
  return new RegExp(`^${pattern}$`);
}

export function parsePermission(spec: unknown): PermissionParseResult {
  if (typeof spec !== 'string') {
    return { ok: false, error: 'permission must be a string' };
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'permission must not be empty' };
  }

  const colonIdx = trimmed.indexOf(':');
  const capability = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  const pathGlob = colonIdx === -1 ? undefined : trimmed.slice(colonIdx + 1);

  if (capability.length === 0) {
    return { ok: false, error: `permission "${spec}" has empty capability` };
  }
  if (RESERVED_PREFIXES.some((p) => capability.startsWith(p))) {
    return { ok: false, error: `capability "${capability}" is reserved` };
  }
  if (!KNOWN_CAPABILITIES.has(capability)) {
    return { ok: false, error: `unknown capability "${capability}"` };
  }
  if (pathGlob !== undefined && pathGlob.length === 0) {
    return { ok: false, error: `permission "${spec}" has empty path glob` };
  }

  const parsed: ParsedPermission = { capability };
  if (pathGlob !== undefined) {
    parsed.pathGlob = pathGlob;
    try {
      parsed.pathRegex = globToRegex(pathGlob);
    } catch (err) {
      return {
        ok: false,
        error: `permission "${spec}" path glob invalid: ${String(err)}`,
      };
    }
  }
  return { ok: true, permission: parsed };
}

// Per-entry rejection emitted by `parsePermissionList`. Carries enough
// detail for the caller to point at the offending element in the original
// input — the position survives across the wire so plugins can render
// "permission #2 is unknown" instead of guessing.
export interface PermissionParseError {
  /**
   * Index into the original input array. `-1` is reserved for the
   * top-level "input is not an array" error which has no per-entry context.
   */
  index: number;
  /** The original input value, unchanged — `unknown` to surface non-strings. */
  permission: unknown;
  /** Human-readable explanation from `parsePermission`. */
  reason: string;
}

export interface PermissionListParseResult {
  parsed: ParsedPermission[];
  errors: PermissionParseError[];
}

export function parsePermissionList(input: unknown): PermissionListParseResult {
  if (!Array.isArray(input)) {
    return {
      parsed: [],
      errors: [{ index: -1, permission: input, reason: 'permissions must be an array' }],
    };
  }
  const parsed: ParsedPermission[] = [];
  const errors: PermissionParseError[] = [];
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    const result = parsePermission(entry);
    if (result.ok) parsed.push(result.permission);
    else errors.push({ index: i, permission: entry, reason: result.error });
  }
  return { parsed, errors };
}
