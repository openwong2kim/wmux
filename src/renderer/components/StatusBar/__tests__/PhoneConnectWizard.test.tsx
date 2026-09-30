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
  findNewDevice,
  liveDeviceIds,
  wizardReadiness,
  type PhoneWizardViewProps,
} from '../PhoneConnectWizard';
import { DEVICE_ACTIVE_WINDOW_MS, type WebDeviceSummary, type WebDiagnosis } from '../../../../shared/web';

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

describe('findNewDevice', () => {
  const baseline = liveDeviceIds([device('a'), device('gone', { revokedAt: NOW - 5 })]);

  it('baseline holds live devices only', () => {
    expect([...baseline]).toEqual(['a']);
  });
  it('a device outside the baseline, seen recently, is the new phone', () => {
    expect(findNewDevice([device('a'), device('b')], baseline, NOW)?.deviceId).toBe('b');
  });
  it('an old or revoked record is not', () => {
    const stale = device('c', { lastSeenAt: NOW - DEVICE_ACTIVE_WINDOW_MS - 1 });
    const revoked = device('d', { revokedAt: NOW });
    expect(findNewDevice([device('a'), stale, revoked], baseline, NOW)).toBeNull();
  });
  it('activeNow counts even when lastSeenAt lags', () => {
    const live = device('e', { lastSeenAt: 0, activeNow: true });
    expect(findNewDevice([live], baseline, NOW)?.deviceId).toBe('e');
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
    onRetry: vi.fn(),
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

  it('step 1 ready: Next is the one primary', () => {
    const html = render({ diagnosis: { tailscale: tsOk, web: { running: false } } });
    expect(html).toContain('web.wizardReady');
    expect(html.match(/ui-btn-primary/g)?.length).toBe(1);
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

  it('step 3 with the named code gone: no stray code, a way to mint a new one', () => {
    const html = render({ step: 'qr', info: { running: true, pairCode: 'UNNAMED1', urls: ['https://box.example.ts.net/'] } });
    expect(html).not.toContain('UNNAMED1');
    expect(html).toContain('web.pairSpent');
    expect(html).toContain('web.newPairCode');
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
