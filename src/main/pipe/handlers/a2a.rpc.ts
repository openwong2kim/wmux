import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../DaemonClient';
import * as fs from 'fs';
import { getPidMapDir } from '../../../shared/constants';
import { validateMessage } from '../../../shared/types';
import { defaultSnapshot } from '../../pty/portWatch';
import type { PortSnapshot, SnapshotFn } from '../../pty/portWatch';
import { walkToOwningAnchor } from '../../pty/serverSidePidWalk';
import type { OwningAnchor } from '../../pty/serverSidePidWalk';

type GetWindow = () => BrowserWindow | null;

// ─── envelope PR4: A2A 태스크 데몬 정본 게이트 ─────────────────────────
// 전이·취소·생성의 정본은 데몬 A2aTaskService(append-only 로그)다. 이 헬퍼가
// 데몬 커밋을 시도하고 결과를 3분류한다:
//   ok          — 데몬 게이트(권한·VALID_TRANSITIONS) 통과 + 로그 커밋. 렌더러는
//                 committedTask를 **verbatim 적용**해야 한다(§6.M C6).
//   reject      — 데몬 명시 거부(불법 전이 등). 렌더러를 건드리지 않고 그대로
//                 반환한다 — 렌더러가 재판정하면 split-brain.
//   unavailable — 데몬 미가용/로그 미개방/태스크 미시드('task not found': 렌더러-
//                 로컬 생성 태스크 등). 기존 렌더러-검증 경로로 폴백(컨틴전시) —
//                 A2A는 역사적으로 best-effort 비내구라 degrade가 파국이 아니다.
type DaemonTaskGate =
  | { kind: 'ok'; result: Record<string, unknown> }
  | { kind: 'reject'; error: string }
  | { kind: 'unavailable' };

// soft 분류 마커: 'pane-authz deferred'는 S-C2 페인 게이트를 렌더러(페인 트리
// 소유자)가 판정하도록 데몬이 의도적으로 미루는 신호다 — 거부가 아니라 폴백.
const A2A_DAEMON_SOFT_ERRORS = ['task log unavailable', 'task not found', 'pane-authz deferred'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** task.metadata.updatedAt(ISO-8601, 사전순=시간순). 부재 시 '' — 항상 최소값. */
function taskUpdatedAt(t: Record<string, unknown>): string {
  const meta = isRecord(t.metadata) ? t.metadata : undefined;
  return typeof meta?.updatedAt === 'string' ? meta.updatedAt : '';
}

async function daemonTaskRpc(
  getDaemonClient: (() => DaemonClient | null) | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<DaemonTaskGate> {
  const dc = getDaemonClient?.();
  if (!dc) return { kind: 'unavailable' };
  try {
    const res = await dc.rpc(method, params);
    if (isRecord(res) && res.ok === true) return { kind: 'ok', result: res };
    const error = isRecord(res) && typeof res.error === 'string' ? res.error : `${method}: daemon rejected`;
    if (A2A_DAEMON_SOFT_ERRORS.some((s) => error.includes(s))) return { kind: 'unavailable' };
    return { kind: 'reject', error };
  } catch {
    // 파이프 단절/타임아웃 — 렌더러 폴백(soft).
    return { kind: 'unavailable' };
  }
}

/** Validate an RPC-supplied caller pid. Anything non-positive / non-integer is
 *  ignored (older MCP build, or junk) → the handler keeps its legacy behavior. */
function normalizeCallerPid(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Resolve `p`, but never wait longer than `ms` — on timeout resolve `fallback`.
 *  Keeps a slow process snapshot from blocking (past the client's RPC deadline)
 *  the legacy identity fallback the handler still wants to return. */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback); } }, ms);
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    p.then(finish, () => finish(fallback));
  });
}

/** Soft cap for the whole resolve.identity call, under the MCP client's ~10s RPC
 *  timeout. The snapshot wait is bounded to whatever remains after the pid-map
 *  scan so a hung Win32_Process query can't sink the legacy fallback response. */
