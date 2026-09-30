/**
 * Entry of the browser build (wmux web `/`). Built by vite.web.config.ts
 * into one classic script + one stylesheet that scripts/build-daemon-web.mjs
 * inlines into the daemon's page, after boot.ts has installed the credential
 * and the deny-by-default `window.electronAPI`.
 */
import { createRoot } from 'react-dom/client';
import { useStore } from '../stores';
import { terminalRegistry } from '../hooks/useTerminal';
import { getTerminalReplayMute, isReplayMuted } from '../terminal/replayMute';
import { WebApp, PHONE_QUERY } from './WebApp';
import { startWebSync } from './webSync';
import { createWebPty } from './webPty';
import { setWebPtyHub } from './WebTerminal';
import { CLASSIC_PATH, WEB_PTY_BRIDGE_KEY } from './webElectronApi';
import '../styles/globals.css';
import '../styles/ui.css';

const w = window as unknown as Window & Record<string, unknown> & { __wmuxAppBooted?: boolean; __wmuxWebToken?: string };
w.__wmuxAppBooted = true;

const token = w.__wmuxWebToken ?? '';
const toClassic = () => window.location.replace(CLASSIC_PATH);

const hub = createWebPty({
  token,
  onUnauthorized: toClassic,
  // xterm answers device queries through the same channel as typing; while a
  // replayed screen is being parsed those answers are not the user's.
  isReplaying: (ptyId) => {
    const term = terminalRegistry.get(ptyId);
    return !!term && isReplayMuted(getTerminalReplayMute(term));
  },
});
setWebPtyHub(hub);
w[WEB_PTY_BRIDGE_KEY] = hub.pty;
// Dogfood hook, as on the classic page: the real risk here is a leaked stream.
w.__wmuxWebDebug = {
  streams: () => hub.openStreamCount(),
  live: () => hub.liveIds(),
  allowInput: () => hub.allowsInput(),
  // What a pane's terminal holds (the WebGL renderer leaves no DOM text).
  screen: (ptyId: string) => {
    const term = terminalRegistry.get(ptyId);
    if (!term) return null;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    return { cols: term.cols, rows: term.rows, fontSize: term.options.fontSize, modes: term.modes, lines };
  },
};

useStore.setState({
  readOnly: true,
  // The image addon decodes with WebAssembly, which the page's CSP does not
  // allow ('wasm-unsafe-eval'); sixel / iTerm2 images stay off in the browser.
  inlineImagesEnabled: false,
  sidebarVisible: !window.matchMedia(PHONE_QUERY).matches,
});
document.documentElement.setAttribute('data-theme', useStore.getState().theme);

// THIS caller's grant (a read-only device gets false even on a server with
// input on). Until it answers, typing goes nowhere.
void fetch('/api/config', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  .then((res) => (res.ok ? res.json() : null))
  .then((cfg: { allowInput?: unknown } | null) => hub.setAllowInput(cfg?.allowInput === true))
  .catch(() => undefined);

createRoot(document.getElementById('root')!).render(<WebApp />);

startWebSync({
  token,
  onUnauthorized: toClassic,
  onSessions: (rows) => hub.setSessions(rows),
});
