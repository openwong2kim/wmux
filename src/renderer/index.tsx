import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './stores';
import { applyInlineImagesSetting } from './terminal/inlineImages';
import './styles/globals.css';
import './styles/ui.css';
import './styles/onboarding.css';

// Apply the store's DEFAULT theme before first paint. Without this a fresh
// session (no persisted `theme`) never sets data-theme at all, so the CSS
// :root fallback (hinomaru) silently wins over the store default — the store
// and the screen disagree until the user touches the theme picker.
// loadSession overrides this with the persisted choice moments later.
document.documentElement.setAttribute('data-theme', useStore.getState().theme);

// #1641: load and probe the inline-image addon before the first pane mounts,
// so that pane attaches synchronously (its replay and first DA1 see it), and
// follow the setting for every live terminal, parked ones included.
applyInlineImagesSetting(useStore.getState().inlineImagesEnabled);
useStore.subscribe((state, prev) => {
  if (state.inlineImagesEnabled !== prev.inlineImagesEnabled) applyInlineImagesSetting(state.inlineImagesEnabled);
});

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
