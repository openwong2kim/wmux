/**
 * LanLink Settings section (PR-3). vitest runs in a node env with no DOM, so we
 * mirror the SettingsPanel.notifications test pattern: drive the pure
 * `LanLinkView` through renderToStaticMarkup for markup/ARIA, call its onChange
 * props directly to verify setter wiring, and unit-test the pure `nicOptions`
 * helper. Container wiring (useIpc → daemon) is validated by tsc, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LanLinkView,
  LanLinkPairingView,
  nicOptions,
  LANLINK_NIC_NONE,
  type LanLinkViewProps,
  type LanLinkPairingViewProps,
} from '../SettingsPanel';
import type { NicInfo, LanLinkNic, LanLinkPeerSummary } from '../../../../shared/lanlink';

/** Identity translator — returns the key so tests don't depend on en.ts copy. */
const tStub = (key: string): string => key;

const NIC_A: NicInfo = { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff', addresses: ['192.168.1.5'] };
const NIC_B: NicInfo = { name: 'Wi-Fi', mac: '11:22:33:44:55:66', addresses: ['192.168.1.6'] };

function makeProps(overrides: Partial<LanLinkViewProps> = {}): LanLinkViewProps {
  return {
    enabled: false,
    onToggleEnabled: () => undefined,
    options: nicOptions([NIC_A, NIC_B], null, tStub),
    selectedValue: LANLINK_NIC_NONE,
    onChangeNic: () => undefined,
    busy: false,
    t: tStub,
    ...overrides,
  };
}

describe('nicOptions', () => {
  it('leads with a None option, then one option per live NIC', () => {
    const opts = nicOptions([NIC_A, NIC_B], null, tStub);
    expect(opts[0]).toEqual({ value: LANLINK_NIC_NONE, label: 'settings.lanlinkNicNone', nic: null });
    expect(opts).toHaveLength(3);
    expect(opts[1].nic).toEqual({ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' });
    expect(opts[1].label).toContain('Ethernet');
    expect(opts[1].label).toContain('192.168.1.5');
  });

  it('keeps a persisted-but-absent NIC visible as a stale option', () => {
    const ghost: LanLinkNic = { name: 'USB-LAN', mac: 'de:ad:be:ef:00:01' };
    const opts = nicOptions([NIC_A], ghost, tStub);
    const stale = opts.find((o) => o.nic?.name === 'USB-LAN');
    expect(stale).toBeDefined();
    expect(stale!.label).toContain('settings.lanlinkNicUnavailable');
  });

  it('does NOT duplicate the selected NIC when it is already live', () => {
    const opts = nicOptions([NIC_A], { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' }, tStub);
    const ethCount = opts.filter((o) => o.nic?.name === 'Ethernet').length;
    expect(ethCount).toBe(1);
  });

  it('gives distinct values to distinct NICs (so the select can disambiguate)', () => {
    const opts = nicOptions([NIC_A, NIC_B], null, tStub);
    const values = opts.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('LanLinkView — markup', () => {
  it('renders the section, an OFF toggle, the NIC select, and the warning copy', () => {
    const html = renderToStaticMarkup(createElement(LanLinkView, makeProps()));
    expect(html).toContain('lanlink-section');
    expect(html).toContain('lanlink-warning');
    expect(html).toContain('settings.lanlinkWarning');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"'); // OFF by default
    expect(html).toContain('<select'); // NIC dropdown present
  });

  it('reflects an enabled toggle as aria-checked=true', () => {
    const html = renderToStaticMarkup(createElement(LanLinkView, makeProps({ enabled: true })));
    expect(html).toContain('aria-checked="true"');
  });

  it('shows the applying hint only when busy', () => {
    const idle = renderToStaticMarkup(createElement(LanLinkView, makeProps({ busy: false })));
    expect(idle).not.toContain('settings.lanlinkApplying');
    const busy = renderToStaticMarkup(createElement(LanLinkView, makeProps({ busy: true })));
    expect(busy).toContain('settings.lanlinkApplying');
  });
});

describe('LanLinkView — onChange wiring', () => {
  it('fires onToggleEnabled with the negated value', () => {
    const onToggleEnabled = vi.fn();
    const props = makeProps({ enabled: false, onToggleEnabled });
    // The Toggle calls onChange(!checked) on click — exercise the prop directly.
    props.onToggleEnabled(!props.enabled);
    expect(onToggleEnabled).toHaveBeenCalledWith(true);
  });

  it('fires onChangeNic with the chosen option value', () => {
    const onChangeNic = vi.fn();
    const props = makeProps({ onChangeNic });
    const ethOption = props.options.find((o) => o.nic?.name === 'Ethernet')!;
    props.onChangeNic(ethOption.value);
    expect(onChangeNic).toHaveBeenCalledWith(ethOption.value);
  });
});

// ─── LanLink pairing (PR-5) — pure view ───────────────────────────────────────

function makePairProps(overrides: Partial<LanLinkPairingViewProps> = {}): LanLinkPairingViewProps {
  return {
    enabled: true,
    pin: null,
    countdownSec: null,
    failCount: 0,
    pairBusy: false,
    onBeginPair: () => undefined,
    onCancelPair: () => undefined,
    joinHost: '',
    joinPort: 0,
    joinPin: '',
    onJoinHost: () => undefined,
    onJoinPort: () => undefined,
    onJoinPin: () => undefined,
    onJoin: () => undefined,
    joinBusy: false,
    peers: [],
    confirmingRevoke: null,
    onAskRevoke: () => undefined,
    onConfirmRevoke: () => undefined,
    onCancelRevoke: () => undefined,
    error: null,
    t: tStub,
    ...overrides,
  };
}

describe('LanLinkPairingView — markup', () => {
  it('shows only the disabled hint when LanLink is off (no actionable form)', () => {
    const html = renderToStaticMarkup(createElement(LanLinkPairingView, makePairProps({ enabled: false })));
    expect(html).toContain('settings.lanlinkPairDisabled');
    expect(html).not.toContain('settings.lanlinkPairStartButton');
  });

  it('shows the Generate PIN button + empty peers when enabled with no PIN', () => {
    const html = renderToStaticMarkup(createElement(LanLinkPairingView, makePairProps()));
    expect(html).toContain('settings.lanlinkPairStartButton');
    expect(html).toContain('settings.lanlinkPeersEmpty');
  });

  it('renders the PIN + countdown when a pairing window is open', () => {
    const html = renderToStaticMarkup(
      createElement(LanLinkPairingView, makePairProps({ pin: '123456', countdownSec: 90 })),
    );
    expect(html).toContain('lanlink-pair-pin');
    expect(html).toContain('123456');
    expect(html).toContain('settings.lanlinkPairCountdown');
  });

  it('renders a peer row with the "remote peer" badge and a revoke control', () => {
    const peers: LanLinkPeerSummary[] = [
      { peerUuid: 'u1', peerName: 'Workstation', pairedAt: 1, lastSeenAt: 2, burned: false },
    ];
    const html = renderToStaticMarkup(createElement(LanLinkPairingView, makePairProps({ peers })));
    expect(html).toContain('lanlink-peers');
    expect(html).toContain('settings.lanlinkPeerBadge');
    expect(html).toContain('Workstation');
    expect(html).toContain('settings.lanlinkPeerRevoke');
  });

  it('surfaces an error message when present', () => {
    const html = renderToStaticMarkup(createElement(LanLinkPairingView, makePairProps({ error: 'boom' })));
    expect(html).toContain('lanlink-pair-error');
    expect(html).toContain('boom');
  });
});

describe('LanLinkPairingView — onChange wiring', () => {
  it('fires onBeginPair / onJoin / onConfirmRevoke directly', () => {
    const onBeginPair = vi.fn();
    const onJoin = vi.fn();
    const onConfirmRevoke = vi.fn();
    const props = makePairProps({ onBeginPair, onJoin, onConfirmRevoke });
    props.onBeginPair();
    props.onJoin();
    props.onConfirmRevoke('u1');
    expect(onBeginPair).toHaveBeenCalled();
    expect(onJoin).toHaveBeenCalled();
    expect(onConfirmRevoke).toHaveBeenCalledWith('u1');
  });
});
