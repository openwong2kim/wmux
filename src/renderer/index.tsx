import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './stores';
import { installChromeScrollPin } from './utils/pinChromeScroll';
import { installWindowGlass } from './utils/windowGlass';
import { hasRoundedWindowCorners } from '../shared/windowCorners';
import { rememberStartPolarity, settleStartTheme, startTheme } from './utils/startTheme';
import { installDocumentHiddenMotion, installSystemReducedMotion } from './utils/reducedMotion';
import './styles/globals.css';
import './styles/ui.css';
import './styles/onboarding.css';

// Apply the store's DEFAULT theme before first paint. Without this a fresh
// session (no persisted `theme`) never sets data-theme at all, so the CSS
// :root fallback (hinomaru) silently wins over the store default — the store
// and the screen disagree until the user touches the theme picker.
// loadSession overrides this with the persisted choice moments later. Until
// then a window main started light shows the light default rather than the
// dark one (#2512); the store keeps its default.
const shownStartTheme = startTheme(window.electronAPI?.startPolarity, useStore.getState().theme);
document.documentElement.setAttribute('data-theme', shownStartTheme);
document.documentElement.setAttribute('data-glass-level', useStore.getState().windowGlass);
document.documentElement.setAttribute('data-platform', window.electronAPI?.platform ?? '');
// Round window corners (macOS, Windows 11) let the sheet sit flush with the
// window's edges; square ones keep its margin (ui.css, "Frame and sheet").
document.documentElement.setAttribute('data-window-corners',
  hasRoundedWindowCorners(window.electronAPI?.platform, window.electronAPI?.windowsBuildNumber) ? 'round' : 'square');

// Windows' Animation effects off, which the media query misses there.
installSystemReducedMotion();

// No avatar motion while the window is hidden (removed nodes stay alive until the next frame).
installDocumentHiddenMotion();

// Undo any programmatic scroll of the page chrome (#1679) — see pinChromeScroll.
installChromeScrollPin();

// Translucent chrome over the macOS window material, in the theme's appearance.
// Installed once the saved theme and glass level are in, so a launch never
// flashes the defaults' glass or flips the app's appearance twice.
// The theme's polarity rides the session save (main starts a glass window in it).
// The start theme is settled first, so glass reads the theme that stays.
const saveWindowAppearance = (appearance: 'dark' | 'light') => {
  useStore.getState().setWindowAppearance(appearance);
  rememberStartPolarity(() => window.sessionStorage, appearance);
};
const onSessionSettingsLoaded = () => {
  settleStartTheme(document.documentElement, shownStartTheme, useStore.getState().theme);
  installWindowGlass(document.documentElement, saveWindowAppearance, (level) => useStore.getState().setWindowGlassEffective(level));
};
if (useStore.getState().sessionSettingsLoaded) onSessionSettingsLoaded();
else {
  const unsubscribe = useStore.subscribe((state) => {
    if (!state.sessionSettingsLoaded) return;
    unsubscribe();
    onSessionSettingsLoaded();
  });
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
