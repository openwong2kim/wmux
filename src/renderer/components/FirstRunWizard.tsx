/**
 * FirstRunWizard (T6 of 1.15 first-run wizard batch).
 *
 * Magical-moment onboarding modal. Detects Claude Code, offers 1-click
 * MCP registration, and runs a deterministic sample task that splits the
 * window 2x2 and launches Claude in the upper-left pane's shell — that pane
 * is a plain shell, so the sample task runs `claude` there (#452).
 *
 * See:
 *   - progress.md (T6 spec)
 *   - decisions.md D1 (skip-friendly when no Claude)
 *   - decisions.md D2 (1-click register)
 *   - decisions.md D3 (OSC133 fallback UX)
 *   - decisions.md D9 (reopen disables sample task)
 *   - decisions.md D10 (registerMcp Tier 2 inline error)
 *
 * Renderer-only. Glues to main via window.electronAPI.firstRun.* (T1/T4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FirstRunCheckResult,
  FirstRunMode,
  RegisterMcpResult,
  RegisterMcpErrorCode,
  SampleTaskStartPayload,
} from '../../shared/firstRun';
import type { Pane, PaneLeaf } from '../../shared/types';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';

// ─── Local type narrowing for electronAPI.firstRun ────────────────────────────
//
// `firstRun` is also declared as optional on `Window['electronAPI']` in the
// shared `electron.d.ts` augmentation. We narrow to a non-optional shape here
// so callers below don't have to optional-chain every method.
interface FirstRunBridge {
  check: () => Promise<FirstRunCheckResult>;
  complete: () => Promise<void>;
  dismiss: () => Promise<void>;
  reopen: () => Promise<FirstRunCheckResult>;
  registerMcp: () => Promise<RegisterMcpResult>;
  startSampleTask: (payload: SampleTaskStartPayload) => Promise<void>;
  onSampleTaskReady: (cb: () => void) => () => void;
  onSampleTaskTimeout: (cb: () => void) => () => void;
}

function firstRunBridge(): FirstRunBridge {
  const api = (window as unknown as {
    electronAPI?: { firstRun?: FirstRunBridge };
  }).electronAPI;
  if (!api?.firstRun) {
    throw new Error('window.electronAPI.firstRun is not available — preload not loaded?');
  }
  return api.firstRun;
}

function shellOpenExternal(url: string): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: { shell?: { openExternal: (u: string) => Promise<void> } };
  }).electronAPI;
  if (!api?.shell?.openExternal) return Promise.resolve();
  return api.shell.openExternal(url);
}

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Top-level UI state derived from {@link FirstRunCheckResult} + mode.
 *
 * - `claude-missing` → render install link, sample task disabled
 * - `needs-register` → render Register button
 * - `ready` → all green, sample task enabled (mode='firstRun' only)
 * - `reopen` → mode='reopen'; sample task always disabled (D9)
 */
export type WizardUiState = 'claude-missing' | 'needs-register' | 'ready' | 'reopen';

export function decideUiState(
  result: FirstRunCheckResult | null,
  mode: FirstRunMode,
): WizardUiState | null {
  if (!result) return null;
  if (mode === 'reopen') return 'reopen';
  if (!result.status.claudeFound) return 'claude-missing';
  if (!result.status.mcpRegistered) return 'needs-register';
  return 'ready';
}

/**
 * Recursively descend `children[0]` to find the upper-left leaf in a pane tree.
 *
 * For the builtin-grid 2x2 layout (vertical[ horizontal[L, L], horizontal[L, L] ]),
 * this returns the top-left leaf id.
 */
export function findTopLeftLeafId(root: Pane): string | null {
  if (root.type === 'leaf') return root.id;
  if (root.children.length === 0) return null;
  return findTopLeftLeafId(root.children[0]);
}

