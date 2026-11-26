import { createContext } from 'react';

/**
 * Cold-park of a mixed workspace (one that also holds a browser, editor, diff
 * or other non-terminal surface). Its pane tree stays mounted so those
 * surfaces keep their live state, and every local terminal surface under this
 * provider renders nothing instead: unmounting the terminal frees its xterm
 * and WebGL renderer, while the session keeps running in the daemon and
 * replays on reveal, exactly as a fully parked workspace's terminals do.
 */
export const TerminalsParkedContext = createContext(false);
