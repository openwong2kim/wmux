// === wmux Plugin Host types (B-1) ===
//
// UI plugins are static bundles under `~/.fmux/plugins/<name>/` described by
// a `manifest.json`. Their UI runs in a sandboxed iframe (allow-scripts only,
// opaque origin) served over the `fmux-plugin://` protocol; all host
// interaction goes through the postMessage bridge envelope below, which maps
// 1:1 onto the existing RPC method space so the Phase 2.2 permission stack
// (PluginTrustStore / PermissionEnforcer / methodCapabilityMap) applies
// verbatim — the iframe bridge is just another transport in front of the
// same enforcement.
//
// The envelope and manifest shapes are FROZEN (v1) — see
// docs/internal/fable-window-schema-freeze.md §4. Changes are additive-only;
// consumers ignore unknown fields and unknown envelope kinds.

import type { WmuxEvent } from './events';

export const PLUGIN_BRIDGE_VERSION = 1 as const;

/** Protocol scheme serving plugin bundle files to sandboxed iframes. */
export const PLUGIN_PROTOCOL_SCHEME = 'fmux-plugin';

/**
 * Plugin directory names double as the identity key in plugin-trust.json
 * and as the host segment of `fmux-plugin://<name>/...` URLs, so the
 * charset is restricted to what is safe in both.
 */
export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// === Bridge envelope (host ⇄ plugin iframe, over a dedicated MessagePort) ===

export interface BridgeRequest {
  v: typeof PLUGIN_BRIDGE_VERSION;
  id: string;
  kind: 'request';
  /** RPC method name — same method space as the pipe RPC surface. */
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  v: typeof PLUGIN_BRIDGE_VERSION;
  id: string;
  kind: 'response';
  result?: unknown;
  error?: { code: string; message: string };
}

export interface BridgeEvent {
  v: typeof PLUGIN_BRIDGE_VERSION;
  id: null;
  kind: 'event';
  event: WmuxEvent;
}

/**
 * Host→plugin command invocation (additive v1 extension, schema-freeze
 * rule 1): fired when the user runs one of the plugin's contributed
 * palette commands. `command` is the manifest `contributes.commands[].id`.
 */
export interface BridgeCommand {
  v: typeof PLUGIN_BRIDGE_VERSION;
  id: null;
  kind: 'command';
  command: string;
}

export type BridgeEnvelope = BridgeRequest | BridgeResponse | BridgeEvent | BridgeCommand;

/**
 * Validate an inbound message from a plugin iframe. Hostile iframes can
 * post anything; everything that doesn't match the frozen request shape is
 * dropped (never throws). Only `request` envelopes are accepted inbound —
 * `response`/`event` flow host→plugin exclusively.
 */
export function parseBridgeRequest(raw: unknown): BridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== PLUGIN_BRIDGE_VERSION) return null;
  if (m.kind !== 'request') return null;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 128) return null;
  if (typeof m.method !== 'string' || m.method.length === 0 || m.method.length > 128) return null;
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) {
    return null;
  }
  return {
    v: PLUGIN_BRIDGE_VERSION,
    id: m.id,
    kind: 'request',
    method: m.method,
    params: m.params as Record<string, unknown> | undefined,
  };
}

// === Manifest ===

export interface PluginSidebarContribution {
  /** Panel title shown in the sidebar section header. */
  title: string;
  /** Bundle-relative path to the panel's HTML entry. */
  entry: string;
}

export interface PluginStatusBarContribution {
  /** Bundle-relative path to the widget's HTML entry. */
  entry: string;
  /** Optional alignment hint; default 'right'. */
  alignment?: 'left' | 'right';
}

export interface PluginCommandContribution {
  /** Stable command id, palette-unique per plugin (`<plugin>:<id>`). */
  id: string;
  /** Palette display title. */
  title: string;
}

