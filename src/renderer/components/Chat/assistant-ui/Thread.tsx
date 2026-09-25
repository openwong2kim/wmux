// Adapted from assistant-ui's MIT-licensed registry Thread:
// https://r.assistant-ui.com/thread.json (2026-09-21). See ./LICENSE.
// Keep its 44rem column, viewport footer, composer and scroll-to-latest control;
// the thread anchors to the bottom (no top-anchor reserve, 2026-09-25).
// wmux supplies transcript rows, session notices, composer attachments and Stop;
// unsupported backend actions (regeneration, editing and voice) are not exposed.
import { useState, type ReactNode } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useT } from '../../../hooks/useT';
import { ChatComposerInput, type ChatComposerKeys, type SkillComposer, type ChatSkillScope } from '../ChatComposerInput';
import { ChatMessage } from '../ChatMessage';

const MESSAGE_COMPONENTS = { Message: ChatMessage };

export function Thread({ status, empty, welcome, history, notices, working, disabled, placeholder, composerOptions, maxLength, skillScope, composer,
  pending, attachments, hint, stop, keys }: {
  status?: ReactNode; empty: boolean; welcome: ReactNode; history: ReactNode; notices: ReactNode;
  working: boolean; disabled: boolean; placeholder?: string; composerOptions?: ReactNode; maxLength?: number; skillScope?: ChatSkillScope; composer: SkillComposer;
  /** Sent messages the transcript has not recorded yet. */
  pending?: ReactNode; attachments?: ReactNode; hint?: string; stop?: ReactNode; keys?: ChatComposerKeys;
}) {
  const t = useT();
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  return <ThreadPrimitive.Root className="wmux-chat aui-thread-root" data-chat-view>
    {status}
    <ThreadPrimitive.Viewport className="wmux-chat-viewport" autoScroll>
      <div className="wmux-chat-column" data-empty={empty}>
        {history}
        {welcome}
        <div className="wmux-chat-messages">
          <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
          {pending}
          {working && <div className="wmux-chat-working" role="status"><span aria-hidden="true">●</span>{t('chat.working')}</div>}
        </div>
        <ThreadPrimitive.ViewportFooter className="wmux-chat-footer" data-empty={empty}>
          <ThreadPrimitive.ScrollToBottom className="wmux-chat-scroll wmux-chat-icon-button" aria-label={t('chat.scrollToBottom')} title={t('chat.scrollToBottom')}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg>
          </ThreadPrimitive.ScrollToBottom>
          {notices}
          <ComposerPrimitive.Root className="wmux-chat-composer aui-composer-root">
            {composerOptions}
            {attachments}
            <ChatComposerInput composer={composer} onDiscoveryOpenChange={setDiscoveryOpen} scope={skillScope} disabled={disabled} placeholder={placeholder ?? t('chat.placeholder')} maxLength={maxLength ?? 16_000} keys={keys} />
            <div className="wmux-chat-composer-footer"><span>{hint ?? t(skillScope && ['claude', 'codex'].includes(skillScope.agent) ? 'chat.inputSkillsHint' : 'chat.inputHint')}</span>
              {stop}
              <ComposerPrimitive.Send disabled={discoveryOpen} className="wmux-chat-send wmux-chat-icon-button" aria-label={t('chat.send')} title={t('chat.send')}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </div>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>;
}