/** Recursively find a leaf pane by id. Returns null if not found or if `id` resolves to a branch. */
export function findLeafById(root: Pane, id: string): PaneLeaf | null {
  if (root.id === id && root.type === 'leaf') return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findLeafById(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** ISO timestamp → YYYY-MM-DD. Returns empty string for invalid input. */
export function formatCompletedAt(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** i18n keys for Tier 2 error display (D10). Falls back to UNKNOWN for unrecognized codes. */
export function getRegisterErrorKeys(code: RegisterMcpErrorCode | string): {
  problem: string;
  cause: string;
  fix: string;
} {
  const valid: ReadonlyArray<RegisterMcpErrorCode> = ['PERM', 'PARSE', 'IO', 'UNKNOWN'];
  const safe = valid.includes(code as RegisterMcpErrorCode) ? code : 'UNKNOWN';
  return {
    problem: `firstRunWizard.error.${safe}.problem`,
    cause: `firstRunWizard.error.${safe}.cause`,
    fix: `firstRunWizard.error.${safe}.fix`,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface FirstRunWizardProps {
  mode: FirstRunMode;
  onClose: () => void;
}

type SampleSubState =
  | 'idle'
  | 'splitting'
  | 'awaiting-prompt'
  | 'success'
  | 'timeout-fallback'
  | 'error';

const PTYID_WAIT_TIMEOUT_MS = 10_000;

export default function FirstRunWizard({ mode, onClose }: FirstRunWizardProps) {
  const t = useT();
  const headerId = 'first-run-wizard-header';

  const [result, setResult] = useState<FirstRunCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<
    { code: RegisterMcpErrorCode; message: string } | null
  >(null);
  const [sampleState, setSampleState] = useState<SampleSubState>('idle');

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  // Keep latest onClose in a ref so listeners installed once stay correct.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ─── Mount guard (I3) ──────────────────────────────────────────────────
  // The ptyId-wait subscription inside handleTrySampleTask schedules state
  // updates after async work (10s timeout + store subscription). Without a
  // guard, dismissing the wizard mid-handshake would call setState on an
  // unmounted component AND leak the store subscription / pending timer.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ─── Initial check ─────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next =
        mode === 'reopen'
          ? await firstRunBridge().reopen()
          : await firstRunBridge().check();
      setResult(next);
    } catch {
      // If main is unreachable, default to a "claude-missing" UI so the
      // user can still skip out cleanly.
      setResult({
        shown: false,
        status: { claudeFound: false, mcpRegistered: false, claudeJsonPath: '' },
      });
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ─── Dismiss / Escape ──────────────────────────────────────────────────────
  const dismiss = useCallback(async () => {
    try {
      await firstRunBridge().dismiss();
    } catch {
      // ignore — closing is best-effort
    }
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void dismiss();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [dismiss]);

  // Focus first interactive element on mount.
  useEffect(() => {
    if (loading) return;
    firstFocusRef.current?.focus();
  }, [loading]);

  // ─── Register MCP ──────────────────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const res = await firstRunBridge().registerMcp();
      if (res.ok) {
        await refresh();
      } else {
        setRegisterError({ code: res.code, message: res.message });
      }
    } catch (err) {
      setRegisterError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRegistering(false);
    }
  }, [refresh]);

  // ─── Sample task ───────────────────────────────────────────────────────────
  // TODO(I1): the 2x2 grid created by applyLayoutTemplate('builtin-grid')
  // is not rolled back if the user dismisses (Skip / Escape / ×) while we
  // are still in 'splitting' or 'awaiting-prompt'. The store currently has
  // no public set-rootPane / restore-layout primitive (we only mutate
  // ws.rootPane through paneSlice's split/close and uiSlice's
  // applyLayoutTemplate). Adding a new store action is out of scope for
  // this fix-up; revisit alongside paneSlice undo/redo work.
  const handleTrySampleTask = useCallback(async () => {
    if (sampleState !== 'idle') return;
    setSampleState('splitting');

    // 1. Apply 2x2 grid layout to the active workspace.
    const store = useStore.getState();
    store.applyLayoutTemplate('builtin-grid');

    // 2. Find the top-left leaf id in the (now-rebuilt) workspace tree.
    const stateAfter = useStore.getState();
    const ws = stateAfter.workspaces.find((w) => w.id === stateAfter.activeWorkspaceId);
    const topLeftLeafId = ws ? findTopLeftLeafId(ws.rootPane) : null;
    if (!ws || !topLeftLeafId) {
      setSampleState('error');
      return;
    }

    // 3. Wait for the top-left leaf's first surface to acquire a non-empty ptyId.
    //    The Terminal component creates the pty asynchronously when it mounts;
    //    we subscribe to the store and resolve as soon as ptyId is populated.
    //    I3 guard: if the wizard unmounts mid-wait (Skip / Escape / × click)
    //    we tear down the subscription + timer immediately and resolve null
    //    so no setState lands on the unmounted component.
    const ptyId = await new Promise<string | null>((resolve) => {
      const tryGet = (): string | null => {
        const s = useStore.getState();
        const w = s.workspaces.find((x) => x.id === ws.id);
        if (!w) return null;
        const leaf = findLeafById(w.rootPane, topLeftLeafId);
        if (leaf && leaf.surfaces.length > 0 && leaf.surfaces[0].ptyId) {
          return leaf.surfaces[0].ptyId;
        }
        return null;
      };

      const initial = tryGet();
      if (initial) {
        resolve(initial);
        return;
      }

      const unsub = useStore.subscribe(() => {
        if (!isMountedRef.current) {
          unsub();
          clearTimeout(timer);
          resolve(null);
          return;
        }
        const got = tryGet();
        if (got) {
          unsub();
          clearTimeout(timer);
          resolve(got);
        }
      });
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, PTYID_WAIT_TIMEOUT_MS);
    });

    if (!isMountedRef.current) return;

    if (!ptyId) {
      setSampleState('error');
      return;
    }

    // 4. Subscribe to ready/timeout BEFORE starting the task to avoid races.
    setSampleState('awaiting-prompt');
    const noop = (): void => undefined;
    let unsubReady: () => void = noop;
    let unsubTimeout: () => void = noop;

    const cleanup = () => {
      unsubReady();
      unsubTimeout();
    };

    const bridge = firstRunBridge();
    unsubReady = bridge.onSampleTaskReady(() => {
      cleanup();
      if (!isMountedRef.current) return;
      setSampleState('success');
      // Auto-complete + close after a brief moment so the user can read the success copy.
      setTimeout(() => {
        void firstRunBridge().complete().catch(() => undefined);
        onCloseRef.current();
      }, 2_000);
    });

    unsubTimeout = bridge.onSampleTaskTimeout(() => {
      cleanup();
      if (!isMountedRef.current) return;
      setSampleState('timeout-fallback');
    });

    // 5. Hand the ptyId off to main; SampleTaskRunner will scan for OSC133.
    try {
      await bridge.startSampleTask({ ptyId });
    } catch {
      cleanup();
      if (!isMountedRef.current) return;
      setSampleState('error');
    }
  }, [sampleState]);

  const handleFallbackContinue = useCallback(async () => {
    try {
      await firstRunBridge().complete();
    } catch {
      // ignore
    }
    onCloseRef.current();
  }, []);

  const ui = useMemo(() => decideUiState(result, mode), [result, mode]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center"
      style={{ backgroundColor: 'var(--backdrop-modal)' }}
      data-testid="first-run-wizard-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headerId}
        className="flex flex-col gap-4 p-6 rounded-xl"
        style={{
          width: 480,
          maxWidth: '90vw',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          boxShadow: 'var(--shadow-modal)',
          fontFamily: 'ui-monospace, monospace',
        }}
        data-testid="first-run-wizard"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id={headerId}
              className="text-display"
              style={{ color: 'var(--text-main)', margin: 0 }}
            >
              {t('firstRunWizard.title')}
            </h2>
            <p
              className="text-xs"
              style={{ color: 'var(--text-sub)', margin: '4px 0 0 0' }}
            >
              {t('firstRunWizard.subtitle')}
            </p>
          </div>
          <button
            ref={firstFocusRef}
            onClick={() => void dismiss()}
            aria-label={t('firstRunWizard.closeButton')}
            data-testid="first-run-wizard-close"
            className="text-sm"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-subtle)',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {loading && (
          <div
            className="text-xs"
            style={{ color: 'var(--text-subtle)' }}
            data-testid="first-run-wizard-loading"
          >
            …
          </div>
        )}

        {!loading && result && (
          <>
            {/* Claude detection status */}
            <ClaudeStatusBlock
              claudeFound={result.status.claudeFound}
              mcpRegistered={result.status.mcpRegistered}
              registering={registering}
              onRegister={handleRegister}
            />

            {/* Tier 2 inline registration error (D10) */}
            {registerError && (
              <div
                role="alert"
                data-testid="first-run-wizard-register-error"
                className="flex flex-col gap-1 p-3 rounded-lg"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--accent-red, #f38ba8)',
                }}
              >
                {(() => {
                  const keys = getRegisterErrorKeys(registerError.code);
                  return (
                    <>
                      <p
                        className="text-xs font-semibold"
                        style={{ color: 'var(--text-main)', margin: 0 }}
                      >
                        {t(keys.problem)}
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: 'var(--text-sub)', margin: 0 }}
                      >
                        {t(keys.cause)}
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: 'var(--text-sub)', margin: 0 }}
                      >
                        {t(keys.fix)}
                      </p>
                      <button
                        onClick={() => void handleRegister()}
                        disabled={registering}
                        data-testid="first-run-wizard-register-retry"
                        className="self-start mt-2 px-3 py-1 rounded text-xs font-medium"
                        style={{
                          backgroundColor: 'var(--bg-overlay)',
                          color: 'var(--text-main)',
                          border: 'none',
                          cursor: registering ? 'wait' : 'pointer',
                        }}
                      >
                        {t('firstRunWizard.registerMcpButton')}
                      </button>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Sample task block */}
            <SampleTaskBlock
              uiState={ui}
              sampleState={sampleState}
              completedAt={result.completedAt}
              onTry={handleTrySampleTask}
              onFallbackContinue={handleFallbackContinue}
            />

            {/* Footer */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => void dismiss()}
                data-testid="first-run-wizard-skip"
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-subtle)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {t('firstRunWizard.skipButton')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-blocks (exported for unit tests) ─────────────────────────────────────

export function ClaudeStatusBlock({
  claudeFound,
  mcpRegistered,
  registering,
  onRegister,
}: {
  claudeFound: boolean;
  mcpRegistered: boolean;
  registering: boolean;
  onRegister: () => void;
}) {
  const t = useT();

  if (!claudeFound) {
    return (
      <div
        className="flex flex-col gap-2"
        data-testid="first-run-wizard-claude-missing"
      >
        <p className="text-sm" style={{ color: 'var(--text-main)', margin: 0 }}>
          ⚠ {t('firstRunWizard.claudeNotDetected')}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-sub)', margin: 0 }}>
          {t('firstRunWizard.claudeInstallHint')}
        </p>
        <a
          href="https://claude.ai/code"
          onClick={(e) => {
            e.preventDefault();
            void shellOpenExternal('https://claude.ai/code').catch(() => undefined);
          }}
          className="text-xs underline self-start"
          style={{ color: 'var(--accent-blue)' }}
          data-testid="first-run-wizard-install-link"
        >
          claude.ai/code
        </a>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="first-run-wizard-claude-detected"
    >
      <p className="text-sm" style={{ color: 'var(--text-main)', margin: 0 }}>
        ✓ {t('firstRunWizard.claudeDetected')}
      </p>
      {mcpRegistered ? (
        <p
          className="text-xs"
          style={{ color: 'var(--text-sub)', margin: 0 }}
          data-testid="first-run-wizard-mcp-registered"
        >
          ✓ {t('firstRunWizard.mcpRegistered')}
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <p
            className="text-xs"
            style={{ color: 'var(--text-sub)', margin: 0 }}
            data-testid="first-run-wizard-mcp-not-registered"
          >
            {t('firstRunWizard.mcpNotRegistered')}
          </p>
          <button
            onClick={onRegister}
            disabled={registering}
            data-testid="first-run-wizard-register"
            className="px-3 py-1 rounded text-xs font-medium"
            style={{
              backgroundColor: 'var(--accent-blue)',
              color: 'var(--bg-base)',
              border: 'none',
              cursor: registering ? 'wait' : 'pointer',
              opacity: registering ? 0.7 : 1,
            }}
          >
            {t('firstRunWizard.registerMcpButton')}
          </button>
        </div>
      )}
    </div>
  );
}

export function SampleTaskBlock({
  uiState,
  sampleState,
  completedAt,
  onTry,
  onFallbackContinue,
}: {
  uiState: WizardUiState | null;
  sampleState: SampleSubState;
  completedAt: string | undefined;
  onTry: () => void;
  onFallbackContinue: () => void;
}) {
  const t = useT();

  const enabled = uiState === 'ready' && sampleState === 'idle';
  const isReopen = uiState === 'reopen';
  const date = formatCompletedAt(completedAt);

  // Sample task in progress — show progress states.
  if (sampleState === 'splitting' || sampleState === 'awaiting-prompt') {
    return (
      <div
        className="flex flex-col gap-2 p-3 rounded-lg"
        style={{ backgroundColor: 'var(--bg-surface)' }}
        data-testid="first-run-wizard-sample-running"
      >
        <p className="text-sm font-semibold" style={{ color: 'var(--text-main)', margin: 0 }}>
          {t('firstRunWizard.sampleTaskHeading')}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-sub)', margin: 0 }}>
          {sampleState === 'splitting'
            ? t('firstRunWizard.sampleTaskDescription')
            : t('firstRunWizard.sampleTaskDescription')}
        </p>
      </div>
    );
  }

  if (sampleState === 'success') {
    return (
      <div
        className="flex flex-col gap-2 p-3 rounded-lg"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--accent-green, #a6e3a1)',
        }}
        data-testid="first-run-wizard-sample-success"
      >
        <p className="text-sm font-semibold" style={{ color: 'var(--text-main)', margin: 0 }}>
          ✓ {t('firstRunWizard.sampleTaskHeading')}
        </p>
      </div>
    );
  }

  if (sampleState === 'timeout-fallback') {
    return (
      <div
        className="flex flex-col gap-2 p-3 rounded-lg"
        style={{ backgroundColor: 'var(--bg-surface)' }}
        data-testid="first-run-wizard-sample-fallback"
      >
        <p className="text-sm" style={{ color: 'var(--text-main)', margin: 0 }}>
          {t('firstRunWizard.fallbackPressEnter')}
        </p>
        <button
          onClick={onFallbackContinue}
          data-testid="first-run-wizard-fallback-continue"
          className="self-start px-3 py-1 rounded text-xs font-medium"
          style={{
            backgroundColor: 'var(--accent-blue)',
            color: 'var(--bg-base)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {t('firstRunWizard.fallbackButton')}
        </button>
      </div>
    );
  }

  if (sampleState === 'error') {
    return (
      <div
        className="flex flex-col gap-2 p-3 rounded-lg"
        style={{ backgroundColor: 'var(--bg-surface)' }}
        data-testid="first-run-wizard-sample-error"
      >
        <p className="text-sm" style={{ color: 'var(--text-main)', margin: 0 }}>
          {t('firstRunWizard.error.UNKNOWN.problem')}
        </p>
      </div>
    );
  }

  // idle — render the trigger / disabled trigger.
  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-lg"
      style={{ backgroundColor: 'var(--bg-surface)' }}
      data-testid="first-run-wizard-sample-idle"
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--text-main)', margin: 0 }}>
        {t('firstRunWizard.sampleTaskHeading')}
      </p>
      <p className="text-xs" style={{ color: 'var(--text-sub)', margin: 0 }}>
        {isReopen
          ? t('firstRunWizard.alreadyCompleted', { date: date || '—' })
          : t('firstRunWizard.sampleTaskDescription')}
      </p>
      <button
        onClick={onTry}
        disabled={!enabled}
        data-testid="first-run-wizard-try"
        className="self-start px-3 py-1 rounded text-xs font-medium"
        style={{
          backgroundColor: enabled ? 'var(--accent-blue)' : 'var(--bg-overlay)',
          color: enabled ? 'var(--bg-base)' : 'var(--text-subtle)',
          border: 'none',
          cursor: enabled ? 'pointer' : 'not-allowed',
          opacity: enabled ? 1 : 0.6,
        }}
      >
        {t('firstRunWizard.tryItButton')}
      </button>
    </div>
  );
}
