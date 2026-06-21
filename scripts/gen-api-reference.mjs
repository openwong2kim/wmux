#!/usr/bin/env node
/**
 * gen-api-reference.mjs — regenerate docs/api/reference.md from the wmux
 * sources of truth so the RPC-method, event-type, and capability tables can
 * never silently drift from the code.
 *
 * Sources parsed (all relative to repo root):
 *   - src/shared/rpc.ts                  → ALL_RPC_METHODS (the method list)
 *   - src/shared/events.ts               → WMUX_EVENT_TYPES, RING_CAPACITY,
 *                                          POLL_DEFAULT_MAX
 *   - src/main/mcp/methodCapabilityMap.ts → per-method { capability, riskClass }
 *   - package.json                       → version (for the generated-on line)
 *
 * This is a deliberately dependency-free regex/line scanner, NOT a TypeScript
 * compiler. It is brittle by design: if a source file is reshaped in a way the
 * scanner can't follow, it throws with a clear message rather than emitting a
 * half-baked reference. The fix is then either to adapt the source back to the
 * documented shape or to update this script — never to ship a stale doc.
 *
 * Usage:
 *   node scripts/gen-api-reference.mjs            # write docs/api/reference.md
 *   node scripts/gen-api-reference.mjs --help
 *   node scripts/gen-api-reference.mjs --check    # exit 1 if the file is stale
 *   node scripts/gen-api-reference.mjs --stdout   # print to stdout, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs Node >= 20.11; package.json engines allows >= 18.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const SRC = {
  rpc: path.join(REPO_ROOT, 'src', 'shared', 'rpc.ts'),
  events: path.join(REPO_ROOT, 'src', 'shared', 'events.ts'),
  capMap: path.join(REPO_ROOT, 'src', 'main', 'mcp', 'methodCapabilityMap.ts'),
  pipeServer: path.join(REPO_ROOT, 'src', 'main', 'pipe', 'PipeServer.ts'),
  pkg: path.join(REPO_ROOT, 'package.json'),
};
const OUT = path.join(REPO_ROOT, 'docs', 'api', 'reference.md');

const CAPABILITY_RESOLVER_DOC = new Map([
  ['capabilityFromA2aTaskSend', 'a2a.send / a2a.execute (execute:true)'],
]);

const HELP = `gen-api-reference.mjs — regenerate docs/api/reference.md from source.

Reads the canonical RPC method list, event types, ring constants, and the
per-method capability map, then writes a machine-generated Markdown reference.

Usage:
  node scripts/gen-api-reference.mjs            Write docs/api/reference.md
  node scripts/gen-api-reference.mjs --stdout   Print to stdout; write nothing
  node scripts/gen-api-reference.mjs --check     Exit 1 if reference.md is stale
  node scripts/gen-api-reference.mjs --help      Show this help

The output is deterministic given the same sources (the generated-on line is
derived from package.json version, not a wall-clock timestamp), so --check is
safe to run in CI to assert the doc was regenerated after a surface change.`;

function die(msg) {
  console.error(`gen-api-reference: ${msg}`);
  process.exit(1);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`cannot read ${path.relative(REPO_ROOT, file)}: ${err.message}`);
  }
}

/**
 * Extract a `const NAME = [ ... ] as const` (or `: readonly T[] = [ ... ]`)
 * string-literal array. Returns the ordered list of single-quoted entries.
 * Throws if the opening/closing markers can't be found or the array is empty.
 */
function parseConstStringArray(source, constName, file) {
  // Match `export const NAME` up to the first `[` after an `=`.
  const declRe = new RegExp(
    `export\\s+const\\s+${constName}\\b[^=]*=\\s*\\[`,
    'm',
  );
  const m = declRe.exec(source);
  if (!m) {
    die(`could not find \`export const ${constName} = [\` in ${path.relative(REPO_ROOT, file)} — source shape changed; update the scanner.`);
  }
  const start = m.index + m[0].length;
  // Find the matching close. These arrays are flat (no nested brackets), so
  // the first `]` after start closes them. Guard anyway.
  const end = source.indexOf(']', start);
  if (end === -1) {
    die(`unterminated array for ${constName} in ${path.relative(REPO_ROOT, file)}`);
  }
  const body = source.slice(start, end);
  if (body.includes('[')) {
    die(`unexpected nested '[' inside ${constName} array in ${path.relative(REPO_ROOT, file)} — scanner only handles flat string arrays.`);
  }
  const entries = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (entries.length === 0) {
    die(`parsed zero entries for ${constName} in ${path.relative(REPO_ROOT, file)} — refusing to emit an empty table.`);
  }
  return entries;
}

