// The pipe relay turning a caller away because its Chrome has no room left
// (CdpPipeRelay hands out no token; the MCP engine passes the reason on instead
// of retrying, since a retry seconds later meets the same full Chrome).

const MARK = 'automation connections, the most it takes';
const LEAD = 'this browser already has ';

/** What a full Chrome tells the caller that asked for a token. */
export function relayFullMessage(max: number): string {
  return (
    `${LEAD}${max} ${MARK}. Each agent keeps its connection until its MCP server exits: ` +
    'end agents that no longer use the browser, then retry.'
  );
}

/**
 * The relay's refusal as a message PREFIX, after main's `CdpPipeRelay: ` and
 * optionally one `<rpc.method>: ` before it (browser.cdp.info answers
 * `browser.cdp.info: CdpPipeRelay: …`). Never a substring anywhere else: a
 * page title or URL quoted inside some other error must not end the retries.
 */
const FULL_PREFIX = new RegExp(`^(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*:[ \\t]+)?CdpPipeRelay: (${LEAD}\\d+ ${MARK}\\.[\\s\\S]*)$`);

/** The full-Chrome message an error carries (as it crossed the wmux pipe), or null. */
export function relayFullIn(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return FULL_PREFIX.exec(text)?.[1] ?? null;
}
