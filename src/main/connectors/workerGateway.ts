// ─── Signed-in connections for a bot's workers: main-owned gateway leases ───
//
// A connection the owner signed in to (main/connectors/connectorOAuth.ts: an
// OAuth record is stored for it) reaches a bot's worker only through a
// loopback gateway main runs for that one worker (createTerminalGateway, the
// owner terminals' gateway): the worker's MCP config names
// `http://127.0.0.1:<port>/mcp` and a per-lease bearer, and main adds the
// vendor token to each upstream request itself. The vendor token never leaves
// main: not the worker's env, arguments, files or MCP config.
//
// What a worker gets, per connection of its task:
//  - the loopback URL, written into its `--mcp-config` (botWorkerMcp.ts);
//  - the lease bearer under CONNECTOR_<ID>_TOKEN in the daemon's spawn-only
//    `secretEnv` (pty.handler.ts), which the MCP config names as `${NAME}`.
//
// A lease is checked on every request (the gateway's `authorize` and its
// configuration snapshot): the connection is unchanged, still this bot's,
// its sign-in revision is the one the lease started on, the task is open
// and the bot may run. Its upstream token comes from a non-interactive
// refresh only: a worker never starts a sign-in, and the gateway never
// answers 401, so the worker's own client never looks for one.
//
// Life: opened at the worker pane's create, bound to its daemon session;
// closed when that session dies or is destroyed, the daemon disconnects, the
// task ends, the create rolls back, no tools/list arrived within
// FIRST_LIST_MS, or LEASE_TTL_MS passed; and when the connection changes or
// its sign-in is replaced or removed. The leases live in main's memory only:
// a restart of main ends them all (the worker's calls then fail closed). A
// sign-in replaced or removed, a restart and the lease cap each tell the
// task's bot (`worker.connection_lost` notice): resume the worker after
// signing in again. A worker pane is never given a new lease in place (a
// running shell cannot take a new env): its task is resumed in a new pane.
//
// Remaining exposure, accepted with this design: the bearer sits in the
// worker pane's environment for that pane's life, where other processes of
// the same user can read it (as with the owner terminals' gateway). It only
// reaches the gateway on loopback, for the connection's listed tools, while
// the lease lives. Commands the worker runs get no bearer and no network
// (the OS sandbox block, botWorkerMcp.ts buildWorkerSettings).

import path from 'node:path';
import type { Connector } from '../../shared/botConnector';
import type { LedgerEntry } from '../../shared/ledger';
import { botSandboxSettings } from '../factory/botExecSandbox';
import { isSignInService } from '../../shared/connectorServices';
import type { ConnectorCheckResult } from '../../shared/connectorCheck';
import { taskThreadOf } from '../../shared/room';
import type { BotNoticeInput } from '../factory/botNotices';
import { createTerminalGateway } from './terminalGateway';
import type { ConnectorOAuth } from './connectorOAuth';
import { setRedactedConnectorLeases } from '../factory/secretRedaction';

export const WORKER_GATEWAY_LIMITS = {
  /** Leases open at once: the factory's worker cap (3) times the most
   *  connections one task carries (8). A lease not yet bound to a session
   *  holds its slot too, until it is bound or FIRST_LIST_MS closes it. */
  LEASES_MAX: 24,
  /** A lease no tools/list reached within this long is closed: a worker's
   *  claude reads its tools at start, and a cold start (first-run checks, a
   *  slow disk) can take more than the terminal path's two minutes. */
  FIRST_LIST_MS: 10 * 60_000,
  /** The longest a lease lives, used or not. */
  LEASE_TTL_MS: 6 * 3_600_000,
  /** A closed lease's bearer stays redacted this long (it may still sit in a
   *  pane's env or scrollback), and at most this many of them. */
  RETIRED_KEEP_MS: 24 * 3_600_000,
  RETIRED_MAX: 64,
} as const;

/** The env name a lease bearer travels under: credential-shaped
 *  (isBotSecretName), so every env strip that removes credentials removes it.
 *  Pure. */
export function workerGatewayEnvName(connectorId: string): string {
  return `CONNECTOR_${connectorId.replace(/^con-/, '').toUpperCase()}_TOKEN`;
}

