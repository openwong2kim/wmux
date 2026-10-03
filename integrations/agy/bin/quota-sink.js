// wmux-managed: agy-quota-sensor
// wmux ↔ Antigravity CLI (agy) quota sensor (statusLine hook sink).
//
// Registered as agy's `statusLine` command in ~/.gemini/antigravity-cli/settings.json:
//   "statusLine": {
//     "type": "command",
//     "command": "node <abs path to quota-sink.js> agy",
//     "enabled": true,
//     "stack_with_default": true
//   }
// agy spawns this command whenever agent state changes, feeding full JSON on stdin.
// Its stdout becomes the status line text.
//
// This script:
//   1. Reads full JSON payload from stdin.
//   2. Extracts ONLY allowlisted fields:
//        quota, quotaCapturedAtMs, plan_tier, model.id (nested under model: { id }),
//        context_window, conversation_id, version, capturedAtMs (Date.now()).
//      Explicitly drops email, cwd, transcript_path, vcs, and any other field (privacy).
//   3. Merges with previous stored record:
//      - If incoming payload has no quota (or empty object), preserves previous quota, plan_tier, and quotaCapturedAtMs.
//      - If incoming payload has no allowlisted fields at all, writes nothing.
//      - Writes only if merged record differs from stored record ignoring capturedAtMs,
//        OR stored capturedAtMs is older than 30 000 ms.
//   4. Writes the merged record atomically to <homeDir>/.wmux/quota/agy.json via tmp + rename.
//      homeDir is overridable via WMUX_QUOTA_SINK_HOME.
//   4b. When the payload names the signed-in account (`email`), also merges and writes the
//      same record to <homeDir>/.wmux/quota/agy-accounts/<key>.json, key = first 16 hex of
//      sha256(lower-cased email). The email itself is never written; wmux derives the same
//      key from its account registry, so each agy account keeps its own quota snapshot.
//   5. If an original statusLine command was chained (via --chain-b64 <base64url> CLI arg or
//      WMUX_AGY_ORIGINAL_STATUSLINE env var), re-executes that command piping the
//      same stdin through to it, and prints its stdout verbatim.
//      If no original command is configured, prints nothing (empty stdout).
//   6. Exits 0 (or chained command's exit code).
//
// SELF-CONTAINED: Node built-ins only, no external dependencies, no imports from src/.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/**
 * Deep equality check for plain objects, arrays, and primitive values.
 */
function isDeepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!isDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Checks whether two records are deeply equal ignoring their `capturedAtMs` and `quotaCapturedAtMs` timestamps.
 */
function recordsEqualIgnoringCapturedAt(a, b) {
  if (!a || !b) return false;
  const aCopy = { ...a };
  delete aCopy.capturedAtMs;
  delete aCopy.quotaCapturedAtMs;
  const bCopy = { ...b };
  delete bCopy.capturedAtMs;
  delete bCopy.quotaCapturedAtMs;
  return isDeepEqual(aCopy, bCopy);
}

/**
 * Checks whether the input object contains a non-empty quota bucket dictionary.
 */
function hasQuota(input) {
  return Boolean(
    input &&
    input.quota !== null &&
    input.quota !== undefined &&
    typeof input.quota === 'object' &&
    !Array.isArray(input.quota) &&
    Object.keys(input.quota).length > 0,
  );
}

/**
 * Checks whether the input object contains any allowlisted field.
 */
function hasAnyAllowlistedField(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  if (hasQuota(input)) {
    return true;
  }
  if (typeof input.plan_tier === 'string' && input.plan_tier.length > 0) {
    return true;
  }
  if (typeof input.model === 'string' && input.model.length > 0) {
    return true;
  }
  if (input.model && typeof input.model === 'object' && !Array.isArray(input.model) && input.model.id !== undefined) {
    return true;
  }
  if (input.context_window !== undefined && input.context_window !== null && typeof input.context_window === 'object' && !Array.isArray(input.context_window)) {
    return true;
  }
  if (typeof input.conversation_id === 'string' && input.conversation_id.length > 0) {
    return true;
  }
  if (typeof input.version === 'string' && input.version.length > 0) {
    return true;
  }
  return false;
}

