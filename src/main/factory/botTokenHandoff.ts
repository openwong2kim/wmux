// ─── Bot token hand-off — the spawner side ─────────────────────────────────
//
// A bot's MCP child is started by the bot's agent host (the Claude SDK, a
// claude pane, an ACP agent) from the {command, args, env} main gives it, so
// main never holds that child's file descriptors or its stdin. The token is
// therefore handed over in a file: main writes it, owner-only, into a fresh
// file under `factory/handoff/` for ONE spawn and names the file in the MCP
// args (`--bot-token-file=`); the MCP entry reads it once and deletes it
// (src/mcp/botTokenHandoff.ts). Nothing goes in the environment.
//
// Every agent spawn needs its own hand-off (a resumed session is a new spawn).
// `dispose()` removes a file the child never consumed; revoking the token
// itself stays the caller's job (commanderTrust.revokeCommanderToken).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { botMcpArgs, isBotBinding, type BotBinding, type BotSurfaceNarrowing } from '../../shared/bot';

export interface BotTokenHandoff {
  /** The file holding the token until the MCP child reads it. */
  filePath: string;
  /** The MCP server args after the bundle path: `--bot=<role>` and
   *  `--bot-token-file=<filePath>`. */
  mcpArgs: string[];
  /** Remove the file if it is still there. Idempotent, never throws. */
  dispose(): void;
}

/** The directory hand-off files are written to. */
export function botTokenHandoffDir(dir: string = getWmuxDir()): string {
  return path.join(dir, 'factory', 'handoff');
}

/** Write `token` for one spawn of `binding`'s MCP child. Throws when the
 *  binding is malformed, the token is empty, or the file cannot be created
 *  exclusively. */
export function writeBotTokenHandoff(
  binding: BotBinding,
  token: string,
  opts: { dir?: string; keep?: boolean; surface?: BotSurfaceNarrowing } = {},
): BotTokenHandoff {
  if (!isBotBinding(binding)) throw new Error('writeBotTokenHandoff: malformed bot binding');
  if (typeof token !== 'string' || token.length === 0) throw new Error('writeBotTokenHandoff: empty token');
  const handoffDir = botTokenHandoffDir(opts.dir);
  fs.mkdirSync(handoffDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(handoffDir, `${binding.botId}-${randomBytes(8).toString('hex')}.token`);
  // 'wx': never follow or reuse an existing path.
  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    filePath,
    mcpArgs: botMcpArgs(binding.role, filePath, opts.keep === true, opts.surface),
    dispose: () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* already consumed or removed */
      }
    },
  };
}
