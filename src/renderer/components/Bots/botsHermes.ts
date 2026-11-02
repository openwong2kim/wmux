// ─── Can a bot run on Hermes? (the bot profile's Engine line) ──────────────
//
// A bot on Hermes Agent runs through wmux's own Hermes home, so the profile
// asks main whether Hermes can run here — without a model turn
// (IPC.FACTORY_HERMES_READINESS, preload `factory.factoryHermesReadiness`) —
// while the bot is on Hermes or the owner is about to switch it there, and
// offers the one step that fixes the reason it cannot. The engine itself is
// changed through its own verb (`factory.setBotEngine`): the generic update
// refuses an engine change to ACP. A build whose preload lacks a verb shows
// the line without that part.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HERMES_MCP_FIX_COMMAND,
  HERMES_VERSION_MIN,
  myHermesProfileLabel,
  type HermesNotReadyReason,
  type HermesReadiness,
  type MyHermesNotice,
  type MyHermesNotReadyReason,
  type MyHermesProfile,
  type MyHermesReadiness,
  type MyHermesStatus,
} from '../../../shared/hermesEngine';
import { HERMES_PROFILE_RE, MY_HERMES_DEFAULT_PROFILE } from '../../../shared/bot';

/** The engines the profile's picker switches between: Claude, wmux's
 *  Hermes, or My Hermes (the owner's own Hermes profile). */
export type PickableEngine = 'claude-sdk' | 'hermes' | 'my-hermes';

/** One picker choice: My Hermes carries its profile. */
export interface EnginePick { engine: PickableEngine; profile?: string }

/** The picker option's value for a choice ("my-hermes:<profile>"). Pure. */
export function engineOptionValue(pick: EnginePick): string {
  return pick.engine === 'my-hermes' ? `my-hermes:${pick.profile ?? MY_HERMES_DEFAULT_PROFILE}` : pick.engine;
}

/** The choice an option value names, or null. Pure. */
export function parseEngineOption(value: string): EnginePick | null {
  if (value === 'claude-sdk' || value === 'hermes') return { engine: value };
  const m = /^my-hermes:(.+)$/.exec(value);
  return m && HERMES_PROFILE_RE.test(m[1]) ? { engine: 'my-hermes', profile: m[1] } : null;
}

