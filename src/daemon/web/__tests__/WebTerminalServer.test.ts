import { LiveSettingsError } from '../codexLiveSettings';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { RunHistoryStore } from '../../history/RunHistoryStore';
import { InputReceiptStore } from '../InputReceiptStore';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, SessionAuthorizationExpiredError, type WebDeviceResolver } from '../WebTerminalServer';
import type { TranscriptProjector } from '../../transcript/TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { TranscriptStatus } from '../../../shared/transcript/turnEvents';
import { GIT_HARDENING_CONFIG, type GitRunner } from '../sessionDiff';
import { MIN_PHONE_PROTOCOL_VERSION, PHONE_PROTOCOL_VERSION } from '../protocolVersion';
import { OutputModeTracker } from '../../util/outputModeTracker';
import { capSnapshot } from '../snapshotWindow';

/** Drop the fixed `-c key=value` hardening prefix, leaving the command itself. */
const gitBody = (args: readonly string[]): string[] => args.slice(GIT_HARDENING_CONFIG.length);
/** The git subcommand — `rev-parse`, `diff`, `status`. */
const gitVerb = (args: readonly string[]): string => gitBody(args)[0] ?? '';
import type {
  ApprovalEvent,
  ApprovalRegistryApi,
  ApprovalRequest,
  ApprovalResolveResult,
} from '../../approvals/types';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

// A minimal fake of exactly what WebTerminalServer touches: getSession() (for
// stream/input) and listLiveSessions() (for the picker). No real daemon/pty.
function makeDeps() {
  const bridge = new EventEmitter();
  const write = vi.fn();
  const managed = {
    // `cwd` and `spawnCwd` DIFFER on purpose: `cwd` is what the pane's own
    // process last claimed via OSC 7 (i.e. attacker-controlled), `spawnCwd` is
    // where the daemon actually spawned it. Every diff assertion below expects
    // '/x', which is the whole point.
    meta: { id: 's1', incarnationId: 'incarnation-1', cols: 80, rows: 24, state: 'detached', cwd: '/tmp/osc7-said-so', spawnCwd: '/x' },
    // A session recovered from a reboot that has not had its first resize yet.
    // The resize route refuses it — that first resize is the desk's unmute.
    deferred: false,
    // #766 — the desk is showing the pane unless a test flips this; the
    // resize route only honors 'attached' when this is also true.
    viewerVisible: true,
    ringBuffer: {
      readAll: () => Buffer.from('screen-bytes'),
      // The real ring's monotonic lifetime counter. A fake ring never wraps,
      // so "everything ever written" is exactly what readAll returns — and
      // keeping it a getter means a test that restages readAll gets a
      // consistent counter for free.
      get totalBytesWritten(): number { return this.readAll().length; },
    },
    bridge,
    ptyProcess: { write },
  };
  // Three panes covering the workspace-label matrix: named workspace, a legacy
  // pane spawned before WMUX_WORKSPACE_NAME existed (id present, name absent),
  // and no wmux identity at all.
  type LiveRow = {
    id: string; cwd: string; cols: number; rows: number; state: string;
    agent: { role: string; teamId: string; displayName: string } | undefined;
    lastDetectedAgent: string | undefined;
    lastActivity: string;
    env: Record<string, string>; cmd: string;
  };
  const live: LiveRow[] = [    {
      id: 's1', cwd: '/x', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1', ANTHROPIC_API_KEY: 'sk-secret' },
      // Quoted because the path contains a space, plus an argument to prove
      // only the basename is surfaced.
      cmd: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo --token sk-nope',
    },
    {
      id: 's2', cwd: '/y', cols: 80, rows: 24, state: 'attached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_WORKSPACE_ID: 'ws-legacy' },
      // The shape actually recorded on Windows: UNQUOTED, spaces in the path,
      // no arguments (ShellDetector hands the bare path through). Splitting on
      // whitespace here yields "Program" for every pane — precisely the
      // sameness this field exists to remove — so this case must stay covered.
      cmd: 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe\\pwsh.exe',
    },
    {
      id: 's3', cwd: '/z', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { PATH: '/usr/bin' },
      cmd: '/usr/bin/bash -l',
    },
  ];
  // Every geometry the resize route forwarded, and the escape hatch for a
  // manager that refuses (a pane that died between the lookup and the body).
  const resizeCalls: Array<{ id: string; cols: number; rows: number }> = [];
  const resizeBox: {
    throws: string;
    /** Store something other than the request, to prove the route reads back. */
    applyAs: { cols: number; rows: number } | null;
    /** The pane dies between the resize and the read-back. */
    vanishAfter: boolean;
  } = { throws: '', applyAs: null, vanishAfter: false };
  // The real DaemonSessionManager is an EventEmitter; the server tees its
  // session:critical / session:notification events, so the fake must emit too.
  const sessionManager = Object.assign(new EventEmitter(), {
    // Every live pane is gettable, each with its own spawn cwd, so the
    // concurrency bound can be exercised across more than one session.
    getSession: (id: string) => {
      if (resizeBox.vanishAfter && resizeCalls.length > 0) return undefined;
      if (id === 's1') return managed;
      const row = live.find((l) => l.id === id);
      return row
        ? {
            ...managed,
            // `state` is carried through because the resize route reads it —
            // s2 is the attached pane the desk owns.
            meta: {
              ...managed.meta,
              id,
              state: row.state,
              cols: row.cols,
              rows: row.rows,
              cwd: '/tmp/osc7-said-so',
              spawnCwd: row.cwd,
              // The real manager carries the child env on `meta`. Without it here
              // an env-marker check reads as absent and a test can only ever
              // exercise the id-prefix half of it (review: CodeRabbit).
              env: row.env,
            },
          }
        : undefined;
    },
    listLiveSessions: () => live,
    resizeSession: (id: string, cols: number, rows: number) => {
      resizeCalls.push({ id, cols, rows });
      if (resizeBox.throws) throw new Error(resizeBox.throws);
      // The manager may store something other than what was asked for (it
      // floors both axes), so a route that echoed the REQUEST rather than the
      // applied geometry has to fail here rather than in the field.
      const applied = resizeBox.applyAs ?? { cols: Math.max(10, cols), rows: Math.max(2, rows) };
      const target = id === 's1' ? managed.meta : live.find((l) => l.id === id);
      if (target) {
        target.cols = applied.cols;
        target.rows = applied.rows;
      }
    },
  }) as unknown as DaemonSessionManager;
  // Lifecycle stand-in for the daemon's own daemon.createSession /
  // daemon.destroySession handlers (src/daemon/index.ts). The real ones spawn a
  // PTY, arm the supervisor, start the process monitor and flush state — none
  // of which the HTTP surface may know about, which is why the fake is two
  // functions. It mutates `live` so the route's "describe the new pane with the
  // SAME projection /api/sessions uses" claim is actually exercised.
  const lifecycleCalls: Array<{ op: 'create' | 'destroy'; arg: unknown }> = [];
  // `createGate` stands in for the daemon's own awaits inside create (workspace
  // account env, CLI lookup, Codex relay reservation): the route has already
  // re-authorized before create is called, so the window this fake opens is
  // exactly the one the daemon's pre-spawn check has to cover.
  const lifecycleBox = {
    createThrows: '', destroyThrows: '', createGoesMissing: false,
    createGate: null as Promise<void> | null, gatePassed: false,
    authorizedAfterGate: null as boolean | null, spawned: false,
  };
  let created = 0;
  const lifecycle = {
    async create({ authorized, ...params }: { workspaceId?: string; cwd?: string; authorized?: () => Promise<boolean> }) {
      lifecycleCalls.push({ op: 'create', arg: { ...params } });
      if (lifecycleBox.createGate) { await lifecycleBox.createGate; lifecycleBox.gatePassed = true; }
      if (authorized && !(await authorized())) {
        lifecycleBox.authorizedAfterGate = lifecycleBox.gatePassed;
        throw new SessionAuthorizationExpiredError();
      }
      lifecycleBox.spawned = true;
      if (lifecycleBox.createThrows) throw new Error(lifecycleBox.createThrows);
      created += 1;
      const id = `web-${created}`;
      if (!lifecycleBox.createGoesMissing) {
        live.push({
          id, cwd: params.cwd ?? '/home', cols: 120, rows: 30, state: 'detached',
          agent: undefined, lastDetectedAgent: undefined,
          lastActivity: '2020-01-02T00:00:00.000Z',
          env: params.workspaceId ? { WMUX_WORKSPACE_ID: params.workspaceId, WMUX_WORKSPACE_NAME: 'Workspace 1' } : {},
          cmd: '/bin/zsh',
        });
      }
      return { id };
    },
    async destroy(id: string) {
      lifecycleCalls.push({ op: 'destroy', arg: id });
      if (lifecycleBox.destroyThrows) throw new Error(lifecycleBox.destroyThrows);
    },
  };

  // Scripted git for /api/sessions/:id/diff. Records every argv so the
  // "fixed-argv, cwd-from-the-daemon" claim can be asserted from the route side
  // too, not just in sessionDiff.test.ts.
  const gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  const gitScript: Record<
    string,
    { ok: boolean; stdout: string; stderr: string; ran?: boolean }
  > = {
    'rev-parse': { ok: true, stdout: 'true\n/x\n', stderr: '' },
    diff: { ok: true, stdout: 'PATCH\n', stderr: '' },
    status: { ok: true, stdout: ' M src/a.ts\0?? notes.md\0', stderr: '' },
  };
  // Lets a test hold a collection open, which is the only way to observe the
  // concurrency bound and the per-session coalescing.
  const gitGate: { hold: Promise<void> | null } = { hold: null };
  const git: GitRunner = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (gitGate.hold) await gitGate.hold;
    return gitScript[gitVerb(args)] ?? { ok: true, stdout: '', stderr: '' };
  };

  // Where POST /api/upload writes. A real directory rather than a mock: the
  // route's whole job is the file it leaves behind, and the filename pattern,
  // the 0600 mode and the TTL sweep are only observable on disk.
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-uploads-'));

  // #782 — a stand-in for the daemon's TranscriptProjector. The turns route
  // calls status()/snapshot()/delta() in-process; tests steer each via
  // mockReturnValue on the same object.
  const projectorMock = {
    status: vi.fn<(id: string) => TranscriptStatus>(() => ({ available: false, reason: 'no-hook' })),
    // `/api/sessions`'s lastAssistantText reads the file itself, so it needs the
    // full path status() deliberately withholds from the wire.
    transcriptPath: vi.fn<(id: string) => string | null>(() => null),
    snapshot: vi.fn((): unknown => null),
    delta: vi.fn((): unknown => null),
    codeBlock: vi.fn((): unknown => null),
  };

  return {
    sessionManager, bridge, write, live, managed,
    resizeCalls, resizeBox,
    lifecycle, lifecycleCalls, lifecycleBox,
    git, gitCalls, gitScript, gitGate, uploadsDir,
    projectorMock,
    ...makeApprovals(), ...makeDevices(),
  };
}

/**
 * A stand-in for Worker A's DeviceStore (M3). The real one owns the KDF and its
 * parameters, the per-device salt, `devices.json`, the derived-key cache and the
 * audit log — none of which the HTTP surface may know about, which is why the
 * fake is two functions: the web layer only ever asks "whose credential is
 * this?" and "mint one for the device I just named".
 *
 * `roster` is mutable so a test can revoke a device out from under a live
 * stream; `box.mintThrows` covers a roster the daemon cannot persist.
 */
