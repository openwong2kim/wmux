/**
 * #897 — the "an update is waiting" notice, and why it is shaped this way.
 *
 * Structural test (house pattern: appLayout.sessionSaveInvariants.test.ts).
 * AppLayout has no jsdom fixture, and every property below is one a refactor
 * could undo with all other tests staying green — while the symptom is silence,
 * which is indistinguishable from "there was no update".
 *
 * The bug: a background poll downloads and verifies an installer, emits
 * UPDATE_AVAILABLE{downloaded} once, and the only listener is the Settings
 * panel — mounted only while Settings is OPEN. So the app sat on a ready
 * installer saying nothing. Two reporters and the maintainer described the same
 * thing: it downloads, nothing happens, and pressing "Check for updates" by
 * hand is the only way through (that path sets a one-shot install intent; the
 * background poll deliberately never does).
 *
 * This subsystem has now made that mistake three times: #866's refused-install
 * notice pushed into the same Settings-only listener, this notice did not exist
 * at all, and the Settings widget itself only subscribed and never asked what
 * was already true. Same fix each time — read from a surface that is actually
 * mounted — so these assertions exist to stop a fourth round.
 *
 * Both halves are needed and neither is sufficient: the mount read covers "it
 * was ready before you looked", the live subscription covers "it became ready
 * while you were working". A poll finishing an hour into a session is the
 * common case, and a mount-only fix would stay silent for it until restart.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('AppLayout — update notices are pulled, not pushed', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'AppLayout.tsx'),
    'utf-8',
  );

  function hookBody(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} not found in AppLayout.tsx`).toBeGreaterThan(-1);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it('reads the pending install from an always-mounted surface', () => {
    // The whole point: AppLayout is mounted whether or not Settings is open.
    // Moving this read into a panel re-creates the original bug exactly.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/electronAPI\?\.updater\?\.getPendingInstall/);
    expect(source).toMatch(/usePendingInstallNotice\(t\);/);
  });

  it('shows it as a PERSISTENT toast', () => {
    // "An update is ready" is still true five minutes later. A toast that
    // auto-dismisses leaves the user exactly where they started — which is the
    // reported symptom, not a fix for it.
    expect(hookBody('usePendingInstallNotice')).toMatch(/persist:\s*true/);
  });

  it('offers the install as a one-click action', () => {
    // Without an action the notice tells the user something is ready and makes
    // them go find where to press it — which is the Settings panel they were
    // never in.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/action:\s*\{/);
    expect(body).toMatch(/installUpdate/);
  });

  it('names both versions so the notice is checkable', () => {
    // A bare "an update is ready" cannot be reconciled against what the user
    // sees in Settings; #897's reporters were comparing exactly those numbers.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/\{version\}/);
    expect(body).toMatch(/\{current\}/);
  });

  it('also fires when the update becomes ready DURING the session', () => {
    // The mount read alone only covers "it was already ready before you
    // looked". A background poll finishing an hour in would otherwise stay
    // silent until the next restart — which is most of the reported experience.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/onUpdateAvailable/);
    expect(body).toMatch(/data\.status !== 'downloaded'/);
  });

  it('announces once, whichever path gets there first', () => {
    // The pull and the live event describe the SAME pending install. Without a
    // guard, a download finishing shortly after boot posts the toast twice.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/announced/);
    expect(body).toMatch(/if \(cancelled \|\| announced\) return;/);
  });

  it('unsubscribes the live listener on unmount', () => {
    expect(hookBody('usePendingInstallNotice')).toMatch(/unsubscribe\?\.\(\)/);
  });

  it('never breaks mount, and never swallows the failure silently', () => {
    // Same posture as the refusal notice: a silent catch here reads as "no
    // update pending", which is the exact failure being fixed.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/\.catch\(/);
    expect(body).toMatch(/console\.warn/);
  });

  it('keeps the refused-install notice on the same always-mounted path', () => {
    // The precedent this fix follows. If it ever moves back into a panel, the
    // reasoning above stops being true for both notices at once.
    const body = hookBody('useRefusedInstallNotice');
    expect(body).toMatch(/electronAPI\?\.updater\?\.takeRefusedInstall/);
    expect(source).toMatch(/useRefusedInstallNotice\(t\);/);
  });
});

describe('AutoUpdater — pending install is a read, not a take', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'main', 'updater', 'AutoUpdater.ts'),
    'utf-8',
  );

  it('reports the pending install without consuming it', () => {
    // A refusal is a past event, so takeRefusedInstall clears its marker. A
    // pending install is a STATE: it is still true after you look, and stays
    // true until the install happens. Clearing it on read would make the notice
    // appear exactly once per boot — a strictly worse version of the bug.
    const start = source.indexOf('private getPendingInstall(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  private ', start + 1));
    expect(body).toMatch(/this\.downloadedPath/);
    expect(body).not.toMatch(/this\.downloadedPath\s*=\s*null/);
    expect(body).not.toMatch(/clearAbortMarker/);
  });

  it('only reports once an installer is actually downloaded and verified', () => {
    // pendingUpdate alone means "a newer release exists", which is not
    // something the user can act on with one click. downloadedPath is set only
    // after the SHA-256 check passes.
    const start = source.indexOf('private getPendingInstall(');
    const body = source.slice(start, source.indexOf('\n  private ', start + 1));
    expect(body).toMatch(/if \(!this\.downloadedPath \|\| !this\.pendingUpdate\) return null;/);
  });
});
