/**
 * How long wmux's own Chrome may take to start (ChromeLauncher waits this long
 * on a Chrome still running but not yet listening). Its first start after the
 * install changed reads ~450 MB from a cold disk before it says anything:
 * 8-14 s measured on a GitHub Ubuntu runner.
 */
export const CHROME_START_CEILING_MS = 30_000;

/**
 * The transport deadline for an RPC that may start that Chrome (the first
 * `browser.cdp.info`, `browser.tabs` `new`): the start, then the restored-tab
 * settle and the tab itself. Past the 10 s default a cold start used to fail
 * at the caller while main went on, so a retry could open a second tab.
 */
export const CHROME_START_RPC_TIMEOUT_MS = CHROME_START_CEILING_MS + 15_000;
