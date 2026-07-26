import { describe, it, expect } from 'vitest';
import {
  annotateWebStopJsonResponse,
  deviceCredentialWarning,
} from '../commands/web';

/**
 * `wmux web --status` and the per-device credential posture (M3).
 *
 * The warning exists because of one failure mode: a daemon whose device roster
 * could not be loaded still serves, still pairs, and still hands out a working
 * credential — it just hands out the SHARED one, so there is nothing to revoke
 * device by device. An operator who believes revocation is armed would leave a
 * lost phone's access alive while thinking they had cut it. The daemon reports
 * the posture in `status()`; this is the half that says it out loud.
 */
describe('deviceCredentialWarning', () => {
  it('warns ONLY when the daemon reports per-device credentials off', () => {
    const warning = deviceCredentialWarning({ deviceCredentials: false });
    expect(warning).not.toBeNull();
    const text = (warning ?? []).join('\n');
    // Names what is lost, and what the operator still has instead — a warning
    // that does not say "--new-token still rotates everyone" leaves them with
    // no lever at all.
    expect(text).toContain('revoke one device at a time');
    expect(text).toContain('SHARED token');
    expect(text).toContain('--new-token');
  });

  it('stays quiet when per-device credentials are armed', () => {
    expect(deviceCredentialWarning({ deviceCredentials: true })).toBeNull();
  });

  it('stays quiet when the daemon does not report the field at all', () => {
    // A daemon predating the field cannot answer the question. Inventing an
    // alarm for "old daemon" is the same class of lie as staying silent for a
    // real one, and it would fire on every `--status` against a 3.34.0 daemon.
    expect(deviceCredentialWarning({})).toBeNull();
    expect(deviceCredentialWarning({ deviceCredentials: undefined })).toBeNull();
  });
});

describe('annotateWebStopJsonResponse', () => {
  it('keeps a failed stop failed while reporting that its front was removed', () => {
    expect(
      annotateWebStopJsonResponse(
        { id: 'stop-1', ok: false, error: 'persisted state could not be revoked' },
        true,
      ),
    ).toEqual({
      id: 'stop-1',
      ok: false,
      error: 'persisted state could not be revoked',
      tailscaleServeRemoved: true,
    });
  });

  it('annotates a successful result without changing its envelope', () => {
    expect(
      annotateWebStopJsonResponse(
        { id: 'stop-2', ok: true, result: { running: false } },
        true,
      ),
    ).toEqual({
      id: 'stop-2',
      ok: true,
      result: { running: false, tailscaleServeRemoved: true },
    });
  });

  it('leaves the response untouched when no front was removed', () => {
    const response = { id: 'stop-3', ok: false as const, error: 'still running' };
    expect(annotateWebStopJsonResponse(response, false)).toBe(response);
  });
});
