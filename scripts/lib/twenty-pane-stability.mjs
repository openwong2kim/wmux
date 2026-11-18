// Pure parts of scripts/twenty-pane-stability.mjs: argument parsing, layout and
// marker planning, the synthetic producer, shell command lines, and the run
// summary. No import-time side effects, so scripts/__tests__ can exercise the
// measurement core on synthetic samples on any platform. The driver that boots
// the app and collects samples needs a packaged wmux and is not unit-tested.

import { summarizeSamples } from '../perf-scenarios.mjs';

export const DEFAULTS = Object.freeze({
  minutes: 30,
  panes: 20,
  streaming: 6,
  perWorkspace: 5,
  sampleSec: 10,
  keysPerSample: 4,
  workspaceSwitchEvery: 3,
  treeEvery: 3,
  probeTimeoutMs: 3000,
  keyTimeoutMs: 3000,
  stallMs: 5000,
  rateKiB: 16,
  claude: 0,
  claudeMaxTurns: 20,
  claudeIntervalSec: 60,
  claudeTurnTimeoutSec: 120,
});

const INT_FLAGS = {
  '--panes': 'panes',
  '--streaming': 'streaming',
  '--per-workspace': 'perWorkspace',
  '--sample-sec': 'sampleSec',
  '--keys': 'keysPerSample',
  '--workspace-switch-every': 'workspaceSwitchEvery',
  '--tree-every': 'treeEvery',
  '--probe-timeout-ms': 'probeTimeoutMs',
  '--key-timeout-ms': 'keyTimeoutMs',
  '--stall-ms': 'stallMs',
  '--rate-kib': 'rateKiB',
  '--claude': 'claude',
  '--claude-max-turns': 'claudeMaxTurns',
  '--claude-interval-sec': 'claudeIntervalSec',
  '--claude-turn-timeout-sec': 'claudeTurnTimeoutSec',
};