export interface HermesPort {
  /** Absent: this build cannot tell (the readiness row is not drawn).
   *  `fresh`: checked again in main, not its cached answer. */
  readiness?: (opts?: { fresh?: boolean }) => Promise<HermesReadiness>;
  /** Absent: no setup here. Opens Hermes's own model setup for wmux's Hermes
   *  home in a terminal tab; rejects with a plain message when none opens. */
  setup?: () => Promise<void>;
  /** Absent: the engine shows read-only. `profile`: My Hermes's. */
  setEngine?: (botId: string, engine: PickableEngine, profile?: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** Absent: no My Hermes option. The owner's Hermes profiles, and with
   *  `profile` whether it could serve a bot (read-only in main). */
  myHermes?: (req?: { profile?: string; fresh?: boolean }) => Promise<MyHermesStatus>;
}

interface HermesBridge {
  factoryHermesReadiness?: (opts?: { fresh?: boolean }) => Promise<unknown>;
  factoryHermesSetup?: () => Promise<void>;
  setBotEngine?: (botId: string, engine: PickableEngine, profile?: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  factoryMyHermes?: (req?: { profile?: string; fresh?: boolean }) => Promise<unknown>;
}

const REASONS: ReadonlySet<string> = new Set<HermesNotReadyReason>(['not-installed', 'outdated', 'unsupported', 'not-set-up', 'mcp-missing', 'config-mismatch', 'unknown']);

function shortText(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : undefined;
}

/** main's answer, checked (anything unreadable is "unknown"). Pure. */
export function readHermesReadiness(raw: unknown): HermesReadiness {
  if (!raw || typeof raw !== 'object') return { ready: false, reason: 'unknown' };
  const r = raw as Record<string, unknown>;
  const version = shortText(r.version, 40);
  if (r.ready === true) return { ready: true, ...(version ? { version } : {}) };
  const reason = typeof r.reason === 'string' && REASONS.has(r.reason) ? (r.reason as HermesNotReadyReason) : 'unknown';
  const message = shortText(r.message, 300);
  return { ready: false, reason, ...(version ? { version } : {}), ...(message ? { message } : {}) };
}

/** The preload's Hermes verbs, when this build has them. */
export function bridgeHermesPort(): HermesPort {
  const api = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI;
  const f = api?.factory && typeof api.factory === 'object' ? (api.factory as HermesBridge) : null;
  if (!f) return {};
  const readiness = f.factoryHermesReadiness;
  const setup = f.factoryHermesSetup;
  const setEngine = f.setBotEngine;
  const myHermes = f.factoryMyHermes;
  return {
    ...(readiness ? { readiness: async (opts?: { fresh?: boolean }) => readHermesReadiness(await readiness(opts)) } : {}),
    ...(setup ? { setup: () => setup() } : {}),
    ...(setEngine ? { setEngine: (botId: string, engine: PickableEngine, profile?: string) => (profile === undefined ? setEngine(botId, engine) : setEngine(botId, engine, profile)) } : {}),
    ...(myHermes ? { myHermes: async (req?: { profile?: string; fresh?: boolean }) => readMyHermesStatus(await myHermes(req)) } : {}),
  };
}

const MY_REASONS: ReadonlySet<string> = new Set<MyHermesNotReadyReason>([
  'unsupported-os', 'not-installed', 'foreign-install', 'outdated', 'unsupported', 'profile-missing',
  'acp-missing', 'no-model', 'approvals-off', 'wmux-mcp', 'messengers', 'gateway-messengers', 'unknown',
]);

const shortList = (raw: unknown, max: number): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.slice(0, 60)).slice(0, max) : [];

function readNotice(raw: unknown): MyHermesNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'approvals-smart') return { kind: 'approvals-smart' };
  if (r.kind === 'allowlist' && typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0) return { kind: 'allowlist', count: Math.floor(r.count) };
  if (r.kind === 'mcp-servers') {
    const names = shortList(r.names, 20);
    return names.length > 0 ? { kind: 'mcp-servers', names } : null;
  }
  return null;
}

/** main's My Hermes readiness, checked. Pure. */
export function readMyHermesReadiness(raw: unknown): MyHermesReadiness {
  if (!raw || typeof raw !== 'object') return { ready: false, reason: 'unknown', notices: [] };
  const r = raw as Record<string, unknown>;
  const version = shortText(r.version, 40);
  const notices = Array.isArray(r.notices) ? r.notices.map(readNotice).filter((n): n is MyHermesNotice => n !== null).slice(0, 5) : [];
  if (r.ready === true) return { ready: true, ...(version ? { version } : {}), notices };
  const reason = typeof r.reason === 'string' && MY_REASONS.has(r.reason) ? (r.reason as MyHermesNotReadyReason) : 'unknown';
  const message = shortText(r.message, 300);
  const platforms = shortList(r.platforms, 8);
  return { ready: false, reason, ...(version ? { version } : {}), ...(message ? { message } : {}), ...(platforms.length > 0 ? { platforms } : {}), notices };
}

