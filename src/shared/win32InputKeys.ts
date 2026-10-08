// win32-input-mode key records (`CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`), shared
// by every process that writes keys into a ConPTY pane.
//
// ConPTY asks its terminal for win32-input-mode (`CSI ? 9001 h`) at the start
// of every session on Windows, so the conhost behind each pane parses input as
// key records. A bare ESC byte is ambiguous there: it may be the first byte of
// an escape sequence, so conhost can hold it instead of delivering an Esc key.
// Measured on Claude Code 2.1.293 (#1915): a lone `\x1b` written to the pane
// left the AskUserQuestion picker and the Bash permission dialog on screen,
// while the record pair below closed both at once.
//
// Each constant is a key-down record followed by the matching key-up record
// (Kd = 0, Uc = 0), the shape a terminal in win32-input-mode sends.

/** Escape: VK_ESCAPE 27, scan 1, Unicode 27, no modifiers. */
export const ESCAPE_WIN32 = '\x1b[27;1;27;1;0;1_\x1b[27;1;0;0;0;1_';
