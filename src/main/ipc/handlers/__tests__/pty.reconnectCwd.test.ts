import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock (owner-reported 2026-07-19):
 *
 * After an app restart, reconnecting to the daemon's persistent session
 * (PTY_RECONNECT) shows only the name in the workspace sidebar — no branch/port/PR.
 * Cause: the metadata poll only handles panes present in cwdMap, and
 * buildMetadataPayload returns null immediately without a cwd, so the entire context
 * line disappears when there's no cwd. The create path seeds cwd, but reconnect threw
 * away the cwd the daemon included in the listSessions response. After-the-fact prompt
 * scraping only catches PowerShell/bash prompts, not macOS's default zsh ("works on
 * win but not mac"), so reconnect must seed it.
 *
 * The reconnect handler is deeply coupled to daemonClient RPC, so unit isolation is
 * hard (mocking it all is fragile). Like the imeCopyPaste / macCtrlPassthrough locks,
 * we pin it at the source level.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'),
  'utf8',
);

// Slice out only the PTY_RECONNECT handler body (so it doesn't mix with the create path's updateCwd).
const reconnectStart = SRC.indexOf('IPC.PTY_RECONNECT, wrapHandler');
const RECONNECT = reconnectStart > -1 ? SRC.slice(reconnectStart) : '';

describe('PTY_RECONNECT seeds cwd (source-level lock)', () => {
  it('locates the reconnect handler', () => {
    expect(reconnectStart).toBeGreaterThan(-1);
  });

  it('the listSessions response type includes cwd', () => {
    expect(RECONNECT).toMatch(/id: string; cmd: string; state: string; pid\?: number; cwd\?: string/);
  });

  it('calls updateCwd with the session cwd on reconnect', () => {
    expect(RECONNECT).toMatch(/if \(session\.cwd\) updateCwd\(id, session\.cwd\)/);
  });
});

/**
 * Source-level regression lock (dogfood 2026-07-22, 30-session scaling branch):
 *
 * A recovered pane sat BLANK until it was clicked. Root cause: attachSession
 * makes the daemon replay the session's historical RingBuffer (the only paint
 * an idle recovered shell gets — no new output is coming), but the reconnect
 * handler registered the session:data forwarder AFTER attach+connect. Under
 * boot load (many sessions recovering, busy event loop) DaemonClient could
 * read+emit that replay before a handler existed, dropping it; the pane then
 * stayed blank until a focus/reveal forced a resync.
 *
 * Fix: register setSessionDataListener BEFORE daemon.attachSession so no replay
 * byte can arrive without a handler. This lock pins that ordering — the handler
 * is deeply coupled to daemonClient RPC (electron import), so like the cwd lock
 * above we assert it at the source level.
 */
describe('PTY_RECONNECT registers session:data before attachSession (source-level lock)', () => {
  const listenerIdx = RECONNECT.indexOf('setSessionDataListener(id, onSessionData)');
  const attachIdx = RECONNECT.indexOf("daemon.attachSession', { id }");

  it('registers the session:data handler in the reconnect path', () => {
    expect(listenerIdx).toBeGreaterThan(-1);
  });

  it('calls attachSession in the reconnect path', () => {
    expect(attachIdx).toBeGreaterThan(-1);
  });

  it('registers the handler BEFORE attachSession (closes the replay-drop window)', () => {
    expect(listenerIdx).toBeLessThan(attachIdx);
  });

  it('does not re-register the handler a second time after attach (no duplicate)', () => {
    const matches = RECONNECT.match(/setSessionDataListener\(id, onSessionData\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
