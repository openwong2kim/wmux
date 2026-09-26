#!/usr/bin/env node
// recorder.mjs — the wmux reference "event recorder" plugin.
//
// An external developer can clone examples/event-recorder/, run it against a
// running wmux, and watch lifecycle events stream into a file. It demonstrates,
// against the real substrate, every piece an external plugin needs:
//
//   1. Transport      — connect over the named pipe / unix socket / TCP
//                        fallback, auth with the token file. (PROTOCOL.md §5)
//   2. Identity        — mcp.identify + mcp.declarePermissions, then handle the
//                        enforce-mode approval handshake. (mcp-plugin-spec §4)
//   3. Event bus       — events.poll from cursor 0, opaque-cursor discipline,
//                        bootId restart detection, resync/droppedCount
//                        reconciliation via pane.list. (PROTOCOL.md §2, §3)
//   4. Metadata write  — optimistic-concurrency writeback of the recorder's
//                        own custom.* subtree. (PROTOCOL.md §1)
//
// No runtime dependencies. Node >= 18.
//
// All RPC method names, params, capability strings, and event types used here
// are verified against:
//   src/shared/rpc.ts, src/shared/events.ts,
//   src/main/mcp/methodCapabilityMap.ts, docs/api/mcp-plugin-spec.md.

import fs from 'node:fs';
import { WmuxClient, WmuxRpcError, endpoint } from './wmux-rpc.mjs';

const VERSION = '0.1.0';
const CLIENT_NAME = 'wmux-examples.event-recorder';

// The capability set this plugin actually needs (mcp-plugin-spec §3.2), each
// mapped to the method that requires it (src/main/mcp/methodCapabilityMap.ts):
//   events.subscribe                    — events.poll
//   workspace.read                      — workspace.list
//   pane.read                           — pane.list
//   meta.read                           — pane.getMetadata (read the current
//                                         version before an optimistic-
//                                         concurrency write)
//   meta.write:label                    — the shared display label, which shows
//                                         in the pane header (last-writer-wins)
//   meta.write:custom.event-recorder.*  — our own namespaced custom subtree
// We scope each meta.write to the narrowest glob we actually touch rather than
// requesting unscoped meta.write — the approval prompt renders the declared
// globs verbatim, so a tight scope is easier to approve. The two meta.write
// entries union at enforcement time (PermissionEnforcer.findCapabilityGrant
// collects every declaration for a capability), so a single pane.setMetadata
// writing both `label` and `custom.event-recorder.*` passes the path check.
const DECLARED_PERMISSIONS = [
  'events.subscribe',
  'workspace.read',
  'pane.read',
  'meta.read',
  'meta.write:label',
  'meta.write:custom.event-recorder.*',
];
const DECLARE_RATIONALE =
  'Reference event recorder: subscribes to lifecycle events and annotates the pane it is watching.';

// The eight WmuxEventType values (src/shared/events.ts WMUX_EVENT_TYPES).
const ALL_EVENT_TYPES = [
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.metadata.changed',
  'workspace.metadata.changed',
  'process.started',
  'process.exited',
  'agent.lifecycle',
];

// ── argv parsing (dependency-free) ───────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    legacy: false,
    workspace: null,
    types: ALL_EVENT_TYPES,
    out: './events.ndjson',
    interval: 1000,
    annotate: false,
    annotateEvery: 10,
    once: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--legacy': out.legacy = true; break;
      case '--annotate': out.annotate = true; break;
      case '--once': out.once = true; break;
      case '--help': case '-h': out.help = true; break;
      case '--workspace': out.workspace = argv[++i]; break;
      case '--out': out.out = argv[++i]; break;
      case '--interval': out.interval = Math.max(50, Number(argv[++i]) || 1000); break;
      case '--annotate-every': out.annotateEvery = Math.max(1, Number(argv[++i]) || 10); break;
      case '--types': {
        const raw = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        const valid = raw.filter((t) => ALL_EVENT_TYPES.includes(t));
        if (valid.length) out.types = valid;
        break;
      }
      default:
        log(`ignoring unknown arg: ${a}`);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`wmux event-recorder — reference plugin (v${VERSION})

Usage: node recorder.mjs [options]

  --legacy               DEPRECATED (#1111): skip mcp.identify/declarePermissions
                         and send no clientName. The substrate grandfathers
                         envelope-less callers (PROTOCOL.md §4), so this is the
                         fastest way to see events with no approval dialog —
                         but that lane closes in the first release on or after
                         2026-09-30, after which the request is refused. The
                         npm smoke script no longer uses it.
  --workspace <id>       Watch a specific workspace id (default: first from
                         workspace.list).
  --types a,b,c          Comma-separated WmuxEventType filter. Default: all 8.
                         (${ALL_EVENT_TYPES.join(', ')})
  --out <path>           NDJSON output file (default: ./events.ndjson).
  --interval <ms>        Poll interval (default: 1000; min 50). The floor keeps
                         the loop — polls plus annotate writes — well under the
                         50 rpc/s per-socket cap.
  --annotate             Write a shared label + custom.event-recorder.{lastSeq,
                         count} onto the watched pane via optimistic concurrency
                         (PROTOCOL.md §1). The label shows in the pane header.
  --annotate-every <n>   Annotate once per n recorded events (default: 10).
  --once                 Single poll then exit (smoke test).
  --help, -h             This text.
`);
}

