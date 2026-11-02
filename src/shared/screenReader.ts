// Channels for the screen-reader state (main/screenReader.ts decides it).
// The renderer asks once with `get`; `changed` carries every change after.
export const SCREEN_READER_IPC = {
  get: 'system:screen-reader',
  changed: 'system:screen-reader-changed',
} as const;
