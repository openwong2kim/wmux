// ─── Classify a bot engine_unavailable message for the owner UI ────────────
//
// BotRuntime stores the raw English refusal (truncated) on lastError and parks
// the bot. The Bots page used to show that English string and "stopped with
// error". These codes map known causes to localized cards with a Fix action;
// the raw detail stays available behind a details toggle. Pure: never throws.

export type EngineErrorCode =
  | 'not_installed'
  | 'not_logged_in'
  | 'mcp_missing'
  | 'acp_test_only'
  | 'unusable'
  /** Bots are set to a Claude API key and none is usable here. */
  | 'api_key_missing'
  /** The Claude subscription refused a bot's request (isSubscriptionRefusal). */
  | 'subscription_refused'
  | 'other';

/** How the Claude brain adapters (ClaudeSdkAdapter, ClaudePtyBrainAdapter)
 *  start their error when no claude resolves; matched below. */
export const CLAUDE_NOT_FOUND_LEAD = 'Claude Code not found —';

/** That error, for the brain named. */
export function claudeNotFoundMessage(brain: string): string {
  return `${CLAUDE_NOT_FOUND_LEAD} the ${brain} needs a claude install (native installer or npm global). Install it, then retry.`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RULES: readonly { code: EngineErrorCode; re: RegExp }[] = [
  {
    code: 'not_installed',
    re: new RegExp(`claude code is not installed|no claude executable|claude code (native binary|executable) not found|${escapeRe(CLAUDE_NOT_FOUND_LEAD)}`, 'i'),
  },
  // claudeApiKey.ts CLAUDE_API_KEY_MISSING_MESSAGE / _UNREADABLE_MESSAGE.
  { code: 'api_key_missing', re: /bots are set to run on a claude api key, but/i },
  { code: 'not_logged_in', re: /not signed in|not logged in|sign-?in could not be read|claude auth login/i },
  { code: 'mcp_missing', re: /mcp bundle was not found|would have no tools/i },
  { code: 'acp_test_only', re: /acp engines run bots only in a test build|acp stub is not available/i },
  // The SDK's own launch failures: the process did not spawn, the native
  // binary is there and fails to start, or claude exited with an error code.
  { code: 'unusable', re: /claude --version|could not run claude|claude is installed but|failed to spawn claude code process|exists but failed to launch|claude code process exited with code [1-9]/i },
];

/** Map a raw engine_unavailable (or similar) message to a stable code. Pure. */
export function classifyEngineError(message: string): EngineErrorCode {
  const m = typeof message === 'string' ? message : '';
  for (const r of RULES) {
    if (r.re.test(m)) return r.code;
  }
  return 'other';
}

/** What a bot the subscription refused tells the owner (its lastError and
 *  the room's error card), before Claude's own words. */
export const SUBSCRIPTION_REFUSED_GUIDANCE =
  'Your Claude subscription refused this bot\'s request, so the bot stopped. To keep it running, switch Bots to a Claude API key in Settings › Bots, then resume the bot.';

/** What the subscription says when it turns a bot's request away (see
 *  isSubscriptionRefusal). */
const SUBSCRIPTION_REFUSAL_RES: readonly RegExp[] = [
  /oauth authentication is (?:currently )?not (?:supported|allowed)/i,
  /only authori[sz]ed for use with claude code/i,
  /\bthird[- ]party (?:apps?|applications?|clients?|tools?|use|usage)\b/i,
  /\bextra usage\b/i,
  /\b(?:401|403)\b[^\n]{0,200}\b(?:oauth|subscription)\b/i,
  /\b(?:oauth|subscription)\b[^\n]{0,200}\b(?:401|403)\b/i,
];
/** A sign-in that ran out or was signed out: signing in again fixes it,
 *  not an API key. */
const SIGNED_OUT_RE = /token has expired|expired token|has been revoked|run \/login|not (?:signed|logged) in/i;

/** The subscription turning a bot's request away, as the API or claude
 *  words it: its sign-in refused for this use (401/403 about OAuth or the
 *  subscription), a credential "only authorized for use with Claude Code",
 *  or extra usage / third-party use. Deliberately narrow: a match parks the
 *  bot and tells the owner to switch Bots to an API key, so an expired or
 *  signed-out sign-in is not one, nor an error that only names a status. A
 *  usage-limit notice is decided before this (BotRuntime.settle). Pure. */
export function isSubscriptionRefusal(message: string): boolean {
  const m = typeof message === 'string' ? message : '';
  if (SIGNED_OUT_RE.test(m)) return false;
  return SUBSCRIPTION_REFUSAL_RES.some((re) => re.test(m));
}
