// The company a folder keeps in its wmux.json, under `company` (insight 170):
// its name, mission, standing orders, which seat is the CEO, and each seat's
// name, what it owns and the agent it starts. The folder is the one that
// holds the wmux.json.
//
// The file is checked into the repository, so it holds nothing a seat runs
// verbatim: no launch line, argument, flag, environment, token or path. A
// seat names an agent by its registry slug and wmux builds the launch line.
// The text becomes each agent's first prompt, so it is refused when it holds a
// control, bidi or invisible character: what the review shows is what the
// agents read.
// Pure, like wmuxProjectConfig.ts.

import { isAgentSlug } from './agentIdentity';
import { normalizePaneLabel } from './paneLabelRules';
import { COMPANY_TEXT_MAX, SEAT_LABEL_MAX, companySeatsError, type CompanyPresetSeat } from './companyPreset';

/** A company as the file declares it, normalized: `ceo` indexes `seats`. */
export interface WmuxProjectCompany {
  name: string;
  mission?: string;
  standingOrders?: string;
  ceo: number;
  seats: CompanyPresetSeat[];
}

/** Above C0: the C1 controls, the line and paragraph separators, the format
 *  characters (the bidi marks, embeddings, overrides and isolates among them)
 *  and every default-ignorable character (zero-width, joiners, variation
 *  selectors, tags, fillers): what reorders the text a reader sees or carries
 *  text a reader does not see. */
const HIDDEN_ABOVE_C0 = String.raw`\u007f-\u009f\p{Zl}\p{Zp}\p{Cf}\p{Default_Ignorable_Code_Point}`;
// eslint-disable-next-line no-misleading-character-class -- matching combining characters is the point
const UNSAFE_LINE = new RegExp(String.raw`[\u0000-\u001f${HIDDEN_ABOVE_C0}]`, 'u');
/** The same, with the line feed allowed. */
// eslint-disable-next-line no-misleading-character-class -- as above
const UNSAFE_TEXT = new RegExp(String.raw`[\u0000-\u0009\u000b-\u001f${HIDDEN_ABOVE_C0}]`, 'u');
/** The same with the tab allowed too, and the replacement character that
 *  stands for bytes that are not UTF-8, captured for a split. */
// eslint-disable-next-line no-misleading-character-class -- as above
const HIDDEN = new RegExp(String.raw`([\u0000-\u0008\u000b-\u001f${HIDDEN_ABOVE_C0}\ufffd])`, 'u');

/** A file's text cut at each of these characters but a tab or a line end (LF,
 *  or CRLF), so a view of it can show each one where it sits: the odd entries
 *  are those characters, one each. */
export function splitHiddenCharacters(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(HIDDEN);
}

/** The trimmed text, '' for an omitted one, or null when it is refused. */
function text(input: unknown, max: number, multiline: boolean): string | null {
  if (input === undefined) return '';
  if (typeof input !== 'string' || input.length > max) return null;
  if ((multiline ? UNSAFE_TEXT : UNSAFE_LINE).test(input)) return null;
  return input.trim();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/**
 * The `company` key, or null when any part of it is refused: a company with
 * one seat dropped or a different CEO is not the company the author wrote.
 * Keys it does not know are ignored, so nothing else in it can run.
 */
export function normalizeCompanyFile(input: unknown): WmuxProjectCompany | null {
  if (!isRecord(input)) return null;
  const name = text(input.name, COMPANY_TEXT_MAX.company, false);
  if (!name) return null;
  const mission = text(input.mission, COMPANY_TEXT_MAX.mission, true);
  const standingOrders = text(input.standingOrders, COMPANY_TEXT_MAX.standingOrders, true);
  if (mission === null || standingOrders === null) return null;
  if (!Array.isArray(input.seats)) return null;

  const seats: CompanyPresetSeat[] = [];
  for (const raw of input.seats) {
    if (!isRecord(raw) || typeof raw.name !== 'string') return null;
    const label = text(raw.name, SEAT_LABEL_MAX, false);
    const owns = text(raw.owns, COMPANY_TEXT_MAX.owns, false);
    const agent = raw.agent;
    if (label === null || owns === null) return null;
    if (agent !== undefined && !isAgentSlug(agent)) return null;
    seats.push({ label, owns, ...(agent !== undefined ? { agent } : {}) });
  }

  // The CEO is named by its seat; an omitted one is the first seat.
  let ceo = 0;
  if (input.ceo !== undefined) {
    if (typeof input.ceo !== 'string') return null;
    ceo = seats.findIndex((s) => normalizePaneLabel(s.label) === normalizePaneLabel(input.ceo as string));
    if (ceo < 0) return null;
  }
  if (companySeatsError(seats, ceo) !== null) return null;

  return {
    name,
    ...(mission ? { mission } : {}),
    ...(standingOrders ? { standingOrders } : {}),
    ceo,
    seats,
  };
}

/** The `company` key as written to wmux.json; normalizeCompanyFile reads it back unchanged. */
export function companyFileJson(company: WmuxProjectCompany): Record<string, unknown> {
  return {
    name: company.name,
    ...(company.mission ? { mission: company.mission } : {}),
    ...(company.standingOrders ? { standingOrders: company.standingOrders } : {}),
    ceo: company.seats[company.ceo]?.label,
    seats: company.seats.map((s) => ({
      name: s.label,
      ...(s.owns ? { owns: s.owns } : {}),
      ...(s.agent ? { agent: s.agent } : {}),
    })),
  };
}

/** Why the New company dialog cannot save a company to the folder's wmux.json. */
export type CompanyFileSaveBlock =
  /** The file holds something not approved on this PC: it is reviewed first. */
  | 'review-first'
  /** The file is not valid JSON or not a usable wmux.json. */
  | 'invalid'
  /** The folder is not a git checkout and holds no wmux.json. */
  | 'no-project'
  /** The folder's wmux.json is in another folder (`dir`); a company read
   *  from there would work in that folder, not this one. */
  | 'other-folder';

/** What the New company dialog needs before it saves (IPC PROJECT_COMPANY_GET). */
export interface CompanyFileView {
  /** The folder whose wmux.json holds, or would hold, the company. */
  dir?: string;
  /** True when that wmux.json exists. */
  exists: boolean;
  /** Hash of its bytes as read; sent back on save. */
  contentHash?: string;
  /** The company it holds now, which a save replaces. */
  company?: WmuxProjectCompany;
  /** Present when saving is refused, and why. */
  saveBlocked?: CompanyFileSaveBlock;
}

export type CompanyFileSaveResult =
  | { ok: true; contentHash: string }
  | { ok: false; error: 'changed' | 'invalid-input' | 'write-failed' | CompanyFileSaveBlock; detail?: string };
