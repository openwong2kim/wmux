// Small talk is not work: a thank-you or a greeting alone must not open an
// [active-work] record (deck.handler beginTrackedWork). Its own module so the
// many tests that mock the work store need not know about it.

// A thank-you or a greeting, alone. Thanks and greetings only: a bare "ok",
// "네" or "좋아" can be the operator agreeing to go ahead, which is a request.
const SMALL_TALK_WORDS = [
  // Korean
  '고마워(?:요)?', '고맙(?:다|네|네요|습니다|어요)', '감사(?:해|해요|합니다|하다|드려요|드립니다)?', '땡큐', 'ㄱㅅ', 'ㄳ',
  '수고(?:했어|했어요|하셨어요|하셨습니다|해|해요|많았어|많았어요|하세요)?', '안녕(?:하세요|하십니까)?', '반가워(?:요)?',
  '잘했어(?:요)?', '최고(?:야|예요|에요)?', '멋져(?:요)?', '굿', '덕분(?:이야|이에요|입니다)?', '정말', '진짜', '너무', '많이', '아주',
  // English
  'thanks?', 'thank\\s+you', 'thx', 'ty', 'tysm', 'cheers', 'much\\s+appreciated', 'appreciated?', 'hi', 'hello', 'hey',
  'good\\s+(?:morning|afternoon|evening|night|job|work)', 'nice\\s+(?:job|work|one)', 'well\\s+done', 'great(?:\\s+job)?',
  'awesome', 'so', 'much', 'very', 'a\\s+lot', 'moa',
];
const SMALL_TALK_RE = new RegExp(`^(?:(?:${SMALL_TALK_WORDS.join('|')})\\s*)+$`, 'iu');
/** A message of laughter, emoji and punctuation only. */
const LAUGHTER_ONLY_RE = /^(?:[ㅋㅎㅠㅜ^~.!?\s]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\b(?:lol|lmao|haha+|hehe+|ha|kk+)\b)+$/iu;
/** Longest message still read as small talk; longer text says something more. */
const SMALL_TALK_MAX_CHARS = 40;

/** A thank-you or greeting with nothing asked: not work. Such a message must
 *  not open (or extend) an [active-work] record, or Moa would report it done. */
export function isSmallTalk(text: string): boolean {
  // Laughter or emoji alone (ㅋㅋㅋ, lol, 👍) asks for nothing either.
  if (text.trim() && LAUGHTER_ONLY_RE.test(text.normalize('NFC').trim())) return true;
  const t = text
    // NFC, not NFKC: NFKC turns ㄱㅅ / ㅋㅋ into conjoining jamo.
    .normalize('NFC')
    // Punctuation, symbols and emoji carry no request.
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}~]+/gu, ' ')
    .replace(/[ㅋㅎㅠㅜ^]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || [...t].length > SMALL_TALK_MAX_CHARS) return false;
  return SMALL_TALK_RE.test(t);
}
