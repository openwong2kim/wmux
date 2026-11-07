// The agent-desktop commands an agent may ask for through
// `computer({ action: 'desktop', command, args })`, and how each one becomes
// an argv for the helper's runner. Pure: no process, no file.
//
// Read-only commands only. Everything else upstream offers, including any
// command a later upstream version adds, is refused here. Every string value
// is passed as `--flag=value`, so a value can never be read as another flag.

import { ComputerError } from '../../shared/computer/errors';
import { DESKTOP_COMMANDS } from '../../shared/computer/protocol';

export { DESKTOP_COMMANDS };
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export const DESKTOP_SURFACES = ['window', 'menu', 'sheet', 'popover', 'alert'] as const;
const GET_PROPERTIES = ['text', 'value', 'title', 'bounds', 'role', 'states'] as const;
const IS_PROPERTIES = ['visible', 'enabled', 'checked', 'focused', 'expanded', 'selected'] as const;
const WAIT_PREDICATES = ['exists', 'enabled', 'visible', 'value'] as const;

/** Longest a desktop `wait` (or a traversal deadline) may run. */
export const DESKTOP_WAIT_MAX_MS = 30_000;
const TRAVERSAL_MAX_MS = 10_000;
/** What the runner is given beyond a command's own deadline: process start and output. */
const RUN_SLACK_MS = 5_000;

/** A ref as agent-desktop prints it: `@<snapshot id>:e<N>`. */
const REF_PATTERN = /^@([a-z0-9]{1,64}):e([1-9][0-9]{0,8})$/;

export interface DesktopRef {
  ref: string;
  snapshotId: string;
}

/**
 * What a command acts on: `window` and `app` need the target main resolved
 * and vetted (`--app`, plus `--window-id` for `window`); `ref` acts on the
 * snapshot its refs came from; `none` touches no app.
 */
export type DesktopScope = 'window' | 'app' | 'ref' | 'none';

export interface DesktopPlan {
  command: DesktopCommand;
  scope: DesktopScope;
  /** Refs the call names; each must come from a snapshot this agent took. */
  refs: DesktopRef[];
  /** The reply's window must be the vetted window (a window-surface snapshot; find replies name none). */
  checksWindow: boolean;
  /** The runner's deadline for this run. */
  timeoutMs: number;
  /** The argv for agent-desktop, given the vetted target's display name and window id. */
  argv(target: { appName: string; windowId: string } | null): string[];
}

const SCHEMAS: Record<DesktopCommand, string> = {
  snapshot:
    'snapshot args: { surface?: window|menu|sheet|popover|alert, root?: ref, maxDepth?: 1-30, interactiveOnly?: boolean, compact?: boolean, skeleton?: boolean, includeBounds?: boolean, timeoutMs?: number } (with app, and window from listWindows)',
  find:
    'find args: { role?, name?, value?, text?, description?, nativeId?: string, exact?: boolean, state?: string[], surface?, root?: ref, first?|last?: boolean, nth?|limit?: number, count?: boolean, timeoutMs?: number }; at least one of role, name, value, text, description, nativeId, state (with app)',
  get: 'get args: { ref: "@<snapshot>:eN", property?: text|value|title|bounds|role|states }',
  is: 'is args: { ref: "@<snapshot>:eN", property?: visible|enabled|checked|focused|expanded|selected }',
  'list-surfaces': 'list-surfaces args: {} (with app)',
  wait:
    'wait args: exactly one of { element: ref, predicate?: exists|enabled|visible|value, value?: string } | { text: string, count?: number } | { menu: true } | { menuClosed: true } | { ms: number }, plus timeout?: number up to 30000 (text and menu waits need app)',
};

/** The arg schema of a command, for an error that tells the agent how to call it. */
export function desktopSchema(command: DesktopCommand): string {
  return SCHEMAS[command];
}

function bad(command: DesktopCommand, problem: string): never {
  throw new ComputerError('invalid_argument', `${problem}. ${SCHEMAS[command]}`);
}