/** Extract a numeric `export const NAME = <number>;` constant. */
function parseNumberConst(source, constName, file) {
  const re = new RegExp(`export\\s+const\\s+${constName}\\s*=\\s*(\\d+)`, 'm');
  const m = re.exec(source);
  if (!m) {
    die(`could not find numeric \`export const ${constName}\` in ${path.relative(REPO_ROOT, file)}`);
  }
  return Number(m[1]);
}

/**
 * Extract the PipeServer transport caps so the constants table can't drift.
 * These aren't exported: three are `private static readonly NAME = <n>`, the
 * line buffer is a module-level `const MAX_LINE_BUFFER = <a> * <b>`, and the
 * per-socket RPC cap is a bare literal in the rate-limit branch
 * (`if (limit.count > <n>)`). Each one dies loudly if the shape changes.
 */
function parsePipeServerCaps(source, file) {
  const rel = path.relative(REPO_ROOT, file);
  const staticNum = (name) => {
    const m = new RegExp(
      `private\\s+static\\s+readonly\\s+${name}\\s*=\\s*(\\d+)`,
      'm',
    ).exec(source);
    if (!m) die(`could not find \`private static readonly ${name}\` in ${rel} — update the scanner or the table.`);
    return Number(m[1]);
  };
  const bufM = /const\s+MAX_LINE_BUFFER\s*=\s*(\d+)\s*\*\s*(\d+)/m.exec(source);
  if (!bufM) die(`could not find \`const MAX_LINE_BUFFER = <a> * <b>\` in ${rel} — update the scanner or the table.`);
  const perSocketM = /if\s*\(\s*limit\.count\s*>\s*(\d+)\s*\)/m.exec(source);
  if (!perSocketM) die(`could not find the per-socket \`limit.count > <n>\` cap in ${rel} — update the scanner or the table.`);
  return {
    maxConnections: staticNum('MAX_CONNECTIONS'),
    globalRateLimit: staticNum('GLOBAL_RATE_LIMIT'),
    maxNewConnectionsPerSec: staticNum('MAX_NEW_CONNECTIONS_PER_SEC'),
    maxLineBuffer: Number(bufM[1]) * Number(bufM[2]),
    perSocketRateLimit: Number(perSocketM[1]),
  };
}

/**
 * Parse the METHOD_CAPABILITY record. Each entry looks like:
 *   'pane.list':   { capability: 'pane.read', riskClass: 'pane-lifecycle' },
 *   'mcp.identify': { capability: null },
 *   'pane.setMetadata': {
 *     capability: 'meta.write',
 *     pathFromParams: pathsFromSetMetadata,
 *     riskClass: 'metadata',
 *     multiPathMode: 'all-or-nothing',
 *   },
 * Returns a Map<method, { capability: string|null, riskClass: string|null }>.
 * The scanner tolerates the entry body spanning multiple lines: it keys off
 * the `'method':` literal that opens each entry and reads the following object
 * literal up to its matching brace.
 */