export type GatewayOAuth = Pick<ConnectorOAuth, 'hasRecord' | 'accessToken' | 'revision' | 'awaitingConsent' | 'onRevision'>;

/** Why a lease was closed. Only the ones the bot should hear of post a notice. */
export type GatewayCloseReason = 'session' | 'task' | 'rollback' | 'unused' | 'daemon' | 'expired' | 'signed_out' | 'changed' | 'disposed';

const NOTICE_REASONS: ReadonlySet<GatewayCloseReason> = new Set(['expired', 'signed_out', 'changed']);

// The sign-in service test lives in shared/connectorServices.ts, so the
// profile's recipe checklist reads connections exactly as this gateway does.
export { isSignInService };

/** Which of a bot task's connections go through the gateway: the HTTP ones
 *  with a stored sign-in. A connection whose sign-in cannot be read now, and
 *  a catalog sign-in service with no sign-in, are refusals (neither is ever
 *  sent without one). Pure but for the OAuth reads. */
export function gatewayConnectorsOf(connectors: readonly Connector[], oauth: Pick<GatewayOAuth, 'hasRecord'> | null): { gateway: Connector[] } | { refusal: string } {
  const gateway: Connector[] = [];
  for (const c of connectors) {
    if (c.transport !== 'http') continue;
    const rec = oauth ? oauth.hasRecord(c.id) : (isSignInService(c) ? 'unknown' : false);
    if (rec === 'unknown') return { refusal: `the sign-in of ${c.name} cannot be read now (the system keychain is locked or unavailable); try again later` };
    if (rec) gateway.push(c);
    else if (isSignInService(c)) return { refusal: `${c.name} is not signed in: ask the owner to sign in to it in Plugins › Connectors` };
  }
  return { gateway };
}

/** Why a bot task may not take these signed-in connections, from what the
 *  request says, or null: macOS and Linux only; every connection of the task
 *  a signed-in one (another would run outside the sandbox); a wake, and a
 *  conversation, that took in no outside text (until each call is approved,
 *  the tools cannot be told apart by what they do); the research preset
 *  only; each connection's tools picked by the owner. Pure. */
export function gatewayShapeRefusal(input: {
  connectors: readonly Connector[];
  /** Every connection the task names. */
  all: readonly Connector[];
  platform: NodeJS.Platform;
  preset: string | undefined;
  wakeTainted: boolean;
  conversationTainted: boolean;
}): string | null {
  if (input.connectors.length === 0) return null;
  if (input.platform === 'win32') return 'signed-in connections do not reach workers on Windows yet; start the task without them';
  const others = input.all.filter((c) => !input.connectors.some((g) => g.id === c.id));
  if (others.length > 0) return `a task with a signed-in connection carries only signed-in connections; start ${others.map((c) => c.name).join(', ')} in a task of its own`;
  if (input.wakeTainted) return 'this turn started from outside text (or as a researcher), and such a turn cannot use a signed-in connection; ask the owner to start it from their own message';
  if (input.conversationTainted) return 'this conversation has taken in outside text, and a signed-in connection is used only from a conversation that has not; ask the owner to start it in a new conversation';
  if (input.preset !== 'research') return 'a task with a signed-in connection runs only with preset "research" (no repository, no push)';
  for (const c of input.connectors) {
    if (c.tools.mode !== 'listed' || c.tools.allowed.length === 0) {
      return `the owner has not picked the tools of ${c.name} yet: ask them to choose its tools in Plugins › Connectors`;
    }
  }
  return null;
}

export interface GatewayReadyInput {
  connectors: readonly Connector[];
  oauth: GatewayOAuth | null;
  /** Whether workers can run in the command sandbox (botExecSandbox.ts
   *  probeBotExecSupport). */
  sandbox: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The service's own tool list now, with the token (checkConnector.ts). */
  listTools: (c: Connector, headers: Record<string, string>) => Promise<ConnectorCheckResult>;
}

/** Why the signed-in connections cannot be used now, or null: each is
 *  signed in (a refresh when due, never a sign-in), every tool the owner
 *  picked is one the service marks read-only (a second layer: the owner's
 *  list stays what is served), and the command sandbox is available. */
