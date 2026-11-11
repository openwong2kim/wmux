// App actions: a small, fixed set of wmux features an agent in a pane may
// drive through one pipe method (`app.action`), listed by `app.action.list`.
//
// What an action may touch: the caller's own workspace and what is in it, or
// one of a few app-wide settings. Main takes the caller's workspace from its
// pane claim (minted by main's own walk of the caller's parent processes),
// checks the action id and its arguments against this registry, and only
// then hands the call to the renderer, which resolves the target in the live
// store and refuses one outside the caller's workspace. This is a guard
// against an agent's mistake (renaming or rearranging someone else's
// workspace), not a boundary against same-user code: a process of the same
// user can already reach the pipe.
//
// Versioning is by action id: a changed meaning gets a new id, never a new
// method name.

export const APP_ACTION_RPC = {
  run: 'app.action',
  list: 'app.action.list',
} as const;

/** Why an action was refused. Stable: a caller branches on it. */
export type AppActionErrorCode =
  | 'not_found'
  | 'not_owned'
  | 'invalid_args'
  | 'unknown_action'
  | 'no_window'
  | 'timeout'
  | 'fenced'
  | 'remote_refused'
  | 'no_identity';

export const APP_ACTION_ERROR_CODES: readonly AppActionErrorCode[] = [
  'not_found',
  'not_owned',
  'invalid_args',
  'unknown_action',
  'no_window',
  'timeout',
  'fenced',
  'remote_refused',
  'no_identity',
];

