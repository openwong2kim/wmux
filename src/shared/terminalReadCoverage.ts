/** Coverage of an active alternate buffer is limited to its current viewport. */
export function terminalReadCoverage(bufferType: 'normal' | 'alternate' | undefined): {
  alternateScreen?: true;
  historyIncomplete?: true;
  hint?: string;
} {
  if (bufferType !== 'alternate') return {};
  return {
    alternateScreen: true,
    historyIncomplete: true,
    hint: 'The application is using the alternate screen, which has no terminal scrollback. '
      + 'This read covers the current viewport only; earlier output may have been overwritten. '
      + 'full_scrollback cannot recover it. Use the application transcript, or start a future '
      + 'session using an inline or scrollback-preserving mode, if the application supports one.',
  };
}
