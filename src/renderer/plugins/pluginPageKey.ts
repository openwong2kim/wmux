// A rail page plugin holds keyboard focus inside its sandboxed frame, so the
// app's window keydown listener never sees a key pressed there: a plugin
// page's own toggle shortcut could open the page but never close it again.
//
// A page may hand a chord it does not use back to the host as
// `{ v: 1, kind: 'key', key, code, ctrlKey, metaKey, altKey, shiftKey, repeat }`.
// The host runs it ONLY when it resolves to a plugin page shortcut (open that
// page, or back to Workspaces when it is the one showing, exactly as the
// window listener does). Every other app shortcut is ignored, so a plugin
// cannot press "close pane" or any other action on the user's behalf.

import { isPluginPageShortcut, resolveShortcut, type PluginPageShortcutId, type ShortcutBinding, type ShortcutKeyEventLike } from '../../shared/keymap';

const MAX_KEY_LEN = 32;

export interface BridgeKey extends ShortcutKeyEventLike {
  repeat: boolean;
}

/** A well-formed `kind: 'key'` bridge message; null for anything else. */
export function parseBridgeKey(data: unknown): BridgeKey | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || d.kind !== 'key') return null;
  const { key, code } = d;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN) return null;
  if (typeof code !== 'string' || code.length > MAX_KEY_LEN) return null;
  const flag = (v: unknown) => v === true;
  return {
    key, code,
    ctrlKey: flag(d.ctrlKey), metaKey: flag(d.metaKey), altKey: flag(d.altKey), shiftKey: flag(d.shiftKey),
    repeat: flag(d.repeat),
  };
}

/**
 * The route a forwarded key toggles to, given the route showing now; null
 * when the key is not a plugin page shortcut (or is an auto-repeat, which
 * would flip the page back and forth).
 */
export function pluginPageKeyRoute(
  key: BridgeKey,
  bindings: readonly ShortcutBinding[],
  currentRoute: string,
): 'workspaces' | PluginPageShortcutId | null {
  if (key.repeat) return null;
  const action = resolveShortcut(key, bindings);
  if (!action || !isPluginPageShortcut(action)) return null;
  return currentRoute === action ? 'workspaces' : action;
}
