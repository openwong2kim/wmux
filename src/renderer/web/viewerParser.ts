/**
 * Parser hooks the browser build (wmux web) installs on every terminal it
 * mounts. The browser is a VIEWER of a pane another machine owns:
 *
 *  - Terminal queries (DA1/DA2/DA3, DSR/CPR, DECRQM, XTVERSION, DECRQSS, OSC
 *    color queries) are absorbed, so this xterm never answers them. The pane's
 *    owner (the desktop's terminal) answers; a second answer from the browser
 *    arrived in the shell as junk (`^[[?1;2c` on the prompt). With no desktop
 *    attached the query goes unanswered — apps that ask fall back on their own
 *    timeout, which is the safe failure: a viewer that answers can type into a
 *    shell, a viewer that stays quiet cannot. Replayed queries are absorbed the
 *    same way, which is what keeps a snapshot from typing anything.
 *  - While this viewer may not type, mouse-tracking modes are absorbed too: the
 *    reports would go nowhere, and with them armed a drag selects nothing and
 *    the "app is using the mouse" hint offers a key that does nothing.
 *
 * Desktop terminals never get these hooks.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';

/** DECSET/DECRST mouse-tracking and mouse-encoding modes. */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

type ParserTerminal = Pick<Terminal, 'parser'>;

export interface ViewerParserOptions {
  /** False while this viewer may not type (read-only device or server). */
  mayInput: () => boolean;
}

const installed = new WeakSet<object>();

export function installViewerParser(term: ParserTerminal, opts: ViewerParserOptions): IDisposable[] {
  if (installed.has(term)) return [];
  installed.add(term);
  const absorb = () => true;
  const p = term.parser;
  const out: IDisposable[] = [
    p.registerCsiHandler({ final: 'c' }, absorb), // DA1
    p.registerCsiHandler({ prefix: '>', final: 'c' }, absorb), // DA2
    p.registerCsiHandler({ prefix: '=', final: 'c' }, absorb), // DA3
    p.registerCsiHandler({ final: 'n' }, absorb), // DSR / CPR
    p.registerCsiHandler({ prefix: '?', final: 'n' }, absorb), // DECDSR
    p.registerCsiHandler({ intermediates: '$', final: 'p' }, absorb), // DECRQM (ANSI)
    p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, absorb), // DECRQM (DEC)
    p.registerCsiHandler({ prefix: '>', final: 'q' }, absorb), // XTVERSION
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, absorb), // DECRQSS
  ];
  // OSC 4 / 10 / 11 / 12: a `?` spec is a query; setting a colour still applies.
  for (const ident of [4, 10, 11, 12]) {
    out.push(p.registerOscHandler(ident, (data) => data.includes('?')));
  }
  const mouseOnly = (params: (number | number[])[]) =>
    params.length > 0 && params.every((v) => typeof v === 'number' && MOUSE_MODES.has(v));
  const readOnlyMouse = (params: (number | number[])[]) => !opts.mayInput() && mouseOnly(params);
  out.push(p.registerCsiHandler({ prefix: '?', final: 'h' }, readOnlyMouse));
  return out;
}

/** Focus reports (`?1004`) are the viewer's focus, not the owner's: never sent. */
export function isFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
