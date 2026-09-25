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
import { isInstallTake } from '../../shared/statuslineOutcome';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import Button from './ui/Button';
import MediaPreview from './ui/MediaPreview';
import { MEDIA_CLIPS } from '../assets/media';
import { IconCheck, IconWarning } from './icons';
import { FOCUS_RING } from './focusRing';

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

// Statusline bridge (preload `deck.statuslineBridge`). Optional: older preloads
// may not expose it, so the accessor returns null instead of throwing and the
// wizard simply hides the statusline offer.
interface StatuslineBridge {
  status: () => Promise<{
    installed: boolean;
    outcome: {
      scriptDest: string;
      scriptExists: boolean;
      targets: Array<{ label: string; settingsPath: string; state: StatuslineTargetState }>;
    };
  }>;
  install: () => Promise<{
    ok: boolean;
    error: string | null;
    targets: Array<{ label: string; settingsPath: string; outcome: string }>;
  }>;
}

export type StatuslineTargetState = 'none' | 'wmux' | 'foreign' | 'corrupt' | 'missing';

// Hook bridge (preload `deck.hooksBridge`). Same shape of contract as the
// statusline: an opt-in install the user clicks, never an edit behind their
// back. Unlike the statusline this one is not cosmetic — without it every
// lifecycle signal degrades to the regex detector, so the wizard is the one
// place a new install is guaranteed to see the offer.
interface HooksBridge {
  status: () => Promise<{ installed: boolean }>;
  install: () => Promise<{ ok: boolean; error: string | null }>;
}

/** Exported for the same contract test as {@link statuslineBridge}. */
export function hooksBridge(): HooksBridge | null {
  const api = (window as unknown as {
    electronAPI?: { deck?: { hooksBridge?: HooksBridge } };
  }).electronAPI;
  return api?.deck?.hooksBridge ?? null;
}

