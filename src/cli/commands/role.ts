// ─── wmux role resolve <Role> ────────────────────────────────────────────────
//
// Read-only bridge for launchers wmux does not assemble itself (a project's
// own dispatch scripts): prints what a role is bound to in Settings → Roles &
// fan-out, as tokens a script can exec without re-implementing each CLI's
// grammar.
//
// Reads the app's session.json directly (the renderer persists the bindings
// there), so it works whether or not wmux is running, and re-normalizes with
// the same normalizeRoleBinding the app uses — session.json is hand-editable.
//
// Exit codes: 0 bound · 2 role not bound · 1 session file missing/unreadable.
// Zero Electron dependencies: must stay importable into the CLI bundle.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataSuffix } from '../../shared/constants';
import {
  applyRoleBinding, bindingEnforcesSkipPermissions, normalizeRoleBindings, type RoleBinding,
} from '../../shared/orchestratorRole';
import { tokenize } from '../../shared/agentResume';
import { agyEffortOf } from '../../shared/modelCatalog';

/** Electron's `app.getPath('userData')` for productName "wmux", with the same
 *  WMUX_DATA_SUFFIX isolation main applies (`-dev` for dev builds). */
export function defaultSessionPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = os.homedir();
  const base =
    platform === 'win32'
      ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, `wmux${dataSuffix()}`, 'session.json');
}

export interface ResolvedRole {
  role: string;
  agent?: string;
  model?: string;
  /** For agy this is the model id suffix, never a separate flag. */
  effort?: string;
  skipPermissions: boolean;
  /** The full launch, launcher first, as exec-ready tokens. */
  argv: string[];
  /** Flags only (argv without the launcher), for scripts that own the launcher. */
  flags: string[];
}

export function resolveRole(role: string, binding: RoleBinding): ResolvedRole {
  const agent = binding.agent;
  const effort = agent === 'agy' ? (binding.model ? agyEffortOf(binding.model) : undefined) : binding.effort;
  const argv = agent
    ? tokenize(applyRoleBinding(agent, binding, { spawnedProcess: true }).command).map((t) => t.value)
    : [];
  return {
    role,
    ...(agent ? { agent } : {}),
    ...(binding.model ? { model: binding.model } : {}),
    ...(effort ? { effort } : {}),
    // What the launch in `argv` does, not the stored setting: a permission
    // flag in the role's args withholds the skip, a skip flag in them adds it.
    skipPermissions: bindingEnforcesSkipPermissions(binding),
    argv,
    flags: argv.slice(1),
  };
}

export interface RoleDeps {
  sessionPath: string;
  readFile: (p: string) => string;
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
}

const USAGE = 'Usage: wmux role resolve <Role> [--json] [--session <path>]';

export async function handleRole(args: string[], jsonMode: boolean, overrides: Partial<RoleDeps> = {}): Promise<void> {
  const deps: RoleDeps = {
    sessionPath: defaultSessionPath(),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    exit: (c) => process.exit(c),
    ...overrides,
  };
  const [sub, role, ...rest] = args;
  if (sub !== 'resolve' || !role) {
    deps.error(USAGE);
    deps.exit(1);
    return;
  }
  const sessionFlag = rest.indexOf('--session');
  const sessionPath = sessionFlag >= 0 && rest[sessionFlag + 1] ? rest[sessionFlag + 1] : deps.sessionPath;

  let bindings;
  try {
    const data: unknown = JSON.parse(deps.readFile(sessionPath));
    // A root that is not an object is a corrupt file, not "no bindings": report
    // it as unreadable (exit 1) so a script does not read it as "not bound".
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('session data is not a JSON object');
    }
    bindings = normalizeRoleBindings((data as { orchestratorRoleBindings?: unknown }).orchestratorRoleBindings);
  } catch (err) {
    deps.error(`wmux role: cannot read ${sessionPath}: ${(err as Error).message}`);
    deps.exit(1);
    return;
  }
  // Own keys only: `constructor` / `toString` are not roles.
  const binding = Object.hasOwn(bindings, role) ? bindings[role] : undefined;
  if (!binding) {
    if (jsonMode) deps.log(JSON.stringify({ role, bound: false }));
    else deps.error(`Role "${role}" is not bound in Settings → Roles & fan-out.`);
    deps.exit(2);
    return;
  }
  const resolved = resolveRole(role, binding);
  if (jsonMode) {
    deps.log(JSON.stringify({ bound: true, ...resolved }));
  } else {
    deps.log(resolved.argv.join(' ') || `(role "${role}" has no agent bound)`);
  }
}
