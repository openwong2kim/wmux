/**
 * Entry of the browser build (wmux web `/`). Built by vite.web.config.ts
 * into one classic script + one stylesheet that scripts/build-daemon-web.mjs
 * inlines into the daemon's page, after boot.ts has installed the credential
 * and the deny-by-default `window.electronAPI`.
 */
import { createRoot } from 'react-dom/client';
import { useStore } from '../stores';
import { onTerminalRegistered, terminalRegistry } from '../hooks/useTerminal';
import { getTerminalReplayMute, isReplayMuted } from '../terminal/replayMute';
import { WebApp, PHONE_QUERY } from './WebApp';
import { startWebSync } from './webSync';
import { createWebPty } from './webPty';
import { setWebPtyHub } from './WebTerminal';
import { installViewerParser } from './viewerParser';
import { CLASSIC_PATH, WEB_PTY_BRIDGE_KEY } from './webElectronApi';
import '../styles/globals.css';
import '../styles/ui.css';

/** Set by vite.web.config.ts; true only in WMUX_WEB_DEBUG=1 builds. */
declare const __WMUX_WEB_DEBUG__: boolean | undefined;

const w = window as unknown as Window & Record<string, unknown> & { __wmuxAppBooted?: boolean; __wmuxWebToken?: string };
w.__wmuxAppBooted = true;

const token = w.__wmuxWebToken ?? '';
const toClassic = () => window.location.replace(CLASSIC_PATH);

const hub = createWebPty({
  token,
  onUnauthorized: toClassic,
  // Keys typed while a replayed screen is being parsed wait for it.
  isReplaying: (ptyId) => {
    const term = terminalRegistry.get(ptyId);
    return !!term && isReplayMuted(getTerminalReplayMute(term));
  },
  // A mid-stream resize: pin the grid before the next byte parses; the
  // fixedGeometry effect refits the font on the next render.
  applyGeometry: (ptyId, g) => {
    const term = terminalRegistry.get(ptyId);
    if (term && (term.cols !== g.cols || term.rows !== g.rows)) term.resize(g.cols, g.rows);
  },
});
setWebPtyHub(hub);
w[WEB_PTY_BRIDGE_KEY] = hub.pty;
// Every terminal this page mounts is a viewer: it never answers terminal
// queries and never arms mouse reporting it could not send (viewerParser.ts).
// A terminal registers in its mount effect, before its stream opens.
onTerminalRegistered((ptyId) => {
  const term = terminalRegistry.get(ptyId);
  if (term) installViewerParser(term, { mayInput: () => hub.inputState() !== 'read-only' });
});
// Dogfood hook, as on the classic page: the real risk here is a leaked stream.
w.__wmuxWebDebug = {
  streams: () => hub.openStreamCount(),
  live: () => hub.liveIds(),
  inputState: () => hub.inputState(),
  // A pane's screen as its terminal holds it (the WebGL renderer leaves no DOM
  // text). It reads pane contents, so development builds only.
  ...(typeof __WMUX_WEB_DEBUG__ !== 'undefined' && __WMUX_WEB_DEBUG__ ? {
    screen: (ptyId: string) => {
      const term = terminalRegistry.get(ptyId);
      if (!term) return null;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
      return { cols: term.cols, rows: term.rows, fontSize: term.options.fontSize, modes: term.modes, lines };
    },
  } : {}),
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
// input on), re-read while the page lives: a failed first read or a changed
// grant must not stick.
hub.startConfig();

createRoot(document.getElementById('root')!).render(<WebApp />);

startWebSync({
  token,
  onUnauthorized: toClassic,
  onSessions: (rows) => hub.setSessions(rows),
});
