import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './stores';
import { installChromeScrollPin } from './utils/pinChromeScroll';
import './styles/globals.css';
import './styles/ui.css';
import './styles/onboarding.css';

// Apply the store's DEFAULT theme before first paint. Without this a fresh
// session (no persisted `theme`) never sets data-theme at all, so the CSS
// :root fallback (hinomaru) silently wins over the store default — the store
// and the screen disagree until the user touches the theme picker.
// loadSession overrides this with the persisted choice moments later.
document.documentElement.setAttribute('data-theme', useStore.getState().theme);

// Undo any programmatic scroll of the page chrome (#1679) — see pinChromeScroll.
installChromeScrollPin();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
