/**
 * #3049 — daemon:connected waits for the held user shells' start, bounded.
 *
 * The renderer hydrates resume offers on mount and on daemon:connected only.
 * A held user shell gets its offer (finishRecoveredPane) once main's connect
 * pass has started it, so an app already subscribed when the daemon came back
 * would read the list too early and never show that pane's resume pill.
 * Pinned structurally (house pattern: beforeQuitDisconnectRace.test.ts):
 * onInstall lives inside main's app 'ready' handler.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../test-utils/sourceText';
import { HELD_START_CONNECTED_WAIT_MS } from '../pty/userShellRecord';

const main = readSourceText(path.join(__dirname, '..', 'index.ts'));
const startAt = main.indexOf('const heldStart = startHeldUserShells(client, ');
const sendAt = main.indexOf("mainWindow.webContents.send('daemon:connected', { replaced });");

describe('daemon:connected after the held user shells start (#3049)', () => {
  it('keeps the start\'s promise, which never rejects', () => {
    expect(startAt).toBeGreaterThan(0);
    const start = main.slice(startAt, main.indexOf('});', main.indexOf('(err: unknown) =>', startAt)));
    // Both outcomes are handled on the kept promise, so an error cannot block the send.
    expect(start).toMatch(/\}\)\.then\(\(held\) => \{[\s\S]*\}, \(err: unknown\) => \{/);
  });

  it('awaits it before the send, bounded by an unref\'d timer', () => {
    expect(sendAt).toBeGreaterThan(startAt);
    const before = main.slice(startAt, sendAt);
    const waitAt = before.indexOf('await Promise.race([heldStart, new Promise<void>((resolve) => { setTimeout(resolve, HELD_START_CONNECTED_WAIT_MS).unref?.(); })]);');
    expect(waitAt).toBeGreaterThan(0);
    // An install a disconnect ended while it waited sends nothing.
    expect(before.slice(waitAt)).toMatch(/if \(daemonClient !== client\) return;/);
  });

  it('waits a few seconds at most', () => {
    expect(HELD_START_CONNECTED_WAIT_MS).toBe(5_000);
  });
});
