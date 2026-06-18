// Pure, deterministic mapping of a Claude Code PostToolUse hook's
// (tool_name, tool_input) into a short, scannable "what is this agent doing"
// line for the Fleet View card. NO LLM, NO network — this is the local,
// structured-tool-activity surfacing described in
// plans/fleet-activity-line-hook.md.
//
// Hard guarantees (adversarial review):
//   - `toolInput` is `unknown`: every field access is guarded. Never throws;
//     any unexpected shape falls back to the bare `{toolName}`.
//   - All interpolated values are stripped of newlines + control chars.
//   - The final string is hard-truncated to <= MAX_ACTIVITY_LEN. Input length
//     is never trusted.
//   - basename handles BOTH `/` and `\` separators (Windows + POSIX), since the
//     payload comes from whatever platform the agent runs on.
//
// This file is intentionally dependency-free (no node:path) so it is safe to
// import from both main and renderer bundles.

/** Hard cap on the produced activity string (chars). Never trust input length. */
export const MAX_ACTIVITY_LEN = 80;

/**
 * Hard cap applied at the TOP of clean() before any regex / split / URL work
 * runs on untrusted input. A multi-MB tool_name or tool_input field (e.g. a
 * Claude Bash command that captured huge output, or a malformed payload) would
 * otherwise make the control-char regex and whitespace collapse do O(n) work
 * on the full string and block the main thread for tens of ms per call.
 *
 * 1024 is chosen as: comfortably above MAX_ACTIVITY_LEN (80) + any reasonable
 * prefix/suffix overhead, well below any size that causes perceptible latency
 * on V8's regex engine, and large enough that no real file path, command
 * prefix, grep pattern, or URL host could be legitimately longer. Any real
 * tool input needing more than 1024 chars for its key field (e.g. a `command`
 * that is itself a giant heredoc) is noise in a 1-line status display; the
 * BASH_CMD_LEN=40 display cap handles the output side.
 */
export const MAX_RAW_LEN = 1024;

/** Max chars of a Bash command we surface (the rest is elided). */
const BASH_CMD_LEN = 40;

/**
 * Produce a short activity string for a finished tool call.
 *
 * @param toolName  the hook's `tool_name` (may be any type — guarded).
 * @param toolInput the hook's `tool_input` (`unknown` — guarded field access).
 * @returns a scannable, control-char-free string, <= MAX_ACTIVITY_LEN chars.
 *          Falls back to the bare tool name (or empty string) on any unknown
 *          shape; never throws.
 */
export function summarizeActivity(toolName: unknown, toolInput: unknown): string {
  // Normalize the tool name itself — it's the universal fallback, so it must be
  // a clean string regardless of what arrived.
  const name = clean(typeof toolName === 'string' ? toolName : '');
  const fallback = name; // bare tool name (already cleaned)

  if (!name) {
    // No usable tool name → nothing meaningful to show. Truncate defensively.
    return truncate(fallback);
  }

  // mcp__<srv>__<tool>  →  "{srv}:{tool}"  (checked before the named switch so a
  // server that happens to expose a tool literally named "Read" isn't mistaken
  // for the built-in Read).
  const mcp = parseMcpToolName(name);
  if (mcp) {
    return truncate(`${mcp.server}:${mcp.tool}`);
  }

  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const file = basename(getStringField(toolInput, 'file_path'))
        // NotebookEdit uses notebook_path in some payload variants.
        || basename(getStringField(toolInput, 'notebook_path'));
      return file ? truncate(`✎ ${file}`) : truncate(fallback);
    }
    case 'Read': {
      const file = basename(getStringField(toolInput, 'file_path'))
        || basename(getStringField(toolInput, 'notebook_path'));
      return file ? truncate(`→ ${file}`) : truncate(fallback);
    }
    case 'Bash': {
      const cmd = getStringField(toolInput, 'command');
      if (!cmd) return truncate(fallback);
      const short = cmd.length > BASH_CMD_LEN ? `${cmd.slice(0, BASH_CMD_LEN)}…` : cmd;
      return truncate(`$ ${short}`);
    }
    case 'Grep':
    case 'Glob': {
      const pattern = getStringField(toolInput, 'pattern');
      return pattern ? truncate(`⌕ ${pattern}`) : truncate(fallback);
    }
    case 'Task': {
      const desc = getStringField(toolInput, 'description');
      return desc ? truncate(`⇲ ${desc}`) : truncate(fallback);
    }
    case 'WebFetch': {
      const url = getStringField(toolInput, 'url');
      const host = hostFromUrl(url);
      return host ? truncate(`🌐 ${host}`) : truncate(fallback);
    }
    case 'WebSearch': {
      const query = getStringField(toolInput, 'query');
      return query ? truncate(`🌐 ${query}`) : truncate(fallback);
    }
    default:
      return truncate(fallback);
  }
}

