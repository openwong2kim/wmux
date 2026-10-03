// Entry for the global quick-launch composer window (launcher.html). It loads
// none of the main app: no store, no daemon, just the composer and the tokens.
import { createRoot } from 'react-dom/client';
import QuickLaunchComposer from './QuickLaunchComposer';
import '../styles/globals.css';
import '../styles/ui.css';
import './launcher.css';

document.documentElement.setAttribute('data-theme', 'tint');
createRoot(document.getElementById('root')!).render(<QuickLaunchComposer />);