function parseCapabilityMap(source, file) {
  const startRe = /export\s+const\s+METHOD_CAPABILITY\s*:[^=]*=\s*\{/m;
  const sm = startRe.exec(source);
  if (!sm) {
    die(`could not find \`export const METHOD_CAPABILITY = {\` in ${path.relative(REPO_ROOT, file)} — source shape changed; update the scanner.`);
  }
  const objStart = sm.index + sm[0].length;
  // Walk braces to find the record's closing brace.
  let depth = 1;
  let i = objStart;
  for (; i < source.length && depth > 0; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) {
    die(`unterminated METHOD_CAPABILITY record in ${path.relative(REPO_ROOT, file)}`);
  }
  const body = source.slice(objStart, i - 1);

  const map = new Map();
  // Match each entry: a quoted key, a colon, then a { ... } object literal.
  // The object literals here contain no nested braces, so a non-greedy match
  // to the next standalone `}` is sufficient and safe.
  const entryRe = /'([^']+)'\s*:\s*\{([^{}]*)\}/g;
  let em;
  while ((em = entryRe.exec(body)) !== null) {
    const method = em[1];
    const entryBody = em[2];
    const capM = /capability\s*:\s*(null|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/.exec(entryBody);
    let capability;
    if (!capM) {
      die(`METHOD_CAPABILITY entry for '${method}' has no \`capability\` field in ${path.relative(REPO_ROOT, file)}`);
    }
    if (capM[1] === 'null') {
      capability = null;
    } else if (capM[2] !== undefined) {
      capability = capM[2];
    } else {
      capability = CAPABILITY_RESOLVER_DOC.get(capM[3]);
      if (!capability) {
        die(`METHOD_CAPABILITY entry for '${method}' uses unsupported capability resolver \`${capM[3]}\` in ${path.relative(REPO_ROOT, file)}`);
      }
    }
    const riskM = /riskClass\s*:\s*'([^']*)'/.exec(entryBody);
    const riskClass = riskM ? riskM[1] : null;
    map.set(method, { capability, riskClass });
  }
  if (map.size === 0) {
    die(`parsed zero entries from METHOD_CAPABILITY in ${path.relative(REPO_ROOT, file)} — refusing to emit an empty table.`);
  }
  return map;
}

// === Grouping ===

// Ordered prefix groups for readability. Methods are matched against the
// longest prefix first (so 'company.a2a.*' wins over 'company.*'). Any method
// that matches no prefix lands in the "other" bucket and is still emitted.
const GROUP_ORDER = [
  { key: 'workspace.', title: 'workspace' },
  { key: 'surface.', title: 'surface' },
  { key: 'pane.', title: 'pane' },
  { key: 'events.', title: 'events' },
  { key: 'input.', title: 'input' },
  { key: 'terminal.', title: 'terminal' },
  { key: 'meta.', title: 'meta' },
  { key: 'mcp.', title: 'mcp' },
  { key: 'system.', title: 'system' },
  { key: 'notify', title: 'notify' },
  { key: 'browser.', title: 'browser' },
  { key: 'a2a.', title: 'a2a' },
  { key: 'company.a2a.', title: 'company.a2a' },
  { key: 'company.', title: 'company' },
  { key: 'lanlink.', title: 'lanlink' },
  { key: 'daemon.', title: 'daemon' },
  { key: 'hooks.', title: 'hooks' },
];

function groupFor(method) {
  let best = null;
  for (const g of GROUP_ORDER) {
    if (method === g.key || method.startsWith(g.key)) {
      if (!best || g.key.length > best.key.length) best = g;
    }
  }
  return best ? best.title : 'other';
}

function mdEscape(s) {
  // Escape pipe so a value never breaks a Markdown table cell.
  return String(s).replace(/\|/g, '\\|');
}