// ── logging ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}
function log(msg) {
  process.stderr.write(`[recorder ${ts()}] ${msg}\n`);
}

// ── identity handshake (mcp-plugin-spec §4.1, §4.2) ──────────────────────────

async function declareIdentity(client) {
  // 4.1 First contact. Returns a PluginIdentityRecord (creates an
  // 'unconfirmed' entry on first sight). mcp.identify is bootstrap-exempt
  // (capability: null in methodCapabilityMap), so it is never gated.
  const idResult = await client.rpc('mcp.identify', { name: CLIENT_NAME, version: VERSION });
  const identity = idResult?.identity ?? idResult;
  log(`mcp.identify → status=${identity?.status} name=${identity?.name}`);

  // 4.2 Declare the capability set. Result is a discriminated union:
  //   { ok:true, identity, accepted }   ← every entry parsed + persisted
  //   { ok:false, errors:[{index,permission,reason}] }  ← grammar rejection
  // declarePermissions is also bootstrap-exempt.
  const declare = await client.rpc('mcp.declarePermissions', {
    permissions: DECLARED_PERMISSIONS,
    rationale: DECLARE_RATIONALE,
  });
  if (declare?.ok === false) {
    log('mcp.declarePermissions REJECTED — fix the grammar before retrying:');
    for (const e of declare.errors ?? []) {
      log(`  [${e.index}] ${JSON.stringify(e.permission)} → ${e.reason}`);
    }
    throw new Error('permission declaration rejected by grammar');
  }
  log(`mcp.declarePermissions accepted: [${(declare?.accepted ?? []).join(', ')}]`);
  return declare?.identity ?? identity;
}

// ── approval-retry idiom (mcp-plugin-spec §4.4, RpcRouter enforce mode) ───────
//
// In enforce mode (production default), an unconfirmed plugin that declared
// capabilities is REJECTED on its first gated RPC with:
//   rejection.reason === 'identity-status', status 'unconfirmed',
//   rejection.pendingApproval.promptId
// and wmux pops an approval dialog. We retry the same RPC on a backoff until
// the user approves (status flips to trusted → call succeeds) or denies
// (rejection.status === 'denied' → we stop). In --legacy mode this branch is
// never taken because envelope-less calls are grandfathered.