/** Parse CLI flags. Throws on unknown flags or invalid values. */
export function parseArgs(argv) {
  const out = {
    ...DEFAULTS, out: null, app: null, keepApp: false, help: false,
    engine: null, claudeConfigDir: null, claudeCmd: 'claude',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--keep-app') out.keepApp = true;
    else if (flag === '--out') out.out = value();
    else if (flag === '--app') out.app = value();
    else if (flag === '--engine') {
      const v = value();
      // The Node engine is removed: rust is the only engine a run can ask for.
      if (v === 'node') throw new Error('--engine node: the Node terminal engine is removed; only rust remains');
      if (v !== 'rust') throw new Error('--engine must be rust');
      out.engine = v;
    } else if (flag === '--claude-config-dir') out.claudeConfigDir = value();
    else if (flag === '--claude-cmd') {
      out.claudeCmd = value().trim();
      if (!out.claudeCmd) throw new Error('--claude-cmd must not be empty');
    }
    else if (flag === '--minutes') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new Error('--minutes must be a positive number');
      out.minutes = n;
    } else if (flag in INT_FLAGS) {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
      out[INT_FLAGS[flag]] = n;
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (out.panes < 1) throw new Error('--panes must be at least 1');
  if (out.streaming + out.claude > out.panes) throw new Error('--streaming plus --claude cannot exceed --panes');
  if (out.claude > 0 && (out.claudeMaxTurns < 1 || out.claudeIntervalSec < 1 || out.claudeTurnTimeoutSec < 1)) {
    throw new Error('--claude-max-turns, --claude-interval-sec and --claude-turn-timeout-sec must be at least 1');
  }
  if (out.perWorkspace < 1) throw new Error('--per-workspace must be at least 1');
  if (out.sampleSec < 1) throw new Error('--sample-sec must be at least 1');
  return out;
}

/** Pane counts per workspace, e.g. (20, 5) -> [5, 5, 5, 5], (7, 5) -> [5, 2]. */
export function planLayout(panes, perWorkspace) {
  const layout = [];
  for (let left = panes; left > 0; left -= perWorkspace) layout.push(Math.min(perWorkspace, left));
  return layout;
}

/**
 * Pane classes, spread across workspaces (first pane of each workspace, then
 * the second, ...) so hidden and visible workspaces both carry load: the
 * first `streaming` positions run the producer, the next `claude` run Claude
 * Code, the rest stay idle. `panes` is [{ workspaceIndex, indexInWorkspace }];
 * returns one class per pane, in the same order.
 */
export function assignClasses(panes, streaming, claude = 0) {
  const order = panes
    .map((p, pos) => ({ pos, ws: p.workspaceIndex, idx: p.indexInWorkspace }))
    .sort((a, b) => a.idx - b.idx || a.ws - b.ws);
  const cls = panes.map(() => 'idle');
  order.forEach((o, rank) => {
    if (rank < streaming) cls[o.pos] = 'streaming';
    else if (rank < streaming + claude) cls[o.pos] = 'claude';
  });
  return cls;
}

/**
 * Check the daemon's own report of its terminal engine
 * (`daemon.ping {includeTerminalCore}` -> `terminalCore`) against the engine
 * the run asked for. Throws on a mismatch. With no requested engine it only
 * records what is running (an older daemon may still report node). Asking
 * for node is an error: the Node engine is removed.
 */
export function verifyEngine(requested, ping) {
  if (requested === 'node') throw new Error('cannot ask for the node engine: the Node terminal engine is removed; only rust remains');
  const core = ping && typeof ping === 'object' ? ping.terminalCore : undefined;
  if (!core || (core.effective !== 'node' && core.effective !== 'rust')) {
    if (!requested) return null;
    throw new Error(`cannot verify the terminal engine: this daemon does not report it (daemon.ping terminalCore is missing; version ${ping?.version ?? 'unknown'})`);
  }
  const runtime = {
    requested: core.requested, effective: core.effective,
    rustAvailable: core.rustAvailable === true, environmentOverride: core.environmentOverride === true,
  };
  if (!requested) return runtime;
  if (requested === 'rust' && !runtime.rustAvailable) {
    throw new Error('asked for the rust engine but the Rust terminal module is unavailable in this build');
  }
  if (runtime.environmentOverride) {
    throw new Error('WMUX_TERMINAL_CORE is set for the daemon and overrides the saved engine; unset it and rerun');
  }
  if (runtime.requested !== requested) {
    throw new Error(`the daemon started with the ${runtime.requested} engine, not ${requested}: the saved setting did not reach it`);
  }
  if (runtime.effective !== requested) {
    throw new Error(`asked for the ${requested} engine but the daemon runs ${runtime.effective}`);
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Claude Code panes
// ---------------------------------------------------------------------------

export const CLAUDE_PROMPT = 'Read README.md and reply with its first line only.';

export const CLAUDE_README = '# wmux soak fixture\n\nA tiny repository for the wmux 20-pane stability benchmark.\n';

/** Claude Code project settings: hooks that record turn start and end. */
export function claudeProjectSettings(nodePath, hookPath) {
  // Forward slashes and double quotes work in the shell Claude Code runs hooks
  // in on every platform (Git Bash on Windows).
  const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
  const hook = (ev) => [{ hooks: [{ type: 'command', command: `${q(nodePath)} ${q(hookPath)} ${ev}` }] }];
  return { hooks: { UserPromptSubmit: hook('start'), Stop: hook('end') } };
}

/** The hook: appends {ev, t} to $SOAK_STATUS_FILE. */
export function claudeHookSource() {
  return `'use strict';
const fs = require('fs');
const file = process.env.SOAK_STATUS_FILE;
process.stdin.resume();
process.stdin.on('data', () => {});
if (file) fs.appendFileSync(file, JSON.stringify({ ev: process.argv[2], t: Date.now() }) + '\\n');
setTimeout(() => process.exit(0), 50);
`;
}

/**
 * The line typed into a pane to start Claude Code in the fixture repo. Claude
 * Code runs with the user's REAL profile (`realProfile`: USERPROFILE and HOME
 * as they were before the sandbox), so its own login works; nothing is copied
 * or passed through the environment. Only this pane's shell gets them back;
 * every wmux path stays suffixed and sandboxed. `configDir` (optional) points
 * Claude Code at another config dir the operator chose.
 */
export function claudeLaunchCommand(platform, { repoDir, configDir = null, statusFile, cmd, realProfile }) {
  if (platform === 'win32') {
    return [
      `Set-Location -LiteralPath ${quoteArg(platform, repoDir)}`,
      `$env:USERPROFILE=${quoteArg(platform, realProfile.USERPROFILE)}`,
      realProfile.HOME ? `$env:HOME=${quoteArg(platform, realProfile.HOME)}` : 'Remove-Item Env:HOME -ErrorAction SilentlyContinue',
      ...(configDir ? [`$env:CLAUDE_CONFIG_DIR=${quoteArg(platform, configDir)}`] : []),
      `$env:SOAK_STATUS_FILE=${quoteArg(platform, statusFile)}`,
      cmd,
    ].join('; ');
  }
  const config = configDir ? `CLAUDE_CONFIG_DIR=${quoteArg(platform, configDir)} ` : '';
  return `cd ${quoteArg(platform, repoDir)} && HOME=${quoteArg(platform, realProfile.HOME)} ${config}SOAK_STATUS_FILE=${quoteArg(platform, statusFile)} ${cmd}`;
}

/**
 * Is a profile entry this run's? ~/.claude.json keys projects by path and
 * ~/.claude/projects names them by slug (every non-alphanumeric character
 * becomes '-'), so an entry is this run's when it IS the fixture repo's path
 * or slug: no substring match, which would also take '.../claude-repo-old'
 * or another run's mixed-case mkdtemp name. Case is folded only for Windows
 * paths. `repoPaths` lists the repo as created and as resolved (macOS /tmp is
 * /private/tmp).
 */
export function isRunEntry(entry, repoPaths, platform = process.platform) {
  const fold = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const e = fold(String(entry).replace(/\\/g, '/'));
  return repoPaths.filter(Boolean).some((p) =>
    e === fold(String(p).replace(/\\/g, '/')) || e === fold(String(p).replace(/[^a-zA-Z0-9]/g, '-')));
}

/**
 * What changed in the Claude Code profile during the run. Project entries
 * (~/.claude/projects names, ~/.claude.json project keys) are filtered to the
 * fixture repo, so entries other sessions add are left out. Top-level
 * ~/.claude.json key changes cannot be attributed to a session; they are
 * listed by name, unfiltered. Snapshots are
 * { projects: string[], configKeys: string[], configProjects: string[] }.
 */
export function profileDiff(before, after, repoPaths, platform = process.platform) {
  const added = (a = [], b = []) => b.filter((x) => !a.includes(x));
  const ours = (list) => list.filter((x) => isRunEntry(x, repoPaths, platform));
  return {
    projectsAdded: ours(added(before.projects, after.projects)),
    configProjectsAdded: ours(added(before.configProjects, after.configProjects)),
    configKeysAddedAnySession: added(before.configKeys, after.configKeys),
    configKeysRemovedAnySession: added(after.configKeys, before.configKeys),
  };
}

// The same bytes input.sendKey writes (src/main/pipe/handlers/input.rpc.ts KEY_MAP).
const KEY_BYTES = { down: '\x1b[B', enter: '\r', escape: '\x1b' };

/**
 * Answer the folder-trust prompt in each Claude pane whose screen shows it.
 * The keys go through `write` (the renderer's pty.write, i.e. the operator's
 * own typing): input.sendKey is refused while an approval-like prompt is on
 * screen. pty.write reports nothing when main drops the bytes, so success is
 * read from the screen: `screenAfter(ptyId)` returns the control-stripped
 * output since the answer, and a pane still showing the prompt (or showing
 * nothing new) is not trusted. Such a pane gets Escape, so no half-answered
 * prompt is left waiting for a stray Enter, and its loop stops
 * ('trust-refused'); the run goes on. panes: [{ ptyId, claude }], screens:
 * control-stripped text per pane. `beforeAnswer(ptyId)` resets the capture
 * just before the confirming key.
 */
export async function answerTrustPrompts(panes, screens, io) {
  let trusted = 0;
  let refused = 0;
  for (let i = 0; i < panes.length; i++) {
    const keys = trustPromptKeys(screens[i] ?? '');
    if (!keys) continue;
    const { ptyId } = panes[i];
    let ok = false;
    let detail = 'the prompt was still on screen after the answer';
    try {
      // Capture only what follows the confirming key: moving the selection
      // repaints the prompt itself.
      for (const [k, key] of keys.entries()) {
        if (k === keys.length - 1) await io.beforeAnswer(ptyId);
        await io.write(ptyId, KEY_BYTES[key]);
        await io.sleep(300);
      }
      await io.sleep(2500);
      const after = await io.screenAfter(ptyId);
      ok = after.length > 0 && !/trust\s*this\s*folder/i.test(after);
      if (after.length === 0) detail = 'no output after the answer';
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    if (ok) { trusted++; continue; }
    try { await io.write(ptyId, KEY_BYTES.escape); } catch { /* the pane is stopped either way */ }
    panes[i].claude.stopped = 'trust-refused';
    panes[i].claude.stoppedDetail = detail;
    refused++;
  }
  return { trusted, refused };
}

/**
 * Keys that answer Claude Code's folder-trust prompt with "Yes", read from the
 * pane's control-stripped screen text: null when no prompt is shown or the
 * selection cannot be read (then nothing is sent). The option order differs
 * between versions, so the selected option (after the last ❯) decides.
 */
export function trustPromptKeys(text) {
  if (!/trust\s*this\s*folder/i.test(text)) return null;
  const at = text.lastIndexOf('\u276f');
  if (at === -1) return null;
  const selected = text.slice(at + 1).replace(/^[\s\d.]+/, '');
  if (/^Yes/i.test(selected)) return ['enter'];
  if (/^No/i.test(selected) && /^No[^]*?Yes/i.test(selected)) return ['down', 'enter'];
  return null;
}

export function newClaudeState() {
  return { turns: 0, completed: 0, inTurn: false, turnStartedAt: null, lastSubmitAt: null, awaitingStartSince: null, stopped: null, intervals: [], turnMs: [] };
}

/** Fold hook events ({ev: 'start'|'end', t}) into a pane's loop state. */
export function applyClaudeEvents(state, events) {
  for (const e of events) {
    if (e.ev === 'start' && !state.inTurn) {
      state.inTurn = true;
      state.turnStartedAt = e.t;
      state.awaitingStartSince = null;
      state.intervals.push({ start: e.t, end: null });
    } else if (e.ev === 'end' && state.inTurn) {
      state.inTurn = false;
      state.completed++;
      state.turnMs.push(e.t - state.turnStartedAt);
      state.intervals[state.intervals.length - 1].end = e.t;
      state.turnStartedAt = null;
    }
  }
  return state;
}

/**
 * The loop's next step at `now`: 'submit' a prompt, 'interrupt' a turn over
 * the timeout (and stop), or null. Caps: at most maxTurns prompts per pane,
 * one every intervalSec, none after the run ends; a turn over turnTimeoutSec,
 * or a prompt whose turn never starts, stops the pane's loop for good.
 */
export function nextClaudeAction(state, now, { maxTurns, intervalSec, turnTimeoutSec, runEnded = false }) {
  if (state.stopped) return null;
  if (state.inTurn) {
    if (now - state.turnStartedAt > turnTimeoutSec * 1000) {
      // Escape does not fire the Stop hook: close the turn here, or the pane
      // would count as streaming (and stall) for the rest of the run.
      state.stopped = 'turn-timeout';
      state.inTurn = false;
      state.intervals[state.intervals.length - 1].end = now;
      state.turnStartedAt = null;
      return 'interrupt';
    }
    if (runEnded) state.stopped = 'run-ended';
    return null;
  }
  if (state.awaitingStartSince !== null && now - state.awaitingStartSince > turnTimeoutSec * 1000) {
    state.stopped = 'turn-not-observed';
    return 'interrupt';
  }
  if (runEnded) { state.stopped = 'run-ended'; return null; }
  if (state.turns >= maxTurns) { state.stopped = 'max-turns'; return null; }
  if (state.awaitingStartSince !== null) return null;
  if (state.lastSubmitAt !== null && now - state.lastSubmitAt < intervalSec * 1000) return null;
  state.turns++;
  state.lastSubmitAt = now;
  state.awaitingStartSince = now;
  return 'submit';
}

/** Is wall-clock `t` inside one of the pane's turns? (A Claude pane counts as streaming only then.) */
export function inTurnAt(intervals, t) {
  return intervals.some((iv) => t >= iv.start && (iv.end === null || t < iv.end));
}

/**
 * The part of an output gap [start, end] that falls inside the turn running
 * at `start`, in ms (0 outside turns). A reply printed just before the Stop
 * hook, followed by the idle wait for the next prompt, is not a stall.
 */
export function gapInTurnMs(intervals, start, end) {
  const iv = intervals.find((i) => start >= i.start && (i.end === null || start < i.end));
  if (!iv) return 0;
  return Math.max(0, Math.min(end, iv.end ?? end) - start);
}

/**
 * A marker typed into, or written to, one pane. Unique per run, never produced
 * by the producer below (it never emits "qz"), short enough not to wrap.
 */
export function markerFor(paneIndex, seq) {
  return `qz${paneIndex.toString(36)}k${seq.toString(36)}j`;
}

/**
 * Printable text of a raw output tail, for marker matching. Same rules as
 * perf-scenarios.mjs sanitizeTerminalEcho (OSC, CSI, two-byte escapes and C0
 * controls), plus CR/LF and DECSC/DECRC. Self-contained on purpose: the
 * renderer hook embeds `stripTerminalControls.toString()`, so the unit test
 * and the live matcher run the same code.
 */
export function stripTerminalControls(raw) {
  return String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_78]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/** Quote one argument for the pane's shell. */
export function quoteArg(platform, arg) {
  const s = String(arg);
  if (platform === 'win32') return `'${s.replace(/'/g, "''")}'`; // PowerShell literal string
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into a pane to start the producer (PowerShell on win32, POSIX shells elsewhere). */
export function producerCommand(platform, nodePath, scriptPath, args) {
  const parts = [quoteArg(platform, nodePath), quoteArg(platform, scriptPath), ...args.map((a) => String(a))];
  return platform === 'win32' ? `& ${parts.join(' ')}` : parts.join(' ');
}

/**
 * Typed into every pane before the run: a two-character prompt so a marker
 * never wraps in a narrow pane, and no PSReadLine inline prediction (PS 7) that
 * would paint suggestions into the echo. Windows PowerShell 5.1's PSReadLine
 * lacks -PredictionSource; the try/catch keeps that quiet.
 */
export function shellPrepCommand(platform) {
  if (platform === 'win32') {
    return "function prompt { '> ' }; try { Set-PSReadLineOption -PredictionSource None -ErrorAction Stop } catch { }; Clear-Host";
  }
  return "PS1='> '; PROMPT='> '; RPROMPT=''; clear";
}

/**
 * Source of the synthetic producer, written to the sandbox as a .cjs file.
 * Args: <tag> <KiB per second> <seconds>. Every 100 ms it repaints a status
 * row (cursor save, move to row 1, reverse video, restore: TUI-style) and
 * appends colored log lines up to the byte budget, honoring stdout
 * backpressure. Stdin is raw and edits a one-line input box on row 2 that is
 * repainted whole on every key, as TUI agents do, so a marker typed key by
 * key still arrives contiguous between log lines. Ctrl+C exits. It exits by itself after <seconds>.
 * Its output never contains "qz", so it cannot fake a marker echo.
 */
export function producerSource() {
  return `'use strict';
const tag = process.argv[2] || '0';
const kibPerSec = Number(process.argv[3]) || 16;
const seconds = Number(process.argv[4]) || 60;
const TICK_MS = 100;
const budget = Math.max(64, Math.round((kibPerSec * 1024 * TICK_MS) / 1000));
const end = Date.now() + seconds * 1000;
const spin = '|/-\\\\';
let seq = 0;
let blocked = false;
let skipped = 0;
const out = (s) => { if (!process.stdout.write(s)) blocked = true; };
process.stdout.on('drain', () => { blocked = false; });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', (d) => {
  if (d.includes(3)) process.exit(0);
  for (const ch of d.toString('utf8')) {
    if (ch === '\\x7f' || ch === '\\b') input = input.slice(0, -1);
    else if (ch === '\\r' || ch === '\\n') input = '';
    else if (ch >= ' ') input = (input + ch).slice(-64);
  }
  out('\\x1b7\\x1b[2;1H\\x1b[K> ' + input + '\\x1b8');
});
const pad = (n, w) => String(n).padStart(w, '0');
const stamp = () => { const t = new Date(); return pad(t.getHours(), 2) + ':' + pad(t.getMinutes(), 2) + ':' + pad(t.getSeconds(), 2) + '.' + pad(t.getMilliseconds(), 3); };
const timer = setInterval(() => {
  if (Date.now() >= end) {
    clearInterval(timer);
    out('\\r\\nproducer ' + tag + ' done after ' + seq + ' ticks (' + skipped + ' skipped for backpressure)\\r\\n');
    process.exit(0);
  }
  if (blocked) { skipped++; return; }
  seq++;
  let chunk = '\\x1b7\\x1b[1;1H\\x1b[7m stream ' + tag + ' seq=' + seq + ' ' + spin[seq % 4] + ' \\x1b[0m\\x1b[K\\x1b8';
  let line = 0;
  while (chunk.length < budget) {
    line++;
    chunk += '\\x1b[2m' + stamp() + '\\x1b[0m \\x1b[32mINFO\\x1b[0m worker-' + tag + ' step ' + seq + '.' + line +
      ' \\uCC98\\uB9AC \\uC644\\uB8CC \\u2713 ' + (seq * 7919 + line).toString(16).padStart(8, '0') + ' ' + '-'.repeat(24) + '\\r\\n';
  }
  out(chunk);
}, TICK_MS);
`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/** Least-squares slope of [{x, y}] (y per unit x); null with fewer than 2 distinct x. */
export function linearSlope(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

const MIN_TREND_SEC = 600;

/** first / last / max / growth (MiB per hour, runs of 10 min or more) of a byte series [{tSec, bytes}]. */
export function memoryTrend(series) {
  const pts = series.filter((p) => Number.isFinite(p.bytes));
  if (pts.length === 0) return null;
  const mib = pts.map((p) => p.bytes / MiB);
  // A rate extrapolated from a few minutes is noise (GC, helper restarts).
  const span = pts[pts.length - 1].tSec - pts[0].tSec;
  const slope = span >= MIN_TREND_SEC ? linearSlope(pts.map((p) => ({ x: p.tSec / 3600, y: p.bytes / MiB }))) : null;
  return {
    samples: pts.length,
    firstMiB: round1(mib[0]),
    lastMiB: round1(mib[mib.length - 1]),
    maxMiB: round1(Math.max(...mib)),
    growthMiBPerHour: round1(slope),
  };
}

/** Echo outcome counts + latency summary of [{echoMs|null}] events. */
function outcome(events) {
  const echoed = events.filter((e) => Number.isFinite(e.echoMs));
  return {
    sent: events.length,
    echoed: echoed.length,
    dropped: events.length - echoed.length,
    echoMs: summarizeSamples(echoed.map((e) => e.echoMs)),
  };
}

/**
 * Turn the per-tick samples into the run summary.
 *
 * Each sample: { tSec, keyboard: [{ phase, echoMs, frameMs, wrongPane }],
 *   probes: [{ ptyId, cls, echoMs }], late: [{ kind: 'key'|'probe', lateMs }], stalls: [{ ptyId, cls, gapMs, atSec }],
 *   silent: [{ ptyId, cls, silentMs }], memory: { daemonRssBytes, electronBytes,
 *   rendererBytes, mainBytes, gpuBytes, treeBytes }, raf: { p50, throttled },
 *   focus: { workspaceSwitch, focused } }.
 * Fields may be missing on a sample; the summary skips what it does not have.
 */
export function summarizeRun(samples, { stallMs = DEFAULTS.stallMs, windowMin = 5, claude = [], startDaemonPid = null } = {}) {
  const keyboard = samples.flatMap((s) => s.keyboard ?? []);
  const probes = samples.flatMap((s) => (s.probes ?? []).map((p) => ({ ...p, tSec: s.tSec })));
  // A respawned daemon starts its sessions over: the producers died with the
  // old daemon, so "streaming" panes are plain shells from then on and their
  // silence is not a stall. Stall metrics stop at the first respawn.
  // Stalls that ended between the last ping of the old daemon and the first
  // of the new one cannot be attributed; they are listed apart, not counted.
  const respawns = detectRespawns(samples, startDaemonPid);
  const stallCutSec = respawns.length ? (respawns[0].lastOldPingSec ?? 0) : null;
  const allStalls = samples.flatMap((s) => s.stalls ?? []);
  const stalls = stallCutSec === null ? allStalls : allStalls.filter((st) => st.atSec <= stallCutSec);
  const aroundRespawn = stallCutSec === null ? [] : allStalls.filter((st) => st.atSec > stallCutSec && st.atSec <= respawns[0].atSec);
  const late = samples.flatMap((s) => s.late ?? []);
  const lateOf = (kind) => {
    const ms = late.filter((l) => l.kind === kind).map((l) => l.lateMs);
    return { count: ms.length, maxMs: ms.length ? Math.max(...ms) : null };
  };
  const lastSilent = stallCutSec === null && samples.length ? samples[samples.length - 1].silent ?? [] : [];

  const perPane = new Map();
  for (const p of probes) {
    if (!perPane.has(p.ptyId)) perPane.set(p.ptyId, { ptyId: p.ptyId, cls: p.cls, events: [] });
    perPane.get(p.ptyId).events.push(p);
  }

  const series = (key) => samples.map((s) => ({ tSec: s.tSec, bytes: s.memory?.[key] }));
  const rafP50 = samples.map((s) => s.raf?.p50).filter(Number.isFinite);

  const windows = [];
  const lastT = samples.length ? samples[samples.length - 1].tSec : 0;
  for (let from = 0; from * 60 <= lastT; from += windowMin) {
    const inWin = samples.filter((s) => s.tSec >= from * 60 && s.tSec < (from + windowMin) * 60);
    if (inWin.length === 0) continue;
    const kb = outcome(inWin.flatMap((s) => s.keyboard ?? []));
    const pr = outcome(inWin.flatMap((s) => s.probes ?? []));
    const lastMem = inWin[inWin.length - 1].memory ?? {};
    windows.push({
      fromMin: from,
      toMin: from + windowMin,
      keyboardP95Ms: kb.echoMs.p95,
      keyboardDropped: kb.dropped,
      probeP95Ms: pr.echoMs.p95,
      probeDropped: pr.dropped,
      stalls: inWin.reduce((a, s) => a + (s.stalls?.length ?? 0), 0),
      daemonRssMiB: round1((lastMem.daemonRssBytes ?? NaN) / MiB),
      electronMiB: round1((lastMem.electronBytes ?? NaN) / MiB),
    });
  }

  const kbAll = outcome(keyboard);
  const probeAll = outcome(probes);
  const summary = {
    samples: samples.length,
    durationSec: lastT,
    keyboard: {
      ...kbAll,
      afterSwitch: outcome(keyboard.filter((k) => k.phase === 'afterSwitch')),
      steady: outcome(keyboard.filter((k) => k.phase === 'steady')),
      frameMs: summarizeSamples(keyboard.map((k) => k.frameMs)),
      wrongPane: keyboard.filter((k) => k.wrongPane).length,
      late: lateOf('key'),
    },
    probes: {
      ...probeAll,
      late: lateOf('probe'),
      streaming: outcome(probes.filter((p) => p.cls === 'streaming')),
      idle: outcome(probes.filter((p) => p.cls === 'idle')),
      perPane: [...perPane.values()].map((p) => {
        const o = outcome(p.events);
        return { ptyId: p.ptyId, cls: p.cls, sent: o.sent, dropped: o.dropped, p95Ms: o.echoMs.p95, maxMs: o.echoMs.max };
      }),
    },
    stalls: {
      thresholdMs: stallMs,
      episodes: stalls.length,
      panes: [...new Set(stalls.map((s) => s.ptyId))].length,
      worstGapMs: stalls.length ? Math.max(...stalls.map((s) => s.gapMs)) : null,
      list: stalls,
      silentAtEnd: lastSilent,
      // Set when the daemon was respawned: stall metrics cover only the run up
      // to the last sample before it.
      validUntilSec: stallCutSec,
      aroundRespawn,
      ignoredAfterRespawn: allStalls.length - stalls.length - aroundRespawn.length,
    },
    daemonRespawned: respawns.length ? respawns : null,
    memory: {
      daemonRss: memoryTrend(series('daemonRssBytes')),
      electronTotal: memoryTrend(series('electronBytes')),
      electronMain: memoryTrend(series('mainBytes')),
      renderer: memoryTrend(series('rendererBytes')),
      gpu: memoryTrend(series('gpuBytes')),
      processTree: memoryTrend(series('treeBytes')),
      // Commit (private) bytes: Windows trims working sets, commit it cannot.
      processTreeCommit: memoryTrend(series('treeCommitBytes')),
      daemonCommit: memoryTrend(series('daemonCommitBytes')),
    },
    frames: {
      rafP50Ms: summarizeSamples(rafP50),
      throttledSamples: samples.filter((s) => s.raf?.throttled).length,
    },
    focus: {
      workspaceSwitches: samples.filter((s) => s.focus?.workspaceSwitch).length,
      workspaceSwitchMisses: samples.filter((s) => s.focus?.workspaceSwitch && s.focus.switched === false).length,
      focusMisses: samples.filter((s) => s.focus && s.focus.focused === false).length,
    },
    windows,
    claude: summarizeClaude(claude),
  };
  summary.flags = flagsFor(summary);
  return summary;
}

/** Claude Code panes: [{ paneIndex, ptyId, turns, completed, turnMs: [], stopped }]. */
export function summarizeClaude(panes) {
  if (!panes.length) return null;
  const stopped = {};
  for (const p of panes) if (p.stopped) stopped[p.stopped] = (stopped[p.stopped] ?? 0) + 1;
  return {
    panes: panes.length,
    turnsSubmitted: panes.reduce((a, p) => a + p.turns, 0),
    turnsCompleted: panes.reduce((a, p) => a + p.completed, 0),
    turnMs: summarizeSamples(panes.flatMap((p) => p.turnMs)),
    stopped,
    perPane: panes.map((p) => ({
      paneIndex: p.paneIndex, ptyId: p.ptyId, turns: p.turns, completed: p.completed, stopped: p.stopped,
      ...(p.stoppedDetail ? { stoppedDetail: p.stoppedDetail } : {}),
    })),
  };
}

/** Plain-language findings a reader should not miss. Never a pass/fail gate. */
export function flagsFor(summary) {
  const flags = [];
  if (summary.keyboard.dropped > 0) flags.push(`${summary.keyboard.dropped} focused keystroke marker(s) not echoed within the timeout (${summary.keyboard.late.count} arrived later)`);
  if (summary.keyboard.wrongPane > 0) flags.push(`${summary.keyboard.wrongPane} keystroke marker(s) echoed in a pane other than the focused one`);
  if (summary.probes.dropped > 0) flags.push(`${summary.probes.dropped} pane probe(s) not echoed within the timeout (${summary.probes.late.count} arrived later)`);
  if (summary.stalls.episodes > 0) flags.push(`${summary.stalls.episodes} output stall(s) over ${summary.stalls.thresholdMs} ms on ${summary.stalls.panes} pane(s)`);
  if (summary.daemonRespawned) {
    const r = summary.daemonRespawned[0];
    flags.push(`the daemon was respawned between ${Math.round(r.lastOldPingSec ?? 0)} s and ${Math.round(r.atSec)} s (pid ${r.fromPid} -> ${r.toPid})${summary.daemonRespawned.length > 1 ? `, ${summary.daemonRespawned.length} times in all` : ''}; stall metrics cover only the first ${Math.round(summary.stalls.validUntilSec)} s, since the producers died with it${summary.stalls.aroundRespawn.length ? ` (${summary.stalls.aroundRespawn.length} stall(s) in between are listed in stalls.aroundRespawn)` : ''}`);
  }
  if (summary.stalls.silentAtEnd.length > 0) flags.push(`${summary.stalls.silentAtEnd.length} streaming pane(s) silent at the last sample`);
  if (summary.frames.throttledSamples > 0) flags.push(`${summary.frames.throttledSamples} sample(s) with a throttled window (rAF p50 > 50 ms): frame numbers there are not trustworthy`);
  const cs = summary.claude?.stopped ?? {};
  if (cs['turn-timeout']) flags.push(`${cs['turn-timeout']} Claude pane(s) stopped after a turn ran past the timeout`);
  if (cs['trust-refused']) flags.push(`${cs['trust-refused']} Claude pane(s) stopped at start: the folder-trust prompt could not be answered`);
  if (cs['turn-not-observed']) flags.push(`${cs['turn-not-observed']} Claude pane(s) stopped: a submitted prompt never started a turn`);
  if (summary.focus.workspaceSwitchMisses > 0) flags.push(`${summary.focus.workspaceSwitchMisses} workspace switch(es) left the same workspace active`);
  if (summary.focus.focusMisses > 0) flags.push(`${summary.focus.focusMisses} sample(s) where no terminal had keyboard focus after a switch`);
  return flags;
}

/** Compact console rendering of the summary. */
export function renderSummary(summary) {
  const engine = summary.engine
    ? `terminal engine: ${summary.engine.requested ?? 'app default'} requested; daemon reports ${summary.engine.start?.effective ?? 'unknown'} at start, ${summary.engine.end?.effective ?? 'unknown'} at end`
    : null;
  const lat = (o) => `p50 ${o.echoMs.p50 ?? '-'} / p95 ${o.echoMs.p95 ?? '-'} / max ${o.echoMs.max ?? '-'} ms (${o.echoed}/${o.sent} echoed, ${o.dropped} dropped)`;
  const mem = (t) => (t ? `${t.firstMiB} -> ${t.lastMiB} MiB (max ${t.maxMiB}, ${t.growthMiBPerHour ?? '-'} MiB/h)` : 'unavailable');
  return [
    ...(engine ? [engine] : []),
    `samples: ${summary.samples} over ${Math.round(summary.durationSec)} s`,
    `keyboard echo (focused pane): ${lat(summary.keyboard)}`,
    `  first key after a switch: ${lat(summary.keyboard.afterSwitch)}`,
    `  steady: ${lat(summary.keyboard.steady)}`,
    `  next frame: p50 ${summary.keyboard.frameMs.p50 ?? '-'} / p95 ${summary.keyboard.frameMs.p95 ?? '-'} ms`,
    `pane probes, streaming: ${lat(summary.probes.streaming)}`,
    `pane probes, idle: ${lat(summary.probes.idle)}`,
    ...(summary.claude ? [
      `Claude turns: ${summary.claude.turnsCompleted}/${summary.claude.turnsSubmitted} completed on ${summary.claude.panes} pane(s), p50 ${summary.claude.turnMs.p50 ?? '-'} / max ${summary.claude.turnMs.max ?? '-'} ms; stopped: ${JSON.stringify(summary.claude.stopped)}`,
    ] : []),
    `stalls (> ${summary.stalls.thresholdMs} ms): ${summary.stalls.episodes} on ${summary.stalls.panes} pane(s), worst ${summary.stalls.worstGapMs ?? '-'} ms; silent at end: ${summary.stalls.silentAtEnd.length}`,
    `daemon RSS: ${mem(summary.memory.daemonRss)}`,
    `Electron working sets: ${mem(summary.memory.electronTotal)}`,
    `  renderer: ${mem(summary.memory.renderer)}; main: ${mem(summary.memory.electronMain)}; gpu: ${mem(summary.memory.gpu)}`,
    `process tree: ${mem(summary.memory.processTree)}`,
    `commit, Windows only: process tree ${mem(summary.memory.processTreeCommit)}; daemon ${mem(summary.memory.daemonCommit)}`,
    `rAF p50 per sample: median ${summary.frames.rafP50Ms.p50 ?? '-'} ms; throttled samples: ${summary.frames.throttledSamples}`,
    `workspace switches: ${summary.focus.workspaceSwitches} (${summary.focus.workspaceSwitchMisses} did not switch); focus misses: ${summary.focus.focusMisses}`,
    ...(summary.flags.length ? ['flags:', ...summary.flags.map((f) => `  - ${f}`)] : ['flags: none']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Process identity and teardown
// ---------------------------------------------------------------------------

const normPath = (p, platform) => {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^"/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
};

/**
 * May the harness kill `pid` as its own daemon? Only with positive evidence
 * from one process lookup: the process started after the harness did, and its
 * command line runs the app this harness launched. Missing data or a failed
 * lookup is a no: a recycled pid may belong to the user's installed wmux.
 */
export function daemonPidVerdict(row, { harnessStartMs, appDir, platform }) {
  if (!row || !Number.isFinite(row.createdMs) || typeof row.commandLine !== 'string') return false;
  // ps reports start times to the second.
  if (row.createdMs < Math.floor(harnessStartMs / 1000) * 1000) return false;
  const dir = normPath(appDir, platform).replace(/\/$/, '') + '/';
  return normPath(row.commandLine, platform).includes(dir);
}

/**
 * Processes left behind by this run: started after the harness and naming one
 * of the run's own sandbox paths on their command line.
 * rows: [{ pid, createdMs, commandLine }].
 */
export function leftoverPids(rows, { needles, harnessStartMs, platform, excludePids = [] }) {
  const keys = needles.filter(Boolean).map((n) => normPath(n, platform).replace(/\/$/, ''));
  return rows.filter((r) => !excludePids.includes(r.pid)
    && Number.isFinite(r.createdMs) && r.createdMs >= Math.floor(harnessStartMs / 1000) * 1000
    && typeof r.commandLine === 'string'
    && keys.some((k) => containsPath(normPath(r.commandLine, platform), k)))
    .map((r) => r.pid);
}

/** `path` occurs in `text` as a whole path: `.../wmux-s1a` must not match `.../wmux-s1ab`. */
export function containsPath(text, path) {
  for (let i = text.indexOf(path); i !== -1; i = text.indexOf(path, i + 1)) {
    const next = text[i + path.length];
    if (next === undefined || next === '/' || next === '"' || next === "'" || next === ' ') return true;
  }
  return false;
}

/**
 * Stop an instance in the only order that leaves nothing running:
 *   1. kill the app and wait for it to exit (its daemon respawn controller
 *      would otherwise restart a daemon whose socket closes);
 *   2. daemon.shutdown;
 *   3. wait until the daemon pipe is gone;
 *   4. wait for the daemon PROCESS to exit (up to pidExitWaitMs): a daemon
 *      can close its pipe, log its exit and still live on, holding files.
 *      One that lingers is described (`describeProcess`) and recorded as
 *      `daemonLingering`, then killed, only through the identity check;
 *   5. one process pass over the sandbox paths, killing leftovers;
 *   6. remove the sandbox, only when the pipe is gone and the daemon process
 *      has exited, so a daemon that survived keeps its token and files for
 *      manual cleanup. `clean` is true only then.
 * `io` supplies every side effect, so the order is unit-tested with fakes.
 */
export async function runTeardown(io, { pipeWaitMs = 10000, pidExitWaitMs = 30000, pollMs = 200 } = {}) {
  // Every pid that may be this run's daemon: the one it last reported over its
  // pipe and the one in its pid file (a respawned daemon writes a new one).
  const pids = [...new Set((io.daemonPids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  const report = {
    appExited: false, daemonShutdownSent: false, daemonPipeGone: false, daemonPids: pids,
    daemonExited: false, daemonLingering: null, daemonKilled: false, leftoversKilled: 0, removed: false, clean: false,
  };
  await io.killApp();
  report.appExited = await io.waitAppExit();
  try { report.daemonShutdownSent = await io.shutdownDaemon(); } catch { report.daemonShutdownSent = false; }
  const now = io.now ?? Date.now;
  const waitUntil = async (done, limitMs) => {
    const start = now();
    for (;;) {
      if (await done()) return true;
      if (now() - start >= limitMs) return false;
      await io.sleep(pollMs);
    }
  };
  const alivePids = async () => {
    const alive = [];
    for (const pid of pids) if (await io.pidAlive(pid)) alive.push(pid);
    return alive;
  };
  const pipeStart = now();
  report.daemonPipeGone = await waitUntil(async () => !(await io.daemonPipeAlive()), pipeWaitMs);
  const pidStart = now();
  // With the pipe still open there is nothing to wait for: go straight to the kill.
  await waitUntil(async () => (await alivePids()).length === 0, report.daemonPipeGone ? pidExitWaitMs : 0);
  const lingering = await alivePids();
  if (lingering.length > 0 || !report.daemonPipeGone) {
    report.daemonLingering = {
      pid: lingering[0] ?? null,
      ...(lingering.length > 1 ? { otherPids: lingering.slice(1) } : {}),
      seconds: Math.round((now() - (report.daemonPipeGone ? pidStart : pipeStart)) / 1000),
      pipeGone: report.daemonPipeGone,
      ...(lingering.length ? (await io.describeProcess(lingering[0]).catch(() => null) ?? {}) : {}),
    };
    let killed = lingering.length > 0;
    for (const pid of lingering) killed = (await io.killDaemonIfOurs(pid)) && killed;
    report.daemonKilled = killed;
    if (killed) {
      await waitUntil(async () => (await alivePids()).length === 0, 5000);
      report.daemonPipeGone = report.daemonPipeGone || await waitUntil(async () => !(await io.daemonPipeAlive()), 2000);
    }
  }
  // Exited only when every known pid is gone; with none known it is unknown.
  report.daemonExited = pids.length > 0 && (await alivePids()).length === 0;
  for (const pid of await io.findLeftovers()) {
    if (await io.killPid(pid)) report.leftoversKilled++;
  }
  if (report.daemonPipeGone && report.daemonExited) {
    await io.removeSandbox();
    report.removed = true;
  }
  report.clean = report.removed && report.daemonLingering === null;
  return report;
}

/** Summary flags for a teardown report: never "clean" while the daemon lives. */
export function teardownFlags(report) {
  if (!report) return [];
  const flags = [];
  const l = report.daemonLingering;
  if (l) {
    const who = l.pid === null ? 'no known daemon pid was alive' : `the daemon (pid ${l.pid}) was still alive`;
    const how = l.pipeGone ? `${l.seconds} s after its pipe closed` : 'and its pipe never closed';
    flags.push(`${who} ${how}${l.pid === null ? '' : report.daemonKilled ? '; killed after the identity check' : '; not provably ours, so not killed'}`);
  }
  if (report.daemonPids && report.daemonPids.length === 0) flags.push('the daemon pid was unknown, so its exit could not be confirmed');
  if (!report.removed) flags.push('teardown was not clean: the sandbox was kept for manual cleanup (run.json)');
  return flags;
}

/**
 * Daemon replacements seen in the samples. `memory.daemonPid` and
 * `memory.daemonPingSec` say which daemon answered daemon.ping and when.
 * Each respawn names the last ping that still saw the old daemon
 * (`lastOldPingSec`) and the first that saw the new one (`atSec`).
 */
export function detectRespawns(samples, startPid = null) {
  const out = [];
  let prev = startPid;
  let prevPingSec = null;
  for (const s of samples) {
    const pid = s.memory?.daemonPid;
    if (!Number.isInteger(pid)) continue;
    const pingSec = s.memory?.daemonPingSec ?? s.tSec;
    if (prev !== null && pid !== prev) out.push({ atSec: pingSec, lastOldPingSec: prevPingSec, fromPid: prev, toPid: pid });
    prev = pid;
    prevPingSec = pingSec;
  }
  return out;
}
