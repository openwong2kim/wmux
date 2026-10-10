import { usePcRailFeeds } from '../../hooks/usePcRailFeeds';

/**
 * Mounts the PC rail's host feeds. Rendered only once session.json has been
 * restored (or failed to load), so the first mute set main receives is the
 * saved one: main holds remote toasts until it has a mute set, and an empty
 * set sent before restore would let a muted computer toast on launch.
 */
export default function PcRailFeeds(): null {
  usePcRailFeeds();
  return null;
}
