import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// The pipe relay's (CdpPipeRelay) listener on Windows: a named pipe closed to
// everyone but this user and SYSTEM.
//  - Node creates a pipe with the default descriptor, which lets every account
//    (Everyone, Anonymous) open it for reading. Node has no way to set another
//    one, so the relay opens its own pipe once with WRITE_DAC, right after
//    listen() returns (the pipe exists by then, in the same tick), sets a
//    protected DACL of SYSTEM and this user, reads it back on that handle, and
//    closes it. The descriptor belongs to the pipe name: instances libuv
//    creates later carry it too.
//  - A pipe whose DACL could not be set is never served: the relay closes it
//    and binds under a fresh name, then falls back to loopback TCP.
//  - When this process runs as another user than the session's (run as a
//    different account), a pipe closed to this user would shut out the
//    session's own clients: TCP then.
// Nothing here logs a pipe name, a SID or a user name.
// ---------------------------------------------------------------------------

export const RELAY_PIPE_PREFIX = 'wmux-cdp-relay-';
const PIPE_ROOT = '\\\\.\\pipe\\';
/** ws+unix splits its target on ':'; a name is only these characters. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** A fresh relay pipe path: \\.\pipe\wmux-cdp-relay-<32 hex>. No suffix, no user name. */
export function relayPipePath(hex: string = randomBytes(16).toString('hex')): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('relay pipe name has unsafe characters');
  return `${PIPE_ROOT}${RELAY_PIPE_PREFIX}${hex}`;
}

/**
 * The endpoint a client dials for `pipePath`. Exactly this spelling: with no
 * `//` the URL's path is opaque, so ws hands `\\.\pipe\<name>` to net as is.
 * `ws+unix:////./pipe/…` loses its `.` segment to URL parsing (a UNC path),
 * and `ws+unix://\\.\pipe\…` is not a URL at all.
 */
export function relayPipeEndpoint(pipePath: string, relayPath: string): string {
  if (!pipePath.startsWith(PIPE_ROOT) || !SAFE_NAME.test(pipePath.slice(PIPE_ROOT.length))) {
    throw new Error('not a relay pipe path');
  }
  return `ws+unix:${pipePath}:${relayPath}`;
}

// ── DACL text ───────────────────────────────────────────────────────────────

export interface DaclAce {
  readonly type: string;
  readonly flags: string;
  readonly rights: string;
  readonly sid: string;
}

export interface ParsedDacl {
  readonly protected: boolean;
  readonly aces: DaclAce[];
}

/** A DACL in SDDL form (`D:P(A;;FA;;;SY)…`), or null when it is not one. */
export function parseDacl(sddl: string): ParsedDacl | null {
  const match = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl);
  if (!match) return null;
  const aces: DaclAce[] = [];
  for (const [, body] of match[2].matchAll(/\(([^()]*)\)/g)) {
    const parts = body.split(';');
    if (parts.length !== 6) return null;
    aces.push({ type: parts[0], flags: parts[1], rights: parts[2], sid: parts[5] });
  }
  return { protected: match[1].includes('P'), aces };
}

/** FILE_ALL_ACCESS as SDDL writes it back (GA set on a file object reads back as FA). */
const ALL_ACCESS = new Set(['FA', 'GA', '0x1f01ff']);

/**
 * Exactly what the relay sets: protected (nothing inherited), two allow
 * entries with all access and no inheritance flags, for SYSTEM and `userSid`.
 */
export function isOwnerOnlyDacl(dacl: ParsedDacl | null, userSid: string): boolean {
  if (!dacl || !dacl.protected || dacl.aces.length !== 2) return false;
  const sids = new Set<string>();
  for (const ace of dacl.aces) {
    const rights = /^0x/i.test(ace.rights) ? ace.rights.toLowerCase() : ace.rights;
    if (ace.type !== 'A' || ace.flags !== '' || !ALL_ACCESS.has(rights)) return false;
    sids.add(ace.sid);
  }
  return sids.size === 2 && sids.has('SY') && sids.has(userSid);
}

export function ownerOnlyDaclSddl(userSid: string): string {
  if (!/^S-1-[0-9-]+$/.test(userSid)) throw new Error('not a SID');
  return `D:P(A;;GA;;;SY)(A;;GA;;;${userSid})`;
}

// ── Win32 ───────────────────────────────────────────────────────────────────

type Fn = (...args: unknown[]) => unknown;
interface KoffiLib { func(prototype: string): Fn }
interface Koffi {
  load(name: string): KoffiLib;
  decode(value: unknown, type: string, length?: number): unknown;
  address(value: unknown): bigint;
}

