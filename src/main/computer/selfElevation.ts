// Whether wmux itself runs elevated on Windows (TokenElevation of its own
// token), read in-process through koffi like winSnapshotNative.ts: no child
// process for antivirus heuristics to scan. The computer-use helper inherits
// this token and refuses to run elevated (exit 72), so main checks first and
// says why instead of reporting a helper that can never start.

const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION = 20;
/** GetCurrentProcess() pseudo-handle. */
const CURRENT_PROCESS = -1;

let cached: boolean | null | undefined;

/** true / false, or null when it cannot be read (non-Windows, koffi missing). */
export function isSelfElevated(): boolean | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'win32') return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as {
      load(name: string): { func(name: string, result: string, args: string[]): (...args: unknown[]) => number };
    };
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const openProcessToken = advapi32.func('OpenProcessToken', 'int', ['int64', 'uint32', 'void *']);
    const getTokenInformation = advapi32.func('GetTokenInformation', 'int', ['int64', 'int', 'void *', 'uint32', 'void *']);
    const closeHandle = kernel32.func('CloseHandle', 'int', ['int64']);
    const handle = Buffer.alloc(8);
    if (!openProcessToken(CURRENT_PROCESS, TOKEN_QUERY, handle)) return cached;
    const token = handle.readBigInt64LE(0);
    try {
      const elevation = Buffer.alloc(4);
      const returned = Buffer.alloc(4);
      if (getTokenInformation(token, TOKEN_ELEVATION, elevation, 4, returned)) cached = elevation.readUInt32LE(0) !== 0;
    } finally {
      closeHandle(token);
    }
  } catch {
    // Unknown: the helper's own refusal (exit 72) still covers it.
  }
  return cached;
}
