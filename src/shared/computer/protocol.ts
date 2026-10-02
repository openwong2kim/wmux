// Computer-use contract shared by main, the MCP tool and both native helpers.
//
// Two layers live here:
//   1. The agent-facing action set (`ComputerAction`) the MCP `computer` tool
//      accepts and main's `computer.*` RPC handlers carry.
//   2. The helper wire protocol: NDJSON over the helper's stdio. The helper's
//      first line is a `hello`; after that each line is a response to exactly
//      one request, matched by `id`. See docs/computer-use-design.md.
//
// Both native helpers (native/computer-use-windows, native/computer-use-macos)
// implement layer 2 verbatim; bump COMPUTER_PROTOCOL_VERSION on any
// incompatible change so main restarts or refuses a mismatched helper.

import { isComputerErrorCode, type ComputerErrorPayload } from './errors';

export const COMPUTER_PROTOCOL_VERSION = 1;

/** Accessibility-tree caps. Both helpers enforce the same numbers. */
export const TREE_MAX_NODES = 800;
export const TREE_MAX_DEPTH = 40;
export const TREE_TEXT_PREVIEW_CHARS = 120;

/** Snapshots stay addressable for this long, and the helper keeps this many. */
export const SNAPSHOT_TTL_MS = 120_000;
export const SNAPSHOT_CACHE_SIZE = 16;

/** Text at least this long is pasted through the clipboard instead of typed. */
export const TYPE_PASTE_THRESHOLD = 64;

/** Longest NDJSON line main accepts from a helper (base64 screenshots). */
export const HELPER_MAX_LINE_BYTES = 24 * 1024 * 1024;

export const HELPER_TIMEOUT_MS = {
  hello: 10_000,
  getAppState: 15_000,
  default: 8_000,
} as const;

/** The helper exits after this long without a request. */
export const HELPER_IDLE_EXIT_MS = 5 * 60_000;

// === Agent-facing actions ===

export const COMPUTER_OBSERVE_ACTIONS = ['capabilities', 'listApps', 'listWindows', 'getAppState'] as const;
export const COMPUTER_CONTROL_ACTIONS = ['click', 'setValue', 'type', 'pressKey', 'hotkey', 'scroll'] as const;
export const COMPUTER_ACTIONS = [...COMPUTER_OBSERVE_ACTIONS, ...COMPUTER_CONTROL_ACTIONS] as const;

export type ComputerObserveAction = (typeof COMPUTER_OBSERVE_ACTIONS)[number];
export type ComputerControlAction = (typeof COMPUTER_CONTROL_ACTIONS)[number];
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

const CONTROL_SET: ReadonlySet<string> = new Set(COMPUTER_CONTROL_ACTIONS);

export function isControlAction(action: string): action is ComputerControlAction {
  return CONTROL_SET.has(action);
}

export type ObservationMode = 'ax' | 'vision' | 'both';
export const OBSERVATION_MODES: readonly ObservationMode[] = ['ax', 'vision', 'both'];

// === Key vocabulary ===
//
// The only key names that ever reach a helper. Main normalizes what the agent
// wrote (case, aliases such as `Return`, `Esc`, `cmd`) into these canonical
// spellings and refuses anything else with `invalid_argument`, so a helper
// maps a closed set to virtual-key codes / CGKeyCodes and never parses free
// text. A helper that receives a name outside this set must answer
// `invalid_argument`, not guess.

/**
 * `meta` is the Windows key on Windows and Command on macOS; `alt` is Option
 * on macOS. Modifiers are never sent as a key on their own (a bare Win key
 * opens Start), only alongside one.
 */
export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';
export const MODIFIERS: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];

export const NAMED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
] as const;
/** Letters are lower case on the wire; Shift is a modifier, not a spelling. */
export const LETTER_KEYS = 'abcdefghijklmnopqrstuvwxyz'.split('') as readonly string[];
export const DIGIT_KEYS = '0123456789'.split('') as readonly string[];

export type NamedKey = (typeof NAMED_KEYS)[number];
/** A canonical key: a NamedKey, a lower-case letter a–z or a digit 0–9. */
export type Key = NamedKey | string;

const KEY_BY_LOWER = new Map<string, Key>(
  [...NAMED_KEYS, ...LETTER_KEYS, ...DIGIT_KEYS].map((k) => [k.toLowerCase(), k]),
);
const KEY_ALIASES: Record<string, Key> = {
  return: 'Enter', esc: 'Escape', del: 'Delete', back: 'Backspace', spacebar: 'Space', ' ': 'Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', pagedn: 'PageDown',
};
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', windows: 'meta', super: 'meta',
};

