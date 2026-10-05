// The words Moa shows the operator (its completion report, its decision
// cards) are the operator's words: no wmux tool names, raw field names or
// internal ids. A prompt rule alone did not hold (a completion card read
// "pane_list: foregroundProgram=null, agents=[]"), so the server refuses such
// text and asks the brain to restate it.

/** wmux MCP tools, by their families, and the raw fields their replies carry. */
const TOOL_NAME = /\b(?:mcp__wmux__\w+|(?:pane|workspace|surface|terminal|a2a|deck|moa|fanout|channel|ledger|approval|repl|fleet)_[a-z_]+)\b/g;
const FIELD_NAME = /\b(?:ptyId|paneId|surfaceId|workspaceId|taskId|foregroundProgram|agentStatus|agentName|surfacePtyIds|otherWorkspaceAgents|bootId|asOfSeq|commanderToken)\b/g;
/** Internal ids: a daemon pty, or a uuid-shaped workspace/task/pane id. */
const INTERNAL_ID = /\b(?:daemon-[0-9a-f]{8}|(?:ws|task|pane|surface)-[0-9a-f]{8}(?:-[0-9a-f]{4}){0,3})/g;

/** The internal terms in `text`, deduplicated, in order of appearance. */
export function internalTermsIn(text: string): string[] {
  const found: string[] = [];
  for (const re of [TOOL_NAME, FIELD_NAME, INTERNAL_ID]) {
    for (const m of text.matchAll(re)) if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

/** The refusal a brain gets back, or null when every text reads plainly. */
export function plainLanguageRefusal(texts: readonly string[]): { ok: false; error: 'not_plain_language'; terms: string[]; message: string } | null {
  const terms = [...new Set(texts.flatMap(internalTermsIn))];
  if (terms.length === 0) return null;
  return {
    ok: false,
    error: 'not_plain_language',
    terms,
    message: `The operator reads this. Restate it in plain words, with no tool names, ids or field names (found: ${terms.join(', ')}), and call again.`,
  };
}
