/**
 * The Pair a phone dialog's pure pieces: whether this computer can pair, which
 * roster entry counts as "the phone that just scanned", what Can type changes
 * for other devices, and the markup of each step.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PhonePairView,
  canPair,
  codeIsLive,
  findPairedDevice,
  pairReadiness,
  sharedImpacts,
  type PhonePairViewProps,
} from '../PhonePairDialog';
import type { WebDeviceSummary, WebDiagnosis, WebTerminalInfo } from '../../../../shared/web';

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

describe('pairReadiness', () => {
  it('stopped + tailscale ok → ready', () => {
    expect(pairReadiness({ tailscale: tsOk, web: { running: false } })).toBe('ready');
  });
  it('stopped + tailscale problem → tailscale', () => {
    expect(pairReadiness({ tailscale: tsBad, web: { running: false } })).toBe('tailscale');
  });
  it('running on an https address another device can reach → shared, whatever tailscale says', () => {
    const web = { running: true, urls: ['https://box.example.ts.net/'] };
    expect(pairReadiness({ tailscale: tsBad, web })).toBe('shared');
  });
  it('running on loopback/plain http → needs-restart (never restarted behind the operator)', () => {
    const web = { running: true, urls: ['http://127.0.0.1:7681/?token=x'] };
    expect(pairReadiness({ tailscale: tsOk, web })).toBe('needs-restart');
  });
  it('running but pairing refused → needs-restart', () => {
    const web = {
      running: true,
      urls: ['https://box.example.ts.net/'],
      pairRefusal: { reason: 'no-front' as const, detail: '' },
    };
    expect(pairReadiness({ tailscale: tsOk, web })).toBe('needs-restart');
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

  it('raising input counts devices already allowed to type', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, [typing, quiet], true)).toEqual([{ key: 'web.wizardInputRaiseWarn', count: 1 }]);
  });
  it('running with nobody else paired still warns about the access link', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, [], true)).toEqual([{ key: 'web.wizardInputRaiseWarn', count: 0 }]);
  });
  it('stopped with nobody able to type: nothing to confirm', () => {
    expect(sharedImpacts({ running: false }, [quiet], true)).toEqual([]);
  });
  it('view only, or input already on: nothing to confirm', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, [typing], false)).toEqual([]);
    expect(sharedImpacts({ running: true, allowInput: true }, [typing], true)).toEqual([]);
  });
  it('the upload grant is never part of it: the dialog does not touch upload', () => {
    expect(sharedImpacts({ running: true, allowInput: true, allowUpload: true }, [typing, quiet], false)).toEqual([]);
  });
  it('an unreadable roster warns with an unknown count rather than staying silent', () => {
    expect(sharedImpacts({ running: true, allowInput: false }, null, true)).toEqual([{ key: 'web.wizardInputRaiseWarn', count: null }]);
  });
});

describe('canPair', () => {
  const ok = { readiness: 'ready' as const, name: 'p', busy: false, impacts: [], acknowledged: false };
  it('needs a ready computer, a name, no request in flight, and a confirmed impact', () => {
    expect(canPair(ok)).toBe(true);
    expect(canPair({ ...ok, readiness: 'shared' })).toBe(true);
    expect(canPair({ ...ok, readiness: null })).toBe(false);
    expect(canPair({ ...ok, readiness: 'needs-restart' })).toBe(false);
    expect(canPair({ ...ok, readiness: 'tailscale' })).toBe(false);
    expect(canPair({ ...ok, name: '   ' })).toBe(false);
    expect(canPair({ ...ok, busy: true })).toBe(false);
    const impacts = [{ key: 'web.wizardInputRaiseWarn' as const, count: 1 }];
    expect(canPair({ ...ok, impacts })).toBe(false);
    expect(canPair({ ...ok, impacts, acknowledged: true })).toBe(true);
  });
});

const live: WebTerminalInfo = {
  running: true,
  pairCode: 'ABCD2345',
  pendingDeviceName: 'my phone',
  pendingPairFlow: 'phone',
  urls: ['https://box.example.ts.net/'],
};

function render(over: Partial<PhonePairViewProps>): string {
  const base: PhonePairViewProps = {
    step: 'form',
    info: { running: false },
    readiness: null,
    diagnosis: null,
    busy: false,
    remote: false,
    name: '',
    errorLines: [],
    qr: null,
    copied: null,
    pairedName: '',
    pairedRemote: false,
    impacts: [],
    acknowledged: false,
    scopeOpen: false,
    notice: null,
    onToggleAcknowledged: vi.fn(),
    onToggleScope: vi.fn(),
    onRetry: vi.fn(),
    onOpenSettings: vi.fn(),
    onRemoteChange: vi.fn(),
    onNameChange: vi.fn(),
    onPair: vi.fn(),
    onClose: vi.fn(),
    onCancelPairing: vi.fn(),
    onNewPairCode: vi.fn(),
    onCopyPairUrl: vi.fn(),
    onCopyPairCode: vi.fn(),
    onOpenLink: vi.fn(),
    onAnother: vi.fn(),
    t,
  };
  return renderToStaticMarkup(createElement(PhonePairView, { ...base, ...over }));
}

describe('PhonePairView — the form', () => {
  it('while checking: status text, Pair is not the primary', () => {
    const html = render({ name: 'Phone' });
    expect(html).toContain('web.wizardChecking');
    expect(html).not.toContain('ui-btn-primary');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>web\.phonePairingPair/);
  });

  it('ready: readiness, name, access, the folded scope, then Cancel and Pair — Pair the one primary', () => {
    const html = render({ name: 'Phone', readiness: 'ready', diagnosis: { tailscale: tsOk, web: { running: false } } });
    const order = ['web.wizardReady', 'web.phonePairingName', 'value="Phone"', 'web.phonePairingAccess', 'web.phonePairingScope', 'web.cancel', 'web.phonePairingPair'];
    const at = order.map((k) => html.indexOf(k));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/ui-btn-primary/g)?.length).toBe(1);
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.phonePairingPair/);
    // The scope is folded until asked for.
    expect(html).not.toContain('data-pairing-scope');
  });

  it('access is View only by default, said in one line under it', () => {
    const html = render({ name: 'p', readiness: 'ready' });
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>web\.wizardViewOnly/);
    expect(html).toContain('web.wizardViewOnlyHint');
    expect(render({ name: 'p', readiness: 'ready', remote: true })).toContain('web.wizardRemoteHint');
  });

  it('opened scope shows what a paired phone reaches', () => {
    expect(render({ name: 'p', readiness: 'ready', scopeOpen: true })).toContain('data-pairing-scope');
  });

  it('without a name, Pair cannot run', () => {
    expect(render({ name: '  ', readiness: 'ready' })).toMatch(/<button[^>]*disabled=""[^>]*>web\.phonePairingPair/);
  });

  it('a server-wide effect: the warning in place, and no Pair until confirmed', () => {
    const impacts = [{ key: 'web.wizardInputRaiseWarn' as const, count: 2 }];
    const blocked = render({ name: 'p', readiness: 'shared', remote: true, impacts });
    expect(blocked).toContain('data-testid="pair-impacts"');
    expect(blocked).toContain('web.wizardConfirmShared');
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>web\.phonePairingPair/);
    const confirmed = render({ name: 'p', readiness: 'shared', remote: true, impacts, acknowledged: true });
    expect(confirmed).not.toMatch(/<button[^>]*disabled=""[^>]*>web\.phonePairingPair/);
  });

  it('while busy: the access picker cannot change under the request', () => {
    const html = render({ name: 'p', readiness: 'ready', busy: true });
    expect(html.match(/role="radio"[^>]*aria-disabled="true"/g)?.length).toBe(2);
    expect(html).toContain('web.wizardPreparing');
  });

  it('Tailscale problem: quotes its lines, links the URL, its one fix and Check again on that line', () => {
    const html = render({ name: 'p', readiness: 'tailscale', diagnosis: { tailscale: tsBad, web: { running: false } } });
    expect(html).toContain('needs the Tailscale CLI');
    expect(html).toContain('>https://tailscale.com/download</button>');
    expect(html).toContain('data-tailscale-problem-fix="pair"');
    expect(html).toContain('web.wizardRetry');
    expect(html).not.toContain('ui-btn-primary');
  });

  it('sharing without HTTPS: points at Phone access settings instead of restarting it', () => {
    const html = render({ name: 'p', readiness: 'needs-restart' });
    expect(html).toContain('web.wizardNeedsRestart');
    expect(html).toContain('web.phonePairingSettings');
    expect(html).not.toContain('ui-btn-primary');
  });

  it('sharing behind a tailnet front that tailscale reports broken: a warning with its fix', () => {
    const web = { running: true, tailscale: true, urls: ['https://box.example.ts.net/'] };
    const html = render({ name: 'p', readiness: 'shared', diagnosis: { tailscale: tsBad, web } });
    expect(html).toContain('web.wizardAlreadySharing');
    expect(html).toContain('web.wizardTailscaleWarn');
    expect(html).toContain('data-tailscale-problem-fix="pair-shared"');
  });

  it('a lapsed pairing says so on the form', () => {
    expect(render({ name: 'p', readiness: 'ready', notice: 'lapsed' })).toContain('>lapsed<');
  });
});

describe('PhonePairView — waiting', () => {
  const qrStep = { step: 'qr' as const, info: live, pairedName: 'my phone' };

  it('the QR and code, the chosen access, and only Cancel pairing', () => {
    const html = render({ ...qrStep, qr: { d: 'M0 0h1v1H0z', size: 21 }, pairedRemote: true });
    expect(html).toContain('aria-label="web.qrAlt"');
    expect(html).toContain('ABCD2345');
    expect(html).toContain('web.phonePairingWaiting');
    expect(html).toContain('web.cancelPairing');
    expect(html).not.toContain('ui-btn-primary');
    expect(render({ ...qrStep, t: (k) => (k === 'web.phonePairingWaiting' ? 'Waiting ({access})' : k), pairedRemote: true })).toContain('Waiting (web.wizardRemoteControl)');
  });

  it('★ the QR replaces the address text, and copy stays reachable', () => {
    const html = render({ ...qrStep, qr: { d: 'M0 0h1v1H0z', size: 21 } });
    expect(html).toContain('viewBox="0 0 21 21"');
    expect(html).not.toContain('/pair</span>');
    expect(html).toContain('web.copyLink');
  });

  it('falls back to the address text when there is no QR', () => {
    const html = render({ ...qrStep, qr: null });
    expect(html).not.toContain('web.qrAlt');
    expect(html).toContain('/pair');
  });

  it('names the device the code will register, next to the code', () => {
    const html = render({ ...qrStep, t: (k) => (k === 'web.pairingAs' ? 'Pairing as {name}' : k) });
    expect(html).toContain('Pairing as my phone');
  });

  it('with the named code gone: no stray code while the watcher settles it', () => {
    const html = render({ ...qrStep, info: { running: true, pairCode: 'UNNAMED1', urls: ['https://box.example.ts.net/'] } });
    expect(html).not.toContain('UNNAMED1');
    expect(html).toContain('web.devicesLoading');
  });

  it('★ a refusal REPLACES the pairing code rather than sitting beside it', () => {
    const html = render({ ...qrStep, info: { ...live, pairRefusal: { reason: 'insecure-transport', detail: 'plaintext bind' } } });
    expect(html).toContain('web.refusalInsecure');
    expect(html).toContain('web.refusalInsecureFix');
    expect(html).toContain('web.phonePairingSettings');
    expect(html).not.toContain('ABCD2345');
    expect(html).not.toContain('web.newPairCode');
  });

  it('★ a vanished tailnet front gets its own reason, not the plaintext one', () => {
    const html = render({ ...qrStep, info: { ...live, pairRefusal: { reason: 'no-front', detail: 'serve config missing' } } });
    expect(html).toContain('web.refusalNoFront');
    expect(html).not.toContain('web.refusalInsecure');
  });
});

describe('PhonePairView — done', () => {
  it('names the phone and its access, says where to change it, Done is the one primary', () => {
    const html = render({
      step: 'done',
      pairedName: 'my phone',
      t: (k) => (k === 'web.phonePairingConnected' ? '“{name}” is connected · {access}' : k),
    });
    expect(html).toContain('“my phone” is connected · web.wizardViewOnly');
    expect(html).toContain('web.phonePairingChangeLater');
    expect(html).toContain('web.phonePairingAnother');
    expect(html.match(/ui-btn-primary/g)?.length).toBe(1);
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.wizardDone/);
  });
});
