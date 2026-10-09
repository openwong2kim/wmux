import { randomUUID } from 'node:crypto';
import { withLaunchSessionId } from '../../shared/agentResume';
import { splitModelEnvMarker } from '../../shared/workerLaunch';

/**
 * pty:create's stage that pins a fresh wmux-launched Claude to a minted
 * conversation id (`claude --session-id <uuid>`), so the pane's exact id is on
 * the agent's command line from its first instant (the daemon binds it from
 * there, see agentCommandLineBinding.ts) and recovery never has to guess which
 * conversation the pane held. Typed launch lines only (`initialCommand`): an
 * `exec` unit's command is the trust-approved bytes the daemon persists and
 * replays, and its hooks already bind it. Every line withLaunchSessionId does
 * not recognise as a fresh Claude launch is left as it is. A leading worker
 * model-env marker is kept.
 */
export function withLaunchSessionPin<T extends { initialCommand?: string }>(
  options: T | undefined,
  mint: () => string = randomUUID,
): T | undefined {
  if (!options?.initialCommand) return options;
  const { marker, command } = splitModelEnvMarker(options.initialCommand);
  const pinned = withLaunchSessionId(command, mint());
  return pinned === command ? options : { ...options, initialCommand: marker + pinned };
}
