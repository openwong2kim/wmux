// Composer drafts survive view/workspace changes (the composer unmounts with
// its view), but never cross conversation boundaries: the key names one.
import { useEffect } from 'react';
import type { useExternalStoreRuntime } from '@assistant-ui/react';

const drafts = new Map<string, string>();

/** Restore `key`'s draft into the runtime's composer and keep it saved. */
export function useComposerDraft(runtime: ReturnType<typeof useExternalStoreRuntime>, key: string): void {
  useEffect(() => {
    const composer = runtime.thread.composer;
    composer.setText(drafts.get(key) ?? '');
    return composer.subscribe(() => {
      const text = composer.getState().text;
      drafts.delete(key);
      if (text) drafts.set(key, text);
      if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    });
  }, [runtime, key]);
}
