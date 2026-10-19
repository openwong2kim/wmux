import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';

// Since group chats replaced the automatic workspace room (2026-10-15), no
// owner-facing copy about the bots names a room, and a question's answer
// field no longer speaks of the orchestrator.
const ROOM_WORDS: Record<string, RegExp> = {
  en: /\broom\b|orchestrator/i,
  ko: /룸|방을|방에|오케스트레이터/,
  pl: /pok[oó]j|orkiestrator/i,
  zh: /房间|编排器/,
};
const KEYS = ['settings.factory.enabledDesc', 'botsPage.group.sameWorkspace', 'deck.decisionAnswerLabel'] as const;

describe('bots copy after group chats', () => {
  for (const [name, dict] of Object.entries({ en, ko, pl, zh }) as [string, Record<string, string>][]) {
    it(`${name}: no room or orchestrator wording`, () => {
      for (const key of KEYS) {
        expect(dict[key], key).toBeTruthy();
        expect(dict[key], key).not.toMatch(ROOM_WORDS[name]);
      }
    });
  }
});