export interface PluginContributions {
  sidebar?: PluginSidebarContribution;
  statusbar?: PluginStatusBarContribution;
  /**
   * Declares intent to decorate panes (badges/overlays) via bridge RPCs.
   * Carries no entry — decorations are data pushed through the bridge,
   * rendered by the host, never plugin DOM inside a pane.
   */
  paneDecoration?: Record<string, never>;
  commands?: PluginCommandContribution[];
}

/** Frozen activation event grammar — see schema-freeze §4. */
export type PluginActivationEvent =
  | 'onStartup'
  | 'onWorkspace'
  | `onAgentDetected:${string}`
  | `onEvent:${string}`;

export interface PluginManifest {
  name: string;
  version: string;
  /** Human-readable description shown in approval prompts and settings. */
  description?: string;
  /**
   * Declared capabilities, `<capability>[:<path-glob>]` grammar — the same
   * strings `mcp.declarePermissions` accepts, including the ui.* additions.
   */
  capabilities: string[];
  activationEvents: PluginActivationEvent[];
  contributes: PluginContributions;
}

/** Map of contribution point → capability required to mount it. */
export const CONTRIBUTION_CAPABILITY = {
  sidebar: 'ui.sidebar',
  statusbar: 'ui.statusbar',
  paneDecoration: 'ui.pane-decoration',
  commands: 'ui.commands',
} as const;

export type PluginManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const MAX_TITLE_LEN = 64;
const MAX_ENTRY_LEN = 256;
const MAX_CAPABILITIES = 64;
const MAX_ACTIVATION_EVENTS = 32;
const MAX_COMMANDS = 64;

/**
 * Bundle-relative entry paths become `fmux-plugin://<name>/<entry>` URLs.
 * Reject anything that could escape the bundle dir or smuggle a scheme;
 * the protocol handler re-validates with a realpath containment check —
 * this is the first of two gates, not the only one.
 */
function isSafeEntryPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_ENTRY_LEN) return false;
  if (p.includes('\\') || p.includes('..') || p.includes(':')) return false;
  if (p.startsWith('/') || p.includes('\0')) return false;
  return true;
}

const ACTIVATION_EVENT_REGEX = /^(onStartup|onWorkspace|onAgentDetected:[a-z0-9_-]{1,32}|onEvent:[a-z0-9.]{1,64})$/;

/**
 * Pure manifest validation — no filesystem access, so it is unit-testable
 * and reusable by a future `wmux plugin validate` CLI. Capability-string
 * grammar validation (known capability, glob syntax) happens separately in
 * the loader via `parsePermissionList`; this only checks structure.
 */
