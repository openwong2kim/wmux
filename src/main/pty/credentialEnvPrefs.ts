// Settings > Git safety: "Withhold credentials from agent panes" (default on).
//
// Read at every pane spawn by pty.handler (daemon mode) and PTYManager (local
// mode) and handed to resolveEnvPolicy. Off lets an interactive agent pane
// inherit credential-named env vars (*_TOKEN, *_KEY, ...) like a user-opened
// shell does; exec, supervised, bot-worker and fan-out panes stay gated.
// Only the choice is stored here, never an env value.
import fs from 'node:fs';
import path from 'node:path';
import { getWmuxHomeDir } from '../../shared/constants';

export interface CredentialEnvPrefs {
  withholdFromAgents: boolean;
}

export interface CredentialEnvPrefsStore {
  load(): CredentialEnvPrefs;
  save(p: CredentialEnvPrefs): void;
}

const DEFAULTS: CredentialEnvPrefs = { withholdFromAgents: true };

/** File-backed prefs; a missing or broken file means the default (on). */
export function credentialEnvFilePrefs(
  file: string,
  f: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync'> = fs,
): CredentialEnvPrefsStore {
  let cached: CredentialEnvPrefs | null = null;
  return {
    load() {
      if (cached) return cached;
      try {
        const j = JSON.parse(f.readFileSync(file, 'utf8')) as Partial<CredentialEnvPrefs>;
        cached = { withholdFromAgents: j.withholdFromAgents !== false };
      } catch {
        cached = { ...DEFAULTS };
      }
      return cached;
    },
    save(p) {
      f.mkdirSync(path.dirname(file), { recursive: true });
      f.writeFileSync(file, JSON.stringify({ withholdFromAgents: p.withholdFromAgents }, null, 2));
      cached = { withholdFromAgents: p.withholdFromAgents };
    },
  };
}

let store: CredentialEnvPrefsStore | null = null;

function getStore(): CredentialEnvPrefsStore {
  store ??= credentialEnvFilePrefs(path.join(getWmuxHomeDir(), 'credential-env.json'));
  return store;
}

/** Test seam: swap the backing store. */
export function setCredentialEnvPrefsStoreForTests(s: CredentialEnvPrefsStore | null): void {
  store = s;
}

/** Current setting; default true (withhold). Never throws. */
export function withholdCredentialsFromAgents(): boolean {
  try {
    return getStore().load().withholdFromAgents;
  } catch {
    return true;
  }
}

export function setWithholdCredentialsFromAgents(on: boolean): CredentialEnvPrefs {
  getStore().save({ withholdFromAgents: on });
  return getStore().load();
}
