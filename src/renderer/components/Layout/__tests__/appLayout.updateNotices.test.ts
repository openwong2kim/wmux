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
import { en } from '../../../i18n/locales/en';

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
    //
    // Asserted on the STRING, not on the call site: the placeholders live in
    // the locale copy, and t() interpolates them. Matching the source for
    // literal `{current}` only proved the hook happened to hand-roll a
    // `.replace()` chain — it went red the moment that was replaced with the
    // correct `t(key, vars)` call, while the user-visible contract was
    // unchanged. The locale contract test owns per-locale coverage; this owns
    // "the default copy names both".
    expect(en['update.readyToInstall']).toContain('{version}');
    expect(en['update.readyToInstall']).toContain('{current}');
    // And the hook must actually pass them, or the sentence renders with holes.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/update\.readyToInstall'\s*,\s*\{[^}]*version[^}]*current/s);
  });

  it('also fires when the update becomes ready DURING the session', () => {
    // The mount read alone only covers "it was already ready before you
    // looked". A background poll finishing an hour in would otherwise stay
    // silent until the next restart — which is most of the reported experience.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/onUpdateAvailable/);
    expect(body).toMatch(/data\.status !== 'downloaded'/);
  });

  it('announces once per version, whichever path gets there first', () => {
    // The pull and the live event describe the SAME pending install. Without a
    // guard, a download finishing shortly after boot posts the toast twice.
    //
    // The guard is keyed on the VERSION, not a bare boolean: an app left open
    // across two releases sees main replace the staged installer and re-fire
    // `downloaded`, and a boolean would leave the old version named in a
    // persistent toast whose button installs the new one.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/announcedVersion/);
    expect(body).toMatch(/announcedVersion === version/);
    expect(body).toMatch(/announcedVersion = version/);
  });

  it('unsubscribes the live listener on unmount', () => {
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/unsubscribe\?\.\(\)/);
    expect(body).toMatch(/unsubscribeError\?\.\(\)/);
  });

  it('says so when an install the user asked for is refused', () => {
    // The action button dismisses its own toast, and every performInstall
    // refusal reports on UPDATE_ERROR — whose only other listener is the
    // Settings panel, closed by definition whenever this toast is what the
    // user is looking at. Without this the button looks inert, which is the
    // silence #897 is about.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/onUpdateError/);
    expect(body).toMatch(/update\.installFailed/);
  });

  it('does not report a background check or download failure as an install failure', () => {
    // UPDATE_ERROR is not an install channel: it also carries a failed poll
    // (the first runs seconds after launch) and a failed download. Subscribed
    // outright, an offline machine posts "the update could not be installed"
    // at startup and again every poll — false copy, on a toast that never
    // fades, in a list that evicts its OLDEST entry, i.e. the ready-notice
    // this feature exists to keep on screen. The report is correlated to a
    // click instead.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/installRequestedAt/);
    expect(body).toMatch(/INSTALL_ERROR_WINDOW_MS/);
  });

  it('replaces the previous notice when a newer release supersedes it', () => {
    // A second release staged in the same session re-announces. Pushing on top
    // would leave the old toast up, naming version A over a button that
    // installs the staged B.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/dismissToast\(announcedToastId\)/);
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

  it('surfaces the marker reason and persists the refusal notice (#1055)', () => {
    // The reason string is the diagnostic #1055 arrived without; a fading
    // toast on the one boot after a failed update is a coin flip on whether
    // anyone was looking. Main-side suppression (takeRefusedInstall) owns
    // the case where persisting would give wrong advice.
    const body = hookBody('useRefusedInstallNotice');
    expect(body).toMatch(/persist:\s*true/);
    expect(body).toMatch(/update\.refusedInstall'\s*,\s*\{\s*detail:\s*truncateReason\(reason\)/);
    // And the default copy has somewhere for that reason to land.
    expect(en['update.refusedInstall']).toContain('{detail}');
  });

  it('routes UPDATE_ERROR through the shared policy, not an inline window check (#1055)', () => {
    // The decision lives in updateNoticePolicy.ts where it is unit-tested:
    // tagged install errors always show (macOS deadlines, one-shot installs),
    // untagged ones keep the 30s click window. Inlining the arithmetic here
    // is how the tagged cases got silently dropped in the first place.
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/shouldShowInstallError\(data,\s*installRequestedAt,\s*Date\.now\(\),\s*INSTALL_ERROR_WINDOW_MS\)/);
  });

  it('hands the Install button back after a failure, without stomping a superseding release (#1055)', () => {
    const body = hookBody('usePendingInstallNotice');
    expect(body).toMatch(/shouldReannounceAfterError\(data\)/);
    expect(body).toMatch(/announcedVersion = null;/);
    expect(body).toMatch(/announcedVersion !== null/);
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
