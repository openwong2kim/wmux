import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import type { PaneMetadata } from '../../../shared/types';
import type { RpcContext } from '../../../shared/rpc';
import { ORCH_ROLE_KEY } from '../../../shared/orchestratorRole';
import { metadataStore, type MergeMode, type MetadataStore } from '../../metadata/MetadataStore';

type GetWindow = () => BrowserWindow | null;

/**
 * D2 SECURITY — `custom['orchestrator.role']` is OPERATOR-ONLY on this wire.
 *
 * The role is no longer just a routing hint the orchestrator may ignore: it
 * selects which enforced agent/model/args binding applies to a pane
 * (shared/orchestratorRole.applyRoleBinding). Leaving it writable by any
 * `pane.setMetadata` caller would hand policy selection to the very agents the
 * policy governs — a prompt-injected worker could rename its own role to an
 * unbound string so the lookup misses and it gets the expensive default model,
 * point the operator's binding at a pane of its choosing, or change a sibling
 * pane's role so that pane launches differently. A sentence in the commander
 * system prompt ("Never set or change a pane's role yourself") is a request to
 * an LLM, not a control.
 *
 * `ctx.firstParty` is the existing trust distinction for exactly this: it is set
 * only by trusted in-process dispatch (the renderer IPC bridge, the plugin host)
 * and is a dispatch() argument, never a request field, so the external wire
 * cannot forge it — see the a2a.channel / events.poll precedents.
 *
 * The operator's own path is UNAFFECTED: the Fleet dropdown writes through the
 * dedicated `metadata:set-role` ipcMain channel (metadata.handler.ts), which
 * never touches this router.
 *
 * STRIP, not throw — deliberately. `pane.setMetadata` is a multi-field write and
 * read-modify-write is the natural client shape (read the metadata, edit one
 * field, send the map back), so a throw would punish an agent for merely echoing
 * a role it never intended to change, taking its legitimate `label`/`status`
 * write down with it. Instead the key is dropped, the rest of the patch applies,
 * and the denial is made OBSERVABLE two ways: the reply carries
 * `rejectedKeys: ['orchestrator.role']` plus a `note`, and main logs a warning.
 * This mirrors the deprecated-`role`-field drop already in this handler.
 */
function guardRoleKey(
  patch: Partial<PaneMetadata>,
  mode: MergeMode,
  currentCustom: Record<string, string> | undefined,
): { patch: Partial<PaneMetadata>; rejected: boolean } {
  const wroteRole = patch.custom !== undefined && ORCH_ROLE_KEY in patch.custom;
  const currentRole = currentCustom?.[ORCH_ROLE_KEY];

  // 'replaceShared' preserves base.custom wholesale and ignores patch.custom
  // entirely (MetadataStore.merge), so the role is already untouchable there.
  if (mode === 'replaceShared') return { patch, rejected: false };

  // A 'replace' DELETES every custom key the patch omits, so stripping alone is
  // not enough — dropping the role is itself the attack (an unbound role fails
  // the lookup open). Carry the operator's existing value forward.
  const mustPreserve = mode === 'replace' && currentRole !== undefined;
  if (!wroteRole && !mustPreserve) return { patch, rejected: false };

  const custom: Record<string, string> = { ...(patch.custom ?? {}) };
  delete custom[ORCH_ROLE_KEY];
  if (mustPreserve) custom[ORCH_ROLE_KEY] = currentRole as string;

  const next: Partial<PaneMetadata> = { ...patch };
  if (Object.keys(custom).length > 0 || patch.custom !== undefined) {
    next.custom = custom;
  }
  // Only an explicit write attempt is reported; a preserved-through-replace role
  // is invisible policy, not a denied request.
  return { patch: next, rejected: wroteRole };
}

