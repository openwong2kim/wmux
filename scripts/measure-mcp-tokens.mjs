#!/usr/bin/env node
/**
 * Token-cost report for the bundled MCP tool surface.
 *
 * Every agent session pays for `tools/list` before it does any work: the host
 * puts each tool's name, description, and JSON schema into the system prompt.
 * This script measures that fixed cost so a description diet can be judged by
 * numbers instead of by feel.
 *
 * Usage:
 *   node scripts/measure-mcp-tokens.mjs [--profile full|commander] [--json]
 *                                       [--top N] [--save <file>]
 *                                       [--compare <file>]
 *
 * Token counts are the usual chars/4 approximation, not a real tokenizer —
 * good enough for before/after deltas, which is what this exists for.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BUNDLE_PATH = path.join(REPO_ROOT, 'dist', 'mcp-bundle', 'index.js');
const REQUEST_TIMEOUT_MS = 20_000;
const CHARS_PER_TOKEN = 4;

function parseArgs(argv) {
  const args = { profile: 'full', json: false, top: 10, save: null, compare: null };
  // A flag left without its value used to read `undefined` and only blow up
  // later inside path.resolve. Reject it here, where the message can name the
  // flag the caller actually mistyped.
  const value = (index, flag) => {
    const next = argv[index];
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--profile') args.profile = value(++i, arg);
    else if (arg === '--save') args.save = value(++i, arg);
    else if (arg === '--compare') args.compare = value(++i, arg);
    else if (arg === '--top') {
      args.top = Number(value(++i, arg));
      if (!Number.isFinite(args.top)) throw new Error('--top requires a number');
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.profile !== 'full' && args.profile !== 'commander') {
    throw new Error(`--profile must be "full" or "commander", got ${args.profile}`);
  }
  return args;
}

function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Speak raw JSON-RPC over stdio rather than using the SDK Client: the bytes a
 * host actually receives are the thing being measured, and the SDK re-wraps
 * them. Mirrors the raw pass in scripts/probe-commander-surface.mjs.
 */
async function listTools(profile) {
  const commander = profile === 'commander';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  );
  delete env.WMUX_COMMANDER_TOKEN;
  if (commander) env.WMUX_COMMANDER_TOKEN = 'wmux-token-measure';

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      commander ? [BUNDLE_PATH, '--commander'] : [BUNDLE_PATH],
      { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let instructions = '';

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      reject(error);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.stdin.on('error', fail);
    // The server outlives this exchange in the happy path and exits only once
    // stdin.end() below closes its input. If it dies first — a broken bundle,
    // a crash during startup — report that now instead of sitting out the full
    // request timeout. 'close' rather than 'exit' because it fires after
    // stdout has been fully delivered, so a server that answers and exits at
    // once still resolves normally.
    let exitCode = null;
    child.on('exit', (code) => { exitCode = code; });
    child.on('close', () => {
      fail(new Error(
        `MCP server exited (code ${exitCode}) before answering tools/list; ` +
        `stderr: ${stderr.trim()}`,
      ));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (settled || line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          fail(new Error(`non-JSON frame on MCP stdout: ${line.slice(0, 120)}`, { cause: error }));
          return;
        }
        if (message.id === 1) {
          instructions = message.result?.instructions ?? '';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (message.id === 2) {
          settled = true;
          clearTimeout(timeout);
          child.stdin.end();
          resolve({ tools: message.result?.tools ?? [], instructions });
        }
      }
    });

    const timeout = setTimeout(() => {
      fail(new Error(`tools/list timed out; stderr: ${stderr.trim()}`));
    }, REQUEST_TIMEOUT_MS);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'wmux-token-measure', version: '1.0.0' },
      },
    });
  });
}

function measure(tools, instructions) {
  const rows = tools.map((tool) => {
    const total = JSON.stringify(tool).length;
    const description = (tool.description ?? '').length;
    const schema = JSON.stringify(tool.inputSchema ?? {}).length;
    return {
      name: tool.name,
      browser: tool.name.startsWith('browser_'),
      totalChars: total,
      descriptionChars: description,
      schemaChars: schema,
      totalTokens: estimateTokens(total),
      descriptionTokens: estimateTokens(description),
    };
  });
  const sum = (list, key) => list.reduce((acc, row) => acc + row[key], 0);
  const group = (list) => ({
    tools: list.length,
    totalChars: sum(list, 'totalChars'),
    totalTokens: estimateTokens(sum(list, 'totalChars')),
    descriptionChars: sum(list, 'descriptionChars'),
    descriptionTokens: estimateTokens(sum(list, 'descriptionChars')),
    schemaChars: sum(list, 'schemaChars'),
  });
  return {
    rows,
    browser: group(rows.filter((row) => row.browser)),
    other: group(rows.filter((row) => !row.browser)),
    all: group(rows),
    instructionChars: instructions.length,
    instructionTokens: estimateTokens(instructions.length),
  };
}

