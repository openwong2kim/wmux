// Sign-in variables each vendor's CLI reads from its environment. Shared by
// main (the account vault injects them) and the daemon (a pane that spawned
// with one keeps that sign-in whatever config folder it later runs on).

import { agentRow } from './agentIdentity';

export const VENDOR_AUTH_NAMES: ReadonlyMap<string, 'claude' | 'codex'> = new Map([
  ['ANTHROPIC_API_KEY', 'claude'],
  ['ANTHROPIC_AUTH_TOKEN', 'claude'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'claude'],
  ['OPENAI_API_KEY', 'codex'],
  ['CODEX_API_KEY', 'codex'],
]);

/** A sign-in variable of an agent whose conversation can move between
 *  accounts (its row's `continueOnAccount`: Claude). Names only, any case. */
export function isContinueSignInName(name: string): boolean {
  return agentRow(VENDOR_AUTH_NAMES.get(name.toUpperCase()))?.continueOnAccount === true;
}
