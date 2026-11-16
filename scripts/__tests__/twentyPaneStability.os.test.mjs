// Measurement core of the 20-pane stability soak (scripts/twenty-pane-stability.mjs).
// The driver needs a packaged app; these cover what turns raw samples into the
// published numbers, and the marker matcher the renderer hook embeds.
import { describe, expect, it } from 'vitest';
import {
  applyClaudeEvents, assignClasses, claudeLaunchCommand, claudeProjectSettings, containsPath, daemonPidVerdict,
  answerTrustPrompts, gapInTurnMs, inTurnAt, isRunEntry, trustPromptKeys,
  leftoverPids, linearSlope, markerFor, newClaudeState, nextClaudeAction, parseArgs, planLayout, producerCommand,
  producerSource, profileDiff, runTeardown, stripTerminalControls, summarizeRun, verifyEngine,
  detectRespawns, teardownFlags,
} from '../lib/twenty-pane-stability.mjs';

const MiB = 1024 * 1024;

function sample(tSec, over = {}) {
  return {
    tSec,
    keyboard: [{ phase: 'afterSwitch', echoMs: 4, frameMs: 12 }, { phase: 'steady', echoMs: 2, frameMs: 10 }],
    probes: [
      { ptyId: 'a', cls: 'streaming', echoMs: 6 },
      { ptyId: 'b', cls: 'idle', echoMs: 3 },
    ],
    stalls: [],
    silent: [],
    raf: { p50: 16.7, throttled: false },
    focus: { workspaceSwitch: false, focused: true },
    memory: { daemonRssBytes: 100 * MiB + tSec * MiB, electronBytes: 500 * MiB },
    ...over,
  };
}

