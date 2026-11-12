/**
 * How a Squirrel install hook relaunches the app without keeping the
 * installer waiting (#3280).
 *
 * Squirrel starts each hook with stdout and stderr redirected to pipes, and
 * reads them to the end after the hook exits. libuv starts every child with
 * `bInheritHandles=TRUE`, so a process the hook spawns directly inherits the
 * hook's inheritable handles, those pipe ends included, whatever `stdio` it
 * is given. A relaunched app kept the pipe open for as long as it ran, and
 * Setup.exe, plus everything Squirrel does after the hook, waited until the
 * user closed wmux (runner probe, run 43075263739).
 *
 * So the hook relaunches through ShellExecute, in process (Electron's
 * `shell.openPath`): the shell starts the app without handle inheritance, and
 * no helper process of ours sits in between holding the pipe.
 *
 * And it relaunches only when nothing else will. The in-app updater's install
 * waiter starts Setup.exe non-silently, so Squirrel's own
 * `--squirrel-firstrun` launch brings the app back; the waiter says so through
 * FIRSTRUN_RELAUNCH_ENV, which Setup.exe, Update.exe and the hook inherit. A
 * silent package-manager upgrade sets nothing, and the hook relaunches.
 *
 * No `electron` import here: the caller passes `shell.openPath` in, so this
 * module stays testable outside Electron.
 */

/** Set to '1' on the Setup.exe the in-app updater starts (installTeardown.ts). */
export const FIRSTRUN_RELAUNCH_ENV = 'WMUX_SQUIRREL_FIRSTRUN_RELAUNCHES';

/** Whether the install hook relaunches the app itself. */
export function hookShouldRelaunch(env: NodeJS.ProcessEnv): boolean {
  return env[FIRSTRUN_RELAUNCH_ENV] !== '1';
}

/** `shell.openPath`: resolves to '' on success, else the error text. */
export type OpenPath = (target: string) => Promise<string>;

/** How long the hook waits for the shell's answer before it exits anyway. */
export const RELAUNCH_WAIT_MS = 5_000;

/**
 * Squirrel cancels the install and updated hooks about 16 s after starting
 * them; the wait for the shell ends by this point, counted from process start.
 */
export const RELAUNCH_HOOK_DEADLINE_MS = 13_000;

/** The wait for the shell, cut to the hook's time left (at least 1 s). */
export function relaunchWaitMs(uptimeMs: number): number {
  return Math.max(1_000, Math.min(RELAUNCH_WAIT_MS, RELAUNCH_HOOK_DEADLINE_MS - uptimeMs));
}

/**
 * Start `exe` through the shell, so it inherits no handle of this process,
 * and wait for the shell's answer (bounded) so a failure reaches the log
 * before the hook exits. Never rejects.
 */
export async function relaunchWithoutInheritance(
  exe: string,
  openPath: OpenPath,
  waitMs: number = RELAUNCH_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`no answer from the shell after ${waitMs} ms`), waitMs);
  });
  try {
    const opened = Promise.resolve()
      .then(() => openPath(exe))
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)) || 'unknown error');
    const error = await Promise.race([opened, timeout]);
    if (error) console.warn(`[Squirrel] relaunch failed: ${error}`);
    else console.log('[Squirrel] relaunched through the shell');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
