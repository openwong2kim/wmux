// Adapted from assistant-ui's MIT-licensed registry Thread:
// https://r.assistant-ui.com/thread.json (2026-09-21). See ./LICENSE.
// Keep its 44rem column, viewport footer, composer and scroll anchor structure.
// wmux supplies transcript rows and session notices; unsupported backend actions
// (attachments, regeneration, editing and voice) are deliberately not exposed.
import { useState, type ReactNode } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useT } from '../../../hooks/useT';
import { ChatComposerInput, type SkillComposer, type ChatSkillScope } from '../ChatComposerInput';
import { ChatMessage } from '../ChatMessage';

const MESSAGE_COMPONENTS = { Message: ChatMessage };

export function Thread({ status, empty, welcome, history, notices, working, disabled, placeholder, composerOptions, maxLength, skillScope, composer }: {
  status?: ReactNode; empty: boolean; welcome: ReactNode; history: ReactNode; notices: ReactNode;
  working: boolean; disabled: boolean; placeholder?: string; composerOptions?: ReactNode; maxLength?: number; skillScope?: ChatSkillScope; composer: SkillComposer;
}) {
  const t = useT();
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  return <ThreadPrimitive.Root className="wmux-chat aui-thread-root" data-chat-view>
    {status}
    <ThreadPrimitive.Viewport className="wmux-chat-viewport" turnAnchor="top" autoScroll>
      <div className="wmux-chat-column" data-empty={empty}>
        {history}
        {welcome}
        <div className="wmux-chat-messages">
          <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
          {working && <div className="wmux-chat-working" role="status"><span aria-hidden="true">●</span>{t('chat.working')}</div>}
        </div>
        <ThreadPrimitive.ViewportFooter className="wmux-chat-footer" data-empty={empty}>
          <ThreadPrimitive.ScrollToBottom className="wmux-chat-scroll wmux-chat-icon-button" aria-label={t('chat.scrollToBottom')} title={t('chat.scrollToBottom')}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg>
          </ThreadPrimitive.ScrollToBottom>
          {notices}
          <ComposerPrimitive.Root className="wmux-chat-composer aui-composer-root">
            {composerOptions}
            <ChatComposerInput composer={composer} onDiscoveryOpenChange={setDiscoveryOpen} scope={skillScope} disabled={disabled} placeholder={placeholder ?? t('chat.placeholder')} maxLength={maxLength ?? 16_000} />
            <div className="wmux-chat-composer-footer"><span>{t(skillScope && ['claude', 'codex'].includes(skillScope.agent) ? 'chat.inputSkillsHint' : 'chat.inputHint')}</span>
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