const RPC_SNAPSHOT_DEADLINE_MS = 8000;

export function registerA2aRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  claudeWorker: ClaudeWorker,
  opts: { snapshot?: SnapshotFn; getDaemonClient?: () => DaemonClient | null } = {},
): void {
  const getDaemonClient = opts.getDaemonClient;
  // Server-side process-tree snapshot for handshake identity resolution. Shared
  // across CONCURRENT handshakes (in-flight coalescing) so the multi-agent launch
  // burst triggers ONE Win32_Process spawn, not one per agent. The MCP side
  // caches a resolved identity, so a successful handshake never re-fires; only
  // the miss/fallback path re-snaps.
  const snapshotFn: SnapshotFn = opts.snapshot ?? defaultSnapshot;
  let snapInflight: Promise<PortSnapshot> | null = null;
  async function getCoalescedSnapshot(): Promise<PortSnapshot | null> {
    if (!snapInflight) {
      snapInflight = snapshotFn().finally(() => { snapInflight = null; });
    }
    try {
      return await snapInflight;
    } catch {
      return null; // PowerShell missing / denied → no server walk
    }
  }
  // Return a process table guaranteed to contain `callerPid` (or null). A
  // coalesced snapshot can PREDATE this caller — an earlier handshake in the same
  // burst triggered it before this MCP's process existed — so our pid and our
  // ancestry may be absent, silently missing the walk. When the shared table
  // lacks callerPid, take ONE fresh snapshot. A single refresh is enough; a pid
  // still absent afterwards is a genuine miss (caller detached / exited), not a
  // staleness artifact.
  async function snapshotForCaller(callerPid: number): Promise<PortSnapshot | null> {
    const shared = await getCoalescedSnapshot();
    // Snapshot FAILED (PowerShell/CIM unavailable or slow) — do NOT retry: a
    // second attempt could stack two ~8s timeouts and blow past the client's RPC
    // deadline, costing the caller even the legacy/client-walk/env fallback
    // mappings. Degrade gracefully (no server walk; mappings/entries still
    // returned). Refresh ONLY when the table succeeded but predates this caller.
    if (!shared) return null;
    if (shared.ppidByPid.has(callerPid)) return shared;
    // Stale: this snapshot predates our process. Re-COALESCE rather than spawn
    // directly — the first batch's inflight promise already cleared, so this
    // joins/forms a SECOND shared snapshot with the burst's other late arrivers
    // instead of one PowerShell spawn per caller. A callerPid still absent after
    // that is a genuine miss the walk handles (parent undefined → null).
    return getCoalescedSnapshot();
  }

  // a2a.resolve.identity — handled in main process (not renderer).
  // Returns PID → CURRENT workspaceId mappings so an MCP server can resolve
  // which workspace it belongs to by walking its own process tree.
  //
  // The on-disk pid-map stores PID → ptyId (a stable, immutable anchor). The
  // owning workspace is resolved LIVE here, from the renderer, every time —
  // because a workspace id can be re-minted by a daemon respawn or session
  // restore while the shell process (and its frozen WMUX_WORKSPACE_ID env)
  // lives on. Storing the workspace id at create time and trusting it forever
  // is exactly what produced stale identities ("no workspace found for ws-…").
  router.register('a2a.resolve.identity', async (params) => {
    // PROPER multi-agent fix: a caller that can't walk its own process tree —
    // Codex sandboxes the per-hop PowerShell spawn and strips the env hints —
    // sends its OWN pid as `callerPid`. We then walk the tree HERE (main, where
    // the snapshot is unsandboxed) from that pid up to the owning shell's
    // pid-map anchor and return the resolved identity directly. Absent callerPid
    // keeps the legacy contract verbatim (the client walks the returned map), so
    // older MCP builds are unaffected.
    //
    // SECURITY: callerPid is caller-asserted (the pipe does not bind the
    // connection to a pid), so a same-user caller could pass a foreign pid to
    // resolve another pane's identity. That stays within the #113 same-user
    // ceiling — a caller holding the pipe token is already grandfathered
    // allow-all — so this is a reliability mechanism, not a new security boundary.
    const callerPid = normalizeCallerPid((params as { callerPid?: unknown }).callerPid);
    // Start the snapshot CONCURRENTLY and bound the wait (at the walk below) to the
    // RPC budget: it feeds only the final walk, so it must never delay — or, past
    // the client's ~10s RPC deadline, SINK — the legacy mappings/entries fallback
    // this handler returns. Overlapping the pid-map scan + renderer resolves hides
    // its latency in the common case; the deadline caps the degraded one
    // (PowerShell/CIM hung → up to two 8s timeouts inside snapshotForCaller).
    // Started only when a caller asked for server-side resolution (legacy calls
    // pay nothing); resolves to a table containing callerPid, or null.
    const startedAt = Date.now();
    const snapshotPromise: Promise<PortSnapshot | null> =
      callerPid != null ? snapshotForCaller(callerPid) : Promise.resolve(null);

    const dir = getPidMapDir();
    const mappings: Record<string, string> = {};
    // Additive (X4 CLI): per-PID detail including the immutable ptyId anchor,
    // so a caller that finds its own shell PID here gets pane-level identity
    // (ptyId) and not just the owning workspace. `mappings` is kept verbatim
    // for existing MCP clients.
    const entries: Array<{ pid: string; ptyId: string; workspaceId: string }> = [];
    try {
      if (!fs.existsSync(dir)) return { mappings, entries, resolved: null };

      for (const file of fs.readdirSync(dir)) {
        let value: string;
        try {
          value = fs.readFileSync(`${dir}/${file}`, 'utf8').trim();
        } catch {
          continue; // unreadable / racing-unlink entry — skip
        }
        if (!value) continue;

        // Drop legacy "PID → workspaceId" entries unconditionally. They have no
        // ptyId anchor so they cannot be live-resolved; the old code passed them
        // through verbatim, handing back a frozen id that goes stale the moment
        // the workspace is re-minted (daemon respawn / session restore). Worse,
        // the OS recycles PID numbers onto unrelated live processes (Notepad /
        // Discord / RuntimeBroker observed in the wild), so a legacy entry on a
        // recycled-but-live PID resurfaces as a ghost workspace (browser_open →
        // "no active workspace"; terminal ops → "not owned by workspace ws-…").
        // The current writer only ever stores ptyIds, so any "ws-" value is pure
        // legacy debris — purge it. This is the single largest ghost source and
        // is safe to delete on this read path (no liveness probe, no race).
        //
        // We deliberately do NOT "keep it if its workspace is still live"
        // (considered, then rejected): workspace.list proves only that the
        // workspace exists, not that this PID file still belongs to that pane.
        // Legacy files are PID-keyed with ws- content, so removePidMapByPtyId
        // (keyed by ptyId content) can never prune them — a kept entry lives
        // forever, and once the OS recycles its PID onto another MCP server's
        // ancestor it mis-routes commands to a live-but-WRONG workspace (worse
        // than the dead-id ghost: silent, not a hard failure). Unverifiable +
        // unprunable ⇒ unconditional purge is the only safe policy. A genuinely
        // live pane re-anchors with a current-format ptyId entry on its next
        // reconnect, so nothing is permanently lost.
        if (value.startsWith('ws-')) {
          try { fs.unlinkSync(`${dir}/${file}`); } catch { /* best-effort */ }
          continue;
        }

        // Current format: PID → ptyId. Resolve the workspace that owns this pty
        // RIGHT NOW. PID → ptyId is immutable for the process lifetime; only the
        // pty → workspace edge changes, and that is read live. A dead or
        // recycled-but-live PID whose stored ptyId no longer exists resolves to
        // null here and is correctly excluded — so a stale current-format file
        // can never produce a ghost and is harmless if left on disk. Accretion
        // is bounded instead at the write boundary (see pty.handler.ts
        // onDaemonSessionDied cleanup); a read-path prune is deliberately out of
        // scope — a snapshot-only liveness signal can be incomplete and would
        // risk deleting a LIVE pane's anchor (3-way review consensus).
        try {
          // Mirror-first (workspace/ptyOwnership.ts) — this loop pays one
          // lookup per live pid-map anchor, so a fresh mirror collapses N
          // renderer round-trips into zero.
          const wsId = await resolvePtyOwnerWorkspace(getWindow, value);
          if (typeof wsId === 'string' && wsId) {
            mappings[file] = wsId;
            entries.push({ pid: file, ptyId: value, workspaceId: wsId });
          }
        } catch {
          // Renderer unavailable (early boot / reload) — skip this entry;
          // the caller retries resolution on its next identity-gated call.
        }
      }
    } catch { /* best-effort: identity resolution is non-critical */ }

    // Server-side walk: from callerPid's PARENT up the live tree to the first
    // ancestor that is a known live anchor. `entries` is already the set of LIVE
    // PID→ptyId→workspace anchors resolved above, so the walk reuses it — no
    // second pid-map read, and dead/recycled anchors are excluded by construction.
    //
    // We start at the PARENT, never callerPid itself: the MCP is never its own
    // pane's shell, and matching its own pid could hit a recycled-PID anchor (an
    // old shell's pid-map file whose number the OS reassigned to this MCP) and
    // mis-route to a stranger workspace. The client-side walk avoids this the same
    // way — it starts at process.ppid.
    // The snapshot feeds ONLY the walk, and the walk can only hit if there is at
    // least one live anchor. With no entries (empty dir / boot-respawn window /
    // renderer gave no owners) skip the snapshot wait entirely — awaiting a
    // slow/hung snapshot to walk an empty anchor set would stall the empty-map
    // fallback for nothing (and terminal routing's empty-map grace loop would
    // multiply it). The concurrently-started snapshot just resolves and is dropped
    // (coalesced, so a boot burst shares one).
    let resolved: { workspaceId: string; ptyId: string } | null = null;
    if (callerPid != null && entries.length > 0) {
      const snapshot = await withDeadline(
        snapshotPromise,
        RPC_SNAPSHOT_DEADLINE_MS - (Date.now() - startedAt),
        null,
      );
      if (snapshot) {
        const anchorByPid = new Map<number, OwningAnchor>();
        for (const e of entries) {
          const pid = Number(e.pid);
          if (Number.isInteger(pid) && pid > 0) {
            anchorByPid.set(pid, { ptyId: e.ptyId, workspaceId: e.workspaceId });
          }
        }
        const parentPid = snapshot.ppidByPid.get(callerPid);
        const hit = parentPid !== undefined
          ? walkToOwningAnchor(parentPid, snapshot.ppidByPid, anchorByPid)
          : null;
        if (hit) resolved = { workspaceId: hit.anchor.workspaceId, ptyId: hit.anchor.ptyId };
      }
    }

    return { mappings, entries, resolved };
  });

  // A2A protocol — whoami/discover/broadcast/skills는 렌더러 소유 그대로.
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', (params) => sendToRenderer(getWindow, 'a2a.discover', params));
  router.register('a2a.broadcast', (params) => sendToRenderer(getWindow, 'a2a.broadcast', params));
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));

  // task.query — 데몬 정본 + 렌더러 캐시 병합(envelope PR4).
  // 렌더러: 렌더러-로컬 생성 태스크(채널멘션 chmention-* 등)와 세션 내 증분
  // 히스토리를 보유. 데몬: 재시작을 생존한 정본 태스크를 보유(내구화의 가치).
  // 병합 규칙(패널 D): 같은 id면 **데몬이 더 최신일 때 데몬 status/updatedAt 우선**.
  // 데몬 커밋 후 렌더러가 daemonCommitted를 적용하기 전 크래시/불달이면 렌더러
  // 캐시가 stale인데, 렌더러-무조건-우선은 그 stale이 정본을 영영 가린다. 데몬이
  // 더 최신이면 status/updatedAt만 데몬 값으로 덮고, 렌더러 전용 증분(history·
  // artifacts)은 보존한다(§6.F — 증분 히스토리는 아직 데몬 비내구). 데몬-only
  // id(재시작 생존분)는 추가. 데몬 미가용이면 현행 렌더러-only와 동일.
  router.register('a2a.task.query', async (params) => {
    let rendererRes: unknown = null;
    try {
      rendererRes = await sendToRenderer(getWindow, 'a2a.task.query', params);
    } catch (err) {
      rendererRes = null; // 렌더러 미가용(early boot) — 데몬 단독 응답 시도
      if (!getDaemonClient?.()) throw err; // 양쪽 다 없으면 현행대로 전파
    }
    // 렌더러의 구조화 검증 에러(workspaceId 누락·불량 커서)는 계약 그대로 반환 —
    // 데몬-only 응답으로 대체하면 오늘의 에러 계약이 사라진다.
    if (isRecord(rendererRes) && typeof rendererRes.error === 'string') return rendererRes;
    // 커서는 렌더러와 동일하게 canonical UTC ISO로 정규화해 데몬에 전달한다
    // (데몬 projection의 사전순 비교 건전성 — useRpcBridge A9와 동일 이유).
    let updatedSince: string | undefined;
    if (typeof params.updatedSince === 'string' && params.updatedSince.trim()) {
      const ms = Date.parse(params.updatedSince.trim());
      if (!Number.isNaN(ms)) updatedSince = new Date(ms).toISOString();
    }
    // status 필터는 데몬 조회에 넣지 않는다(패널 델타): 데몬 정본이 필터 밖 상태이면
    // (예: 렌더러 stale=working인데 데몬 정본=completed, 필터=working) 데몬 조회가 그
    // 태스크를 빼버려 same-id override가 불가능해진다. 데몬은 status 무필터로 받아
    // 병합해 정본을 덮은 뒤, 최종 merged에 status 필터를 적용한다. role(불변)·
    // updatedSince(커서)는 override 문제가 없어 데몬 조회에 유지.
    const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.query', {
      workspaceId: params.workspaceId,
      ...(typeof params.role === 'string' ? { role: params.role } : {}),
      ...(updatedSince ? { updatedSince } : {}),
    });
    if (gate.kind !== 'ok') return rendererRes;
    const daemonTasks = Array.isArray(gate.result.tasks) ? (gate.result.tasks as Array<Record<string, unknown>>) : [];
    const rendererOk = isRecord(rendererRes) && Array.isArray(rendererRes.tasks);
    if (!rendererOk) {
      return { workspaceId: params.workspaceId, tasks: daemonTasks };
    }
    const rendererTasks = (rendererRes as { tasks: Array<Record<string, unknown>> }).tasks;
    const daemonById = new Map(daemonTasks.map((t) => [t.id, t]));
    const merged = rendererTasks.map((rt) => {
      const dt = daemonById.get(rt.id);
      if (!dt) return rt;
      // 데몬 정본이 렌더러 캐시보다 최신이면(렌더러가 daemonCommitted 미적용) status/
      // updatedAt을 데몬 값으로 덮되 렌더러 전용 증분(history·artifacts)은 보존.
      if (taskUpdatedAt(dt) > taskUpdatedAt(rt)) {
        const rtMeta = isRecord(rt.metadata) ? rt.metadata : {};
        const dtMeta = isRecord(dt.metadata) ? dt.metadata : {};
        return { ...rt, status: dt.status, metadata: { ...rtMeta, updatedAt: dtMeta.updatedAt } };
      }
      return rt;
    });
    const seen = new Set(rendererTasks.map((t) => t.id));
    merged.push(...daemonTasks.filter((t) => !seen.has(t.id)));
    // 데몬 무필터 조회분(override·append)에 최종 status 필터를 적용한다 —
    // 렌더러는 이미 status로 걸렀지만, 데몬 override로 상태가 바뀐 태스크(stale
    // working→canonical completed)와 데몬-only 추가분은 여기서 걸러져야 한다.
    const statusFilter = typeof params.status === 'string' ? params.status : undefined;
    const finalTasks = statusFilter
      ? merged.filter((t) => (isRecord(t.status) ? t.status.state : undefined) === statusFilter)
      : merged;
    return { ...(rendererRes as Record<string, unknown>), tasks: finalTasks };
  });

  // task.update — 데몬 정본 게이트 선행(envelope PR4 C12 대칭 경로).
  // 데몬 ok → 렌더러에 daemonCommitted 마커 + committedTask로 verbatim 캐시 적용 +
  // 메시지 배달/이벤트 방출(렌더러 UI 반응성 로직 보존). 데몬 reject → 렌더러
  // 미접촉 반환(재판정 금지). 데몬 unavailable → 현행 렌더러-검증 경로 폴백.
  router.register('a2a.task.update', async (params) => {
    // 메시지 선검증(shared validateMessage — 렌더러와 동일 계약): 데몬 커밋 후
    // 렌더러가 메시지를 거부해 캐시-데몬이 갈라지는 창을 닫는다.
    if (typeof params.message === 'string') {
      try { validateMessage(params.message); } catch (e) {
        return { error: `a2a.task.update: ${e instanceof Error ? e.message : 'invalid'}` };
      }
    }
    if (typeof params.status === 'string') {
      const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.update', {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        status: params.status,
        // S-C2: 페인 신원 주장 여부를 데몬에 전달 — 페인 핀 태스크는 soft-defer로
        // 렌더러 페인 게이트에 판정을 되돌린다(ptyId→pane 해석은 렌더러 소유).
        ...(typeof params.senderPtyId === 'string' ? { senderPtyId: params.senderPtyId } : {}),
        ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
        // §4 멱등(리뷰 codex): 파이프 호출자의 키를 데몬까지 전달한다 — 없으면 커밋 후
        // 응답 유실 재시도가 캐시 미스 → invalid transition(completed->completed)으로 변질.
        ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
      });
      if (gate.kind === 'reject') return { error: gate.error };
      if (gate.kind === 'ok') {
        return sendToRenderer(getWindow, 'a2a.task.update', {
          ...params,
          daemonCommitted: true,
          committedTask: gate.result.task,
        });
      }
      // unavailable → 폴백(아래 공통 경로)
    }
    return sendToRenderer(getWindow, 'a2a.task.update', params);
  });

  // task.send: renderer validates, approval-gates execute:true, then stores +
  // delivers. Main only spawns the background worker after renderer reports that
  // the pre-create execute approval succeeded.
  // envelope PR4: 렌더러 성공 후 데몬 A2aTaskService에 정본 미러-생성한다(주소
  // 해석·승인 게이트 등 렌더러 UI 반응성 로직은 그대로). 워커 spawn **전에**
  // await — 이후 전이(working/completed)가 데몬 게이트에서 태스크를 찾도록.
  router.register('a2a.task.send', async (params, ctx) => {
    // Forward the VALIDATED commander binding (RpcRouter set it from the
    // per-spawn token; never read from the wire, so any caller-supplied value
    // is dropped first). The renderer's reply-delivery guards need it: an
    // orchestrator brain owns no pane, so without this every brain→worker nudge
    // in its own workspace is suppressed as an unverifiable sender.
    const sendParams: Record<string, unknown> = { ...params };
    delete sendParams.commanderWorkspaceId;
    if (ctx?.commanderWorkspace) sendParams.commanderWorkspaceId = ctx.commanderWorkspace;
    const result = await sendToRenderer(getWindow, 'a2a.task.send', sendParams);

    // 데몬 정본 미러-생성(신규 태스크 브랜치에서만 — 렌더러가 task 스냅샷 동반).
    // 실패는 soft-degrade: 이후 전이가 'task not found'로 렌더러 폴백을 탄다.
    if (isRecord(result) && result.ok === true && isRecord(result.task) && !params.taskId) {
      const t = result.task as { id?: unknown; metadata?: { title?: unknown; from?: unknown; to?: unknown }; history?: unknown };
      if (typeof t.id === 'string' && isRecord(t.metadata)) {
        const mirror = await daemonTaskRpc(getDaemonClient, 'a2a.task.create', {
          id: t.id,
          title: t.metadata.title,
          from: t.metadata.from,
          to: t.metadata.to,
          ...(Array.isArray(t.history) ? { history: t.history } : {}),
        });
        // C(패널): 미러-생성 실패는 조용한 비내구 태스크가 된다(렌더러엔 있고 데몬엔
        // 없음 → 재시작 미생존). 이후 전이는 'task not found'로 렌더러 폴백해 수렴하나,
        // 침묵 손실은 관측 가능해야 한다(롤백/outbox는 §6.F 소관 — 여기선 경고만).
        if (mirror.kind !== 'ok') {
          console.warn(
            `[a2a.rpc] daemon mirror-create failed for task ${t.id} — will not survive restart:`,
            mirror.kind === 'reject' ? mirror.error : 'daemon unavailable',
          );
        }
      }
      // 내부 운반 필드 제거 — 파이프 호출자 응답 계약 불변.
      delete (result as Record<string, unknown>).task;
    }

    // execute → origin decision (LanLink PR-1, positive-allow):
    //   local  + execute + !taskId + approved → claudeWorker.execute()  ← only spawn
    //   remote / undefined / unknown          → drop (fail-closed; blocks remote RCE)
    //   local  + (no execute | taskId | !approved) → message-only
    // origin is a REQUIRED RpcContext field, so a future remote transport cannot
    // silently inherit execute. The renderer-returned executeApproved is
    // origin-blind, so it is only consulted once we know origin is local.
    if (ctx?.origin === 'local' && params.execute === true && !params.taskId) {
      const record = result as Record<string, unknown> | null;
      const taskId = typeof record?.taskId === 'string' ? record.taskId : '';
      const receiverWsId = typeof record?.toWorkspaceId === 'string' ? record.toWorkspaceId : '';
      const executeApproved = record?.executeApproved === true;
      if (taskId && receiverWsId && executeApproved) {
        const message = typeof params.message === 'string' ? params.message : '';
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        claudeWorker.execute(taskId, receiverWsId, message, cwd).catch((err) => {
          console.error(`[a2a.rpc] Background worker failed for task ${taskId}:`, err);
        });
      }
    }

    return result;
  });

  // task.cancel: cancel worker + 데몬 정본 커밋 + 렌더러 캐시/이벤트(envelope PR4).
  router.register('a2a.task.cancel', async (params) => {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    if (taskId) claudeWorker.cancel(taskId);
    const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.cancel', {
      taskId,
      workspaceId: params.workspaceId,
      // §4 멱등(리뷰 codex): update 경로와 대칭 — 파이프 호출자 키를 데몬까지 전달.
      ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
    });
    if (gate.kind === 'reject') return { error: gate.error };
    if (gate.kind === 'ok') {
      // G(패널 델타): 데몬이 실제로 canceled로 전이했을 때만 렌더러 cancelled 이벤트를
      // 태운다. 이미 종단(completed/failed)인 태스크의 멱등 no-op(데몬 G 수정)은 상태
      // 변화가 없는데, 렌더러 cancel 핸들러는 daemonCommitted 시 무조건 state:'canceled'
      // 이벤트를 하드코딩 방출한다(useRpcBridge :1951) → completed 태스크에 거짓 'canceled'
      // 이벤트. no-op이면 렌더러 라운드트립 없이 ok만 반환(캐시 표류는 query 병합이 수렴).
      const committed = isRecord(gate.result.task) ? gate.result.task : undefined;
      const committedState =
        committed && isRecord(committed.status) ? committed.status.state : undefined;
      if (committedState === 'canceled') {
        return sendToRenderer(getWindow, 'a2a.task.cancel', {
          ...params,
          daemonCommitted: true,
          committedTask: gate.result.task,
        });
      }
      return { ok: true, taskId };
    }
    return sendToRenderer(getWindow, 'a2a.task.cancel', params);
  });
}
