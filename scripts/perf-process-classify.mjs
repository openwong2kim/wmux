// Pure process-classification helpers for the A1 RAM-attribution breakdown
// (perf-bench.mjs PR D). Split into its own module — with NO shebang — so it
// can be imported by both perf-bench.mjs and a vitest test
// (scripts/__tests__/perfProcessClassify.test.mjs). A leading shebang makes
// the Windows-CI vitest loader throw a SyntaxError (known repo gotcha — see
// the same note atop perf-compare.mjs), so this file must stay shebang-free.
//
// The bench sums working-set + commit over the FULL wmux process tree, but a
// flat total can't tell us WHERE the ~70 MB/pane lives (renderer V8 heap vs
// GPU process vs daemon vs ConPTY conhost). This module maps each CIM
// Win32_Process row to one attribution bucket using Electron's child-process
// `--type=` command-line flag plus image-name heuristics, so measureRam() can
// emit an additive `ram.breakdown` field without touching product code.

/**
 * Attribution categories. Order is the display order in the bench log.
 *   main     — the Electron main/browser process (the root wmux.exe, no --type)
 *   renderer — Chromium renderer processes (--type=renderer): the React UI +
 *              every xterm. This is the bucket the scrollback/DOM diet targets.
 *   gpu      — the GPU process (--type=gpu-process): WebGL contexts live here.
 *   utility  — Chromium utility/network/audio processes (--type=utility and the
 *              older --type=network/audio/storage service splits).
 *   daemon   — the detached wmux daemon (runs the bundled daemon entry; NOT an
 *              Electron child of the main exe, identified by its pid file).
 *   conhost  — ConPTY's conhost.exe instances backing each shell (one per PTY).
 *   other    — user shells plus any unclassified Chromium child types. The
 *              utility bucket only matches the --type= roles we enumerate
 *              (utility/network/audio/storage/broker); other Chromium child
 *              types (e.g. zygote, crashpad-handler) land here, as do the
 *              user's own shells. Kept explicit so the breakdown always
 *              reconciles to the flat total.
 */
export const RAM_CATEGORIES = [
  'main',
  'renderer',
  'gpu',
  'utility',
  'daemon',
  'conhost',
  'other',
];