const READ_CONTROL = 0x00020000;
const WRITE_DAC = 0x00040000;
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const SE_KERNEL_OBJECT = 6;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const WTS_USER_NAME = 5;
const WTS_DOMAIN_NAME = 7;
export const ERROR_PIPE_BUSY = 231;
const INVALID_HANDLE = 0xffffffffffffffffn;

export type NarrowResult = { ok: true } | { ok: false; busy: boolean; reason: string };

/** What the relay needs on Windows, loaded before a pipe is made. */
export interface PipeSecurity {
  /** This process's user, as a SID string. */
  readonly userSid: string;
  /** Set the owner-only DACL on `pipePath` and read it back. */
  narrow(pipePath: string): NarrowResult;
  /** `pipePath`'s DACL as SDDL (opens the pipe once, for reading its descriptor), or an error text. */
  daclOf(pipePath: string): string;
  /** Test seam: open `pipePath` for reading, as any account could under the default DACL. Returns a close function. */
  openForReading(pipePath: string): (() => void) | { error: number };
}

export type PipeSecurityResult = { security: PipeSecurity } | { unavailable: 'different-user' | 'no-session-user' | 'win32-api' };

let loaded: PipeSecurityResult | undefined;

/** Load once: koffi, this process's user, and whether it is the session's user. */
export function loadPipeSecurity(): PipeSecurityResult {
  if (loaded) return loaded;
  try {
    loaded = load();
  } catch {
    loaded = { unavailable: 'win32-api' };
  }
  return loaded;
}

