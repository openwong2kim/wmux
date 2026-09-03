#!/usr/bin/env node
/**
 * Golden-wire probe for the bundled MCP server.
 *
 * This intentionally combines the public MCP Client with a raw stdio frame
 * pass instead of importing wmux internals. It protects the contract a real
 * host sees: handshake metadata, server instructions, tool names, schemas,
 * ordering, profile boundaries, payload budgets, and stdout framing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BUNDLE_PATH = path.join(REPO_ROOT, 'dist', 'mcp-bundle', 'index.js');
const UNBUNDLED_PATH = path.join(REPO_ROOT, 'dist', 'mcp', 'mcp', 'entry.js');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'mcp-protocol-baseline.json');
const REQUEST_TIMEOUT_MS = 20_000;
const RAW_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-03-26',
  '2024-11-05',
];

const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
// `maxListBytes` per profile lives in the baseline file (JSON, so it cannot
// carry this note itself). It is a HOST budget, not a hard protocol limit: a
// tools/list result has to stay small enough that a client's context is not
// dominated by the schema dump before any work starts. Raising it is a
// deliberate act, recorded here so the next raise has to argue with a number
// that already had a reason.
//
//   full: 75000 -> 78000 (browser_replay, PR-C). The full profile measured
//   74,652 bytes with 92 tools, i.e. 348 bytes of headroom — less than a
//   single tool's schema. One more tool could not be added at all without a
//   raise, and a 3 KB cushion buys roughly one more tool after this one
//   before the question has to be re-argued. core (49000) is untouched;
//   browser_replay is full-only.
//   commander: 45000 -> 60000 (orchestrator track, 2026-09). The commander
//   profile measured ~43,000 bytes against 45,000 — under one tool of
//   headroom. The task-ledger / gate / adopt tools (ledger_*, task_*,
//   git_*) add about nine schemas, roughly 7-8 KB, so a 15 KB raise lands
//   them with one more small tool of cushion before this is re-argued.
//   Note the budget now exceeds core (49000): today the subset invariant
//   (commander ⊆ core ⊆ full, below) makes the gap unreachable, on purpose —
//   the brain tools land as commander-ONLY registrations that relax that
//   invariant to "commander ⊆ core ∪ COMMANDER_ONLY_TOOLS", at which point
//   this number is the one that binds.
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Profile → launch argv. The ONLY thing that selects a surface: no env var
// widens or narrows it, so the probe reproduces exactly what a host config
// can express (see src/shared/coreSurface.ts and commanderSurface.ts).
const PROFILE_ARGS = {
  full: [],
  core: ['--core'],
  commander: ['--commander'],
};

function profileArgs(profile) {
  // hasOwn, not truthiness: a baseline key of `constructor` or `toString`
  // would otherwise pass the guard and blow up in the spread below.
  assert.ok(Object.hasOwn(PROFILE_ARGS, profile), `unknown probe profile: ${profile}`);
  return [BUNDLE_PATH, ...PROFILE_ARGS[profile]];
}

function childEnvironment(profile) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  );

  // A developer's ambient token must not affect this deterministic probe.
  // Only commander gets one: core is an optimization profile that claims no
  // role, so injecting a token there would probe a topology that never ships.
  delete env.WMUX_COMMANDER_TOKEN;
  if (profile === 'commander') env.WMUX_COMMANDER_TOKEN = 'wmux-protocol-probe';
  return env;
}

async function readSdkProfile(profile, config) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: profileArgs(profile),
    cwd: REPO_ROOT,
    env: childEnvironment(profile),
    stderr: 'pipe',
  });
  transport.stderr?.resume();

  const client = new Client(
    { name: 'wmux-protocol-probe', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const first = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    const second = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    const firstJson = JSON.stringify(first);
    const secondJson = JSON.stringify(second);
    const names = first.tools.map((tool) => tool.name);
    const uniqueNames = new Set(names);
    const sdkViewBytes = Buffer.byteLength(firstJson, 'utf8');
    const sdkViewSha256 = sha256(firstJson);
    const instructions = client.getInstructions();

    assert.deepEqual(
      client.getServerVersion(),
      { name: 'wmux', version: packageJson.version },
      `${profile}: handshake serverInfo must match package.json`,
    );
    assert.equal(
      typeof instructions,
      'string',
      `${profile}: initialize result must include server instructions`,
    );
    assert.ok(instructions.length > 0, `${profile}: server instructions must not be empty`);
    assert.ok(
      Buffer.byteLength(instructions, 'utf8') <= 2 * 1024,
      `${profile}: server instructions exceed the 2 KiB host budget`,
    );
    assert.equal(
      sha256(instructions),
      config.instructionSha256,
      `${profile}: server instructions changed`,
    );
    assert.equal(first.nextCursor, undefined, `${profile}: tool pagination is not supported yet`);
    assert.equal(
      uniqueNames.size,
      names.length,
      `${profile}: tools/list contains duplicate tool names`,
    );
    assert.deepEqual(names, config.toolNames, `${profile}: tool surface changed`);
    assert.ok(
      sdkViewBytes <= config.maxListBytes,
      `${profile}: SDK tools/list view is ${sdkViewBytes} bytes ` +
        `(budget ${config.maxListBytes})`,
    );
    assert.equal(
      firstJson,
      secondJson,
      `${profile}: repeated tools/list responses are not deterministic`,
    );

    return {
      profile,
      toolCount: names.length,
      sdkViewBytes,
      sdkViewSha256,
      instructionSha256: sha256(instructions),
      instructionBytes: Buffer.byteLength(instructions, 'utf8'),
      names,
    };
  } finally {
    await client.close();
  }
}

async function readHandshake(entryPath, label, config) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    cwd: REPO_ROOT,
    env: childEnvironment('full'),
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client(
    { name: 'wmux-layout-probe', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    assert.deepEqual(
      client.getServerVersion(),
      { name: 'wmux', version: packageJson.version },
      `${label}: handshake serverInfo must match package.json`,
    );
    assert.equal(
      sha256(client.getInstructions() ?? ''),
      config.instructionSha256,
      `${label}: server instructions changed`,
    );
  } finally {
    await client.close();
  }
}

function extractRawResult(line, id) {
  // The SDK's stdio transport writes this stable JSON-RPC envelope. Extract
  // only the result value so sequential requests with different IDs can be
  // compared byte-for-byte without parsing and re-serializing tool fields.
  const prefix = '{"result":';
  const suffix = `,"jsonrpc":"2.0","id":${id}}`;
  assert.ok(line.startsWith(prefix), `unexpected tools/list response prefix`);
  assert.ok(line.endsWith(suffix), `unexpected tools/list response suffix`);
  return line.slice(prefix.length, -suffix.length);
}

function writeFrame(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function readRawProfile(profile, config, protocolVersion) {
  const label = `${profile}/${protocolVersion}`;

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      profileArgs(profile),
      {
        cwd: REPO_ROOT,
        env: childEnvironment(profile),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdoutBuffer = '';
    let stderr = '';
    let initialized;
    let firstResult;
    let firstResultRaw;
    let secondResultRaw;
    let frameCount = 0;
    let settled = false;
    let timeout;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      reject(error);
    };

    const handleLine = (line) => {
      if (settled) return;
      if (line.length === 0) {
        fail(new Error(`${label}: blank non-protocol frame appeared on MCP stdout`));
        return;
      }
      frameCount += 1;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(new Error(
          `${label}: non-JSON data appeared on MCP stdout: ${line.slice(0, 120)}`,
          { cause: error },
        ));
        return;
      }

      try {
        if (message.id === 1) {
          initialized = message.result;
          writeFrame(child, {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          });
          writeFrame(child, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          });
        } else if (message.id === 2) {
          firstResult = message.result;
          firstResultRaw = extractRawResult(line, 2);
          writeFrame(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list',
          });
        } else if (message.id === 3) {
          secondResultRaw = extractRawResult(line, 3);
          child.stdin.end();
        } else {
          throw new Error(`${label}: unexpected JSON-RPC response id ${message.id}`);
        }
      } catch (error) {
        fail(error);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;

      try {
        assert.equal(
          stdoutBuffer,
          '',
          `${label}: MCP stdout ended with an incomplete or unframed value`,
        );
        assert.equal(
          code,
          0,
          `${label}: raw MCP child exited ${code}; stderr: ${stderr.trim()}`,
        );
        assert.equal(frameCount, 3, `${label}: expected exactly three response frames`);
        assert.deepEqual(
          initialized?.serverInfo,
          { name: 'wmux', version: packageJson.version },
          `${label}: raw initialize serverInfo must match package.json`,
        );
        assert.equal(
          initialized?.protocolVersion,
          protocolVersion,
          `${label}: raw probe must negotiate the requested protocol`,
        );
        assert.equal(
          sha256(initialized?.instructions ?? ''),
          config.instructionSha256,
          `${label}: raw server instructions changed`,
        );
        assert.equal(
          firstResultRaw,
          secondResultRaw,
          `${label}: raw tools/list result values are not byte-identical`,
        );

        const names = firstResult.tools.map((tool) => tool.name);
        assert.deepEqual(names, config.toolNames, `${label}: raw tool surface changed`);
        const wireResultBytes = Buffer.byteLength(firstResultRaw, 'utf8');
        const wireResultSha256 = sha256(firstResultRaw);
        assert.ok(
          wireResultBytes <= config.maxListBytes,
          `${label}: raw tools/list result is ${wireResultBytes} bytes ` +
            `(budget ${config.maxListBytes})`,
        );
        assert.equal(
          wireResultSha256,
          config.wireResultSha256,
          `${label}: raw tool schemas, descriptions, or ordering changed`,
        );

        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ wireResultBytes, wireResultSha256 });
      } catch (error) {
        fail(error);
      }
    });

    timeout = setTimeout(() => {
      fail(new Error(
        `${label}: raw MCP probe timed out; stderr: ${stderr.trim()}`,
      ));
    }, REQUEST_TIMEOUT_MS);

    writeFrame(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'wmux-raw-protocol-probe', version: '1.0.0' },
      },
    });
  });
}

async function main() {
  assert.equal(
    baseline.schemaVersion,
    2,
    `unsupported MCP protocol baseline schema: ${baseline.schemaVersion}`,
  );
  // Order matters as well as membership: `full` must stay first because the
  // handshake-layout passes below and the subset invariants read results[0]
  // as the canonical full surface.
  assert.deepEqual(
    Object.keys(baseline.profiles),
    ['full', 'core', 'commander'],
    'baseline must define exactly the full, core and commander profiles, full first',
  );

  const results = [];
  for (const [profile, config] of Object.entries(baseline.profiles)) {
    const sdk = await readSdkProfile(profile, config);
    const wire = await readRawProfile(profile, config, RAW_PROTOCOL_VERSIONS[0]);
    for (const protocolVersion of RAW_PROTOCOL_VERSIONS.slice(1)) {
      await readRawProfile(profile, config, protocolVersion);
    }
    results.push({ ...sdk, ...wire });
  }

  // The bundle probe above covers the packaged path. Exercise the actual
  // tsc output as well, then relocate the self-contained bundle to prove its
  // build-injected metadata does not depend on the repository layout.
  await readHandshake(
    UNBUNDLED_PATH,
    'unbundled dist',
    baseline.profiles.full,
  );
  const stableProbeDir = mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-stable-probe-'));
  try {
    const relocatedBundle = path.join(stableProbeDir, 'index.js');
    copyFileSync(BUNDLE_PATH, relocatedBundle);
    await readHandshake(
      relocatedBundle,
      'relocated stable bundle',
      baseline.profiles.full,
    );
  } finally {
    rmSync(stableProbeDir, { recursive: true, force: true });
  }

  const byProfile = new Map(results.map((result) => [result.profile, result.names]));
  const fullOrder = byProfile.get('full');
  const fullNames = new Set(fullOrder);

  // Every narrower profile is a strict, order-preserving subset of full: a
  // host that cached the full ordering must never see a tool move.
  for (const profile of ['core', 'commander']) {
    const names = byProfile.get(profile);
    assert.ok(
      names.every((name) => fullNames.has(name)),
      `${profile} surface must be a strict subset of the full surface`,
    );
    assert.ok(
      names.length < fullNames.size,
      `${profile} surface must omit at least one full-profile tool`,
    );
    const set = new Set(names);
    assert.deepEqual(
      names,
      fullOrder.filter((name) => set.has(name)),
      `${profile} must preserve the canonical full-profile registration order`,
    );
  }

  // commander ⊆ core: commander drops browser_/company_ too, so the security
  // role can never name a tool the optimization profile already removed.
  const coreNames = new Set(byProfile.get('core'));
  assert.ok(
    byProfile.get('commander').every((name) => coreNames.has(name)),
    'commander surface must be contained in the core surface',
  );

  // The point of the core profile: no browser tools at all.
  assert.deepEqual(
    byProfile.get('core').filter((name) => name.startsWith('browser_')),
    [],
    'core surface must contain no browser_* tool',
  );
  assert.deepEqual(
    byProfile.get('core').filter((name) => name.startsWith('company_')),
    [],
    'core surface must contain no company_* tool',
  );

  console.log(JSON.stringify({
    server: { name: 'wmux', version: packageJson.version },
    baseline: path.relative(REPO_ROOT, BASELINE_PATH).replaceAll('\\', '/'),
    rawProtocolVersions: RAW_PROTOCOL_VERSIONS,
    handshakeLayouts: ['bundle', 'unbundled-dist', 'relocated-bundle'],
    profiles: Object.fromEntries(results.map((result) => [
      result.profile,
      {
        toolCount: result.toolCount,
        wireResultBytes: result.wireResultBytes,
        wireResultSha256: result.wireResultSha256,
        sdkViewSha256: result.sdkViewSha256,
        instructionBytes: result.instructionBytes,
        instructionSha256: result.instructionSha256,
      },
    ])),
  }, null, 2));
}

main().catch((error) => {
  console.error('[wmux-mcp-probe] failed:', error);
  process.exitCode = 1;
});
