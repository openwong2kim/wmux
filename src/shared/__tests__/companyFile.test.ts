import { describe, it, expect } from 'vitest';
import { companyFileJson, normalizeCompanyFile, splitHiddenCharacters } from '../companyFile';
import { COMPANY_PRESET_MAX_SEATS, COMPANY_TEXT_MAX } from '../companyPreset';

const shop = {
  name: 'shop team',
  mission: 'Ship one-click refunds by Friday',
  standingOrders: 'The CEO plans and writes no code.\nEvery PR gets a review from #reviewer.',
  ceo: 'ceo',
  seats: [
    { name: 'ceo', owns: 'Plans and hands out the work', agent: 'claude' },
    { name: 'api', owns: 'Payments API', agent: 'codex' },
    { name: 'reviewer', agent: 'claude' },
  ],
};

const RLO = String.fromCharCode(0x202e);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const ESC = String.fromCharCode(0x1b);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const TAG_A = String.fromCodePoint(0xe0041);
const VARIATION_SELECTOR_17 = String.fromCodePoint(0xe0100);

describe('normalizeCompanyFile', () => {
  it('reads a company with its CEO named by seat', () => {
    expect(normalizeCompanyFile({ ...shop, ceo: 'Reviewer' })).toEqual({
      name: 'shop team',
      mission: 'Ship one-click refunds by Friday',
      standingOrders: 'The CEO plans and writes no code.\nEvery PR gets a review from #reviewer.',
      ceo: 2,
      seats: [
        { label: 'ceo', owns: 'Plans and hands out the work', agent: 'claude' },
        { label: 'api', owns: 'Payments API', agent: 'codex' },
        { label: 'reviewer', owns: '', agent: 'claude' },
      ],
    });
  });

  it('takes the first seat as CEO when none is named, and a seat with no agent as a plain shell', () => {
    const c = normalizeCompanyFile({ name: 'solo', seats: [{ name: 'lead' }, { name: 'notes', owns: 'Notes' }] });
    expect(c).toEqual({ name: 'solo', ceo: 0, seats: [{ label: 'lead', owns: '' }, { label: 'notes', owns: 'Notes' }] });
  });

  it('ignores keys it does not know, so a launch line in the file never reaches a seat', () => {
    const c = normalizeCompanyFile({
      ...shop,
      env: { TOKEN: 'x' },
      seats: [{ name: 'ceo', agent: 'claude', command: 'claude --dangerously-skip-permissions', cwd: '/etc' }],
    });
    expect(c?.seats).toEqual([{ label: 'ceo', owns: '', agent: 'claude' }]);
    expect(JSON.stringify(c)).not.toMatch(/dangerously|TOKEN|etc/);
  });

  it('reads back what companyFileJson writes', () => {
    const c = normalizeCompanyFile(shop)!;
    expect(companyFileJson(c)).toEqual(shop);
    expect(normalizeCompanyFile(companyFileJson(c))).toEqual(c);
  });

  it.each([
    ['an agent outside the registry', { ...shop, seats: [{ name: 'ceo', agent: 'my-own-agent' }] }],
    ['an agent that is not a slug', { ...shop, seats: [{ name: 'ceo', agent: { command: 'sh' } }] }],
    ['a CEO naming no seat', { ...shop, ceo: 'boss' }],
    ['a CEO that is not a name', { ...shop, ceo: 0 }],
    ['two seats with one name', { ...shop, ceo: 'dev', seats: [{ name: 'dev' }, { name: 'DEV' }] }],
    ['no seats', { ...shop, seats: [] }],
    ['too many seats', { ...shop, ceo: 's0', seats: Array.from({ length: COMPANY_PRESET_MAX_SEATS + 1 }, (_, i) => ({ name: `s${i}` })) }],
    ['seats that are not a list', { ...shop, seats: { ceo: {} } }],
    ['a seat name with a space', { ...shop, ceo: 'a b', seats: [{ name: 'a b' }] }],
    ['a seat name that is a pane coordinate', { ...shop, ceo: 'w1', seats: [{ name: 'w1' }] }],
    ['an empty name', { ...shop, name: '  ' }],
    ['a name too long', { ...shop, name: 'x'.repeat(COMPANY_TEXT_MAX.company + 1) }],
    ['a mission too long', { ...shop, mission: 'x'.repeat(COMPANY_TEXT_MAX.mission + 1) }],
    ['standing orders too long', { ...shop, standingOrders: 'x'.repeat(COMPANY_TEXT_MAX.standingOrders + 1) }],
    ['owns too long', { ...shop, seats: [{ name: 'ceo', owns: 'x'.repeat(COMPANY_TEXT_MAX.owns + 1) }] }],
    ['a bidi override in the mission', { ...shop, mission: `Ship ${RLO}refunds` }],
    ['a line separator in the standing orders', { ...shop, standingOrders: `Review${LINE_SEPARATOR}everything` }],
    ['an escape sequence in owns', { ...shop, seats: [{ name: 'ceo', owns: `${ESC}[2Jnothing` }] }],
    ['a new line in the name', { ...shop, name: 'shop\nteam' }],
    ['a zero-width space in the mission', { ...shop, mission: `Ship${ZERO_WIDTH_SPACE}refunds` }],
    ['a tag character in a seat name', { ...shop, ceo: `api${TAG_A}`, seats: [{ name: `api${TAG_A}` }] }],
    ['a variation selector in the standing orders', { ...shop, standingOrders: `Review${VARIATION_SELECTOR_17}` }],
    ['a Hangul filler in the name', { ...shop, name: 'shop\u3164team' }],
    ['a musical format character in the mission', { ...shop, mission: 'Ship\u{1d173}refunds' }],
    ['a mission that is not text', { ...shop, mission: ['a'] }],
  ])('refuses the whole company for %s', (_why, raw) => {
    expect(normalizeCompanyFile(raw)).toBeNull();
  });

  it('refuses a company that is not an object', () => {
    expect(normalizeCompanyFile(null)).toBeNull();
    expect(normalizeCompanyFile([shop])).toBeNull();
    expect(normalizeCompanyFile('shop')).toBeNull();
  });
});