/** The canonical spelling of a key, or null when it is not in the vocabulary. */
export function normalizeKey(name: string): Key | null {
  if (typeof name !== 'string') return null;
  const lower = name === ' ' ? ' ' : name.trim().toLowerCase();
  return KEY_BY_LOWER.get(lower) ?? KEY_ALIASES[lower] ?? null;
}

/** The canonical modifier for a name (`cmd`, `Control`, `option`, …), or null. */
export function normalizeModifier(name: string): Modifier | null {
  if (typeof name !== 'string') return null;
  return MODIFIER_ALIASES[name.trim().toLowerCase()] ?? null;
}

export function isKey(value: unknown): value is Key {
  return typeof value === 'string' && KEY_BY_LOWER.get(value.toLowerCase()) === value;
}

export function isModifier(value: unknown): value is Modifier {
  return typeof value === 'string' && (MODIFIERS as readonly string[]).includes(value);
}

/**
 * Parses an agent's hotkey (`["ctrl", "shift", "t"]`, any order of modifiers)
 * into modifiers plus exactly one key. Returns a reason string when the chord
 * is not expressible in the vocabulary.
 */
export function parseHotkey(keys: readonly unknown[]): { modifiers: Modifier[]; key: Key } | { error: string } {
  const modifiers: Modifier[] = [];
  let key: Key | null = null;
  for (const raw of keys) {
    if (typeof raw !== 'string') return { error: 'hotkey keys must be strings' };
    const mod = normalizeModifier(raw);
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    const k = normalizeKey(raw);
    if (!k) return { error: `unknown key "${raw.slice(0, 20)}"` };
    if (key) return { error: 'a hotkey has exactly one non-modifier key' };
    key = k;
  }
  if (!key) return { error: 'a hotkey needs one non-modifier key, e.g. ["ctrl","s"]' };
  return { modifiers: MODIFIERS.filter((m) => modifiers.includes(m)), key };
}

/** For error messages and the tool description. */
export const KEY_VOCABULARY_TEXT =
  'Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1–F12, a–z, 0–9; modifiers ctrl, alt (option), shift, meta (cmd / Windows key)';

export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * How an action addresses its target. `index` needs the `snapshotId` it came
 * from; `x`/`y` are screenshot pixels of that same snapshot. Main converts
 * pixels to window points before the helper sees them.
 */
export interface TargetRef {
  snapshotId?: string;
  index?: number;
  x?: number;
  y?: number;
}

// === Helper-side data ===

export interface AppInfo {
  /** Stable id: bundle id on macOS, lower-cased exe path on Windows. */
  id: string;
  name: string;
  pid: number;
  /** Absolute executable path (Windows) or bundle path (macOS). */
  path: string;
  bundleId?: string;
  frontmost?: boolean;
}

export interface WindowInfo {
  id: string;
  appId: string;
  pid: number;
  title: string;
  /** Screen rectangle in logical points. */
  bounds: { x: number; y: number; width: number; height: number };
  focused?: boolean;
  minimized?: boolean;
  /** Windows only: the owning process runs at a higher integrity level. */
  elevated?: boolean;
}

export interface Screenshot {
  mime: 'image/jpeg' | 'image/png';
  /** Base64 image data. */
  data: string;
  width: number;
  height: number;
  /** Image pixels per window logical point (see scale.ts). */
  scale: number;
}

export type ScreenshotStatus =
  | { status: 'captured' }
  | { status: 'skipped' }
  | { status: 'failed'; error: ComputerErrorPayload };

export interface AppState {
  snapshotId: string;
  app: AppInfo;
  window: WindowInfo;
  /** Rendered tree text (format in docs/computer-use-design.md); absent in `vision` mode. */
  tree?: string;
  elementCount?: number;
  truncated?: boolean;
  screenshot?: Screenshot;
  screenshotStatus: ScreenshotStatus;
}

export type ActionMethod = 'accessibility' | 'synthetic' | 'clipboard';

export interface ActionResult {
  method: ActionMethod;
  /** `verified` only when the effect was read back (e.g. value after setValue). */
  verification: 'verified' | 'unverified';
  note?: string;
}

export interface HelperCapabilities {
  actions: string[];
  modes: ObservationMode[];
  permissions: { accessibility: boolean; screenRecording: boolean };
}

export interface HelperHello {
  type: 'hello';
  protocolVersion: number;
  os: 'win32' | 'darwin';
  helperVersion: string;
  capabilities: HelperCapabilities;
}