export async function gatewayReadyRefusal(input: GatewayReadyInput): Promise<string | null> {
  if (input.connectors.length === 0) return null;
  if (!input.oauth) return 'signed-in connections are not running';
  for (const c of input.connectors) {
    if (input.oauth.awaitingConsent(c.id)) return `the sign-in of ${c.name} is waiting for the owner; ask them to finish it in Plugins › Connectors`;
    let token: string | undefined;
    try {
      token = await input.oauth.accessToken(c.id);
    } catch {
      token = undefined;
    }
    if (!token) return `${c.name} needs the owner to sign in again: ask them to sign in to it in Plugins › Connectors`;
    let listed: ConnectorCheckResult;
    try {
      listed = await input.listTools(c, { ...(c.remote?.headers ?? {}), Authorization: `Bearer ${token}` });
    } catch {
      listed = { status: 'failed' };
    }
    if (listed.status !== 'ready') return `the tools of ${c.name} could not be listed now (${listed.status}); try again later`;
    const readOnly = new Set(listed.readOnlyToolNames ?? []);
    const writes = c.tools.mode === 'listed' ? c.tools.allowed.filter((t) => !readOnly.has(t)) : ['(all tools)'];
    if (writes.length > 0) return `a signed-in connection gives workers read-only tools only, and ${c.name} does not mark these read-only: ${writes.join(', ')}; ask the owner to leave them out of its tools`;
  }
  let support: { ok: true } | { ok: false; reason: string };
  try {
    support = await input.sandbox();
  } catch (err) {
    support = { ok: false, reason: String(err) };
  }
  if (!support.ok) return `a task with a signed-in connection runs only in the command sandbox, which is not available here (${support.reason})`;
  return null;
}

export interface WorkerGatewayDeps {
  oauth: () => GatewayOAuth | null;
  /** The connection as the library holds it now. */
  connector: (id: string) => Connector | null;
  /** The connections that apply to the bot now (connectorsForBot). */
  forBot: (botId: string) => readonly Connector[];
  /** The task is still open (not completed, failed or cancelled). */
  taskOpen: (taskId: string) => boolean;
  /** The bot is enabled, not parked, and the bots are on. */
  botMayRun: (botId: string) => boolean;
  /** Tell the task's bot its worker lost a connection. */
  notice?: (n: { botId: string; taskId: string; connectorName: string; reason: GatewayCloseReason }) => void;
  platform?: NodeJS.Platform;
  gateway?: typeof createTerminalGateway;
  redact?: (entries: ReadonlyArray<{ name: string; value: string }>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  log?: (line: string) => void;
}

interface Lease {
  id: number;
  connectorId: string;
  connectorName: string;
  envName: string;
  token: string;
  botId: string;
  taskId: string;
  sessionId?: string;
  revision: number;
  closed: boolean;
  closeGateway: () => void;
  /** Closes the lease when no tools/list arrived in time (cleared by one). */
  firstList?: unknown;
  /** The absolute cap. */
  ttl?: unknown;
}

/** What a worker create gets for its task's signed-in connections. */
export interface WorkerGatewayOpen {
  /** Per connection name: its loopback URL and the env name of its bearer. */
  routes: Record<string, { url: string; envName: string }>;
  /** The bearers, for the create's `secretEnv` only. */
  env: Record<string, string>;
  /** The create minted its daemon session id: the leases are that pane's. */
  bind: (sessionId: string) => void;
  /** The create failed or rolled back. */
  close: () => void;
}

export class WorkerGatewayRegistry {
  private leases = new Map<number, Lease>();
  private retired: Array<{ name: string; value: string; at: number }> = [];
  private nextId = 1;
  private pending = 0;
  private offRevision: (() => void) | null = null;

  constructor(private deps: WorkerGatewayDeps) {}

  get size(): number {
    return this.leases.size;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  }

  private watchRevisions(): void {
    if (this.offRevision) return;
    const oauth = this.deps.oauth();
    if (!oauth) return;
    this.offRevision = oauth.onRevision((id) => this.closeConnector(id, 'signed_out'));
  }

  private publishRedaction(): void {
    const at = this.now();
    this.retired = this.retired.filter((r) => at - r.at < WORKER_GATEWAY_LIMITS.RETIRED_KEEP_MS).slice(-WORKER_GATEWAY_LIMITS.RETIRED_MAX);
    const live = [...this.leases.values()].map((l) => ({ name: l.envName, value: l.token }));
    (this.deps.redact ?? setRedactedConnectorLeases)([...live, ...this.retired.map(({ name, value }) => ({ name, value }))]);
  }

