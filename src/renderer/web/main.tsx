/**
 * Entry of the browser build (wmux web `/app`). Built by vite.web.config.ts
 * into one classic script + one stylesheet that scripts/build-daemon-web.mjs
 * inlines into the daemon's page, after boot.ts has installed the credential
 * and the deny-by-default `window.electronAPI`.
 */
import { createRoot } from 'react-dom/client';
import { useStore } from '../stores';
import { WebApp, PHONE_QUERY } from './WebApp';
import { startWebSync } from './webSync';
import '../styles/globals.css';
import '../styles/ui.css';

const w = window as Window & { __wmuxAppBooted?: boolean; __wmuxWebToken?: string };
w.__wmuxAppBooted = true;

useStore.setState({
  readOnly: true,
  sidebarVisible: !window.matchMedia(PHONE_QUERY).matches,
});
document.documentElement.setAttribute('data-theme', useStore.getState().theme);

createRoot(document.getElementById('root')!).render(<WebApp />);

startWebSync({
  token: w.__wmuxWebToken ?? '',
  onUnauthorized: () => window.location.replace('/'),
});
