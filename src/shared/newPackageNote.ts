// The "note new packages on install approvals" setting. When on, a gated
// shell command that installs packages the pane's project does not have yet
// gets one quiet line on its approval card (daemon/approvals/installPackageLookup.ts).
// On by default.
//
// Main writes the setting to a file in the wmux data dir; the daemon reads it
// on each gated command, so a change applies to the next approval without a
// restart.
//
// No Node imports: the preload reads the IPC channel names from here.

/** The setting's file in the wmux data dir. */
export const NEW_PACKAGE_NOTE_FILENAME = 'new-package-note.json';

/** Renderer ↔ main read and write of the setting. */
export const NEW_PACKAGE_NOTE_IPC = {
  GET: 'approvals:new-package-note:get',
  SET: 'approvals:new-package-note:set',
} as const;
