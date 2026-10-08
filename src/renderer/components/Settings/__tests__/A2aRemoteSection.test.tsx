/**
 * Cross-PC A2A Settings section. Node env, no DOM: the pure `A2aRemoteView`
 * renders through renderToStaticMarkup (LanLinkSection.test.tsx pattern) and
 * its callbacks are invoked directly. Container wiring is covered by tsc.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { A2aRemoteView, fingerprintPrefix, formatRemaining, type A2aRemoteViewProps } from '../A2aRemoteSection';
import { en } from '../../../i18n/locales/en';
import type { A2aRemoteJoinError } from '../../../../shared/rpc';

const tStub = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');

function props(over: Partial<A2aRemoteViewProps> = {}): A2aRemoteViewProps {
  return {
    status: {
      enabled: true, port: 45660, listening: true, hostId: '11111111-1111-4111-8111-111111111111',
      name: 'DESK-PC', fingerprint256: FP, lastError: null,
    },
    platform: 'darwin', fingerprintCopied: false, onCopyFingerprint: () => undefined, lockedSec: null,
    busy: false, onToggleEnabled: () => undefined, portDraft: '45660', onPortDraft: () => undefined, onPortCommit: () => undefined,
    invite: null, inviteAddresses: [], remainingSec: null, copied: false,
    onCreateInvite: () => undefined, onCopyInvite: () => undefined, onCancelInvite: () => undefined,
    joinInput: '', onJoinInput: () => undefined, onJoin: () => undefined, joinBusy: false, joinOutcome: null,
    hosts: [], peers: [], confirming: null, removed: null,
    onAsk: () => undefined, onConfirm: () => undefined, onCancelConfirm: () => undefined,
    exposureOpen: null, onToggleExposure: () => undefined,
    error: null, t: tStub,
    ...over,
  };
}

const render = (p: A2aRemoteViewProps): string => renderToStaticMarkup(createElement(A2aRemoteView, p));

describe('A2aRemoteView', () => {
  it('shows this PC’s name, the first 16 fingerprint characters and the listening port', () => {
    const html = render(props());
    expect(html).toContain('DESK-PC');
    // Visible text is cut on a byte boundary with an ellipsis; the full value is the title.
    expect(html).toContain('>10:11:12:13:14:15…</span>');
    expect(html).toContain(`title="${FP}"`);
    expect(html).toContain('settings.a2aRemoteFingerprintCopy');
    expect(html).toContain('settings.a2aRemoteListening(45660)');
  });

  it('has no primary button (the LAN tab spends it on LanLink)', () => {
    const html = render(props({ invite: 'wmux-a2a://desk:45660/ABCDEFGH#sha256=x', remainingSec: 75 }));
    expect(html).not.toContain('ui-btn-primary');
  });

  it('the invite button is disabled while not listening, with the reason shown', () => {
    const html = render(props({ status: { ...props().status, listening: false, lastError: 'EADDRINUSE' } }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>settings\.a2aRemoteInviteButton</);
    expect(html).toContain('settings.a2aRemoteNotListening(EADDRINUSE)');
    expect(html).toContain('settings.a2aRemoteInviteNeedsListener');
  });

  it('an open invite shows the string, copy, countdown and cancel', () => {
    const invite = 'wmux-a2a://desk:45660/ABCDEFGH#sha256=x';
    const html = render(props({ invite, remainingSec: 75 }));
    expect(html).toContain(invite);
    expect(html).toContain('settings.a2aRemoteInviteCopy');
    expect(html).toContain('settings.a2aRemoteInviteExpires(1:15)');
    expect(html).toContain('settings.a2aRemoteInviteCancel');
  });

  it('maps every join error to its own message key, all present in en', () => {
    const codes: A2aRemoteJoinError[] = [
      'invite-invalid', 'self', 'fingerprint-mismatch', 'connect-refused', 'timeout', 'not-found',
      'code-expired', 'code-invalid', 'already-paired', 'rate-limited', 'protocol', 'failed',
    ];
    for (const error of codes) {
      const html = render(props({ joinOutcome: { ok: false, error } }));
      expect(html).toContain(`settings.a2aRemoteJoinError.${error}`);
      expect(en).toHaveProperty([`settings.a2aRemoteJoinError.${error}`]);
    }
    // The identity-changed case tells the user to get a new invite.
    expect(en['settings.a2aRemoteJoinError.fingerprint-mismatch']).toMatch(/new invite/);
  });

  it('disconnecting a peer takes a confirm step', () => {
    const peer = { v: 1 as const, peerId: 'p1', hostId: '22222222-2222-4222-8222-222222222222', name: 'LAPTOP', createdAt: '2026-10-07T00:00:00.000Z' };
    const onAsk = vi.fn();
    const first = render(props({ peers: [peer], onAsk }));
    expect(first).toContain('LAPTOP');
    expect(first).toContain('ui-btn-danger-tinted');
    expect(first).not.toContain('settings.a2aRemoteKeep');

    const onConfirm = vi.fn();
    const asking = render(props({ peers: [peer], confirming: { kind: 'peer', id: 'p1' }, onConfirm }));
    expect(asking).toContain('settings.a2aRemoteKeep');
    expect(asking).toContain('ui-btn-danger');
  });

  it('opens a PC\'s "panes to show" checklist in place', () => {
    const peer = { v: 1 as const, peerId: 'p1', hostId: '22222222-2222-4222-8222-222222222222', name: 'LAPTOP', createdAt: '2026-10-07T00:00:00.000Z' };
    const closed = render(props({ peers: [peer], renderExposure: () => 'CHECKLIST' }));
    expect(closed).toContain('settings.a2aExposureButton');
    expect(closed).not.toContain('CHECKLIST');
    const open = render(props({ peers: [peer], exposureOpen: peer.hostId, renderExposure: (id, name) => `CHECKLIST ${id} ${name}` }));
    expect(open).toContain(`CHECKLIST ${peer.hostId} LAPTOP`);
  });

  it('lists joined hosts with their address', () => {
    const host = {
      v: 1 as const, hostId: '33333333-3333-4333-8333-333333333333', name: 'BUILD-BOX', addresses: ['build-box', '10.0.0.9'],
      port: 45660, fingerprint256: FP, peerId: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-07T00:00:00.000Z',
    };
    const html = render(props({ hosts: [host] }));
    expect(html).toContain('BUILD-BOX');
    expect(html).toContain('build-box:45660');
  });
});

describe('A2aRemoteView — addresses and outcomes', () => {
  it('lists the addresses the open invite offers', () => {
    const html = render(props({
      invite: 'wmux-a2a://desk:45660/ABCDEFGH#sha256=x&alt=10.0.0.5',
      inviteAddresses: ['desk', '10.0.0.5'],
      remainingSec: 30,
    }));
    expect(html).toContain('settings.a2aRemoteInviteAddresses(desk, 10.0.0.5)');
  });

  it('says whether a removed PC was told', () => {
    expect(render(props({ removed: { name: 'BOX', remoteRevoked: true } }))).toContain('settings.a2aRemoteRemovedBoth(BOX)');
    expect(render(props({ removed: { name: 'BOX', remoteRevoked: false } }))).toContain('settings.a2aRemoteRemovedLocalOnly(BOX)');
  });

  it('a failed port change shows the error while the old port keeps serving', () => {
    const html = render(props({ status: { ...props().status, lastError: 'EADDRINUSE' } }));
    expect(html).toContain('settings.a2aRemotePortFailed(EADDRINUSE,45660)');
  });
});

describe('A2aRemoteView — platform, lockout and retry', () => {
  it('words the port hint for the platform', () => {
    expect(render(props({ platform: 'darwin' }))).toContain('settings.a2aRemotePortDesc.darwin');
    expect(render(props({ platform: 'win32' }))).toContain('settings.a2aRemotePortDesc.win32');
    for (const p of ['darwin', 'win32', 'linux']) expect(en).toHaveProperty([`settings.a2aRemotePortDesc.${p}`]);
    expect(en['settings.a2aRemotePortDesc.darwin']).not.toMatch(/Windows/);
  });

  it('says when a PC is locked out instead of only showing attempts left', () => {
    expect(render(props())).not.toContain('settings.a2aRemoteInviteLocked');
    const html = render(props({ invite: 'wmux-a2a://desk:45660/ABCDEFGH#sha256=x', remainingSec: 500, lockedSec: 8 }));
    expect(html).toContain('settings.a2aRemoteInviteLocked(0:08)');
  });

  it('a rate-limited join says when to retry', () => {
    const html = render(props({ joinOutcome: { ok: false, error: 'rate-limited', retryAfterSec: 30 } }));
    expect(html).toContain('settings.a2aRemoteJoinError.rate-limited');
    expect(html).toContain('settings.a2aRemoteJoinRetryIn(0:30)');
  });
});

describe('fingerprintPrefix', () => {
  it('cuts on a byte boundary', () => {
    expect(fingerprintPrefix('03:5C:37:EC:BF:1A:22:33')).toBe('03:5C:37:EC:BF:1A…');
    expect(fingerprintPrefix('03:5C')).toBe('03:5C');
  });
});

describe('formatRemaining', () => {
  it('renders m:ss', () => {
    expect(formatRemaining(600)).toBe('10:00');
    expect(formatRemaining(61)).toBe('1:01');
    expect(formatRemaining(-3)).toBe('0:00');
  });
});