export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.name !== 'string' || !PLUGIN_NAME_REGEX.test(m.name)) {
    errors.push(`name must match ${PLUGIN_NAME_REGEX} (lowercase, 1-64 chars)`);
  }
  if (typeof m.version !== 'string' || m.version.trim().length === 0 || m.version.length > 32) {
    errors.push('version must be a non-empty string (≤32 chars)');
  }
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 512)) {
    errors.push('description must be a string (≤512 chars)');
  }

  if (!Array.isArray(m.capabilities) || m.capabilities.length > MAX_CAPABILITIES) {
    errors.push(`capabilities must be an array (≤${MAX_CAPABILITIES})`);
  } else if (m.capabilities.some((c) => typeof c !== 'string' || c.length === 0 || c.length > 128)) {
    errors.push('every capability must be a non-empty string (≤128 chars)');
  }

  if (!Array.isArray(m.activationEvents) || m.activationEvents.length > MAX_ACTIVATION_EVENTS) {
    errors.push(`activationEvents must be an array (≤${MAX_ACTIVATION_EVENTS})`);
  } else {
    for (const ev of m.activationEvents) {
      if (typeof ev !== 'string' || !ACTIVATION_EVENT_REGEX.test(ev)) {
        errors.push(`invalid activation event: ${JSON.stringify(ev)}`);
      }
    }
  }

  const contributes: PluginContributions = {};
  if (m.contributes !== undefined) {
    if (!m.contributes || typeof m.contributes !== 'object' || Array.isArray(m.contributes)) {
      errors.push('contributes must be an object');
    } else {
      const c = m.contributes as Record<string, unknown>;
      if (c.sidebar !== undefined) {
        const s = c.sidebar as Record<string, unknown> | null;
        if (!s || typeof s !== 'object'
          || typeof s.title !== 'string' || s.title.trim().length === 0 || s.title.length > MAX_TITLE_LEN
          || !isSafeEntryPath(s.entry)) {
          errors.push('contributes.sidebar requires { title (≤64 chars), entry (safe bundle-relative path) }');
        } else {
          contributes.sidebar = { title: s.title.trim(), entry: s.entry as string };
        }
      }
      if (c.statusbar !== undefined) {
        const s = c.statusbar as Record<string, unknown> | null;
        if (!s || typeof s !== 'object' || !isSafeEntryPath(s.entry)
          || (s.alignment !== undefined && s.alignment !== 'left' && s.alignment !== 'right')) {
          errors.push('contributes.statusbar requires { entry (safe bundle-relative path), alignment? (left|right) }');
        } else {
          contributes.statusbar = {
            entry: s.entry as string,
            ...(s.alignment ? { alignment: s.alignment as 'left' | 'right' } : {}),
          };
        }
      }
      if (c.paneDecoration !== undefined) {
        if (!c.paneDecoration || typeof c.paneDecoration !== 'object' || Array.isArray(c.paneDecoration)) {
          errors.push('contributes.paneDecoration must be an object (declaration-only, no fields)');
        } else {
          contributes.paneDecoration = {};
        }
      }
      if (c.commands !== undefined) {
        if (!Array.isArray(c.commands) || c.commands.length > MAX_COMMANDS) {
          errors.push(`contributes.commands must be an array (≤${MAX_COMMANDS})`);
        } else {
          const cmds: PluginCommandContribution[] = [];
          for (const cmd of c.commands) {
            const k = cmd as Record<string, unknown> | null;
            if (!k || typeof k !== 'object'
              || typeof k.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(k.id)
              || typeof k.title !== 'string' || k.title.trim().length === 0 || k.title.length > MAX_TITLE_LEN) {
              errors.push('every contributes.commands entry requires { id (lowercase slug), title (≤64 chars) }');
              break;
            }
            cmds.push({ id: k.id, title: k.title.trim() });
          }
          if (cmds.length === (c.commands as unknown[]).length) contributes.commands = cmds;
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name: m.name as string,
      version: (m.version as string).trim(),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      capabilities: (m.capabilities as string[]).slice(),
      activationEvents: (m.activationEvents as PluginActivationEvent[]).slice(),
      contributes,
    },
  };
}

/**
 * Capability (bare, no glob) required for each contribution the manifest
 * declares. The loader cross-checks these against `capabilities` so a
 * manifest can't contribute UI it never declared, and the renderer host
 * re-checks trust status before mounting.
 */
export function requiredUiCapabilities(contributes: PluginContributions): string[] {
  const caps: string[] = [];
  if (contributes.sidebar) caps.push(CONTRIBUTION_CAPABILITY.sidebar);
  if (contributes.statusbar) caps.push(CONTRIBUTION_CAPABILITY.statusbar);
  if (contributes.paneDecoration) caps.push(CONTRIBUTION_CAPABILITY.paneDecoration);
  if (contributes.commands && contributes.commands.length > 0) caps.push(CONTRIBUTION_CAPABILITY.commands);
  return caps;
}

// === Renderer-facing summary ===

/**
 * What the renderer (and the `plugins:list` IPC) sees per plugin. Trust
 * status rides along so UI hosts can gate mounting: only `trusted` plugins
 * get an iframe; `unconfirmed` render an approval placeholder.
 */
export interface PluginHostPluginSummary {
  name: string;
  version: string;
  description?: string;
  capabilities: string[];
  activationEvents: PluginActivationEvent[];
  contributes: PluginContributions;
  trustStatus: 'unconfirmed' | 'trusted' | 'denied' | 'legacy';
}
