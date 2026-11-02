/**
 * Make the wmux window the owner of a pane's console window (Windows).
 *
 * A console program that opens a window of its own parents it to the console:
 * MSAL/WAM sign-in (`az login`'s account picker, and other tools that use it)
 * walks `GetAncestor(GetConsoleWindow(), GA_ROOTOWNER)`. Under ConPTY that
 * console window is a hidden pseudo-window with no owner, so the picker had no
 * relation to wmux and opened behind it: the pane looked frozen.
 *
 * `setParentWindow` asks the bundled conpty.dll (`ConptyReparentPseudoConsole`)
 * to make a given top-level window that owner, so such a window stacks above
 * wmux. Both pty engines have it: node-pty 1.2.0-beta.17, and the Rust core
 * (terminalPty.ts RustPty, through the vendored portable-pty). The in-box
 * ConPTY has no equivalent: there, and off Windows, the call is a no-op that
 * reports false.
 */
import type { IPty } from 'node-pty';

/**
 * The size of an HWND in a 64-bit process, as Electron's getNativeWindowHandle()
 * returns it. 64-bit only: wmux ships no ia32 build.
 */
export const NATIVE_WINDOW_HANDLE_BYTES = 8;

/** Main → daemon: `{ handle: base64 | null }`, the desk window (daemon/hostWindowRpc.ts). */
export const HOST_WINDOW_RPC = 'daemon.setHostWindow';

/**
 * A window to hand to ConPTY: one HWND's bytes in native byte order, and not
 * the all-zero (NULL) handle. A NULL owner is never sent: when the owner
 * window is destroyed, Windows already drops it as the console's owner.
 */
export function isNativeWindowHandle(handle: unknown): handle is Buffer {
  return Buffer.isBuffer(handle) && handle.length === NATIVE_WINDOW_HANDLE_BYTES && !isNullHandle(handle);
}

function isNullHandle(bytes: Buffer): boolean {
  return bytes.every((b) => b === 0);
}

/**
 * Ask ConPTY to make `handle` the owner of `p`'s console window. Returns
 * whether the request was sent (ConPTY applies it asynchronously). Never
 * throws: a pty that is already closed, or one without the method (a Rust
 * core module built before it, a test double), just reports false.
 */
export function applyParentWindow(
  p: Pick<IPty, 'setParentWindow'>,
  handle: Buffer | null,
): boolean {
  if (!isNativeWindowHandle(handle)) return false;
  if (typeof p.setParentWindow !== 'function') return false;
  try {
    return p.setParentWindow(handle);
  } catch {
    return false;
  }
}

/**
 * Decode the wire form of a handle (base64 of its bytes, or null). Null and
 * an all-zero handle both mean "no window": the daemon stops handing one to
 * new panes. Anything else that is not exactly one HWND is refused (undefined).
 */
export function decodeNativeWindowHandle(wire: unknown): Buffer | null | undefined {
  if (wire === null) return null;
  if (typeof wire !== 'string') return undefined;
  const bytes = Buffer.from(wire, 'base64');
  if (bytes.length !== NATIVE_WINDOW_HANDLE_BYTES || bytes.toString('base64') !== wire) return undefined;
  return isNullHandle(bytes) ? null : bytes;
}
