// The floating quick-launch composer: a prompt, three pickers and Start.
//
// UI and flow adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/quick-composer/ui/QuickComposer.tsx), MIT License,
// Copyright (c) 2026 Nick: prompt on top, one control row underneath, the
// draft surviving a dismiss, every show refreshing the choices and focusing
// the prompt, and the window sized to the card.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { QuickLaunchCheckout, QuickLaunchContext } from '../../shared/quickLaunch';
import type { CustomThemeColors } from '../../shared/types';
import { setLocale, t, type Locale } from '../i18n';
import { applyCustomCssVars, clearCustomCssVars } from '../themes';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import SegmentedControl from '../components/ui/SegmentedControl';
import { agentValue, composerKeyAction, initialWorkspace, parseAgentValue, type ComposerChoice } from './composerModel';

const CHOICE_KEY = 'wmux.quickLaunch.choice';
const PROMPT_MAX_HEIGHT = 240;

function loadChoice(): Partial<ComposerChoice> {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    return raw ? (JSON.parse(raw) as Partial<ComposerChoice>) : {};
  } catch {
    return {};
  }
}

function saveChoice(choice: ComposerChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // A convenience only.
  }
}

function applyTheme(ctx: QuickLaunchContext): void {
  const theme = ctx.theme ?? 'amber';
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'custom' && ctx.customThemeColors) applyCustomCssVars(ctx.customThemeColors as CustomThemeColors);
  else clearCustomCssVars();
}

export default function QuickLaunchComposer() {
  const api = window.quickLaunchAPI;
  const [ctx, setCtx] = useState<QuickLaunchContext | null>(null);
  const [prompt, setPrompt] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [agent, setAgent] = useState('default');
  const [checkout, setCheckout] = useState<QuickLaunchCheckout>('current');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const seeded = useRef(false);

  const focusPrompt = useCallback(() => {
    requestAnimationFrame(() => {
      const field = promptRef.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }, []);

  // Workspaces and the theme can change in the main window between shows, so
  // every show re-reads them. The draft is kept.
  const refresh = useCallback(async () => {
    setError(null);
    focusPrompt();
    const next = await api.context().catch(() => null);
    if (!next) return;
    if (next.locale) setLocale(next.locale as Locale);
    applyTheme(next);
    const remembered = loadChoice();
    setCtx(next);
    setWorkspaceId((current) =>
      initialWorkspace(next.workspaces, current ?? remembered.workspaceId, next.activeWorkspaceId),
    );
    // The last launch's choices seed the first show only; after that, what
    // the person picked stays picked across a dismiss, like the draft.
    if (!seeded.current) {
      seeded.current = true;
      if (remembered.agent) setAgent(remembered.agent);
      if (remembered.checkout) setCheckout(remembered.checkout);
    }
  }, [api, focusPrompt]);

  useEffect(() => {
    void refresh();
    return api.onShown(() => void refresh());
  }, [api, refresh]);

  // The window is exactly the card.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => void api.fit(Math.ceil(card.getBoundingClientRect().height)));
    observer.observe(card);
    return () => observer.disconnect();
  }, [api]);

  useLayoutEffect(() => {
    const field = promptRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, PROMPT_MAX_HEIGHT)}px`;
  }, [prompt]);

  const usable = ctx?.workspaces.filter((w) => w.cwd) ?? [];
  const canSubmit = !busy && prompt.trim().length > 0 && Boolean(workspaceId);

  const submit = async () => {
    if (!canSubmit || !workspaceId) return;
    setBusy(true);
    setError(null);
    const result = await api
      .submit({ prompt, workspaceId, agent: parseAgentValue(agent), checkout })
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      focusPrompt();
      return;
    }
    saveChoice({ workspaceId, agent, checkout });
    setPrompt('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = composerKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.nativeEvent.keyCode,
    });
    if (!action) return;
    // Enter only submits from the prompt; on a picker it keeps its own meaning.
    if (action === 'submit' && e.target !== promptRef.current) return;
    e.preventDefault();
    if (action === 'dismiss') void api.dismiss();
    else void submit();
  };

  return (
    <div ref={cardRef} className="quick-launch ui-surface" onKeyDown={onKeyDown}>
      <textarea
        ref={promptRef}
        className="quick-launch-prompt"
        value={prompt}
        rows={2}
        spellCheck
        disabled={busy}
        placeholder={usable.length > 0 || !ctx ? t('quickLaunch.placeholder') : t('quickLaunch.noWorkspace')}
        aria-label={t('quickLaunch.prompt')}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="quick-launch-controls">
        <Select
          className="quick-launch-select"
          aria-label={t('quickLaunch.workspace')}
          value={workspaceId ?? ''}
          disabled={busy || usable.length === 0}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          {usable.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
        <Select
          className="quick-launch-select"
          aria-label={t('quickLaunch.agent')}
          value={agent}
          disabled={busy}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="default">{t('quickLaunch.agentDefault')}</option>
          {ctx && ctx.roles.length > 0 && (
            <optgroup label={t('quickLaunch.roles')}>
              {ctx.roles.map((role) => (
                <option key={role} value={agentValue({ kind: 'role', role })}>{role}</option>
              ))}
            </optgroup>
          )}
          {ctx && ctx.agents.length > 0 && (
            <optgroup label={t('quickLaunch.agents')}>
              {ctx.agents.map((a) => (
                <option key={a.stem} value={agentValue({ kind: 'agent', agent: a.stem })}>{a.label}</option>
              ))}
            </optgroup>
          )}
        </Select>
        <SegmentedControl<QuickLaunchCheckout>
          ariaLabel={t('quickLaunch.checkout')}
          value={checkout}
          onValueChange={setCheckout}
          options={[
            { value: 'current', label: t('quickLaunch.current'), disabled: busy },
            { value: 'worktree', label: t('quickLaunch.worktree'), disabled: busy },
          ]}
        />
        <span className="quick-launch-status" role={error ? 'alert' : undefined} title={error ?? undefined}>
          {error ? <span className="quick-launch-error">{error}</span> : busy ? t('quickLaunch.starting') : null}
        </span>
        <Button variant="primary" size="sm" aria-keyshortcuts="Enter" disabled={!canSubmit} onClick={() => void submit()}>
          {t('quickLaunch.start')}
        </Button>
      </div>
    </div>
  );
}
