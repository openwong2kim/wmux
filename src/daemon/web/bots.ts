// The phone's read-only view of the desktop Bots page list:
//
//   GET /api/bots
//
// Bots, group chats and rooms live in Electron main; this daemon gates, asks
// main over the desktop bridge (shared/phoneBots.ts names the command) and
// parses its reply with the same allowlist main projected with. It never
// caches the list.
//
// The gate is `--allow-transcript`, as for the room routes: names, previews
// and counts are bot-authored room text. Checked first. No desktop, or one
// whose factory has not started, is 503: nothing here answers from memory.

import { PHONE_BOTS_COMMAND, parsePhoneBotsReply } from '../../shared/phoneBots';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';
import type { RoomsDesktop, RoomsResponse } from './rooms';

export const BOTS_ROUTE = '/api/bots';

/** Whether the list command answers on the attached desktop. */
export function botsSupported(desktop: RoomsDesktop | null): boolean {
  return !!desktop && desktop.supports(PHONE_BOTS_COMMAND);
}

/** `GET /api/bots`. Never throws. */
export async function botsResponse(opts: { allowTranscript: boolean; desktop: RoomsDesktop | null }): Promise<RoomsResponse> {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'transcript-disabled' } };
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!botsSupported(desktop)) return { status: 503, body: { error: 'bots-unavailable' } };
  let reply: unknown;
  try {
    reply = await desktop.request(PHONE_BOTS_COMMAND, {});
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  if (reply !== null && typeof reply === 'object' && (reply as Record<string, unknown>).unavailable === true) {
    return { status: 503, body: { error: 'bots-unavailable' } };
  }
  const list = parsePhoneBotsReply(reply);
  return list ? { status: 200, body: list } : { status: 502, body: { error: 'desktop-bad-reply' } };
}