/**
 * Persisting policy (pure function):
 * Merges previous stored quota record with an incoming payload.
 *
 * Rules:
 * 1. Extract only allowlisted fields (quota, plan_tier, model id, context_window, conversation_id, version).
 * 2. Stamp capturedAtMs: nowMs. Additionally keep quotaCapturedAtMs (timestamp of most recent payload carrying quota).
 * 3. If incoming payload has no quota (or empty object), keep previous quota, plan_tier, and quotaCapturedAtMs.
 * 4. If incoming payload has none of the allowlisted fields at all, write nothing (shouldWrite: false).
 * 5. Write only if merged record differs from stored record ignoring capturedAtMs and quotaCapturedAtMs, OR stored capturedAtMs is older than 30 000 ms.
 * 6. Never include forbidden fields (email, cwd, transcript_path, workspace, session_id, etc.).
 *
 * @param {object|null} previous Stored record from ~/.wmux/quota/agy.json
 * @param {object|null} incoming Incoming raw payload from agy statusLine
 * @param {number} [nowMs=Date.now()] Current timestamp in milliseconds
 * @returns {{ record: object|null, shouldWrite: boolean }}
 */
function mergeQuotaRecord(previous, incoming, nowMs = Date.now()) {
  if (!hasAnyAllowlistedField(incoming)) {
    return {
      record: previous ?? null,
      shouldWrite: false,
    };
  }

  const record = {
    capturedAtMs: nowMs,
  };

  // 1. Quota & QuotaCapturedAtMs & PlanTier
  if (hasQuota(incoming)) {
    record.quota = incoming.quota;
    record.quotaCapturedAtMs = nowMs;
    if (incoming.plan_tier !== undefined) {
      record.plan_tier = incoming.plan_tier;
    } else if (previous && previous.plan_tier !== undefined) {
      record.plan_tier = previous.plan_tier;
    }
  } else {
    // Keep previous quota, plan_tier, and quotaCapturedAtMs across gap
    if (previous && previous.quota !== undefined) {
      record.quota = previous.quota;
    }
    if (previous && previous.quotaCapturedAtMs !== undefined) {
      record.quotaCapturedAtMs = previous.quotaCapturedAtMs;
    }
    if (previous && previous.plan_tier !== undefined) {
      record.plan_tier = previous.plan_tier;
    } else if (incoming.plan_tier !== undefined) {
      record.plan_tier = incoming.plan_tier;
    }
  }

  // 2. Model: string or { id }
  let modelVal;
  if (typeof incoming.model === 'string') {
    modelVal = { id: incoming.model };
  } else if (incoming.model && typeof incoming.model === 'object' && !Array.isArray(incoming.model)) {
    if (incoming.model.id !== undefined) {
      modelVal = { id: incoming.model.id };
    }
  }
  if (modelVal !== undefined) {
    record.model = modelVal;
  } else if (previous && previous.model !== undefined) {
    record.model = previous.model;
  }

  // 3. Context window
  if (incoming.context_window !== undefined && incoming.context_window !== null && typeof incoming.context_window === 'object' && !Array.isArray(incoming.context_window)) {
    record.context_window = incoming.context_window;
  } else if (previous && previous.context_window !== undefined) {
    record.context_window = previous.context_window;
  }

  // 4. Conversation ID
  if (incoming.conversation_id !== undefined && incoming.conversation_id !== null) {
    record.conversation_id = incoming.conversation_id;
  } else if (previous && previous.conversation_id !== undefined) {
    record.conversation_id = previous.conversation_id;
  }

  // 5. Version
  if (incoming.version !== undefined && incoming.version !== null) {
    record.version = incoming.version;
  } else if (previous && previous.version !== undefined) {
    record.version = previous.version;
  }

  // Persisting policy write decision:
  // Write only if merged record differs from stored one ignoring capturedAtMs and quotaCapturedAtMs,
  // OR stored capturedAtMs is older than 30 000 ms.
  let shouldWrite = false;
  if (!previous) {
    shouldWrite = true;
  } else {
    const hasChanged = !recordsEqualIgnoringCapturedAt(previous, record);
    const isStale = typeof previous.capturedAtMs === 'number' && (nowMs - previous.capturedAtMs) >= 30000;
    shouldWrite = hasChanged || isStale;
  }

  return {
    record,
    shouldWrite,
  };
}

/**
 * Extracts ONLY allowlisted fields from a single payload (for direct standalone extraction).
 */
function extractQuotaPayload(input, nowMs = Date.now()) {
  const { record } = mergeQuotaRecord(null, input, nowMs);
  return record || { capturedAtMs: nowMs };
}

/**
 * Resolves the target home directory.
 * Overridable via WMUX_QUOTA_SINK_HOME for testing without touching real user home.
 */
function getHomeDir(env = process.env) {
  return env.WMUX_QUOTA_SINK_HOME || env.USERPROFILE || env.HOME || os.homedir();
}

