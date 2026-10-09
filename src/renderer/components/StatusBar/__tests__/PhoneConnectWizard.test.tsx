/**
 * The phone wizard's pure pieces: what step 1 concludes from a diagnosis,
 * which roster entry counts as "the phone that just scanned", and the markup
 * of each step.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PhoneWizardView,
  codeIsLive,
  findPairedDevice,
  sharedImpacts,
  wizardReadiness,
  type PhoneWizardViewProps,
} from '../PhoneConnectWizard';
import type { WebDeviceSummary, WebDiagnosis } from '../../../../shared/web';

const t = (key: string): string => key;
const NOW = 1_800_000_000_000;

function device(id: string, over: Partial<WebDeviceSummary> = {}): WebDeviceSummary {
  return { deviceId: id, name: id, createdAt: NOW - 1000, lastSeenAt: NOW - 1000, allowInput: false, ...over };
}

const tsOk: WebDiagnosis['tailscale'] = { ok: true, serve: 'free' };
const tsBad: WebDiagnosis['tailscale'] = {
  ok: false,
  problem: 'not-installed',
  lines: ['Error: --tailscale needs the Tailscale CLI.', '  • Install it from https://tailscale.com/download, then run it.'],
};

describe('wizardReadiness', () => {
  it('stopped + tailscale ok → ready', () => {
    expect(wizardReadiness({ tailscale: tsOk, web: { running: false } })).toBe('ready');
  });
  it('stopped + tailscale problem → tailscale', () => {
    expect(wizardReadiness({ tailscale: tsBad, web: { running: false } })).toBe('tailscale');
  });
  it('running on an https address another device can reach → shared, whatever tailscale says', () => {
    const web = { running: true, urls: ['https://box.example.ts.net/'] };
    expect(wizardReadiness({ tailscale: tsBad, web })).toBe('shared');
  });
  it('running on loopback/plain http → needs-restart (never restarted behind the operator)', () => {
    const web = { running: true, urls: ['http://127.0.0.1:7681/?token=x'] };
    expect(wizardReadiness({ tailscale: tsOk, web })).toBe('needs-restart');
  });
  it('running but pairing refused → needs-restart', () => {
    const web = {
      running: true,
      urls: ['https://box.example.ts.net/'],
      pairRefusal: { reason: 'no-front' as const, detail: '' },
    };
    expect(wizardReadiness({ tailscale: tsOk, web })).toBe('needs-restart');
  });
});

describe('pairing follows the code', () => {
  it('codeIsLive: only the running phone code under this name', () => {
    const live = { running: true, pairCode: 'AB', pendingDeviceName: 'p', pendingPairFlow: 'phone' as const };
    expect(codeIsLive(live, 'p')).toBe(true);
    expect(codeIsLive({ ...live, pendingDeviceName: undefined }, 'p')).toBe(false);
    expect(codeIsLive({ ...live, pendingPairFlow: 'computer' }, 'p')).toBe(false);
    expect(codeIsLive({ ...live, running: false }, 'p')).toBe(false);
  });

  it('findPairedDevice: the newest live device with the name, minted after the code', () => {
    const since = NOW - 500;
    const older = device('old', { name: 'p', createdAt: NOW - 10_000 });
    const mine = device('new', { name: 'p', createdAt: NOW });
    const other = device('x', { name: 'q', createdAt: NOW });
    expect(findPairedDevice([older, other, mine], 'p', since)?.deviceId).toBe('new');
    expect(findPairedDevice([older, other], 'p', since)).toBeNull();
    expect(findPairedDevice([{ ...mine, revokedAt: NOW }], 'p', since)).toBeNull();
  });
});

describe('sharedImpacts', () => {
  const typing = device('a', { allowInput: true });
  const quiet = device('b', { allowInput: false });

  it('raising input counts devices already allowed to type (legacy records included upstream)', () => {
    const info = { running: true, allowInput: false, allowUpload: false };
    expect(sharedImpacts(info, [typing, quiet], true, false)).toEqual([{ key: 'web.wizardInputRaiseWarn', count: 1 }]);
  });
  it('running with nobody else paired still warns about the access link', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, [], true, false)).toEqual([
      { key: 'web.wizardInputRaiseWarn', count: 0 },
    ]);
  });
  it('view only, or input already on: nothing to confirm', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, [typing], false, false)).toEqual([]);
    expect(sharedImpacts({ running: true, allowInput: true }, [typing], true, false)).toEqual([]);
  });
  it('upload in either direction reaches every live device', () => {
    const on = { running: true, allowInput: true, allowUpload: true };
    expect(sharedImpacts(on, [typing, quiet], false, false)).toEqual([{ key: 'web.wizardUploadOffWarn', count: 2 }]);
    const off = { running: true, allowInput: true, allowUpload: false };
    expect(sharedImpacts(off, [typing], false, true)).toEqual([{ key: 'web.wizardUploadOnWarn', count: 1 }]);
  });
  it('an unreadable roster warns with an unknown count rather than staying silent', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, null, true, false)).toEqual([
      { key: 'web.wizardInputRaiseWarn', count: null },
    ]);
  });
});

function render(over: Partial<PhoneWizardViewProps>): string {
  const base: PhoneWizardViewProps = {
    step: 'check',
    info: { running: false },
    diagnosis: null,
    busy: false,
    remote: false,
    upload: false,
    name: '',
    errorLines: [],
    qr: null,
    copied: null,
    connected: null,
    devices: [],
    impacts: [],
    acknowledged: false,
    onToggleAcknowledged: vi.fn(),
    notice: null,
    onRetry: vi.fn(),
    onPairNow: vi.fn(),
    onNext: vi.fn(),
    onBack: vi.fn(),
    onRemoteChange: vi.fn(),
    onToggleUpload: vi.fn(),
    onNameChange: vi.fn(),
    onConnect: vi.fn(),
    onCancel: vi.fn(),
    onNewPairCode: vi.fn(),
    onCopyPairUrl: vi.fn(),
    onCopyPairCode: vi.fn(),
    onOpenLink: vi.fn(),
    onOpenDevices: vi.fn(),
    onAnother: vi.fn(),
    onExit: vi.fn(),
    t,
  };
  return renderToStaticMarkup(createElement(PhoneWizardView, { ...base, ...over }));
}

describe('PhoneWizardView', () => {
  it('step 1 while checking: status text, no primary action', () => {
    const html = render({});
    expect(html).toContain('web.wizardChecking');
    expect(html).not.toContain('ui-btn-primary');
    expect(html).toContain('web.wizardAllSettings');
  });

  it('step 1 ready: Pair a phone is the one primary, the options one click away', () => {
    const html = render({ name: 'Phone', diagnosis: { tailscale: tsOk, web: { running: false } } });
    expect(html).toContain('web.wizardReady');
    expect(html.match(/ui-btn-primary/g)?.length).toBe(1);
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.connectPhonePair/);
    expect(html).toContain('web.connectPhoneOptions');
  });

  it('step 1 problem: quotes describeTailscaleProblem lines, links the URL, offers retry', () => {
    const html = render({ diagnosis: { tailscale: tsBad, web: { running: false } } });
    expect(html).toContain('needs the Tailscale CLI');
    expect(html).toContain('>https://tailscale.com/download</button>');
    expect(html).toContain('web.wizardRetry');
    expect(html).not.toContain('ui-btn-primary');
  });

  it('step 2: view/remote radio group, the existing upload grant, and a name', () => {
    const html = render({ step: 'permissions', name: 'my phone' });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="web.phoneAccess"');
    expect(html).toContain('web.wizardViewOnlyHint');
    expect(html).toContain('web.allowUpload');
    expect(html).toContain('web.wizardShowQr');
  });

  it('step 2 without a name cannot continue', () => {
    const html = render({ step: 'permissions', name: '  ' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>web\.wizardShowQr/);
  });

  it('step 3: the shared pair-code block with its QR', () => {
    const html = render({
      step: 'qr',
      info: { running: true, pairCode: 'ABCD2345', pendingDeviceName: 'my phone', urls: ['https://box.example.ts.net/'] },
      qr: { d: 'M0 0h1v1H0z', size: 21 },
    });
    expect(html).toContain('aria-label="web.qrAlt"');
    expect(html).toContain('ABCD2345');
    expect(html).toContain('web.wizardWaiting');
  });

  it('step 3 with the named code gone: no stray code while the watcher settles it', () => {
    const html = render({ step: 'qr', info: { running: true, pairCode: 'UNNAMED1', urls: ['https://box.example.ts.net/'] } });
    expect(html).not.toContain('UNNAMED1');
    expect(html).toContain('web.devicesLoading');
  });

  it('step 2 with a server-wide effect: the warning, and no way on until confirmed', () => {
    const impacts = [{ key: 'web.wizardInputRaiseWarn' as const, count: 2 }];
    const blocked = render({ step: 'permissions', name: 'p', impacts });
    expect(blocked).toContain('data-testid="wizard-impacts"');
    expect(blocked).toContain('web.wizardConfirmShared');
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>web\.wizardShowQr/);
    const confirmed = render({ step: 'permissions', name: 'p', impacts, acknowledged: true });
    expect(confirmed).not.toMatch(/<button[^>]*disabled=""[^>]*>web\.wizardShowQr/);
  });

  it('step 2 while busy: the access picker cannot change under the request', () => {
    const html = render({ step: 'permissions', name: 'p', busy: true });
    expect(html.match(/role="radio"[^>]*aria-disabled="true"/g)?.length).toBe(2);
  });

  it('step 1 while sharing behind a tailnet front that tailscale reports broken: a warning', () => {
    const web = { running: true, tailscale: true, urls: ['https://box.example.ts.net/'] };
    const html = render({ diagnosis: { tailscale: tsBad, web } });
    expect(html).toContain('web.wizardAlreadySharing');
    expect(html).toContain('web.wizardTailscaleWarn');
    expect(html).toContain('needs the Tailscale CLI');
  });

  it('step 4: the named device and the roster, with Done as primary', () => {
    const phone = device('p', { name: 'my phone', kind: 'phone', activeNow: true });
    const html = render({ step: 'done', connected: phone, devices: [phone, device('q', { revokedAt: 1 })] });
    expect(html).toContain('web.wizardConnectedTitle');
    expect(html).toContain('data-testid="wizard-devices"');
    expect(html).toContain('my phone');
    expect(html).not.toContain('>q<');
    expect(html.match(/ui-btn-primary/g)?.length).toBe(1);
  });
});