function makeDevices() {
  const roster = new Map<string, { secret: string; name?: string; revoked: boolean; allowInput: boolean }>();
  const resolveCalls: Array<{ deviceId: string; secret: string }> = [];
  const mintCalls: Array<{ name?: string; allowInput?: boolean }> = [];
  const touchCalls: string[] = [];
  const pushRegistrations: Array<{ deviceId: string; apnsToken: string; publicKey: string }> = [];
  const liveActivityRegistrations: Array<{ deviceId: string } & Record<string, unknown>> = [];
  /** Forces the store's answer, so the route's status mapping can be exercised. */
  const liveActivityBox: { reason: string } = { reason: '' };
  const box = { mintThrows: false };
  let seq = 0;
  const devices: WebDeviceResolver = {
    async mint(params) {
      mintCalls.push({ ...params });
      if (box.mintThrows) throw new Error('roster write failed');
      seq += 1;
      const deviceId = `dev-${seq}`;
      const deviceSecret = `s3cr3t-${seq}`;
      roster.set(deviceId, {
        secret: deviceSecret,
        name: params.name,
        revoked: false,
        // Mirrors the real store: the grant is explicit on every new record and
        // only an absent one (a pre-grant roster) reads as allowed.
        allowInput: params.allowInput !== false,
      });
      return { deviceId, deviceSecret };
    },
    async resolve(deviceId, secret) {
      resolveCalls.push({ deviceId, secret });
      const rec = roster.get(deviceId);
      // Unknown and revoked are separate answers on purpose — the phone shows
      // different copy for "never heard of you" and "the operator threw you out".
      if (!rec) return { ok: false, reason: 'unknown' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      if (rec.secret !== secret) return { ok: false, reason: 'unknown' };
      return { ok: true, deviceId, ...(rec.name ? { name: rec.name } : {}), allowInput: rec.allowInput };
    },
    touch(deviceId) {
      touchCalls.push(deviceId);
    },
    registerPush(deviceId, input) {
      pushRegistrations.push({ deviceId, ...input });
      const rec = roster.get(deviceId);
      if (!rec) return { ok: false, reason: 'not-found' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      if (!/^[0-9a-f]{64,200}$/.test(input.apnsToken)) return { ok: false, reason: 'bad-token' };
      if (Buffer.from(input.publicKey, 'base64').length !== 32) return { ok: false, reason: 'bad-key' };
      // The real store owns this allowlist; the fake mirrors it so the route's
      // 400 mapping is exercised rather than assumed.
      if (
        input.apnsEnvironment !== undefined &&
        input.apnsEnvironment !== 'development' &&
        input.apnsEnvironment !== 'production'
      ) {
        return { ok: false, reason: 'bad-apns-environment' };
      }
      return { ok: true };
    },
    // Mirrors the real store closely enough that the route's own mapping is
    // exercised: MERGE semantics, `null` removes, and the same two refusals.
    registerLiveActivity(deviceId, input) {
      liveActivityRegistrations.push({ deviceId, ...input });
      if (liveActivityBox.reason) return { ok: false, reason: liveActivityBox.reason };
      const rec = roster.get(deviceId);
      if (!rec) return { ok: false, reason: 'not-found' };
      if (rec.revoked) return { ok: false, reason: 'revoked' };
      for (const key of ['pushToStartToken', 'activityToken'] as const) {
        const raw = input[key];
        if (raw === undefined || raw === null) continue;
        if (typeof raw !== 'string' || !/^[0-9a-f]{64,200}$/.test(raw)) {
          return { ok: false, reason: 'bad-token' };
        }
      }
      if (
        input.apnsEnvironment !== undefined &&
        input.apnsEnvironment !== 'development' &&
        input.apnsEnvironment !== 'production'
      ) {
        return { ok: false, reason: 'bad-apns-environment' };
      }
      return { ok: true };
    },
  };
  return {
    devices,
    liveActivityRegistrations,
    liveActivityBox,
    deviceRoster: roster,
    deviceResolveCalls: resolveCalls,
    deviceMintCalls: mintCalls,
    pushRegistrations,
    deviceTouchCalls: touchCalls,
    deviceBox: box,
  };
}

/**
 * A stand-in for the daemon's ApprovalRegistry (Worker A). The real one owns
 * CAS, persistence, the prompt re-verify and the keystroke map — none of which
 * the HTTP surface is allowed to know about, which is exactly why the fake can
 * be this small: the web layer only lists, resolves, and republishes.
 *
 * `records` is mutable so a test can script what is pending; `resolveResult` is
 * what the next resolve() answers, which is how every status-code mapping gets
 * exercised without a real pane to refuse.
 */
function makeApprovals() {
  // The registry hands back an unsubscribe closure rather than taking off(), so
  // the fake keeps the listener set itself — and the leak test can count it.
  const listeners = new Set<(e: ApprovalEvent) => void>();
  const records: ApprovalRequest[] = [];
  const resolveCalls: Array<{ id: string; decision: string; resolvedBy: string }> = [];
  const box: { result: ApprovalResolveResult; listThrows: boolean; beforeAuthorize?: () => void } = {
    result: { ok: true, durable: true, request: mkApproval({ state: 'resolved', decision: 'approve', resolvedBy: 'web' }) },
    listThrows: false,
  };
  const approvals: ApprovalRegistryApi = {
    list: () => {
      if (box.listThrows) throw new Error('registry exploded');
      return {
        pending: records.filter((r) => r.state === 'pending'),
        recentlyResolved: records.filter((r) => r.state !== 'pending'),
      };
    },
    pendingCount: () => records.filter((r) => r.state === 'pending').length,
    resolve: async (params) => {
      // Recorded without the `authorize` closure, so call assertions stay plain
      // data. The closure is still exercised the way the real registry does:
      // against the pending record, with the same two refusals.
      const { authorize, ...recorded } = params;
      resolveCalls.push(recorded);
      const pending = records.find((r) => r.id === params.id && r.state === 'pending');
      if (authorize && pending) {
        box.beforeAuthorize?.();
        const verdict = await authorize(pending);
        if (verdict === 'expired') return { ok: false, reason: 'unauthorized' };
        if (verdict === 'read-only') return { ok: false, reason: 'input-revoked' };
      }
      return box.result;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emitApproval = (type: ApprovalEvent['type'], request: ApprovalRequest) => {
    for (const l of listeners) l({ type, request });
  };
  return { approvals, approvalRecords: records, resolveCalls, emitApproval, approvalListeners: listeners, approvalBox: box };
}

/** A pending request, with just enough shape to be recognisable on the wire. */
function mkApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap-1',
    sessionId: 's1',
    agent: 'claude',
    kind: 'awaiting_input',
    createdAt: 1_700_000_000_000,
    state: 'pending',
    ...over,
  };
}

// The phone Git controller refuses repositories with content filters, and the
// macOS CI image declares git-lfs filters in the runner's global gitconfig.
// Point HOME at an empty directory for this file so git sees no global config.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-home-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe('WebTerminalServer', () => {
  let server: WebTerminalServer;
  let bridge: EventEmitter;
  let write: ReturnType<typeof vi.fn>;
  let sessionManager: DaemonSessionManager;
  let approvalRecords: ApprovalRequest[];
  let resolveCalls: Array<{ id: string; decision: string; resolvedBy: string }>;
  let emitApproval: (type: ApprovalEvent['type'], request: ApprovalRequest) => void;
  let approvalListeners: Set<(e: ApprovalEvent) => void>;
  let approvalBox: { result: ApprovalResolveResult; listThrows: boolean; beforeAuthorize?: () => void };
  let deviceRoster: Map<string, { secret: string; name?: string; revoked: boolean }>;
  let deviceMintCalls: Array<{ name?: string }>;
  let pushRegistrations: Array<{ deviceId: string; apnsToken: string; publicKey: string }>;
  let liveActivityRegistrations: Array<{ deviceId: string } & Record<string, unknown>>;
  let liveActivityBox: { reason: string };
  let liveActivityRegisteredCalls: number;
  let deviceTouchCalls: string[];
  let deviceBox: { mintThrows: boolean };
  let resizeCalls: Array<{ id: string; cols: number; rows: number }>;
  let resizeBox: ReturnType<typeof makeDeps>['resizeBox'];
  let lifecycleCalls: Array<{ op: 'create' | 'destroy'; arg: unknown }>;
  let lifecycleBox: { createThrows: string; destroyThrows: string; createGoesMissing: boolean;
    createGate: Promise<void> | null; gatePassed: boolean; authorizedAfterGate: boolean | null; spawned: boolean };
  let gitCalls: Array<{ args: readonly string[]; cwd: string }>;
  let gitScript: Record<string, { ok: boolean; stdout: string; stderr: string; ran?: boolean }>;
  let gitGate: { hold: Promise<void> | null };
  let managed: {
    meta: Record<string, unknown>;
    deferred: boolean;
    viewerVisible: boolean;
    // Reassigned by the snapshot-preamble tests to stage a ring larger than the
    // 256 KB window.
    ringBuffer: { readAll: () => Buffer; readonly totalBytesWritten: number };
  };
  let live: ReturnType<typeof makeDeps>['live'];
  let uploadsDir: string;
  let projectorMock: ReturnType<typeof makeDeps>['projectorMock'];
  /** #783 — the daemon's runtime gate flag, which the server only reads/writes. */
  let gateArmed: boolean;
  /** Whether the daemon's Live Activity pusher reports itself enabled. */
  let liveActivityPushEnabled: boolean;
  let desktopBridge: DesktopPhoneBridge | null;
  let agentLaunchEnv: NodeJS.ProcessEnv | undefined;
  let settingsCalls: Array<{id:string;choice:unknown}>;
  let settingsHook: ((authorized:()=>Promise<boolean>)=>Promise<void>) | undefined;
  const settingsRevision = 'a'.repeat(64)+'.'+'b'.repeat(64);

  /** #1163 — the daemon's canonical agent state per session, as the server reads it. */
  let agentStates: Record<string, { agentName: string | null; agentStatus: 'idle' | 'running' | 'awaiting_input' }>;
  /** #1342 — the daemon's resume state per session, as the server reads it. */
  let resumeStates: Record<string, { binding?: ResumeBinding; commandRunning?: boolean; agentProcessAlive?: boolean }>;

  beforeEach(() => {
    desktopBridge = null;
    agentLaunchEnv = undefined;
    settingsCalls = []; settingsHook = undefined;
    gateArmed = true;
    liveActivityPushEnabled = true;
    agentStates = {};
    resumeStates = {};
    const deps = makeDeps();
    bridge = deps.bridge;
    write = deps.write;
    sessionManager = deps.sessionManager;
    approvalRecords = deps.approvalRecords;
    resolveCalls = deps.resolveCalls;
    emitApproval = deps.emitApproval;
    approvalListeners = deps.approvalListeners;
    approvalBox = deps.approvalBox;
    deviceRoster = deps.deviceRoster;
    deviceMintCalls = deps.deviceMintCalls;
    pushRegistrations = deps.pushRegistrations;
    liveActivityRegistrations = deps.liveActivityRegistrations;
    liveActivityBox = deps.liveActivityBox;
    liveActivityRegisteredCalls = 0;
    deviceTouchCalls = deps.deviceTouchCalls;
    deviceBox = deps.deviceBox;
    resizeCalls = deps.resizeCalls;
    resizeBox = deps.resizeBox;
    lifecycleCalls = deps.lifecycleCalls;
    lifecycleBox = deps.lifecycleBox;
    gitCalls = deps.gitCalls;
    gitScript = deps.gitScript;
    gitGate = deps.gitGate;
    managed = deps.managed;
    live = deps.live;
    uploadsDir = deps.uploadsDir;
    projectorMock = deps.projectorMock;
    server = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      approvals: deps.approvals,
      devices: deps.devices,
      lifecycle: deps.lifecycle,
      git: deps.git,
      uploadsDir: deps.uploadsDir,
      runHistory: () => new RunHistoryStore(deps.uploadsDir),
      inputReceipts: () => new InputReceiptStore(deps.uploadsDir),
      desktop: () => desktopBridge,
      agentLaunchOptions: async env => { agentLaunchEnv = env; return [{agent:'claude',models:['opus','sonnet'],efforts:['low','high']}]; },
      agentSettings: async (id,authorized,choice)=>{
        settingsCalls.push({id,choice});
        await settingsHook?.(authorized);
        return {agent:'codex',model:'model-a',effort:'low',busy:false,revision:settingsRevision,models:[]};
      },
      projector: () => projectorMock as unknown as TranscriptProjector,
      gateConfig: () => ({ gatedTools: ['Bash'] }),
      gateEnabled: () => gateArmed,
      liveActivityPush: () => liveActivityPushEnabled,
      liveActivityRegistered: () => { liveActivityRegisteredCalls += 1; },
      setGateEnabled: (enabled) => { gateArmed = enabled; },
      agentState: (id) => agentStates[id],
      resumeState: (id) => resumeStates[id],
      log: () => { /* silent in tests */ },
      assetsDir: os.tmpdir(), // no terminal.html needed for the /api/* tests
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  // Port 0 → ephemeral bind; status() reports the actual port.
  const startRO = () => server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
  const startRW = () => server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false });
  /** Uploads on, input OFF — the combination that proves the two grants are separate. */
  const startUpload = () =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
  /** #782 — transcript turn view armed (`--allow-transcript`); its own grant. */
  const startWithTranscript = () =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: true });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const pairCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;

  it('gates /api/* — Bearer header required, query token rejected for non-SSE', async () => {
    const info = await startRO();
    expect(info.running).toBe(true);
    const token = info.token as string;

    // No credentials → 401
    const noAuth = await fetch(`${base()}/api/config`);
    expect(noAuth.status).toBe(401);

    // Query-string token is NOT accepted on a non-SSE endpoint (narrowed to Bearer)
    const q = await fetch(`${base()}/api/config?token=${encodeURIComponent(token)}`);
    expect(q.status).toBe(401);

    // Bearer header → 200
    const ok = await fetch(`${base()}/api/config`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ allowInput: false, allowUpload: false });
  });

  // #1316 — the phone's half of the daemon's idle clock. The daemon folds this
  // timestamp into the same anchor as the pipe's lastDisconnectAt, so a phone
  // that is being used is no longer indistinguishable from an abandoned daemon.
  it('stamps idle-clock activity for authenticated /api/* calls, and only those', async () => {
    const info = await startRO();
    const token = info.token as string;

    expect(server.getLastActivityAt()).toBeNull();

    // A refused credential is not somebody using the daemon.
    const noAuth = await fetch(`${base()}/api/config`);
    expect(noAuth.status).toBe(401);
    expect(server.getLastActivityAt()).toBeNull();

    // Neither is the one unauthenticated API route: anything that can open the
    // port can call it, and a stranger must not be able to keep the daemon up.
    await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
    expect(server.getLastActivityAt()).toBeNull();

    const before = Date.now();
    const ok = await fetch(`${base()}/api/sessions`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    const stamped = server.getLastActivityAt();
    expect(stamped).not.toBeNull();
    expect(stamped as number).toBeGreaterThanOrEqual(before);
  });

  it('★ /api/config carries the phone protocol handshake', async () => {
    // A shipped native client cannot be updated by the daemon, so the daemon
    // has to say which contract it is speaking. This is the route the client
    // already calls at connect time, and a daemon predating the handshake
    // answers the same body with these three keys absent — which is how a
    // client reads "protocol 0".
    const info = await startRO();
    const res = await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocolVersion).toBe(PHONE_PROTOCOL_VERSION);
    expect(body.minProtocolVersion).toBe(MIN_PHONE_PROTOCOL_VERSION);
    // The floor can never exceed what the server itself speaks — that would
    // lock out every client including a freshly built one.
    expect(body.minProtocolVersion).toBeLessThanOrEqual(body.protocolVersion);
    // Present and non-empty. The value is the launcher-injected release or the
    // 'unknown' sentinel; tests run without the launcher, so both are valid and
    // only the field's existence is contractual.
    expect(typeof body.serverVersion).toBe('string');
    expect(body.serverVersion.length).toBeGreaterThan(0);
  });

  it('★ the handshake survives a bind that refuses to pair', async () => {
    // A plaintext non-loopback bind refuses to mint credentials, which is the
    // one state where the server answers operator surfaces differently. An
    // already-paired phone still reaches /api/config there, so the version
    // fields must not be a property of the happy path only — a client that
    // could not read them would report "update required" for a transport
    // problem.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
    expect(server.status().pairRefusal?.reason).toBe('insecure-transport');

    const res = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
      headers: bearer(info.token as string),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocolVersion: PHONE_PROTOCOL_VERSION,
      minProtocolVersion: MIN_PHONE_PROTOCOL_VERSION,
    });
  });

  it('never lists the orchestrator brain as a pane', async () => {
    // The brain's TUI is a daemon session like any other, but it is the
    // orchestrator itself — not a worker pane. It must not be listed (nor
    // attachable/approvable) from the phone, exactly as the fleet pane listing
    // already excludes it. Both markers are checked: the env stamp is
    // authoritative, the id prefix is the fallback for a session whose env the
    // daemon no longer holds.
    live.push(
      {
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/local/bin/claude',
      },
      {
        id: 'brain-noenv', cwd: '/b2', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: {}, cmd: '/usr/local/bin/claude',
      },
    );
    try {
      const info = await startRO();
      const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    } finally {
      live.length = 3;
    }
  });

  it('labels sessions by workspace NAME only, and leaks nothing else from env', async () => {
    const info = await startRO();
    const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Array<Record<string, unknown>> };

    // Named workspace wins.
    expect(sessions[0].workspace).toBe('Workspace 1');
    // A pane that predates WMUX_WORKSPACE_NAME carries only the id. The id is a
    // UUID and means nothing to a human, so it is NOT used as a fallback — the
    // field stays absent and the frontend keeps showing its cwd label.
    expect('workspace' in sessions[1]).toBe(false);
    // No wmux identity at all → the field is absent, so the frontend falls back
    // to its cwd label instead of showing a fabricated workspace.
    expect('workspace' in sessions[2]).toBe(false);

    // Only the workspace NAME is read out of the pane env — the rest of it
    // (credentials, account config dirs, and the meaningless workspace UUID)
    // must never reach the browser.
    const wire = JSON.stringify(sessions);
    expect(wire).not.toContain('sk-secret');
    expect(wire).not.toContain('ANTHROPIC_API_KEY');
    expect(wire).not.toContain('/usr/bin');
    expect(wire).not.toContain('ws-legacy');
  });

  it('★ #1319 a pane row names the detected agent and the cwd leaf, or carries neither key', async () => {
    // s1 runs an agent the detector recognised; s2 and s3 are plain shells.
    // Before this the phone had only `agent`, whose value is a role display
    // name for some panes and this same slug for others — so every shell pane's
    // chip collapsed to the generic word.
    live[0].lastDetectedAgent = 'claude';
    const info = await startRO();
    const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Array<Record<string, unknown>> };

    expect(sessions[0].lastDetectedAgent).toBe('claude');
    // `agent` keeps the shape it always had — the new field is additive, not a
    // replacement, so a client that ignores it behaves exactly as before.
    expect(sessions[0].agent).toBe('claude');
    // Absent means "no agent was ever detected here", never null-the-value: a
    // client must be able to tell "not known" from "known to be nothing".
    expect('lastDetectedAgent' in sessions[1]).toBe(false);
    expect('lastDetectedAgent' in sessions[2]).toBe(false);

    // The leaf of the pane's own cwd — the label of last resort, computed once
    // by the daemon instead of separately by every client.
    expect(sessions[0].cwdLeaf).toBe('x');
    expect(sessions[1].cwdLeaf).toBe('y');
  });

  it('★ #1319 the cwd leaf survives both separators and a trailing one', async () => {
    // A Windows daemon can hold a pane whose shell reports a POSIX path (WSL,
    // git-bash), so neither separator can be the only one split on, and a
    // trailing separator must not swallow the leaf.
    live[0].cwd = 'C:\\Users\\dev\\wmux\\';
    live[1].cwd = '/home/dev/projects/relay';
    live[2].cwd = '\\\\build-01\\share\\out';
    const info = await startRO();
    const { sessions } = (await (
      await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) })
    ).json()) as { sessions: Array<Record<string, unknown>> };

    expect(sessions[0].cwdLeaf).toBe('wmux');
    expect(sessions[1].cwdLeaf).toBe('relay');
    expect(sessions[2].cwdLeaf).toBe('out');
  });

  it('★ #1319 a cwd with no readable leaf carries no key — including a DRIVE root', async () => {
    // `cwd` is whatever the pane's own process last claimed over OSC 7, so the
    // degenerate values are real. The key is withheld rather than filled with
    // something a human cannot read: absent is a label the client can fall back
    // from, "C:" and " " are labels it would print.
    live[0].cwd = '/';
    // What OSC 7 `/C:/` parses to on the daemon's primary platform. Before the
    // drive-letter check this rendered a pane chip reading "C:".
    live[1].cwd = 'C:\\';
    live[2].cwd = '   ';
    const info = await startRO();
    const { sessions } = (await (
      await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) })
    ).json()) as { sessions: Array<Record<string, unknown>> };

    expect('cwdLeaf' in sessions[0]).toBe(false);
    expect('cwdLeaf' in sessions[1]).toBe(false);
    expect('cwdLeaf' in sessions[2]).toBe(false);
  });

  it('deduplicates authenticated input IDs and refuses changed bodies or pane incarnations', async () => {
    const info = await startRW();
    const requestID = `${Date.now()}.${crypto.randomUUID()}`;
    const headers = {...bearer(info.token as string),'X-Wmux-Input-Request-ID':requestID,'X-Wmux-Pane-Incarnation':'incarnation-1'};
    const post = (body: string) => fetch(`${base()}/api/input?session=s1`,{method:'POST',headers,body});
    expect((await post('hello')).status).toBe(200);
    expect(await (await post('hello')).json()).toEqual({status:'written',replayed:true});
    expect(write).toHaveBeenCalledTimes(1);
    expect((await post('changed')).status).toBe(409);
    managed.meta.incarnationId = 'incarnation-2';
    expect((await post('hello')).status).toBe(409);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not retry a possibly partial write through the HTTP receipt path', async () => {
    const info = await startRW();
    write.mockImplementationOnce(() => { throw new Error('partial'); });
    const headers = {...bearer(info.token as string),'X-Wmux-Input-Request-ID':`${Date.now()}.${crypto.randomUUID()}`,'X-Wmux-Pane-Incarnation':'incarnation-1'};
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base()}/api/input?session=s1`,{method:'POST',headers,body:'hello'});
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({status:'uncertain',replayed:attempt === 1});
    }
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([false,true])('guards Return against intervening input (changed=%s)', async changed => {
    const info = await startRW();
    let revision = 0;
    Object.assign(bridge,{getInputRevision:() => revision,noteInput:() => { revision++; }});
    const textID = `${Date.now()}.${crypto.randomUUID()}`;
    const returnID = `${Date.now()}.${crypto.randomUUID()}`;
    const post = (id: string, body: string, after?: string) => fetch(`${base()}/api/input?session=s1`, {
      method:'POST',headers:{...bearer(info.token as string),'X-Wmux-Input-Request-ID':id,
        'X-Wmux-Pane-Incarnation':'incarnation-1',...(after ? {'X-Wmux-Input-After':after} : {})},body,
    });
    const receipt = await (await post(textID,'hello')).json() as {inputToken:string};
    expect(receipt.inputToken).toEqual(expect.any(String));
    if (changed) revision++; // Another phone/desktop write observed by the bridge.
    const submission = await post(returnID,'\r',receipt.inputToken);
    expect(submission.status).toBe(changed ? 409 : 200);
    expect(write).toHaveBeenCalledTimes(changed ? 1 : 2);
    if (!changed) {
      revision++;
      const replay = await post(returnID,'\r',receipt.inputToken);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({status:'written',replayed:true});
      expect(write).toHaveBeenCalledTimes(2);
    }
  });

  it('reconciles a dropped response after HTTP server restart without repeating input', async () => {
    const info = await startRW();
    const requestID = `${Date.now()}.${crypto.randomUUID()}`;
    let receivedResponse = false;
    await new Promise<void>((resolve, reject) => {
      const request = httpReq(`${base()}/api/input?session=s1`, {
        method:'POST', headers:{...bearer(info.token as string),
          'X-Wmux-Input-Request-ID':requestID,'X-Wmux-Pane-Incarnation':'incarnation-1'},
      }, response => { receivedResponse = true; response.resume(); reject(new Error('Expected dropped response')); });
      // Drop the client socket exactly when the server writes, before its
      // receipt response. No timing sleeps or live user PTYs are involved.
      write.mockImplementationOnce(() => request.destroy(new Error('simulated response loss')));
      request.once('error', () => resolve());
      request.end('hello');
    });
    expect(receivedResponse).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    await server.stop();
    const restarted = await startRW();
    const response = await fetch(`${base()}/api/input?session=s1`, {
      method:'POST',headers:{...bearer(restarted.token as string),
        'X-Wmux-Input-Request-ID':requestID,'X-Wmux-Pane-Incarnation':'incarnation-1'},body:'hello',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({status:'written',replayed:true});
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('rechecks device revocation after a slow input body completes', async () => {
    await startRW();
    const phone = await pairDevice('Slow sender',true);
    let observed!: () => void;
    const authorized = new Promise<void>(resolve => { observed = resolve; });
    const original = sessionManager.getSession.bind(sessionManager);
    const spy = vi.spyOn(sessionManager,'getSession').mockImplementation(id => {
      const result = original(id);
      if (id === 's1') observed();
      return result;
    });
    let request: ReturnType<typeof httpReq>;
    const response = new Promise<number | undefined>((resolve,reject) => {
      request = httpReq(`${base()}/api/input?session=s1`,{method:'POST',headers:bearer(phone.token)},res => {
        res.resume(); res.on('end',() => resolve(res.statusCode));
      });
      request.on('error',reject);
      request.write('partial body');
    });
    try {
      await authorized;
      deviceRoster.get(phone.deviceId)!.revoked = true;
      request!.end(' remaining body');
      expect(await response).toBe(401);
      expect(write).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); request!.destroy(); }
  });

  it('rejects input when started read-only (403), accepts and writes when --allow-input (204)', async () => {
    // read-only
    let info = await startRO();
    const roRes = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST', headers: bearer(info.token as string), body: 'nope',
    });
    expect(roRes.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    await server.stop();

    // allow-input
    info = await startRW();
    const rwRes = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST', headers: bearer(info.token as string), body: 'echo hi\r',
    });
    expect(rwRes.status).toBe(204);
    expect(write).toHaveBeenCalledWith('echo hi\r');
  });

  it('mints a fresh token on each start and invalidates the previous one', async () => {
    const a = (await startRO()).token as string;
    await server.stop();
    const b = (await startRO()).token as string;
    expect(b).not.toBe(a);

    // The old token no longer authenticates against the new server.
    const stale = await fetch(`${base()}/api/config`, { headers: bearer(a) });
    expect(stale.status).toBe(401);
    const fresh = await fetch(`${base()}/api/config`, { headers: bearer(b) });
    expect(fresh.status).toBe(200);
  });

  // #596 — the daemon carries the previous token across a restart so a phone
  // that already paired keeps working. The seam is caller-supplied, never RPC
  // params: the daemon reads it from its own 0600 state file.
  it('reuses a caller-supplied token so a paired device survives a restart', async () => {
    const a = (await startRO()).token as string;
    await server.stop();

    const b = (await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token: a }))
      .token as string;
    expect(b).toBe(a);

    // The token the phone already has still opens the door.
    const carried = await fetch(`${base()}/api/config`, { headers: bearer(a) });
    expect(carried.status).toBe(200);
  });

  it('mints a fresh token when the supplied one is empty (no accidental blank-token server)', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token: '' });
    expect(info.token).toBeTruthy();
    expect((info.token as string).length).toBeGreaterThan(8);
    // An empty Bearer must not authenticate against it.
    const blank = await fetch(`${base()}/api/config`, { headers: bearer('') });
    expect(blank.status).toBe(401);
  });

  it('still rotates the pairing code across a token-carrying restart', async () => {
    const first = await startRO();
    const token = first.token as string;
    const codeA = first.pairCode as string;
    await server.stop();

    const second = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, token });
    // The token is carried, the single-use pairing code is NOT — handing back a
    // burned code would be worse than asking for a fresh one.
    expect(second.token).toBe(token);
    expect(second.pairCode).not.toBe(codeA);
  });

  it('teardown stops accepting connections and removes all bridge listeners', async () => {
    const info = await startRO();
    const token = info.token as string;
    const port = server.status().port;

    // Open an SSE stream — this attaches a bridge 'data' + 'exit' listener.
    const ac = new AbortController();
    const sse = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, { signal: ac.signal });
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.listenerCount('data')).toBe(1);
    expect(bridge.listenerCount('exit')).toBe(1);

    // Stop → every SSE client detached, all bridge listeners removed.
    const stopped = await server.stop();
    expect(stopped).toEqual({ stopped: true });
    expect(bridge.listenerCount('data')).toBe(0);
    expect(bridge.listenerCount('exit')).toBe(0);
    expect(server.isRunning).toBe(false);
    ac.abort();

    // The port no longer accepts connections.
    await expect(fetch(`http://127.0.0.1:${port}/api/config`, { headers: bearer(token) })).rejects.toThrow();
  });

  it('stop() on a server that never started is a no-op', async () => {
    expect(await server.stop()).toEqual({ stopped: false });
  });

  // ── pairing ────────────────────────────────────────────────────────────────
  it('exposes an 8-character pairing code + expiry in status()', async () => {
    const info = await startRO();
    expect(info.pairCode).toMatch(pairCodePattern);
    expect(typeof info.pairExpiresAt).toBe('number');
    expect((info.pairExpiresAt as number)).toBeGreaterThan(Date.now());
  });

  it('reports transcript access in normal pairing-capable status responses', async () => {
    const disabled = await startRO();
    expect(disabled).toHaveProperty('allowTranscript', false);

    await server.stop();
    const enabled = await startWithTranscript();
    expect(enabled).toHaveProperty('allowTranscript', true);
    expect(server.status()).toHaveProperty('allowTranscript', true);
  });

  it('/api/pair with the right code returns a credential once, then 403 (single use)', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    const token = info.token as string;

    // No auth header needed — pairing is the only unauthenticated /api route.
    const ok = await fetch(`${base()}/api/pair?code=${code}`);
    expect(ok.status).toBe(200);
    // M3: what the phone gets is ITS OWN credential, never the shared operator
    // token — that is the whole point of making the token durable revocable.
    expect(await ok.json()).toEqual({
      deviceId: 'dev-1',
      deviceSecret: 's3cr3t-1',
      token: 'dev-1.s3cr3t-1',
    });
    expect(token).not.toBe('dev-1.s3cr3t-1');

    // The code is burned — a second use fails.
    const reuse = await fetch(`${base()}/api/pair?code=${code}`);
    expect(reuse.status).toBe(403);
  });

  it('/api/pair with a wrong code decrements attempts and locks after 5', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    // Build a wrong code of the same length from the same alphabet.
    const wrong = code[0] === 'A' ? 'BBBBBBBB' : 'AAAAAAAA';

    for (let i = 4; i >= 1; i--) {
      const r = await fetch(`${base()}/api/pair?code=${wrong}`);
      expect(r.status).toBe(403);
      expect((await r.json()).attemptsLeft).toBe(i);
    }
    // 5th wrong attempt burns the code.
    const last = await fetch(`${base()}/api/pair?code=${wrong}`);
    expect(last.status).toBe(403);
    expect((await last.json()).attemptsLeft).toBe(0);

    // Even the CORRECT code no longer works once the budget is exhausted.
    const correct = await fetch(`${base()}/api/pair?code=${code}`);
    expect(correct.status).toBe(403);
  });

  it('mints a fresh pairing code on each start', async () => {
    let fill = 0;
    const randomBytes = vi.spyOn(crypto, 'randomBytes').mockImplementation((size) => Buffer.alloc(size, fill++));
    try {
      const a = (await startRO()).pairCode as string;
      await server.stop();
      const b = (await startRO()).pairCode as string;
      expect(a).toBe('AAAAAAAA');
      expect(b).toBe('BBBBBBBB');
      expect(a).toMatch(pairCodePattern);
      expect(b).toMatch(pairCodePattern);
    } finally {
      randomBytes.mockRestore();
    }
  });

  // ── critical / notify SSE tee ──────────────────────────────────────────────
  it('★ #1402 withholds the brain pane\'s critical/notify events from the fan-out and the replay log', async () => {
    // Both brain marks, on separate panes: the env marker, and the id prefix
    // for a listing that omits env. A pane the manager no longer knows must
    // still get through — that is a closed pane's in-flight event, not a
    // brain pane.
    live.push({
      id: 'pty-orchestrator', cwd: '/x', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/bin/claude',
    });
    const info = await startRO();
    const token = info.token as string;
    const ac = new AbortController();
    const sse = await fetch(
      `${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`,
      { signal: ac.signal },
    );
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    const em = sessionManager as unknown as EventEmitter;
    em.emit('session:critical', {
      sessionId: 'pty-orchestrator',
      event: { action: 'delete files', riskLevel: 'critical', matchedLine: '$ rm -rf orchestrator-secrets' },
    });
    em.emit('session:notification', {
      sessionId: 'brain-ws-9',
      event: { source: 'osc9', title: null, body: 'orchestrator notification', ts: 1 },
    });
    em.emit('session:notification', {
      sessionId: 'gone-worker',
      event: { source: 'osc9', title: null, body: 'closed pane still speaks', ts: 2 },
    });

    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !text.includes('closed pane still speaks')) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += Buffer.from(value).toString('utf8');
    }
    ac.abort();

    expect(text).toContain('"sessionId":"gone-worker"');
    expect(text).not.toContain('pty-orchestrator');
    expect(text).not.toContain('orchestrator-secrets');
    expect(text).not.toContain('brain-ws-9');
    expect(text).not.toContain('orchestrator notification');

    // The replayable backlog behind /api/events never held them either.
    const backlog = await fetch(`${base()}/api/events`, { headers: bearer(token) });
    expect(backlog.status).toBe(200);
    const body = await backlog.text();
    expect(body).toContain('gone-worker');
    expect(body).not.toContain('pty-orchestrator');
    expect(body).not.toContain('brain-ws-9');
  });

  it('★ #1397 withholds the brain pane\'s approval events from the fan-out and the replay log', async () => {
    // The same producer-side gate as #1402 above, on the other producer. An
    // `approval` event carries the pane id AND the gate's tool name and input
    // summary, so a brain record here would hand a device the orchestrator's
    // tool input plus the very id the per-pane routes (#1388) refuse.
    live.push({
      id: 'pty-orchestrator', cwd: '/x', cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
      env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/bin/claude',
    });
    const info = await startRO();
    const token = info.token as string;

    // Injected at the registry's own event edge, not produced through the hook
    // path: whether the brain can raise a record today is a property of how
    // `ClaudePtyBrainAdapter` spawns it, which is exactly what this gate is
    // here not to depend on.
    emitApproval('create', mkApproval({
      id: 'ap-brain',
      sessionId: 'pty-orchestrator',
      kind: 'awaiting_permission',
      toolName: 'Bash',
      toolInputSummary: 'rm -rf orchestrator-secrets',
    }));
    // A pane the manager no longer knows still gets through — a closed pane's
    // in-flight approval is not a brain pane.
    emitApproval('create', mkApproval({ id: 'ap-gone', sessionId: 'gone-worker' }));
    emitApproval('create', mkApproval({ id: 'ap-worker', sessionId: 's1' }));

    const backlog = await fetch(`${base()}/api/events`, { headers: bearer(token) });
    expect(backlog.status).toBe(200);
    const body = await backlog.text();
    expect(body).toContain('ap-worker');
    expect(body).toContain('ap-gone');
    expect(body).not.toContain('ap-brain');
    expect(body).not.toContain('pty-orchestrator');
    expect(body).not.toContain('orchestrator-secrets');
  });

  it('tees session:critical and session:notification to every SSE client', async () => {
    const info = await startRO();
    const token = info.token as string;

    const ac = new AbortController();
    const sse = await fetch(
      `${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`,
      { signal: ac.signal },
    );
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    // Emit fleet-wide events; they must reach the stream even though it watches s1.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's2',
      // The production shape carries the matched PTY line (#605) — `action` is
      // only a pattern label, so without it the phone cannot say WHICH command.
      event: { action: 'delete files', riskLevel: 'critical', matchedLine: '$ rm -rf /tmp/junk' },
    });
    // The PRODUCTION notify shape (DaemonPTYBridge): {source, title, body, ts},
    // with title null because OSC 9 carries no title. The fake used to emit a
    // `{message}` object that exists nowhere in the daemon — which is exactly
    // how #597 (the frontend reading `data.message`) shipped green.
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId: 's3',
      event: { source: 'osc9', title: null, body: 'Build finished, 3 tests failed', ts: 123 },
    });

    // Read a chunk of the stream and assert both events flattened onto the wire.
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !(text.includes('event: critical') && text.includes('event: notify'))) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += Buffer.from(value).toString('utf8');
    }
    ac.abort();

    expect(text).toContain('event: critical');
    expect(text).toContain('"sessionId":"s2"');
    expect(text).toContain('"action":"delete files"');
    expect(text).toContain('"matchedLine":"$ rm -rf /tmp/junk"');
    expect(text).toContain('event: notify');
    expect(text).toContain('"sessionId":"s3"');
    // ★ The whole parsed notification reaches the browser VERBATIM — all four
    // fields, not just whichever one the frontend happened to read. #597 was a
    // field-name mismatch, and only an end-to-end shape assertion catches that.
    expect(text).toContain('"source":"osc9"');
    expect(text).toContain('"title":null');
    expect(text).toContain('"body":"Build finished, 3 tests failed"');
    expect(text).toContain('"ts":123');
    // Every attention payload is now identified so clients can dedup/replay.
    expect(text).toMatch(/"id":\d+/);
    expect(text).toContain('"epoch":"');
  });

  it('removes the session-manager listeners on stop (no leak across restarts)', async () => {
    await startRO();
    const em = sessionManager as unknown as EventEmitter;
    expect(em.listenerCount('session:critical')).toBe(1);
    expect(em.listenerCount('session:notification')).toBe(1);
    await server.stop();
    expect(em.listenerCount('session:critical')).toBe(0);
    expect(em.listenerCount('session:notification')).toBe(0);
  });
  it('sets frame/sniff/referrer protection on responses', async () => {
    const info = await startRO();
    const res = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  // W4 (#608): the HTML page carries the FULL policy — per-build inline-script
  // hashes instead of 'unsafe-inline', and connect-src 'self' so a future XSS
  // regression could execute but never exfiltrate the token.
  it('serves GET / with a full CSP: script hashes + connect-src self', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-csp-'));
    fs.writeFileSync(
      path.join(dir, 'terminal.html'),
      '<html><head><script>var a=1;</script></head><body><script>var b=2;</script></body></html>',
    );
    const deps = makeDeps();
    const csps = new WebTerminalServer({
      sessionManager: deps.sessionManager,
      log: () => { /* silent */ },
      assetsDir: dir,
    });
    try {
      const info = await csps.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
      const res = await fetch(`http://127.0.0.1:${info.port}/`);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // One hash per inline <script> block, no 'unsafe-inline' for scripts.
      expect(csp.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toHaveLength(2);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      // JSON/API responses keep the minimal baseline policy (no hashes needed).
      const api = await fetch(`http://127.0.0.1:${info.port}/api/config`, {
        headers: { Authorization: `Bearer ${info.token}` },
      });
      expect(api.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      if (csps.isRunning) await csps.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Raw request so we can set Host (undici forbids overriding it on fetch()). */
  const getWithHost = (port: number, path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpReq({ host: '127.0.0.1', port, path, headers: { Host: host } }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('rejects a request addressed to a foreign Host (DNS-rebinding guard)', async () => {
    const info = await startRO();
    const res = await getWithHost(info.port as number, '/api/pair?code=WHATEVER', 'evil.com');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('host not allowed');
  });

  it('accepts loopback Host names', async () => {
    const info = await startRO();
    const res = await getWithHost(info.port as number, '/api/config', `localhost:${info.port}`);
    // 401 (not 403) proves the host gate passed and the token gate took over.
    expect(res.status).toBe(401);
  });

  it('mints a replacement pairing code once the old one is burned', async () => {
    const info = await startRO();
    const first = info.pairCode as string;
    expect(first).toHaveLength(8);
    // Burn the attempt budget with wrong guesses.
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    }
    // Burned, and inside the regeneration cooldown: deliberately still gone.
    await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    expect(server.status().pairCode).toBeUndefined();

    // Past the cooldown, the next attempt mints a replacement so a burned code
    // costs a short wait instead of a server restart.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    try {
      await fetch(`http://127.0.0.1:${info.port}/api/pair?code=ZZZZZZZZ`);
    } finally {
      nowSpy.mockRestore();
    }
    const after = server.status().pairCode;
    expect(after).toHaveLength(8);
    expect(after).not.toBe(first);
  });
  it('names a pane by its program so an agent-less row is not just its own cwd twice', async () => {
    const info = await startRO();
    const res = await fetch(`http://127.0.0.1:${info.port}/api/sessions`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    const { sessions } = await res.json();
    // A quoted program path containing spaces must survive intact.
    expect(sessions[0].shell).toBe('pwsh');
    // A bare Windows path, and a POSIX one.
    expect(sessions[1].shell).toBe('pwsh');
    expect(sessions[2].shell).toBe('bash');
    // Arguments can carry secrets, so only the basename is ever surfaced.
    const wire = JSON.stringify(sessions);
    expect(wire).not.toContain('--token');
    expect(wire).not.toContain('Program Files');
  });

  it('carries the baseline security headers on the SSE stream response too', async () => {
    const info = await startRO();
    const ac = new AbortController();
    const sse = await fetch(
      `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
      { signal: ac.signal },
    );
    expect(sse.status).toBe(200);
    expect(sse.headers.get('x-frame-options')).toBe('DENY');
    expect(sse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(sse.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    ac.abort();
  });

  it('refuses a cross-site /api/pair load without touching the attempt budget', async () => {
    const info = await startRO();
    const code = info.pairCode as string;
    // A hostile page embedding <img src="http://127.0.0.1:<port>/api/pair?…">
    // reaches this route with Sec-Fetch-Site: cross-site stamped by the browser.
    const evil = await fetch(`${base()}/api/pair?code=ZZZZZZZZ`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error).toBe('cross-site request refused');
    // The attempt budget was untouched: the legitimate code still pairs.
    const ok = await fetch(`${base()}/api/pair?code=${code}`);
    expect(ok.status).toBe(200);
  });

  it('never advertises an expired pairing code — status() replaces it past the cooldown', async () => {
    const info = await startRO();
    const first = info.pairCode as string;
    // Jump past both the 10-min TTL and the 30-s regen cooldown.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60_000);
    try {
      const status = server.status();
      expect(status.pairCode).toHaveLength(8);
      expect(status.pairCode).not.toBe(first);
      expect(status.pairExpiresAt as number).toBeGreaterThan(realNow + 11 * 60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('accepts an operator-listed extra Host (reverse-proxy front, e.g. tailscale serve)', async () => {
    const info = await server.start({
      port: 0,
      host: '127.0.0.1',
      allowInput: false, allowUpload: false,
      allowedHosts: ['machine.tail-net.ts.net'],
    });
    // 401 (not 403) proves the host gate passed and the token gate took over.
    const ok = await getWithHost(info.port as number, '/api/config', 'machine.tail-net.ts.net');
    expect(ok.status).toBe(401);
    // Anything not listed is still rejected.
    const bad = await getWithHost(info.port as number, '/api/config', 'evil.com');
    expect(bad.status).toBe(403);
  });

  it('brackets an IPv6 bind host in the advertised URL', async () => {
    let info: Awaited<ReturnType<typeof server.start>>;
    try {
      info = await server.start({ port: 0, host: '::1', allowInput: false, allowUpload: false });
    } catch {
      return; // environment without IPv6 loopback — nothing to assert
    }
    expect(info.urls?.[0]).toBe(`http://[::1]:${info.port}/?token=${info.token}`);
  });

  it('does not leak session-manager listeners when the bind itself fails', async () => {
    // Occupy a port, then ask the web server to bind the same one.
    const blockerInfo = await startRO();
    const em = sessionManager as unknown as EventEmitter;
    const second = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    await expect(
      second.start({ port: blockerInfo.port as number, host: '127.0.0.1', allowInput: false, allowUpload: false }),
    ).rejects.toThrow();
    // Only the FIRST (running) server's listeners remain.
    expect(em.listenerCount('session:critical')).toBe(1);
    expect(em.listenerCount('session:notification')).toBe(1);
    expect(second.isRunning).toBe(false);
  });

  // ── /api/events — the durable attention channel (#598) ─────────────────────
  const emitNotify = (sessionId: string, body: string) =>
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId,
      event: { source: 'osc9', title: null, body, ts: 1 },
    });

  type Backlog = {
    epoch: string;
    headId: number;
    reset: boolean;
    events: Array<Record<string, unknown>>;
  };
  const backlog = async (token: string, since?: string): Promise<Backlog> => {
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await fetch(`${base()}/api/events${q}`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    return (await res.json()) as Backlog;
  };

  /**
   * `reader.read()` on a silent stream never settles, so polling the deadline
   * only BETWEEN reads hangs until the Vitest timeout. Race each read against
   * the remaining budget and treat `null` as "deadline hit, stop reading".
   */
  const readWithin = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    deadline: number,
  ): Promise<ReadableStreamReadResult<Uint8Array> | null> => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([reader.read(), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** Open the SSE variant and read until `want` appears (or the deadline). */
  const readEventStream = async (url: string, want: RegExp, headers: Record<string, string> = {}) => {
    const ac = new AbortController();
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream', ...headers },
    });
    let text = '';
    if (res.status === 200 && res.body) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 700;
      while (Date.now() < deadline && !want.test(text)) {
        const chunk = await readWithin(reader, deadline);
        if (!chunk || chunk.done) break;
        if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
      }
    }
    ac.abort();
    return { status: res.status, text };
  };

  it('★ delivers an attention event raised while NO client was connected', async () => {
    const info = await startRO();
    const token = info.token as string;

    // Nobody is watching — the pane-stream fan-out is a no-op. Before the
    // attention log this event was simply gone (#598).
    emitNotify('s3', 'Build finished, 3 tests failed');

    const data = await backlog(token);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({
      id: 1,
      kind: 'notify',
      sessionId: 's3',
      source: 'osc9',
      title: null,
      body: 'Build finished, 3 tests failed',
    });
    expect(data.headId).toBe(1);
  });

  it('★ never lets a pane-supplied payload shadow the server-assigned identity', async () => {
    const info = await startRO();
    const token = info.token as string;

    // A pane can put anything in the notification event — including keys that
    // collide with the fields the client dedups and resyncs on.
    (sessionManager as unknown as EventEmitter).emit('session:notification', {
      sessionId: 's3',
      event: { source: 'osc9', title: null, body: 'spoofed', id: 999999, epoch: 'evil', kind: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events).toHaveLength(1);
    expect(data.events[0].id).toBe(1);
    expect(data.events[0].kind).toBe('notify');
    expect(data.events[0].body).toBe('spoofed');
    expect(data.headId).toBe(1);

    // Same on the wire: the SSE body carries the server's id/epoch, not the payload's.
    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"body":"spoofed"/,
    );
    expect(out.text).toContain('"id":1');
    expect(out.text).not.toContain('"id":999999');
    expect(out.text).toContain(`"epoch":"${data.epoch}"`);
    expect(out.text).not.toContain('"epoch":"evil"');
  });

  it('★ treats a cursor from another epoch as a full resync', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s3', 'one');
    emitNotify('s3', 'two');

    const data = await backlog(token, 'bogus-epoch:57');
    expect(data.reset).toBe(true);
    expect(data.events.map((e) => e.body)).toEqual(['one', 'two']);
    expect(data.epoch).not.toBe('bogus-epoch');
  });

  it('★ gates /api/events like every other route — Bearer for JSON, ?token= for SSE only', async () => {
    const info = await startRO();
    const token = info.token as string;

    // JSON mode: no credentials, and a query token, are both refused.
    expect((await fetch(`${base()}/api/events`)).status).toBe(401);
    expect((await fetch(`${base()}/api/events?token=${encodeURIComponent(token)}`)).status).toBe(401);

    // SSE mode: `?token=` is accepted (EventSource cannot set headers)…
    const ok = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /event: reset/,
    );
    expect(ok.status).toBe(200);
    // …but only the real token.
    const bad = await readEventStream(`${base()}/api/events?token=nope`, /never/);
    expect(bad.status).toBe(401);
  });

  it('returns only what a matching cursor has not seen, and reports the head id', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s3', 'one');
    emitNotify('s3', 'two');
    emitNotify('s3', 'three');

    const all = await backlog(token);
    expect(all.reset).toBe(true);
    expect(all.headId).toBe(3);

    const since = await backlog(token, `${all.epoch}:2`);
    expect(since.reset).toBe(false);
    expect(since.events.map((e) => e.id)).toEqual([3]);
    expect(since.headId).toBe(3);

    // Fully caught up: nothing to replay, and still not a resync.
    const caughtUp = await backlog(token, `${all.epoch}:3`);
    expect(caughtUp.reset).toBe(false);
    expect(caughtUp.events).toEqual([]);
  });

  it('★ a cursor below the retained window is a RESET, not a silent gap', async () => {
    const info = await startRO();
    const token = info.token as string;

    // The phone saw event 1, then slept. 300 events happened; the log keeps the
    // newest 100, so 2..200 are gone forever.
    emitNotify('s9', 'seen');
    const first = await backlog(token);
    const cursor = `${first.epoch}:1`;
    for (let i = 0; i < 300; i++) emitNotify('s9', `burst-${i}`);

    const out = await backlog(token, cursor);
    // Same epoch, so this used to answer reset:false and hand back the tail —
    // and the client would treat that tail as contiguous with event 1, never
    // learning that 2..200 existed at all.
    expect(out.reset).toBe(true);
    expect(out.events.length).toBeLessThanOrEqual(100);
    expect(out.headId).toBe(301);

    // A cursor still INSIDE the window is unaffected: no false resyncs.
    const oldestHeld = out.events[0].id as number;
    const inside = await backlog(token, `${first.epoch}:${oldestHeld}`);
    expect(inside.reset).toBe(false);

    // The exact boundary — the cursor sits one below the oldest held entry, so
    // the very next event it needs is one we still have. Continuity holds.
    const boundary = await backlog(token, `${first.epoch}:${oldestHeld - 1}`);
    expect(boundary.reset).toBe(false);
    expect(boundary.events[0].id).toBe(oldestHeld);
  });

  it('an empty window is quiet, not lost, until something was actually missed', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s10', 'one');
    const seen = await backlog(token);

    // Caught up with an empty tail: nothing was missed, so no resync.
    const quiet = await backlog(token, `${seen.epoch}:1`);
    expect(quiet.reset).toBe(false);
    expect(quiet.events).toEqual([]);

    // A cursor that cannot have come from us in this epoch.
    const future = await backlog(token, `${seen.epoch}:999`);
    expect(future.reset).toBe(true);
  });

  it('evicts the oldest entries past the cap while ids stay monotonic', async () => {
    const info = await startRO();
    const token = info.token as string;
    const CAP = 100; // ATTENTION_CAP — module-private, asserted by behaviour
    for (let i = 1; i <= CAP + 10; i++) emitNotify('s3', `evt-${i}`);

    const data = await backlog(token);
    expect(data.events).toHaveLength(CAP);
    // The oldest ten are gone; the newest is kept; ids never restart.
    expect(data.events[0].id).toBe(11);
    expect(data.events[CAP - 1].id).toBe(CAP + 10);
    expect(data.events[CAP - 1].body).toBe(`evt-${CAP + 10}`);
    expect(data.headId).toBe(CAP + 10);
    const ids = data.events.map((e) => e.id as number);
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b));
  });

  it('evicts entries past the TTL (injected clock, no sleeping for 30 minutes)', async () => {
    // A dedicated server so the clock seam is under this test's control.
    let clock = 1_000_000;
    const aged = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      now: () => clock,
    });
    const info = await aged.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const token = info.token as string;
    const port = info.port as number;
    const em = sessionManager as unknown as EventEmitter;
    try {
      em.emit('session:notification', {
        sessionId: 's3',
        event: { source: 'osc9', title: null, body: 'stale', ts: 1 },
      });
      // Past the 30-minute TTL, then a fresh event so eviction runs.
      clock += 31 * 60 * 1000;
      em.emit('session:notification', {
        sessionId: 's3',
        event: { source: 'osc9', title: null, body: 'fresh', ts: 2 },
      });

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: bearer(token) });
      const data = (await res.json()) as Backlog;
      expect(data.events.map((e) => e.body)).toEqual(['fresh']);
      // The id space does NOT rewind just because an entry aged out.
      expect(data.headId).toBe(2);
    } finally {
      await aged.stop();
    }
  });

  it('SSE mode: emits ids, resets a foreign cursor, then replays before live events', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'backlogged');

    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events?token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const pump = async (until: RegExp) => {
      const deadline = Date.now() + 700;
      while (Date.now() < deadline && !until.test(text)) {
        const chunk = await readWithin(reader, deadline);
        if (!chunk || chunk.done) break;
        if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
      }
    };
    await pump(/"body":"backlogged"/);
    // No cursor at all → told to resync, then handed the whole window.
    expect(text).toContain('event: reset');
    expect(text).toMatch(/id: [0-9a-f-]+:1\n/);
    expect(text.indexOf('event: reset')).toBeLessThan(text.indexOf('"body":"backlogged"'));

    // Live events keep flowing on the same stream, after the replay.
    emitNotify('s2', 'live-one');
    await pump(/"body":"live-one"/);
    ac.abort();
    expect(text.indexOf('"body":"backlogged"')).toBeLessThan(text.indexOf('"body":"live-one"'));
    expect(text).toMatch(/id: [0-9a-f-]+:2\n/);
  });

  it('SSE mode: a matching cursor replays only the missed tail, with no reset', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'seen-already');
    emitNotify('s2', 'missed-it');
    const epoch = (await backlog(token)).epoch;

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}&since=${encodeURIComponent(`${epoch}:1`)}`,
      /"body":"missed-it"/,
    );
    expect(out.status).toBe(200);
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('seen-already');
    expect(out.text).toContain('"body":"missed-it"');
  });

  it('resumes from Last-Event-ID, which the browser resends on reconnect', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'before-drop');
    emitNotify('s2', 'after-drop');
    const epoch = (await backlog(token)).epoch;

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"body":"after-drop"/,
      { 'Last-Event-ID': `${epoch}:1` },
    );
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('before-drop');
  });

  it('drops /api/events subscribers on stop() without touching the log', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitNotify('s2', 'kept');
    await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    await server.stop();

    // A web-server restart is not an event-loss boundary: the daemon kept
    // running, so the recorded window (and its epoch) survives.
    const next = await startRO();
    const data = await backlog(next.token as string);
    expect(data.events.map((e) => e.body)).toEqual(['kept']);
  });

  // ── approvals (M2) ─────────────────────────────────────────────────────────
  const postApproval = (token: string, id: string, body: unknown) =>
    fetch(`${base()}/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('gates the approval routes on the Bearer token — a query token is not enough', async () => {
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval());

    expect((await fetch(`${base()}/api/approvals`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);

    // The resolve route is a write; an unauthenticated one must not reach the
    // registry at all, not merely fail late.
    const unauth = await fetch(`${base()}/api/approvals/ap-1`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(unauth.status).toBe(401);
    expect(resolveCalls).toEqual([]);
  });

  it('lists pending requests and the settled tail, projecting only browser-safe fields', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A record carrying registry-internal extras the projection must drop —
    // the registry is free to grow fields, the wire is not.
    approvalRecords.push({
      ...mkApproval({
        id: 'ap-pending',
        sessionId: 's2',
        screenTail: 'Allow edit to src/index.ts?',
        question: 'Which database should I use?',
        options: ['Postgres', 'SQLite'],
      }),
      keystrokes: 'y\r',
      paneEnv: { ANTHROPIC_API_KEY: 'sk-secret' },
      // The rest of the AskUserQuestion tool_input. Only question/options were
      // asked for; everything else stays daemon-side.
      toolInput: { header: 'Database', multiSelect: false, prompt: 'sk-tool-secret' },
    } as ApprovalRequest);
    approvalRecords.push(
      mkApproval({
        id: 'ap-done',
        state: 'resolved',
        decision: 'approve',
        resolvedBy: 'deck',
        resolvedAt: 1_700_000_000_900,
      }),
    );

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<Record<string, unknown>>;
      recentlyResolved: Array<Record<string, unknown>>;
    };

    expect(body.pending.map((r) => r.id)).toEqual(['ap-pending']);
    expect(body.pending[0]).toMatchObject({
      sessionId: 's2',
      agent: 'claude',
      kind: 'awaiting_input',
      state: 'pending',
      // The tail is the whole point of the list route: it is what the human
      // reads before answering from a phone.
      screenTail: 'Allow edit to src/index.ts?',
      // …and when the agent asked a structured question, the phone should not
      // have to reverse-engineer it out of a screen tail.
      question: 'Which database should I use?',
      options: ['Postgres', 'SQLite'],
    });
    // Settled requests ride along so a 409 can be explained, not just reported.
    // Bounding and ordering that half is the REGISTRY's job (it is the record of
    // what happened); this surface passes its answer through unreordered.
    expect(body.recentlyResolved.map((r) => r.id)).toEqual(['ap-done']);
    expect(body.recentlyResolved[0]).toMatchObject({
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'deck',
    });

    const wire = JSON.stringify(body);
    expect(wire).not.toContain('sk-secret');
    expect(wire).not.toContain('keystrokes');
    // question/options are the ONLY things extracted from the tool_input. The
    // rest of it — and any field a later registry change adds — must not ride
    // along just because it sits on the same record.
    expect(wire).not.toContain('toolInput');
    expect(wire).not.toContain('sk-tool-secret');
    expect(wire).not.toContain('multiSelect');
    expect(wire).not.toContain('"header"');
  });

  it('omits question/options entirely when the request has none', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A plain permission prompt: no AskUserQuestion, so no structured question.
    approvalRecords.push(mkApproval({ id: 'ap-plain' }));
    approvalRecords.push(mkApproval({ id: 'ap-plain-done', state: 'resolved', resolvedBy: 'web' }));

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as {
      pending: Array<Record<string, unknown>>;
      recentlyResolved: Array<Record<string, unknown>>;
    };
    // Absent, not null and not an empty string — the frontend renders on
    // presence, so a fabricated empty value would draw an empty question card.
    expect('question' in body.pending[0]).toBe(false);
    expect('options' in body.pending[0]).toBe(false);
    expect('question' in body.recentlyResolved[0]).toBe(false);
    expect('options' in body.recentlyResolved[0]).toBe(false);
  });

  it('carries the risk hint onto /api/approvals and the approval event, and omits it otherwise', async () => {
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-risky', risk: 'critical' }));
    approvalRecords.push(mkApproval({ id: 'ap-calm' }));

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as { pending: Array<Record<string, unknown>> };
    expect(body.pending[0]).toMatchObject({ id: 'ap-risky', risk: 'critical' });
    // Absent, not null: a client reads presence, and "no match" is not "safe".
    expect('risk' in body.pending[1]).toBe(false);

    emitApproval('create', mkApproval({ id: 'ap-risky', risk: 'critical' }));
    const data = await backlog(token);
    expect(data.events[0]).toMatchObject({ approvalId: 'ap-risky', risk: 'critical' });
  });

  it('★ projects the gate tool + input onto /api/approvals (#783)', async () => {
    // The SSE nudge carries these, but a client that connects with a gate
    // already pending builds its card from the LIST. Without them the operator
    // is asked to approve a shell command with nothing on screen naming it —
    // and `approvalWire` is an allowlist, so a new field reaches the wire only
    // by being added here.
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(
      mkApproval({
        id: 'ap-gate',
        kind: 'awaiting_permission',
        toolName: 'Bash',
        toolInputSummary: 'rm -rf /tmp/x',
      }),
    );
    approvalRecords.push(mkApproval({ id: 'ap-question' }));

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as { pending: Array<Record<string, unknown>> };
    expect(body.pending[0]).toMatchObject({
      id: 'ap-gate',
      kind: 'awaiting_permission',
      toolName: 'Bash',
      toolInputSummary: 'rm -rf /tmp/x',
    });
    // A screen-backed prompt has no tool — absent, not empty.
    expect('toolName' in body.pending[1]).toBe(false);
    expect('toolInputSummary' in body.pending[1]).toBe(false);
  });

  it('projects question/options on the settled half too, empty list included', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Both halves go through the same projection — a 409 explanation should be
    // able to say what was asked, not just that someone answered.
    approvalRecords.push(
      mkApproval({
        id: 'ap-answered',
        state: 'resolved',
        decision: 'approve',
        resolvedBy: 'deck',
        question: 'Ship it?',
        // An empty list is a recorded fact, not a missing field: presence, not
        // truthiness, decides whether it is projected.
        options: [],
      }),
    );

    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(token) });
    const body = (await res.json()) as { recentlyResolved: Array<Record<string, unknown>> };
    expect(body.recentlyResolved[0]).toMatchObject({
      id: 'ap-answered',
      question: 'Ship it?',
      options: [],
      resolvedBy: 'deck',
    });
  });

  it('★ resolves an approval on a READ-ONLY server, while /api/input on that same server stays 403', async () => {
    // The carve-out that makes M2 worth having: answering a prompt the daemon
    // raised is a narrower grant than --allow-input, so it must not require it.
    const info = await startRO();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-ro' }));

    const ok = await postApproval(token, 'ap-ro', { decision: 'approve' });
    expect(ok.status).toBe(200);
    // `durable` rides along so a client can say the answer landed but will not
    // be remembered, instead of that staying inside the daemon's log.
    expect(await ok.json()).toEqual({ state: 'resolved', durable: true });
    // The caller supplied a DECISION, never bytes; the registry picks those.
    // `resolvedBy` names WHO answered — here the operator token, not the
    // surface. It used to be the constant 'web' for every caller alike.
    expect(resolveCalls).toEqual([{ id: 'ap-ro', decision: 'approve', resolvedBy: 'operator' }]);

    // …and the carve-out is exactly one route wide. Free-form input is still
    // refused on this very same server.
    const input = await fetch(`${base()}/api/input?session=s1`, {
      method: 'POST',
      headers: bearer(token),
      body: 'rm -rf /\r',
    });
    expect(input.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it('★ canResolveGates tracks exactly what a gate resolve requires (#783)', async () => {
    // The daemon arms the permission gate only when this is true, so it must
    // agree with the route: a read-only server refuses an awaiting_permission
    // record, and arming against it would block the agent for the whole gate
    // deadline in front of a card nobody can answer.
    expect(server.canResolveGates).toBe(false); // not started
    const ro = await startRO();
    expect(server.canResolveGates).toBe(false);
    approvalRecords.push(mkApproval({ id: 'ap-gate-ro', kind: 'awaiting_permission', toolName: 'Bash' }));
    const refused = await postApproval(ro.token as string, 'ap-gate-ro', { decision: 'approve' });
    expect(refused.status).toBe(403);

    await server.stop();
    const rw = await startRW();
    expect(server.canResolveGates).toBe(true);
    approvalRecords.push(mkApproval({ id: 'ap-gate-rw', kind: 'awaiting_permission', toolName: 'Bash' }));
    const accepted = await postApproval(rw.token as string, 'ap-gate-rw', { decision: 'approve' });
    expect(accepted.status).toBe(200);

    await server.stop();
    expect(server.canResolveGates).toBe(false);
  });

  it('passes a deny through unchanged', async () => {
    const info = await startRO();
    approvalRecords.push(mkApproval({ id: 'ap-deny' }));
    const res = await postApproval(info.token as string, 'ap-deny', { decision: 'deny' });
    expect(res.status).toBe(200);
    expect(resolveCalls[0].decision).toBe('deny');
  });

  it('passes a valid choiceKey to the registry unchanged', async () => {
    const info = await startRO();
    approvalRecords.push(mkApproval({ id: 'ap-choice' }));
    const res = await postApproval(info.token as string, 'ap-choice', {
      decision: 'approve',
      choiceKey: '2',
    });
    expect(res.status).toBe(200);
    expect(resolveCalls).toEqual([{
      id: 'ap-choice',
      decision: 'approve',
      choiceKey: '2',
      resolvedBy: 'operator',
    }]);
  });

  it('rejects malformed or deny-side choiceKey without reaching the registry', async () => {
    const info = await startRO();
    const token = info.token as string;
    const bodies = [
      { decision: 'approve', choiceKey: '' },
      { decision: 'approve', choiceKey: 'abc' },
      { decision: 'approve', choiceKey: 2 },
      { decision: 'approve', choiceKey: null },
      { decision: 'deny', choiceKey: '2' },
    ];
    for (const body of bodies) {
      const res = await postApproval(token, 'ap-choice', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-choice-key' });
    }
    expect(resolveCalls).toEqual([]);
  });

  it('maps every registry refusal onto its own status code', async () => {
    const cases: Array<{ result: ApprovalResolveResult; status: number; body: Record<string, unknown> }> = [
      // Someone else answered first — and the loser is told who.
      {
        result: { ok: false, reason: 'already-resolved', resolvedBy: 'deck' },
        status: 409,
        body: { error: 'already-resolved', resolvedBy: 'deck' },
      },
      // Gone. 410, not 404: it existed, stop showing it.
      { result: { ok: false, reason: 'expired' }, status: 410, body: { error: 'expired' } },
      { result: { ok: false, reason: 'prompt-gone' }, status: 410, body: { error: 'prompt-gone' } },
      // A supersede reports reason 'expired' with the precise state on the
      // record — same status, different sentence for the human.
      {
        result: { ok: false, reason: 'expired', request: mkApproval({ state: 'superseded' }) },
        status: 410,
        body: { error: 'expired', state: 'superseded' },
      },
      // A well-formed key that is not valid for this live request stays pending.
      { result: { ok: false, reason: 'invalid-choice-key' }, status: 422, body: { error: 'invalid-choice-key' } },
      // No keystroke map for this agent — the daemon refuses to guess bytes.
      { result: { ok: false, reason: 'unsupported-agent' }, status: 501, body: { error: 'unsupported-agent' } },
      { result: { ok: false, reason: 'not-found' }, status: 404, body: { error: 'not-found' } },
    ];

    const info = await startRO();
    const token = info.token as string;
    for (const c of cases) {
      approvalBox.result = c.result;
      const res = await postApproval(token, 'ap-1', { decision: 'approve' });
      expect(res.status, `reason ${'reason' in c.result ? c.result.reason : 'ok'}`).toBe(c.status);
      expect(await res.json()).toEqual(c.body);
    }
  });

  it('refuses a body that is not an approve/deny decision, without touching the registry', async () => {
    const info = await startRO();
    const token = info.token as string;

    for (const body of [{ decision: 'maybe' }, { decision: true }, {}, '', 'not json']) {
      const res = await postApproval(token, 'ap-1', body);
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
    }
    // A decision the surface cannot understand must never reach a PTY.
    expect(resolveCalls).toEqual([]);
  });

  it('404s a resolve with no id at all', async () => {
    const info = await startRO();
    const res = await fetch(`${base()}/api/approvals/`, {
      method: 'POST',
      headers: bearer(info.token as string),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(404);
    expect(resolveCalls).toEqual([]);
  });

  it('answers 503 on a daemon that wired no registry (rather than pretending)', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const url = `http://127.0.0.1:${info.port}/api/approvals`;
    try {
      const list = await fetch(url, { headers: bearer(info.token as string) });
      expect(list.status).toBe(503);
      const resolve = await fetch(`${url}/ap-1`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(resolve.status).toBe(503);
    } finally {
      await bare.stop();
    }
  });

  it('★ publishes the approval lifecycle on /api/events, in the one shared id space', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-9', sessionId: 's2', screenTail: 'Allow edit to src/index.ts?' });

    emitApproval('create', rec);
    emitNotify('s3', 'unrelated'); // interleaved: one cursor covers both kinds
    emitApproval('resolve', {
      ...rec,
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'web',
      resolvedAt: 1_700_000_000_500,
    });

    const data = await backlog(token);
    expect(data.events.map((e) => e.kind)).toEqual(['approval', 'notify', 'approval']);
    expect(data.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(data.events[0]).toMatchObject({
      approvalId: 'ap-9',
      phase: 'create',
      state: 'pending',
      sessionId: 's2',
      agent: 'claude',
    });
    expect(data.events[2]).toMatchObject({
      approvalId: 'ap-9',
      phase: 'resolve',
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'web',
    });
    // The record's id is `approvalId` on the wire: `id` belongs to the replay
    // cursor, and a payload must never be able to shadow it.
    expect(data.events[0].id).toBe(1);
  });

  it('★ stamps a server-authoritative tier on every event kind', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-t', sessionId: 's2' });

    emitApproval('create', rec); // someone is blocked → act
    emitApproval('resolve', { ...rec, state: 'resolved', decision: 'approve' }); // echo → info
    emitApproval('expire', { ...rec, state: 'expired' }); // echo → info
    emitNotify('s3', 'build done'); // FYI → info
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's4',
      event: { action: 'rm -rf', riskLevel: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => [e.kind, e.tier])).toEqual([
      ['approval', 'act'],
      ['approval', 'info'],
      ['approval', 'info'],
      ['notify', 'info'],
      ['critical', 'act'],
    ]);
  });

  it('★ a review-level critical signal is info, not act', async () => {
    // The `critical` KIND names the channel, not the severity: CRITICAL_PATTERNS
    // carries two risk levels and the daemon puts both on it, so `DELETE FROM`
    // and `kubectl delete` arrive beside `rm -rf`. Waking a phone for the first
    // pair at the urgency of the second is how a person learns to ignore the
    // channel — and `hasCriticalRisk` already excludes review-level from "the
    // dangerous class", so mapping both to `act` contradicts it.
    const info = await startRO();
    const token = info.token as string;
    const em = sessionManager as unknown as EventEmitter;
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'DELETE FROM', riskLevel: 'review' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'kubectl delete', riskLevel: 'review' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'terraform destroy', riskLevel: 'critical' },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => [e.action, e.tier])).toEqual([
      ['DELETE FROM', 'info'],
      ['kubectl delete', 'info'],
      ['terraform destroy', 'act'],
    ]);
  });

  it('★ an unrecognised or missing riskLevel stays act', async () => {
    // Fail dangerous. The failure that matters is a destructive action
    // delivered quietly, not an FYI delivered loudly — so only the exact
    // literal 'review' softens the tier.
    const info = await startRO();
    const token = info.token as string;
    const em = sessionManager as unknown as EventEmitter;
    em.emit('session:critical', { sessionId: 's4', event: { action: 'no level' } });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'bogus', riskLevel: 'REVIEW' },
    });
    em.emit('session:critical', {
      sessionId: 's4',
      event: { action: 'object', riskLevel: { toString: 'review' } },
    });

    const data = await backlog(token);
    expect(data.events.map((e) => e.tier)).toEqual(['act', 'act', 'act']);
  });

  it('★ never lets a pane declare its own event non-urgent', async () => {
    const info = await startRO();
    const token = info.token as string;
    // A critical signal whose payload claims it is only FYI. The tier is the
    // server's judgement and is stamped after the payload spread.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's4',
      event: { action: 'rm -rf', riskLevel: 'critical', tier: 'info' },
    });

    const data = await backlog(token);
    expect(data.events[0].tier).toBe('act');

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"tier"/,
      {},
    );
    expect(out.text).toContain('"tier":"act"');
    expect(out.text).not.toContain('"tier":"info"');
  });

  it('★ replays a missed approval from Last-Event-ID, like any other event', async () => {
    const info = await startRO();
    const token = info.token as string;
    const rec = mkApproval({ id: 'ap-9', sessionId: 's2' });
    emitApproval('create', rec);
    emitApproval('expire', { ...rec, state: 'expired' });
    const epoch = (await backlog(token)).epoch;

    // A phone that saw the creation and then lost signal gets ONLY the expiry.
    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"phase":"expire"/,
      { 'Last-Event-ID': `${epoch}:1` },
    );
    expect(out.status).toBe(200);
    expect(out.text).toContain('event: approval');
    expect(out.text).not.toContain('event: reset');
    expect(out.text).not.toContain('"phase":"create"');
    expect(out.text).toMatch(/id: [0-9a-f-]+:2\n/);
  });

  it('delivers an approval live to an already-connected /api/events stream', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Emit AFTER the stream is open, so this covers the live path rather than
    // the replay one.
    setTimeout(() => emitApproval('create', mkApproval({ id: 'ap-live', sessionId: 's3' })), 20);

    const out = await readEventStream(
      `${base()}/api/events?token=${encodeURIComponent(token)}`,
      /"approvalId":"ap-live"/,
    );
    expect(out.status).toBe(200);
    expect(out.text).toContain('event: approval');
    expect(out.text).toContain('"phase":"create"');
  });

  it('keeps the tail AND the question off the event wire — the event is a nudge, the route is the truth', async () => {
    const info = await startRO();
    const token = info.token as string;
    emitApproval(
      'create',
      mkApproval({
        id: 'ap-tail',
        screenTail: 'SECRET-TAIL-CONTENT',
        question: 'QUESTION-BODY-TEXT',
        options: ['OPTION-ALPHA', 'OPTION-BETA'],
      }),
    );

    const data = await backlog(token);
    expect(data.events[0]).toMatchObject({ approvalId: 'ap-tail' });
    // None of the content fields ride the channel: they are fanned out to every
    // client and held in the replay window for the whole TTL. The event says
    // "something needs you", `GET /api/approvals` says what.
    const wire = JSON.stringify(data.events);
    expect(wire).not.toContain('SECRET-TAIL-CONTENT');
    expect(wire).not.toContain('QUESTION-BODY-TEXT');
    expect(wire).not.toContain('OPTION-ALPHA');
    expect(wire).not.toContain('OPTION-BETA');
  });

  it('does not tee approvals onto the pane streams (no old-frontend noise)', async () => {
    const info = await startRO();
    const token = info.token as string;
    const ac = new AbortController();
    const sse = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    emitApproval('create', mkApproval({ id: 'ap-pane' }));
    // A `critical` still rides the pane stream (back-compat), so waiting for it
    // proves the approval had its chance to appear and did not.
    (sessionManager as unknown as EventEmitter).emit('session:critical', {
      sessionId: 's2',
      event: { action: 'delete files' },
    });

    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !text.includes('event: critical')) {
      const chunk = await readWithin(reader, deadline);
      if (!chunk || chunk.done) break;
      if (chunk.value) text += Buffer.from(chunk.value).toString('utf8');
    }
    ac.abort();
    expect(text).toContain('event: critical');
    expect(text).not.toContain('event: approval');
    expect(text).not.toContain('ap-pane');
  });

  it('removes the registry listener on stop (no double-publish across restarts)', async () => {
    await startRO();
    expect(approvalListeners.size).toBe(1);
    await server.stop();
    expect(approvalListeners.size).toBe(0);
    // Restart: still exactly one, so an event is published once, not twice.
    await startRO();
    expect(approvalListeners.size).toBe(1);
  });

  it('survives a registry whose list() throws', async () => {
    const info = await startRO();
    approvalBox.listThrows = true;
    const res = await fetch(`${base()}/api/approvals`, { headers: bearer(info.token as string) });
    expect(res.status).toBe(500);
    // The server is still up and every other route still answers.
    expect((await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) })).status).toBe(200);
  });

  // ── per-device credentials (M3) ────────────────────────────────────────────

  /** Name a device, redeem its code, and return what the phone would store. */
  const pairDevice = async (name?: string, allowInput = true) => {
    const started = server.startPairing({ name, allowInput });
    if (!started.ok) throw new Error(`startPairing refused: ${started.error}`);
    const res = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { deviceId: string; deviceSecret: string; token: string };
  };

  /**
   * Per-device input grants — the gate.
   *
   * `--allow-input` is the CEILING and a device's own grant narrows within it.
   * Five routes share that one grant (typing, pane create, pane close, the
   * permission-gate toggle, and approving a tool permission), so each is
   * checked: a route that reads the server flag directly instead of asking
   * would be a hole nothing else covers.
   */
  describe('per-device input grants', () => {
    it('a device paired read-only is refused on every input route, on a server with input ON', async () => {
      await startRW();
      const viewer = await pairDevice('Wall display', false);
      const h = bearer(viewer.token);

      const typed = await fetch(`${base()}/api/input?session=s1`, { method: 'POST', headers: h, body: 'ls' });
      expect(typed.status).toBe(403);
      // The copy has to name the DEVICE, not the server — the operator reading
      // it on a phone would otherwise go restart a server that is already on.
      expect((await typed.json() as { error: string }).error).toContain('paired without permission');

      const created = await fetch(`${base()}/api/sessions`, {
        method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}',
      });
      expect(created.status).toBe(403);

      const deleted = await fetch(`${base()}/api/sessions/s1`, { method: 'DELETE', headers: h });
      expect(deleted.status).toBe(403);

      const gate = await fetch(`${base()}/api/gate/off`, { method: 'POST', headers: h });
      expect(gate.status).toBe(403);
    });

    it('a device paired with the grant still types', async () => {
      await startRW();
      const typer = await pairDevice('iPhone', true);
      const res = await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(typer.token), body: 'ls',
      });
      expect(res.status).toBe(204);
    });

    // The ceiling. A grant is not a way around a server the operator started
    // read-only, and the refusal must still blame the server so the fix is
    // findable.
    it('the server flag overrides a granted device', async () => {
      await startRO();
      const typer = await pairDevice('iPhone', true);
      const res = await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(typer.token), body: 'ls',
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toContain('without --allow-input');
    });

    // The operator token is the operator. The roster does not narrow a
    // credential they are holding at their own desk.
    it('the operator token is not narrowed by any device grant', async () => {
      const info = await startRW();
      await pairDevice('Wall display', false);
      const res = await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(info.token!), body: 'ls',
      });
      expect(res.status).toBe(204);
    });

    it('/api/config reports the CALLER grant, not the server flag', async () => {
      await startRW();
      const viewer = await pairDevice('Wall display', false);
      const typer = await pairDevice('iPhone', true);

      const asViewer = await (await fetch(`${base()}/api/config`, { headers: bearer(viewer.token) })).json() as { allowInput: boolean };
      const asTyper = await (await fetch(`${base()}/api/config`, { headers: bearer(typer.token) })).json() as { allowInput: boolean };
      // A read-only device that was told `true` here would render a composer
      // that 403s on every keystroke.
      expect(asViewer.allowInput).toBe(false);
      expect(asTyper.allowInput).toBe(true);
    });

    // A ticket exists because EventSource cannot set headers. It is not
    // revalidated against the roster while it lives, so it must never be a
    // path to input.
    /**
     * The headless case, and the reason the default is the server flag rather
     * than `false`. A box with no GUI mints its pairing code inside `start()`
     * with nobody present to tick anything, and the roster UI that could grant
     * input afterwards does not exist there. Defaulting to read-only would make
     * every device paired from a terminal permanently mute.
     */
    it('a code minted by start() inherits the server flag, so headless pairing still types', async () => {
      await startRW();
      const code = server.status().pairCode as string;
      const res = await fetch(`${base()}/api/pair?code=${code}`);
      expect(res.status).toBe(200);
      const { token } = await res.json() as { token: string };

      const typed = await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(token), body: 'ls',
      });
      expect(typed.status).toBe(204);
    });

    it('a second headless pairing is not downgraded by the first having been redeemed', async () => {
      await startRW();
      await fetch(`${base()}/api/pair?code=${server.status().pairCode as string}`);

      server.refreshPairCode();
      const second = await fetch(`${base()}/api/pair?code=${server.status().pairCode as string}`);
      expect(second.status).toBe(200);
      const { token } = await second.json() as { token: string };

      expect((await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(token), body: 'ls',
      })).status).toBe(204);
    });

    // An explicit refusal still wins over the server default — otherwise the
    // GUI's unticked checkbox would mean nothing on an input-enabled server.
    it('an explicit read-only pairing beats the server default', async () => {
      await startRW();
      const viewer = await pairDevice('Wall display', false);
      expect((await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(viewer.token), body: 'ls',
      })).status).toBe(403);
    });

    // The grant belongs to the PAIRING SESSION, like the pending name: a code
    // regenerated after a burned attempt budget is the same operator pairing
    // the same device, and must not quietly change what they chose. Pinned
    // because both reviewers read the preserved-vs-reset question as ambiguous.
    it('a regenerated code keeps the grant chosen for that pairing session', async () => {
      await startRW();
      const started = server.startPairing({ name: 'Wall display', allowInput: false });
      expect(started.ok).toBe(true);

      for (let i = 0; i < 5; i++) await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
      let replacement: string;
      try {
        await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
        replacement = server.status().pairCode as string;
      } finally {
        nowSpy.mockRestore();
      }

      const res = await fetch(`${base()}/api/pair?code=${replacement}`);
      expect(res.status).toBe(200);
      const { token } = await res.json() as { token: string };
      // Still read-only: the replacement carried the session's own decision,
      // not the server default it would otherwise have fallen back to.
      expect((await fetch(`${base()}/api/input?session=s1`, {
        method: 'POST', headers: bearer(token), body: 'ls',
      })).status).toBe(403);
    });

    it('a stream ticket never carries an input grant', async () => {
      await startRW();
      const typer = await pairDevice('iPhone', true);
      const issued = await fetch(`${base()}/api/stream-ticket`, { method: 'POST', headers: bearer(typer.token) });
      expect(issued.status).toBe(200);
      const { ticket } = await issued.json() as { ticket: string };

      const res = await fetch(`${base()}/api/input?session=s1&token=${encodeURIComponent(ticket)}`, {
        method: 'POST', body: 'ls',
      });
      expect(res.status).not.toBe(200);
    });
  });

  /** Open a pane SSE stream with a credential in the Authorization header. */
  const openStream = async (cred: string) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/stream?session=s1`, { signal: ac.signal, headers: bearer(cred) });
    const reader = res.body ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
    return { ac, res, reader };
  };

  /** Open the attention SSE stream with a credential in the Authorization header. */
  const openEvents = async (cred: string) => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events`, {
      signal: ac.signal,
      headers: { ...bearer(cred), Accept: 'text/event-stream' },
    });
    const reader = res.body ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
    return { ac, res, reader };
  };

  /** True once the SERVER ends the stream; false if it is still open at the deadline. */
  const closedWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await readWithin(reader, deadline);
      if (!chunk) return false; // deadline hit with the stream still alive
      if (chunk.done) return true;
    }
    return false;
  };

  it('★ pairs a NAMED device and hands it its own credential, not the shared token', async () => {
    const info = await startRO();
    const paired = await pairDevice('Wife phone');

    expect(paired.deviceId).toBe('dev-1');
    // The composed `deviceId.secret` is what the client presents as its Bearer;
    // the operator token is a different secret and stays with the operator.
    expect(paired.token).toBe(`${paired.deviceId}.${paired.deviceSecret}`);
    expect(paired.token).not.toBe(info.token);
    // The operator named the device BEFORE the code existed (§3): a roster of
    // UUIDs cannot be operated, so the name has to reach the store.
    // The grant rides with the name for the same reason: both are decided at
    // the desk, and the phone types only a code.
    expect(deviceMintCalls).toEqual([{ name: 'Wife phone', allowInput: true }]);

    // A second pairing is a DIFFERENT device — that is the whole point.
    const second = await pairDevice('Tablet');
    expect(second.deviceId).not.toBe(paired.deviceId);
    expect(second.deviceSecret).not.toBe(paired.deviceSecret);
  });

  it('★ a device registers where to push to it; the operator token cannot', async () => {
    const info = await startRO();
    const { token } = await pairDevice('Phone');
    const apnsToken = 'a'.repeat(64);
    const publicKey = Buffer.alloc(32, 3).toString('base64');
    const post = (auth: string, body: unknown) =>
      fetch(`${base()}/api/push-registration`, {
        method: 'POST',
        headers: { ...bearer(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const ok = await post(token, { apnsToken, publicKey });
    expect(ok.status).toBe(200);
    expect(pushRegistrations.at(-1)).toEqual({ deviceId: 'dev-1', apnsToken, publicKey });

    // The operator token names no device, so there is nothing to register it
    // against — 403 beats inventing an association.
    const asOperator = await post(info.token as string, { apnsToken, publicKey });
    expect(asOperator.status).toBe(403);
    expect((await asOperator.json()).error).toBe('push-is-for-devices');
  });

  it('★ carries the APNs stage the build named, and omits it when it named none', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const apnsToken = 'a'.repeat(64);
    const publicKey = Buffer.alloc(32, 3).toString('base64');
    const post = (body: unknown) =>
      fetch(`${base()}/api/push-registration`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await post({ apnsToken, publicKey, apnsEnvironment: 'development' })).status).toBe(200);
    expect(pushRegistrations.at(-1)).toEqual({
      deviceId: 'dev-1', apnsToken, publicKey, apnsEnvironment: 'development',
    });

    // ABSENT STAYS ABSENT. The simulator has no provisioning profile to read a
    // stage out of, and a stage guessed here routes the token to the host that
    // rejects it — a BadDeviceToken that traces back to nothing.
    expect((await post({ apnsToken, publicKey })).status).toBe(200);
    expect(pushRegistrations.at(-1)).toEqual({ deviceId: 'dev-1', apnsToken, publicKey });

    // Present but not one of Apple's two words is a client bug, said out loud.
    for (const apnsEnvironment of ['staging', null, 42, { env: 'production' }, ['production']]) {
      const bad = await post({ apnsToken, publicKey, apnsEnvironment });
      // ★ A non-STRING must not be coerced to absent. Silently doing that
      // answers 200 while the wholesale replace deletes a stage the daemon
      // already knew — routing that device to the host that rejects it, in
      // answer to a request the contract promises to refuse.
      expect(bad.status, JSON.stringify(apnsEnvironment)).toBe(400);
      expect((await bad.json()).error).toBe('bad-apns-environment');
    }
  });

  it('★ survives a JSON body that is a scalar, on every route that reads one', async () => {
    // `123` is valid JSON. It reaches a handler as a NUMBER, `(body ?? {})`
    // leaves it one, and `'field' in 123` is a TypeError thrown inside
    // `req.on('end')` — where nothing catches it. That is one line of request
    // body from any paired device taking the daemon down with it.
    const info = await startRW();
    const { token } = await pairDevice('Phone');
    const scalars = ['123', '"production"', 'true', 'null', '[]'];
    const routes: Array<[string, string]> = [
      ['POST', '/api/push-registration'],
      ['POST', '/api/sessions/s1/resize'],
      ['POST', '/api/sessions'],
      ['POST', `/api/approvals/${'ap-scalar'}`],
    ];
    approvalRecords.push(mkApproval({ id: 'ap-scalar' }));

    for (const [method, path] of routes) {
      for (const body of scalars) {
        const res = await fetch(`${base()}${path}`, {
          method,
          headers: { ...bearer(token), 'Content-Type': 'application/json' },
          body,
        });
        // Any answer is fine — 400, 404, 409. What must NOT happen is the
        // socket dying because the handler threw.
        expect(res.status, `${method} ${path} ← ${body}`).toBeLessThan(500);
      }
    }
    // Still serving after all of that.
    expect((await fetch(`${base()}/api/config`, { headers: bearer(token) })).status).toBe(200);
    expect(info.running).toBe(true);
  });

  it('rejects a malformed token or key with 400', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const post = (body: unknown) =>
      fetch(`${base()}/api/push-registration`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const badToken = await post({ apnsToken: 'nope', publicKey: Buffer.alloc(32).toString('base64') });
    expect(badToken.status).toBe(400);
    expect((await badToken.json()).error).toBe('bad-token');

    const badKey = await post({ apnsToken: 'a'.repeat(64), publicKey: 'nope' });
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).error).toBe('bad-key');
  });

  it('★ a device registers its Live Activity tokens; the operator token cannot', async () => {
    const info = await startRO();
    const { token } = await pairDevice('Phone');
    const pushToStartToken = 'a'.repeat(64);
    const activityToken = 'b'.repeat(64);
    const post = (auth: string, body: unknown) =>
      fetch(`${base()}/api/live-activity-registration`, {
        method: 'POST',
        headers: { ...bearer(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const ok = await post(token, { pushToStartToken, apnsEnvironment: 'development' });
    expect(ok.status).toBe(200);
    expect(liveActivityRegistrations.at(-1)).toEqual({
      deviceId: 'dev-1',
      pushToStartToken,
      apnsEnvironment: 'development',
    });

    // ★ The activity token arrives LATER, in its own call. What reaches the
    // store must carry only that field — an omitted one means "leave it", and
    // the store is the thing that merges.
    const before = liveActivityRegisteredCalls;
    expect((await post(token, { activityToken })).status).toBe(200);
    expect(liveActivityRegistrations.at(-1)).toEqual({ deviceId: 'dev-1', activityToken });
    // ★ …and the daemon hears about it, so numbers that moved while the token
    // was in flight reach the lock screen now rather than at the next approval.
    expect(liveActivityRegisteredCalls).toBe(before + 1);

    // ★ `null` is NOT absence on this route: it is "the activity is over".
    expect((await post(token, { activityToken: null })).status).toBe(200);
    expect(liveActivityRegistrations.at(-1)).toEqual({ deviceId: 'dev-1', activityToken: null });
    // ★ …and it must not re-run the decision, which would start a new activity
    // the moment the old one was dismissed.
    expect(liveActivityRegisteredCalls).toBe(before + 1);

    // The operator token names no device, so there is no activity to register.
    const asOperator = await post(info.token as string, { pushToStartToken });
    expect(asOperator.status).toBe(403);
    expect((await asOperator.json()).error).toBe('push-is-for-devices');
  });

  it('refuses a malformed activity token and an unknown APNs stage with 400', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const post = (body: unknown) =>
      fetch(`${base()}/api/live-activity-registration`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const badToken = await post({ activityToken: 'nope' });
    expect(badToken.status).toBe(400);
    expect((await badToken.json()).error).toBe('bad-token');

    const badStage = await post({ pushToStartToken: 'a'.repeat(64), apnsEnvironment: 'staging' });
    expect(badStage.status).toBe(400);
    expect((await badStage.json()).error).toBe('bad-apns-environment');
  });

  it('★ the store refusals that are not the caller fault come back as 409', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const post = () =>
      fetch(`${base()}/api/live-activity-registration`, {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushToStartToken: 'a'.repeat(64) }),
      });

    // A device revoked between the auth check and the write, a record that
    // vanished, and a roster that could not be written are all 409: the request
    // was fine, the daemon could not honour it.
    for (const reason of ['revoked', 'not-found', 'persist-failed']) {
      liveActivityBox.reason = reason;
      const res = await post();
      expect(res.status, reason).toBe(409);
      expect((await res.json()).error).toBe(reason);
    }
    // Nothing was stored, so there is nothing to catch up on.
    expect(liveActivityRegisteredCalls).toBe(0);
    liveActivityBox.reason = '';
    expect((await post()).status).toBe(200);
  });

  it('★ /api/config says this daemon can drive a Live Activity', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const cfg = await (await fetch(`${base()}/api/config`, { headers: bearer(token) })).json();
    // The phone hands the daemon the start decision only on this flag; a
    // daemon that omits it keeps the app starting the activity locally.
    expect(cfg.liveActivityPush).toBe(true);
  });

  it('★ …and OMITS the key when the pusher is inert, exactly as an old daemon does', async () => {
    // No relay configured → the pusher can send nothing. Reporting `true` here
    // would tell the phone to stop starting the activity itself and wait for a
    // push that is never coming — a lock screen that simply goes quiet.
    liveActivityPushEnabled = false;
    await startRO();
    const { token } = await pairDevice('Phone');
    const res = await fetch(`${base()}/api/config`, { headers: bearer(token) });
    const wire = await res.text();
    // The KEY is gone, not set to false: a daemon that predates the feature
    // answers the same shape, and the phone must read the two identically.
    expect(wire).not.toContain('liveActivityPush');
    expect('liveActivityPush' in JSON.parse(wire)).toBe(false);
  });

  it('★ authenticates the routes a phone actually uses with a device credential', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    approvalRecords.push(mkApproval({ id: 'ap-dev' }));

    expect((await fetch(`${base()}/api/config`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/events`, { headers: bearer(token) })).status).toBe(200);

    // Answering a prompt is the reason the phone exists; a device must be able
    // to do it on a read-only server exactly as the operator can.
    const resolved = await postApproval(token, 'ap-dev', { decision: 'approve' });
    expect(resolved.status).toBe(200);
    // ★ The record names the DEVICE that pressed the key. This is the one
    // action in the whole surface that writes bytes into somebody's terminal,
    // and it used to be attributed to the constant 'web' — so after the fact
    // the roster could not say which paired phone did it.
    expect(resolveCalls).toEqual([
      { id: 'ap-dev', decision: 'approve', resolvedBy: 'device Phone (dev-1)' },
    ]);

    // Every authenticated device request is reported to the roster, so
    // `lastSeenAt` reflects use rather than only the pairing moment.
    expect(deviceTouchCalls.length).toBeGreaterThan(0);
    expect(new Set(deviceTouchCalls)).toEqual(new Set(['dev-1']));

    // Both SSE routes, credential in the header.
    const pane = await openStream(token);
    expect(pane.res.status).toBe(200);
    pane.ac.abort();
    const attn = await openEvents(token);
    expect(attn.res.status).toBe(200);
    attn.ac.abort();
  });

  it('★ leaves the operator token authenticating every route, device store or not', async () => {
    const info = await startRW();
    const token = info.token as string;
    approvalRecords.push(mkApproval({ id: 'ap-op' }));

    expect((await fetch(`${base()}/api/config`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).status).toBe(200);
    expect((await fetch(`${base()}/api/approvals`, { headers: bearer(token) })).status).toBe(200);
    expect((await postApproval(token, 'ap-op', { decision: 'deny' })).status).toBe(200);
    expect(
      (await fetch(`${base()}/api/input?session=s1`, { method: 'POST', headers: bearer(token), body: 'hi' })).status,
    ).toBe(204);

    // Including the `?token=` SSE exception, which is what the CLI's advertised
    // `http://…/?token=…` URLs rely on.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();
    const attn = await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    expect(attn.status).toBe(200);

    // …and the daemon-side control surface is untouched by M3.
    expect(server.status().token).toBe(token);
    expect(server.refreshPairCode().pairCode).toMatch(pairCodePattern);
  });

  it('★ 401s a revoked device with reason `revoked` AND kills its live streams at once', async () => {
    await startRO();
    const victim = await pairDevice('Old phone');
    const bystander = await pairDevice('Keeps working');

    const victimPane = await openStream(victim.token);
    const victimAttn = await openEvents(victim.token);
    const bystanderPane = await openStream(bystander.token);
    expect(victimPane.res.status).toBe(200);
    expect(victimAttn.res.status).toBe(200);
    expect(bystanderPane.res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    // The store's half of a revoke (Worker A persists first); then the seam the
    // daemon calls to make it immediate rather than eventual.
    deviceRoster.get(victim.deviceId)!.revoked = true;
    expect(server.disconnectDevice(victim.deviceId)).toBe(2);

    // The revoked device's streams are gone NOW, not on its next reconnect.
    expect(await closedWithin(victimPane.reader!, 1000)).toBe(true);
    expect(await closedWithin(victimAttn.reader!, 1000)).toBe(true);
    // …and nobody else's are.
    expect(await closedWithin(bystanderPane.reader!, 150)).toBe(false);

    // The next request says WHY, so the phone can show honest copy instead of
    // guessing between "server restarted" and "you were thrown out".
    const after = await fetch(`${base()}/api/sessions`, { headers: bearer(victim.token) });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: 'unauthorized', reason: 'revoked' });

    // The bystander is unaffected by its neighbour's revocation.
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(bystander.token) })).status).toBe(200);

    victimPane.ac.abort();
    victimAttn.ac.abort();
    bystanderPane.ac.abort();
  });

  it('distinguishes an unknown credential from a revoked one', async () => {
    const info = await startRO();
    await pairDevice('Phone');

    // A credential from another daemon / a wiped roster.
    const unknown = await fetch(`${base()}/api/sessions`, { headers: bearer('dev-404.whatever') });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'unauthorized', reason: 'unknown' });

    // The right device id with the wrong secret is 'unknown' too — never
    // 'revoked', which would confirm the id exists.
    const wrongSecret = await fetch(`${base()}/api/sessions`, { headers: bearer('dev-1.not-the-secret') });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).reason).toBe('unknown');

    // A bad operator token reads the same way.
    const badToken = await fetch(`${base()}/api/sessions`, { headers: bearer(`${info.token}x`) });
    expect(badToken.status).toBe(401);
    expect((await badToken.json()).reason).toBe('unknown');
  });

  it('★ refuses a device credential in ?token= — the SSE query exception is operator-only', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const q = encodeURIComponent(token);

    // A device secret is durable and never expires; a query string is the one
    // place a credential is guaranteed to be written down.
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${q}`);
    expect(pane.status).toBe(401);
    expect((await pane.json()).reason).toBe('unknown');
    const attn = await readEventStream(`${base()}/api/events?token=${q}`, /never/);
    expect(attn.status).toBe(401);

    // The same credential in the header opens both.
    const okPane = await openStream(token);
    expect(okPane.res.status).toBe(200);
    okPane.ac.abort();
  });

  /**
   * The pairing code as the WIRE sees it.
   *
   * `start()` always mints one (:481), but `status()` withholds it whenever
   * `mintRefusal()` fires, so the operator is never handed a code that is
   * guaranteed to 403. Tests that exercise the refusal at redemption still need
   * the real value, and reaching past the operator surface is the honest way to
   * say "this is not what a human would see."
   */
  function livePairCode(s: WebTerminalServer): string {
    return (s as unknown as { pairCode: string }).pairCode;
  }

  it('★ status withholds the pairing code on a bind that can never redeem it', async () => {
    // The bug this closes: status() regenerates a code lazily and used to do it
    // without asking whether the server could mint a credential at all. On an
    // exposed bind the GUI showed a fresh 8-character code every poll, the operator
    // read one onto a phone, and only the redemption said 403.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
    expect(info.running).toBe(true);

    const status = server.status();
    expect(status.pairRefusal?.reason).toBe('insecure-transport');
    // The detail is operator prose for logs and tooltips — it must still name
    // the encrypted way out, because it is what a support question gets answered with.
    expect(status.pairRefusal?.detail).toContain('wmux web --tailscale');
    expect(status.pairRefusal?.detail).toContain('--tls-cert');
    // No code, and no expiry for a code that does not exist.
    expect(status.pairCode).toBeUndefined();
    expect(status.pairExpiresAt).toBeUndefined();
  });

  it('★ status advertises a pairing code normally on loopback', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    expect(info.running).toBe(true);

    const status = server.status();
    // The refusal is absent, not merely falsy-but-present: the renderer keys
    // its whole pairing block on this field being undefined.
    expect(status.pairRefusal).toBeUndefined();
    expect(status.pairCode).toMatch(pairCodePattern);
    expect(typeof status.pairExpiresAt).toBe('number');
  });

  it('★ refuses to mint over a plaintext bind, and --allow-host does NOT buy an exception', async () => {
    // A real non-loopback bind: the gate reads the BIND, because that is the
    // only thing about the transport the daemon actually knows.
    const info = await server.start({ port: 0, host: '0.0.0.0', allowInput: false, allowUpload: false });
    const port = info.port as number;

    const refusedUpFront = server.startPairing({ name: 'Phone' });
    expect(refusedUpFront.ok).toBe(false);
    if (!refusedUpFront.ok) {
      // Actionable: it names the encrypted paths and the limited loopback
      // workaround, not just the refusal.
      expect(refusedUpFront.error).toContain('--tls-cert');
      expect(refusedUpFront.error).toContain('wmux web --tailscale');
      expect(refusedUpFront.error).toContain('pair over loopback');
      // …and does not oversell the second one: on a plaintext bind the
      // credential still crosses the wire on every request afterwards.
      expect(refusedUpFront.error).toContain('every later request');
    }

    // And redemption refuses too, since the operator may have re-exposed the
    // server after minting a code. The code is NOT burned by the refusal.
    //
    // Read straight off the instance rather than through status(): a code is
    // still minted on start(), but status() deliberately withholds it on a bind
    // that could never redeem it. This test is about the WIRE refusal, so it
    // needs the live code the wire would see, not the operator-facing view.
    const code = livePairCode(server);
    const denied = await getWithHost(port, `/api/pair?code=${code}`, `127.0.0.1:${port}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
    expect(livePairCode(server)).toBe(code);
  });

  it('★ a forged Host cannot talk a plaintext bind into minting a credential', async () => {
    // This used to work. `--allow-host` named the TLS front, and a request whose
    // Host matched was allowed to mint — but Host is written by the caller, so
    // anyone who could reach the plaintext port (and had the pair code) sent
    // `Host: machine.tail-net.ts.net` straight to the LAN address, skipped the
    // TLS front, and walked off with a credential that never expires.
    const fronted = await server.start({
      port: 0,
      host: '0.0.0.0',
      allowInput: false, allowUpload: false,
      allowedHosts: ['machine.tail-net.ts.net'],
    });

    // Refused up front now: --allow-host is a DNS-rebinding allowlist, not
    // evidence that this particular connection was encrypted.
    const started = server.startPairing({ name: 'Phone' });
    expect(started.ok).toBe(false);

    // …and the same is true at redemption, sending the exact header an attacker
    // would forge. Nothing is minted. (See livePairCode — status() withholds the
    // code here, but the wire still has one to refuse.)
    const code = livePairCode(server);
    const forged = await getWithHost(
      fronted.port as number,
      `/api/pair?code=${code}`,
      'machine.tail-net.ts.net',
    );
    expect(forged.status).toBe(403);
    expect(JSON.parse(forged.body).error).toBe('insecure-transport');
    expect(deviceMintCalls).toEqual([]);
  });

  it('★ status names the TLS front, which is the only address a phone can use', async () => {
    // The supported phone setup binds LOOPBACK and lets `tailscale serve`
    // terminate HTTPS, so reporting the bind alone was correct and useless.
    const info = await server.start({
      port: 0,
      host: '127.0.0.1',
      allowInput: false, allowUpload: false,
      allowedHosts: ['Machine.tail-net.ts.net'],
    });
    const status = server.status();

    expect(status.allowedHosts).toEqual(['machine.tail-net.ts.net']);
    // The front comes first, and carries no port: it terminates TLS on 443.
    expect((status.urls ?? [])[0]).toBe(
      `https://machine.tail-net.ts.net/?token=${info.token as string}`,
    );
    // The loopback URL is still there for someone sitting at the desktop.
    expect((status.urls ?? []).some((u) => u.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('reports no fronts when none were named', async () => {
    await startRO();
    const status = server.status();
    expect(status.allowedHosts).toEqual([]);
    expect((status.urls ?? []).every((u) => u.startsWith('http://'))).toBe(true);
  });

  it('mints on a loopback bind without an allow-host front', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Desk browser' });
    expect(started.ok).toBe(true);
  });

  it('does not burn the pairing code when the roster cannot be persisted', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Phone' });
    if (!started.ok) throw new Error(started.error);
    deviceBox.mintThrows = true;

    const failed = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(failed.status).toBe(500);
    // A credential the daemon cannot remember is one the operator can never
    // revoke, so it must not be handed out — and the operator must not be left
    // re-reading a code that has already been consumed.
    expect(server.status().pairCode).toBe(started.code);

    deviceBox.mintThrows = false;
    const retried = await fetch(`${base()}/api/pair?code=${started.code}`);
    expect(retried.status).toBe(200);
  });

  it('★ status() says out loud whether per-device revocation is actually armed', async () => {
    // Armed: a store is wired, so the operator can cut off one phone.
    const armed = await startRO();
    expect(armed.deviceCredentials).toBe(true);
    expect(server.status().deviceCredentials).toBe(true);

    // NOT armed: pairing still works, but it hands out the shared token and
    // there is nothing to revoke device-by-device. An operator who believed
    // otherwise would leave a lost phone's access alive thinking they cut it,
    // so this must reach `wmux web --status` and the GUI — not just a log line.
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    try {
      const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
      expect(info.deviceCredentials).toBe(false);
      // Explicitly false, never absent: a missing field reads as "old daemon"
      // on the GUI side and would be rendered as unknown rather than as off.
      expect('deviceCredentials' in info).toBe(true);
    } finally {
      await bare.stop();
    }

    // A stopped server has no posture to report.
    expect(await bare.stop()).toEqual({ stopped: false });
    expect(bare.status()).toEqual({ running: false });
  });

  it('falls back to the shared token on a daemon that wired no device store', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/pair?code=${info.pairCode}`);
      expect(res.status).toBe(200);
      // Degraded, not broken: pairing still works, but there is no per-device
      // identity to revoke on this server.
      expect(await res.json()).toEqual({ token: info.token });
      // And a device-shaped credential authenticates nothing here.
      const dev = await fetch(`http://127.0.0.1:${info.port}/api/sessions`, { headers: bearer('dev-1.s3cr3t-1') });
      expect(dev.status).toBe(401);
    } finally {
      await bare.stop();
    }
  });

  it('keeps the pairing name across a burned code, and drops it once redeemed', async () => {
    await startRO();
    const started = server.startPairing({ name: 'Named phone' });
    if (!started.ok) throw new Error(started.error);

    // Burn the attempt budget, wait out the cooldown, and let the server mint a
    // replacement code: the operator is still pairing the SAME device.
    for (let i = 0; i < 5; i++) await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    let replacement: string;
    try {
      await fetch(`${base()}/api/pair?code=ZZZZZZZZ`);
      replacement = server.status().pairCode as string;
    } finally {
      nowSpy.mockRestore();
    }
    expect(replacement).toHaveLength(8);
    expect(replacement).not.toBe(started.code);

    const paired = await fetch(`${base()}/api/pair?code=${replacement}`);
    expect(paired.status).toBe(200);
    // `startPairing` was called with a name and no grant, so the device
    // registers read-only — an unstated grant is never read as "yes".
    expect(deviceMintCalls).toEqual([{ name: 'Named phone', allowInput: false }]);

    // Redeeming consumes the name AND the grant: the next device inherits
    // neither. A code minted without a fresh decision registers a read-only
    // device rather than quietly handing on the last one's keyboard.
    server.refreshPairCode();
    const next = server.status().pairCode as string;
    expect((await fetch(`${base()}/api/pair?code=${next}`)).status).toBe(200);
    expect(deviceMintCalls[1]).toEqual({ name: undefined, allowInput: false });
  });

  // ── stream tickets (B3) ────────────────────────────────────────────────────

  /** Ask for the `?ticket=` capability the way a browser device would. */
  const getTicket = (cred: string) =>
    fetch(`${base()}/api/stream-ticket`, { method: 'POST', headers: bearer(cred) });

  const ticketFor = async (cred: string): Promise<string> => {
    const res = await getTicket(cred);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresAt: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    return body.ticket;
  };

  it('★ issues a stream ticket to a device, and it opens BOTH SSE routes', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);

    // The whole point: a URL a browser EventSource can actually be given.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();

    const attn = await readEventStream(
      `${base()}/api/events?ticket=${encodeURIComponent(ticket)}`,
      /event: reset/,
    );
    expect(attn.status).toBe(200);

    // NOT single-use — EventSource retries the same URL, so burning it on first
    // use would make the first ordinary reconnect a permanent failure.
    const again = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
    expect(again.status).toBe(200);
  });

  it('issues tickets ONLY to devices — the operator is told to use ?token=', async () => {
    const info = await startRO();
    const refused = await getTicket(info.token as string);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('tickets-are-for-devices');

    // And an unauthenticated / unknown caller never reaches the issuer at all.
    expect((await fetch(`${base()}/api/stream-ticket`, { method: 'POST' })).status).toBe(401);
    expect((await getTicket('dev-404.nope')).status).toBe(401);
  });

  it('a ticket is a capability, not a credential — it opens streams and nothing else', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);
    const q = encodeURIComponent(ticket);

    // Non-SSE routes never consult it, whatever it is presented as.
    expect((await fetch(`${base()}/api/sessions?ticket=${q}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/approvals?ticket=${q}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions`, { headers: bearer(ticket) })).status).toBe(401);
    // Including the issuer itself: a ticket cannot mint another ticket.
    expect((await getTicket(ticket)).status).toBe(401);
  });

  it('★ rejects an expired ticket (injected clock, no two-minute sleep)', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 121_000);
    try {
      const stale = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
      expect(stale.status).toBe(401);
      expect((await stale.json()).reason).toBe('unknown');
    } finally {
      nowSpy.mockRestore();
    }

    // The device's own credential is untouched by its ticket expiring — it just
    // asks for another one.
    const fresh = await ticketFor(token);
    expect(fresh).not.toBe(ticket);
    const ok = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(fresh)}`);
    expect(ok.status).toBe(200);
  });

  it('★ revoke invalidates outstanding tickets AND open streams, leaving others alone', async () => {
    await startRO();
    const victim = await pairDevice('Old phone');
    const bystander = await pairDevice('Keeps working');
    const victimTicket = await ticketFor(victim.token);
    const bystanderTicket = await ticketFor(bystander.token);

    // A stream opened WITH the ticket must be torn down like any other: the
    // ticket path tags the client with the device, which is what makes it
    // reachable by disconnectDevice at all.
    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(victimTicket)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    const reader = (pane.body as ReadableStream<Uint8Array>).getReader();
    await new Promise((r) => setTimeout(r, 30));

    deviceRoster.get(victim.deviceId)!.revoked = true;
    expect(server.disconnectDevice(victim.deviceId)).toBe(1);

    expect(await closedWithin(reader, 1000)).toBe(true);
    // The outstanding ticket is destroyed too — otherwise revocation would have
    // a two-minute hole in it during which the phone could reopen a stream.
    const reopened = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(victimTicket)}`);
    expect(reopened.status).toBe(401);
    // …and it cannot get a replacement, because its credential is dead.
    expect((await getTicket(victim.token)).status).toBe(401);
    expect((await getTicket(victim.token)).status).toBe(401);

    // The neighbour's ticket still opens a stream.
    const survivor = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(bystanderTicket)}`);
    expect(survivor.status).toBe(200);
    ac.abort();
  });

  it('keeps the operator ?token= path working untouched alongside tickets', async () => {
    const info = await startRO();
    const token = info.token as string;
    await pairDevice('Phone');

    const ac = new AbortController();
    const pane = await fetch(`${base()}/api/stream?session=s1&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
    });
    expect(pane.status).toBe(200);
    ac.abort();
    const attn = await readEventStream(`${base()}/api/events?token=${encodeURIComponent(token)}`, /event: reset/);
    expect(attn.status).toBe(200);
    // A bogus ticket does not become valid just because tickets exist.
    expect((await fetch(`${base()}/api/stream?session=s1&ticket=not-a-ticket`)).status).toBe(401);
  });

  it('drops outstanding tickets on stop(), so none survives into the next server', async () => {
    await startRO();
    const { token } = await pairDevice('Phone');
    const ticket = await ticketFor(token);
    await server.stop();

    await startRO();
    const stale = await fetch(`${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`);
    expect(stale.status).toBe(401);
  });

  it('drops every device stream on stop(), so a revoke after a restart finds nothing', async () => {
    await startRO();
    const device = await pairDevice('Phone');
    const pane = await openStream(device.token);
    expect(pane.res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    await server.stop();
    expect(await closedWithin(pane.reader!, 1000)).toBe(true);
    expect(server.disconnectDevice(device.deviceId)).toBe(0);
    pane.ac.abort();
  });
  // ── pane geometry ─────────────────────────────────────────────────────────

  const postResize = (id: string, cred: string, body: unknown) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      headers: { ...bearer(cred), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('★ resizes a detached pane, and answers with the geometry that was APPLIED', async () => {
    const token = (await startRO()).token as string;

    const res = await postResize('s1', token, { cols: 60, rows: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cols: 60, rows: 30, owner: 'caller' });
    expect(resizeCalls).toEqual([{ id: 's1', cols: 60, rows: 30 }]);
    // Note the server: startRO. A SIGWINCH is not a keystroke, and gating this
    // on --allow-input would leave the phone letterboxed on every daemon that
    // has not opted into arbitrary execution.
  });

  it('★ refuses while the desk is attached, and says what to render at instead', async () => {
    const token = (await startRO()).token as string;
    // s2 is the attached pane. One PTY cannot be two geometries, and the desk
    // re-derives its own on every layout pass — applying the phone's numbers
    // here starts a fight, not a resize.
    const res = await postResize('s2', token, { cols: 60, rows: 30 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'desk-owns-size',
      cols: 80,
      rows: 24,
      owner: 'desk',
    });
    expect(resizeCalls).toEqual([]);
  });

  it('★ hands the size to the phone when the desk holds the pane but is not showing it (#766)', async () => {
    const token = (await startRO()).token as string;
    // s2 is attached, but the renderer reported the pane off screen
    // (background workspace / inactive tab / minimized window). Nobody is
    // looking at the layout the phone would break, so its numbers apply.
    managed.viewerVisible = false;
    const res = await postResize('s2', token, { cols: 60, rows: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cols: 60, rows: 30, owner: 'caller' });
    expect(resizeCalls).toEqual([{ id: 's2', cols: 60, rows: 30 }]);
  });

  it('★ reports the record, never the request', async () => {
    const token = (await startRO()).token as string;
    // The manager is free to store something other than what was asked for.
    // A route that echoed the request would report a width no PTY ever had.
    resizeBox.applyAs = { cols: 72, rows: 28 };
    const res = await postResize('s1', token, { cols: 65, rows: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cols: 72, rows: 28, owner: 'caller' });
  });

  it('★ a pane that vanishes mid-resize is a 409, not a 200 with the request echoed', async () => {
    const token = (await startRO()).token as string;
    resizeBox.vanishAfter = true;
    const res = await postResize('s1', token, { cols: 65, rows: 50 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('resize-failed');
  });

  it('★ refuses a geometry no human would use, well above the crash floor', async () => {
    const token = (await startRO()).token as string;
    for (const body of [
      // 10 cols does not crash zsh — that is all the manager's floor promises.
      // It DOES hard-wrap everything the pane prints, and scrollback does not
      // re-flow, so those bytes are ruined for good. The route's own floor is
      // about what a terminal is for, not about what survives.
      { cols: 10, rows: 30 },
      { cols: 39, rows: 30 },
      { cols: 60, rows: 7 },
      { cols: 0, rows: 30 },
      { cols: 60.5, rows: 30 },
      { cols: 1001, rows: 30 },
      { cols: 60, rows: 1001 },
      { cols: '60', rows: 30 },
      { rows: 30 },
      {},
    ]) {
      const res = await postResize('s1', token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('bad-geometry');
    }
    expect(resizeCalls).toEqual([]);
  });

  it('★ bounds how often ONE session can be resized', async () => {
    // Not only about CPU. Every accepted resize stamps the bridge's redraw
    // guard, and a device that keeps that guard permanently armed stops
    // AgentDetector from ever emitting a new prompt — approvals go silent.
    let clock = 1_000_000;
    const limited = new WebTerminalServer({
      sessionManager, log: () => { /* silent */ }, assetsDir: os.tmpdir(), now: () => clock,
    });
    const info = await limited.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const at = `http://127.0.0.1:${info.port}/api/sessions/s1/resize`;
    const send = (cols: number) =>
      fetch(at, {
        method: 'POST',
        headers: { ...bearer(info.token as string), 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows: 30 }),
      });
    try {
      expect((await send(60)).status).toBe(200);

      const tooSoon = await send(61);
      expect(tooSoon.status).toBe(429);
      const body = await tooSoon.json();
      expect(body.error).toBe('resize-too-often');
      // Carries somewhere to render meanwhile, and when to try again.
      expect(body.retryAfterMs).toBeGreaterThan(0);
      expect(body.cols).toBeGreaterThan(0);
      expect(resizeCalls).toHaveLength(1);

      clock += 250;
      expect((await send(62)).status).toBe(200);
      expect(resizeCalls).toHaveLength(2);
    } finally {
      await limited.stop();
    }
  });

  it('★ refuses a pane that is still recovering', async () => {
    // The first resize of a deferred session is the desk's unmute handshake.
    // Taking it here starts capture at the phone's geometry and interleaves
    // pre-resize output into scrollback, which cannot be re-flowed later.
    const token = (await startRO()).token as string;
    managed.deferred = true;
    const res = await postResize('s1', token, { cols: 65, rows: 50 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('resize-failed');
    expect(resizeCalls).toEqual([]);
  });

  it('404s an unknown pane and 409s one the manager refuses, without echoing its wording', async () => {
    const token = (await startRO()).token as string;
    expect((await postResize('nope', token, { cols: 60, rows: 30 })).status).toBe(404);

    resizeBox.throws = "Session 's1' is dead: /Users/someone/secret/path";
    const res = await postResize('s1', token, { cols: 60, rows: 30 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('resize-failed');
    // The daemon's own message names session ids and paths. It belongs in the
    // log, not on a wire a paired device reads.
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('s1');
  });

  it('gates the resize route on the Bearer token, and a paired phone may call it', async () => {
    await startRO();
    expect((await postResize('s1', 'nonsense', { cols: 60, rows: 30 })).status).toBe(401);
    const { token } = await pairDevice('Phone');
    expect((await postResize('s1', token, { cols: 60, rows: 30 })).status).toBe(200);
  });

  it('serves durable history only with auth and transcript consent, including closed panes', async () => {
    const ro = await startRO();
    expect((await fetch(`${base()}/api/history`)).status).toBe(401);
    expect((await fetch(`${base()}/api/history`, {headers:bearer(ro.token as string)})).status).toBe(403);
    await server.stop();
    const info = await startWithTranscript();
    const headers = bearer(info.token as string);
    const history = new RunHistoryStore(uploadsDir);
    history.ingest('closed-pane', {}, {source:'hook',decision:'emit',hookKind:'agent.stop',agent:'Claude Code',status:'complete',message:'Done',
      signal:{kind:'agent.stop',agent:'claude',cwd:'/repo',ts:100,payload:{last_assistant_message:'Implemented the fix'}}});
    const response = await fetch(`${base()}/api/history`, {headers});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({entries:[{sessionId:'closed-pane',summary:'Implemented the fix',outcome:'completed'}],nextOffset:null});
    expect((await fetch(`${base()}/api/history?offset=-1`, {headers})).status).toBe(400);
  });

  it('stages and commits through the authenticated Git API using spawnCwd', async () => {
    const info = await startRW();
    const auth = bearer(info.token as string);
    const root = path.join(uploadsDir, 'repo');
    fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', args, {cwd:root,encoding:'utf8'}).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'HTTP Test'); git('config', 'user.email', 'http@example.invalid');
    fs.writeFileSync(path.join(root, 'phone.txt'), 'reviewed');
    managed.meta.spawnCwd = root;
    managed.meta.cwd = '/untrusted-osc-path';
    const endpoint = `${base()}/api/sessions/s1/git`;
    const beforeResponse = await fetch(endpoint, {headers:auth});
    expect(beforeResponse.headers.get('cache-control')).toBe('no-store');
    const before = await beforeResponse.json();
    expect(before).toMatchObject({branch:'main',ref:'refs/heads/main',head:null,files:[{path:'phone.txt',status:'??'}]});
    const stage = await fetch(endpoint, {method:'POST',headers:auth,body:JSON.stringify({requestId:crypto.randomUUID(),action:'stage',paths:['phone.txt'],expectedHead:before.head,expectedTree:before.tree,expectedRef:before.ref})});
    expect(await stage.json()).toEqual({applied:true});
    const staged = await (await fetch(endpoint, {headers:auth})).json();
    const mutation = {requestId:crypto.randomUUID(),action:'commit',message:'From phone',expectedHead:staged.head,expectedTree:staged.tree,expectedRef:staged.ref};
    const send = () => fetch(endpoint, {method:'POST',headers:auth,body:JSON.stringify(mutation)});
    const result = await (await send()).json();
    expect(result).toEqual({applied:true,commit:git('rev-parse','HEAD')});
    expect(await (await send()).json()).toEqual(result);
    expect(git('rev-list','--count','HEAD')).toBe('1');
  });

  it('gates Git control on authentication, input grants and session visibility', async () => {
    const info = await startRO();
    const headers = bearer(info.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/git`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1/git`, {headers})).status).toBe(403);
    expect((await fetch(`${base()}/api/sessions/s1/git`, {method:'POST',headers,body:'{}'})).status).toBe(403);
    expect(await (await fetch(`${base()}/api/config`, {headers})).json()).toMatchObject({gitControl:false});
    await server.stop();
    const enabled = await startRW();
    const auth = bearer(enabled.token as string);
    expect(await (await fetch(`${base()}/api/config`, {headers:auth})).json()).toMatchObject({gitControl:true});
    expect((await fetch(`${base()}/api/sessions/missing/git`, {headers:auth})).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/s1/git`, {method:'POST',headers:auth,body:'{}'})).status).toBe(400);
  });

  it('gates settings on both input and transcript grants', async()=>{
    let info=await startWithTranscript();
    expect((await fetch(`${base()}/api/sessions/s1/agent-settings`,{headers:bearer(info.token as string)})).status).toBe(403);
    await server.stop();info=await startRW();
    expect((await fetch(`${base()}/api/sessions/s1/agent-settings`,{headers:bearer(info.token as string)})).status).toBe(403);
    expect(await (await fetch(`${base()}/api/config`,{headers:bearer(info.token as string)})).json()).toMatchObject({agentSettings:false});
    expect(settingsCalls).toHaveLength(0);
  });
  it('serves scoped settings without cache and refuses extra mutation fields', async()=>{
    const info=await server.start({port:0,host:'127.0.0.1',allowInput:true,allowTranscript:true,allowUpload:false});
    const headers=bearer(info.token as string);
    const endpoint=`${base()}/api/sessions/s1/agent-settings`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(await (await fetch(`${base()}/api/config`,{headers})).json()).toMatchObject({agentSettings:true});
    const result=await fetch(endpoint,{headers});
    expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');
    const choice={model:'model-a',effort:'low',expectedRevision:settingsRevision};
    expect((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...choice,threadId:'forged'})})).status).toBe(400);
    expect((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(choice)})).status).toBe(200);
    expect(settingsCalls).toEqual([{id:'s1',choice:undefined},{id:'s1',choice}]);
  });
  it('serializes settings operations and reauthenticates after an in-flight credential revocation', async()=>{
    await server.start({port:0,host:'127.0.0.1',allowInput:true,allowTranscript:true,allowUpload:false});
    const phone=await pairDevice('Settings phone');const headers=bearer(phone.token);
    let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let permitted=true;
    settingsHook=async authorized=>{enter();await gate;permitted=await authorized();};
    const endpoint=`${base()}/api/sessions/s1/agent-settings`;
    const first=fetch(endpoint,{headers});await entered;
    const second=await fetch(endpoint,{headers});
    expect(second.status).toBe(409);expect(await second.json()).toEqual({error:'busy'});
    deviceRoster.get(phone.deviceId)!.revoked=true;release();
    expect((await first).status).toBe(401);expect(permitted).toBe(false);
    expect(settingsCalls).toHaveLength(1);
  });
  it('preserves an unconfirmed write outcome without retrying the controller', async()=>{
    const info=await server.start({port:0,host:'127.0.0.1',allowInput:true,allowTranscript:true,allowUpload:false});
    settingsHook=async()=>{throw new LiveSettingsError('unconfirmed');};
    const result=await fetch(`${base()}/api/sessions/s1/agent-settings`,{method:'POST',headers:bearer(info.token as string),body:JSON.stringify({model:'model-a',effort:'low',expectedRevision:settingsRevision})});
    expect(result.status).toBe(409);expect(await result.json()).toEqual({error:'unconfirmed'});
    expect(settingsCalls).toHaveLength(1);
  });

  it('reads the selected workspace account catalog without returning its config path', async () => {
    const calls: unknown[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner,raw) => {
      const data = (raw as {data:{requestId:string;command:string;payload:unknown}}).data;
      calls.push({command:data.command,payload:data.payload});
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result:{CODEX_HOME:'/private/account'}});
      return true;
    });
    desktopBridge.register('main');
    await startRW();
    const device = await pairDevice('Catalog phone');
    const headers = bearer(device.token);
    const response = await fetch(`${base()}/api/agent-launch-options?workspaceId=ws-1`,{headers});
    expect(response.status).toBe(200);
    expect(agentLaunchEnv?.CODEX_HOME).toBe('/private/account');
    expect(await response.text()).not.toContain('/private/account');
    expect(calls).toEqual([{command:'accounts.env',payload:{workspaceId:'ws-1'}}]);
    expect((await fetch(`${base()}/api/agent-launch-options?workspaceId=forged`,{headers})).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('validates agent launch against advertised options before creating a pane', async () => {
    const ro = await startRO();
    expect((await fetch(`${base()}/api/agent-launch-options`,{headers:bearer(ro.token as string)})).status).toBe(403);
    await server.stop();
    const rw = await startRW();
    const headers = bearer(rw.token as string);
    expect((await fetch(`${base()}/api/agent-launch-options`)).status).toBe(401);
    expect(await (await fetch(`${base()}/api/agent-launch-options`,{headers})).json()).toEqual({agents:[{agent:'claude',models:['opus','sonnet'],efforts:['low','high']}]});
    const before = lifecycleCalls.length;
    expect((await fetch(`${base()}/api/sessions`,{method:'POST',headers,body:JSON.stringify({agentLaunch:{agent:'claude',model:'opus; bad'}})})).status).toBe(400);
    expect(lifecycleCalls).toHaveLength(before);
    expect((await fetch(`${base()}/api/sessions`,{method:'POST',headers,body:JSON.stringify({agentLaunch:{agent:'claude',model:'opus',effort:'high'}})})).status).toBe(201);
    expect(lifecycleCalls.at(-1)).toMatchObject({op:'create',arg:{agentLaunch:{agent:'claude',model:'opus',effort:'high'}}});
  });

  it('serves workspace-scoped browser captures and restricts browser writes', async () => {
    managed.meta.env = { WMUX_WORKSPACE_ID: 'ws-1' };
    const calls: unknown[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as {data: {requestId: string; command: string; payload: unknown}}).data;
      calls.push({command:data.command,payload:data.payload});
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result:data.command === 'browser.capture'
        ? {data:'x'.repeat(160000),mimeType:'image/jpeg',capturedAt:1} : {pages:[]}});
      return true;
    });
    desktopBridge.register('main');
    const off = await startRO();
    expect((await fetch(`${base()}/api/sessions/s1/browser`,{headers:bearer(off.token as string)})).status).toBe(403);
    await server.stop();
    const ro = await startWithTranscript();
    const headers = bearer(ro.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/browser`)).status).toBe(401);
    const capture = await fetch(`${base()}/api/sessions/s1/browser?surfaceId=own`,{headers});
    expect(capture.status).toBe(200);
    expect(capture.headers.get('cache-control')).toBe('no-store');
    expect((await capture.json()).data).toHaveLength(160000);
    expect((await fetch(`${base()}/api/sessions/s1/browser`,{method:'POST',headers,body:'{}'})).status).toBe(403);
    await server.stop();
    const rw = await server.start({port:0,host:'127.0.0.1',allowInput:true,allowUpload:false,allowTranscript:true});
    const auth = bearer(rw.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/browser`,{method:'POST',headers:auth,body:JSON.stringify({action:'viewport',surfaceId:'own',mode:'mobile',workspaceId:'forged',expression:'bad'})})).status).toBe(200);
    expect(calls).toEqual([
      {command:'browser.capture',payload:{surfaceId:'own',workspaceId:'ws-1'}},
      {command:'browser.viewport',payload:{surfaceId:'own',mode:'mobile',workspaceId:'ws-1'}},
    ]);
    expect((await fetch(`${base()}/api/sessions/s1/browser`,{method:'POST',headers:auth,body:'{"action":"evaluate","surfaceId":"own","expression":"bad"}'})).status).toBe(400);
    const post = (value: unknown) => fetch(`${base()}/api/sessions/s1/browser`,{method:'POST',headers:auth,body:JSON.stringify(value)});
    expect((await post({action:'type',surfaceId:'own',expectedURL:'https://example.com/',text:'hello',expression:'bad',workspaceId:'other'})).status).toBe(200);
    expect(calls.at(-1)).toEqual({command:'browser.type',payload:{surfaceId:'own',expectedURL:'https://example.com/',text:'hello',workspaceId:'ws-1'}});
    expect((await post({action:'key',surfaceId:'own',expectedURL:'https://example.com/',key:'Tab'})).status).toBe(200);
    expect((await post({action:'open',url:'https://example.com/',workspaceId:'forged',partition:'forged'})).status).toBe(200);
    expect(calls.at(-1)).toEqual({command:'browser.open',payload:{url:'https://example.com/',workspaceId:'ws-1'}});
    const geometry = {width:1000,height:728,scrollX:0,scrollY:0};
    expect((await post({action:'tap',surfaceId:'own',expectedURL:'https://example.com/',x:0.5,y:0.25,geometry,workspaceId:'forged'})).status).toBe(200);
    expect(calls.at(-1)).toEqual({command:'browser.tap',payload:{surfaceId:'own',expectedURL:'https://example.com/',x:0.5,y:0.25,geometry,workspaceId:'ws-1'}});
    expect((await post({action:'scroll',surfaceId:'own',expectedURL:'https://example.com/',x:0.5,y:0.5,geometry,deltaX:0,deltaY:0.5,expression:'bad'})).status).toBe(200);
    expect(calls.at(-1)).toEqual({command:'browser.scroll',payload:{surfaceId:'own',expectedURL:'https://example.com/',x:0.5,y:0.5,geometry,deltaX:0,deltaY:0.5,workspaceId:'ws-1'}});
    const count = calls.length;
    expect((await post({action:'scroll',surfaceId:'own',expectedURL:'https://example.com/',x:0.5,y:0.5,geometry,deltaX:0,deltaY:2})).status).toBe(400);
    expect((await post({action:'tap',surfaceId:'own',expectedURL:'https://example.com/',x:1,y:0.25,geometry})).status).toBe(400);
    expect((await post({action:'key',surfaceId:'own',expectedURL:'https://example.com/',key:'Control+l'})).status).toBe(400);
    expect((await post({action:'type',surfaceId:'own',expectedURL:'https://example.com/',text:'x'.repeat(4097)})).status).toBe(400);
    expect((await post({action:'type',surfaceId:'own',text:'missing URL'})).status).toBe(400);
    expect(calls).toHaveLength(count);

  });


  it('opens browsers in a registered workspace without an attachable terminal', async () => {
    const calls: {command:string;payload:unknown}[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner,raw) => {
      const data = (raw as {data:{requestId:string;command:string;payload:unknown}}).data;
      calls.push({command:data.command,payload:data.payload});
      const result = data.command === 'workspaces.list' ? {workspaces:[{id:'empty',name:'Empty',sessionId:null}]} :
        data.command === 'browser.open' ? {surfaceId:'new-browser'} : {pages:[]};
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result});
      return true;
    });
    desktopBridge.register('main');
    const ro = await startWithTranscript();
    expect((await fetch(`${base()}/api/desktop-workspaces/empty/browser`,{headers:bearer(ro.token as string)})).status).toBe(403);
    expect(calls).toHaveLength(0);
    await server.stop();
    const rw = await server.start({port:0,host:'127.0.0.1',allowInput:true,allowUpload:false,allowTranscript:true});
    const headers = bearer(rw.token as string);
    expect((await fetch(`${base()}/api/desktop-workspaces/empty/browser`,{headers})).status).toBe(200);
    expect(calls.at(-1)).toEqual({command:'browser.list',payload:{workspaceId:'empty'}});
    const opened = await fetch(`${base()}/api/desktop-workspaces/empty/browser`,{method:'POST',headers,body:JSON.stringify({action:'open',url:'https://example.com/',workspaceId:'forged'})});
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({surfaceId:'new-browser'});
    expect(calls.at(-1)).toEqual({command:'browser.open',payload:{workspaceId:'empty',url:'https://example.com/'}});
    expect((await fetch(`${base()}/api/desktop-workspaces/missing/browser`,{headers})).status).toBe(404);
    expect(calls.at(-1)?.command).toBe('workspaces.list');
    expect((await fetch(`${base()}/api/desktop-workspaces/empty/browser`)).status).toBe(401);
  });

  it('keeps the legacy live roster and desktop workspace registry on distinct routes', async () => {
    const calls: string[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner,raw) => {
      const data = (raw as {data:{requestId:string;command:string}}).data;
      calls.push(data.command);
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result:{workspaces:[
        {id:'ws-1',name:'Workspace 1',sessionId:'s1'},
        {id:'empty',name:'Empty workspace',sessionId:null},
      ]}});
      return true;
    });
    desktopBridge.register('main');
    const rw = await startRW();
    const headers = bearer(rw.token as string);
    const legacy = await (await fetch(`${base()}/api/workspaces`,{headers})).json();
    expect(legacy.workspaces[0]).toHaveProperty('panes');
    expect(calls).toEqual([]);
    const registry = await (await fetch(`${base()}/api/desktop-workspaces`,{headers})).json();
    expect(registry.workspaces).toEqual([
      {id:'ws-1',name:'Workspace 1',sessionId:'s1'},
      {id:'empty',name:'Empty workspace',sessionId:null},
    ]);
    expect(calls).toEqual(['workspaces.list']);
  });

  it('returns a named conflict when a phone-created workspace was already closed', async () => {
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as {data:{requestId:string}}).data;
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result:{error:'workspace-request-closed'}});
      return true;
    });
    desktopBridge.register('main');
    const rw = await startRW();
    const response = await fetch(`${base()}/api/workspaces`, {method:'POST',headers:bearer(rw.token as string),
      body:JSON.stringify({requestId:'01234567-89ab-4cde-8123-456789abcdef',name:'Project'})});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({error:'workspace-request-closed'});
  });

  it('gates workspace creation and does not forward arbitrary execution fields', async () => {
    const calls: unknown[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as {data: {requestId: string; command: string; payload: unknown}}).data;
      calls.push({command:data.command,payload:data.payload});
      desktopBridge!.complete('main',{requestId:data.requestId,ok:true,result:{id:'ws-phone-test',name:'Project'}});
      return true;
    });
    desktopBridge.register('main');
    const ro = await startRO();
    expect((await fetch(`${base()}/api/workspaces`,{method:'POST',headers:bearer(ro.token as string),body:'{}'})).status).toBe(403);
    await server.stop();
    const rw = await startRW();
    const headers = bearer(rw.token as string);
    const requestId = '01234567-89ab-4cde-8123-456789abcdef';
    expect((await fetch(`${base()}/api/workspaces`,{method:'POST',body:'{}'})).status).toBe(401);
    const result = await fetch(`${base()}/api/workspaces`,{method:'POST',headers,body:JSON.stringify({requestId,name:'Project',cwd:'/project',method:'shell.exec',command:'bad',env:{SECRET:'bad'}})});
    expect(result.status).toBe(200);
    expect(calls).toEqual([{command:'workspaces.create',payload:{requestId,name:'Project',cwd:'/project'}}]);
    expect((await fetch(`${base()}/api/workspaces`,{method:'POST',headers,body:'{"name":"Project"}'})).status).toBe(400);
  });

  it('shares quick commands with input-gated writes and permits long instructions', async () => {
    const calls: string[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const event = raw as { data: { requestId: string; command: string; payload: unknown } };
      calls.push(event.data.command);
      desktopBridge!.complete('main', { requestId: event.data.requestId, ok: true, result: { revision: 'r1', commands: [] } });
      return true;
    });
    desktopBridge.register('main');
    const ro = await startWithTranscript();
    const headers = bearer(ro.token as string);
    expect((await fetch(`${base()}/api/quick-commands`)).status).toBe(401);
    expect((await fetch(`${base()}/api/quick-commands`, { headers })).status).toBe(200);
    expect((await fetch(`${base()}/api/quick-commands`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    await server.stop();
    const rw = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const response = await fetch(`${base()}/api/quick-commands`, { method: 'POST', headers: bearer(rw.token as string), body: JSON.stringify({ revision: 'r1', commands: [{ id: 'one', title: 'Long', text: 'x'.repeat(10000) }] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['prompts.list', 'prompts.replace']);
  });

  it('requires authentication, transcript consent and input permission for account writes', async () => {
    managed.meta.env = { WMUX_WORKSPACE_ID: 'ws-1' };
    const off = await startRW();
    const endpoint = `${base()}/api/sessions/s1/accounts`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: bearer(off.token as string) })).status).toBe(403);
    await server.stop();
    const info = await startWithTranscript();
    const headers = bearer(info.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/accounts`, { method: 'POST', headers, body: '{"action":"usage","accountId":"a"}' })).status).toBe(403);
    expect((await fetch(`${base()}/api/sessions/s1/accounts`, { headers })).status).toBe(503);
    expect(await (await fetch(`${base()}/api/config`, { headers })).json()).toMatchObject({ desktopAccounts: true });
  });

  it('derives account workspace scope from the pane and refuses internal env actions', async () => {
    managed.meta.env = { WMUX_WORKSPACE_ID: 'ws-1' };
    const calls: Array<{ command: string; payload: unknown }> = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const event = raw as { data: { requestId: string; command: string; payload: unknown } };
      calls.push({ command: event.data.command, payload: event.data.payload });
      desktopBridge!.complete('main', { requestId: event.data.requestId, ok: true, result: { workspaceId: 'ws-1', bindings: {}, accounts: [] } });
      return true;
    });
    desktopBridge.register('main');
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const headers = bearer(info.token as string);
    const endpoint = `${base()}/api/sessions/s1/accounts`;
    const list = await fetch(endpoint, { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    const changed = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'bind', vendor: 'claude', accountId: 'a', workspaceId: 'forged', env: { CODEX_HOME: '/forged' } }) });
    expect(changed.status).toBe(200);
    expect(calls).toEqual([
      { command: 'accounts.list', payload: { workspaceId: 'ws-1' } },
      { command: 'accounts.bind', payload: { workspaceId: 'ws-1', vendor: 'claude', accountId: 'a' } },
    ]);
    expect((await fetch(endpoint, { method: 'POST', headers, body: '{"action":"accounts.env"}' })).status).toBe(400);
    expect((await fetch(`${base()}/api/sessions/missing/accounts`, { headers })).status).toBe(404);
    expect(calls).toHaveLength(2);
    desktopBridge.disconnect('main');
    expect((await fetch(endpoint, { headers })).status).toBe(503);
  });

  /**
   * Drives a POST whose body arrives in two parts with the device's grant
   * withdrawn in between. The handoff is synchronized on the ENTRY
   * authentication's roster lookup, so the snapshot the handler took is already
   * decided when the grant changes: a route that only consulted that snapshot
   * would still run the mutation, and a route that re-authenticates after the
   * body completes cannot.
   */
  const withdrawMidBody = async (
    url: string,
    phone: { deviceId: string; token: string },
    head: string,
    tail: string,
    withdraw: (record: { revoked: boolean; allowInput: boolean }) => void,
  ): Promise<number | undefined> => {
    let entered!: () => void;
    const authenticated = new Promise<void>((resolve) => { entered = resolve; });
    const lookup = Map.prototype.get.bind(deviceRoster);
    const spy = vi.spyOn(deviceRoster, 'get').mockImplementation((id: string) => { entered(); return lookup(id); });
    let request!: ReturnType<typeof httpReq>;
    const status = new Promise<number | undefined>((resolve, reject) => {
      request = httpReq(url, { method: 'POST', headers: { ...bearer(phone.token), 'Content-Type': 'application/json' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      request.on('error', reject);
      request.write(head);
    });
    try {
      await authenticated;
      withdraw(deviceRoster.get(phone.deviceId) as unknown as { revoked: boolean; allowInput: boolean });
      request.end(tail);
      return await status;
    } finally { spy.mockRestore(); request.destroy(); }
  };

  it('re-authorizes desktop workspace creation after the request body completes', async () => {
    const calls: string[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as { data: { requestId: string; command: string } }).data;
      calls.push(data.command);
      desktopBridge!.complete('main', { requestId: data.requestId, ok: true, result: { id: 'ws-phone', name: 'Project' } });
      return true;
    });
    desktopBridge.register('main');
    await startRW();
    const phone = await pairDevice('Workspace phone', true);
    const body = JSON.stringify({ requestId: '01234567-89ab-4cde-8123-456789abcdef', name: 'Project' });
    expect(await withdrawMidBody(`${base()}/api/workspaces`, phone, body.slice(0, 20), body.slice(20), (r) => { r.revoked = true; }))
      .toBe(401);
    expect(calls).toEqual([]);
  });

  it('re-authorizes a quick-command replace after the request body completes', async () => {
    const calls: string[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as { data: { requestId: string; command: string } }).data;
      calls.push(data.command);
      desktopBridge!.complete('main', { requestId: data.requestId, ok: true, result: { revision: 'r1', commands: [] } });
      return true;
    });
    desktopBridge.register('main');
    await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const phone = await pairDevice('Quick command phone', true);
    const body = JSON.stringify({ revision: 'r1', commands: [{ id: 'one', title: 'One', text: 'echo' }] });
    // The grant is narrowed rather than the credential revoked: this is the half
    // that proves `mayInput` itself ran again on the freshly resolved principal.
    expect(await withdrawMidBody(`${base()}/api/quick-commands`, phone, body.slice(0, 12), body.slice(12), (r) => { r.allowInput = false; }))
      .toBe(403);
    expect(calls).toEqual([]);
  });

  it('re-authorizes an account bind after the request body completes', async () => {
    managed.meta.env = { WMUX_WORKSPACE_ID: 'ws-1' };
    const calls: string[] = [];
    desktopBridge = new DesktopPhoneBridge((_owner, raw) => {
      const data = (raw as { data: { requestId: string; command: string } }).data;
      calls.push(data.command);
      desktopBridge!.complete('main', { requestId: data.requestId, ok: true, result: {} });
      return true;
    });
    desktopBridge.register('main');
    await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const phone = await pairDevice('Account phone', true);
    const body = JSON.stringify({ action: 'bind', vendor: 'claude', accountId: 'a' });
    expect(await withdrawMidBody(`${base()}/api/sessions/s1/accounts`, phone, body.slice(0, 15), body.slice(15), (r) => { r.revoked = true; }))
      .toBe(401);
    expect(calls).toEqual([]);
  });

  it('re-authorizes a Git mutation after the request body completes', async () => {
    await startRW();
    const phone = await pairDevice('Git phone', true);
    const root = path.join(uploadsDir, 'revoked-repo');
    fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'HTTP Test'); git('config', 'user.email', 'http@example.invalid');
    fs.writeFileSync(path.join(root, 'phone.txt'), 'reviewed');
    managed.meta.spawnCwd = root;
    const before = await (await fetch(`${base()}/api/sessions/s1/git`, { headers: bearer(phone.token) })).json();
    const body = JSON.stringify({ requestId: crypto.randomUUID(), action: 'stage', paths: ['phone.txt'],
      expectedHead: before.head, expectedTree: before.tree, expectedRef: before.ref });
    expect(await withdrawMidBody(`${base()}/api/sessions/s1/git`, phone, body.slice(0, 30), body.slice(30), (r) => { r.revoked = true; }))
      .toBe(401);
    expect(git('ls-files')).toBe('');
  });

  it('re-authorizes pane creation after the request body completes', async () => {
    await startRW();
    const phone = await pairDevice('Create phone', true);
    const body = JSON.stringify({ cwd: '/home' });
    const before = lifecycleCalls.length;
    expect(await withdrawMidBody(`${base()}/api/sessions`, phone, body.slice(0, 6), body.slice(6), (r) => { r.revoked = true; }))
      .toBe(401);
    expect(lifecycleCalls).toHaveLength(before);
  });

  // The route's re-check is not the last word: create then awaits the workspace
  // account environment, the installed-CLI lookup and the Codex relay
  // reservation, and a device revoked inside THAT window still got a shell.
  it('re-authorizes pane creation again inside create, after its own awaits', async () => {
    await startRW();
    const phone = await pairDevice('Create phone', true);
    let open!: () => void;
    lifecycleBox.createGate = new Promise<void>((resolve) => { open = resolve; });
    const pending = fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(phone.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/home' }),
    });
    await vi.waitFor(() => expect(lifecycleCalls.at(-1)).toMatchObject({ op: 'create' }));
    deviceRoster.get(phone.deviceId)!.revoked = true;
    open();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authorization-expired' });
    // Asked AFTER the awaits, and no PTY was spawned.
    expect(lifecycleBox.authorizedAfterGate).toBe(true);
    expect(lifecycleBox.spawned).toBe(false);
  });

  it('re-authorizes an approval answer after the request body completes', async () => {
    await startRW();
    const phone = await pairDevice('Approval phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-mid' }));
    const body = JSON.stringify({ decision: 'approve' });
    expect(await withdrawMidBody(`${base()}/api/approvals/ap-mid`, phone, body.slice(0, 8), body.slice(8), (r) => { r.revoked = true; }))
      .toBe(401);
    expect(resolveCalls).toEqual([]);
  });

  it('a grant narrowed mid-body refuses a permission gate but still answers a screen prompt', async () => {
    await startRW();
    const body = JSON.stringify({ decision: 'approve' });
    const gatePhone = await pairDevice('Gate phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-gate-mid', kind: 'awaiting_permission', toolName: 'Bash' }));
    expect(await withdrawMidBody(`${base()}/api/approvals/ap-gate-mid`, gatePhone, body.slice(0, 8), body.slice(8), (r) => { r.allowInput = false; }))
      .toBe(403);
    expect(resolveCalls).toEqual([]);

    // The read-only carve-out: a screen prompt needs no input grant.
    const promptPhone = await pairDevice('Prompt phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-prompt-mid' }));
    expect(await withdrawMidBody(`${base()}/api/approvals/ap-prompt-mid`, promptPhone, body.slice(0, 8), body.slice(8), (r) => { r.allowInput = false; }))
      .toBe(200);
    expect(resolveCalls).toEqual([
      { id: 'ap-prompt-mid', decision: 'approve', resolvedBy: `device Prompt phone (${promptPhone.deviceId})` },
    ]);
  });

  // The registry re-checks from inside its mutation link, after the route's own
  // re-check: a resolve can queue behind others and re-read the screen first.
  it('the registry re-check refuses a device revoked or narrowed after the route re-check', async () => {
    await startRW();
    const phone = await pairDevice('Queued phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-queued' }));
    approvalBox.beforeAuthorize = () => { deviceRoster.get(phone.deviceId)!.revoked = true; };
    const revoked = await postApproval(phone.token, 'ap-queued', { decision: 'approve' });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: 'authorization-expired' });
    expect(resolveCalls).toHaveLength(1);

    const narrowed = await pairDevice('Narrowed phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-queued-gate', kind: 'awaiting_permission', toolName: 'Bash' }));
    approvalBox.beforeAuthorize = () => {
      (deviceRoster.get(narrowed.deviceId) as unknown as { allowInput: boolean }).allowInput = false;
    };
    const refused = await postApproval(narrowed.token, 'ap-queued-gate', { decision: 'approve' });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/^read-only:/);
  });

  it('answers 500 rather than hanging when the registry list throws after the body arrives', async () => {
    await startRW();
    const phone = await pairDevice('List phone', true);
    approvalRecords.push(mkApproval({ id: 'ap-list' }));
    const body = JSON.stringify({ decision: 'approve' });
    expect(await withdrawMidBody(`${base()}/api/approvals/ap-list`, phone, body.slice(0, 8), body.slice(8), () => { approvalBox.listThrows = true; }))
      .toBe(500);
    expect(resolveCalls).toEqual([]);
  });

  it('serves bounded workspace files only with authentication, transcript AND input consent', async () => {
    const info = await startRO();
    const headers = bearer(info.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/files`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1/files`, { headers })).status).toBe(403);
    await server.stop();
    // Transcript consent ALONE is not a file browser over the spawn directory,
    // which for a plain shell pane is the operator's home.
    const readOnly = await startWithTranscript();
    const readOnlyAuth = bearer(readOnly.token as string);
    expect((await fetch(`${base()}/api/sessions/s1/files`, { headers: readOnlyAuth })).status).toBe(403);
    expect((await (await fetch(`${base()}/api/config`, {headers: readOnlyAuth})).json()).workspaceFiles).toBe(false);
    await server.stop();
    const enabled = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const auth = bearer(enabled.token as string);
    managed.meta.spawnCwd = uploadsDir;
    fs.writeFileSync(path.join(uploadsDir, 'review.txt'), 'review this change');
    const config = await (await fetch(`${base()}/api/config`, {headers: auth})).json();
    expect(config.workspaceFiles).toBe(true);
    const listing = await fetch(`${base()}/api/sessions/s1/files`, {headers: auth});
    expect(listing.status).toBe(200);
    expect(listing.headers.get('cache-control')).toBe('no-store');
    expect(await listing.json()).toMatchObject({entries:[{name:'review.txt',directory:false}]});
    const preview = await fetch(`${base()}/api/sessions/s1/files?path=review.txt&preview=1`, {headers: auth});
    expect(await preview.json()).toMatchObject({text:'review this change'});
    const search = await fetch(`${base()}/api/sessions/s1/files?query=REVIEW`, {headers: auth});
    expect(search.headers.get('cache-control')).toBe('no-store');
    expect(await search.json()).toMatchObject({entries:[{path:'review.txt'}],truncated:false});
    expect((await fetch(`${base()}/api/sessions/s1/files?query=`, {headers:auth})).status).toBe(400);
    expect((await fetch(`${base()}/api/sessions/s1/files?path=..%2Fsecret&preview=1`, {headers:auth})).status).toBe(400);
    expect((await fetch(`${base()}/api/sessions/missing/files`, {headers:auth})).status).toBe(404);

    // Dot-entries at any depth answer exactly as a path that is not there does,
    // so the route cannot be used to prove a secret exists.
    fs.mkdirSync(path.join(uploadsDir, '.git'), {recursive: true});
    fs.writeFileSync(path.join(uploadsDir, '.git', 'config'), '[remote]');
    fs.writeFileSync(path.join(uploadsDir, '.env'), 'TOKEN=private');
    fs.mkdirSync(path.join(uploadsDir, '.ssh'), {recursive: true});
    fs.writeFileSync(path.join(uploadsDir, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    const absent = await fetch(`${base()}/api/sessions/s1/files?path=nothing-here.txt&preview=1`, {headers:auth});
    expect(absent.status).toBe(404);
    const absentBody = await absent.json();
    for (const hidden of ['.git/config', '.env', '.ssh/id_ed25519', '.git']) {
      const response = await fetch(`${base()}/api/sessions/s1/files?path=${encodeURIComponent(hidden)}&preview=1`, {headers:auth});
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(absentBody);
    }
    const hiddenListing = await (await fetch(`${base()}/api/sessions/s1/files`, {headers: auth})).json();
    expect(hiddenListing.entries.map((e: {name: string}) => e.name)).toEqual(['review.txt']);
    expect((await (await fetch(`${base()}/api/sessions/s1/files?query=env`, {headers: auth})).json()).entries).toEqual([]);
    // A normal file is unaffected.
    expect((await fetch(`${base()}/api/sessions/s1/files?path=review.txt&preview=1`, {headers:auth})).status).toBe(200);
  });

  // ── pane diff (read-only git) ──────────────────────────────────────────────

  const getDiff = (id: string, cred: string) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}/diff`, { headers: bearer(cred) });

  it('gates the diff route on the Bearer token — a query token is not enough', async () => {
    const info = await startRO();
    const token = info.token as string;
    expect((await fetch(`${base()}/api/sessions/s1/diff`)).status).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1/diff?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await getDiff('s1', token)).status).toBe(200);
  });

  it('★ the diff payload is never cacheable', async () => {
    // A 200 GET with no Cache-Control and no validator is heuristically
    // cacheable, and this is the one payload an approval decision is made
    // against: a phone — or an intermediary — replaying yesterday's patch
    // under today's prompt is the exact failure this route exists to prevent.
    const info = await startRO();
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('★ answers the diff on a READ-ONLY server, and only ever runs fixed-argv read-only git', async () => {
    const info = await startRO();
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      files: [
        { path: 'src/a.ts', status: ' M' },
        { path: 'notes.md', status: '??' },
      ],
      // Staged, working tree, then the untracked add-hunk — three runs of the
      // same scripted stdout.
      patch: 'PATCH\nPATCH\nPATCH\n',
      truncated: false,
      omittedBytes: 0,
      patchIncomplete: false,
    });
    expect(gitCalls.map((c) => gitBody(c.args))).toEqual([
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      // Names the repo's content filters so they can be blanked before
      // anything below converts working-tree content.
      ['config', '--list', '--name-only', '-z'],
      ['diff', '--histogram', '--cached', '--no-ext-diff', '--no-textconv'],
      ['diff', '--histogram', '--no-ext-diff', '--no-textconv'],
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      // #6: an untracked file is in files[] and would otherwise contribute
      // nothing to the patch. The path goes after a literal `--`.
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', 'notes.md'],
      // Closing re-read: did the tree change while all of that ran?
      ['status', '--porcelain', '-z', '--untracked-files=all'],
    ]);
    // Every one of them carried the hardening prefix.
    for (const c of gitCalls) {
      expect(c.args.slice(0, GIT_HARDENING_CONFIG.length)).toEqual([...GIT_HARDENING_CONFIG]);
    }
  });

  it("★ takes the cwd from the daemon's session record, never from the request", async () => {
    const info = await startRO();
    // Every shape a caller could try to smuggle a directory or a ref through.
    await fetch(`${base()}/api/sessions/s1/diff?cwd=/etc&ref=HEAD~5&base=main`, {
      headers: bearer(info.token as string),
    });
    // s1's recorded spawn cwd is /x — see makeDeps.
    expect(new Set(gitCalls.map((c) => c.cwd))).toEqual(new Set(['/x']));
    const flat = gitCalls.flatMap((c) => c.args);
    expect(flat).not.toContain('/etc');
    expect(flat).not.toContain('HEAD~5');
    expect(flat).not.toContain('main');
  });

  it('★ diffs the SPAWN cwd, never the OSC 7 cwd the pane itself last claimed', async () => {
    // The pane's process emitted an OSC 7 pointing at /tmp/osc7-said-so, which
    // the daemon dutifully recorded in meta.cwd. If the route read that, any
    // process inside any pane could aim this read-only route at any directory
    // on the machine and get the patch back over HTTP.
    const info = await startRO();
    await getDiff('s1', info.token as string);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) expect(c.cwd).toBe('/x');
    expect(gitCalls.map((c) => c.cwd)).not.toContain('/tmp/osc7-said-so');
  });

  it('409s a session record with no spawn cwd rather than falling back to the live one', async () => {
    const info = await startRO();
    // A pre-spawnCwd record. Falling back to meta.cwd here would reopen the
    // hole above for exactly the sessions whose provenance is unknown.
    const meta = (managed as unknown as { meta: Record<string, unknown> }).meta;
    const saved = meta.spawnCwd;
    meta.spawnCwd = undefined;
    try {
      expect((await getDiff('s1', info.token as string)).status).toBe(409);
      expect(gitCalls).toHaveLength(0);
    } finally {
      meta.spawnCwd = saved;
    }
  });

  it('★ 409s a cwd that is not a git repo — a scratch pane is normal, not an error', async () => {
    const info = await startRO();
    gitScript['rev-parse'] = { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not-a-git-repo' });
  });

  it('★ 500s, not 409s, when git never ran — "no repo here" must be gits word', async () => {
    // ENOENT on the git binary, or our own timeout. The old code collapsed
    // every failure into 409, telling the human their perfectly good repo was
    // not a repo.
    const info = await startRO();
    gitScript['rev-parse'] = { ok: false, ran: false, stdout: '', stderr: 'spawn git ENOENT' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'git-failed' });
  });

  it('500s when git itself fails, and leaks no detail on the wire', async () => {
    const info = await startRO();
    gitScript['status'] = {
      ok: false,
      stdout: '',
      stderr: 'fatal: index file /home/someone/secret-project/.git/index corrupt',
    };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(500);
    // The whole body, not a subset: git stderr names paths, remotes and config
    // keys, and none of it helps a phone decide what to do next.
    expect(await res.json()).toEqual({ error: 'git-failed' });
  });

  it('★ reports patchIncomplete when a diff command fails, instead of "no changes"', async () => {
    // The reason this flag exists: an empty patch with truncated:false renders
    // on a phone as a clean tree, and a human approves an edit against it.
    const info = await startRO();
    gitScript['diff'] = { ok: false, ran: false, stdout: '', stderr: 'killed' };
    const res = await getDiff('s1', info.token as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      patch: '',
      truncated: false,
      patchIncomplete: true,
      files: [
        { path: 'src/a.ts', status: ' M' },
        { path: 'notes.md', status: '??' },
      ],
    });
  });

  it('★ bounds concurrent collections and coalesces per session', async () => {
    const info = await startRO();
    const token = info.token as string;
    // Hold every collection open so all of them are genuinely in flight.
    let release = (): void => { /* replaced below */ };
    gitGate.hold = new Promise<void>((r) => { release = r; });

    // s1 twice (coalesced into one collection) + s2 = two slots used.
    const a = getDiff('s1', token);
    const b = getDiff('s1', token);
    const c = getDiff('s2', token);
    // Let the three requests reach the handler before the fourth.
    await new Promise((r) => setTimeout(r, 30));
    const d = getDiff('s3', token);
    const dRes = await d;
    expect(dRes.status).toBe(429);
    expect(await dRes.json()).toEqual({ error: 'busy' });

    gitGate.hold = null;
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra.status, rb.status, rc.status]).toEqual([200, 200, 200]);
    // Coalescing: the two s1 requests got the same answer from one collection.
    expect(await ra.json()).toEqual(await rb.json());
    // s3 never shelled out at all — the refusal is before git, which is the
    // point of the bound.
    expect(gitCalls.map((x) => x.cwd)).not.toContain('/z');

    // And the bound is released: a later request succeeds normally.
    expect((await getDiff('s1', token)).status).toBe(200);
  });

  it('404s an unknown session id, and never shells out for one', async () => {
    const info = await startRO();
    expect((await getDiff('nope', info.token as string)).status).toBe(404);
    expect((await getDiff('a/b', info.token as string)).status).toBe(404);
    expect(gitCalls).toHaveLength(0);
  });

  it('serves the diff to a paired device exactly as to the operator', async () => {
    await startRO();
    const device = await pairDevice('Phone');
    const res = await getDiff('s1', device.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { files: unknown[] }).files).toHaveLength(2);
  });

  // ── pane slash commands + skills ──────────────────────────────────────────

  const getCommands = (id: string, cred: string) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}/commands`, { headers: bearer(cred) });
  type CommandRow = { name: string; description: string; source: string; kind: string };
  const commandRows = async (res: Response): Promise<CommandRow[]> =>
    ((await res.json()) as { commands: CommandRow[] }).commands;

  /**
   * A pane whose spawn cwd is a real directory on disk, so the route's scan has
   * something to find. Returns the directory so the test can add files to it
   * mid-flight — which is how the cache is observed.
   */
  const paneWithCatalog = (id: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-commands-'));
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'bar'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'commands', 'foo.md'), 'run the foo\n');
    fs.writeFileSync(
      path.join(dir, '.claude', 'skills', 'bar', 'SKILL.md'),
      '---\nname: bar\ndescription: does the bar thing\n---\n\nbody\n',
    );
    live.push({
      id, cwd: dir, cols: 80, rows: 24, state: 'detached',
      agent: undefined, lastDetectedAgent: undefined,
      lastActivity: '2020-01-01T00:00:00.000Z',
      env: {}, cmd: '/bin/zsh',
    });
    return dir;
  };

  it('gates the commands route on the Bearer token', async () => {
    const info = await startRO();
    const token = info.token as string;
    expect((await fetch(`${base()}/api/sessions/s1/commands`)).status).toBe(401);
    // Same grade as /api/sessions: a query token is not a Bearer header here
    // either, and the route answers once a real credential arrives.
    expect(
      (await fetch(`${base()}/api/sessions/s1/commands?token=${encodeURIComponent(token)}`)).status,
    ).toBe(401);
    expect((await getCommands('s1', token)).status).toBe(200);
  });

  it('404s an unknown session id', async () => {
    const info = await startRO();
    const token = info.token as string;
    expect((await getCommands('nope', token)).status).toBe(404);
    expect((await getCommands('a/b', token)).status).toBe(404);
  });

  it("★ lists the pane cwd's own commands and skills, each with its kind and source", async () => {
    const dir = paneWithCatalog('sk1');
    try {
      const info = await startRO();
      const rows = await commandRows(await getCommands('sk1', info.token as string));
      // Containment, not equality: the scan also reads the operator's
      // user-global catalog, which no test may assume the shape of.
      expect(rows).toContainEqual({
        name: 'foo', description: '', source: 'project', kind: 'command',
      });
      expect(rows).toContainEqual({
        name: 'bar', description: 'does the bar thing', source: 'project', kind: 'skill',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ serves the second call from cache instead of walking the directory again', async () => {
    // The phone asks for this every time someone types `/`. Without the TTL a
    // fast typist turns a directory walk into a poll.
    const dir = paneWithCatalog('sk1');
    try {
      const info = await startRO();
      const token = info.token as string;
      const first = await commandRows(await getCommands('sk1', token));
      expect(first.map((c) => c.name)).toContain('foo');

      fs.writeFileSync(path.join(dir, '.claude', 'commands', 'baz.md'), 'added after\n');
      const second = await commandRows(await getCommands('sk1', token));
      // A route that re-read the disk would have picked `baz` up.
      expect(second.map((c) => c.name)).not.toContain('baz');
      expect(second).toEqual(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── pane lifecycle (POST / DELETE /api/sessions) ───────────────────────────

  const postSession = (cred: string, body?: unknown) =>
    fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(cred), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const deleteSession = (id: string, cred: string) =>
    fetch(`${base()}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: bearer(cred),
    });

  it('★ refuses BOTH lifecycle routes on a read-only server — this is not an approval-style carve-out', async () => {
    const info = await startRO();
    const token = info.token as string;
    const created = await postSession(token, {});
    expect(created.status).toBe(403);
    expect(((await created.json()) as { error: string }).error).toMatch(/read-only/);
    const deleted = await deleteSession('s1', token);
    expect(deleted.status).toBe(403);
    // The point of the gate: nothing reached the daemon.
    expect(lifecycleCalls).toEqual([]);
  });

  it('gates the lifecycle routes on the Bearer token — a query token is not enough', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await fetch(`${base()}/api/sessions`, { method: 'POST' })).status).toBe(401);
    expect(
      (await fetch(`${base()}/api/sessions?token=${encodeURIComponent(token)}`, { method: 'POST' })).status,
    ).toBe(401);
    expect((await fetch(`${base()}/api/sessions/s1`, { method: 'DELETE' })).status).toBe(401);
  });

  it('★ spawns a pane and describes it with the SAME projection /api/sessions uses', async () => {
    const info = await startRW();
    const token = info.token as string;
    const res = await postSession(token, { workspaceId: 'ws-1', cwd: '/repo' });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({
      id: 'web-1', cwd: '/repo', cols: 120, rows: 30,
      state: 'detached', agent: null, workspace: 'Workspace 1', shell: 'zsh',
    });
    expect(lifecycleCalls).toEqual([{ op: 'create', arg: { workspaceId: 'ws-1', cwd: '/repo' } }]);

    // Byte-identical to the row the list route serves for the same pane.
    const listed = (
      (await (await fetch(`${base()}/api/sessions`, { headers: bearer(token) })).json()) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions.find((sx) => sx.id === 'web-1');
    expect(listed).toEqual(row);
  });

  it('forwards neither field when the body is empty, absent, or the wrong type', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await postSession(token)).status).toBe(201);
    expect((await postSession(token, {})).status).toBe(201);
    expect((await postSession(token, { workspaceId: 7, cwd: ['/x'] })).status).toBe(201);
    expect(lifecycleCalls.map((c) => c.arg)).toEqual([{}, {}, {}]);
  });

  it('★ 400s a workspaceId that is not the right SHAPE, before anything is spawned', async () => {
    const info = await startRW();
    const token = info.token as string;
    // The value is stamped into WMUX_WORKSPACE_ID and persisted into
    // sessions.json, so a control character or a newline is not a cosmetic
    // problem — it is a value that renders as something else downstream.
    for (const bad of [
      'ws 1',
      'ws/../other',
      'ws-1\nWMUX_AUTH_TOKEN=x',
      // A literal NUL, written as an escape: as a raw byte it makes this
      // file unsearchable and reads as a duplicate of the space case above.
      'ws\u00001',
      'ws-\u001b[31m1',
      'w'.repeat(65),
      '../../etc/passwd',
    ]) {
      const res = await postSession(token, { workspaceId: bad });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid-workspace-id' });
    }
    expect(lifecycleCalls).toEqual([]);
  });

  it('★ 400s a well-shaped workspaceId that no live pane is running in — for a paired DEVICE', async () => {
    // The daemon owns no workspace registry, so "some live session already
    // carries this id" is the only evidence it has that the workspace exists.
    // Accepting an unverifiable id from a device would be workspace
    // impersonation — this is #1001's regression guard: the operator
    // exception below must not have widened this for anyone else.
    await startRW();
    const device = await pairDevice('Phone');
    const res = await postSession(device.token, { workspaceId: 'ws-invented' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown-workspace-id' });
    expect(lifecycleCalls).toEqual([]);
  });

  it('★ #1001 — the OPERATOR may bootstrap a brand-new workspaceId no pane is running in', async () => {
    // "New workspace on this host" on a headless remote daemon has no live
    // pane to vouch for the id yet — that is the whole gap #1001 closes.
    // Shape is still enforced (mirrors the 400 test above); only the
    // liveness/existence check is skipped, and only for this credential.
    const info = await startRW();
    const res = await postSession(info.token as string, { workspaceId: 'ws-brand-new' });
    expect(res.status).toBe(201);
    expect(lifecycleCalls).toEqual([{ op: 'create', arg: { workspaceId: 'ws-brand-new' } }]);
  });

  it('★ #1001 — the operator exception still enforces SHAPE', async () => {
    const info = await startRW();
    const res = await postSession(info.token as string, { workspaceId: 'ws 1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid-workspace-id' });
    expect(lifecycleCalls).toEqual([]);
  });

  it('accepts a workspaceId a live pane vouches for, and always accepts none at all', async () => {
    const info = await startRW();
    const token = info.token as string;
    // ws-1 is s1's workspace; ws-legacy is s2's (id present, name absent).
    expect((await postSession(token, { workspaceId: 'ws-1' })).status).toBe(201);
    expect((await postSession(token, { workspaceId: 'ws-legacy' })).status).toBe(201);
    // The documented escape hatch from the trade-off above.
    expect((await postSession(token, {})).status).toBe(201);
    expect(lifecycleCalls.map((c) => c.arg)).toEqual([
      { workspaceId: 'ws-1' },
      { workspaceId: 'ws-legacy' },
      {},
    ]);
  });

  it('400s a malformed JSON body rather than spawning anything', async () => {
    const info = await startRW();
    const res = await fetch(`${base()}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(info.token as string), 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(lifecycleCalls).toEqual([]);
  });

  it("409s with the daemon's own wording when the create is refused", async () => {
    const info = await startRW();
    lifecycleBox.createThrows = 'Cannot create new terminal: 200 active sessions already running.';
    const res = await postSession(info.token as string, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'create-failed',
      detail: expect.stringContaining('200 active sessions'),
    });
  });

  it('500s rather than faking a row when the created session is not live', async () => {
    const info = await startRW();
    lifecycleBox.createGoesMissing = true;
    expect((await postSession(info.token as string, {})).status).toBe(500);
  });

  it('★ closes a pane through the daemon and answers 204', async () => {
    const info = await startRW();
    const res = await deleteSession('s1', info.token as string);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(lifecycleCalls).toEqual([{ op: 'destroy', arg: 's1' }]);
  });

  it('404s an unknown or malformed id on DELETE, without calling the daemon', async () => {
    const info = await startRW();
    const token = info.token as string;
    expect((await deleteSession('nope', token)).status).toBe(404);
    expect((await deleteSession('a/b', token)).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/`, { method: 'DELETE', headers: bearer(token) })).status).toBe(404);
    expect(lifecycleCalls).toEqual([]);
  });

  it('500s when the daemon fails to reap the pane', async () => {
    const info = await startRW();
    lifecycleBox.destroyThrows = 'pty already gone';
    const res = await deleteSession('s1', info.token as string);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'destroy-failed' });
  });

  it('★ works from a paired device, not just the operator token', async () => {
    await startRW();
    const device = await pairDevice('Phone');
    const created = await postSession(device.token, { cwd: '/repo' });
    expect(created.status).toBe(201);
    expect((await deleteSession('s1', device.token)).status).toBe(204);
    expect(lifecycleCalls.map((c) => c.op)).toEqual(['create', 'destroy']);
  });

  it('answers 503 on both lifecycle routes when the daemon wired no lifecycle', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false });
    try {
      const url = `http://127.0.0.1:${info.port}/api/sessions`;
      const hdrs = bearer(info.token as string);
      expect((await fetch(url, { method: 'POST', headers: hdrs })).status).toBe(503);
      expect((await fetch(`${url}/s1`, { method: 'DELETE', headers: hdrs })).status).toBe(503);
    } finally {
      await bare.stop();
    }
  });

  it('leaves unmatched methods on the sessions namespace as 404, not 405 guesswork', async () => {
    const info = await startRW();
    const hdrs = bearer(info.token as string);
    expect((await fetch(`${base()}/api/sessions/s1`, { method: 'GET', headers: hdrs })).status).toBe(404);
    expect((await fetch(`${base()}/api/sessions/s1/diff`, { method: 'DELETE', headers: hdrs })).status).toBe(404);
  });
  // --- POST /api/upload ---------------------------------------------------
  //
  // The route exists because a phone has a camera and a desktop does not. What
  // the tests below pin down is everything a client cannot be trusted to get
  // right: the grant, the format, and the name on disk.

  /** A minimal JPEG: the SOI + APP0 marker is all the sniff looks at. */
  const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('body-jpeg')]);
  /** A minimal PNG: the eight-byte signature plus filler. */
  const pngBytes = () =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('body-png'),
    ]);
  const upload = (token: string, body: Buffer, contentType = 'application/octet-stream') =>
    fetch(`${base()}/api/upload`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': contentType },
      body: new Uint8Array(body),
    });

  it('stores a general attachment with server-owned naming and private non-executable permissions', async () => {
    const info = await startUpload();
    const body = Buffer.from('document\0bytes\n');
    const response = await fetch(`${base()}/api/upload-file`, {
      method: 'POST', headers: { ...bearer(info.token as string), 'X-Wmux-File-Extension': 'PDF' }, body,
    });
    expect(response.status).toBe(201);
    const receipt = await response.json() as {path:string};
    expect(path.dirname(receipt.path)).toBe(uploadsDir);
    expect(path.basename(receipt.path)).toMatch(/^file-.*-[a-f0-9]{8}\.pdf$/);
    expect(fs.readFileSync(receipt.path)).toEqual(body);
    if (process.platform !== 'win32') expect(fs.statSync(receipt.path).mode & 0o777).toBe(0o600);
    expect((await upload(info.token as string, body)).status).toBe(415);
  });

  it('rejects general upload traversal and unauthenticated requests without writing', async () => {
    const info = await startUpload();
    expect((await fetch(`${base()}/api/upload-file`, {method:'POST',body:'x'})).status).toBe(401);
    for (const extension of ['../txt','a.txt','txt/sh','longextension123']) {
      const response = await fetch(`${base()}/api/upload-file`, {
        method:'POST',headers:{...bearer(info.token as string),'X-Wmux-File-Extension':extension},body:'x',
      });
      expect(response.status).toBe(400);
    }
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('does not infer general file upload permission from input permission', async () => {
    const info = await startRW();
    const response = await fetch(`${base()}/api/upload-file`, {method:'POST',headers:bearer(info.token as string),body:'x'});
    expect(response.status).toBe(403);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('refuses an unauthenticated upload before it looks at anything else', async () => {
    await startUpload();
    const res = await fetch(`${base()}/api/upload`, {
      method: 'POST',
      body: new Uint8Array(jpegBytes()),
    });
    expect(res.status).toBe(401);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('403s an upload on a server started with --allow-input but not --allow-upload', async () => {
    // The point of the pairing: input is a grant to type into a pane the
    // operator is watching, upload is a grant to write files into their home
    // directory. One must never imply the other.
    const info = await startRW();
    const res = await upload(info.token as string, jpegBytes());
    expect(res.status).toBe(403);
    // The exact string, not just the code: the phone client prefix-matches it
    // to say "ask your Mac to enable uploads" instead of showing an HTTP code.
    expect(await res.json()).toEqual({
      error: 'uploads-disabled: server started without --allow-upload',
    });
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('413s a body over the 10 MB cap and writes nothing', async () => {
    const info = await startUpload();
    const oversized = Buffer.concat([jpegBytes(), Buffer.alloc(10 * 1024 * 1024)]);
    // The server destroys the socket on the cap, so the fetch itself may reject
    // rather than resolve with the 413 — the same trade-off /api/input makes.
    // What matters either way is that no file appeared.
    const res = await upload(info.token as string, oversized).catch(() => undefined);
    if (res) expect(res.status).toBe(413);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('415s anything that is not JPEG or PNG by its leading bytes, including an empty body', async () => {
    const info = await startUpload();
    const token = info.token as string;

    const text = await upload(token, Buffer.from('this is not an image at all'));
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({
      error: 'unsupported-format: only JPEG and PNG are accepted',
    });

    // Empty, and shorter-than-a-signature, are the same answer: we could not
    // identify it, so we will not store it.
    expect((await upload(token, Buffer.alloc(0))).status).toBe(415);
    expect((await upload(token, Buffer.from([0xff, 0xd8]))).status).toBe(415);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it('stores a JPEG under a server-chosen name and answers 201 with the absolute path', async () => {
    const info = await startUpload();
    const bytes = jpegBytes();
    const before = Date.now();
    const res = await upload(info.token as string, bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; expiresAt: number };

    expect(path.isAbsolute(body.path)).toBe(true);
    expect(path.dirname(body.path)).toBe(uploadsDir);
    // The client never names the file — a client-supplied name is a traversal
    // primitive and nothing reads these by name anyway.
    expect(path.basename(body.path)).toMatch(
      /^photo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.jpg$/,
    );
    expect(fs.readFileSync(body.path).equals(bytes)).toBe(true);
    // A day out, measured from the same clock the route used.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('trusts the magic bytes over the Content-Type the client claimed', async () => {
    const info = await startUpload();
    const bytes = pngBytes();
    // A PNG announced as a JPEG. Believing the header would put .jpg on a PNG
    // and hand the agent a file whose extension lies about its contents.
    const res = await upload(info.token as string, bytes, 'image/jpeg');
    expect(res.status).toBe(201);
    const { path: stored } = (await res.json()) as { path: string };
    expect(stored.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(stored).equals(bytes)).toBe(true);
  });

  it('sweeps photos past the TTL before a write, and leaves everything else alone', async () => {
    // A dedicated server so the clock seam is under this test's control.
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const swept = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      now: () => clock,
    });
    const info = await swept.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const token = info.token as string;
      const url = `http://127.0.0.1:${info.port}/api/upload`;
      const post = (body: Buffer) =>
        fetch(url, { method: 'POST', headers: bearer(token), body: new Uint8Array(body) });

      const first = (await (await post(jpegBytes())).json()) as { path: string };
      // Not ours. `~/.wmux/uploads` is also where an operator drops files for
      // browser_file_upload, and those are not the sweep's to delete.
      const keep = path.join(uploadsDir, 'keep.txt');
      fs.writeFileSync(keep, 'operator file');

      clock += 25 * 60 * 60 * 1000;
      const second = (await (await post(pngBytes())).json()) as { path: string };

      expect(fs.existsSync(first.path)).toBe(false);
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(second.path)).toBe(true);
    } finally {
      await swept.stop();
    }
  });

  it('reports allowUpload on /api/config so the phone can hide the button', async () => {
    const info = await startUpload();
    const res = await fetch(`${base()}/api/config`, { headers: bearer(info.token as string) });
    expect(await res.json()).toMatchObject({ allowInput: false, allowUpload: true, generalFileUpload: true });
    // status() carries it too — that is what `wmux web --status` prints.
    expect(server.status().allowUpload).toBe(true);
  });

  it('shares document/photo quota and sweeps expired documents without deleting staged files', async () => {
    let clock = Date.now();
    const bounded = new WebTerminalServer({
      sessionManager, log: () => { /* noop */ }, assetsDir: os.tmpdir(), uploadsDir,
      now: () => clock, uploadLimits: {maxFiles: 1},
    });
    const info = await bounded.start({port:0,host:'127.0.0.1',allowInput:false,allowUpload:true});
    const post = (endpoint: string, body: Buffer) => fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
      method:'POST',headers:{...bearer(info.token as string),'X-Wmux-File-Extension':'txt'},body: new Uint8Array(body),
    });
    try {
      const staged = path.join(uploadsDir,'file-my-notes.txt');
      fs.writeFileSync(staged,'operator file');
      const first = await post('/api/upload-file',Buffer.from('document'));
      expect(first.status).toBe(201);
      const receipt = await first.json() as {path:string};
      fs.utimesSync(receipt.path,clock / 1000,clock / 1000);
      expect((await post('/api/upload',jpegBytes())).status).toBe(507);
      expect((await post('/api/upload-file',Buffer.from('second'))).status).toBe(507);
      clock += 25 * 60 * 60 * 1000;
      const replacement = await post('/api/upload',jpegBytes());
      expect(replacement.status).toBe(201);
      const photo = await replacement.json() as {path:string};
      // Keep filesystem mtime aligned with the injected clock after advancing it.
      fs.utimesSync(photo.path,clock / 1000,clock / 1000);
      expect(fs.existsSync(receipt.path)).toBe(false);
      expect(fs.readFileSync(staged,'utf8')).toBe('operator file');
      expect((await post('/api/upload-file',Buffer.from('third'))).status).toBe(507);
    } finally { await bounded.stop(); }
  });

  it('answers 503 when the daemon wired no uploads directory', async () => {
    const bare = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
    const info = await bare.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      // 503, not 403: the operator DID grant the permission, the server simply
      // has nowhere to put the bytes. Saying "disabled" would send them off to
      // re-add a flag that is already there.
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'uploads-unavailable' });
    } finally {
      await bare.stop();
    }
  });
  /** A name the sweep and the quota both recognise as ours. */
  const generatedName = (isoMs: number, hex: string, ext: 'jpg' | 'png' = 'jpg') =>
    `photo-${new Date(isoMs).toISOString().replace(/[:.]/g, '-')}-${hex}.${ext}`;

  it('507s once the directory quota is full, and counts only its own files', async () => {
    // Limits are injected rather than honoured at their production values: the
    // only honest way to test a 200 MB ceiling is to fill it, and that is not a
    // test. The pass/fail logic under test is the same either way.
    const quota = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxFiles: 2 },
    });
    const info = await quota.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const url = `http://127.0.0.1:${info.port}/api/upload`;
      const post = () =>
        fetch(url, {
          method: 'POST',
          headers: bearer(info.token as string),
          body: new Uint8Array(jpegBytes()),
        });

      expect((await post()).status).toBe(201);
      expect((await post()).status).toBe(201);

      const full = await post();
      // 507, not 403: the operator granted the permission and the request is
      // well formed — the server has no room, and the TTL will make some.
      expect(full.status).toBe(507);
      expect(await full.json()).toEqual({ error: 'uploads-full: quota exceeded, try again later' });
    } finally {
      await quota.stop();
    }
  });

  it('does not charge the quota for files it did not write', async () => {
    const quota = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxFiles: 1 },
    });
    // An operator's own staged files are not ours to delete, so they are not
    // ours to count against a limit either.
    fs.writeFileSync(path.join(uploadsDir, 'photo-vacation.jpg'), 'operator file');
    fs.writeFileSync(path.join(uploadsDir, 'notes.txt'), 'operator file');
    const info = await quota.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      expect(res.status).toBe(201);
    } finally {
      await quota.stop();
    }
  });

  it('429s a fifth concurrent upload rather than buffering it', async () => {
    // Each in-flight upload holds its whole body in memory, so the disk quota
    // does nothing for RAM. maxConcurrent: 1 makes the bound observable with
    // one held-open request instead of five.
    const busy = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      uploadLimits: { maxConcurrent: 1 },
    });
    const info = await busy.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    const token = info.token as string;
    const port = info.port as number;
    try {
      const bytes = jpegBytes();
      // A request whose body arrives in two pieces, so the handler is provably
      // inside the buffering window while the second request is made.
      const held = httpReq({
        host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(bytes.length) },
      });
      const heldStatus = new Promise<number>((resolve, reject) => {
        held.on('response', (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        held.on('error', reject);
      });
      await new Promise<void>((resolve) => held.write(bytes.subarray(0, 4), () => resolve()));

      const refused = await fetch(`http://127.0.0.1:${port}/api/upload`, {
        method: 'POST',
        headers: bearer(token),
        body: new Uint8Array(bytes),
      });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'too-many-uploads: try again in a moment' });

      // The slot comes back when the held request finishes, so the next caller
      // is served rather than being locked out by a leaked counter.
      held.end(bytes.subarray(4));
      expect(await heldStatus).toBe(201);
      const after = await fetch(`http://127.0.0.1:${port}/api/upload`, {
        method: 'POST',
        headers: bearer(token),
        body: new Uint8Array(bytes),
      });
      expect(after.status).toBe(201);
    } finally {
      await busy.stop();
    }
  });

  it('sweeps only the names it generated — an operator photo-*.jpg survives', async () => {
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const swept = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      uploadsDir,
      now: () => clock,
    });
    const info = await swept.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true });
    try {
      // Ours, and expired: the exact shape handleUpload writes.
      const mine = path.join(uploadsDir, generatedName(clock, '0123abcd'));
      fs.writeFileSync(mine, 'old photo');
      // Theirs, and just as old. `photo-*.jpg` would have matched it, which is
      // why the pattern anchors the timestamp and the hex suffix instead.
      // (The uppercase-hex name below must not collide with `mine` — a
      // case-insensitive filesystem would make them the same file.)
      const theirs = path.join(uploadsDir, 'photo-vacation.jpg');
      fs.writeFileSync(theirs, 'operator file');
      const alsoTheirs = path.join(uploadsDir, 'photo-2030-01-01T00-00-00-000Z-DEADBEEF.jpg');
      fs.writeFileSync(alsoTheirs, 'uppercase hex is not ours');

      clock += 25 * 60 * 60 * 1000;
      const res = await fetch(`http://127.0.0.1:${info.port}/api/upload`, {
        method: 'POST',
        headers: bearer(info.token as string),
        body: new Uint8Array(jpegBytes()),
      });
      expect(res.status).toBe(201);

      expect(fs.existsSync(mine)).toBe(false);
      expect(fs.existsSync(theirs)).toBe(true);
      expect(fs.existsSync(alsoTheirs)).toBe(true);
    } finally {
      await swept.stop();
    }
  });

  describe('#782 — phone turn-view contract (GET /api/sessions/:id/turns)', () => {
    it('403 without --allow-transcript, while /api/approvals stays 200 on the same server', async () => {
      const info = await startRO(); // allowTranscript not set
      const h = bearer(info.token as string);
      const turns = await fetch(`${base()}/api/sessions/s1/turns`, { headers: h });
      expect(turns.status).toBe(403);
      expect(turns.headers.get('cache-control')).toBe('no-store');
      const body = await turns.json();
      // Matched by the machine-readable TAG, the way a client must: the prose
      // after the colon may be reworded, `transcript-disabled:` may not.
      expect(body.error.startsWith('transcript-disabled:')).toBe(true);
      // The two grants are independent: approvals still served on read-only.
      const approvals = await fetch(`${base()}/api/approvals`, { headers: h });
      expect(approvals.status).toBe(200);
    });

    it('401 without a Bearer header', async () => {
      await startWithTranscript();
      const res = await fetch(`${base()}/api/sessions/s1/turns`);
      expect(res.status).toBe(401);
    });

    it('404 for an unknown pane', async () => {
      const info = await startWithTranscript();
      const res = await fetch(`${base()}/api/sessions/no-such-pane/turns`, {
        headers: bearer(info.token as string),
      });
      expect(res.status).toBe(404);
    });

    it('unavailable reasons arrive as 200 {available:false, reason}, never 500', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      for (const reason of ['no-hook', 'stale-session', 'not-claude', 'unsafe-transcript-path']) {
        projectorMock.status.mockReturnValue({ available: false, reason });
        const res = await fetch(`${base()}/api/sessions/s1/turns`, { headers: h });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ available: false, reason });
      }
    });

    it('★ turn-view responses are never cacheable', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);

      const unavailable = await fetch(`${base()}/api/sessions/s1/turns`, { headers: h });
      expect(unavailable.status).toBe(200);
      expect(unavailable.headers.get('cache-control')).toBe('no-store');

      projectorMock.status.mockReturnValue({ available: true, reason: 'ok', transcriptBasename: 's.jsonl' });
      projectorMock.snapshot.mockReturnValue({
        events: [{ id: 'snapshot', kind: 'user_text', text: 'private snapshot' }],
        cursor: { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1234 },
        hasMore: false,
        truncatedHead: false,
      });
      const snapshot = await fetch(`${base()}/api/sessions/s1/turns`, { headers: h });
      expect(snapshot.status).toBe(200);
      expect(snapshot.headers.get('cache-control')).toBe('no-store');

      projectorMock.delta.mockReturnValue({
        events: [{ id: 'delta', kind: 'assistant_text', text: 'private delta' }],
        cursor: { headOffset: 0, tailOffset: 20, fileSize: 20, mtimeMs: 1234 },
        reset: false,
      });
      const cursor = Buffer.from(JSON.stringify({ head: 0, tail: 10 })).toString('base64url');
      const delta = await fetch(`${base()}/api/sessions/s1/turns?cursor=${cursor}`, { headers: h });
      expect(delta.status).toBe(200);
      expect(delta.headers.get('cache-control')).toBe('no-store');
    });

    it('a forward delta is served from projector.delta with an opaque cursor', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      projectorMock.status.mockReturnValue({ available: true, reason: 'ok', transcriptBasename: 's.jsonl' });
      projectorMock.delta.mockReturnValue({
        events: [{ id: 'x', kind: 'user_text', text: 'hi' }],
        cursor: { headOffset: 0, tailOffset: 10, fileSize: 100, mtimeMs: 1234 },
        reset: false,
      });
      const cursor = Buffer.from(JSON.stringify({ head: 0, tail: 0, mtimeMs: 1234, fileSize: 100 })).toString('base64url');
      const res = await fetch(`${base()}/api/sessions/s1/turns?cursor=${cursor}&dir=forward`, { headers: h });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.events).toHaveLength(1);
      // The cursor is opaque base64url.
      expect(typeof body.cursor).toBe('string');
    });

    it('transcript nudge is non-recording: it never enters the attention log', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      // A successful turns read registers the device as a watcher, so a nudge
      // has a recipient to reach (otherwise it short-circuits on an empty set).
      projectorMock.status.mockReturnValue({ available: true, reason: 'ok', transcriptBasename: 's.jsonl' });
      projectorMock.snapshot.mockReturnValue({
        events: [],
        cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 },
        hasMore: false,
        truncatedHead: false,
      });
      const read = await fetch(`${base()}/api/sessions/s1/turns`, { headers: h });
      expect(read.status).toBe(200);

      const before = await (await fetch(`${base()}/api/events`, { headers: h })).json();
      // Fire a burst of nudges. Recorded, these would evict attention events;
      // non-recording, they leave the backlog byte-identical.
      for (let i = 0; i < 60; i++) server.emitTranscriptNudge('s1');
      const after = await (await fetch(`${base()}/api/events`, { headers: h })).json();
      expect(after.headId).toBe(before.headId);
      expect(after.events).toEqual(before.events);
    });

    it('★ /api/config reports whether the gate is armed, and a flip reaches other devices', async () => {
      const info = await server.start({
        port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false,
      });
      const h = bearer(info.token as string);

      const armed = await (await fetch(`${base()}/api/config`, { headers: h })).json();
      expect(armed.gateEnabled).toBe(true);
      expect(armed.gatedTools).toEqual(['Bash']);

      // A second device is watching the attention channel. The gate is daemon-
      // wide, so the flip below is a change to what IT is looking at.
      const ac = new AbortController();
      const stream = await fetch(`${base()}/api/events`, {
        signal: ac.signal,
        headers: { ...h, Accept: 'text/event-stream' },
      });
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      let wire = '';
      const pump = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value) wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch {
          /* aborted at the end of the test */
        }
      })();

      try {
        const off = await fetch(`${base()}/api/gate/off`, { method: 'POST', headers: h });
        expect(off.status).toBe(200);
        expect((await off.json()).gateEnabled).toBe(false);

        await new Promise((r) => setTimeout(r, 150));
        expect(wire).toContain('event: gate.state');
        expect(wire).toContain('"gateEnabled":false');

        // ...and the next client to ask reads the new state rather than the
        // default it would have had to guess.
        const disarmed = await (await fetch(`${base()}/api/config`, { headers: h })).json();
        expect(disarmed.gateEnabled).toBe(false);
      } finally {
        ac.abort();
        await pump;
      }
    });

    it('★ a read-only server reports the gate as OFF — it cannot hold anything', async () => {
      const info = await startRO();
      const h = bearer(info.token as string);
      // Disarming widens what runs without review, so it takes the same grant as
      // typing.
      const res = await fetch(`${base()}/api/gate/off`, { method: 'POST', headers: h });
      expect(res.status).toBe(403);
      // ...but the reported state must be the EFFECTIVE one. The daemon only
      // holds a tool call when the runtime flag is clear AND this server can
      // resolve gates; a read-only server raises cards nobody can answer, so it
      // lets everything through. `gateArmed` is still true here — reporting that
      // would tell the phone calls are being held while none are.
      expect(gateArmed).toBe(true);
      expect((await (await fetch(`${base()}/api/config`, { headers: h })).json()).gateEnabled).toBe(false);
    });

    it('serves a code-block body behind the same grant as the turn page', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      projectorMock.codeBlock.mockReturnValue({ body: 'console.log(1)\n' });

      const res = await fetch(
        `${base()}/api/sessions/s1/turns/block?srcOffset=64&n=2&eventId=ev-1`,
        { headers: h },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ body: 'console.log(1)\n', bytes: 15 });
      // The eventId rides through: without it a rotated file answers at the same
      // offset with another conversation's code.
      expect(projectorMock.codeBlock).toHaveBeenCalledWith('s1', {
        srcOffset: 64,
        n: 2,
        eventId: 'ev-1',
      });
    });

    it('★ a stale ref is a 404, and an over-cap body says it was cut', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);

      // Rotated file / mid-line offset — the projector refuses. An empty 200
      // here would render as "this block is empty" instead of "re-fetch".
      projectorMock.codeBlock.mockReturnValue(null);
      const stale = await fetch(`${base()}/api/sessions/s1/turns/block?srcOffset=9&n=1`, { headers: h });
      expect(stale.status).toBe(404);
      expect((await stale.json()).error).toBe('block not found');

      // Garbage refs never reach the projector.
      projectorMock.codeBlock.mockClear();
      // `Number('')` and `Number(null)` are both 0, so an empty param and a
      // missing one would each read as "offset 0" and serve a block from the
      // first line of the file.
      for (const q of [
        'srcOffset=-1&n=1', 'srcOffset=0&n=0', 'srcOffset=abc&n=1',
        'n=1', 'srcOffset=&n=1', 'srcOffset=0&n=', 'srcOffset=%20&n=1',
      ]) {
        const bad = await fetch(`${base()}/api/sessions/s1/turns/block?${q}`, { headers: h });
        expect(bad.status).toBe(400);
      }
      expect(projectorMock.codeBlock).not.toHaveBeenCalled();

      // A large tool body is cut at the cap, and SAYS it was cut — the seam
      // lands mid-character here, which must not surface as U+FFFD. The cap is
      // 256 KB and must stay under the projector's 512 KB line-read ceiling: at
      // or above it, no body could ever reach the branch (2-MODEL review).
      const huge = `${'a'.repeat(256 * 1024 - 1)}가나다`;
      projectorMock.codeBlock.mockReturnValue({ body: huge });
      const capped = await fetch(`${base()}/api/sessions/s1/turns/block?srcOffset=0&n=1`, { headers: h });
      const body = await capped.json();
      expect(capped.status).toBe(200);
      expect(body.truncated).toBe(true);
      expect(body.bytes).toBe(Buffer.byteLength(huge, 'utf8'));
      expect(body.body).not.toContain('�');
      expect(Buffer.byteLength(body.body, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    });

    it('★ the orchestrator brain pane is unreadable, even with its id in hand', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      // A brain pty IS a live daemon session, and `getSession` says so. It is
      // excluded from the pane list, so a phone should never see one — but ids
      // are guessable by prefix and can ride an approval payload, and existence
      // alone used to be the whole check on these two routes.
      // Both marks, on separate panes: `isBrainPty` checks the env marker first
      // and falls back to the id prefix, and a daemon build that omits env from a
      // session must still refuse. One pane per mark keeps them independent.
      live.push({
        id: 'brain-ws-1', cwd: '/x', cols: 80, rows: 24, state: 'detached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: {}, cmd: '/usr/bin/claude',
      });
      live.push({
        id: 'pty-orchestrator', cwd: '/x', cols: 80, rows: 24, state: 'detached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/bin/claude',
      });
      projectorMock.status.mockReturnValue({ available: true, reason: 'ok', transcriptBasename: 's.jsonl' });
      projectorMock.snapshot.mockReturnValue({
        events: [{ id: 'e', kind: 'assistant_text', text: 'orchestrator secrets' }],
        cursor: { headOffset: 0, tailOffset: 1, fileSize: 1, mtimeMs: 0 },
        hasMore: false,
        truncatedHead: false,
      });
      projectorMock.codeBlock.mockReturnValue({ body: 'orchestrator secrets' });

      for (const id of ['brain-ws-1', 'pty-orchestrator']) {
        const turns = await fetch(`${base()}/api/sessions/${id}/turns`, { headers: h });
        expect(turns.status).toBe(404);
        const block = await fetch(
          `${base()}/api/sessions/${id}/turns/block?srcOffset=0&n=1`,
          { headers: h },
        );
        expect(block.status).toBe(404);
      }
      // Refused before the projector was consulted at all.
      expect(projectorMock.snapshot).not.toHaveBeenCalled();
      expect(projectorMock.codeBlock).not.toHaveBeenCalled();

      // The guard is not "refuse everything" — an ordinary pane still reads.
      const ok = await fetch(`${base()}/api/sessions/s2/turns`, { headers: h });
      expect(ok.status).toBe(200);
    });

    it('the block route refuses without --allow-transcript, by tag', async () => {
      const info = await startRO();
      const res = await fetch(`${base()}/api/sessions/s1/turns/block?srcOffset=0&n=1`, {
        headers: bearer(info.token as string),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.startsWith('transcript-disabled:')).toBe(true);
    });

    it('★ liveness is non-recording and reaches only panes the device has read', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      projectorMock.status.mockReturnValue({ available: true, reason: 'ok', transcriptBasename: 's.jsonl' });
      projectorMock.snapshot.mockReturnValue({
        events: [],
        cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 },
        hasMore: false,
        truncatedHead: false,
      });

      const ac = new AbortController();
      const stream = await fetch(`${base()}/api/events`, {
        signal: ac.signal,
        headers: { ...h, Accept: 'text/event-stream' },
      });
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      // One continuous pump into a buffer. A read-with-timeout loop would leave
      // a pending read() behind on every timeout, and that orphan consumes the
      // next chunk into a promise nobody awaits — the event vanishes.
      let wire = '';
      const pump = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value) wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch {
          /* aborted at the end of the test */
        }
      })();
      const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

      try {
        // Not a watcher yet — the device never opened s1's turn view, so its SSE
        // must not carry s1's per-tool-call traffic.
        server.emitAgentLiveness({ sessionId: 's1', state: 'idle', agent: 'Claude Code', at: 1 });
        await settle(150);
        expect(wire).not.toContain('agent.liveness');

        expect((await fetch(`${base()}/api/sessions/s1/turns`, { headers: h })).status).toBe(200);

        // A settled state skips the coalescing window: it is the transition the
        // header exists to catch, so it must not wait out a second.
        const before = await (await fetch(`${base()}/api/events`, { headers: h })).json();
        server.emitAgentLiveness({
          sessionId: 's1',
          state: 'awaiting_input',
          agent: 'Claude Code',
          at: 2,
        });
        await settle(200);
        expect(wire).toContain('event: agent.liveness');
        expect(wire).toContain('"state":"awaiting_input"');

        // ...and none of it is recorded: a busy pane's liveness must never evict
        // a pending approval from the replay window (#782 CRITICAL 3).
        for (let i = 0; i < 60; i++) {
          server.emitAgentLiveness({ sessionId: 's1', state: 'tool', tool: 'Bash', agent: 'Claude Code', at: i });
        }
        const after = await (await fetch(`${base()}/api/events`, { headers: h })).json();
        expect(after.headId).toBe(before.headId);
        expect(after.events).toEqual(before.events);
      } finally {
        ac.abort();
        await pump;
      }
    });

    it('★ /api/sessions carries liveness state (never the tool) with no stream or watcher', async () => {
      const info = await startRO();
      // No SSE client, no turn-view watcher: the whole point of the list field
      // is that a phone which only polls still knows which panes are working.
      server.emitAgentLiveness({
        sessionId: 's1',
        state: 'busy',
        tool: 'Bash',
        agent: 'Claude Code',
        at: Date.now(),
      });

      const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
      const body = (await res.json()) as {
        sessions: Array<{ id: string; liveness?: { state: string; tool?: string; at: number } }>;
      };
      const s1 = body.sessions.find((s) => s.id === 's1');
      expect(s1?.liveness?.state).toBe('busy');
      // The tool name is watcher-only and must not have been widened with the state.
      expect(s1?.liveness).not.toHaveProperty('tool');
      expect(JSON.stringify(body)).not.toContain('Bash');
      // A pane with no liveness signal carries no field at all — absent means
      // "not known", not "idle".
      expect(body.sessions.find((s) => s.id === 's2')).not.toHaveProperty('liveness');
    });

    // ── #1315: liveness on the pane stream the terminal face already holds ──
    //
    // The fleet copy above needs a `/turns` read, which is itself 403 without
    // --allow-transcript, so a phone that only ever opens the terminal mirror
    // saw no liveness at all and had to infer "is it running" from a poll plus
    // an activity window. These four cover the contract: it arrives, it is
    // narrowed, it is scoped to one pane, and it dies with the socket.

    /** Drain an SSE body into a growing buffer until the test aborts it. */
    const pumpSse = (res: Awaited<ReturnType<typeof fetch>>) => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const state = { wire: '' };
      // One continuous pump, for the same reason the /api/events test above
      // gives: a read-with-timeout loop orphans a pending read() on every
      // timeout, and the orphan swallows the next chunk into a promise nobody
      // awaits — the event simply vanishes.
      const done = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value) state.wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch {
          /* aborted at the end of the test */
        }
      })();
      return { state, done };
    };
    const settleMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /**
     * Wait until a pumped buffer contains `want`, or fail at the deadline.
     *
     * A positive assertion must never be a fixed sleep: a loopback chunk that
     * lands at 260 ms on a loaded runner would be a hard failure rather than a
     * slower pass. Polling the buffer the pump already fills costs nothing and
     * leaves no orphaned `read()` behind. (A NEGATIVE assertion is still a
     * bounded sleep — proving absence has no event to wait for.)
     */
    const waitForWire = async (
      state: { wire: string },
      want: string,
      budgetMs = 3_000,
    ): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while (!state.wire.includes(want) && Date.now() < deadline) await settleMs(20);
      expect(state.wire).toContain(want);
    };

    it('★ #1315 the pane stream carries liveness with no /turns read and no --allow-transcript', async () => {
      const info = await startRO();
      const ac = new AbortController();
      const res = await fetch(
        `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const { state, done } = pumpSse(res);
      try {
        // A settled state skips the coalescing window — it is the transition a
        // header exists to catch.
        server.emitAgentLiveness({
          sessionId: 's1', state: 'awaiting_input', agent: 'Claude Code', at: 2,
        });
        await waitForWire(state, 'event: agent.liveness');
        expect(state.wire).toContain('"state":"awaiting_input"');
        expect(state.wire).toContain('"sessionId":"s1"');
      } finally {
        ac.abort();
        await done;
      }
    });

    it('★ #1315 a coalesced working state reaches the pane stream too', async () => {
      // Every other case here emits a SETTLED state, which skips the coalescing
      // window entirely. `busy`/`tool` take the other path — the one that arms a
      // timer and delivers from its callback — so without this the whole
      // setTimeout branch onto the pane stream is untested.
      const info = await startRO();
      const ac = new AbortController();
      const res = await fetch(
        `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const { state, done } = pumpSse(res);
      try {
        server.emitAgentLiveness({
          sessionId: 's1', state: 'busy', agent: 'Claude Code', at: 1,
        });
        // Last-write-wins inside the window: the frame that lands is the newest
        // state, not the one that opened it.
        server.emitAgentLiveness({
          sessionId: 's1', state: 'tool', tool: 'Bash', agent: 'Claude Code', at: 2,
        });
        await waitForWire(state, 'event: agent.liveness');
        expect(state.wire).toContain('"state":"tool"');
        expect(state.wire).not.toContain('"state":"busy"');
        expect(state.wire).not.toContain('Bash');
      } finally {
        ac.abort();
        await done;
      }
    });

    it('★ #1315 pane-stream liveness withholds the tool name and never crosses panes', async () => {
      const info = await startRO();
      const ac = new AbortController();
      const res = await fetch(
        `${base()}/api/stream?session=s2&token=${encodeURIComponent(info.token as string)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const { state, done } = pumpSse(res);
      try {
        // This connection asked for s2 by name. Another pane's per-tool-call
        // traffic is not its business.
        server.emitAgentLiveness({
          sessionId: 's1', state: 'awaiting_permission', tool: 'Bash', agent: 'Claude Code', at: 1,
        });
        await settleMs(200);
        expect(state.wire).not.toContain('agent.liveness');

        // Its own pane's state does arrive — but the tool name is agent-authored
        // text off the hook pipe, withheld here exactly as /api/sessions
        // withholds it. Widening the STATE is the point; widening what the pane
        // is typing is not.
        server.emitAgentLiveness({
          sessionId: 's2', state: 'awaiting_permission', tool: 'Bash', agent: 'Claude Code', at: 2,
        });
        await waitForWire(state, 'event: agent.liveness');
        expect(state.wire).toContain('"state":"awaiting_permission"');
        expect(state.wire).not.toContain('Bash');
        expect(state.wire).not.toContain('"tool"');
      } finally {
        ac.abort();
        await done;
      }
    });

    it('★ #1315 a closed pane stream leaves no liveness subscriber behind', async () => {
      await startRO();
      const phone = await pairDevice('Phone');
      const ticket = await ticketFor(phone.token);
      const ac = new AbortController();
      const res = await fetch(
        `${base()}/api/stream?session=s1&ticket=${encodeURIComponent(ticket)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const { state, done } = pumpSse(res);
      server.emitAgentLiveness({
        sessionId: 's1', state: 'awaiting_input', agent: 'Claude Code', at: 1,
      });
      await waitForWire(state, 'event: agent.liveness');
      expect(server.status().clients).toBe(1);

      ac.abort();
      await done;
      const deadline = Date.now() + 3_000;
      while (server.status().clients !== 0 && Date.now() < deadline) await settleMs(20);

      // The subscription IS the connection, so nothing survives it — the
      // server's own client count going back to zero is that claim, and it
      // cannot pass for the wrong reason the way a revoke count could.
      // `transcriptWatchers`, the fleet channel's registry, is deliberately
      // never undone; this path has nothing to undo.
      expect(server.status().clients).toBe(0);
      // Revoking the device finds nothing left to cut either.
      expect(server.disconnectDevice(phone.deviceId)).toBe(0);
    });

    it('★ #1388 a paired device cannot stream or type into the brain pane; the operator still can', async () => {
      live.push({
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/local/bin/claude',
      });
      const ac = new AbortController();
      try {
        const info = await startRW();
        // A device credential, exactly as a phone gets one.
        const paired = await fetch(`${base()}/api/pair?code=${info.pairCode as string}`);
        expect(paired.status).toBe(200);
        const deviceToken = ((await paired.json()) as { token: string }).token;
        const operatorToken = encodeURIComponent(info.token as string);
        // A device carries its credential in the Authorization header (an
        // EventSource would use a stream ticket; the class gate is the same).
        const asDevice = { Authorization: `Bearer ${deviceToken}` };

        // Device: the brain id answers exactly like a missing pane (no
        // confirmation that the id exists), a worker pane still streams.
        const brainAsDevice = await fetch(`${base()}/api/stream?session=brain-abc`, {
          headers: asDevice, signal: ac.signal,
        });
        expect(brainAsDevice.status).toBe(404);
        const paneAsDevice = await fetch(`${base()}/api/stream?session=s1`, {
          headers: asDevice, signal: ac.signal,
        });
        expect(paneAsDevice.status).toBe(200);
        const panePump = pumpSse(paneAsDevice);

        // Operator: unchanged — the desktop's own mirror streams the brain.
        const brainAsOperator = await fetch(`${base()}/api/stream?session=brain-abc&token=${operatorToken}`, {
          signal: ac.signal,
        });
        expect(brainAsOperator.status).toBe(200);
        const brainPump = pumpSse(brainAsOperator);

        // Device input into the brain pane is refused the same way; nothing
        // reaches the pty. (404, not 403: "not yours" and "gone" are one answer.)
        const typed = await fetch(`${base()}/api/input?session=brain-abc`, {
          method: 'POST',
          headers: { ...asDevice, 'Content-Type': 'text/plain' },
          body: 'rm -rf /\r',
        });
        expect(typed.status).toBe(404);

        // Every other per-pane route a device can reach answers the same way,
        // so none of them confirms the id (review: resize/delete/diff/commands
        // had the identical bare lookup).
        const resized = await fetch(`${base()}/api/sessions/brain-abc/resize`, {
          method: 'POST', headers: { ...asDevice, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: 100, rows: 30 }),
        });
        expect(resized.status).toBe(404);
        const deleted = await fetch(`${base()}/api/sessions/brain-abc`, { method: 'DELETE', headers: asDevice });
        expect(deleted.status).toBe(404);
        const diffed = await fetch(`${base()}/api/sessions/brain-abc/diff`, { headers: asDevice });
        expect(diffed.status).toBe(404);
        const commands = await fetch(`${base()}/api/sessions/brain-abc/commands`, { headers: asDevice });
        expect(commands.status).toBe(404);
        expect(live.find((s) => s.id === 'brain-abc')).toBeDefined();

        ac.abort();
        await Promise.all([panePump.done, brainPump.done]);
      } finally {
        ac.abort();
      }
    });

    it('★ #1397 a paired device can neither list nor answer a brain pane approval; the operator still can', async () => {
      live.push({
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/local/bin/claude',
      });
      // Seeded straight into the registry rather than driven through the hook
      // path: the producer refuses to create one of these (HookIngest), and
      // this asserts the route refuses to serve one anyway — the reachability
      // of the producer is the assumption #1397 is about.
      approvalRecords.push(mkApproval({
        id: 'ap-brain',
        sessionId: 'brain-abc',
        question: 'ship the orchestrator secret?',
      }));
      approvalRecords.push(mkApproval({ id: 'ap-worker', sessionId: 's1' }));

      const info = await startRO();
      const paired = await fetch(`${base()}/api/pair?code=${info.pairCode as string}`);
      expect(paired.status).toBe(200);
      const deviceToken = ((await paired.json()) as { token: string }).token;
      const asDevice = { Authorization: `Bearer ${deviceToken}` };

      // Listed: the worker's approval only, and nothing that names the brain.
      const listed = await fetch(`${base()}/api/approvals`, { headers: asDevice });
      expect(listed.status).toBe(200);
      const text = await listed.text();
      expect(text).toContain('ap-worker');
      expect(text).not.toContain('ap-brain');
      expect(text).not.toContain('brain-abc');
      expect(text).not.toContain('orchestrator secret');

      // Answerable: not with the id in hand either. Same 404 as an unknown id,
      // and the registry is never asked to resolve it.
      const answered = await postApproval(deviceToken, 'ap-brain', { decision: 'approve' });
      expect(answered.status).toBe(404);
      expect(resolveCalls).toEqual([]);

      // The device's own panes are unaffected.
      const worker = await postApproval(deviceToken, 'ap-worker', { decision: 'approve' });
      expect(worker.status).toBe(200);
      expect(resolveCalls.map((c) => c.id)).toEqual(['ap-worker']);

      // Operator: unchanged. The desktop lists and answers the brain's own
      // record exactly as before — the exclusion follows the credential class.
      const asOperator = bearer(info.token as string);
      const operatorList = await fetch(`${base()}/api/approvals`, { headers: asOperator });
      expect(await operatorList.text()).toContain('ap-brain');
      const operatorAnswer = await fetch(`${base()}/api/approvals/ap-brain`, {
        method: 'POST',
        headers: { ...asOperator, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(operatorAnswer.status).toBe(200);
      expect(resolveCalls.map((c) => c.id)).toEqual(['ap-worker', 'ap-brain']);
    });


    it('★ #1315 pane-stream liveness refuses the brain pane and an invented session id', async () => {
      // `sessionId` arrives from the hook pipe, which is not a trusted producer,
      // and the orchestrator brain is not a worker pane a phone may learn
      // anything about. `handleStream` itself still resolves with a bare
      // getSession, so the delivery side takes the gate the transcript routes
      // take rather than inheriting that pane route's older, looser check.
      live.push({
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1' }, cmd: '/usr/local/bin/claude',
      });
      const ac = new AbortController();
      try {
        const info = await startRO();
        const token = encodeURIComponent(info.token as string);
        const brain = await fetch(`${base()}/api/stream?session=brain-abc&token=${token}`, {
          signal: ac.signal,
        });
        expect(brain.status).toBe(200);
        const brainPump = pumpSse(brain);
        const pane = await fetch(`${base()}/api/stream?session=s1&token=${token}`, {
          signal: ac.signal,
        });
        expect(pane.status).toBe(200);
        const panePump = pumpSse(pane);

        server.emitAgentLiveness({
          sessionId: 'brain-abc', state: 'awaiting_input', agent: 'Claude Code', at: 1,
        });
        // A pane the daemon does not have at all — an id a compromised pane
        // could invent — reaches nobody either.
        server.emitAgentLiveness({
          sessionId: 'no-such-pane', state: 'awaiting_input', agent: 'Claude Code', at: 1,
        });
        await settleMs(250);
        expect(brainPump.state.wire).not.toContain('agent.liveness');
        expect(panePump.state.wire).not.toContain('agent.liveness');

        // ...and the gate is the pane's identity, not a blanket refusal: a real
        // worker pane on the same server still gets its own state.
        server.emitAgentLiveness({
          sessionId: 's1', state: 'awaiting_input', agent: 'Claude Code', at: 2,
        });
        await waitForWire(panePump.state, 'event: agent.liveness');

        ac.abort();
        await Promise.all([brainPump.done, panePump.done]);
      } finally {
        ac.abort();
        live.length = 3;
      }
    });

    it('★ #1315 the fleet stream keeps its watcher gate — the pane stream is a second door', async () => {
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      const ac = new AbortController();
      // A pane stream for s1 AND a fleet stream, on one principal that has never
      // read s1's turn view. The pane copy must arrive; the fleet copy must not.
      const pane = await fetch(
        `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
        { signal: ac.signal },
      );
      expect(pane.status).toBe(200);
      const panePump = pumpSse(pane);
      const fleet = await fetch(`${base()}/api/events`, {
        signal: ac.signal,
        headers: { ...h, Accept: 'text/event-stream' },
      });
      expect(fleet.status).toBe(200);
      const fleetPump = pumpSse(fleet);
      try {
        server.emitAgentLiveness({
          sessionId: 's1', state: 'awaiting_input', agent: 'Claude Code', at: 1,
        });
        await waitForWire(panePump.state, 'event: agent.liveness');
        expect(fleetPump.state.wire).not.toContain('agent.liveness');
      } finally {
        ac.abort();
        await Promise.all([panePump.done, fleetPump.done]);
      }
    });

    it('★ a stale working state drops out of /api/sessions; a resting one does not', async () => {
      const info = await startRO();
      const old = Date.now() - 301_000;
      server.emitAgentLiveness({ sessionId: 's1', state: 'busy', agent: 'Claude Code', at: old });
      server.emitAgentLiveness({ sessionId: 's2', state: 'idle', agent: 'Claude Code', at: old });

      const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
      const body = (await res.json()) as {
        sessions: Array<{ id: string; liveness?: { state: string } }>;
      };
      // "Running Bash" from five minutes ago is a crashed agent, not a busy one.
      expect(body.sessions.find((s) => s.id === 's1')).not.toHaveProperty('liveness');
      // An agent that stopped five minutes ago is still stopped.
      expect(body.sessions.find((s) => s.id === 's2')?.liveness?.state).toBe('idle');
    });

    it('★ liveness is not recorded for a sessionId the daemon does not have', async () => {
      const info = await startRO();
      // The hook pipe is not a trusted producer; an invented id must not enter
      // the map (which nothing else would ever evict).
      server.emitAgentLiveness({ sessionId: 'no-such-pane', state: 'busy', agent: 'Claude Code', at: Date.now() });

      const res = await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) });
      const body = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
      expect(JSON.stringify(body)).not.toContain('no-such-pane');
    });

    it('★ a liveness `at` is clamped forward and never walks backward', async () => {
      const info = await startRO();
      // A pane whose clock runs an hour fast would otherwise sit at "0s" for an
      // hour AND outlive the staleness cutoff however long it had been dead.
      const future = Date.now() + 3_600_000;
      server.emitAgentLiveness({ sessionId: 's1', state: 'busy', agent: 'Claude Code', at: future });
      // Hook delivery is not ordered: an older state arriving late must not
      // resurrect itself over the newer one.
      server.emitAgentLiveness({ sessionId: 's1', state: 'idle', agent: 'Claude Code', at: 1_000 });
      // Not a number at all → refused; the believable entry survives.
      server.emitAgentLiveness({
        sessionId: 's1', state: 'idle', agent: 'Claude Code',
        at: Number.NaN,
      });

      const body = (await (
        await fetch(`${base()}/api/sessions`, { headers: bearer(info.token as string) })
      ).json()) as { sessions: Array<{ id: string; liveness?: { state: string; at: number } }> };
      const liveness = body.sessions.find((s) => s.id === 's1')?.liveness;
      expect(liveness?.state).toBe('busy');
      expect(liveness?.at).toBeLessThan(future);
      expect(liveness?.at).toBeGreaterThan(Date.now() - 10_000);
    });

    it('★ /api/sessions sweeps snapshot state for panes that died without a DELETE', async () => {
      const info = await startRO();
      const h = bearer(info.token as string);
      server.emitAgentLiveness({ sessionId: 's2', state: 'idle', agent: 'Claude Code', at: Date.now() });
      const first = (await (await fetch(`${base()}/api/sessions`, { headers: h })).json()) as {
        sessions: Array<{ id: string; liveness?: { state: string } }>;
      };
      expect(first.sessions.find((s) => s.id === 's2')?.liveness?.state).toBe('idle');

      // s2's process exits. Nothing tells the web server — it subscribes to no
      // death event — so the sweep on the next list is the only thing that can
      // drop the entry.
      const [dead] = live.splice(1, 1);
      await fetch(`${base()}/api/sessions`, { headers: h });
      // Put an identically-named pane back. A leaked entry would show up here as
      // a brand-new pane that is somehow already idle.
      live.splice(1, 0, dead);
      const after = (await (await fetch(`${base()}/api/sessions`, { headers: h })).json()) as {
        sessions: Array<{ id: string; liveness?: { state: string } }>;
      };
      expect(after.sessions.find((s) => s.id === 's2')).not.toHaveProperty('liveness');
    });

    it('★ lastAssistantText rides --allow-transcript, is tail-cut to 140 graphemes, and is read off the loop', async () => {
      // A real transcript on disk: the reader lstats and tail-reads the file, so
      // a mock would test nothing that ships.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-transcript-'));
      const transcript = path.join(dir, 'session.jsonl');
      // Over 600 characters, so `condense()` in the reader keeps the TAIL and
      // the preview is cutting an already-cut string. Newlines on purpose — a
      // list row is one line, and the flattening is part of the contract.
      // U+200B and the RLO are the invisibles that must not survive; the ZWJ in
      // the emoji must, or one grapheme shatters into three.
      const said = `${Array.from({ length: 400 }, (_, i) => `줄${i}`).join('\n')}\n\u200b\u202e끝 👩\u200d💻`;
      expect(said.length).toBeGreaterThan(600);
      const entry = (text: string) =>
        `${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })}\n`;
      fs.writeFileSync(transcript, entry(said));
      // Pin mtime to a whole millisecond so the (path, size, mtime) cache key can
      // be reproduced exactly below — a natural mtime carries sub-ms precision
      // that `utimesSync` cannot round-trip.
      const pinned = new Date(1_700_000_000_000);
      fs.utimesSync(transcript, pinned, pinned);
      projectorMock.transcriptPath.mockReturnValue(transcript);

      try {
        // Transcript grant OFF → conversation content stays off the list, even
        // though the projector would happily hand over the path.
        const ro = await startRO();
        const off = (await (
          await fetch(`${base()}/api/sessions`, { headers: bearer(ro.token as string) })
        ).json()) as { sessions: Array<{ id: string; lastAssistantText?: string }> };
        expect(off.sessions.every((s) => s.lastAssistantText === undefined)).toBe(true);
        // The path is the projector's ONE resolve per row; status() is not part
        // of this path at all (it would re-walk the same binding for a size this
        // stats for itself).
        expect(projectorMock.status).not.toHaveBeenCalled();
        await server.stop();

        const on = await startWithTranscript();
        const h = bearer(on.token as string);
        const poll = async () => {
          const body = (await (await fetch(`${base()}/api/sessions`, { headers: h })).json()) as {
            sessions: Array<{ id: string; lastAssistantText?: string }>;
          };
          return body.sessions.find((s) => s.id === 's1')?.lastAssistantText;
        };

        // The FIRST poll answers with no field: the 256 KB read is started in
        // the background, never on the request's own thread.
        expect(await poll()).toBeUndefined();

        let text: string | undefined;
        await vi.waitFor(async () => {
          text = await poll();
          expect(text).toBeDefined();
        });

        expect(text).not.toContain('\n');
        // Cut from the END: an agent's ask is the last thing it wrote.
        expect(text?.startsWith('…')).toBe(true);
        expect(text?.endsWith('끝 👩\u200d💻')).toBe(true);
        expect(text).not.toContain('\u200b');
        expect(text).not.toContain('\u202e');
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        // 140 INCLUDING the ellipsis — the truncated row is never the wider one.
        expect([...segmenter.segment(text as string)].length).toBe(140);

        // Same (path, size, mtime) → served from the memo. Rewriting the file
        // with a byte-identical, content-different message and restoring the
        // pinned mtime is the only way to prove the second poll never re-read:
        // a re-read would answer with the new ending.
        fs.writeFileSync(transcript, entry(said.replace('끝', '꾰')));
        fs.utimesSync(transcript, pinned, pinned);
        expect(await poll()).toBe(text);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('#782 - turn-view images (GET /api/sessions/:id/turns/image)', () => {
    /** The smallest legal PNG: signature, IHDR for 1x1, one IDAT, IEND. */
    const PNG_1X1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    /** Temp trees this describe made, torn down after every case. */
    let dirs: string[];
    const tmpTree = (): string => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-turn-image-')));
      dirs.push(dir);
      return dir;
    };
    const imageUrl = (id: string, p: string): string =>
      `${base()}/api/sessions/${id}/turns/image?path=${encodeURIComponent(p)}`;

    beforeEach(() => { dirs = []; });
    afterEach(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('403 tagged transcript-disabled without --allow-transcript', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'a.png');
      fs.writeFileSync(file, PNG_1X1);
      managed.meta.spawnCwd = dir;
      const info = await startRO();
      const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      // The TAG is the contract, exactly as on /turns and /turns/block.
      expect(body.error.startsWith('transcript-disabled:')).toBe(true);
    });

    it('401 without a Bearer header', async () => {
      await startWithTranscript();
      const res = await fetch(imageUrl('s1', '/x/a.png'));
      expect(res.status).toBe(401);
    });

    it('404 for an unknown pane, and for the orchestrator brain', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'a.png');
      fs.writeFileSync(file, PNG_1X1);
      // The brain pane's own spawn cwd holds the image, so only readableSession
      // stands between a guessed id and the orchestrator's screenshots.
      live.push({
        id: 'brain-ws-1', cwd: dir, cols: 80, rows: 24, state: 'detached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: {}, cmd: '/usr/bin/claude',
      });
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      for (const id of ['no-such-pane', 'brain-ws-1']) {
        const res = await fetch(imageUrl(id, file), { headers: h });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('session not found');
      }
    });

    it('400 bad-image-ref for a missing, empty, relative or NUL-bearing path', async () => {
      managed.meta.spawnCwd = tmpTree();
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      const refs = ['', '   ', 'relative/a.png', './a.png', `/x/a${String.fromCharCode(0)}.png`];
      for (const ref of refs) {
        const res = await fetch(imageUrl('s1', ref), { headers: h });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('bad-image-ref');
      }
      // No `path` at all is the same refusal.
      const bare = await fetch(`${base()}/api/sessions/s1/turns/image`, { headers: h });
      expect(bare.status).toBe(400);
      expect((await bare.json()).error).toBe('bad-image-ref');
    });

    it('404 for a real file outside the boundary', async () => {
      managed.meta.spawnCwd = tmpTree();
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', '/etc/hosts'), {
        headers: bearer(info.token as string),
      });
      expect(res.status).toBe(404);
      // "outside" and "missing" answer alike: a distinct code would confirm the
      // file exists to a caller mapping the disk.
      expect((await res.json()).error).toBe('image not found');
    });

    it('404 for a symlink inside the cwd that points outside it', async () => {
      const root = tmpTree();
      const cwd = path.join(root, 'cwd');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(cwd);
      fs.mkdirSync(outside);
      const secret = path.join(outside, 'secret.png');
      fs.writeFileSync(secret, PNG_1X1);
      const link = path.join(cwd, 'looks-local.png');
      fs.symlinkSync(secret, link);
      managed.meta.spawnCwd = cwd;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', link), { headers: bearer(info.token as string) });
      expect(res.status).toBe(404);
    });

    it('404 for a file under meta.cwd - only spawnCwd is a boundary', async () => {
      const root = tmpTree();
      const cwd = path.join(root, 'spawned');
      const osc7 = path.join(root, 'osc7-said-so');
      fs.mkdirSync(cwd);
      fs.mkdirSync(osc7);
      const wandered = path.join(osc7, 'a.png');
      fs.writeFileSync(wandered, PNG_1X1);
      // `meta.cwd` is whatever the pane's own process last claimed via OSC 7 -
      // three bytes of terminal output, i.e. attacker-controlled. Honoring it
      // would let a hostile process point this route at the whole home dir.
      managed.meta.spawnCwd = cwd;
      managed.meta.cwd = osc7;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', wandered), { headers: bearer(info.token as string) });
      expect(res.status).toBe(404);
    });

    it('404 for a sibling directory sharing the boundary prefix', async () => {
      const root = tmpTree();
      const cwd = path.join(root, 'b');
      const sibling = path.join(root, 'bc');
      fs.mkdirSync(cwd);
      fs.mkdirSync(sibling);
      const file = path.join(sibling, 'a.png');
      fs.writeFileSync(file, PNG_1X1);
      managed.meta.spawnCwd = cwd;
      const info = await startWithTranscript();
      // A string prefix test passes `/a/bc/a.png` against root `/a/b`.
      const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(404);
    });

    it('200 when the boundary root is itself a symlink', async () => {
      const root = tmpTree();
      const realDir = path.join(root, 'real');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'a.png'), PNG_1X1);
      const linkDir = path.join(root, 'linked');
      fs.symlinkSync(realDir, linkDir);
      // The shape macOS hands us for free: `/tmp` is a symlink to `/private/tmp`,
      // so a root compared unresolved rejects every file beneath it.
      managed.meta.spawnCwd = linkDir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', path.join(linkDir, 'a.png')), {
        headers: bearer(info.token as string),
      });
      expect(res.status).toBe(200);
    });

    it('serves a photo out of the uploads directory, session-independently', async () => {
      managed.meta.spawnCwd = tmpTree();
      const photo = path.join(uploadsDir, 'photo.png');
      fs.writeFileSync(photo, PNG_1X1);
      try {
        const info = await startWithTranscript();
        const res = await fetch(imageUrl('s1', photo), { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
      } finally {
        // uploadsDir is shared across describes; the tree cleanup does not cover it.
        fs.rmSync(photo, { force: true });
      }
    });

    it('404 for a FIFO inside the boundary instead of hanging on open', async () => {
      const dir = tmpTree();
      const fifo = path.join(dir, 'pipe.png');
      execFileSync('mkfifo', [fifo]);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', fifo), { headers: bearer(info.token as string) });
      expect(res.status).toBe(404);
    });

    it('413 when the file grew past the size the gate approved', async () => {
      // The route reads exactly the size it measured and probes one byte past
      // it. A file that is already over the cap is the 413 the gate catches;
      // this pins the second gate — the probe — by handing it a file whose
      // stat and contents disagree the way a growing file would.
      const dir = tmpTree();
      const file = path.join(dir, 'grow.png');
      fs.writeFileSync(file, PNG_1X1);
      managed.meta.spawnCwd = dir;
      const statSpy = vi.spyOn(fs.promises, 'open');
      const info = await startWithTranscript();
      statSpy.mockImplementationOnce(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await fs.promises.open(...args);
        const realStat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const st = await realStat();
          return Object.assign(st, { size: st.size - 1 });
        }) as typeof handle.stat;
        return handle;
      });
      try {
        const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
        expect(res.status).toBe(413);
        const body = await res.json();
        expect(body.detail).not.toMatch(/image is/);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('serves the pane cwd on a daemon with no uploads directory wired', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'a.png');
      fs.writeFileSync(file, PNG_1X1);
      managed.meta.spawnCwd = dir;
      // `uploadsDir` is optional - a daemon started without `--allow-upload`
      // has none, and the cwd root has to keep working on its own.
      const noUploads = new WebTerminalServer({
        sessionManager,
        projector: () => projectorMock as unknown as TranscriptProjector,
        log: () => { /* silent in tests */ },
        assetsDir: os.tmpdir(),
      });
      const info = await noUploads.start({
        port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: true,
      });
      try {
        const url = `http://127.0.0.1:${info.port}/api/sessions/s1/turns/image?path=${encodeURIComponent(file)}`;
        const res = await fetch(url, { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
      } finally {
        await noUploads.stop();
      }
    });

    it('415 not-an-image for a text file inside the boundary', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'notes.png');
      fs.writeFileSync(file, 'plain text wearing a .png suffix');
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe('not-an-image');
    });

    it('404 for a directory inside the boundary', async () => {
      const dir = tmpTree();
      const sub = path.join(dir, 'pictures');
      fs.mkdirSync(sub);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', sub), { headers: bearer(info.token as string) });
      expect(res.status).toBe(404);
    });

    it('413 image-too-large over the 8 MiB cap', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'huge.png');
      // One byte over. The size gate runs before the magic-byte read on purpose:
      // refusing on the stat is what keeps a huge file from being read at all.
      fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1));
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe('image-too-large');
    });

    it('200 serves the bytes with the sniffed type, a length and no-store', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'shot.bin');
      fs.writeFileSync(file, PNG_1X1);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(imageUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(200);
      // The BYTES decide the type, not the `.bin` the transcript named.
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-length')).toBe(String(PNG_1X1.length));
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_1X1)).toBe(true);
    });

    it('/api/config advertises turnImages only alongside the transcript grant', async () => {
      const off = await startRO();
      const offBody = await (
        await fetch(`${base()}/api/config`, { headers: bearer(off.token as string) })
      ).json();
      // ABSENT, not false: that is exactly how a daemon predating the route reads.
      expect(offBody).not.toHaveProperty('turnImages');

      await server.stop();
      const on = await startWithTranscript();
      const onBody = await (
        await fetch(`${base()}/api/config`, { headers: bearer(on.token as string) })
      ).json();
      expect(onBody).toHaveProperty('turnImages', true);
    });
  });

  describe('turn-view files (GET /api/sessions/:id/turns/file)', () => {
    /** The smallest legal PNG: signature, IHDR for 1x1, one IDAT, IEND. */
    const PNG_1X1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    /**
     * An ISO BMFF header: the `ftyp` box's own length, the marker at byte 4,
     * the major brand at byte 8, a minor version, one compatible brand. Enough
     * bytes for the sniffer and nothing more — what is being pinned is the
     * brand table, not a decoder.
     */
    const bmff = (brand: string): Buffer => {
      const box = Buffer.alloc(24);
      box.writeUInt32BE(24, 0);
      box.write('ftyp', 4, 'latin1');
      box.write(brand, 8, 'latin1');
      box.writeUInt32BE(512, 12);
      box.write(brand, 16, 'latin1');
      box.write('mp41', 20, 'latin1');
      return box;
    };
    let dirs: string[];
    const tmpTree = (): string => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-turn-file-')));
      dirs.push(dir);
      return dir;
    };
    const fileUrl = (id: string, p: string): string =>
      `${base()}/api/sessions/${id}/turns/file?path=${encodeURIComponent(p)}`;
    /**
     * A file of `size` bytes whose head is `head`. `truncate` makes the tail
     * SPARSE, so a 128 MB fixture costs no disk and no wall clock — writing
     * real bytes for the cap cases would dominate the run.
     */
    const sparse = (dir: string, name: string, head: Buffer, size: number): string => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, head);
      fs.truncateSync(file, size);
      return file;
    };

    /**
     * Wrap the FileHandle this route opens FOR ONE PATH. Scoping by path is not
     * tidiness: `fs.promises.open` is global, the daemon opens files of its own
     * (state, devices) while a test runs, and a `mockImplementationOnce` can be
     * spent on one of those instead — the handler then gets a real handle and
     * the case silently proves nothing, or worse, a stub that blocks parks a
     * read the suite never finishes.
     */
    /**
     * The paths every intercepted `open` was asked for, so a case that never
     * fired says WHY in its failure rather than just asserting zero.
     */
    let openedPaths: string[] = [];
    /**
     * Wrap the FileHandle this route opens FOR ONE FILE. Scoping matters:
     * `fs.promises.open` is global and the daemon opens files of its own while
     * a case runs, so an unscoped `mockImplementationOnce` can be spent on one
     * of those — the case then silently proves nothing, or parks the suite if
     * the stub blocks.
     *
     * The file is identified by INODE, not by the path string. The handler
     * opens whatever `realpath` returned, and a test that compares spellings is
     * one `/tmp` symlink, one mount, one case difference away from matching
     * nothing at all — silently, because "never intercepted" and "intercepted
     * and the route behaved" look identical from the assertion side. The path
     * is still accepted as a fallback for platforms that report no inode.
     */
    const interceptOpen = (
      target: string,
      wrap: (handle: fs.promises.FileHandle) => Promise<fs.promises.FileHandle>,
    ) => {
      const real = fs.promises.open;
      const targetIno = fs.statSync(target).ino;
      let used = false;
      const spy = vi.spyOn(fs.promises, 'open');
      spy.mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await real(...args);
        openedPaths.push(String(args[0]));
        if (used) return handle;
        let mine = String(args[0]) === target;
        if (!mine && targetIno !== 0) {
          try {
            mine = (await handle.stat()).ino === targetIno;
          } catch {
            mine = false;
          }
        }
        if (!mine) return handle;
        used = true;
        return wrap(handle);
      }) as never);
      return spy;
    };

    beforeEach(() => { dirs = []; openedPaths = []; });
    afterEach(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('403 tagged transcript-disabled without --allow-transcript', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'a.mp4');
      fs.writeFileSync(file, bmff('isom'));
      managed.meta.spawnCwd = dir;
      const info = await startRO();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      // The phone splits this refusal from every other 403 by the PREFIX.
      expect((await res.json()).error.startsWith('transcript-disabled:')).toBe(true);
    });

    it('401 without a Bearer header', async () => {
      await startWithTranscript();
      const res = await fetch(fileUrl('s1', '/x/a.mp4'));
      expect(res.status).toBe(401);
    });

    it('serves mp4, QuickTime and every type the image route already served', async () => {
      const dir = tmpTree();
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      // The BRANDS decide, and `qt  ` must not be folded into video/mp4: the
      // phone names its cache file from this header, and AVPlayer will not
      // open a QuickTime movie called `.mp4`.
      const cases: Array<[string, Buffer, string]> = [
        ['clip.mp4', bmff('isom'), 'video/mp4'],
        ['clip2.mp4', bmff('mp42'), 'video/mp4'],
        ['clip3.mp4', bmff('avc1'), 'video/mp4'],
        ['clip4.m4v', bmff('M4V '), 'video/mp4'],
        ['clip.mov', bmff('qt  '), 'video/quicktime'],
        ['shot.png', PNG_1X1, 'image/png'],
      ];
      for (const [name, bytes, type] of cases) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        const res = await fetch(fileUrl('s1', file), { headers: h });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(type);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('content-length')).toBe(String(bytes.length));
        // Streamed, but byte-identical — and never a Range advertisement the
        // route cannot honour.
        expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
        expect(res.headers.get('accept-ranges')).toBe(null);
      }
    });

    it('415 unsupported-type for a text file, whatever it is named', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'notes.mp4');
      fs.writeFileSync(file, 'plain text wearing an .mp4 suffix');
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(415);
      // A DIFFERENT tag from the image route's `not-an-image`, so the phone's
      // two error maps never collapse into one.
      expect((await res.json()).error).toBe('unsupported-type');
    });

    it('415, not 413, for an unsupported file over every cap', async () => {
      // The cap depends on the type, so the sniff runs first. Saying
      // "too large" about a file that would be refused at any size is a lie,
      // and the phone renders the two differently (no retry vs. a limit).
      const dir = tmpTree();
      const file = sparse(dir, 'huge.txt', Buffer.from('not a media file'), 200 * 1024 * 1024);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe('unsupported-type');
    });

    it('413 file-too-large over the 128 MiB video cap, without leaking the size', async () => {
      const dir = tmpTree();
      const file = sparse(dir, 'big.mp4', bmff('isom'), 128 * 1024 * 1024 + 1);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toBe('file-too-large');
      // The cap is the only number a caller learns.
      expect(body.detail).toBe(`the cap is ${128 * 1024 * 1024} bytes`);
      expect(body.detail).not.toContain(String(128 * 1024 * 1024 + 1));
    });

    it('413 for an image over the 8 MiB image cap - the caps stay per kind', async () => {
      const dir = tmpTree();
      const file = sparse(dir, 'big.png', PNG_1X1, 8 * 1024 * 1024 + 1);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(413);
      expect((await res.json()).detail).toBe(`the cap is ${8 * 1024 * 1024} bytes`);
    });

    it('streams a 100 MB video instead of reading it whole', async () => {
      const dir = tmpTree();
      const file = sparse(dir, 'long.mp4', bmff('isom'), 100 * 1024 * 1024);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      // RSS alone cannot answer this question: server and client share one
      // process, so the client's own chunks and whatever the GC has not got to
      // yet are counted too, and a buffered handler's 100 MB would be freed
      // before a post-hoc reading anyway. So the handle itself is watched. A
      // route that buffers asks it for `stat.size` bytes in one call; this one
      // never asks for more than a stream chunk, whatever the file weighs.
      const reads: number[] = [];
      let streams = 0;
      const openSpy = interceptOpen(file, async (handle) => {
        const realRead = handle.read.bind(handle);
        const realStream = handle.createReadStream.bind(handle);
        handle.read = ((...a: unknown[]) => {
          reads.push(typeof a[2] === 'number' ? a[2] : 0);
          return (realRead as (...x: unknown[]) => unknown)(...a);
        }) as typeof handle.read;
        handle.createReadStream = ((...a: Parameters<typeof handle.createReadStream>) => {
          streams += 1;
          return realStream(...a);
        }) as typeof handle.createReadStream;
        return handle;
      });
      try {
        const before = process.memoryUsage().rss;
        const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(100 * 1024 * 1024));
        // Counted, never accumulated: `arrayBuffer()` here would add 100 MB
        // from the CLIENT side of the same process.
        let seen = 0;
        let peak = before;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          seen += chunk.length;
          const rss = process.memoryUsage().rss;
          if (rss > peak) peak = rss;
        }
        expect(seen).toBe(100 * 1024 * 1024);
        // Named with the evidence: a bare `toBe(1)` here reports "0 is not 1"
        // and leaves the next reader guessing whether the route stopped
        // streaming or the interception never landed.
        expect({ streams, openedPaths }).toMatchObject({ streams: 1 });
        // The largest single read is one stream chunk (64 KiB), not the 100 MB
        // a `Buffer.allocUnsafe(stat.size)` route would have asked for. The
        // count is left alone deliberately — it tracks the highWaterMark, and
        // pinning it would break on a Node that changes the default.
        expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
        expect(reads.length).toBeGreaterThan(100);
        // Secondary, and loose on purpose: this number includes the client's
        // uncollected chunks, so it is here to catch an order-of-magnitude
        // regression, not to measure the handler.
        expect(peak - before).toBeLessThan(100 * 1024 * 1024);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('cuts the response when the file shrank under the promised length', async () => {
      // Content-Length is the size the gate approved. Fewer bytes than that
      // leaves URLSession waiting for a remainder that is never coming, so the
      // honest end - the header is already gone - is to cut the socket.
      const dir = tmpTree();
      const file = path.join(dir, 'shrink.mp4');
      fs.writeFileSync(file, bmff('isom'));
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const openSpy = interceptOpen(file, async (handle) => {
        const realStat = handle.stat.bind(handle);
        // One byte MORE than there is: the same disagreement a file being
        // truncated mid-flight produces.
        handle.stat = (async () => {
          const st = await realStat();
          return Object.assign(st, { size: st.size + 1 });
        }) as typeof handle.stat;
        return handle;
      });
      try {
        await expect(
          fetch(fileUrl('s1', file), { headers: bearer(info.token as string) })
            .then((r) => r.arrayBuffer()),
        ).rejects.toThrow();
      } finally {
        openSpy.mockRestore();
      }
      // And the server is still serving: the cut released its handle.
      const ok = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(ok.status).toBe(200);
    });

    it('finishes cleanly, with the approved prefix, when the file grows', async () => {
      // The contract sketched a cut here. It cannot work: the stream is bounded
      // by `end: stat.size - 1`, so the client already holds every byte the
      // Content-Length announced and reads the message as complete. Destroying
      // the socket at that point does not reach it as a failure — it lands on
      // whatever is still in the userland buffer, so the SAME correct response
      // arrives whole or truncated depending on timing. What this pins is the
      // decision that replaced it: the approved prefix is delivered, intact,
      // every time.
      const dir = tmpTree();
      const file = path.join(dir, 'grow.mp4');
      const bytes = bmff('isom');
      fs.writeFileSync(file, bytes);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      // The handler is told the file is one byte shorter than it is — the same
      // disagreement a file being appended to mid-flight produces.
      const openSpy = interceptOpen(file, async (handle) => {
        const realStat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const st = await realStat();
          return Object.assign(st, { size: st.size - 1 });
        }) as typeof handle.stat;
        return handle;
      });
      try {
        const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(bytes.length - 1));
        const got = Buffer.from(await res.arrayBuffer());
        // Exactly the approved prefix: not one byte of the growth, and not one
        // byte short of what the header promised.
        expect(got.length).toBe(bytes.length - 1);
        expect(got.equals(bytes.subarray(0, bytes.length - 1))).toBe(true);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('survives a client that walks away mid-download', async () => {
      // `pipe` unpipes on a closed response but never destroys its source, so
      // this is the path that would leak the FileHandle for the life of the
      // daemon. What it must NOT do is leave the process with a pending wait.
      const dir = tmpTree();
      const file = sparse(dir, 'walked.mp4', bmff('isom'), 32 * 1024 * 1024);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      let closed = false;
      const openSpy = interceptOpen(file, async (handle) => {
        const realClose = handle.close.bind(handle);
        handle.close = (async () => { closed = true; return realClose(); }) as typeof handle.close;
        return handle;
      });
      try {
        const ac = new AbortController();
        const res = await fetch(fileUrl('s1', file), {
          headers: bearer(info.token as string),
          signal: ac.signal,
        });
        expect(res.status).toBe(200);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        ac.abort();
        await reader.cancel().catch(() => { /* already aborted */ });
        // THE assertion. A server leaking the descriptor still answers the next
        // request happily, so "it answered again" proves nothing on its own.
        await vi.waitFor(() => expect(closed).toBe(true));
      } finally {
        openSpy.mockRestore();
      }
      const after = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(after.status).toBe(200);
      await after.body?.cancel();
    });

    it('releases the handle when the client leaves before the first byte', async () => {
      // The window the abort test above cannot reach: every step of the gate is
      // an await, so 'close' can fire BEFORE the handler subscribes to it. A
      // listener registered after the event never runs, and writing to a
      // destroyed response returns false rather than throwing — so a handler
      // that only subscribed would park in `pipe` for ever holding this handle.
      const dir = tmpTree();
      const file = sparse(dir, 'early.mp4', bmff('isom'), 8 * 1024 * 1024);
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      let entered!: () => void;
      const inTheGate = new Promise<void>((r) => { entered = r; });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let closed = false;
      const openSpy = interceptOpen(file, async (handle) => {
        const realClose = handle.close.bind(handle);
        handle.close = (async () => { closed = true; return realClose(); }) as typeof handle.close;
        entered();
        await held;
        return handle;
      });
      try {
        const ac = new AbortController();
        const pending = fetch(fileUrl('s1', file), {
          headers: bearer(info.token as string),
          signal: ac.signal,
        });
        const settled = pending.catch(() => 'aborted' as const);
        await inTheGate;
        ac.abort();
        // Let the abort reach the server before the gate finishes.
        await new Promise((r) => setImmediate(r));
        release();
        expect(await settled).toBe('aborted');
        // The handler has to finish on its own — a leak would leave this
        // pending for the life of the daemon.
        await vi.waitFor(() => expect(closed).toBe(true));
      } finally {
        openSpy.mockRestore();
      }
      const ok = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(ok.status).toBe(200);
      await ok.body?.cancel();
    });

    it('404s outside the boundary, through a symlink, and on a FIFO', async () => {
      const root = tmpTree();
      const cwd = path.join(root, 'cwd');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(cwd);
      fs.mkdirSync(outside);
      const secret = path.join(outside, 'secret.mp4');
      fs.writeFileSync(secret, bmff('isom'));
      const link = path.join(cwd, 'looks-local.mp4');
      fs.symlinkSync(secret, link);
      const fifo = path.join(cwd, 'pipe.mp4');
      execFileSync('mkfifo', [fifo]);
      const sibling = path.join(root, 'cwd-next-door');
      fs.mkdirSync(sibling);
      const prefixed = path.join(sibling, 'a.mp4');
      fs.writeFileSync(prefixed, bmff('isom'));
      const sub = path.join(cwd, 'clips');
      fs.mkdirSync(sub);
      managed.meta.spawnCwd = cwd;
      // OSC 7 moves `meta.cwd`, so it is never a boundary.
      managed.meta.cwd = outside;
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      // The escape hatch, the hang, the string-prefix sibling, the directory,
      // the wandered cwd, and a path that is simply not there - one answer for
      // all of them, or the difference maps the disk.
      for (const p of [secret, link, fifo, prefixed, sub, path.join(cwd, 'nope.mp4')]) {
        const res = await fetch(fileUrl('s1', p), { headers: h });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('file not found');
      }
    });

    it('400 bad-file-ref for a missing, empty, relative or NUL-bearing path', async () => {
      managed.meta.spawnCwd = tmpTree();
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      const refs = ['', '   ', 'relative/a.mp4', './a.mp4', `/x/a${String.fromCharCode(0)}.mp4`];
      for (const ref of refs) {
        const res = await fetch(fileUrl('s1', ref), { headers: h });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('bad-file-ref');
      }
      const bare = await fetch(`${base()}/api/sessions/s1/turns/file`, { headers: h });
      expect(bare.status).toBe(400);
      expect((await bare.json()).error).toBe('bad-file-ref');
    });

    it('404 for an unknown pane, and for the orchestrator brain', async () => {
      const dir = tmpTree();
      const file = path.join(dir, 'a.mp4');
      fs.writeFileSync(file, bmff('isom'));
      live.push({
        id: 'brain-ws-1', cwd: dir, cols: 80, rows: 24, state: 'detached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: {}, cmd: '/usr/bin/claude',
      });
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      for (const id of ['no-such-pane', 'brain-ws-1']) {
        const res = await fetch(fileUrl(id, file), { headers: h });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('session not found');
      }
    });

    it('serves a video out of the uploads directory, session-independently', async () => {
      managed.meta.spawnCwd = tmpTree();
      const clip = path.join(uploadsDir, 'clip.mp4');
      fs.writeFileSync(clip, bmff('isom'));
      try {
        const info = await startWithTranscript();
        const res = await fetch(fileUrl('s1', clip), { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
      } finally {
        // uploadsDir is shared across describes; the tree cleanup misses it.
        fs.rmSync(clip, { force: true });
      }
    });

    it('serves fragmented mp4, whose major brand is not isom', async () => {
      // `ffmpeg -movflags frag_keyframe+empty_moov` writes `iso5`. An agent
      // rendering a clip for streaming is the use this route exists for, and a
      // 415 there is permanent as far as a client is concerned.
      const dir = tmpTree();
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      for (const brand of ['iso4', 'iso5', 'iso6', 'dash']) {
        const file = path.join(dir, `frag-${brand.trim()}.mp4`);
        fs.writeFileSync(file, bmff(brand));
        const res = await fetch(fileUrl('s1', file), { headers: h });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        await res.body?.cancel();
      }
    });

    it('415s a text file that merely contains the ftyp marker', async () => {
      // The marker is twelve bytes of ASCII a document can hold. What it cannot
      // also hold in front of it is a plausible box length: a `ftyp` box is
      // 16 bytes or more and a multiple of four, and `<!--` read as a
      // big-endian length is neither.
      const dir = tmpTree();
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const h = bearer(info.token as string);
      const decoys = [
        Buffer.from('<!--ftypisom this is a comment, not a movie -->'),
        // Length zero: legal in MP4 only for the LAST box, never for `ftyp`.
        Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]),
        // 18: not a multiple of four, so not a box that holds whole brands.
        (() => {
          const b = Buffer.alloc(24);
          b.writeUInt32BE(18, 0);
          b.write('ftypisom', 4, 'latin1');
          return b;
        })(),
      ];
      for (const [i, bytes] of decoys.entries()) {
        const file = path.join(dir, `decoy-${i}.mp4`);
        fs.writeFileSync(file, bytes);
        const res = await fetch(fileUrl('s1', file), { headers: h });
        expect(res.status).toBe(415);
        expect((await res.json()).error).toBe('unsupported-type');
      }
    });

    it('carries the security headers onto the 200', async () => {
      // Nothing else in this describe would notice if the spread of
      // `securityHeaders()` were dropped from the streamed response, and this
      // route hands a browser bytes it sniffed itself.
      const dir = tmpTree();
      const file = path.join(dir, 'clip.mp4');
      fs.writeFileSync(file, bmff('isom'));
      managed.meta.spawnCwd = dir;
      const info = await startWithTranscript();
      const res = await fetch(fileUrl('s1', file), { headers: bearer(info.token as string) });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      await res.body?.cancel();
    });

    it('404s when the last component became a symlink after the boundary check', async () => {
      // O_NOFOLLOW is the whole answer to the window between `realpath` and
      // `open`, and every other symlink case in this file is caught one step
      // earlier - by realpath - so nothing reaches the flag. Handing the
      // handler a path realpath did NOT resolve is what puts the swap in front
      // of `open`, where ELOOP is the refusal.
      const root = tmpTree();
      const cwd = path.join(root, 'cwd');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(cwd);
      fs.mkdirSync(outside);
      const secret = path.join(outside, 'secret.mp4');
      fs.writeFileSync(secret, bmff('isom'));
      const swapped = path.join(cwd, 'swapped.mp4');
      fs.symlinkSync(secret, swapped);
      managed.meta.spawnCwd = cwd;
      const realRealpath = fs.promises.realpath;
      const rpSpy = vi.spyOn(fs.promises, 'realpath');
      rpSpy.mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
        // The link resolves to itself: containment passes, and the file `open`
        // then meets is the symlink the check never saw through.
        if (String(p) === swapped) return swapped;
        return (realRealpath as (...a: unknown[]) => Promise<string>)(p, ...rest);
      }) as never);
      try {
        const info = await startWithTranscript();
        const res = await fetch(fileUrl('s1', swapped), { headers: bearer(info.token as string) });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('file not found');
      } finally {
        rpSpy.mockRestore();
      }
    });

    it('serves a file under an uploads directory nested inside the pane cwd', async () => {
      // The two roots are independent, and one containing the other must not
      // turn into a rejection on whichever is checked second.
      const cwd = tmpTree();
      const nested = path.join(cwd, 'uploads');
      fs.mkdirSync(nested);
      const clip = path.join(nested, 'from-phone.mp4');
      fs.writeFileSync(clip, bmff('isom'));
      managed.meta.spawnCwd = cwd;
      const nestedServer = new WebTerminalServer({
        sessionManager,
        projector: () => projectorMock as unknown as TranscriptProjector,
        log: () => { /* silent in tests */ },
        assetsDir: os.tmpdir(),
        uploadsDir: nested,
      });
      const info = await nestedServer.start({
        port: 0, host: '127.0.0.1', allowInput: false, allowUpload: true, allowTranscript: true,
      });
      try {
        const url = `http://127.0.0.1:${info.port}/api/sessions/s1/turns/file?path=${encodeURIComponent(clip)}`;
        const res = await fetch(url, { headers: bearer(info.token as string) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        await res.body?.cancel();
      } finally {
        await nestedServer.stop();
      }
    });

    it('/api/config advertises turnFiles only alongside the transcript grant', async () => {
      const off = await startRO();
      const offBody = await (
        await fetch(`${base()}/api/config`, { headers: bearer(off.token as string) })
      ).json();
      // ABSENT, not false - the shape a daemon predating the route serves.
      expect(offBody).not.toHaveProperty('turnFiles');

      await server.stop();
      const on = await startWithTranscript();
      const onBody = await (
        await fetch(`${base()}/api/config`, { headers: bearer(on.token as string) })
      ).json();
      expect(onBody).toHaveProperty('turnFiles', true);
      // The older key keeps its meaning; this one is additive.
      expect(onBody).toHaveProperty('turnImages', true);
    });
  });

  describe('GET /api/workspaces', () => {
    it('groups live sessions by WMUX_WORKSPACE_ID and surfaces id+name+panes', async () => {
      // Fixture already covers the matrix: s1 → ws-1 named "Workspace 1", s2 →
      // ws-legacy (no name), s3 → no workspace id at all (unaddressable, so
      // it must contribute no row and no phantom workspace).
      const info = await startRO();
      const res = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workspaces: Array<{ id: string; name: string; panes: Array<{ sessionId: string; shell?: string; cwd?: string }> }>;
      };
      // Named workspace sorts before the unnamed one.
      expect(body.workspaces.map((w) => w.id)).toEqual(['ws-1', 'ws-legacy']);
      expect(body.workspaces[0].name).toBe('Workspace 1');
      expect(body.workspaces[0].panes).toEqual([{ sessionId: 's1', shell: 'pwsh', cwd: '/x' }]);
      expect(body.workspaces[1].name).toBe('');
      expect(body.workspaces[1].panes).toEqual([{ sessionId: 's2', shell: 'pwsh', cwd: '/y' }]);
      // The env-less session (s3) is omitted entirely.
      expect(body.workspaces.flatMap((w) => w.panes).map((p) => p.sessionId)).not.toContain('s3');
    });

    // #1163 — per-session agent metadata, so the attaching desktop's roster
    // can count remote Claude sessions. Additive-optional: panes the host
    // knows nothing about carry no agent fields at all.
    it('surfaces per-pane agent name and status, omitting them when unknown', async () => {
      live.push(
        {
          id: 's-agent', cwd: '/a', cols: 80, rows: 24, state: 'detached',
          agent: undefined,
          // X6 persisted what USED to run here; the daemon's canonical answer
          // (below) says nothing runs now. The persisted slug must not
          // resurrect a ghost roster row.
          lastDetectedAgent: 'claude',
          lastActivity: '2020-01-01T00:00:00.000Z',
          env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1' },
          cmd: '/usr/bin/bash',
        },
        {
          id: 's-role', cwd: '/b', cols: 80, rows: 24, state: 'detached',
          // Creation-time role metadata outranks the persisted slug.
          agent: { role: 'worker', teamId: 't1', displayName: 'Codex' },
          lastDetectedAgent: 'claude',
          lastActivity: '2020-01-01T00:00:00.000Z',
          env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1' },
          cmd: '/usr/bin/bash',
        },
      );
      // The daemon's canonical reader: s1 runs a live, blocked agent; s-agent's
      // agent has exited (canonical null); s-role's canonical answer is
      // outranked by its creation-time role metadata.
      agentStates = {
        s1: { agentName: 'Claude Code', agentStatus: 'awaiting_input' },
        's-agent': { agentName: null, agentStatus: 'idle' },
        's-role': { agentName: 'Claude Code', agentStatus: 'running' },
      };
      const info = await startRO();
      const read = async () => {
        const r = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
        expect(r.status).toBe(200);
        return (await r.json()) as {
          workspaces: Array<{ panes: Array<{ sessionId: string; agentName?: string; agentStatus?: string }> }>;
        };
      };
      let body = await read();
      let byId = new Map(body.workspaces.flatMap((w) => w.panes).map((p) => [p.sessionId, p]));
      expect(byId.get('s1')).toMatchObject({ agentName: 'Claude Code', agentStatus: 'awaiting_input' });
      // Role metadata outranks the canonical detector name.
      expect(byId.get('s-role')).toMatchObject({ agentName: 'Codex', agentStatus: 'running' });
      // Exited agent: the persisted slug does NOT resurrect a row.
      expect(byId.get('s-agent')).not.toHaveProperty('agentName');
      expect(byId.get('s-agent')).not.toHaveProperty('agentStatus');
      // No canonical state for the session → no agent fields at all.
      expect(byId.get('s2')).not.toHaveProperty('agentName');

      // The agent in s1 exits → its row disappears on the next poll.
      agentStates.s1 = { agentName: null, agentStatus: 'idle' };
      body = await read();
      byId = new Map(body.workspaces.flatMap((w) => w.panes).map((p) => [p.sessionId, p]));
      expect(byId.get('s1')).not.toHaveProperty('agentName');
    });

    // #1342 — the resume block for a remote resume chip. Additive-optional, and
    // the host-local transcript path is structurally absent from the wire.
    it('surfaces the resume block with a cwd verdict and never the transcript path', async () => {
      resumeStates = {
        s1: {
          binding: {
            agent: 'claude',
            sessionId: 'conv-1',
            // Matches the fixture's cwd for s1 ('/x') → an EXACT resume is safe.
            cwd: '/x',
            permissionMode: 'bypassPermissions',
            transcriptPath: '/home/host/.claude/projects/x/conv-1.jsonl',
            ts: 1,
          },
          commandRunning: false,
          agentProcessAlive: false,
        },
        s2: {
          binding: {
            // Recorded elsewhere than the pane's live cwd ('/y') → fallback only.
            agent: 'claude', sessionId: 'conv-2', cwd: '/elsewhere', ts: 1,
          },
        },
      };
      const info = await startRO();
      const r = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
      expect(r.status).toBe(200);
      const raw = await r.text();
      const body = JSON.parse(raw) as {
        workspaces: Array<{ panes: Array<{ sessionId: string; resume?: Record<string, unknown>; commandRunning?: boolean; agentProcessAlive?: boolean }> }>;
      };
      const byId = new Map(body.workspaces.flatMap((w) => w.panes).map((p) => [p.sessionId, p]));
      expect(byId.get('s1')?.resume).toEqual({
        agent: 'claude',
        sessionId: 'conv-1',
        cwdMatches: true,
        permissionMode: 'bypassPermissions',
      });
      expect(byId.get('s1')).toMatchObject({ commandRunning: false, agentProcessAlive: false });
      // Recorded cwd no longer matches → the host says so; no mode was captured.
      expect(byId.get('s2')?.resume).toEqual({ agent: 'claude', sessionId: 'conv-2', cwdMatches: false });
      // A session the daemon reports nothing for carries no resume fields at all.
      expect(byId.get('s2')).not.toHaveProperty('commandRunning');
      // The host-local transcript path never crosses the API, under any key.
      expect(raw).not.toContain('.jsonl');
      expect(raw).not.toContain('transcriptPath');
    });

    it('groups multiple panes into the same workspace, sorted by sessionId', async () => {
      live.push({
        id: 's4', cwd: '/x2', cols: 80, rows: 24, state: 'detached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1' },
        cmd: '/usr/bin/bash',
      });
      try {
        const info = await startRO();
        const res = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
        const body = (await res.json()) as { workspaces: Array<{ id: string; panes: Array<{ sessionId: string }> }> };
        const ws1 = body.workspaces.find((w) => w.id === 'ws-1');
        expect(ws1?.panes.map((p) => p.sessionId)).toEqual(['s1', 's4']);
      } finally {
        live.length = 3;
      }
    });

    // m6 — the sort used to push unnamed workspaces last via a '￿' (U+FFFF)
    // sentinel compared through localeCompare, which relies on ICU
    // collation treating that noncharacter as sorting after every real
    // name — not guaranteed across locales/ICU builds. An explicit boolean
    // tiebreak (unnamed vs named) makes the ordering locale-independent.
    // This also covers the multi-unnamed tie: they fall back to id order.
    it('sorts multiple unnamed workspaces last, ordered by id', async () => {
      live.push(
        {
          id: 's5', cwd: '/z', cols: 80, rows: 24, state: 'detached',
          agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
          env: { WMUX_WORKSPACE_ID: 'ws-zzz' },
          cmd: '/usr/bin/bash',
        },
        {
          id: 's6', cwd: '/a', cols: 80, rows: 24, state: 'detached',
          agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
          env: { WMUX_WORKSPACE_ID: 'ws-aaa' },
          cmd: '/usr/bin/bash',
        },
      );
      try {
        const info = await startRO();
        const res = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
        const body = (await res.json()) as { workspaces: Array<{ id: string; name: string }> };
        // Named ('ws-1') first; the two unnamed ones ('ws-aaa','ws-legacy',
        // 'ws-zzz') last, ordered by id, never mixed in with named entries.
        expect(body.workspaces.map((w) => w.id)).toEqual(['ws-1', 'ws-aaa', 'ws-legacy', 'ws-zzz']);
        expect(body.workspaces.slice(1).every((w) => w.name === '')).toBe(true);
      } finally {
        live.length = 3;
      }
    });

    it('rejects an unauthenticated request exactly like /api/sessions', async () => {
      await startRO();
      const res = await fetch(`${base()}/api/workspaces`);
      expect(res.status).toBe(401);
    });

    it('hides brain ptys — not listed, and no phantom workspace from their env', async () => {
      live.push({
        id: 'brain-abc', cwd: '/b', cols: 80, rows: 24, state: 'attached',
        agent: undefined, lastDetectedAgent: undefined, lastActivity: '2020-01-01T00:00:00.000Z',
        env: { WMUX_BRAIN_PTY: '1', WMUX_WORKSPACE_ID: 'ws-brain', WMUX_WORKSPACE_NAME: 'Brain' },
        cmd: '/usr/local/bin/claude',
      });
      try {
        const info = await startRO();
        const res = await fetch(`${base()}/api/workspaces`, { headers: bearer(info.token as string) });
        const body = (await res.json()) as { workspaces: Array<{ id: string }> };
        expect(body.workspaces.map((w) => w.id)).not.toContain('ws-brain');
      } finally {
        live.length = 3;
      }
    });
  });

  // ── mode-safe snapshot window + resize propagation ────────────────────────
  //
  // `/api/stream` paints the LAST 256 KB of the ring. A fullscreen TUI switched
  // to the alternate screen once, long before that window, so the window's
  // absolute-positioned frames used to land on the client's normal buffer and
  // interleave with scrollback. The daemon reconstructs the mode state instead
  // (OutputModeTracker) and prepends a preamble to the snapshot payload.
  describe('stream snapshot mode preamble', () => {
    /** Read the SSE body until `until` holds (or 2s), then return the text. */
    const readStream = async (
      url: string,
      ac: AbortController,
      until: (text: string) => boolean,
    ): Promise<string> => {
      const res = await fetch(url, { signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let text = '';
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) text += Buffer.from(value).toString('utf8');
      }
      return text;
    };

    /** Every `snapshot` event payload, decoded from base64. */
    const snapshots = (text: string): string[] =>
      [...text.matchAll(/event: snapshot\ndata: ([^\n]*)\n/g)].map((m) =>
        Buffer.from(m[1], 'base64').toString('utf8'),
      );

    /** Every `meta` event payload, parsed. */
    const metas = (text: string): Array<Record<string, unknown>> =>
      [...text.matchAll(/event: meta\ndata: ([^\n]*)\n/g)].map(
        (m) => JSON.parse(m[1]) as Record<string, unknown>,
      );

    /** 400 KB of output — comfortably more than the 256 KB snapshot window. */
    const FILLER = 'x'.repeat(400 * 1024) + '\n';

    /**
     * Stage the fake session's ring on `text` and feed the SAME bytes, with the
     * same offsets, to a real tracker hung off the fake bridge — which is what
     * DaemonPTYBridge does at ring-write time.
     */
    const stageRing = (text: string): void => {
      managed.ringBuffer.readAll = () => Buffer.from(text, 'utf8');
      const tracker = new OutputModeTracker();
      tracker.feed(text, Buffer.byteLength(text, 'utf8'));
      Object.assign(bridge, { outputModes: tracker });
    };

    /** `head` far enough back that it has scrolled out of the window. */
    const primeRing = (head: string): void => stageRing(head + FILLER);

    /** Exactly what the client SHOULD receive when nothing is prepended. */
    const bareWindow = (): string =>
      capSnapshot(managed.ringBuffer.readAll()).bytes.toString('utf8');

    /** Open the stream and return the first snapshot payload. */
    const firstSnapshot = async (): Promise<string> => {
      const info = await startRO();
      const ac = new AbortController();
      const text = await readStream(
        `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
        ac,
        (t) => snapshots(t).length >= 1,
      );
      ac.abort();
      const [first] = snapshots(text);
      expect(first).toBeDefined();
      return first;
    };

    it('★ prepends an alt-screen preamble when ?1049h scrolled out of the window', async () => {
      // The exact field shape: the app entered the alternate screen at startup
      // and has been painting ever since, so the switch is 400 KB back.
      primeRing('\x1b[?1049h\x1b[2J\x1b[H');
      const first = await firstSnapshot();
      // The window itself no longer contains the switch…
      expect(bareWindow()).not.toContain('\x1b[?1049h');
      // …so the payload has to open with it, plus an erase + home so the
      // absolute-positioned frames that follow start from a blank grid.
      expect(first).toBe('\x1b[?1049h\x1b[2J\x1b[H' + bareWindow());
    });

    it('★ sends NO alt preamble when the window still contains the entry', async () => {
      // The common case: an app launched a moment ago, so its own `?1049h` is
      // inside the window. Asserting the switch first would paint the shell
      // scrollback ahead of it into the ALTERNATE buffer; the window's own
      // switch then no-ops, and the app's eventual `?1049l` would drop the user
      // on an empty normal buffer with the scrollback gone.
      stageRing(FILLER + 'line1\r\nline2\r\n\x1b[?1049h\x1b[2J\x1b[HVIM FRAME');
      const first = await firstSnapshot();
      expect(bareWindow()).toContain('\x1b[?1049h');
      expect(first).toBe(bareWindow());
    });

    it('sends no preamble at all for a plain normal-buffer session', async () => {
      // Deliberately full of escape sequences — colours, and an alt screen the
      // app entered AND left — so "the payload happens not to start with ESC"
      // cannot pass for a real assertion. The only acceptable answer is the
      // window, byte for byte.
      primeRing('\x1b[32m$ vim\x1b[0m\n\x1b[?1049h\x1b[2Jediting\x1b[?1049l\x1b[?1002l\n');
      const first = await firstSnapshot();
      expect(first).toBe(bareWindow());
    });

    it('carries non-default modes other than alt screen (bracketed paste, mouse SGR)', async () => {
      primeRing('\x1b[?2004h\x1b[?1002;1006h');
      const first = await firstSnapshot();
      expect(first).toContain('\x1b[?1002h');
      expect(first).toContain('\x1b[?1006h');
      expect(first).toContain('\x1b[?2004h');
      // No alt-screen switch was sent, so none is asserted.
      expect(first).not.toContain('\x1b[?1049h');
    });

    it('ends just this stream when the initial frame cannot be built', async () => {
      // `readAll()` copies the whole ring — up to 64 MB — and `Buffer.concat`
      // allocates again on top. The headers are already out by then, so there
      // is no error status left to send; what matters is that the throw does
      // NOT escape the request handler, because an uncaught exception in a
      // daemon request handler ends the daemon, not the request.
      managed.ringBuffer.readAll = () => { throw new Error('Array buffer allocation failed'); };
      const info = await startRO();
      const ac = new AbortController();
      const res = await fetch(
        `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      // The stream closes rather than hanging, and carries no frames.
      const body = await res.text();
      expect(snapshots(body)).toHaveLength(0);

      // The daemon is still serving — the failure was scoped to one client.
      managed.ringBuffer.readAll = () => Buffer.from('recovered');
      const after = await fetch(`${base()}/api/sessions`, {
        headers: { Authorization: `Bearer ${info.token as string}` },
      });
      expect(after.status).toBe(200);
    });

    // ── resize propagation ──────────────────────────────────────────────
    //
    // An applied resize invalidates the viewer's grid, so it has to hear about
    // it. What it must NOT get is a fresh snapshot: that is a full ring copy
    // and ~341 KB of base64 per viewer per resize, and every client resets its
    // terminal before replaying one — so a viewer scrolled up reading would be
    // wiped and dragged to the bottom each time someone resized the pane on
    // the machine that owns it.
    describe('applied resize', () => {
      /** Open a stream and keep pumping its body into a growing string. */
      const openPumped = async (): Promise<{
        ac: AbortController;
        body: () => string;
        pump: (budgetMs: number) => Promise<void>;
      }> => {
        const info = await startRO();
        const ac = new AbortController();
        const res = await fetch(
          `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
          { signal: ac.signal },
        );
        expect(res.status).toBe(200);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        let text = '';
        // `reader.read()` on an idle SSE stream never settles, so every read is
        // raced against the remaining budget. The losing read is CARRIED to the
        // next pump rather than dropped — an orphaned read still consumes the
        // next chunk, which is how a resize frame goes missing without anyone
        // noticing the test never saw it.
        let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
        const pump = async (budgetMs: number): Promise<void> => {
          const deadline = Date.now() + budgetMs;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            if (!pending) pending = reader.read();
            const settled = await Promise.race([
              pending.then((v) => ({ v })),
              new Promise<null>((r) => setTimeout(() => r(null), remaining)),
            ]);
            if (!settled) return; // budget spent; `pending` survives for next time
            pending = null;
            if (settled.v.done) return;
            if (settled.v.value) text += Buffer.from(settled.v.value).toString('utf8');
          }
        };
        await pump(500);
        return { ac, body: () => text, pump };
      };

      it('★ answers with meta ONLY — never a second snapshot', async () => {
        primeRing('\x1b[?1049h');
        const s = await openPumped();
        expect(snapshots(s.body())).toHaveLength(1);

        managed.meta.cols = 100;
        managed.meta.rows = 40;
        bridge.emit('resize');
        await s.pump(1200);
        s.ac.abort();

        // The new geometry arrived…
        const metaEvents = metas(s.body());
        expect(metaEvents).toHaveLength(2);
        expect(metaEvents[1]).toMatchObject({ cols: 100, rows: 40, resize: true });
        // …and the viewer's scrollback was not re-sent under it.
        expect(snapshots(s.body())).toHaveLength(1);
      }, 15000);

      it('★ collapses a storm into one, and still answers the next one', async () => {
        // The debounce has to outlast MIN_RESIZE_INTERVAL_MS (250) or every
        // resize the rate limiter lets through is already spaced far enough
        // apart to defeat it — which is exactly what a 150 ms window did.
        primeRing('hello\n');
        const s = await openPumped();
        expect(metas(s.body())).toHaveLength(1);

        // Two accepted resizes one limiter-interval apart still merge…
        bridge.emit('resize');
        await new Promise((r) => setTimeout(r, 260));
        bridge.emit('resize');
        await s.pump(1200);
        expect(metas(s.body())).toHaveLength(2);

        // …while one that lands after the window has closed is its own message.
        managed.meta.cols = 132;
        bridge.emit('resize');
        await s.pump(1200);
        s.ac.abort();
        const metaEvents = metas(s.body());
        expect(metaEvents).toHaveLength(3);
        expect(metaEvents[2]).toMatchObject({ cols: 132, resize: true });
      }, 20000);

      it('drops the pending resize when the client disconnects', async () => {
        primeRing('hello\n');
        // The debounce callback re-reads the session, so counting that read is
        // a direct signal for "the timer fired" — an assertion that a leftover
        // `clearTimeout` deletion cannot pass, unlike a listener count.
        const mgr = sessionManager as unknown as { getSession: (id: string) => unknown };
        const inner = mgr.getSession.bind(mgr);
        let reads = 0;
        mgr.getSession = (id: string) => { reads += 1; return inner(id); };

        const info = await startRO();
        const ac = new AbortController();
        await readStream(
          `${base()}/api/stream?session=s1&token=${encodeURIComponent(info.token as string)}`,
          ac,
          (t) => snapshots(t).length >= 1,
        );
        bridge.emit('resize');
        ac.abort();
        const atAbort = reads;
        // Long enough for the debounce to have fired twice over.
        await new Promise((r) => setTimeout(r, 1200));

        expect(reads).toBe(atAbort); // nothing woke up behind the closed stream
        expect(bridge.listenerCount('resize')).toBe(0);
      }, 15000);
    });
  });
});