/**
 * The window main vetted for a control request (the snapshot's window). Sent
 * with every control method so the helper re-checks it right before each
 * input batch, where only the helper can do it without a race:
 *   - keyboard batches (type, pressKey, hotkey, synthetic setValue): the
 *     foreground window must be `windowId`, owned by `pid`;
 *   - pointer batches at a point (click, scroll): the window under the point
 *     must be owned by `pid`.
 * Otherwise the helper sends nothing and answers `window_not_focused`.
 * Semantic actions on an element (UIA patterns, AXPress, AXSetValue) only
 * need the element to still belong to `pid`.
 */
export interface ControlTarget {
  pid: number;
  windowId: string;
}

/**
 * Methods a helper implements. Coordinates here are window logical points.
 *
 * Held input: every control batch sends its own key-up / button-up events,
 * even when it fails part-way. On stdin EOF or a termination signal the helper
 * releases anything it still holds before exiting. A helper that was killed
 * outright cannot, so main starts a fresh one and sends `releaseInput` at
 * once (HelperProcess). `releaseInput` releases only what a helper of this
 * kind may have pressed: the four modifiers and the three mouse buttons.
 */
export interface HelperMethods {
  capabilities: { params: Record<string, never>; result: HelperCapabilities };
  listApps: { params: Record<string, never>; result: { apps: AppInfo[] } };
  listWindows: { params: { app?: string }; result: { windows: WindowInfo[] } };
  /** Resolves an app/window selector without walking the tree (for policy checks). */
  resolveTarget: { params: { app: string; window?: string }; result: { app: AppInfo; window: WindowInfo } };
  getAppState: {
    params: { app: string; window?: string; mode: ObservationMode; maxNodes: number; maxDepth: number };
    result: AppState;
  };
  click: {
    params: {
      snapshotId: string;
      target: ControlTarget;
      index?: number;
      point?: { x: number; y: number };
      button: MouseButton;
      clickCount: number;
      modifiers: Modifier[];
    };
    result: ActionResult;
  };
  setValue: { params: { snapshotId: string; target: ControlTarget; index: number; value: string }; result: ActionResult };
  type: { params: { snapshotId: string; target: ControlTarget; index?: number; text: string }; result: ActionResult };
  /** `key` is canonical (normalizeKey); never a modifier on its own. */
  pressKey: { params: { snapshotId: string; target: ControlTarget; key: Key; repeat: number }; result: ActionResult };
  /** Modifiers down in MODIFIERS order, `key` down/up, modifiers up in reverse. */
  hotkey: { params: { snapshotId: string; target: ControlTarget; modifiers: Modifier[]; key: Key }; result: ActionResult };
  scroll: {
    params: {
      snapshotId: string;
      target: ControlTarget;
      index?: number;
      point?: { x: number; y: number };
      direction: ScrollDirection;
      amount: number;
    };
    result: ActionResult;
  };
  /** Releases every modifier and mouse button the helper may hold. Always safe. */
  releaseInput: { params: Record<string, never>; result: { released: boolean } };
}

export type HelperMethod = keyof HelperMethods;

export interface HelperRequest<M extends HelperMethod = HelperMethod> {
  id: number;
  method: M;
  params: HelperMethods[M]['params'];
}

export type HelperResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: ComputerErrorPayload };

export type HelperLine =
  | { kind: 'hello'; hello: HelperHello }
  | { kind: 'response'; response: HelperResponse }
  | { kind: 'invalid'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses one NDJSON line from a helper. Never throws: a malformed line comes
 * back as `invalid` so the caller can decide to kill the helper.
 */
export function parseHelperLine(line: string): HelperLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not an object' };

  if (value.type === 'hello') {
    const caps = value.capabilities;
    if (
      typeof value.protocolVersion !== 'number' ||
      (value.os !== 'win32' && value.os !== 'darwin') ||
      typeof value.helperVersion !== 'string' ||
      !isRecord(caps) ||
      !Array.isArray(caps.actions) ||
      !Array.isArray(caps.modes) ||
      !isRecord(caps.permissions)
    ) {
      return { kind: 'invalid', reason: 'malformed hello' };
    }
    return { kind: 'hello', hello: value as unknown as HelperHello };
  }

  if (typeof value.id !== 'number' || !Number.isInteger(value.id)) {
    return { kind: 'invalid', reason: 'missing id' };
  }
  if (value.ok === true) {
    return { kind: 'response', response: { id: value.id, ok: true, result: value.result } };
  }
  if (value.ok === false && isRecord(value.error)) {
    const { code, message } = value.error;
    return {
      kind: 'response',
      response: {
        id: value.id,
        ok: false,
        error: {
          code: isComputerErrorCode(code) ? code : 'internal',
          message: typeof message === 'string' ? message : 'helper error',
        },
      },
    };
  }
  return { kind: 'invalid', reason: 'missing ok' };
}

export function encodeHelperRequest(request: HelperRequest): string {
  return `${JSON.stringify(request)}\n`;
}