export function isAppActionErrorCode(value: unknown): value is AppActionErrorCode {
  return typeof value === 'string' && (APP_ACTION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * What an action's `target` names. `none` takes no target (an app-wide
 * setting); the others default to the caller's own workspace, its own pane or
 * its own terminal tab when the target is omitted.
 */
export type AppActionTargetKind = 'workspace' | 'pane' | 'surface' | 'none';

export type AppActionArgSpec =
  | { type: 'string'; required?: boolean; maxLength: number; description: string }
  | { type: 'enum'; required?: boolean; values: readonly string[]; description: string }
  /** A string (at most `maxLength`) or a finite number; the action parses it. */
  | { type: 'scalar'; required?: boolean; maxLength: number; description: string };

export interface AppActionSpec {
  id: string;
  target: AppActionTargetKind;
  args: Readonly<Record<string, AppActionArgSpec>>;
  description: string;
}

/** The settings `settings.get` reads and `settings.set` writes. */
export const APP_ACTION_SETTING_KEYS = ['theme', 'locale', 'terminal.fontSize', 'terminal.fontFamily'] as const;
export type AppActionSettingKey = (typeof APP_ACTION_SETTING_KEYS)[number];

/** Workspace and tab names: long enough for a real name, short enough to read in the sidebar. */
export const APP_ACTION_NAME_MAX = 64;
/** A target or a pane address: an id or a `#tag`. */
export const APP_ACTION_TARGET_MAX = 256;

const NAME_ARG: AppActionArgSpec = {
  type: 'string',
  required: true,
  maxLength: APP_ACTION_NAME_MAX,
  description: 'The new name. Refused when it looks like a pane tag (w1-2) or another one already uses it.',
};

export const APP_ACTIONS: readonly AppActionSpec[] = [
  {
    id: 'workspace.rename',
    target: 'workspace',
    args: { name: NAME_ARG },
    description: 'Rename the workspace. Sets the final name, so running it twice is the same as once.',
  },
  {
    id: 'tab.rename',
    target: 'surface',
    args: { name: NAME_ARG },
    description: 'Rename a terminal tab (its title, and the name #tags resolve). Defaults to the caller\'s own tab.',
  },
  {
    id: 'layout.balance',
    target: 'workspace',
    args: {},
    description: 'Give every split in the workspace equal sizes.',
  },
  {
    id: 'pane.move',
    target: 'pane',
    args: {
      beside: {
        type: 'string',
        required: true,
        maxLength: APP_ACTION_TARGET_MAX,
        description: 'The pane to put it next to: a pane id or a #tag, in the same workspace.',
      },
      edge: {
        type: 'enum',
        required: true,
        values: ['left', 'right', 'top', 'bottom'],
        description: 'Which side of that pane it ends up on.',
      },
    },
    description: 'Move a pane next to another pane of the same workspace. Defaults to the caller\'s own pane.',
  },
  {
    id: 'settings.get',
    target: 'none',
    args: {
      key: { type: 'enum', values: APP_ACTION_SETTING_KEYS, description: 'One setting; all of them when omitted.' },
    },
    description: 'Read the settings app actions can change.',
  },
  {
    id: 'settings.set',
    target: 'none',
    args: {
      key: { type: 'enum', required: true, values: APP_ACTION_SETTING_KEYS, description: 'The setting.' },
      value: {
        type: 'scalar',
        required: true,
        maxLength: 128,
        description: 'theme: a built-in theme id; locale: a supported language; terminal.fontSize: a number in the zoom range; terminal.fontFamily: a font name.',
      },
    },
    description: 'Change one setting. The app shows that an agent changed it.',
  },
  {
    id: 'notifications.markRead',
    target: 'workspace',
    args: {},
    description: 'Mark the workspace\'s notifications read.',
  },
  {
    id: 'notifications.clear',
    target: 'workspace',
    args: {},
    description: 'Remove the workspace\'s notifications.',
  },
];

export function findAppAction(id: string): AppActionSpec | undefined {
  return APP_ACTIONS.find((a) => a.id === id);
}

export type AppActionArgs = Record<string, string | number>;

export type AppActionArgsCheck =
  | { ok: true; args: AppActionArgs }
  | { ok: false; error: string };

/**
 * Check `raw` against the action's argument schema: a plain object (or
 * nothing), no key the schema does not list, every required key present,
 * each value of its type and size. Values are trimmed strings or finite
 * numbers afterwards; whether a value names a real theme or a real pane is
 * the action's own check.
 */
export function checkAppActionArgs(spec: AppActionSpec, raw: unknown): AppActionArgsCheck {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, error: `${spec.id}: args must be an object` };
  }
  const given = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(spec.args, key)) {
      const known = Object.keys(spec.args);
      return {
        ok: false,
        error: `${spec.id}: unknown argument "${key}"${known.length > 0 ? ` (takes ${known.join(', ')})` : ' (takes none)'}`,
      };
    }
  }
  const args: AppActionArgs = {};
  for (const [key, argSpec] of Object.entries(spec.args)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (argSpec.required) return { ok: false, error: `${spec.id}: missing argument "${key}"` };
      continue;
    }
    if (argSpec.type === 'scalar' && typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, error: `${spec.id}: "${key}" must be a finite number or a string` };
      args[key] = value;
      continue;
    }
    if (typeof value !== 'string') return { ok: false, error: `${spec.id}: "${key}" must be a string` };
    const text = value.trim();
    if (!text) return { ok: false, error: `${spec.id}: "${key}" is empty` };
    if (argSpec.type === 'enum') {
      if (!argSpec.values.includes(text)) {
        return { ok: false, error: `${spec.id}: "${key}" must be one of ${argSpec.values.join(', ')}` };
      }
    } else if (text.length > argSpec.maxLength) {
      return { ok: false, error: `${spec.id}: "${key}" is longer than ${argSpec.maxLength} characters` };
    }
    args[key] = text;
  }
  return { ok: true, args };
}

/** What `app.action` answers: the action's own fields on success, a code on refusal. */
export type AppActionResult =
  | ({ ok: true; id: string } & Record<string, unknown>)
  | { ok: false; code: AppActionErrorCode; error: string };

export function appActionRefusal(code: AppActionErrorCode, error: string): { ok: false; code: AppActionErrorCode; error: string } {
  return { ok: false, code, error };
}