/** main's My Hermes answer, checked. Pure. */
export function readMyHermesStatus(raw: unknown): MyHermesStatus {
  if (!raw || typeof raw !== 'object') return { supported: false, profiles: [] };
  const r = raw as Record<string, unknown>;
  const profiles: MyHermesProfile[] = [];
  for (const p of Array.isArray(r.profiles) ? r.profiles.slice(0, 50) : []) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q.name !== 'string' || !HERMES_PROFILE_RE.test(q.name)) continue;
    const dir = shortText(q.dir, 200) ?? q.name;
    const u = q.usedBy && typeof q.usedBy === 'object' ? (q.usedBy as Record<string, unknown>) : null;
    const usedBy = u && typeof u.botId === 'string' && typeof u.name === 'string' ? { botId: u.botId, name: u.name.slice(0, 80) } : undefined;
    profiles.push({ name: q.name, dir, ...(usedBy ? { usedBy } : {}) });
  }
  return {
    supported: r.supported === true,
    profiles,
    ...(r.readiness !== undefined ? { readiness: readMyHermesReadiness(r.readiness) } : {}),
  };
}

/** What the My Hermes readiness row says: its line, and a command to copy. */
export function myHermesReadinessView(r: MyHermesReadiness, profile = MY_HERMES_DEFAULT_PROFILE): { key: string; vars: Record<string, string>; command?: string } {
  const version = r.version ?? '—';
  if (r.ready) return { key: 'botsPage.myHermes.ready', vars: { version } };
  switch (r.reason) {
    case 'unsupported-os': return { key: 'botsPage.myHermes.unsupportedOs', vars: {} };
    case 'not-installed': return { key: 'botsPage.myHermes.notInstalled', vars: {} };
    case 'foreign-install': return { key: 'botsPage.myHermes.foreignInstall', vars: {} };
    case 'outdated': return { key: 'botsPage.myHermes.outdated', vars: { version, min: HERMES_VERSION_MIN } };
    case 'unsupported': return { key: 'botsPage.hermes.unsupported', vars: { version, tested: TESTED_LINE } };
    case 'profile-missing': return { key: 'botsPage.myHermes.profileMissing', vars: {} };
    case 'acp-missing': return { key: 'botsPage.myHermes.acpMissing', vars: {} };
    case 'no-model': return { key: 'botsPage.myHermes.noModel', vars: {}, command: profile === MY_HERMES_DEFAULT_PROFILE ? 'hermes model' : `hermes -p ${profile} model` };
    case 'approvals-off': return { key: 'botsPage.myHermes.approvalsOff', vars: {} };
    case 'wmux-mcp': return { key: 'botsPage.myHermes.wmuxMcp', vars: { file: `${myHermesProfileLabel(profile)}/config.yaml` } };
    case 'messengers': return { key: 'botsPage.myHermes.messengers', vars: { platforms: (r.platforms ?? []).join(', ') || '—' } };
    case 'gateway-messengers': return { key: 'botsPage.myHermes.gatewayMessengers', vars: { platforms: (r.platforms ?? []).join(', ') || '—' } };
    default: return { key: 'botsPage.myHermes.unknown', vars: {} };
  }
}

/** The owner's Hermes profiles (asked once while `active`), and the
 *  readiness of `profile` (null: none asked). Asked again when the window
 *  comes back and on Check again; never polled (each answer runs Hermes). */
