// A bot's skills in its profile: each row says where the skill stands in the
// owner's words, an approved skill's card no longer reads "recorded only",
// and every string is in en, ko, pl and zh.

import { describe, expect, it } from 'vitest';
import { en } from '../../../i18n/locales/en';
import { skillStateText } from '../BotSkills';
import { approvalPhase, type ApprovalView } from '../../Room/approvalsStore';

const t = (key: string, vars?: Record<string, string | number>) => {
  const text = (en as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`));
};

describe('bot profile: skills', () => {
  it('says where each skill stands', () => {
    expect(skillStateText({ name: 'a', state: 'proposed', proposed: { version: '1.0.0', description: 'd', at: 1 }, updatedAt: 1 }, t)).toBe('waiting for your approval (1.0.0)');
    expect(skillStateText({ name: 'a', state: 'approved', version: '1.0.0', description: 'd', updatedAt: 1 }, t)).toBe('approved 1.0.0');
    expect(skillStateText({ name: 'a', state: 'approved', version: '1.0.0', description: 'd', proposed: { version: '1.1.0', description: 'd', at: 1 }, updatedAt: 1 }, t))
      .toBe('approved 1.0.0 · update 1.1.0 waiting for your approval');
    expect(skillStateText({ name: 'a', state: 'archived', updatedAt: 1 }, t)).toBe('archived');
    expect(skillStateText({ name: 'a', state: 'approved', version: '1.0.0', description: 'd', changed: true, updatedAt: 1 }, t))
      .toBe('approved 1.0.0 · changed since approval — not loaded until the bot proposes it again');
  });

  it('an approved skill card is done, not "recorded only"', () => {
    const r = { action: 'skill', state: 'approved', decidedBy: 'owner' } as ApprovalView;
    expect(approvalPhase(r, 0)).toEqual({ phase: 'approved', byRule: false, recordedOnly: false });
    expect(approvalPhase({ ...r, action: 'comment' } as ApprovalView, 0)).toMatchObject({ recordedOnly: true });
  });

  it('every skill string is in en, ko, pl and zh', async () => {
    const { ko } = await import('../../../i18n/locales/ko');
    const { pl } = await import('../../../i18n/locales/pl');
    const { zh } = await import('../../../i18n/locales/zh');
    const keys = Object.keys(en).filter((k) => k.startsWith('botsPage.profile.skill') || k === 'botsPage.canDo.skills' || k === 'room.approval.action.skill');
    expect(keys.length).toBe(11);
    for (const locale of [ko, pl, zh] as Record<string, string>[]) for (const k of keys) expect(locale[k], k).toBeTruthy();
  });
});
