// ---------------------------------------------------------------------------
// Dangerous pattern detection for browser code execution
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bnavigator\.sendBeacon\b/, label: 'sendBeacon' },
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\b/, label: 'new Function()' },
  { pattern: /\bdocument\.cookie\b/, label: 'document.cookie access' },
  { pattern: /\blocalStorage\b/, label: 'localStorage access' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage access' },
  { pattern: /\bindexedDB\b/, label: 'indexedDB access' },
];

/**
 * Detect dangerous patterns in a JavaScript code string.
 * Returns an array of human-readable labels for each matched pattern.
 */
export function detectDangerousPatterns(code: string): string[] {
  return DANGEROUS_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ label }) => label);
}