describe('twenty-pane stability summary', () => {
  it('counts lost markers as drops, separates late echoes, and keeps latency stats to echoed ones', () => {
    const samples = [
      sample(0),
      sample(10, {
        keyboard: [{ phase: 'afterSwitch', echoMs: null, frameMs: null }, { phase: 'steady', echoMs: 40, frameMs: 50 }],
        probes: [{ ptyId: 'a', cls: 'streaming', echoMs: null }, { ptyId: 'b', cls: 'idle', echoMs: 5 }],
        late: [{ kind: 'probe', lateMs: 4200 }],
      }),
    ];
    const s = summarizeRun(samples);
    expect(s.keyboard.sent).toBe(4);
    expect(s.keyboard.dropped).toBe(1);
    expect(s.keyboard.echoMs.max).toBe(40);
    expect(s.keyboard.afterSwitch.dropped).toBe(1);
    expect(s.keyboard.steady.echoMs.count).toBe(2);
    expect(s.probes.streaming.dropped).toBe(1);
    expect(s.probes.idle.echoMs.max).toBe(5);
    expect(s.probes.late).toEqual({ count: 1, maxMs: 4200 });
    expect(s.probes.perPane.find((p) => p.ptyId === 'a')).toMatchObject({ sent: 2, dropped: 1 });
    expect(s.flags.join('\n')).toMatch(/1 focused keystroke marker/);
    expect(s.flags.join('\n')).toMatch(/1 pane probe\(s\) not echoed within the timeout \(1 arrived later\)/);
  });

  it('reports stalls and panes still silent at the end', () => {
    const samples = [
      sample(0, { stalls: [{ ptyId: 'a', cls: 'streaming', gapMs: 7000, atSec: 3 }] }),
      sample(10, { stalls: [{ ptyId: 'a', cls: 'streaming', gapMs: 9000, atSec: 12 }], silent: [{ ptyId: 'c', cls: 'streaming', silentMs: 8000 }] }),
    ];
    const s = summarizeRun(samples, { stallMs: 5000 });
    expect(s.stalls).toMatchObject({ thresholdMs: 5000, episodes: 2, panes: 1, worstGapMs: 9000 });
    expect(s.stalls.silentAtEnd).toHaveLength(1);
    expect(s.flags.some((f) => f.includes('silent at the last sample'))).toBe(true);
  });

  it('turns memory samples into a growth rate per hour', () => {
    // daemon grows 1 MiB per second -> 3600 MiB/h; Electron flat.
    const s = summarizeRun([sample(0), sample(300), sample(600)]);
    expect(s.memory.daemonRss).toMatchObject({ firstMiB: 100, lastMiB: 700, maxMiB: 700, growthMiBPerHour: 3600 });
    expect(s.memory.electronTotal.growthMiBPerHour).toBe(0);
    expect(s.memory.processTree).toBeNull();
    // A short run reports levels but no rate.
    expect(summarizeRun([sample(0), sample(60)]).memory.daemonRss.growthMiBPerHour).toBeNull();
  });

  it('buckets samples into 5-minute windows', () => {
    const samples = [sample(0), sample(299), sample(300), sample(610)];
    const s = summarizeRun(samples);
    expect(s.windows.map((w) => w.fromMin)).toEqual([0, 5, 10]);
    expect(s.windows[0].keyboardP95Ms).toBe(4);
  });

  it('flags throttled windows and focus misses without failing the run', () => {
    const s = summarizeRun([sample(0, { raf: { p50: 100, throttled: true }, focus: { workspaceSwitch: true, switched: false, focused: false } })]);
    expect(s.frames.throttledSamples).toBe(1);
    expect(s.focus).toEqual({ workspaceSwitches: 1, workspaceSwitchMisses: 1, focusMisses: 1 });
    expect(s.flags).toHaveLength(3);
  });

  it('fits a least-squares slope', () => {
    expect(linearSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toBe(2);
    expect(linearSlope([{ x: 1, y: 1 }])).toBeNull();
  });
});

describe('twenty-pane stability marker matching', () => {
  it('finds a marker through PSReadLine-style colour, cursor moves and chunk re-renders', () => {
    const m = markerFor(7, 42);
    const echoed = `\x1b[?25l\x1b[93mqz7\x1b[0m\x1b[?25h\x1b[3G\x1b[93m${m}\x1b[0m\r\n`;
    expect(stripTerminalControls(echoed)).toContain(m);
    // OSC title/cwd reports and DECSC/DECRC (the producer's repaint) are stripped too.
    expect(stripTerminalControls(`\x1b]0;title\x07\x1b7\x1b[1;1Hx\x1b8${m}`)).toBe(`x${m}`);
  });

  it('never appears in producer output, and markers are unique', () => {
    expect(producerSource()).not.toMatch(/qz/);
    expect(markerFor(1, 11)).not.toBe(markerFor(11, 1));
  });

  it('runs as a self-contained function, as the renderer hook embeds it', () => {
    const rebuilt = new Function(`return (${stripTerminalControls.toString()})`)();
    expect(rebuilt('\x1b[31mqz1k1j\x1b[0m')).toBe('qz1k1j');
  });
});

describe('twenty-pane stability setup helpers', () => {
  it('parses flags with defaults', () => {
    expect(parseArgs([])).toMatchObject({ minutes: 30, panes: 20, streaming: 6, perWorkspace: 5 });
    expect(parseArgs(['--panes', '4', '--minutes', '1', '--streaming', '1'])).toMatchObject({ panes: 4, minutes: 1, streaming: 1 });
    expect(() => parseArgs(['--streaming', '9', '--panes', '4'])).toThrow(/cannot exceed/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });

  it('lays panes out per workspace and spreads streaming panes across workspaces', () => {
    expect(planLayout(20, 5)).toEqual([5, 5, 5, 5]);
    expect(planLayout(7, 5)).toEqual([5, 2]);
    const panes = planLayout(20, 5).flatMap((n, w) => Array.from({ length: n }, (_, i) => ({ workspaceIndex: w, indexInWorkspace: i })));
    const cls = assignClasses(panes, 6, 4);
    expect(cls.filter((c) => c === 'streaming')).toHaveLength(6);
    expect(cls.filter((c) => c === 'claude')).toHaveLength(4);
    const streamingWs = new Set(panes.filter((_, i) => cls[i] === 'streaming').map((p) => p.workspaceIndex));
    expect(streamingWs.size).toBe(4);
  });

  it('quotes the producer command for PowerShell and POSIX shells', () => {
    expect(producerCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', "C:\\T\\it's.cjs", [3, 16, 60]))
      .toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\T\\it''s.cjs' 3 16 60");
    expect(producerCommand('darwin', '/usr/local/bin/node', "/tmp/it's.cjs", [0, 16, 60]))
      .toBe("'/usr/local/bin/node' '/tmp/it'\\''s.cjs' 0 16 60");
  });
});

describe('twenty-pane stability engine verification', () => {
  const ping = (core) => ({ version: '4.11.0', terminalCore: core });
  const rust = { requested: 'rust', effective: 'rust', rustAvailable: true, environmentOverride: false };
  const node = { requested: 'node', effective: 'node', rustAvailable: true, environmentOverride: false };

  it('accepts the engine the daemon reports running', () => {
    expect(verifyEngine('rust', ping(rust))).toMatchObject({ effective: 'rust' });
  });

  it('refuses a run that asks for node: the Node engine is removed', () => {
    expect(() => verifyEngine('node', ping(node))).toThrow(/Node terminal engine is removed/);
  });

  it('aborts when an older daemon runs node', () => {
    expect(() => verifyEngine('rust', ping(node))).toThrow(/started with the node engine, not rust/);
    expect(() => verifyEngine('rust', ping({ ...rust, effective: 'node' }))).toThrow(/runs node/);
  });

  it('aborts a rust run on a build without the Rust module', () => {
    expect(() => verifyEngine('rust', ping({ ...rust, effective: 'node', rustAvailable: false }))).toThrow(/Rust terminal module is unavailable/);
  });

  it('aborts when an older daemon reports an environment override', () => {
    expect(() => verifyEngine('rust', ping({ ...rust, environmentOverride: true }))).toThrow(/WMUX_TERMINAL_CORE/);
  });

  it('aborts when the daemon cannot report its engine, unless none was requested', () => {
    expect(() => verifyEngine('rust', { version: '4.3.0' })).toThrow(/cannot verify/);
    expect(verifyEngine(null, { version: '4.3.0' })).toBeNull();
    expect(verifyEngine(null, ping(node))).toMatchObject({ effective: 'node' });
  });

  it('parses --engine rust and rejects anything else, node included', () => {
    expect(parseArgs(['--engine', 'rust']).engine).toBe('rust');
    expect(parseArgs([]).engine).toBeNull();
    expect(() => parseArgs(['--engine', 'node'])).toThrow(/Node terminal engine is removed/);
    expect(() => parseArgs(['--engine', 'wasm'])).toThrow(/must be rust/);
  });
});

describe('twenty-pane stability Claude loop', () => {
  const cfg = { maxTurns: 3, intervalSec: 60, turnTimeoutSec: 120 };
  const s = (sec) => sec * 1000;

  it('defaults to no Claude panes and fits the pane budget', () => {
    expect(parseArgs([])).toMatchObject({ claude: 0, claudeConfigDir: null });
    expect(parseArgs(['--claude', '2'])).toMatchObject({ claude: 2, claudeMaxTurns: 20, claudeTurnTimeoutSec: 120, claudeCmd: 'claude' });
    expect(() => parseArgs(['--claude', '4', '--streaming', '18'])).toThrow(/cannot exceed/);
  });

  it('submits at most one prompt per interval and stops at the turn cap', () => {
    const st = newClaudeState();
    let t = 0;
    const actions = [];
    for (let i = 0; i < 10; i++) {
      const a = nextClaudeAction(st, s(t), cfg);
      actions.push(a);
      if (a === 'submit') applyClaudeEvents(st, [{ ev: 'start', t: s(t + 1) }, { ev: 'end', t: s(t + 6) }]);
      t += 30;
    }
    expect(actions.filter((a) => a === 'submit')).toHaveLength(3);
    expect(actions.slice(0, 3)).toEqual(['submit', null, 'submit']);
    expect(st).toMatchObject({ turns: 3, completed: 3, stopped: 'max-turns' });
    expect(st.turnMs).toEqual([5000, 5000, 5000]);
  });

  it('interrupts and stops for good when a turn runs past the timeout', () => {
    const st = newClaudeState();
    expect(nextClaudeAction(st, 0, cfg)).toBe('submit');
    applyClaudeEvents(st, [{ ev: 'start', t: s(1) }]);
    expect(nextClaudeAction(st, s(100), cfg)).toBeNull();
    expect(nextClaudeAction(st, s(122), cfg)).toBe('interrupt');
    expect(st.stopped).toBe('turn-timeout');
    // Escape fires no Stop hook: the turn is closed here, so the pane stops
    // counting as streaming.
    expect(st.inTurn).toBe(false);
    expect(st.intervals[0].end).toBe(s(122));
    expect(inTurnAt(st.intervals, s(300))).toBe(false);
    applyClaudeEvents(st, [{ ev: 'end', t: s(123) }]);
    expect(nextClaudeAction(st, s(400), cfg)).toBeNull();
  });

  it('stops when a prompt never starts a turn, and when the run ends', () => {
    const lost = newClaudeState();
    nextClaudeAction(lost, 0, cfg);
    expect(nextClaudeAction(lost, s(60), cfg)).toBeNull();
    expect(nextClaudeAction(lost, s(121), cfg)).toBe('interrupt');
    expect(lost.stopped).toBe('turn-not-observed');
    const ended = newClaudeState();
    expect(nextClaudeAction(ended, 0, { ...cfg, runEnded: true })).toBeNull();
    expect(ended).toMatchObject({ turns: 0, stopped: 'run-ended' });
  });

  it('counts only the part of a gap inside the turn', () => {
    const iv = [{ start: 1000, end: 10000 }, { start: 70000, end: null }];
    // reply at the end of a turn, then the idle wait for the next prompt
    expect(gapInTurnMs(iv, 9950, 69000)).toBe(50);
    // a real stall inside a running turn
    expect(gapInTurnMs(iv, 72000, 80000)).toBe(8000);
    expect(gapInTurnMs(iv, 20000, 30000)).toBe(0);
  });

  it('answers the folder-trust prompt with Yes whichever option is preselected', () => {
    expect(trustPromptKeys('Quick safety check ... \u276f No, exit  Yes, I trust this folder Enter to confirm')).toEqual(['down', 'enter']);
    expect(trustPromptKeys('Quick safety check \u276f 1. Yes, I trust this folder 2. No, exit')).toEqual(['enter']);
    expect(trustPromptKeys('> qz1k2j')).toBeNull();
    expect(trustPromptKeys('Yes, I trust this folder (no selection marker)')).toBeNull();
  });

  it('counts a Claude pane as streaming only inside a turn', () => {
    const st = newClaudeState();
    applyClaudeEvents(st, [{ ev: 'start', t: 100 }, { ev: 'end', t: 200 }, { ev: 'start', t: 500 }]);
    expect(inTurnAt(st.intervals, 150)).toBe(true);
    expect(inTurnAt(st.intervals, 300)).toBe(false);
    expect(inTurnAt(st.intervals, 9999)).toBe(true);
  });

  it('summarizes turns and flags timeouts', () => {
    const sum = summarizeRun([sample(0)], { claude: [
      { paneIndex: 1, ptyId: 'c1', turns: 3, completed: 3, turnMs: [4000, 5000, 6000], stopped: 'max-turns' },
      { paneIndex: 2, ptyId: 'c2', turns: 2, completed: 1, turnMs: [4000], stopped: 'turn-timeout' },
    ] });
    expect(sum.claude).toMatchObject({ panes: 2, turnsSubmitted: 5, turnsCompleted: 4, stopped: { 'max-turns': 1, 'turn-timeout': 1 } });
    expect(sum.claude.turnMs.max).toBe(6000);
    expect(sum.flags.some((f) => f.includes('ran past the timeout'))).toBe(true);
    expect(summarizeRun([sample(0)]).claude).toBeNull();
  });

  it('starts Claude in the fixture repo with the real profile for that process only', () => {
    const win = claudeLaunchCommand('win32', {
      repoDir: 'C:\\T\\repo', statusFile: 'C:\\T\\s.ndjson', cmd: 'claude --model haiku',
      realProfile: { USERPROFILE: 'C:\\Users\\me', HOME: null },
    });
    expect(win).toBe("Set-Location -LiteralPath 'C:\\T\\repo'; $env:USERPROFILE='C:\\Users\\me'; Remove-Item Env:HOME -ErrorAction SilentlyContinue; $env:SOAK_STATUS_FILE='C:\\T\\s.ndjson'; claude --model haiku");
    expect(claudeLaunchCommand('darwin', { repoDir: '/t/repo', statusFile: '/t/s', cmd: 'claude', realProfile: { HOME: '/Users/me' } }))
      .toBe("cd '/t/repo' && HOME='/Users/me' SOAK_STATUS_FILE='/t/s' claude");
    expect(claudeLaunchCommand('darwin', { repoDir: '/r', configDir: '/cc', statusFile: '/s', cmd: 'claude', realProfile: { HOME: '/h' } }))
      .toBe("cd '/r' && HOME='/h' CLAUDE_CONFIG_DIR='/cc' SOAK_STATUS_FILE='/s' claude");
    const hooks = claudeProjectSettings('C:\\Program Files\\nodejs\\node.exe', 'C:\\T\\hook.cjs').hooks;
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe('"C:/Program Files/nodejs/node.exe" "C:/T/hook.cjs" start');
    expect(hooks.Stop[0].hooks[0].command).toMatch(/ end$/);
  });
});

describe('twenty-pane stability Claude profile diff', () => {
  it('keeps only entries for this run\'s fixture repo, by path or slug', () => {
    const repo = ['/tmp/wsk-1/claude-repo', '/private/tmp/wsk-1/claude-repo'];
    const before = { projects: ['-a'], configKeys: ['projects'], configProjects: ['/a'] };
    const after = {
      // another session opened /work/app during the run
      projects: ['-a', '-private-tmp-wsk-1-claude-repo', '-work-app'],
      configKeys: ['projects', 'tipsHistory'],
      configProjects: ['/a', '/private/tmp/wsk-1/claude-repo', '/work/app'],
    };
    expect(profileDiff(before, after, repo, 'darwin')).toEqual({
      projectsAdded: ['-private-tmp-wsk-1-claude-repo'],
      configProjectsAdded: ['/private/tmp/wsk-1/claude-repo'],
      configKeysAddedAnySession: ['tipsHistory'],
      configKeysRemovedAnySession: [],
    });
  });

  it('matches the exact path or slug only', () => {
    const repo = ['/tmp/wsk-aB12cD/claude-repo'];
    expect(isRunEntry('-tmp-wsk-aB12cD-claude-repo', repo, 'darwin')).toBe(true);
    // another run's mkdtemp name differing only in case, and a longer path
    expect(isRunEntry('-tmp-wsk-Ab12Cd-claude-repo', repo, 'darwin')).toBe(false);
    expect(isRunEntry('/tmp/wsk-aB12cD/claude-repo-old', repo, 'darwin')).toBe(false);
    const win = ['C:\\Users\\me\\AppData\\Local\\Temp\\wsk-ab12\\claude-repo'];
    expect(isRunEntry('c:/users/me/appdata/local/temp/wsk-ab12/claude-repo', win, 'win32')).toBe(true);
    expect(isRunEntry('C--Users-me-AppData-Local-Temp-wsk-ab12-claude-repo', win, 'win32')).toBe(true);
    expect(isRunEntry('C--Users-me-work', win, 'win32')).toBe(false);
  });
});

describe('twenty-pane stability folder-trust answer', () => {
  const pane = (ptyId) => ({ ptyId, claude: newClaudeState() });
  const prompt = 'Quick safety check \u276f No, exit  Yes, I trust this folder';
  // screens after the answer, per pane
  function io(after, { throwOn = null } = {}) {
    const writes = [];
    return {
      writes,
      beforeAnswer: () => Promise.resolve(),
      write: async (id, d) => { if (id === throwOn) throw new Error('page closed'); writes.push([id, d]); },
      screenAfter: async (id) => after[id] ?? '',
      sleep: () => Promise.resolve(),
    };
  }

  it('types the answer, only where the prompt shows, and confirms it on screen', async () => {
    const x = io({ a: '> Try "how does this repo work"' });
    const panes = [pane('a'), pane('b')];
    expect(await answerTrustPrompts(panes, [prompt, '> '], x)).toEqual({ trusted: 1, refused: 0 });
    expect(x.writes).toEqual([['a', '\x1b[B'], ['a', '\r']]);
    expect(panes[0].claude.stopped).toBeNull();
  });

  it('stops a pane whose prompt is still there (pty.write cannot report a drop), and cancels it', async () => {
    const x = io({ a: prompt, b: '' });
    const panes = [pane('a'), pane('b')];
    expect(await answerTrustPrompts(panes, [prompt, prompt], x)).toEqual({ trusted: 0, refused: 2 });
    expect(panes[0].claude).toMatchObject({ stopped: 'trust-refused', stoppedDetail: /still on screen/ });
    expect(panes[1].claude.stoppedDetail).toMatch(/no output/);
    // Escape after the keys: no half-answered prompt waits for a stray Enter
    expect(x.writes.filter(([id]) => id === 'a').map(([, d]) => d)).toEqual(['\x1b[B', '\r', '\x1b']);
    // a stopped pane never submits a prompt
    expect(nextClaudeAction(panes[0].claude, 0, { maxTurns: 5, intervalSec: 60, turnTimeoutSec: 120 })).toBeNull();
  });

  it('stops only the pane whose write fails, and flags it in the summary', async () => {
    const panes = [pane('a'), pane('b')];
    const res = await answerTrustPrompts(panes, [prompt, prompt], io({ b: '> ' }, { throwOn: 'a' }));
    expect(res).toEqual({ trusted: 1, refused: 1 });
    expect(panes[0].claude).toMatchObject({ stopped: 'trust-refused', stoppedDetail: 'page closed' });
    const sum = summarizeRun([sample(0)], { claude: [{ paneIndex: 0, ptyId: 'a', ...panes[0].claude }] });
    expect(sum.claude.stopped).toEqual({ 'trust-refused': 1 });
    expect(sum.flags.some((f) => f.includes('folder-trust prompt could not be answered'))).toBe(true);
  });
});

describe('twenty-pane stability process identity', () => {
  const opts = { harnessStartMs: Date.parse('2026-10-26T08:00:00.500Z'), appDir: 'D:\\test\\wmux', platform: 'win32' };
  const ours = { createdMs: Date.parse('2026-10-26T08:01:00Z'), commandLine: '"D:\\Test\\wmux\\wmux.exe" "D:\\test\\wmux\\resources\\daemon-bundle\\index.js"' };

  it('accepts only a daemon started after the harness from the launched app', () => {
    expect(daemonPidVerdict(ours, opts)).toBe(true);
    // the installed app's daemon: other directory, started earlier
    expect(daemonPidVerdict({ ...ours, commandLine: '"C:\\Users\\me\\AppData\\Local\\wmux\\wmux.exe" daemon' }, opts)).toBe(false);
    expect(daemonPidVerdict({ ...ours, createdMs: Date.parse('2026-10-26T07:00:00Z') }, opts)).toBe(false);
    // a sibling directory sharing the prefix is not the app dir
    expect(daemonPidVerdict({ ...ours, commandLine: 'D:\\test\\wmux-old\\wmux.exe' }, opts)).toBe(false);
  });

  it('says no when the lookup gave nothing to judge', () => {
    expect(daemonPidVerdict(null, opts)).toBe(false);
    expect(daemonPidVerdict({ createdMs: null, commandLine: ours.commandLine }, opts)).toBe(false);
    expect(daemonPidVerdict({ createdMs: ours.createdMs, commandLine: null }, opts)).toBe(false);
  });

  it('finds leftovers by the run sandbox paths only', () => {
    const rows = [
      { pid: 1, createdMs: ours.createdMs, commandLine: 'node C:\\T\\wsk-ab\\soak-producer.cjs 3' },
      { pid: 2, createdMs: ours.createdMs, commandLine: 'node C:\\T\\other\\x.cjs' },
      { pid: 3, createdMs: Date.parse('2026-10-26T07:00:00Z'), commandLine: 'C:\\T\\wsk-ab\\old' },
      { pid: 4, createdMs: ours.createdMs, commandLine: 'C:\\T\\wsk-ab\\harness' },
    ];
    expect(leftoverPids(rows, { needles: ['c:\\t\\WSK-AB', null], harnessStartMs: opts.harnessStartMs, platform: 'win32', excludePids: [4] })).toEqual([1]);
  });

  it('never matches another run whose suffix extends this one', () => {
    const rows = [{ pid: 9, createdMs: ours.createdMs, commandLine: '/A/wmux --user-data-dir=/L/wmux-s1ab --type=renderer' }];
    expect(leftoverPids(rows, { needles: ['/L/wmux-s1a'], harnessStartMs: opts.harnessStartMs, platform: 'darwin' })).toEqual([]);
    expect(containsPath('--user-data-dir=/L/wmux-s1a --type=gpu', '/L/wmux-s1a')).toBe(true);
    expect(containsPath('"/L/wmux-s1a/x"', '/L/wmux-s1a')).toBe(true);
  });
});

describe('twenty-pane stability teardown order', () => {
  // pipeDiesAfterShutdown: the pipe closes on daemon.shutdown.
  // processExitsWithPipe: the process exits with it (false = it lingers).
  function fakes({ pipeDiesAfterShutdown = true, processExitsWithPipe = true, daemonKillable = true, pids = [4242], alivePid = 4242 } = {}) {
    const calls = [];
    let pipeUp = true;
    let procUp = true;
    let clock = 0;
    const io = {
      daemonPids: pids,
      now: () => clock,
      killApp: async () => { calls.push('killApp'); },
      waitAppExit: async () => { calls.push('waitAppExit'); return true; },
      shutdownDaemon: async () => {
        calls.push('shutdownDaemon');
        if (pipeDiesAfterShutdown) { pipeUp = false; if (processExitsWithPipe) procUp = false; }
        return true;
      },
      daemonPipeAlive: async () => pipeUp,
      pidAlive: async (pid) => procUp && pid === alivePid,
      describeProcess: async (pid) => { calls.push(`describe:${pid}`); return { threads: 20, handles: 310, workingSetBytes: 1 }; },
      killDaemonIfOurs: async (pid) => {
        calls.push(`killDaemonIfOurs:${pid}`);
        if (daemonKillable) { pipeUp = false; procUp = false; }
        return daemonKillable;
      },
      findLeftovers: async () => { calls.push('findLeftovers'); return [7, 8]; },
      killPid: async (pid) => { calls.push(`killPid:${pid}`); return true; },
      removeSandbox: async () => { calls.push(`removeSandbox:pipe=${pipeUp},proc=${procUp}`); },
      sleep: async (ms) => { clock += ms; },
    };
    return { io, calls };
  }
  const fast = { pipeWaitMs: 1000, pidExitWaitMs: 30000, pollMs: 500 };

  it('kills the app before the daemon, so no respawn can follow, and removes the sandbox last', async () => {
    const { io, calls } = fakes();
    const report = await runTeardown(io, fast);
    expect(calls).toEqual(['killApp', 'waitAppExit', 'shutdownDaemon', 'findLeftovers', 'killPid:7', 'killPid:8', 'removeSandbox:pipe=false,proc=false']);
    expect(report).toMatchObject({ daemonPipeGone: true, daemonExited: true, daemonLingering: null, leftoversKilled: 2, removed: true, clean: true });
    expect(teardownFlags(report)).toEqual([]);
  });

  it('never calls a teardown clean while the daemon process outlives its pipe', async () => {
    const { io, calls } = fakes({ processExitsWithPipe: false });
    const report = await runTeardown(io, fast);
    // measured: the full 30 s wait elapsed on the fake clock
    expect(report.daemonLingering).toEqual({ pid: 4242, seconds: 30, pipeGone: true, threads: 20, handles: 310, workingSetBytes: 1 });
    // described, then killed through the identity check, and only then removed
    expect(calls).toEqual(['killApp', 'waitAppExit', 'shutdownDaemon', 'describe:4242', 'killDaemonIfOurs:4242',
      'findLeftovers', 'killPid:7', 'killPid:8', 'removeSandbox:pipe=false,proc=false']);
    expect(report).toMatchObject({ daemonKilled: true, daemonExited: true, removed: true, clean: false });
    expect(teardownFlags(report)[0]).toMatch(/pid 4242\) was still alive 30 s after its pipe closed; killed/);
  });

  it('watches the pid-file pid too, so a respawned daemon cannot hide behind a stale one', async () => {
    // last ping named 100 (dead); the pid file names the live respawned 200
    const { io, calls } = fakes({ processExitsWithPipe: false, pids: [100, 200], alivePid: 200 });
    const report = await runTeardown(io, fast);
    expect(report.daemonLingering.pid).toBe(200);
    expect(calls).toContain('killDaemonIfOurs:200');
    expect(calls).not.toContain('killDaemonIfOurs:100');
  });

  it('keeps the sandbox when a lingering daemon is not provably ours', async () => {
    const { io, calls } = fakes({ processExitsWithPipe: false, daemonKillable: false });
    const report = await runTeardown(io, fast);
    expect(report).toMatchObject({ daemonPipeGone: true, daemonExited: false, removed: false, clean: false });
    expect(calls.some((c) => c.startsWith('removeSandbox'))).toBe(false);
    expect(teardownFlags(report).join('\n')).toMatch(/not killed[^]*sandbox was kept/);
  });

  it('never reports clean when no daemon pid is known', async () => {
    const { io } = fakes({ pids: [] });
    const report = await runTeardown(io, fast);
    expect(report).toMatchObject({ daemonPipeGone: true, daemonExited: false, removed: false, clean: false });
    expect(teardownFlags(report).join('\n')).toMatch(/pid was unknown/);
  });

  it('kills a daemon that ignored shutdown only through the identity check', async () => {
    const { io, calls } = fakes({ pipeDiesAfterShutdown: false });
    const report = await runTeardown(io, fast);
    expect(calls.slice(0, 5)).toEqual(['killApp', 'waitAppExit', 'shutdownDaemon', 'describe:4242', 'killDaemonIfOurs:4242']);
    expect(report).toMatchObject({ daemonKilled: true, daemonPipeGone: true, daemonExited: true, removed: true, clean: false });
    expect(report.daemonLingering.pipeGone).toBe(false);
  });

  it('flags an open pipe even when no known pid is alive', async () => {
    const { io, calls } = fakes({ pipeDiesAfterShutdown: false, alivePid: -1 });
    const report = await runTeardown(io, fast);
    expect(report.daemonLingering).toMatchObject({ pid: null, pipeGone: false });
    expect(calls.some((c) => c.startsWith('removeSandbox'))).toBe(false);
    expect(teardownFlags(report)[0]).toMatch(/no known daemon pid was alive and its pipe never closed/);
  });

  it('keeps the sandbox (and the daemon token) when the daemon is still up', async () => {
    const { io, calls } = fakes({ pipeDiesAfterShutdown: false, daemonKillable: false });
    const report = await runTeardown(io, fast);
    expect(report).toMatchObject({ daemonPipeGone: false, removed: false, clean: false });
    expect(calls.some((c) => c.startsWith('removeSandbox'))).toBe(false);
  });
});

describe('twenty-pane stability daemon respawn', () => {
  const at = (tSec, daemonPid, stalls = [], silent = [], pingSec = tSec + 4) =>
    sample(tSec, { memory: daemonPid === undefined ? {} : { daemonPid, daemonPingSec: pingSec }, stalls, silent });

  it('detects a pid change mid-run with the pings around it', () => {
    const samples = [at(0, 100), at(10, 100), at(20, undefined), at(30, 200), at(40, 200)];
    expect(detectRespawns(samples, 100)).toEqual([{ atSec: 34, lastOldPingSec: 14, fromPid: 100, toPid: 200 }]);
    expect(detectRespawns([at(0, 100), at(10, 100)], 100)).toEqual([]);
    // a start pid from daemon.ping that the first sample no longer shows
    expect(detectRespawns([at(0, 300)], 100)).toEqual([{ atSec: 4, lastOldPingSec: null, fromPid: 100, toPid: 300 }]);
  });

  it('counts stalls up to the old daemon\'s last ping, lists the ones around the respawn, and flags it', () => {
    const gap = (atSec) => ({ ptyId: 'p', cls: 'streaming', gapMs: 9000, atSec });
    const samples = [
      at(0, 100, [gap(5)]),
      at(10, 100, [gap(13)]), // ended after this sample started, before its ping at 14 s: counted
      at(20, 200, [gap(18), gap(23)]), // 18 s: between the pings; 23 s: before the new ping at 24 s
      at(30, 200, [gap(28)], [{ ptyId: 'p', cls: 'streaming', silentMs: 9000 }]),
    ];
    const s = summarizeRun(samples, { startDaemonPid: 100 });
    expect(s.daemonRespawned).toHaveLength(1);
    expect(s.stalls).toMatchObject({ episodes: 2, validUntilSec: 14, ignoredAfterRespawn: 1, silentAtEnd: [] });
    expect(s.stalls.aroundRespawn.map((x) => x.atSec)).toEqual([18, 23]);
    expect(s.flags.some((f) => /respawned between 14 s and 24 s \(pid 100 -> 200\).*first 14 s.*2 stall/.test(f))).toBe(true);
    const steady = summarizeRun([at(0, 100, [gap(5)]), at(10, 100)], { startDaemonPid: 100 });
    expect(steady).toMatchObject({ daemonRespawned: null, stalls: { episodes: 1, validUntilSec: null, ignoredAfterRespawn: 0 } });
  });
});


