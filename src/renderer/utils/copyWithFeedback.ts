/**
 * Pure orchestration for "copy selection → clipboard, with success/error
 * feedback".
 *
 * Background:
 * The Electron main-process clipboard handler now throws (with codes such as
 * CLIPBOARD_TOO_LARGE / CLIPBOARD_INVALID_TYPE / CLIPBOARD_WRITE_FAILED) on
 * failure. Previously the renderer fired-and-forgot
 * `clipboardAPI.writeText()`, cleared the selection, and showed a success
 * toast — meaning failures were invisible and the user thought the copy had
 * worked. This helper awaits the write and routes success/failure to the
 * correct UI path while keeping the selection intact on error so the user
 * can retry without re-dragging.
 *
 * Kept in its own module so it can be unit-tested in vitest's default `node`
 * environment (without pulling in xterm / WebGL / DOM-dependent imports).
 */

export interface CopyWithFeedbackDeps {
  /** Bridge to `window.clipboardAPI.writeText` (or any equivalent). */
  write: (text: string) => Promise<void>;
  /** Called on success only — selection stays put on failure for retry. */
  clearSelection: () => void;
  /** Called on success — typically shows a green "Copied!" toast. */
  onSuccess: () => void;
  /** Called on failure — typically shows a red "Copy failed" toast. */
  onError: () => void;
  /** Turns the selection into the text to write (a clean copy). Absent: the
   *  selection as it is. Must not throw. */
  resolve?: (selection: string) => Promise<string>;
  /** False once a newer copy started: this one then writes nothing and shows
   *  no toast, so a slow resolution never overwrites the newer copy. */
  isCurrent?: () => boolean;
}

/**
 * Run the copy flow. Always resolves; never throws (it converts a thrown
 * write into the `onError` UI path).
 */
export async function runCopyWithFeedback(
  selection: string,
  deps: CopyWithFeedbackDeps,
): Promise<void> {
  try {
    const text = deps.resolve ? await deps.resolve(selection) : selection;
    if (deps.isCurrent && !deps.isCurrent()) return;
    await deps.write(text);
    // A copy that started during the write owns the selection now.
    if (!deps.isCurrent || deps.isCurrent()) deps.clearSelection();
    deps.onSuccess();
  } catch {
    // Keep the selection — the user can retry the copy.
    deps.onError();
  }
}
