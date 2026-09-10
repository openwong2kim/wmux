import type { ILinkHandler } from '@xterm/xterm';

/**
 * OSC 8 links can hide their destination behind a label, so retain xterm's
 * confirmation. Its default window.open() starts with about:blank, which
 * Electron correctly denies before the destination can be assigned. Dispatch
 * the confirmed URL through the same route as plain-text terminal links.
 */
export function createOsc8LinkHandler(
  activate: (event: MouseEvent, uri: string) => void,
): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate(event, uri) {
      if (window.confirm(`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`)) {
        activate(event, uri);
      }
    },
  };
}