// === Validation single source of truth ===
//
// Field-level metadata validation (label/role/status string + length caps,
// custom-map key/value contract, total byte cap) lives in MetadataStore.set.
// The handler only normalizes wire-shape — paneId/workspaceId resolution,
// mergeMode + expectedVersion type checks — and forwards a raw patch.
// Two parallel validators (one here, one in the store) was alphabeen's
// drift-risk concern on PR #34: with shared constants, near-identical
// switch arms, and zero compile-time link between them, the two paths
// would silently fork as caps or rules evolve. The store throws on every
// rejection; the handler wraps with its RPC-method prefix and surfaces
// the message verbatim. See docs/PROTOCOL.md §1.2.

/**
 * Options for registerPaneRpc — exposed so tests can inject a fresh
 * MetadataStore instance instead of the module-level singleton.
 */
export interface PaneRpcOptions {
  store?: MetadataStore;
}

export function registerPaneRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  opts: PaneRpcOptions = {},
  // X8 — optional daemon-client accessor (same pattern as registerInputRpc).
  // When daemon mode is active, pane.list joins each pane's supervision state
  // from a single daemon.listSessions RPC. Omitted/null ⇒ no supervision field
  // (local mode), which is graceful — the CLI/text table is unaffected.
  getDaemonClient?: () => DaemonClient | null,
): void {
  const store = opts.store ?? metadataStore;
  /**
   * pane.list — returns all panes (leaf nodes) of the current workspace,
   * wrapped in a snapshot envelope. `asOfSeq` is the EventBus seq at the
   * moment of the MetadataStore snapshot — clients reconciling after a
   * `resync` should drain events with `seq > asOfSeq`. `bootId` invalidates
   * cached state across daemon restarts (mismatch ⇒ drop ALL caches,
   * including pane ids).
   *
   * M0-c: each pane entry is augmented with `metadata` + `version` joined
   * from MetadataStore.snapshot(). We call the renderer FIRST and only then
   * capture the metadata snapshot, so `asOfSeq` reflects the EventBus state
   * at or after the pane tree the client receives. Clients can then safely
   * drain events with `seq > asOfSeq` without double-applying a `pane.created`
   * for a pane the snapshot already contains. Metadata mutations that happen
   * during the gap are delivered as ordinary events, so final consistency is
   * preserved (codex P2).
   *
   * Fallback order for `metadata` per pane:
   *   1. MetadataStore entry (authoritative once M0-e SessionManager hydration
   *      lands)
   *   2. `l.metadata` from the renderer response — preserves v2.x session
   *      metadata for panes restored from disk before M0-e wires hydration
   *   3. `{}` — never-seen pane, identical to MetadataStore.get() shape
   * `version` follows the same priority: store version → 0 (the renderer
   * does not track a version field on PaneLeaf).
   *
   * Wire shape:
   *   { asOfSeq: number, bootId: string,
   *     panes: Array<PaneListEntry & { metadata: PaneMetadata, version: number }> }
   */
  router.register('pane.list', async (params) => {
    // 1. Fetch the pane tree from the renderer.
    const panes = (await sendToRenderer(getWindow, 'pane.list', params)) as Array<
      Record<string, unknown> & { id?: unknown; metadata?: unknown }
    >;

    // renderer가 paneGate 미준비(부팅 중) 등으로 배열 대신 { error, retryable }
    // 객체를 반환할 수 있다. 그대로 .map()을 돌리면 TypeError로 핸들러가 죽고
    // 클라이언트엔 의미 없는 에러가 간다. 명시적으로 검사해 retryable 사유를
    // 그대로 전파한다(클라이언트가 재시도 판단 가능).
    if (!Array.isArray(panes)) {
      const errObj = panes as { error?: unknown; retryable?: unknown } | null;
      const reason =
        errObj && typeof errObj.error === 'string'
          ? errObj.error
          : 'pane.list: renderer returned a non-array response';
      throw new Error(reason);
    }

    // 2. THEN snapshot the metadata store. asOfSeq is anchored to the pane
    //    tree we just received: any event with seq > asOfSeq describes a
    //    delta relative to the panes[] the client is about to read.
    const snapshot = store.snapshot();
    const metadataByPaneId = new Map<string, { metadata: PaneMetadata; version: number }>();
    for (const entry of snapshot.entries) {
      metadataByPaneId.set(entry.paneId, {
        metadata: entry.metadata,
        version: entry.version,
      });
    }

    // X8 — join supervision state. One daemon.listSessions RPC per pane.list
    // call; build a ptyId → supervision summary map. Best-effort: a daemon
    // hiccup or local mode just yields no supervision fields (the pane tree is
    // already the authoritative response). `supervision` is additive — the CLI
    // text table and metadata readers ignore it.
    type SupervisionSummary = {
      restart: string;
      status: string;
      restartCount: number;
      consecutiveFailures: number;
    };
    const supervisionByPtyId = new Map<string, SupervisionSummary>();
    const dc = getDaemonClient?.();
    if (dc?.isConnected) {
      try {
        const sessions = (await dc.rpc('daemon.listSessions', {})) as Array<{
          id: string;
          supervision?: { restart?: string; status?: 'armed' | 'stopped' };
          supervisionRuntime?: {
            status?: 'armed' | 'stopped';
            restartCount?: number;
            consecutiveFailures?: number;
          };
        }>;
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (!s.supervision) continue;
            supervisionByPtyId.set(s.id, {
              restart: s.supervision.restart ?? 'on-failure',
              status: s.supervisionRuntime?.status ?? s.supervision.status ?? 'armed',
              restartCount: s.supervisionRuntime?.restartCount ?? 0,
              consecutiveFailures: s.supervisionRuntime?.consecutiveFailures ?? 0,
            });
          }
        }
      } catch (err) {
        console.warn('[pane.rpc] supervision join skipped — daemon.listSessions failed:', err);
      }
    }

    const joined = panes.map((pane) => {
      const paneId = typeof pane.id === 'string' ? pane.id : '';
      const found = metadataByPaneId.get(paneId);
      // Renderer-provided metadata is the M0-e bridge: until SessionManager
      // hydrates MetadataStore from session.json, restored panes only carry
      // their saved metadata on PaneLeaf.metadata. Falling back to it here
      // keeps v2.x sessions intact during the M0 rollout.
      const rendererMetadata =
        pane.metadata && typeof pane.metadata === 'object' && !Array.isArray(pane.metadata)
          ? (pane.metadata as PaneMetadata)
          : undefined;
      // X8 — match any of the pane's surface ptyIds to a supervised session
      // (the renderer exposes surfacePtyIds on each entry). A pane has at most
      // one supervised surface in practice; first match wins.
      let supervision: SupervisionSummary | undefined;
      const surfacePtyIds = Array.isArray(pane.surfacePtyIds)
        ? (pane.surfacePtyIds as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      for (const ptyId of surfacePtyIds) {
        const match = supervisionByPtyId.get(ptyId);
        if (match) { supervision = match; break; }
      }
      return {
        ...pane,
        metadata: found?.metadata ?? rendererMetadata ?? {},
        version: found?.version ?? 0,
        ...(supervision ? { supervision } : {}),
      };
    });

    return {
      asOfSeq: snapshot.asOfSeq,
      bootId: snapshot.bootId,
      panes: joined,
    };
  });

  /**
   * pane.focus — focuses a specific pane
   * params: { id: string }
   */
  router.register('pane.focus', (params, ctx) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('pane.focus: missing required param "id"'));
    }
    // BYOB P4: a validated commander caller (ctx stamped by the router from
    // its per-spawn token — never from the wire) is confined to its own
    // workspace. The confinement id rides to the renderer bridge, which
    // resolves the pane's true owner and refuses a mismatch.
    return sendToRenderer(getWindow, 'pane.focus', {
      id: params['id'],
      ...(ctx?.commanderWorkspace ? { confineWorkspaceId: ctx.commanderWorkspace } : {}),
    });
  });

  /**
   * pane.split — splits the active pane
   * params: { direction: 'horizontal' | 'vertical' }
   */
  router.register('pane.split', (params, ctx) => {
    const direction = params['direction'];
    if (direction !== 'horizontal' && direction !== 'vertical') {
      return Promise.reject(
        new Error('pane.split: "direction" must be "horizontal" or "vertical"'),
      );
    }
    // #236: forward an explicit workspaceId so an external multi-agent caller
    // can split inside ITS OWN workspace rather than whichever workspace the
    // user is currently viewing. Omitted → the renderer falls back to the
    // active workspace (unchanged human-keybind / first-party CLI behavior).
    // Mirrors the pane.search forwarding guard above.
    let workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(
        new Error('pane.split: "workspaceId" must be a string if provided'),
      );
    }
    // BYOB P4: a validated commander is confined to its own workspace — the
    // tool schema lets a (misjudging) brain pass any workspaceId, so the
    // server pins it: explicit mismatch → refuse; omitted → the commander's
    // own workspace, never the on-screen one (GLM review, PR #475).
    if (ctx?.commanderWorkspace) {
      if (workspaceId !== undefined && workspaceId !== ctx.commanderWorkspace) {
        return Promise.reject(
          new Error('pane.split: workspace is outside the commander\'s workspace'),
        );
      }
      workspaceId = ctx.commanderWorkspace;
    }
    return sendToRenderer(getWindow, 'pane.split', {
      direction,
      ...(workspaceId !== undefined && { workspaceId }),
    });
  });

  /**
   * pane.close — closes a leaf pane and disposes its surfaces' PTYs.
   * params: { id: string }
   *
   * paneIds are globally unique, so the renderer resolves the target across
   * ALL workspaces (mirrors surface.close) rather than the UI-active one. This
   * lets an external multi-agent caller clean up a worker pane it created via
   * pane.split in its own background workspace. No active-ws fallback.
   */
  router.register('pane.close', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('pane.close: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'pane.close', { id: params['id'] });
  });

  /**
   * Resolves the target pane for a metadata RPC. Two paths:
   *
   *   - `paneId` provided: ask the renderer to confirm the paneId actually
   *     belongs to `workspaceId` (or, when workspaceId is omitted, to any
   *     workspace) via the internal `pane.validateWorkspace` channel.
   *     MetadataStore is keyed by paneId only — without this check an MCP
   *     scoped to workspace A could pass B's paneId + its own workspaceId
   *     and read/write B's metadata (codex P1, M0-d follow-up). The renderer
   *     holds the authoritative pane tree, so it's the right place to ask.
   *   - `paneId` omitted: ask the renderer for the active leaf via the
   *     `pane.resolveActiveLeaf` channel. Read-only; paneSlice is not
   *     mutated. The resolved leaf id is already scoped to the workspace
   *     the renderer answered for, so no additional check is needed.
   *
   * Both channels are renderer-internal — they never expose metadata
   * patches; the renderer only answers "is this pane in that workspace"
   * (validate) or "which leaf is active" (resolve). MetadataStore remains
   * the sole writer on the metadata surface.
   */
  async function resolveTarget(
    paneId: string | undefined,
    workspaceId: string | undefined,
  ): Promise<{ paneId: string; workspaceId: string | undefined }> {
    if (paneId) {
      // M0-d follow-up (codex P1) — workspace membership check. MetadataStore
      // is keyed by paneId only, so without this an MCP scoped to workspace
      // A could pass B's paneId together with its own workspaceId and quietly
      // read/mutate B's metadata. pane.list still uses the renderer tree-walk
      // path (no resolveTarget call), so this only adds one IPC per
      // set/get/clear write — well below the resolveActiveLeaf budget the
      // paneId-omitted path already pays.
      const validation = (await sendToRenderer(getWindow, 'pane.validateWorkspace', {
        paneId,
        workspaceId,
      })) as { paneId?: string; workspaceId?: string; error?: string };
      if (validation.error || !validation.paneId) {
        throw new Error(validation.error ?? 'pane.validateWorkspace: pane not found');
      }
      return {
        paneId: validation.paneId,
        // When the caller omitted workspaceId, use the workspaceId the
        // renderer just confirmed — it's the authoritative value for
        // event scoping on the subsequent MetadataStore write.
        workspaceId: workspaceId ?? validation.workspaceId,
      };
    }
    const resolved = (await sendToRenderer(getWindow, 'pane.resolveActiveLeaf', {
      workspaceId,
    })) as { paneId?: string; workspaceId?: string; error?: string };
    if (resolved.error || !resolved.paneId) {
      throw new Error(resolved.error ?? 'unable to resolve active leaf pane');
    }
    return {
      paneId: resolved.paneId,
      workspaceId: workspaceId ?? resolved.workspaceId,
    };
  }

  /**
   * pane.setMetadata — set descriptive metadata on a leaf pane.
   * params: { paneId?, workspaceId?, label?, role?, status?, custom?,
   *           merge?, mergeMode?, expectedVersion? }
   *
   * M0-b: MetadataStore is the sole writer for metadata. If the caller
   * omits paneId, the handler resolves the active leaf via the internal
   * `pane.resolveActiveLeaf` channel (renderer answers with the leaf id;
   * no paneSlice write happens) and then commits via MetadataStore.set().
   *
   * M0-f wire-format spec:
   *   - `mergeMode` (v2.9.0+) — 'merge' | 'replace' | 'replaceShared'.
   *     Wins over the legacy `merge` boolean when both are present.
   *   - `merge` (v2.8.x legacy) — true → 'merge', false → 'replace'.
   *     Default 'merge' when neither field is present.
   *   - `expectedVersion` (v2.9.0+) — optimistic concurrency guard.
   *     Mismatch returns VERSION_CONFLICT and does not mutate.
   *   - Reply now includes `version` (additive — v2.8.x destructures of
   *     { ok, paneId, metadata } keep working).
   *
   * External MCP callers SHOULD pass workspaceId so writes stay scoped to
   * the caller's workspace and don't get hijacked to whichever ws the user
   * is currently viewing.
   */
  router.register('pane.setMetadata', async (params, ctx?: RpcContext) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    // M0-f: explicit `mergeMode` wins over legacy `merge:boolean`. When
    // mergeMode is undefined we fall back to the legacy `merge` boolean
    // (v2.8.x compatibility); when it's provided we accept the three
    // documented modes and reject everything else. An earlier draft
    // silently fell back on a wrong-typed value (e.g. mergeMode: 'foo')
    // which masked client bugs — codex P2.
    const mergeModeParam = params['mergeMode'];
    let mergeMode: MergeMode;
    if (mergeModeParam === undefined) {
      mergeMode = params['merge'] === false ? 'replace' : 'merge';
    } else if (
      mergeModeParam === 'merge' ||
      mergeModeParam === 'replace' ||
      mergeModeParam === 'replaceShared'
    ) {
      mergeMode = mergeModeParam;
    } else {
      throw new Error(
        'pane.setMetadata: "mergeMode" must be one of "merge", "replace", "replaceShared"',
      );
    }

    // M0-f: expectedVersion is the optimistic-concurrency guard. An
    // earlier draft coerced wrong-typed values (e.g. the string "1" from
    // a CLI/env serialization path) to undefined, which silently bypassed
    // the guard and turned the call into an unconditional write. Reject
    // anything that isn't a non-negative integer up front — codex P2.
    let expectedVersion: number | undefined;
    if (params['expectedVersion'] !== undefined) {
      const ev = params['expectedVersion'];
      if (typeof ev !== 'number' || !Number.isInteger(ev) || ev < 0) {
        throw new Error(
          'pane.setMetadata: "expectedVersion" must be a non-negative integer',
        );
      }
      expectedVersion = ev;
    }

    // Wire-shape extraction only — actual field validation (types, caps,
    // custom-map contract) is the store's job. Cast targets are safe because
    // MetadataStore.set runs sanitize() up front and throws on every shape
    // violation; the catch below wraps with the RPC-method prefix.
    let patch: Partial<PaneMetadata> = {};
    if (params['label'] !== undefined) patch.label = params['label'] as string;
    // P2: `role` deprecated — no longer written from the RPC. Legacy role in
    // metadata.json is read-only (dead); MetadataStore keeps the field handling
    // for backward-compat reads of pre-P2 data.
    if (params['status'] !== undefined) patch.status = params['status'] as string;
    if (params['custom'] !== undefined) patch.custom = params['custom'] as Record<string, string>;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.setMetadata: ${msg}`);
    }

    // P2 (review fix): the deprecated `role` is dropped above. A legacy role-only
    // call — especially with mergeMode 'replace' — would otherwise hand an EMPTY
    // patch to a replace, which MetadataStore treats as a full wipe of the pane's
    // existing label/status/custom. When role was sent and nothing supported
    // remains, no-op and return the current state rather than destroying metadata
    // over a dead field. (An intentional empty replace — no role — still clears.)
    if (params['role'] !== undefined && Object.keys(patch).length === 0) {
      const current = store.get(target.paneId);
      return { ok: true, paneId: target.paneId, metadata: current.metadata, version: current.version };
    }

    // D2 SECURITY — the enforcement role is operator-only on this wire. See
    // guardRoleKey. First-party dispatch (renderer bridge / plugin host) is the
    // operator and passes through untouched.
    let roleRejected = false;
    if (!ctx?.firstParty) {
      const guarded = guardRoleKey(patch, mergeMode, store.get(target.paneId).metadata.custom);
      patch = guarded.patch;
      roleRejected = guarded.rejected;
      if (roleRejected) {
        console.warn(
          `[wmux:pane.setMetadata] denied "${ORCH_ROLE_KEY}" write from a non-first-party caller`,
          { paneId: target.paneId, clientName: ctx?.clientName ?? 'unknown' },
        );
      }
    }

    let result;
    try {
      // Passing workspaceId through unchanged (including undefined) lets
      // MetadataStore fall back to the pane's remembered workspaceId, so a
      // legacy paneId-only call doesn't clear the scope established by an
      // earlier write. store.set runs sanitize() before any mutation, so a
      // bad payload throws here without bumping the version.
      result = store.set(target.paneId, patch, {
        mergeMode,
        workspaceId: target.workspaceId,
        ...(expectedVersion !== undefined && { expectedVersion }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.setMetadata: ${msg}`);
    }
    if (!result.ok) {
      // VERSION_CONFLICT — RpcRouter currently only propagates the error
      // message string; we embed `currentVersion=N` so clients can parse
      // the right base for a retry. Structured error envelopes (with
      // `code: RPC_VERSION_CONFLICT` and `data.currentVersion`) are
      // future work — see src/shared/rpc.ts for the type stubs.
      throw new Error(
        `pane.setMetadata: ${result.error} (currentVersion=${result.currentVersion})`,
      );
    }
    // M0-f wire-format reply: { ok, paneId, metadata, version }. The
    // `version` field is additive — v2.8.x clients that only read the
    // first three keys keep working.
    return {
      ok: true,
      paneId: target.paneId,
      metadata: result.metadata,
      version: result.version,
      // D2 SECURITY — the denial must be visible to the caller, not silent.
      ...(roleRejected
        ? {
            rejectedKeys: [ORCH_ROLE_KEY],
            note:
              `"${ORCH_ROLE_KEY}" is assigned by the operator and cannot be set over this API; ` +
              'the rest of the patch was applied.',
          }
        : {}),
    };
  });

  /**
   * pane.getMetadata — read metadata for a leaf pane.
   * params: { paneId?, workspaceId? } — omitted paneId resolves to the
   * active leaf via the same `pane.resolveActiveLeaf` channel setMetadata
   * uses, so reads always see the latest MetadataStore state for the same
   * pane that a subsequent write would target.
   */
  router.register('pane.getMetadata', async (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.getMetadata: ${msg}`);
    }

    const entry = store.get(target.paneId);
    // M0-f wire-format reply: { paneId, metadata, version }. `version` is
    // additive — v2.8.x clients reading { paneId, metadata } keep working.
    return { paneId: target.paneId, metadata: entry.metadata, version: entry.version };
  });

  /**
   * pane.clearMetadata — drop all metadata for a leaf pane.
   * params: { paneId?, workspaceId? }
   *
   * Same resolution as setMetadata. The renderer is consulted only to
   * resolve the active leaf; the actual clear happens against MetadataStore.
   */
  router.register('pane.clearMetadata', async (params, ctx?: RpcContext) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.clearMetadata: ${msg}`);
    }

    // D2 SECURITY — the SECOND route to the same key. A wholesale clear drops
    // `orchestrator.role` along with everything else, and dropping the role IS
    // the attack: an unbound role misses the binding lookup and fail-open hands
    // the agent the default model. So a non-first-party clear wipes everything
    // EXCEPT the operator's role assignment. Same strip-and-report posture as
    // setMetadata; see guardRoleKey.
    const preservedRole = ctx?.firstParty
      ? undefined
      : store.get(target.paneId).metadata.custom?.[ORCH_ROLE_KEY];
    if (preservedRole !== undefined) {
      console.warn(
        `[wmux:pane.clearMetadata] preserved "${ORCH_ROLE_KEY}" through a non-first-party clear`,
        { paneId: target.paneId, clientName: ctx?.clientName ?? 'unknown' },
      );
      const kept = store.set(
        target.paneId,
        { custom: { [ORCH_ROLE_KEY]: preservedRole } },
        { mergeMode: 'replace', workspaceId: target.workspaceId },
      );
      return kept.ok
        ? {
            ok: true,
            paneId: target.paneId,
            version: kept.version,
            rejectedKeys: [ORCH_ROLE_KEY],
            note:
              `"${ORCH_ROLE_KEY}" is assigned by the operator and was preserved; ` +
              'all other metadata was cleared.',
          }
        : { ok: false, paneId: target.paneId, error: kept.error };
    }

    const result = store.clear(target.paneId);
    // M0-f wire-format reply: { ok, paneId, version }. Version is the
    // post-clear monotonic counter (bumped by store.clear). v2.8.x clients
    // that only read { ok, paneId } continue to work.
    return result.ok
      ? { ok: true, paneId: target.paneId, version: result.version }
      : { ok: false, paneId: target.paneId, error: result.error };
  });

  /**
   * pane.search — cross-pane search across a workspace's live panes
   * params: { query: string, regex?: boolean, workspaceId?: string }
   *
   * The `workspaceId` (when present) is forwarded so the renderer handler
   * (C1 fix) can scope the search to the CALLING workspace rather than
   * whichever workspace the user happens to be viewing in the UI. Internal
   * renderer callers omit it and the handler falls back to the active
   * workspace. Cross-workspace search is deferred to v2 (D9).
   */
  router.register('pane.search', (params) => {
    if (typeof params['query'] !== 'string' || params['query'].length === 0) {
      return Promise.reject(new Error('pane.search: "query" must be a non-empty string'));
    }
    const regex = params['regex'];
    if (regex !== undefined && typeof regex !== 'boolean') {
      return Promise.reject(new Error('pane.search: "regex" must be a boolean if provided'));
    }
    const workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(
        new Error('pane.search: "workspaceId" must be a string if provided'),
      );
    }
    return sendToRenderer(getWindow, 'pane.search', {
      query: params['query'],
      ...(regex !== undefined && { regex }),
      ...(workspaceId !== undefined && { workspaceId }),
    });
  });
}
