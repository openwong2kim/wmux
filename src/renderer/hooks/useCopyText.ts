// Copy a short text (a command) to the clipboard and say how it went:
// 'copied' only once the write resolved, 'failed' when there is no clipboard
// bridge or the write was refused, so a caller never shows a false "Copied"
// and can leave the text in view to copy by hand instead.
import { useCallback, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/** The clipboard write: 'copied' once it resolved, else 'failed'. */
export async function copyText(text: string): Promise<Exclude<CopyState, 'idle'>> {
  const write = window.clipboardAPI?.writeText;
  if (!write) return 'failed';
  try {
    await write(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function useCopyText(): { state: CopyState; copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>('idle');
  const copy = useCallback(async (text: string) => {
    setState(await copyText(text));
  }, []);
  return { state, copy };
}