// Electron/Chromium tags its children with `--type=<role>` on the command
// line. We read the role token after the flag rather than substring-matching
// the whole command line, so an unrelated path component that happens to
// contain "renderer" can't mis-bucket the main process.
function extractChromiumType(commandLine) {
  if (!commandLine) return null;
  // Match --type=renderer, --type="gpu-process", --type=utility, etc. The
  // value runs until whitespace or a quote.
  const m = /--type=(?:"|')?([a-z-]+)/i.exec(commandLine);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Classify one process row into a RAM_CATEGORIES bucket.
 *
 * @param {object} row
 * @param {string} [row.name]        Win32_Process.Name (image file name).
 * @param {string} [row.commandLine] Win32_Process.CommandLine (may be null —
 *                                   CIM returns null for processes the bench
 *                                   user can't read the command line of).
 * @param {object} [opts]
 * @param {number} [opts.pid]        This process's pid (for daemon/main match).
 * @param {number} [opts.mainPid]    The Electron main exe's pid. A child whose
 *                                   image is wmux.exe with no --type is a main
 *                                   process; Electron spawns no other typeless
 *                                   wmux.exe, so name+no-type is a safe "main"
 *                                   signal even when the pid is not supplied.
 * @param {number} [opts.daemonPid]  The detached daemon's pid (read from the
 *                                   daemon.pid file). Authoritative — the
 *                                   daemon shares the wmux.exe image, so the
 *                                   pid is the only reliable discriminator.
 * @returns {string} one of RAM_CATEGORIES.
 */
export function classifyProcess(row, opts = {}) {
  const name = String(row?.name ?? '').toLowerCase();
  const commandLine = row?.commandLine ?? '';
  const { pid, mainPid, daemonPid } = opts;

  // 1. Daemon: authoritative pid match wins over every name/flag heuristic,
  //    because the daemon runs the same wmux.exe image with no --type and
  //    would otherwise be mis-bucketed as "main".
  if (daemonPid != null && pid != null && pid === daemonPid) return 'daemon';

  // 2. conhost.exe — ConPTY's pseudo-console host backing each shell PTY.
  if (name === 'conhost.exe' || name.startsWith('conhost')) return 'conhost';

  // 3. Electron children carry an explicit --type= role.
  const type = extractChromiumType(commandLine);
  if (type === 'renderer') return 'renderer';
  if (type === 'gpu-process' || type === 'gpu') return 'gpu';
  if (
    type === 'utility' ||
    type === 'network' ||
    type === 'audio' ||
    type === 'storage' ||
    type === 'broker'
  ) {
    return 'utility';
  }

  // 4. The Electron main/browser process: the wmux.exe image with no --type.
  //    (The daemon was already peeled off by the pid match above, so any
  //    remaining typeless wmux.exe is the main process.)
  const isWmuxImage = name.includes('wmux') || (mainPid != null && pid === mainPid);
  if (isWmuxImage && !type) return 'main';

  // 5. Some dev builds name the Electron main image electron.exe — treat a
  //    typeless electron.exe as main too.
  if (name === 'electron.exe' && !type) return 'main';

  // 6. Everything else in the tree: user shells plus any Chromium child type
  //    we don't enumerate in step 3 (e.g. zygote, crashpad-handler).
  return 'other';
}

/**
 * True when a row is a wmux.exe child whose CommandLine CIM could not read
 * (null/empty) AND whose identity isn't otherwise pinned by pid. Such a row
 * carries no `--type=` token, so extractChromiumType returns null and
 * classifyProcess silently folds it into the `main` bucket — even though it may
 * really be a renderer/gpu/utility child. We can't fix the attribution without
 * the command line, but we CAN surface how often it happens so a skewed
 * breakdown is never silent.
 *
 * Excluded on purpose: (a) a typeless wmux.exe WITH a real command line is a
 * genuine main process, and (b) the daemon shares the wmux.exe image and also
 * has a null/typeless command line, but it is bucketed authoritatively by its
 * pid-file match — so a null command line there is expected, not a skew risk.
 */
function isUnreadableWmuxCommandLine(row, opts = {}) {
  const name = String(row?.name ?? '').toLowerCase();
  const { pid, mainPid, daemonPid } = opts;
  // The daemon is pinned by pid; its null command line never skews `main`.
  if (daemonPid != null && pid != null && pid === daemonPid) return false;
  const isWmuxImage = name.includes('wmux') || (mainPid != null && pid === mainPid);
  if (!isWmuxImage) return false;
  const commandLine = row?.commandLine;
  // CIM returns null (or, defensively, an empty string) when the bench user
  // lacks read access to the target process's command line.
  return commandLine == null || String(commandLine).trim() === '';
}

/**
 * Fold a list of process rows into a per-category {workingSetBytes,
 * commitBytes, processCount} breakdown. Every category in RAM_CATEGORIES is
 * present in the output (zeroed when empty) so the JSON shape stays stable
 * across runs. The summed totals reconcile exactly to the flat working-set /
 * commit the bench already reports.
 *
 * The result also carries an additive `commandLineNullCount`: the number of
 * wmux.exe rows whose CommandLine was unreadable. These rows fall back into the
 * `main` bucket for lack of a `--type=` token, so a non-zero count means the
 * main attribution may be inflated by hidden renderer/gpu/utility children. The
 * field sits alongside the category keys (which stay the canonical
 * RAM_CATEGORIES set) and does NOT participate in the bucket-sum invariant.
 *
 * @param {Array<{pid:number,name:string,commandLine:string,
 *                workingSetBytes:number,commitBytes:number}>} rows
 * @param {{mainPid?:number, daemonPid?:number}} opts
 */
export function accumulateBreakdown(rows, opts = {}) {
  const out = {};
  for (const cat of RAM_CATEGORIES) {
    out[cat] = { workingSetBytes: 0, commitBytes: 0, processCount: 0 };
  }
  let commandLineNullCount = 0;
  for (const row of rows) {
    const cat = classifyProcess(
      { name: row.name, commandLine: row.commandLine },
      { pid: row.pid, mainPid: opts.mainPid, daemonPid: opts.daemonPid },
    );
    out[cat].workingSetBytes += Number(row.workingSetBytes) || 0;
    out[cat].commitBytes += Number(row.commitBytes) || 0;
    out[cat].processCount += 1;
    if (isUnreadableWmuxCommandLine(row, { pid: row.pid, mainPid: opts.mainPid, daemonPid: opts.daemonPid })) {
      commandLineNullCount += 1;
    }
  }
  out.commandLineNullCount = commandLineNullCount;
  return out;
}