  /** Open one lease per connection for a worker create (all or none). */
  async open(input: { botId: string; taskId: string; connectors: readonly Connector[] }): Promise<WorkerGatewayOpen> {
    if ((this.deps.platform ?? process.platform) === 'win32') throw new Error('signed-in connections do not reach workers on Windows yet');
    if (input.connectors.length === 0) throw new Error('no signed-in connection to open');
    if (this.leases.size + this.pending + input.connectors.length > WORKER_GATEWAY_LIMITS.LEASES_MAX) {
      throw new Error(`too many signed-in connection leases are open (at most ${WORKER_GATEWAY_LIMITS.LEASES_MAX})`);
    }
    const oauth = this.deps.oauth();
    if (!oauth) throw new Error('signed-in connections are not running');
    this.watchRevisions();
    this.pending += input.connectors.length;
    const opened: Array<{ lease: Lease; url: string }> = [];
    try {
      for (const c of input.connectors) opened.push(await this.openOne(oauth, input.botId, input.taskId, c));
    } catch (err) {
      for (const o of opened) this.closeLease(o.lease, 'rollback');
      throw err;
    } finally {
      this.pending -= input.connectors.length;
    }
    this.publishRedaction();
    const routes: WorkerGatewayOpen['routes'] = {};
    const env: Record<string, string> = {};
    for (const { lease, url } of opened) {
      routes[lease.connectorName] = { url, envName: lease.envName };
      env[lease.envName] = lease.token;
    }
    return {
      routes,
      env,
      bind: (sessionId) => { for (const o of opened) if (!o.lease.closed) o.lease.sessionId = sessionId; },
      close: () => { for (const o of opened) this.closeLease(o.lease, 'rollback'); },
    };
  }

