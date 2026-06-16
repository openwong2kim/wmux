import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import type { PaneMetadata } from '../../../shared/types';
import { metadataStore, type MergeMode, type MetadataStore } from '../../metadata/MetadataStore';

type GetWindow = () => BrowserWindow | null;

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
  router.register('pane.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('pane.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'pane.focus', { id: params['id'] });
  });

  /**
   * pane.split — splits the active pane
   * params: { direction: 'horizontal' | 'vertical' }
   */
  router.register('pane.split', (params) => {
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
    const workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(
        new Error('pane.split: "workspaceId" must be a string if provided'),
      );
    }
    return sendToRenderer(getWindow, 'pane.split', {
      direction,
      ...(workspaceId !== undefined && { workspaceId }),
    });
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
  router.register('pane.setMetadata', async (params) => {
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
    const patch: Partial<PaneMetadata> = {};
    if (params['label'] !== undefined) patch.label = params['label'] as string;
    if (params['role'] !== undefined) patch.role = params['role'] as string;
    if (params['status'] !== undefined) patch.status = params['status'] as string;
    if (params['custom'] !== undefined) patch.custom = params['custom'] as Record<string, string>;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.setMetadata: ${msg}`);
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
  router.register('pane.clearMetadata', async (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.clearMetadata: ${msg}`);
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
