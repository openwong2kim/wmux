// The "Claude can send files to the phone" setting. Claude Code offers its
// `SendUserFile` tool only when its process env carries
// CLAUDE_CODE_ATTACHMENTS_BY_PATH=1 (the "env" block of ~/.claude/settings.json
// does not turn it on), so wmux puts the variable in the env of each pane it
// starts while the setting is on. Off by default.
//
// Main writes the setting to a file in the wmux data dir
// (daemon/claudeFileSendSetting.ts); main's local spawn path and the daemon
// both read that file at spawn time. The daemon reads the file rather than
// waiting for main because it also starts panes while main is not connected:
// recovery at daemon start, phone-created panes, scheduled runs.
//
// No Node imports: the preload reads the IPC channel names from here.

/** The Claude Code variable that exposes the `SendUserFile` tool. */
export const CLAUDE_FILE_SEND_ENV = 'CLAUDE_CODE_ATTACHMENTS_BY_PATH';

/** The setting's file in the wmux data dir. */
export const CLAUDE_FILE_SEND_FILENAME = 'claude-file-send.json';

/** Renderer ↔ main read and write of the setting. */
export const CLAUDE_FILE_SEND_IPC = {
  GET: 'claude:file-send:get',
  SET: 'claude:file-send:set',
} as const;

/** What the setting adds to a new pane's env: the variable when on, nothing when off. */
export function claudeFileSendEnv(on: boolean): Record<string, string> {
  return on ? { [CLAUDE_FILE_SEND_ENV]: '1' } : {};
}