describe('splitHiddenCharacters', () => {
  it('cuts out each character a reader would not see, one per odd entry', () => {
    expect(splitHiddenCharacters('"a": "x\u202ey\u200bz"')).toEqual(['"a": "x', '\u202e', 'y', '\u200b', 'z"']);
    // A tag character is one entry, though it takes two UTF-16 units.
    expect(splitHiddenCharacters('a\u{e0041}b')).toEqual(['a', '\u{e0041}', 'b']);
    expect(splitHiddenCharacters('\u0000')).toEqual(['', '\u0000', '']);
    // Format characters outside the bidi and zero-width ranges, and characters that draw a blank.
    for (const c of ['\u2065', '\u206a', '\ufff9', '\ufff0', '\u{1d173}', '\u{13430}', '\u3164', '\u115f', '\uffa0', '\u180b', '\u17b4', '\u{e0080}', '\u{e0fff}']) {
      expect(splitHiddenCharacters(`a${c}b`)).toEqual(['a', c, 'b']);
    }
  });

  it('cuts out the replacement character, which stands for bytes that are not UTF-8', () => {
    expect(splitHiddenCharacters('a\ufffdb')).toEqual(['a', '\ufffd', 'b']);
  });

  it('keeps a tab and a line end, CRLF as LF, and cuts out a lone carriage return', () => {
    expect(splitHiddenCharacters('{\r\n\t"a": 1\n}')).toEqual(['{\n\t"a": 1\n}']);
    expect(splitHiddenCharacters('a\rb')).toEqual(['a', '\r', 'b']);
  });
});