function pad(value, width, right = false) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

function renderTable(rows, previousByName) {
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const header = [
    pad('tool', nameWidth),
    pad('chars', 8, true),
    pad('desc', 7, true),
    pad('schema', 7, true),
    pad('~tok', 7, true),
  ];
  if (previousByName) header.push(pad('dTok', 8, true));
  const lines = [header.join('  '), '-'.repeat(header.join('  ').length)];
  for (const row of rows) {
    const cells = [
      pad(row.name, nameWidth),
      pad(row.totalChars, 8, true),
      pad(row.descriptionChars, 7, true),
      pad(row.schemaChars, 7, true),
      pad(row.totalTokens, 7, true),
    ];
    if (previousByName) {
      const before = previousByName.get(row.name);
      const delta = before ? row.totalTokens - before.totalTokens : null;
      cells.push(pad(
        delta === null ? 'new' : (delta > 0 ? `+${delta}` : String(delta)),
        8,
        true,
      ));
    }
    lines.push(cells.join('  '));
  }
  return lines.join('\n');
}

function renderGroup(label, group, before) {
  const parts = [
    `${label}: ${group.tools} tools, ${group.totalChars} chars`,
    `~${group.totalTokens} tokens`,
    `(descriptions ${group.descriptionChars} chars / ~${group.descriptionTokens} tokens)`,
  ];
  if (before) {
    const delta = group.totalTokens - before.totalTokens;
    const pct = before.totalTokens === 0 ? 0 : (delta / before.totalTokens) * 100;
    parts.push(`[was ~${before.totalTokens}, ${delta >= 0 ? '+' : ''}${delta} = ${pct.toFixed(1)}%]`);
  }
  return parts.join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tools, instructions } = await listTools(args.profile);
  const report = measure(tools, instructions);
  const previous = args.compare
    ? JSON.parse(readFileSync(path.resolve(REPO_ROOT, args.compare), 'utf8'))
    : null;

  const payload = {
    profile: args.profile,
    charsPerToken: CHARS_PER_TOKEN,
    instructionChars: report.instructionChars,
    instructionTokens: report.instructionTokens,
    browser: report.browser,
    other: report.other,
    all: report.all,
    rows: report.rows,
  };

  if (args.save) {
    writeFileSync(path.resolve(REPO_ROOT, args.save), `${JSON.stringify(payload, null, 2)}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const previousByName = previous
    ? new Map(previous.rows.map((row) => [row.name, row]))
    : null;
  const browserRows = report.rows.filter((row) => row.browser)
    .sort((a, b) => b.totalChars - a.totalChars);
  const otherRows = report.rows.filter((row) => !row.browser)
    .sort((a, b) => b.totalChars - a.totalChars);
  const top = Number.isFinite(args.top) && args.top > 0 ? args.top : browserRows.length;

  console.log(`profile: ${args.profile}   (~tokens = chars / ${CHARS_PER_TOKEN})`);
  console.log('');
  console.log(`browser_* tools - top ${Math.min(top, browserRows.length)} by size:`);
  console.log(renderTable(browserRows.slice(0, top), previousByName));
  console.log('');
  console.log(`non-browser tools - top ${Math.min(top, otherRows.length)} by size:`);
  console.log(renderTable(otherRows.slice(0, top), previousByName));
  console.log('');
  console.log(renderGroup('browser_*  ', report.browser, previous?.browser));
  console.log(renderGroup('non-browser', report.other, previous?.other));
  console.log(renderGroup('all tools  ', report.all, previous?.all));
  console.log(
    `instructions: ${report.instructionChars} chars / ~${report.instructionTokens} tokens`,
  );
}

main().catch((error) => {
  console.error('[wmux-mcp-measure] failed:', error);
  process.exitCode = 1;
});