export function useMyHermes(ask: HermesPort['myHermes'], active: boolean, profile: string | null): {
  status: MyHermesStatus | null;
  readiness: MyHermesReadiness | null;
  checking: boolean;
  recheck: () => void;
} {
  const [status, setStatus] = useState<MyHermesStatus | null>(null);
  const [readiness, setReadiness] = useState<MyHermesReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const run = useCallback((fresh: boolean) => {
    if (!ask) return;
    const mine = ++seq.current;
    if (profile !== null) setChecking(true);
    ask(profile !== null ? { profile, ...(fresh ? { fresh: true } : {}) } : undefined).then(
      (r) => {
        if (mine !== seq.current) return;
        setStatus(r);
        setReadiness(profile !== null ? r.readiness ?? null : null);
      },
      () => { if (mine === seq.current && profile !== null) setReadiness({ ready: false, reason: 'unknown', notices: [] }); },
    ).finally(() => { if (mine === seq.current) setChecking(false); });
  }, [ask, profile]);
  const recheck = useCallback(() => run(true), [run]);
  useEffect(() => {
    if (!active) return undefined;
    setReadiness(null);
    run(false);
    const onFocus = () => run(false);
    window.addEventListener('focus', onFocus);
    return () => {
      seq.current += 1;
      setChecking(false);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, run]);
  return { status, readiness, checking, recheck };
}

/** The one step a readiness answer offers: open the Hermes page, start the
 *  setup, or ask again once the owner ran a command. */
export type HermesFix = 'install' | 'setup' | 'recheck';

export interface HermesReadinessView {
  /** The line's i18n key and its values. */
  key: string;
  vars: Record<string, string>;
  fix?: HermesFix;
  /** A command the owner runs, shown as code with Copy. */
  command?: string;
  /** Raw detail behind a toggle. */
  detail?: string;
}

/** "0.22.x": the release line wmux was tested with. */
const TESTED_LINE = `${HERMES_VERSION_MIN.split('.').slice(0, 2).join('.')}.x`;

/** What the readiness row says for an answer, and its one fix. Pure. */
export function hermesReadinessView(r: HermesReadiness): HermesReadinessView {
  const version = r.version ?? '—';
  if (r.ready) return r.version ? { key: 'botsPage.hermes.ready', vars: { version: r.version } } : { key: 'botsPage.hermes.readyNoVersion', vars: {} };
  switch (r.reason) {
    case 'not-installed': return { key: 'botsPage.hermes.notInstalled', vars: {}, fix: 'install' };
    case 'outdated': return { key: 'botsPage.hermes.outdated', vars: { version, min: HERMES_VERSION_MIN }, fix: 'recheck' };
    case 'unsupported': return { key: 'botsPage.hermes.unsupported', vars: { version, tested: TESTED_LINE }, fix: 'recheck' };
    case 'not-set-up': return { key: 'botsPage.hermes.notSetUp', vars: {}, fix: 'setup' };
    case 'mcp-missing': return { key: 'botsPage.hermes.mcpMissing', vars: {}, fix: 'recheck', command: HERMES_MCP_FIX_COMMAND };
    case 'config-mismatch': return { key: 'botsPage.hermes.configMismatch', vars: {}, fix: 'recheck' };
    default: return { key: 'botsPage.hermes.unknown', vars: {}, fix: 'recheck', ...(r.message ? { detail: r.message } : {}) };
  }
}

/** How often the profile asks again while Hermes is not ready (the fix
 *  happens outside the app). */
const POLL_MS = 4_000;

/** Hermes's readiness while `active`: asked when it turns on, when the window
 *  comes back, and every few seconds until ready. null: not answered yet (or
 *  this build cannot tell). */
export function useHermesReadiness(ask: HermesPort['readiness'], active: boolean): {
  readiness: HermesReadiness | null;
  checking: boolean;
  recheck: () => void;
} {
  const [readiness, setReadiness] = useState<HermesReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const run = useCallback((shown: boolean) => {
    if (!ask) return;
    const mine = ++seq.current;
    if (shown) setChecking(true);
    // The owner's Check again is answered afresh; the polling may be cached.
    ask(shown ? { fresh: true } : undefined).then(
      (r) => { if (mine === seq.current) setReadiness(r); },
      () => { if (mine === seq.current) setReadiness({ ready: false, reason: 'unknown' }); },
    ).finally(() => { if (mine === seq.current) setChecking(false); });
  }, [ask]);
  const recheck = useCallback(() => run(true), [run]);
  useEffect(() => {
    if (!active) return undefined;
    run(false);
    const onFocus = () => run(false);
    window.addEventListener('focus', onFocus);
    return () => {
      seq.current += 1;
      setChecking(false);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, run]);
  const ready = readiness?.ready === true;
  useEffect(() => {
    if (!active || ready || !ask) return undefined;
    const timer = window.setInterval(() => run(false), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, ready, ask, run]);
  return { readiness, checking, recheck };
}
