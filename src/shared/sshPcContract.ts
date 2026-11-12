/**
 * Shared contract for "Add PC over SSH".
 *
 * Three tracks build against this file in parallel:
 *  - daemon  — retention marker, headless account resolution, the
 *              workspace-create grant, `wmux web pair`, `/api/config`
 *              capabilities, `wmux daemon status --json`;
 *  - release — the `wmux-server` artifact, its manifest, and the manifest
 *              baked into the desktop app;
 *  - desktop — the SSH tunnel supervisor, bootstrap/install over SSH, and the
 *              "Add PC over SSH" dialog.
 *
 * Change a shape here only with every track's consent. Every field below is
 * additive to existing wire formats (protocolVersion.ts additive-field rule):
 * an older peer omits it and the newer side must degrade, not guess.
 */

// ─── Capabilities (/api/config `capabilities: string[]`) ────────────────────

/**
 * Feature gates advertised by a host in `/api/config`. Compatibility is
 * checked per capability, not via PHONE_PROTOCOL_VERSION, because additive
 * changes never bump that number. An absent `capabilities` field means none.
 */
export const HOST_CAPABILITIES = {
  /** Sessions created through the web API carry REMOTE_DURABLE_MARKER and
   * survive the detached-idle reap for REMOTE_DURABLE_TTL_HOURS. */
  durableRemoteSessions: 'durable-remote-sessions',
  /** A device holding the `canCreateWorkspace` grant may spawn into a new
   * workspace id, and headless hosts resolve the account env without a desktop. */
  workspaceCreateGrant: 'workspace-create-grant',
  /** `wmux web pair --json` exists on this host's CLI. */
  webPairCli: 'web-pair-cli',
} as const;

export type HostCapability = typeof HOST_CAPABILITIES[keyof typeof HOST_CAPABILITIES];

// ─── Session retention ──────────────────────────────────────────────────────

/**
 * Persisted session-meta field set on sessions created through the web API
 * (POST /api/sessions). The detached-idle sweep and the StateWriter load path
 * both honour it. Bounded on purpose: an unbounded exemption lets abandoned
 * remote shells pile up forever.
 */
export const REMOTE_DURABLE_MARKER = 'remoteDurable' as const;
/** Same horizon as `suspendedTtlHours` — a week of silence, then reaped. */
export const REMOTE_DURABLE_TTL_HOURS = 7 * 24;

// ─── Device grant ───────────────────────────────────────────────────────────

/**
 * DeviceStore record field. Minted only for `kind: 'desktop'` devices paired
 * through `wmux web pair --kind desktop`; phones never receive it. Revoking the
 * device revokes the grant.
 */
export const DEVICE_GRANT_CREATE_WORKSPACE = 'canCreateWorkspace' as const;

// ─── Host CLI JSON (read over SSH stdout) ───────────────────────────────────

/**
 * `wmux web pair --name <laptop> --kind desktop --json`.
 * Calls the daemon's pairStart and prints ONLY this object. The desktop never
 * parses `wmux web --status --json`, which carries the operator token with
 * --show-token.
 * Never restarts the web server and never changes its flags (a transport
 * change revokes every paired device on the host).
 */
export interface WebPairCliResult {
  code: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Loopback port the running web server listens on. */
  port: number;
  allowInput: boolean;
}

/** `wmux daemon status --json` — fields the desktop bootstrap reads. */
export interface DaemonStatusJson {
  running: boolean;
  /** Release version of the daemon actually running (not 'unknown'). */
  version?: string;
  spawnedByVersion?: string;
  /** Live (non-dead) PTY sessions. An upgrade restarts the daemon only at 0. */
  liveSessions?: number;
  web?: { running: boolean; port?: number; allowInput?: boolean };
}

// ─── Server artifact ────────────────────────────────────────────────────────

export type ServerArch = 'x64' | 'arm64';

/** Release asset name. Always fetched from a pinned tag, never `latest`. */
export function serverArtifactName(version: string, arch: ServerArch): string {
  return `wmux-server-${version}-linux-${arch}.tar.gz`;
}

export function serverArtifactUrl(version: string, arch: ServerArch): string {
  return `https://github.com/openwong2kim/wmux/releases/download/v${version}/${serverArtifactName(version, arch)}`;
}

/**
 * Baked into the desktop app at `resources/server-manifest.json` by the
 * release job (which builds the server artifacts BEFORE packaging the app).
 * The desktop passes the expected sha256 to the host over SSH, so integrity
 * does not depend on fetching a manifest from the same place as the tarball.
 */
export interface ServerArtifactManifest {
  version: string;
  /** Bundled Node version, e.g. "24.15.0". */
  node: string;
  /** Minimum glibc the artifact runs on; musl hosts are refused. */
  glibcMin: string;
  artifacts: Partial<Record<ServerArch, { name: string; sha256: string; size: number }>>;
}

export const SERVER_MANIFEST_RESOURCE = 'server-manifest.json';

// ─── Install layout on the host (under $HOME) ───────────────────────────────

/**
 * `~/.wmux/runtime/<ver>/` mirrors the packaged-app resources layout so the
 * CLI's relative lookups resolve unchanged:
 *   <ver>/node/bin/node
 *   <ver>/package.json                       (real version → spawnedByVersion)
 *   <ver>/resources/cli-bundle/index.js
 *   <ver>/resources/daemon-bundle/index.js
 * Install = extract to `<ver>.partial`, verify, rename to `<ver>`, then swap
 * the `current` symlink. A leftover `*.partial` is deleted on the next install.
 * Always invoked by absolute path: non-interactive ssh does not source the
 * user's shell rc files, so PATH is unreliable.
 */
export const RUNTIME_DIR = '.wmux/runtime';
export const RUNTIME_CURRENT_LINK = 'current';
export const RUNTIME_PARTIAL_SUFFIX = '.partial';
export const RUNTIME_NODE_REL = 'node/bin/node';
export const RUNTIME_CLI_REL = 'resources/cli-bundle/index.js';

// ─── Desktop host record ────────────────────────────────────────────────────

/**
 * Stored `RemoteHost.origin` for an SSH host. Deliberately NOT http(s): an
 * older app that predates SSH hosts sees an origin it rejects as insecure and
 * never sends the bearer to whatever owns a loopback port.
 */
export const SSH_ORIGIN_SCHEME = 'wmux-ssh:';
export function sshHostOrigin(hostId: string): string {
  return `${SSH_ORIGIN_SCHEME}//${hostId}`;
}

/** Added to RemoteHost as `ssh?: SshHostBinding`. */
export interface SshHostBinding {
  /** ssh_config alias or `user@host` as the user typed it. Never starts with '-'. */
  alias: string;
  /** From `ssh -G <alias>` at add time; a change requires re-confirmation. */
  resolvedHost: string;
  /** SHA256 host-key fingerprint seen at add time. */
  hostKeyFingerprint: string;
  /** Remote loopback port of `wmux web`. */
  remotePort: number;
  /**
   * Local end of the forward. macOS/Linux use a unix socket in a 0700 dir
   * (its appearance is the readiness signal); Windows uses a pinned TCP port.
   */
  localEndpoint: { socketPath: string } | { port: number };
}
