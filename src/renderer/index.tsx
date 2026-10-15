import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './stores';
import { installChromeScrollPin } from './utils/pinChromeScroll';
import { installWindowGlass } from './utils/windowGlass';
import './styles/globals.css';
import './styles/ui.css';
import './styles/onboarding.css';

// Apply the store's DEFAULT theme before first paint. Without this a fresh
// session (no persisted `theme`) never sets data-theme at all, so the CSS
// :root fallback (hinomaru) silently wins over the store default — the store
// and the screen disagree until the user touches the theme picker.
// loadSession overrides this with the persisted choice moments later.
document.documentElement.setAttribute('data-theme', useStore.getState().theme);
document.documentElement.setAttribute('data-glass-level', useStore.getState().windowGlass);
document.documentElement.setAttribute('data-platform', window.electronAPI?.platform ?? '');

// Undo any programmatic scroll of the page chrome (#1679) — see pinChromeScroll.
installChromeScrollPin();

// Translucent chrome over the macOS window material, in the theme's appearance.
// Installed once the saved theme and glass level are in, so a launch never
// flashes the defaults' glass or flips the app's appearance twice.
if (useStore.getState().sessionSettingsLoaded) installWindowGlass();
else {
  const unsubscribe = useStore.subscribe((state) => {
    if (!state.sessionSettingsLoaded) return;
    unsubscribe();
    installWindowGlass();
  });
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