  private clear(handle: unknown): void {
    if (handle === undefined) return;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  private async openOne(oauth: GatewayOAuth, botId: string, taskId: string, c: Connector): Promise<{ lease: Lease; url: string }> {
    const snapshot = JSON.stringify(this.deps.connector(c.id));
    if (snapshot !== JSON.stringify(c)) throw new Error(`the connection ${c.name} changed since the task was accepted`);
    if (c.tools.mode !== 'listed' || c.tools.allowed.length === 0) throw new Error(`the tools of ${c.name} are not picked`);
    const revision = oauth.revision(c.id);
    const lease: Lease = {
      id: this.nextId++, connectorId: c.id, connectorName: c.name, envName: workerGatewayEnvName(c.id), token: '',
      botId, taskId, revision, closed: false, closeGateway: () => undefined,
    };
    const authorize = async (): Promise<void> => {
      if (lease.closed) throw new Error('Lease closed');
      if (!lease.sessionId) throw new Error('Lease not bound');
      if (JSON.stringify(this.deps.connector(c.id)) !== snapshot) throw new Error('Connection changed');
      if (!this.deps.forBot(botId).some((x) => x.id === c.id)) throw new Error('Connection not for this bot');
      if (!this.deps.taskOpen(taskId)) throw new Error('Task ended');
      if (!this.deps.botMayRun(botId)) throw new Error('Bot not running');
      if ((this.deps.oauth()?.revision(c.id) ?? -1) !== revision) throw new Error('Sign-in changed');
    };
    const headers = async (): Promise<Record<string, string>> => {
      const current = this.deps.oauth();
      if (!current || current.awaitingConsent(c.id)) throw new Error('Authorization pending');
      // A refresh only: a worker never starts a sign-in.
      const token = await current.accessToken(c.id);
      if (!token) throw new Error('Sign in required');
      return { ...(c.remote?.headers ?? {}), Authorization: `Bearer ${token}` };
    };
    // A sign-in that cannot be refreshed now is refused before anything starts.
    await headers();
    const gateway = await (this.deps.gateway ?? createTerminalGateway)({
      getConnector: () => this.deps.connector(c.id) ?? undefined,
      headers,
      authorizationRevision: () => this.deps.oauth()?.revision(c.id) ?? -1,
      authorize,
      ttlMs: WORKER_GATEWAY_LIMITS.LEASE_TTL_MS,
      clientName: 'wmux-bot-worker-connector',
      onListTools: () => {
        this.clear(lease.firstList);
        lease.firstList = undefined;
      },
    });
    lease.token = gateway.token;
    lease.closeGateway = gateway.close;
    this.leases.set(lease.id, lease);
    lease.firstList = this.timer(() => this.closeLease(lease, 'unused'), WORKER_GATEWAY_LIMITS.FIRST_LIST_MS);
    lease.ttl = this.timer(() => this.closeLease(lease, 'expired'), WORKER_GATEWAY_LIMITS.LEASE_TTL_MS);
    return { lease, url: gateway.url };
  }

  private closeLease(lease: Lease, reason: GatewayCloseReason): void {
    if (lease.closed) return;
    lease.closed = true;
    this.clear(lease.firstList);
    this.clear(lease.ttl);
    lease.firstList = undefined;
    lease.ttl = undefined;
    try { lease.closeGateway(); } catch { /* already closed */ }
    this.leases.delete(lease.id);
    if (lease.token) this.retired.push({ name: lease.envName, value: lease.token, at: this.now() });
    this.publishRedaction();
    if (NOTICE_REASONS.has(reason) && lease.sessionId) {
      try {
        this.deps.notice?.({ botId: lease.botId, taskId: lease.taskId, connectorName: lease.connectorName, reason });
      } catch (err) {
        this.log(`[connectors] worker gateway notice not posted: ${String(err)}`);
      }
    }
  }

  private closeWhere(pred: (l: Lease) => boolean, reason: GatewayCloseReason): number {
    let n = 0;
    for (const l of [...this.leases.values()]) {
      if (pred(l)) {
        this.closeLease(l, reason);
        n += 1;
      }
    }
    return n;
  }

  closeSession(sessionId: string): number {
    return this.closeWhere((l) => l.sessionId === sessionId, 'session');
  }

  closeTask(taskId: string): number {
    return this.closeWhere((l) => l.taskId === taskId, 'task');
  }

  closeConnector(connectorId: string, reason: GatewayCloseReason): number {
    return this.closeWhere((l) => l.connectorId === connectorId, reason);
  }

  /** The library changed: a lease whose connection is gone, edited, off or
   *  no longer its bot's is closed. */
  libraryChanged(): number {
    return this.closeWhere((l) => {
      const c = this.deps.connector(l.connectorId);
      if (!c || !c.enabled) return true;
      return !this.deps.forBot(l.botId).some((x) => x.id === l.connectorId);
    }, 'changed');
  }

  closeAll(reason: GatewayCloseReason): number {
    return this.closeWhere(() => true, reason);
  }

  dispose(): void {
    this.closeAll('disposed');
    this.offRevision?.();
    this.offRevision = null;
  }
}

// ── The worker's command sandbox ───────────────────────────────────────────

/** The files in a worker's folder claude reads as its own configuration. */
export const WORKER_FOLDER_CONFIG_NAMES: readonly string[] = ['.claude', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md'];

/** Claude's `sandbox` block for a worker with a signed-in connection: the
 *  bot command sandbox (botExecSandbox.ts: no network, no home folder, every
 *  variable but a harmless few unset for its commands, the bearers among
 *  them), writing and reading only in its task folder and its temp folder.
 *  `env` is a superset of the pane's variables (unsetting an absent name is
 *  harmless). */
export function workerGatewaySandbox(input: { cwd: string; tmpDir?: string; wmuxDir: string; env: Readonly<Record<string, string | undefined>> }): Record<string, unknown> {
  const base = botSandboxSettings({ botDir: input.cwd, wmuxDir: input.wmuxDir, env: input.env });
  const dirs = [path.resolve(input.cwd), ...(input.tmpDir && path.isAbsolute(input.tmpDir) ? [path.resolve(input.tmpDir)] : [])];
  // What claude reads from its folder (project settings, MCP servers,
  // memory) is never written by the worker's commands.
  const denyWrite = WORKER_FOLDER_CONFIG_NAMES.map((n) => path.join(dirs[0], n));
  return { ...base, filesystem: { ...(base.filesystem as Record<string, unknown>), allowWrite: dirs, allowRead: dirs, denyWrite } };
}

// ── Telling the bot ────────────────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Whether a ledger status ends a task. Pure. */
export function isTaskEnded(status: string | undefined): boolean {
  return status === undefined || TERMINAL_STATUSES.has(status);
}

const LOSS_WHY: Readonly<Record<string, string>> = {
  signed_out: 'its sign-in was replaced or removed',
  expired: `its lease reached its ${WORKER_GATEWAY_LIMITS.LEASE_TTL_MS / 3_600_000} hour limit`,
  changed: 'the owner changed it, turned it off or took it from this bot',
  restart: 'wmux restarted',
};

/** The notice that tells a task's bot its worker lost a signed-in
 *  connection, or null for a row that is not an open bot task. Pure. */
export function gatewayLossNotice(entry: LedgerEntry, connectorName: string, reason: GatewayCloseReason | 'restart', at: number): BotNoticeInput | null {
  const botId = entry.dispatch?.origin.kind === 'bot' ? entry.dispatch.origin.botId : undefined;
  if (!botId || isTaskEnded(entry.status)) return null;
  const why = LOSS_WHY[reason] ?? 'it was closed';
  return {
    botId,
    workspaceId: entry.ownerWorkspaceId,
    key: `worker-connection-lost:${entry.id}:${connectorName}:${reason}:${at}`,
    topic: 'worker.connection_lost',
    title: `${connectorName} was disconnected; sign in again if needed, then resume the worker`,
    body: `The worker of task ${entry.id} ("${entry.title}") can no longer use ${connectorName}: ${why}. Its calls to ${connectorName} now fail. Once the owner has signed in to it again (Plugins › Connectors) if they need to, resume the worker with worker_resume: it starts again in a new pane.`,
    threadId: taskThreadOf(entry),
    card: true,
    taskId: entry.id,
  };
}

/** The open bot tasks with signed-in connections, as a restart of main left
 *  them: each of their workers lost its gateway. Pure. */
export function gatewayTasksCutByRestart(entries: readonly LedgerEntry[]): Array<{ entry: LedgerEntry; names: string[] }> {
  return entries
    .filter((e) => !isTaskEnded(e.status) && (e.dispatch?.gatewayConnectors?.length ?? 0) > 0 && e.dispatch?.origin.kind === 'bot')
    .map((entry) => ({ entry, names: [...(entry.dispatch?.gatewayConnectors ?? [])] }));
}

// ── The running app's registry ─────────────────────────────────────────────

let oauthSource: (() => GatewayOAuth | null) = () => null;
let registry: WorkerGatewayRegistry | null = null;

/** main/index.ts hands over the connections' OAuth service. */
export function setWorkerGatewayOAuth(service: GatewayOAuth | null): void {
  oauthSource = () => service;
}

/** The OAuth service, for the accept-time checks (fanout.rpc.ts). */
export function workerGatewayOAuth(): GatewayOAuth | null {
  return oauthSource();
}

/** The worker lifecycle starts the registry with the factory's stores. */
export function installWorkerGateway(deps: Omit<WorkerGatewayDeps, 'oauth'>): () => void {
  registry?.dispose();
  const own = new WorkerGatewayRegistry({ ...deps, oauth: () => oauthSource() });
  registry = own;
  return () => {
    own.dispose();
    if (registry === own) registry = null;
  };
}

export function getWorkerGateways(): WorkerGatewayRegistry | null {
  return registry;
}

/** The daemon's session events end leases (pty.handler.ts installs this per
 *  daemon client). */
export function watchWorkerGatewaySessions(daemon: {
  on: (event: string, fn: (payload: { sessionId: string }) => void) => unknown;
  removeListener: (event: string, fn: (payload: { sessionId: string }) => void) => unknown;
}): () => void {
  const ended = (payload: { sessionId: string }) => { if (payload?.sessionId) registry?.closeSession(payload.sessionId); };
  const lost = () => { registry?.closeAll('daemon'); };
  daemon.on('session:died', ended);
  daemon.on('session:destroyed', ended);
  daemon.on('disconnected', lost);
  return () => {
    daemon.removeListener('session:died', ended);
    daemon.removeListener('session:destroyed', ended);
    daemon.removeListener('disconnected', lost);
  };
}