/**
 * Reads existing quota record from <homeDir>/.wmux/quota/agy.json if available.
 */
/**
 * Per-account file name for a signed-in email (see header step 4b), or null.
 */
function accountQuotaFileName(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const key = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
  return path.join('agy-accounts', `${key}.json`);
}

function readQuotaFile(homeDir = getHomeDir(), fileName = 'agy.json') {
  try {
    const dest = path.join(homeDir, '.wmux', 'quota', fileName);
    if (fs.existsSync(dest)) {
      const raw = fs.readFileSync(dest, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    // ignore read/parse errors
  }
  return null;
}

/**
 * Atomic rename with bounded retry for transient Windows file-lock errors.
 */
function renameWithRetry(from, to, maxAttempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = err && err.code;
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw err;
      }
      const ms = 10 * 2 ** (attempt - 1);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // sync wait
      }
    }
  }
}

/**
 * Writes the extracted quota payload atomically to <homeDir>/.wmux/quota/agy.json.
 */
function writeQuotaFile(data, homeDir = getHomeDir(), fileName = 'agy.json') {
  const dest = path.join(homeDir, '.wmux', 'quota', fileName);
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = path.join(dir, `agy.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameWithRetry(tmp, dest);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Resolves the original command to chain to, if any.
 * Checks WMUX_AGY_ORIGINAL_STATUSLINE env var first, then --chain-b64 argument.
 * Positional chain arguments are dropped.
 */
function resolveOriginalCommand(argv = process.argv, env = process.env) {
  if (typeof env.WMUX_AGY_ORIGINAL_STATUSLINE === 'string' && env.WMUX_AGY_ORIGINAL_STATUSLINE.trim().length > 0) {
    return env.WMUX_AGY_ORIGINAL_STATUSLINE.trim();
  }
  if (Array.isArray(argv)) {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--chain-b64' && i + 1 < argv.length) {
        const rawB64 = argv[i + 1];
        try {
          const decoded = Buffer.from(rawB64, 'base64url').toString('utf8');
          if (decoded.trim().length > 0) {
            return decoded.trim();
          }
        } catch {
          return null;
        }
      } else if (typeof arg === 'string' && arg.startsWith('--chain-b64=')) {
        const rawB64 = arg.slice('--chain-b64='.length);
        try {
          const decoded = Buffer.from(rawB64, 'base64url').toString('utf8');
          if (decoded.trim().length > 0) {
            return decoded.trim();
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Executes the original command, piping inputStdin to it, and writing its stdout verbatim.
 * Returns the child's exit code.
 */
function runChainCommand(command, inputStdin) {
  try {
    const res = spawnSync(command, {
      shell: true,
      input: inputStdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });
    if (res.stdout) {
      process.stdout.write(res.stdout);
    }
    if (res.status !== null && res.status !== undefined) {
      return res.status;
    }
    return 0;
  } catch {
    return 1;
  }
}

/**
 * Main entrypoint for quota-sink.
 */
function runQuotaSink() {
  let rawStdin = '';
  try {
    rawStdin = fs.readFileSync(0, 'utf8');
  } catch {
    rawStdin = '';
  }

  let payload = null;
  if (rawStdin.trim().length > 0) {
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    try {
      const homeDir = getHomeDir();
      const previous = readQuotaFile(homeDir);
      const { record, shouldWrite } = mergeQuotaRecord(previous, payload, Date.now());
      if (shouldWrite && record) {
        writeQuotaFile(record, homeDir);
      }
      const accountFile = accountQuotaFileName(payload.email);
      if (accountFile) {
        const perAccount = mergeQuotaRecord(readQuotaFile(homeDir, accountFile), payload, Date.now());
        if (perAccount.shouldWrite && perAccount.record) {
          writeQuotaFile(perAccount.record, homeDir, accountFile);
        }
      }
    } catch {
      // Do not let write failure abort statusLine hook or block chaining
    }
  }

  const originalCmd = resolveOriginalCommand(process.argv, process.env);
  if (originalCmd) {
    const exitCode = runChainCommand(originalCmd, rawStdin);
    process.exit(exitCode);
  }
}

module.exports = {
  accountQuotaFileName,
  extractQuotaPayload,
  getHomeDir,
  readQuotaFile,
  writeQuotaFile,
  renameWithRetry,
  resolveOriginalCommand,
  runChainCommand,
  runQuotaSink,
  mergeQuotaRecord,
  isDeepEqual,
  recordsEqualIgnoringCapturedAt,
  hasQuota,
  hasAnyAllowlistedField,
};

if (require.main === module) {
  runQuotaSink();
}