export function parseDesktopRef(value: unknown): DesktopRef {
  const match = typeof value === 'string' ? REF_PATTERN.exec(value) : null;
  if (!match) {
    throw new ComputerError(
      'invalid_argument',
      `a ref looks like "@s2gy5:e7", copied from the reply of computer({ action: "desktop", command: "snapshot" }) or "find" on that app; got ${JSON.stringify(value)}`,
    );
  }
  return { ref: value as string, snapshotId: match[1] };
}

/** Reads args field by field; anything left over is an unknown field. */
class Args {
  private readonly seen = new Set<string>();

  constructor(private readonly command: DesktopCommand, private readonly raw: Record<string, unknown>) {}

  private take(key: string): unknown {
    this.seen.add(key);
    return this.raw[key];
  }

  str(key: string, max = 512): string | undefined {
    const v = this.take(key);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0 || v.length > max || v.includes('\0')) bad(this.command, `${key} must be a non-empty string`);
    return v;
  }

  bool(key: string): boolean | undefined {
    const v = this.take(key);
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') bad(this.command, `${key} must be true or false`);
    return v;
  }

  int(key: string, min: number, max: number): number | undefined {
    const v = this.take(key);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) bad(this.command, `${key} must be a whole number from ${min} to ${max}`);
    return v;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const v = this.take(key);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) bad(this.command, `${key} must be one of ${allowed.join(', ')}`);
    return v as T;
  }

  strings(key: string): string[] | undefined {
    const v = this.take(key);
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 16 || v.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 64 || s.includes('\0'))) {
      bad(this.command, `${key} must be a list of short strings`);
    }
    return v as string[];
  }

  ref(key: string): DesktopRef | undefined {
    const v = this.take(key);
    return v === undefined ? undefined : parseDesktopRef(v);
  }

  done(): void {
    const unknown = Object.keys(this.raw).filter((k) => !this.seen.has(k));
    if (unknown.length > 0) bad(this.command, `unknown field ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
  }
}

const flag = (name: string, value: string | number | undefined): string[] => (value === undefined ? [] : [`--${name}=${value}`]);
const on = (name: string, value: boolean | undefined): string[] => (value ? [`--${name}`] : []);
const scopeArgs = (target: { appName: string; windowId: string } | null, withWindow: boolean): string[] => {
  if (!target) throw new ComputerError('internal', 'a desktop command that needs an app ran without one');
  return [`--app=${target.appName}`, ...(withWindow ? [`--window-id=w-${target.windowId}`] : [])];
};

export function planDesktopCommand(commandValue: unknown, argsValue: unknown): DesktopPlan {
  if (typeof commandValue !== 'string' || !(DESKTOP_COMMANDS as readonly string[]).includes(commandValue)) {
    throw new ComputerError(
      'invalid_argument',
      `desktop command must be one of ${DESKTOP_COMMANDS.join(', ')}; got ${JSON.stringify(commandValue)}`,
    );
  }
  const command = commandValue as DesktopCommand;
  if (argsValue !== undefined && (typeof argsValue !== 'object' || argsValue === null || Array.isArray(argsValue))) {
    bad(command, 'args must be an object');
  }
  const a = new Args(command, (argsValue ?? {}) as Record<string, unknown>);

  switch (command) {
    case 'snapshot': {
      const surface = a.oneOf('surface', DESKTOP_SURFACES);
      const root = a.ref('root');
      const maxDepth = a.int('maxDepth', 1, 30);
      const interactiveOnly = a.bool('interactiveOnly');
      const compact = a.bool('compact');
      const skeleton = a.bool('skeleton');
      const includeBounds = a.bool('includeBounds');
      const timeoutMs = a.int('timeoutMs', 100, TRAVERSAL_MAX_MS);
      a.done();
      return {
        command,
        scope: 'window',
        refs: root ? [root] : [],
        checksWindow: (surface ?? 'window') === 'window',
        timeoutMs: (timeoutMs ?? 3_000) + RUN_SLACK_MS,
        argv: (target) => [
          'snapshot',
          ...scopeArgs(target, true),
          ...flag('surface', surface),
          ...flag('root', root?.ref),
          ...flag('max-depth', maxDepth),
          ...on('interactive-only', interactiveOnly),
          ...on('compact', compact),
          ...on('skeleton', skeleton),
          ...on('include-bounds', includeBounds),
          ...flag('timeout-ms', timeoutMs),
        ],
      };
    }
    case 'find': {
      const filters = {
        role: a.str('role', 64),
        name: a.str('name'),
        value: a.str('value'),
        text: a.str('text'),
        description: a.str('description'),
        'native-id': a.str('nativeId'),
      };
      const exact = a.bool('exact');
      const states = a.strings('state');
      const surface = a.oneOf('surface', DESKTOP_SURFACES);
      const root = a.ref('root');
      const first = a.bool('first');
      const last = a.bool('last');
      const nth = a.int('nth', 0, 10_000);
      const limit = a.int('limit', 0, 500);
      const count = a.bool('count');
      const timeoutMs = a.int('timeoutMs', 100, TRAVERSAL_MAX_MS);
      a.done();
      if (Object.values(filters).every((v) => v === undefined) && !states?.length) bad(command, 'find needs a filter');
      if ([first, last, nth !== undefined, limit !== undefined, count].filter(Boolean).length > 1) {
        bad(command, 'first, last, nth, limit and count exclude each other');
      }
      return {
        command,
        scope: 'window',
        refs: root ? [root] : [],
        checksWindow: false,
        timeoutMs: (timeoutMs ?? 5_000) + RUN_SLACK_MS,
        argv: (target) => [
          'find',
          ...scopeArgs(target, true),
          ...Object.entries(filters).flatMap(([k, v]) => flag(k, v)),
          ...on('exact', exact),
          ...(states ?? []).flatMap((s) => flag('state', s)),
          ...flag('surface', surface),
          ...flag('root', root?.ref),
          ...on('first', first),
          ...on('last', last),
          ...flag('nth', nth),
          ...flag('limit', limit),
          ...on('count', count),
          ...flag('timeout-ms', timeoutMs),
        ],
      };
    }
    case 'get':
    case 'is': {
      const ref = a.ref('ref');
      const property = command === 'get' ? a.oneOf('property', GET_PROPERTIES) : a.oneOf('property', IS_PROPERTIES);
      a.done();
      if (!ref) bad(command, 'ref is required');
      return {
        command,
        scope: 'ref',
        refs: [ref],
        checksWindow: false,
        timeoutMs: 5_000 + RUN_SLACK_MS,
        argv: () => [command, ref.ref, ...flag('property', property)],
      };
    }
    case 'list-surfaces': {
      a.done();
      return { command, scope: 'app', refs: [], checksWindow: false, timeoutMs: 5_000 + RUN_SLACK_MS, argv: (target) => ['list-surfaces', ...scopeArgs(target, false)] };
    }
    case 'wait': {
      const element = a.ref('element');
      const predicate = a.oneOf('predicate', WAIT_PREDICATES);
      const value = a.str('value');
      const text = a.str('text');
      const count = a.int('count', 0, 10_000);
      const menu = a.bool('menu');
      const menuClosed = a.bool('menuClosed');
      const ms = a.int('ms', 0, DESKTOP_WAIT_MAX_MS);
      const timeout = a.int('timeout', 100, DESKTOP_WAIT_MAX_MS);
      a.done();
      const modes = [element !== undefined, text !== undefined, menu === true, menuClosed === true, ms !== undefined].filter(Boolean).length;
      if (modes !== 1) bad(command, 'wait takes exactly one of element, text, menu, menuClosed, ms');
      if ((predicate !== undefined || value !== undefined) && !element) bad(command, 'predicate and value go with element');
      if (value !== undefined && predicate !== 'value') bad(command, 'value goes with predicate: "value"');
      if (count !== undefined && text === undefined) bad(command, 'count goes with text');
      const deadline = ms ?? timeout ?? DESKTOP_WAIT_MAX_MS;
      const scope: DesktopScope = element ? 'ref' : ms !== undefined ? 'none' : 'app';
      return {
        command,
        scope,
        refs: element ? [element] : [],
        checksWindow: false,
        timeoutMs: deadline + RUN_SLACK_MS,
        argv: (target) => {
          if (ms !== undefined) return ['wait', String(ms)];
          return [
            'wait',
            ...(element ? flag('element', element.ref) : scopeArgs(target, false)),
            ...flag('predicate', predicate),
            ...flag('value', value),
            ...flag('text', text),
            ...flag('count', count),
            ...on('menu', menu),
            ...on('menu-closed', menuClosed),
            ...flag('timeout', deadline),
          ];
        },
      };
    }
  }
}

/** agent-desktop's error codes, as wmux's. Anything else is `internal`. */
const UPSTREAM_CODES = new Map<string, ConstructorParameters<typeof ComputerError>[0]>([
  ['ELEMENT_NOT_FOUND', 'element_not_found'],
  ['STALE_REF', 'element_stale'],
  ['SNAPSHOT_NOT_FOUND', 'snapshot_unknown'],
  ['APP_NOT_FOUND', 'app_not_found'],
  ['WINDOW_NOT_FOUND', 'window_not_found'],
  ['AMBIGUOUS_TARGET', 'invalid_argument'],
  ['INVALID_ARGS', 'invalid_argument'],
  ['TIMEOUT', 'timeout'],
  ['PERM_DENIED', 'permission_missing'],
  ['ACTION_NOT_SUPPORTED', 'action_not_supported'],
  ['APP_UNRESPONSIVE', 'timeout'],
]);

export interface DesktopReply {
  command: string;
  data: Record<string, unknown>;
}

/** The JSON envelope agent-desktop prints, or the ComputerError its failure maps to. */
export function parseDesktopReply(stdout: string): DesktopReply {
  let envelope: { ok?: unknown; command?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  try {
    envelope = JSON.parse(stdout.trim()) as typeof envelope;
  } catch {
    throw new ComputerError('internal', 'agent-desktop printed something that is not its JSON reply');
  }
  if (envelope?.ok !== true) {
    const code = typeof envelope?.error?.code === 'string' ? UPSTREAM_CODES.get(envelope.error.code) ?? 'internal' : 'internal';
    const message = typeof envelope?.error?.message === 'string' ? envelope.error.message : 'agent-desktop failed';
    throw new ComputerError(code, message);
  }
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>) : {};
  return { command: typeof envelope.command === 'string' ? envelope.command : '', data };
}

/** The pids a snapshot's refmap.json says its refs belong to; null when it cannot be read as one. */
export function refmapPids(refmap: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(refmap);
  } catch {
    return null;
  }
  const inner = (parsed as { inner?: unknown } | null)?.inner;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  return Object.values(inner).map((entry) => {
    const pid = (entry as { pid?: unknown } | null)?.pid;
    return typeof pid === 'number' ? pid : -1;
  });
}

/** The apps agent-desktop picks from for `--app=<name>` (it prints every candidate). */
export const listAppsArgv = (name: string): string[] => ['list-apps', `--app=${name}`];

const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const foldName = (text: string): string => text.replace(BIDI_CONTROLS, '').replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * agent-desktop's display-name match (core app_info.rs `app_name_matches`):
 * exact after dropping bidi controls, ASCII case folded, or the name plus
 * ".exe". A bundle id or executable name stands in only when no app matches.
 */
export function appNameMatches(actual: string, expected: string): boolean {
  const want = foldName(expected);
  const got = foldName(actual);
  return got === want || (!expected.endsWith('.exe') && got === `${want}.exe`);
}

/** Pids of the apps a list-apps reply names `name` by display name; null when its inventory is incomplete or unreadable. */
export function namedPids(reply: DesktopReply, name: string): number[] | null {
  const apps = reply.data.apps;
  if (!Array.isArray(apps) || reply.data.complete === false) return null;
  const pids: number[] = [];
  for (const app of apps as Array<{ name?: unknown; pid?: unknown } | null>) {
    if (typeof app?.name !== 'string' || typeof app.pid !== 'number') return null;
    if (appNameMatches(app.name, name)) pids.push(app.pid);
  }
  return pids;
}
