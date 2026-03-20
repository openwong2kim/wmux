import { useStore } from '../stores';
import { t } from '../i18n';

/**
 * React hook that returns the `t()` translator and re-renders
 * the component whenever the locale changes in the Zustand store.
 */
export function useT() {
  useStore((s) => s.locale); // subscribe → re-render on locale change
  return t;
}
