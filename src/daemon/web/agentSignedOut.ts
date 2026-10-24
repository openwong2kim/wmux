import { isAuthLostAgent, type AuthLostAgent } from '../../shared/agentAuthLost';

/**
 * How long `POST /api/sessions {agentLaunch}` waits for the agent's own status
 * before it creates the pane anyway (the phone waits on this create). The
 * status probe itself may run up to its runner's timeout; it goes on in the
 * background and its answer is cached for the next create.
 */
export const SESSION_LOGIN_WAIT_MS = 3_000;

/**
 * The create was refused because the agent's own status command says this
 * account is signed out: `409 {error:"agent-signed-out", agent, effect:"none"}`.
 */
export class AgentSignedOutError extends Error {
  constructor(readonly agent: AuthLostAgent) {
    super('agent-signed-out');
  }
}

export type BoundedLoginCheck = (agent: AuthLostAgent, env: NodeJS.ProcessEnv, opts: { waitMs: number }) => Promise<boolean | null>;

/**
 * Refuse a new agent pane whose account is surely signed out. Only a definite
 * signed-out answer refuses; "cannot tell", including a status that has not
 * answered within `waitMs`, lets the create go on. An agent whose sign-in
 * wmux cannot check is never asked.
 *
 * `beforeRefusing` runs the refusals that the create would otherwise make
 * only at the spawn (the grant re-check, the account folder), so each of them
 * still answers ahead of this 409; whatever it throws is the answer instead.
 */
export async function refuseSignedOutAgent(
  check: BoundedLoginCheck,
  agent: string,
  env: NodeJS.ProcessEnv,
  onSignedOut: (agent: AuthLostAgent) => void,
  opts: { waitMs?: number; beforeRefusing?: () => Promise<void> } = {},
): Promise<void> {
  if (!isAuthLostAgent(agent)) return;
  if ((await check(agent, env, { waitMs: opts.waitMs ?? SESSION_LOGIN_WAIT_MS })) !== false) return;
  await opts.beforeRefusing?.();
  onSignedOut(agent);
  throw new AgentSignedOutError(agent);
}