function load(): PipeSecurityResult {
  // Runtime require, external to every bundle (its binary sits beside the package).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as Koffi;
  const k32 = koffi.load('kernel32.dll');
  const adv = koffi.load('advapi32.dll');
  const wts = koffi.load('wtsapi32.dll');
  const CreateFileW = k32.func('void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *sa, uint32 disp, uint32 flags, void *tmpl)');
  const CloseHandle = k32.func('int __stdcall CloseHandle(void *h)');
  const GetLastError = k32.func('uint32 __stdcall GetLastError()');
  const LocalFree = k32.func('void * __stdcall LocalFree(void *p)');
  const GetCurrentProcess = k32.func('void * __stdcall GetCurrentProcess()');
  const GetCurrentProcessId = k32.func('uint32 __stdcall GetCurrentProcessId()');
  const ProcessIdToSessionId = k32.func('int __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *session)');
  const OpenProcessToken = adv.func('int __stdcall OpenProcessToken(void *process, uint32 access, _Out_ void **token)');
  const GetTokenInformation = adv.func('int __stdcall GetTokenInformation(void *token, int cls, _Out_ void *info, uint32 length, _Out_ uint32 *returned)');
  const ConvertSidToStringSidW = adv.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)');
  const LookupAccountSidW = adv.func('int __stdcall LookupAccountSidW(str16 system, void *sid, _Out_ void *name, _Inout_ uint32 *nameLength, _Out_ void *domain, _Inout_ uint32 *domainLength, _Out_ int *use)');
  const GetSecurityInfo = adv.func('uint32 __stdcall GetSecurityInfo(void *h, int type, uint32 info, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **sd)');
  const SetSecurityInfo = adv.func('uint32 __stdcall SetSecurityInfo(void *h, int type, uint32 info, void *owner, void *group, void *dacl, void *sacl)');
  const SdToSddl = adv.func('int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *sd, uint32 revision, uint32 info, _Out_ void **str, _Out_ uint32 *length)');
  const SddlToSd = adv.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 str, uint32 revision, _Out_ void **sd, _Out_ uint32 *length)');
  const GetSecurityDescriptorDacl = adv.func('int __stdcall GetSecurityDescriptorDacl(void *sd, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)');
  const WTSQuerySessionInformationW = wts.func('int __stdcall WTSQuerySessionInformationW(void *server, uint32 session, int cls, _Out_ void **buffer, _Out_ uint32 *bytes)');
  const WTSFreeMemory = wts.func('void __stdcall WTSFreeMemory(void *p)');

  const wide = (p: unknown): string => koffi.decode(p, 'char16_t', -1) as string;
  const invalid = (h: unknown): boolean => h === null || koffi.address(h) === INVALID_HANDLE;

  // This process's user.
  const token: unknown[] = [null];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) return { unavailable: 'win32-api' };
  const size = [0];
  GetTokenInformation(token[0], TOKEN_USER, null, 0, size);
  const info = Buffer.alloc(size[0]);
  const gotUser = GetTokenInformation(token[0], TOKEN_USER, info, info.length, size);
  CloseHandle(token[0]);
  if (!gotUser) return { unavailable: 'win32-api' };
  // TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first field is the SID pointer.
  const sid = koffi.decode(info, 'void *');
  const sidText: unknown[] = [null];
  if (!ConvertSidToStringSidW(sid, sidText)) return { unavailable: 'win32-api' };
  const userSid = wide(sidText[0]);
  LocalFree(sidText[0]);
  const name = Buffer.alloc(1024);
  const domain = Buffer.alloc(1024);
  const nameLength = [512];
  const domainLength = [512];
  if (!LookupAccountSidW(null, sid, name, nameLength, domain, domainLength, [0])) return { unavailable: 'win32-api' };
  const userName = name.toString('utf16le', 0, nameLength[0] * 2);
  const userDomain = domain.toString('utf16le', 0, domainLength[0] * 2);

  // The session's interactive user: a client the user starts runs as them.
  const session = [0];
  if (!ProcessIdToSessionId(GetCurrentProcessId(), session)) return { unavailable: 'no-session-user' };
  const sessionText = (cls: number): string | null => {
    const out: unknown[] = [null];
    if (!WTSQuerySessionInformationW(null, session[0], cls, out, [0])) return null;
    const text = wide(out[0]);
    WTSFreeMemory(out[0]);
    return text;
  };
  const sessionUser = sessionText(WTS_USER_NAME);
  const sessionDomain = sessionText(WTS_DOMAIN_NAME);
  if (!sessionUser) return { unavailable: 'no-session-user' };
  const same = (a: string | null, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();
  if (!same(sessionUser, userName) || !same(sessionDomain, userDomain)) return { unavailable: 'different-user' };

  const daclSddl = (handle: unknown): string | null => {
    const sd: unknown[] = [null];
    if (GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, [null], [null], [null], [null], sd) !== 0) return null;
    const text: unknown[] = [null];
    const length = [0];
    const converted = SdToSddl(sd[0], 1, DACL_SECURITY_INFORMATION, text, length);
    const out = converted ? (koffi.decode(text[0], 'char16_t', length[0] - 1) as string) : null;
    if (converted) LocalFree(text[0]);
    LocalFree(sd[0]);
    return out;
  };

  const security: PipeSecurity = {
    userSid,
    narrow(pipePath) {
      // Opening the pipe connects to one of its instances: the server sees a
      // connection that ends when this handle closes.
      const handle = CreateFileW(pipePath, WRITE_DAC | READ_CONTROL, 0, null, OPEN_EXISTING, 0, null);
      if (invalid(handle)) {
        const code = GetLastError() as number;
        return { ok: false, busy: code === ERROR_PIPE_BUSY, reason: `open ${code}` };
      }
      try {
        const sd: unknown[] = [null];
        if (!SddlToSd(ownerOnlyDaclSddl(userSid), 1, sd, [0])) return { ok: false, busy: false, reason: 'build' };
        try {
          const present = [0];
          const dacl: unknown[] = [null];
          if (!GetSecurityDescriptorDacl(sd[0], present, dacl, [0]) || !present[0]) return { ok: false, busy: false, reason: 'build' };
          const set = SetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, null, null, dacl[0], null) as number;
          if (set !== 0) return { ok: false, busy: false, reason: `set ${set}` };
        } finally {
          LocalFree(sd[0]);
        }
        const back = daclSddl(handle);
        return isOwnerOnlyDacl(back === null ? null : parseDacl(back), userSid)
          ? { ok: true }
          : { ok: false, busy: false, reason: 'read-back' };
      } finally {
        CloseHandle(handle);
      }
    },
    daclOf(pipePath) {
      const handle = CreateFileW(pipePath, READ_CONTROL, 0, null, OPEN_EXISTING, 0, null);
      if (invalid(handle)) return `open ${GetLastError() as number}`;
      try {
        return daclSddl(handle) ?? 'read failed';
      } finally {
        CloseHandle(handle);
      }
    },
    openForReading(pipePath) {
      const handle = CreateFileW(pipePath, GENERIC_READ, 0, null, OPEN_EXISTING, 0, null);
      if (invalid(handle)) return { error: GetLastError() as number };
      let open = true;
      return () => {
        if (open) CloseHandle(handle);
        open = false;
      };
    },
  };
  return { security };
}