function buildMarkdown() {
  const rpcSrc = read(SRC.rpc);
  const evSrc = read(SRC.events);
  const capSrc = read(SRC.capMap);
  const pipeSrc = read(SRC.pipeServer);
  const pkg = JSON.parse(read(SRC.pkg));

  const methods = parseConstStringArray(rpcSrc, 'ALL_RPC_METHODS', SRC.rpc);
  const eventTypes = parseConstStringArray(evSrc, 'WMUX_EVENT_TYPES', SRC.events);
  const ringCapacity = parseNumberConst(evSrc, 'RING_CAPACITY', SRC.events);
  const pollDefaultMax = parseNumberConst(evSrc, 'POLL_DEFAULT_MAX', SRC.events);
  const capMap = parseCapabilityMap(capSrc, SRC.capMap);
  const caps = parsePipeServerCaps(pipeSrc, SRC.pipeServer);

  // Sanity cross-check: every method in ALL_RPC_METHODS must appear in the
  // capability map and vice versa. Record<RpcMethod, ...> totality is a tsc
  // invariant, but a partial regex parse (e.g. an entry body the scanner can't
  // follow) would otherwise ship a half-baked table — fail loudly instead.
  const missingCap = methods.filter((m) => !capMap.has(m));
  if (missingCap.length > 0) {
    die(`METHOD_CAPABILITY parse is missing ${missingCap.length} method(s) from ALL_RPC_METHODS — scanner can't follow the entry shape; update the scanner:\n  ${missingCap.join('\n  ')}`);
  }
  const methodSet = new Set(methods);
  const unknownCap = [...capMap.keys()].filter((m) => !methodSet.has(m));
  if (unknownCap.length > 0) {
    die(`METHOD_CAPABILITY has ${unknownCap.length} entr(y/ies) not in ALL_RPC_METHODS:\n  ${unknownCap.join('\n  ')}`);
  }

  const lines = [];
  const p = (s = '') => lines.push(s);

  p('<!--');
  p('  GENERATED by scripts/gen-api-reference.mjs — do not edit by hand.');
  p('  Run `node scripts/gen-api-reference.mjs` to regenerate after changing');
  p('  src/shared/rpc.ts, src/shared/events.ts, or');
  p('  src/main/mcp/methodCapabilityMap.ts.');
  p('-->');
  p('');
  p('# wmux API Reference (generated)');
  p('');
  p(`> **Generated from wmux v${pkg.version} sources.** This file is produced by`);
  p('> `scripts/gen-api-reference.mjs` directly from the code — it lists every');
  p('> RPC method, event type, required capability, and the key event-bus');
  p('> constants exactly as the running daemon sees them. For the hand-curated');
  p('> stability tiers, prose, and MCP-tool mapping, see');
  p('> [`inventory.md`](./inventory.md); for the wire contract, see');
  p('> [`../PROTOCOL.md`](../PROTOCOL.md).');
  p('');
  p('Transport (see `src/shared/constants.ts`): JSON-RPC over a Named Pipe at');
  p('`\\\\.\\pipe\\wmux-<username>` (Windows) or a Unix domain socket at');
  p('`~/.wmux.sock` (POSIX). The first request on each connection carries the');
  p('UUID token from `~/.wmux-auth-token` in its `token` field. On Windows, a');
  p('loopback TCP fallback (port in `~/.wmux-tcp-port`) is used when the pipe');
  p('returns `EPERM`. Wire framing: newline-delimited JSON, one object per line.');
  p('');
  p('---');
  p('');

  // === RPC methods ===
  p('## RPC methods');
  p('');
  p(`Total: **${methods.length}** methods (\`ALL_RPC_METHODS\` in`);
  p('`src/shared/rpc.ts`). Capability and risk class are read from');
  p('`src/main/mcp/methodCapabilityMap.ts`:');
  p('');
  p('- `capability` is the `wmuxPermissions` capability the method requires.');
  p('  `null` = bootstrap/introspection (any caller, no declaration needed).');
  p('  `wmux.internal` = reserved prefix no plugin can declare (internal-only;');
  p('  legacy envelope-less callers grandfather through).');
  p('- `riskClass` drives the approval-dialog wording; blank for `null` and');
  p('  `wmux.internal` methods.');
  p('');

  // Group methods, preserving ALL_RPC_METHODS order within each group.
  const grouped = new Map();
  for (const method of methods) {
    const g = groupFor(method);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(method);
  }
  // Emit groups in GROUP_ORDER, then "other".
  const emittedOrder = [...GROUP_ORDER.map((g) => g.title), 'other'];
  const seen = new Set();
  for (const title of emittedOrder) {
    if (seen.has(title)) continue;
    seen.add(title);
    const groupMethods = grouped.get(title);
    if (!groupMethods || groupMethods.length === 0) continue;
    p(`### \`${title}\``);
    p('');
    p('| Method | Capability | Risk class |');
    p('|---|---|---|');
    for (const method of groupMethods) {
      // Totality asserted above — every method has an entry.
      const entry = capMap.get(method);
      const cap = entry.capability === null ? '`null`' : `\`${entry.capability}\``;
      const risk = entry.riskClass ? `\`${entry.riskClass}\`` : '';
      p(`| \`${mdEscape(method)}\` | ${cap} | ${risk} |`);
    }
    p('');
  }

  p('---');
  p('');

  // === Event types ===
  p('## Event types');
  p('');
  p(`The EventBus exposes **${eventTypes.length}** event types`);
  p('(`WMUX_EVENT_TYPES` in `src/shared/events.ts`), polled via `events.poll`.');
  p('Wire shapes (the fields beyond the common `seq` / `ts` / `workspaceId` /');
  p('`type`) are documented in [`inventory.md`](./inventory.md#event-types) and');
  p('typed in `src/shared/events.ts`.');
  p('');
  p('| Event type |');
  p('|---|');
  for (const t of eventTypes) {
    p(`| \`${mdEscape(t)}\` |`);
  }
  p('');

  p('---');
  p('');

  // === Constants ===
  p('## Event-bus & transport constants');
  p('');
  p('| Constant | Value | Source |');
  p('|---|---|---|');
  p(`| Event ring capacity (\`RING_CAPACITY\`) | ${ringCapacity} | \`src/shared/events.ts\` |`);
  p(`| Default poll page (\`POLL_DEFAULT_MAX\`) | ${pollDefaultMax} | \`src/shared/events.ts\` |`);
  // The transport caps live in PipeServer (not exported); parsed from the
  // source by parsePipeServerCaps so this table can't drift either.
  p(`| Max concurrent connections (\`MAX_CONNECTIONS\`) | ${caps.maxConnections} | \`src/main/pipe/PipeServer.ts\` (private static) |`);
  p(`| Per-socket RPC rate limit | ${caps.perSocketRateLimit} / s | \`src/main/pipe/PipeServer.ts\` |`);
  p(`| Global RPC rate limit (\`GLOBAL_RATE_LIMIT\`) | ${caps.globalRateLimit} / s | \`src/main/pipe/PipeServer.ts\` (private static) |`);
  p(`| New connections rate limit (\`MAX_NEW_CONNECTIONS_PER_SEC\`) | ${caps.maxNewConnectionsPerSec} / s (pre-auth) | \`src/main/pipe/PipeServer.ts\` (private static) |`);
  p(`| Max line buffer (\`MAX_LINE_BUFFER\`) | ${caps.maxLineBuffer / (1024 * 1024)} MB | \`src/main/pipe/PipeServer.ts\` |`);
  p('');
  p('An unauthenticated request (missing/wrong token on the first line) gets');
  p('the socket destroyed, as does overflowing the line buffer. Exceeding a');
  p('rate limit does **not** drop the connection: the daemon replies');
  p('`{ ok: false, error: "rate limited" }` (per-socket) or');
  p('`{ ok: false, error: "rate limited (global)" }` and keeps the socket');
  p('open — back off and retry, do not reconnect.');
  p('');

  return lines.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const md = buildMarkdown();

  if (args.includes('--stdout')) {
    process.stdout.write(md);
    return;
  }

  if (args.includes('--check')) {
    let current = null;
    try {
      // Normalize CRLF: with core.autocrlf=true the checkout is CRLF while
      // the generator emits LF — a byte-exact compare would always be stale.
      current = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // missing file = stale
    }
    if (current === md) {
      console.log(`gen-api-reference: ${path.relative(REPO_ROOT, OUT)} is up to date.`);
      return;
    }
    console.error(`gen-api-reference: ${path.relative(REPO_ROOT, OUT)} is STALE — run \`node scripts/gen-api-reference.mjs\` to regenerate.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`gen-api-reference: wrote ${path.relative(REPO_ROOT, OUT)} (${md.length} bytes).`);
}

main();