/**
 * Parse an `mcp__<server>__<tool>` tool name. Returns null when the name is not
 * an MCP tool. Server/tool segments are returned cleaned (the input `name` is
 * already cleaned by the caller, but we never assume).
 */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null; // need a non-empty server segment + separator
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/**
 * Safely read a string field from an `unknown` value. Returns '' when the value
 * is not a non-null object, the key is missing, or the field is not a string.
 * The returned string is cleaned (control chars / newlines stripped).
 */
function getStringField(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return '';
  // Index access on a guarded object; the value may still be anything.
  const raw = (input as Record<string, unknown>)[key];
  return typeof raw === 'string' ? clean(raw) : '';
}

/**
 * basename for BOTH `/` and `\` separators, without node:path (so this stays
 * importable from the renderer bundle). Trailing separators are tolerated. The
 * input is assumed already-cleaned by the caller; output is the last non-empty
 * path segment, or '' when there is none.
 */
function basename(p: string): string {
  if (!p) return '';
  // Normalize backslashes to forward slashes, then take the last segment.
  const normalized = p.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((seg) => seg.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Extract the host from a URL string. Returns '' on parse failure (the caller
 * falls back to the bare tool name). Uses the WHATWG URL parser, which never
 * throws on a value we already string-checked but may throw on a bad URL — hence
 * the try/catch.
 */
function hostFromUrl(url: string): string {
  if (!url) return '';
  try {
    return clean(new URL(url).host);
  } catch {
    return '';
  }
}

/**
 * Strip control characters (C0 + DEL + C1) and collapse any whitespace runs
 * (incl. newlines/tabs) to single spaces, then trim. This is the single
 * sanitizer applied to every interpolated value so a pathological tool_input
 * (newlines, NUL bytes, escape sequences) can never corrupt the one-line card.
 */
// Matches C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F).
// Built via RegExp(...) with hex escapes so the source stays pure-ASCII (no
// literal control bytes embedded in the file) yet still strips them at runtime.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'g');

function clean(s: string): string {
  // Cap BEFORE any regex / split / URL work so a giant untrusted string cannot
  // block the main thread. Every interpolated value flows through here, so this
  // single guard covers tool_name, file_path, command, pattern, description,
  // url, query — all paths. MAX_RAW_LEN >> MAX_ACTIVITY_LEN so no legitimate
  // display value is lost; the output is further truncated by truncate().
  const capped = s.length > MAX_RAW_LEN ? s.slice(0, MAX_RAW_LEN) : s;
  return capped
    // Drop C0 controls, DEL, and C1 controls.
    .replace(CONTROL_CHARS_RE, " ")
    // Collapse all whitespace runs (now incl. the spaces we just substituted)
    // into a single space.
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hard-truncate to MAX_ACTIVITY_LEN chars. Never trusts input length. */
function truncate(s: string): string {
  return s.length > MAX_ACTIVITY_LEN ? s.slice(0, MAX_ACTIVITY_LEN) : s;
}
