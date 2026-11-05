// This machine's host name, for the renderer. `ls --hyperlink` writes
// `file://<hostname>/path`, and the sandboxed preload cannot call
// `os.hostname()`, so main passes it along with the window, the same way as
// the start locale (startLocale.ts).

const ARG_PREFIX = '--wmux-host-name=';

// A machine host name: dot-separated labels of letters, digits, hyphens and
// underscores (Linux allows `dev_box`, and a URL keeps it as is).
const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*$/;

/** The renderer arguments (`webPreferences.additionalArguments`) carrying the host name; none when it is not a plain host name. */
export function localHostNameArgs(hostName: string): string[] {
  return hostName.length <= 253 && HOST_NAME.test(hostName) ? [`${ARG_PREFIX}${hostName}`] : [];
}

/** The host name main passed, from the preload's `process.argv`; null when there is none. */
export function localHostNameFromArgv(argv: readonly string[] | undefined): string | null {
  const arg = argv?.find((a) => a.startsWith(ARG_PREFIX));
  const name = arg ? arg.slice(ARG_PREFIX.length) : '';
  return localHostNameArgs(name).length > 0 ? name : null;
}