// Exported for the contract test: the accessor and the preload must agree on
// where the bridge lives, and reading the wrong path fails silently by design.
export function statuslineBridge(): StatuslineBridge | null {
  // The bridge lives under `deck` (preload.ts) — reading it off the root of
  // electronAPI returned undefined in every real build, and the "older preload"
  // fallback below turned that into silence: the statusline offer has never
  // rendered outside tests. Read the real path, keep the null fallback for
  // preloads that genuinely predate the bridge.
  const api = (window as unknown as {
    electronAPI?: { deck?: { statuslineBridge?: StatuslineBridge } };
  }).electronAPI;
  return api?.deck?.statuslineBridge ?? null;
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

/**
 * Whether the wizard should offer the statusline install.
 *
 * Hidden when already installed, and when no target could accept an install
 * (every settings.json is foreign-owned or corrupt) — offering a button that
 * can only no-op would be noise. 'none'/'missing' targets are installable
 * (install creates missing settings files).
 */
export function decideStatuslineOffer(status: {
  installed: boolean;
  outcome: { targets: Array<{ state: StatuslineTargetState }> };
} | null): 'offer' | 'hidden' {
  if (!status) return 'hidden';
  if (status.installed) return 'hidden';
  const installable = status.outcome.targets.some(
    (t) => t.state === 'none' || t.state === 'missing',
  );
  return installable ? 'offer' : 'hidden';
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

export type StatuslineSubState =
  | 'unknown'   // status not fetched yet (or bridge unavailable) — block hidden
  | 'offer'     // installable, waiting for the user's click
  | 'installing'
  | 'installed'
  | 'error';

/** Same lifecycle as the statusline block; `unknown` keeps it hidden. */
export type HooksSubState = StatuslineSubState;

const PTYID_WAIT_TIMEOUT_MS = 10_000;

export default function FirstRunWizard({ mode, onClose }: FirstRunWizardProps) {
  const t = useT();

  const [result, setResult] = useState<FirstRunCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<
    { code: RegisterMcpErrorCode; message: string } | null
  >(null);
  const [sampleState, setSampleState] = useState<SampleSubState>('idle');
  const [statuslineState, setStatuslineState] = useState<StatuslineSubState>('unknown');
  const [statuslineError, setStatuslineError] = useState<string | null>(null);
  const [hooksState, setHooksState] = useState<HooksSubState>('unknown');
  const [hooksError, setHooksError] = useState<string | null>(null);

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

  // ─── Statusline offer (opt-in; never auto-installs — owner decision 2026-07-17) ──
  // Fetched once on mount; the block renders only when Claude is detected AND
  // there is at least one installable settings target.
  useEffect(() => {
    const bridge = statuslineBridge();
    if (!bridge) return;
    bridge
      .status()
      .then((s) => {
        if (!isMountedRef.current) return;
        setStatuslineState(decideStatuslineOffer(s) === 'offer' ? 'offer' : 'unknown');
      })
      .catch(() => {
        // Status probe failing is not worth surfacing — just keep the block hidden.
      });
  }, []);

  // ─── Hook bridge offer ─────────────────────────────────────────────────────
  // Already-installed shows as a ✓ line rather than hiding: this one is a
  // REQUIREMENT, and a first-run checklist that silently omits its most
  // important item teaches the operator it does not exist.
  useEffect(() => {
    const bridge = hooksBridge();
    if (!bridge) return;
    bridge
      .status()
      .then((s) => {
        if (!isMountedRef.current) return;
        setHooksState(s.installed ? 'installed' : 'offer');
      })
      .catch(() => {
        // Probe failure is not worth surfacing — keep the block hidden.
      });
  }, []);

  const handleInstallHooks = useCallback(async () => {
    const bridge = hooksBridge();
    if (!bridge) return;
    setHooksState('installing');
    setHooksError(null);
    try {
      const outcome = await bridge.install();
      if (!isMountedRef.current) return;
      if (outcome.ok) {
        setHooksState('installed');
      } else {
        setHooksError(outcome.error);
        setHooksState('error');
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setHooksError(err instanceof Error ? err.message : null);
      setHooksState('error');
    }
  }, []);

  const handleInstallStatusline = useCallback(async () => {
    const bridge = statuslineBridge();
    if (!bridge) return;
    setStatuslineState('installing');
    setStatuslineError(null);
    try {
      const outcome = await bridge.install();
      if (!isMountedRef.current) return;
      // ok:true still means "nothing broke", not "something was installed" —
      // every target can be skipped (foreign/corrupt) if settings changed
      // between the status probe and the click. Only report success when a
      // target actually took the install.
      const installedSomewhere = outcome.targets.some((t) => isInstallTake(t.outcome));
      if (outcome.ok && installedSomewhere) {
        setStatuslineState('installed');
      } else {
        setStatuslineError(outcome.error);
        setStatuslineState('error');
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatuslineError(err instanceof Error ? err.message : null);
      setStatuslineState('error');
    }
  }, []);

  // ─── Dismiss ───────────────────────────────────────────────────────────────
  // Escape, the close button and focus handling come from <Dialog>: Escape is
  // caught in the capture phase (so a focused terminal cannot swallow it) and
  // focus starts on the close button and returns to the opener afterwards.
  const dismiss = useCallback(async () => {
    try {
      await firstRunBridge().dismiss();
    } catch {
      // ignore — closing is best-effort
    }
    onCloseRef.current();
  }, []);

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
  const primary = decidePrimaryAction({
    uiState: ui,
    claudeFound: result?.status.claudeFound ?? false,
    mcpRegistered: result?.status.mcpRegistered ?? false,
    registering,
    hooksState: result?.status.claudeFound ? hooksState : 'unknown',
    sampleState,
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog
      onClose={() => void dismiss()}
      width={500}
      initialFocusRef={firstFocusRef}
      data-testid="first-run-wizard"
      backdropTestId="first-run-wizard-backdrop"
    >
      <DialogHeader
        ref={firstFocusRef}
        title={t('firstRunWizard.title')}
        description={t('firstRunWizard.subtitle')}
        closeLabel={t('firstRunWizard.closeButton')}
        closeTestId="first-run-wizard-close"
      />

      <DialogBody>
        {loading && (
          <div
            className="text-[13px]"
            style={{ color: 'var(--text-muted)' }}
            data-testid="first-run-wizard-loading"
          >
            …
          </div>
        )}

        {!loading && result && (
          <>
            {/* Setup checklist: one grouped container, one row per item. Rows
                that need an action are notice rows with the action on the right. */}
            <div className="ui-group" data-testid="first-run-wizard-checklist">
              <ClaudeStatusBlock
                claudeFound={result.status.claudeFound}
                mcpRegistered={result.status.mcpRegistered}
                registering={registering}
                onRegister={handleRegister}
                primary={primary === 'register'}
              />

              {/* Hook bridge — the required half of the integration. Shown even
                  when already installed, as a check, so the checklist is complete. */}
              {result.status.claudeFound && hooksState !== 'unknown' && (
                <HooksBlock
                  state={hooksState}
                  errorDetail={hooksError}
                  onInstall={() => void handleInstallHooks()}
                  primary={primary === 'hooks'}
                />
              )}

              {/* Statusline opt-in (only when Claude detected & installable) */}
              {result.status.claudeFound && statuslineState !== 'unknown' && (
                <StatuslineBlock
                  state={statuslineState}
                  errorDetail={statuslineError}
                  onInstall={() => void handleInstallStatusline()}
                />
              )}
            </div>

            {/* Tier 2 inline registration error (D10) */}
            {registerError && (
              <div
                role="alert"
                data-testid="first-run-wizard-register-error"
                className="wmux-welcome-alert"
              >
                {(() => {
                  const keys = getRegisterErrorKeys(registerError.code);
                  return (
                    <>
                      <p className="ui-row-title">{t(keys.problem)}</p>
                      <p className="ui-row-detail">{withInlineCode(t(keys.cause))}</p>
                      <p className="ui-row-detail">{withInlineCode(t(keys.fix))}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleRegister()}
                        disabled={registering}
                        data-testid="first-run-wizard-register-retry"
                        className="self-start mt-2"
                      >
                        {t('firstRunWizard.registerMcpButton')}
                      </Button>
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
              primary={primary === 'try' || primary === 'fallback'}
            />
          </>
        )}
      </DialogBody>

      {!loading && result && (
        <DialogFooter>
          <Button
            size="md"
            variant="ghost"
            onClick={() => void dismiss()}
            data-testid="first-run-wizard-skip"
          >
            {t('firstRunWizard.skipButton')}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}

/**
 * Which action gets the dialog's single solid (primary) button. DESIGN.md:
 * at most one filled warm action per surface, and never one that is disabled
 * or already running. Order follows what unblocks the operator first: the
 * timeout fallback's Continue, then MCP registration, then the required hook
 * install, then the sample task. While any of those is in flight, nothing is
 * primary — the emphasis does not jump to the next step mid-install. The
 * optional statusline offer is never primary.
 */
export type WizardPrimaryAction = 'fallback' | 'register' | 'hooks' | 'try' | null;

export function decidePrimaryAction({
  uiState,
  claudeFound,
  mcpRegistered,
  registering,
  hooksState,
  sampleState,
}: {
  uiState: WizardUiState | null;
  claudeFound: boolean;
  mcpRegistered: boolean;
  registering: boolean;
  hooksState: HooksSubState;
  sampleState: SampleSubState;
}): WizardPrimaryAction {
  if (sampleState === 'timeout-fallback') return 'fallback';
  if (sampleState === 'splitting' || sampleState === 'awaiting-prompt') return null;
  // Read from the check result, not uiState: reopen mode still offers Register.
  if (claudeFound && !mcpRegistered) return registering ? null : 'register';
  if (hooksState === 'installing') return null;
  if (hooksState === 'offer' || hooksState === 'error') return 'hooks';
  if (uiState === 'ready' && sampleState === 'idle') return 'try';
  return null;
}

/**
 * Renders `backtick` spans as mono code — commands are machine evidence.
 * Only balanced pairs become code: a stray backtick (an odd count, e.g. from a
 * translation) stays literal instead of turning the rest of the text to code.
 */
export function withInlineCode(text: string): React.ReactNode {
  const parts = text.split('`');
  if (parts.length < 3) return text;
  if (parts.length % 2 === 0) {
    // Odd number of backticks: the last one has no partner.
    const tail = parts.pop() as string;
    parts[parts.length - 1] = `${parts[parts.length - 1]}\`${tail}`;
    if (parts.length < 3) return parts[0];
  }
  return parts.map((part, i) =>
    i % 2 === 1 ? <code key={i} className="ui-code">{part}</code> : part,
  );
}

// ─── Sub-blocks (exported for unit tests) ─────────────────────────────────────

type RowStatus = 'ok' | 'todo' | 'warn' | 'error';

/**
 * One row of a grouped list: status icon, title + optional muted detail, and
 * for a notice row the action on the right behind a vertical divider.
 */
function SetupRow({
  status,
  title,
  detail,
  action,
  children,
  testId,
}: {
  status: RowStatus;
  title: React.ReactNode;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="ui-row" data-status={status} data-testid={testId}>
      <span className="ui-row-icon" aria-hidden="true">
        {status === 'ok' && <span className="wmux-welcome-glyph-ok"><IconCheck size={14} /></span>}
        {status === 'warn' && <span className="wmux-welcome-glyph-warn"><IconWarning size={14} /></span>}
        {status === 'error' && <span className="wmux-welcome-glyph-error"><IconWarning size={14} /></span>}
        {status === 'todo' && <span className="wmux-welcome-todo" />}
      </span>
      <div className="ui-row-text">
        <p className="ui-row-title">{title}</p>
        {detail != null && <p className="ui-row-detail">{detail}</p>}
        {children}
      </div>
      {action != null && <div className="ui-row-action">{action}</div>}
    </div>
  );
}

export function ClaudeStatusBlock({
  claudeFound,
  mcpRegistered,
  registering,
  onRegister,
  primary = true,
}: {
  claudeFound: boolean;
  mcpRegistered: boolean;
  registering: boolean;
  onRegister: () => void;
  /** Draw Register as the dialog's primary action (never while registering). */
  primary?: boolean;
}) {
  const t = useT();

  if (!claudeFound) {
    return (
      <SetupRow
        status="warn"
        testId="first-run-wizard-claude-missing"
        title={t('firstRunWizard.claudeNotDetected')}
        detail={t('firstRunWizard.claudeInstallHint')}
      >
        <a
          href="https://claude.ai/code"
          onClick={(e) => {
            e.preventDefault();
            void shellOpenExternal('https://claude.ai/code').catch(() => undefined);
          }}
          className={`wmux-welcome-link ${FOCUS_RING}`}
          data-testid="first-run-wizard-install-link"
        >
          claude.ai/code
        </a>
      </SetupRow>
    );
  }

  return (
    <div className="contents" data-testid="first-run-wizard-claude-detected">
      <SetupRow status="ok" title={t('firstRunWizard.claudeDetected')} />
      {mcpRegistered ? (
        <SetupRow
          status="ok"
          testId="first-run-wizard-mcp-registered"
          title={t('firstRunWizard.mcpRegistered')}
        />
      ) : (
        <SetupRow
          status="todo"
          testId="first-run-wizard-mcp-not-registered"
          title={t('firstRunWizard.mcpNotRegistered')}
          action={
            <Button
              size="sm"
              variant={primary && !registering ? 'primary' : 'ghost'}
              onClick={onRegister}
              disabled={registering}
              data-testid="first-run-wizard-register"
            >
              {t('firstRunWizard.registerMcpButton')}
            </Button>
          }
        />
      )}
    </div>
  );
}

export function HooksBlock({
  state,
  errorDetail,
  onInstall,
  primary = true,
}: {
  state: HooksSubState;
  errorDetail?: string | null;
  onInstall: () => void;
  /** Draw Install as the dialog's primary action (never while installing). */
  primary?: boolean;
}) {
  const t = useT();

  if (state === 'installed') {
    return (
      <SetupRow
        status="ok"
        testId="first-run-wizard-hooks-installed"
        title={t('firstRunWizard.hooksInstalled')}
        detail={t('firstRunWizard.hooksInstalledHint')}
      />
    );
  }

  const installing = state === 'installing';
  return (
    <SetupRow
      status={state === 'error' ? 'error' : 'todo'}
      testId="first-run-wizard-hooks-offer"
      title={t('firstRunWizard.hooksHeading')}
      detail={t('firstRunWizard.hooksDescription')}
      action={
        <Button
          size="sm"
          variant={primary && !installing ? 'primary' : 'ghost'}
          onClick={onInstall}
          disabled={installing}
          data-testid="first-run-wizard-hooks-install"
        >
          {installing ? t('firstRunWizard.hooksInstalling') : t('firstRunWizard.hooksEnableButton')}
        </Button>
      }
    >
      {state === 'error' && (
        <p className="ui-row-error" data-testid="first-run-wizard-hooks-error">
          {withInlineCode(t('firstRunWizard.hooksError'))}
          {errorDetail ? <> (<code className="ui-code">{errorDetail}</code>)</> : null}
        </p>
      )}
    </SetupRow>
  );
}

export function StatuslineBlock({
  state,
  errorDetail,
  onInstall,
}: {
  state: StatuslineSubState;
  errorDetail?: string | null;
  onInstall: () => void;
}) {
  const t = useT();

  if (state === 'installed') {
    return (
      <SetupRow
        status="ok"
        testId="first-run-wizard-statusline-installed"
        title={t('firstRunWizard.statuslineInstalled')}
        detail={t('firstRunWizard.statuslineInstalledHint')}
      />
    );
  }

  // Optional and cosmetic, so never the primary action. The clip spans the
  // full group width under the row: the statusline is one long line of small
  // text, unreadable at the width of the row's text column.
  return (
    <div>
      <SetupRow
        status={state === 'error' ? 'error' : 'todo'}
        testId="first-run-wizard-statusline-offer"
        title={t('firstRunWizard.statuslineHeading')}
        detail={t('firstRunWizard.statuslineDescription')}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={onInstall}
            disabled={state === 'installing'}
            data-testid="first-run-wizard-statusline-install"
          >
            {state === 'installing'
              ? t('firstRunWizard.statuslineInstalling')
              : t('firstRunWizard.statuslineEnableButton')}
          </Button>
        }
      >
        {state === 'error' && (
          <p className="ui-row-error" data-testid="first-run-wizard-statusline-error">
            {withInlineCode(t('firstRunWizard.statuslineError'))}
            {errorDetail ? <> (<code className="ui-code">{errorDetail}</code>)</> : null}
          </p>
        )}
      </SetupRow>
      <div className="px-3 pb-3">
        <MediaPreview
          clip={MEDIA_CLIPS.statusline}
          label={t('firstRunWizard.statuslineDescription')}
          className="wmux-welcome-statusline-clip"
          data-testid="first-run-wizard-statusline-preview"
        />
      </div>
    </div>
  );
}

/**
 * The sample task offer: a notice row (title + description ·
 * divider · action). Try / Continue are the dialog's primary only when
 * {@link decidePrimaryAction} says so, and never while disabled.
 */
export function SampleTaskBlock({
  uiState,
  sampleState,
  completedAt,
  onTry,
  onFallbackContinue,
  primary = true,
}: {
  uiState: WizardUiState | null;
  sampleState: SampleSubState;
  completedAt: string | undefined;
  onTry: () => void;
  onFallbackContinue: () => void;
  /** Draw Try / Continue as the dialog's primary action. */
  primary?: boolean;
}) {
  const t = useT();

  const enabled = uiState === 'ready' && sampleState === 'idle';
  const isReopen = uiState === 'reopen';
  const date = formatCompletedAt(completedAt);

  const frame = (testId: string, row: React.ReactNode) => (
    <section className="ui-group wmux-welcome-sample" data-testid={testId}>
      {row}
    </section>
  );

  // Sample task in progress — show progress states.
  if (sampleState === 'splitting' || sampleState === 'awaiting-prompt') {
    return frame(
      'first-run-wizard-sample-running',
      <div className="ui-row">
        <span className="ui-row-icon" aria-hidden="true"><span className="wmux-welcome-running-dot" /></span>
        <div className="ui-row-text">
          <p className="ui-row-title">{t('firstRunWizard.sampleTaskHeading')}</p>
          <p className="ui-row-detail">{t('firstRunWizard.sampleTaskDescription')}</p>
        </div>
      </div>,
    );
  }

  if (sampleState === 'success') {
    return frame(
      'first-run-wizard-sample-success',
      <SetupRow status="ok" title={t('firstRunWizard.sampleTaskHeading')} />,
    );
  }

  if (sampleState === 'timeout-fallback') {
    return frame(
      'first-run-wizard-sample-fallback',
      <SetupRow
        status="todo"
        title={t('firstRunWizard.fallbackPressEnter')}
        action={
          <Button
            size="sm"
            variant={primary ? 'primary' : 'secondary'}
            onClick={onFallbackContinue}
            data-testid="first-run-wizard-fallback-continue"
          >
            {t('firstRunWizard.fallbackButton')}
          </Button>
        }
      />,
    );
  }

  if (sampleState === 'error') {
    return frame(
      'first-run-wizard-sample-error',
      <SetupRow status="error" title={t('firstRunWizard.error.UNKNOWN.problem')} />,
    );
  }

  // idle — render the trigger / disabled trigger.
  return frame(
    'first-run-wizard-sample-idle',
    <div className="ui-row">
      <div className="ui-row-text">
        <h3 className="ui-row-title">{t('firstRunWizard.sampleTaskHeading')}</h3>
        <p className="ui-row-detail">
          {isReopen
            ? t('firstRunWizard.alreadyCompleted', { date: date || '—' })
            : t('firstRunWizard.sampleTaskDescription')}
        </p>
      </div>
      <div className="ui-row-action">
        <Button
          size="sm"
          variant={enabled && primary ? 'primary' : 'secondary'}
          onClick={onTry}
          disabled={!enabled}
          data-testid="first-run-wizard-try"
        >
          {t('firstRunWizard.tryItButton')}
        </Button>
      </div>
    </div>,
  );
}
