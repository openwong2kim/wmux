import type { LanLinkStopReason } from '../../../shared/lanlink';

/** The i18n key of the one line that says why an enabled LanLink is not listening. */
export function lanLinkStopReasonKey(reason: LanLinkStopReason): string {
  switch (reason) {
    case 'network-public':
      return 'settings.lanlinkStopPublic';
    case 'network-domain':
      return 'settings.lanlinkStopDomain';
    case 'network-unknown':
      return 'settings.lanlinkStopUnknown';
    case 'network-check-failed':
      return 'settings.lanlinkStopCheckFailed';
    case 'no-address':
      return 'settings.lanlinkStopNoAddress';
    case 'listen-failed':
      return 'settings.lanlinkStopListenFailed';
  }
}