async function withApprovalRetry(client, fn, label) {
  const BACKOFF_MS = 2000;
  let announced = false;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const rej = err instanceof WmuxRpcError ? err.rejection : undefined;
      if (rej && rej.reason === 'identity-status') {
        if (rej.status === 'denied') {
          log(`${label}: plugin DENIED by user — stopping. Edit ~/.wmux/plugin-trust.json to restore.`);
          throw err;
        }
        const promptId = rej.pendingApproval?.promptId;
        if (!announced) {
          log(`${label}: waiting for approval in the wmux UI (promptId=${promptId ?? 'n/a'})`);
          announced = true;
        }
        await sleep(BACKOFF_MS);
        continue;
      }
      throw err; // unrelated failure — propagate
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asArray(workspaceListResult) {
  // workspace.list returns a bare array of { id, name, metadata, ... }
  // (src/renderer/hooks/useRpcBridge.ts). Tolerate a { workspaces:[...] }
  // wrapper too, matching the defensive pattern in the dynamic scripts.
  if (Array.isArray(workspaceListResult)) return workspaceListResult;
  if (Array.isArray(workspaceListResult?.workspaces)) return workspaceListResult.workspaces;
  return [];
}

function prettyEvent(ev) {
  // One-line console summary; the full object is what lands in the NDJSON file.
  const base = `seq=${ev.seq} ${ev.type} ws=${ev.workspaceId}`;
  switch (ev.type) {
    case 'pane.created':
    case 'pane.closed':
    case 'pane.focused':
      return `${base} pane=${ev.paneId}`;
    case 'pane.metadata.changed':
      return `${base} pane=${ev.paneId} version=${ev.version ?? '-'} label=${ev.metadata?.label ?? '-'}`;
    case 'workspace.metadata.changed':
      return `${base} patch=${Object.keys(ev.patch ?? {}).join(',')}`;
    case 'process.started':
      return `${base} pty=${ev.ptyId} pid=${ev.pid ?? '-'} shell=${ev.shell}`;
    case 'process.exited':
      return `${base} pty=${ev.ptyId} exit=${ev.exitCode}`;
    case 'agent.lifecycle':
      // Carries ptyId (NOT paneId), kind, source, agent, decision.
      return `${base} pty=${ev.ptyId} kind=${ev.kind} source=${ev.source} agent=${ev.agent} decision=${ev.decision}`;
    default:
      return base;
  }
}

// ── metadata writeback (PROTOCOL.md §1.3 optimistic concurrency) ─────────────
//
// Read the current version via pane.getMetadata, then pane.setMetadata with
// expectedVersion. If another writer raced us the server replies with an error
// whose string contains "VERSION_CONFLICT" (the {ok:false,error} envelope —
// matched exactly as scripts/m0-dynamic-verify.mjs does); we re-read and retry
// once. We write a `label` (the shared display field — last-writer-wins, shows
// in the pane header) AND our own namespaced custom.event-recorder.* keys.
// mergeMode:'merge' patches exactly these paths and leaves every other field
// (and other plugins' custom subtrees) intact.

async function annotatePane(client, workspaceId, paneId, lastSeq, count) {
  const writeLabel = `event-recorder: ${count}`;
  const writeCustom = {
    'event-recorder.lastSeq': String(lastSeq),
    'event-recorder.count': String(count),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await client.rpc('pane.getMetadata', { paneId, workspaceId });
    const expectedVersion = current?.version ?? 0;
    try {
      const res = await withApprovalRetry(
        client,
        () => client.rpc('pane.setMetadata', {
          paneId,
          workspaceId,
          label: writeLabel,
          custom: writeCustom,
          mergeMode: 'merge',
          expectedVersion,
        }),
        'pane.setMetadata',
      );
      return res?.version;
    } catch (err) {
      if (/VERSION_CONFLICT|currentVersion/i.test(err.message) && attempt === 0) {
        log('annotate: VERSION_CONFLICT — re-reading version and retrying once');
        continue;
      }
      throw err;
    }
  }
}

// ── main flow ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  log(`endpoint = ${endpoint()}`);
  log(`mode = ${args.legacy ? 'legacy (grandfathered)' : 'identity + declare + approve'}`);
  log(`types = ${args.types.join(',')}`);
  log(`out = ${args.out}`);

  // (a) Resolve token + endpoint, connect. In legacy mode we send no
  //     clientName so the substrate treats us as a grandfathered caller.
  const client = new WmuxClient({
    clientName: args.legacy ? undefined : CLIENT_NAME,
    clientVersion: args.legacy ? undefined : VERSION,
    onLog: (m) => log(m),
  });
  await client.connect();
  log('connected.');

  // (b) Identity + permission declaration (skipped in legacy mode).
  if (!args.legacy) {
    await declareIdentity(client);
  }

  // (c) Pick the target workspace. workspace.read gates workspace.list, so in
  //     enforce mode this is the first call that can trigger the approval
  //     handshake — wrap it in the retry idiom.
  const wsResult = await withApprovalRetry(
    client,
    () => client.rpc('workspace.list', {}),
    'workspace.list',
  );
  const workspaces = asArray(wsResult);
  if (workspaces.length === 0) {
    log('no workspaces found — is wmux running with at least one workspace?');
    client.close();
    return 1;
  }
  let target = args.workspace
    ? workspaces.find((w) => (w.id || w.workspaceId) === args.workspace)
    : workspaces[0];
  if (!target) {
    log(`workspace "${args.workspace}" not found. Available: ${workspaces.map((w) => w.id || w.workspaceId).join(', ')}`);
    client.close();
    return 1;
  }
  const workspaceId = target.id || target.workspaceId;
  log(`watching workspace: ${workspaceId} (${target.name ?? 'unnamed'})`);

  // Open the NDJSON sink (append). One JSON object per line.
  const outStream = fs.createWriteStream(args.out, { flags: 'a' });

  // ── reconciliation state (PROTOCOL.md §2.4, §2.5) ──────────────────────────
  let bootId = null;            // last-known EventBus bootId; mismatch ⇒ restart
  let cursor = 0;               // OPAQUE cursor; 0 = replay from oldest in ring
  let recorded = 0;             // total events written
  let watchedPaneId = null;     // first pane we see, used as the annotate target

  // (g) Clean shutdown — flush file, close socket. Hoisted (function
  // declaration) so the stream error handler below can call it.
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    log(`shutting down — recorded ${recorded} events to ${args.out}`);
    try { outStream.end(); } catch { /* ignore */ }
    client.close();
    // Give the stream a tick to flush before exit.
    setTimeout(() => process.exit(0), 100);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Without a listener, a bad --out path / EACCES / disk-full raises an
  // unhandled 'error' event and crashes mid-recording with a raw stack.
  outStream.on('error', (err) => {
    log(`output stream error on ${args.out}: ${err.message} — stopping`);
    shutdown();
  });

  // Single write path: guarded so an in-flight poll that resolves during
  // shutdown can't write after end.
  function writeEvent(ev) {
    if (stopping || outStream.writableEnded || outStream.destroyed) return;
    outStream.write(JSON.stringify(ev) + '\n');
    recorded++;
    log(prettyEvent(ev));
  }

  // pane.list is the snapshot primitive. We call it on start (to seed bootId +
  // the watched pane) and again after a resync/restart to re-hydrate.
  //
  // `reAnchorCursor` distinguishes the cases (PROTOCOL.md §2.5):
  //   - initial connect / resync: keep the cursor where it is. On connect,
  //     cursor 0 makes the first events.poll REPLAY the ring backlog; on
  //     resync, nextCursor already points past the page the resync reply
  //     delivered, and re-anchoring to asOfSeq would skip the rest of the
  //     still-available ring.
  //   - bootId change (daemon restart): the old seq space is gone — re-anchor
  //     cursor to asOfSeq, the watermark this fresh snapshot already
  //     reflects, so we resume cleanly in the new boot's seq space.
  async function hydrate(reason, reAnchorCursor) {
    const snap = await withApprovalRetry(
      client,
      () => client.rpc('pane.list', { workspaceId }),
      'pane.list',
    );
    bootId = snap?.bootId ?? bootId;
    if (reAnchorCursor && typeof snap?.asOfSeq === 'number') cursor = snap.asOfSeq;
    const panes = snap?.panes ?? snap?.leaves ?? [];
    const firstLeaf = panes.find((p) => (p.id || p.paneId));
    if (firstLeaf) watchedPaneId = firstLeaf.id || firstLeaf.paneId;
    log(`pane.list (${reason}): bootId=${shortId(bootId)} asOfSeq=${snap?.asOfSeq} cursor=${cursor} panes=${panes.length} watchedPane=${watchedPaneId ?? '-'}`);
  }

  await hydrate('initial', false);

  // One poll iteration. Returns:
  //   false        — terminal (user denied the plugin); stop the loop.
  //   'reconcile'  — this iteration was a recovery hop (transport error,
  //                  daemon restart, or resync), not a clean data poll.
  //   true         — a clean data poll (zero or more events delivered).
  async function pollOnce() {
    let poll;
    try {
      poll = await withApprovalRetry(
        client,
        () => client.rpc('events.poll', { workspaceId, cursor, types: args.types }),
        'events.poll',
      );
    } catch (err) {
      // 'denied' from the retry idiom is terminal.
      if (err instanceof WmuxRpcError && err.rejection?.reason === 'identity-status' && err.rejection.status === 'denied') {
        return false;
      }
      // Transient failure: rpc timeout, a rate-limit reply, or a dropped
      // socket. Do NOT re-anchor the cursor here — re-anchoring skips events
      // still sitting in the ring. Make sure the socket is alive and retry
      // from the SAME cursor: a real daemon restart surfaces as a bootId
      // change and a genuinely stale cursor surfaces as resync:true, both
      // handled below on the next successful poll.
      log(`events.poll failed: ${err.message} — retrying from the same cursor`);
      await sleep(args.interval);
      try { await client.connect(); } catch (e) { log(`reconnect failed: ${e.message}`); }
      return 'reconcile';
    }

    // bootId mismatch ⇒ daemon restarted under us (PROTOCOL.md §2.4). The old
    // seq space is gone: drop ALL cached cursor/pane state and re-anchor from
    // a fresh snapshot.
    if (bootId && poll.bootId && poll.bootId !== bootId) {
      log(`bootId changed (${shortId(bootId)} → ${shortId(poll.bootId)}) — daemon restarted; re-hydrating`);
      await hydrate('boot-change', true);
      return 'reconcile';
    }
    if (!bootId) bootId = poll.bootId;

    // resync ⇒ our cursor drifted past the ring window (or is in the future).
    // The reply still DELIVERS the oldest surviving page (the bus re-anchors
    // its effective cursor to the oldest ring entry — PROTOCOL.md §2.5), so
    // record it first: only the `droppedCount` events that already fell out
    // of the ring are actually lost. Then continue from nextCursor — it
    // points past the delivered page, and subsequent polls drain the rest of
    // the ring. Re-hydrate the snapshot (the watched pane may be gone) but do
    // NOT re-anchor the cursor to asOfSeq: that would skip the still-
    // available remainder. (A state-cache consumer that rebuilds from the
    // snapshot instead would re-anchor here — see
    // docs/how-to/handle-daemon-restart.md.)
    if (poll.resync) {
      const survived = poll.events ?? [];
      for (const ev of survived) writeEvent(ev);
      cursor = poll.nextCursor;
      log(`resync: true${poll.droppedCount ? ` droppedCount=${poll.droppedCount}` : ''} — recorded ${survived.length} surviving events; refreshing snapshot via pane.list`);
      await hydrate('resync', false);
      return 'reconcile';
    }

    // Append + pretty-log each delivered event.
    for (const ev of poll.events ?? []) {
      writeEvent(ev);
    }

    // Advance the OPAQUE cursor — pass nextCursor back verbatim next time.
    cursor = poll.nextCursor;

    // (f) Optional metadata writeback.
    if (args.annotate && watchedPaneId && recorded > 0 && recorded % args.annotateEvery === 0) {
      try {
        const v = await annotatePane(client, workspaceId, watchedPaneId, cursor, recorded);
        log(`annotated pane ${watchedPaneId}: label="event-recorder: ${recorded}" + custom.event-recorder.{lastSeq=${cursor},count=${recorded}} (version=${v})`);
      } catch (err) {
        log(`annotate failed: ${err.message}`);
      }
    }
    return true;
  }

  if (args.once) {
    // A single user-visible poll. But the first poll from cursor 0 against a
    // long-running wmux may come back as a recovery hop (resync because the
    // ring already wrapped past seq 0, or a transient transport error) — so
    // allow a few bounded reconciliation hops before the clean data poll
    // lands. Each hop is one RPC round-trip, nowhere near the 50 rpc/s cap.
    for (let i = 0; i < 4; i++) {
      const r = await pollOnce();
      if (r !== 'reconcile') break; // terminal (false) or a clean data poll
    }
    log(`--once: recorded ${recorded} events to ${args.out}`);
    outStream.end();
    client.close();
    return 0;
  }

  // (d) Steady-state poll loop. Sleeps `interval` between polls so we never
  //     approach the 50 rpc/s per-socket cap.
  log(`polling every ${args.interval}ms (Ctrl+C to stop)`);
  while (!stopping) {
    const keepGoing = await pollOnce();
    if (keepGoing === false) break;
    await sleep(args.interval);
  }
  shutdown();
  return 0;
}

function shortId(id) {
  return id ? String(id).slice(0, 8) + '…' : '-';
}

main().then(
  (code) => { if (typeof code === 'number' && code !== 0) process.exitCode = code; },
  (err) => { log(`FATAL: ${err.stack || err.message}`); process.exitCode = 1; },
);
