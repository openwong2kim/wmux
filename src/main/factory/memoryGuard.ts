// ─── Memory guard — what a bot's memory may not hold ───────────────────────
//
// Memory (botMemory.ts) loads into every later session of a bot, so a text
// that reads as an instruction would outlive the turn that wrote it. Before
// an entry is kept, and again when it loads, it is checked here: an attempt
// to override the bot's instructions or its role, an instruction to send
// keys, tokens or secrets somewhere, a download piped into a shell, and
// characters a reader cannot see (zero-width, bidi controls, tag characters,
// control codes). A match is refused whole, never edited. Key-shaped values
// are refused and stored secret values masked by botMemory.ts.

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Overriding instructions.
  [/\b(?:ignore|disregard|forget|override|bypass)\b[^\n.]{0,40}\b(?:instructions?|prompts?|guidelines|directives)\b/i,
    'tells the reader to ignore its instructions'],
  // "rules" alone is ordinary ("the linter ignores rules in vendor/"); with
  // a word that points at the reader's own, it is not.
  [/\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|original|system|your|all)\s+rules\b/i,
    'tells the reader to ignore its instructions'],
  [/(?:이전|모든|앞의|위의|기존)\s*(?:지시|명령|지침|규칙|프롬프트)\S*\s*(?:을|를)?\s*(?:모두\s*)?(?:무시|잊)/,
    'tells the reader to ignore its instructions'],
  [/\bnew\s+(?:system\s+)?(?:instructions|rules|directives)\s*:/i, 'gives new instructions'],
  [/\byou\s+are\s+now\s+(?:a|an|the|in|no\s+longer)\b/i, 'assigns the reader a new role'],
  // System-prompt and role markers.
  [/\b(?:system|developer)\s*(?:prompt|message|instructions?)\s*[:=]/i, 'writes a system prompt'],
  [/<\s*\/?\s*(?:system|instructions?|assistant|developer)\b[^>]*>/i, 'carries a role marker'],
  [/<\|im_(?:start|end)\|>|\[\/?(?:INST|SYS|system)\]/i, 'carries a role marker'],
  [/^\s*#*\s*(?:system|assistant)\s*:/im, 'carries a role marker'],
  [/\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal)\b[^\n.]{0,20}\b(?:owner|user|human)\s+(?:about|that|of|what|this)\b/i,
    'hides something from the owner'],
  [/\bhide\b[^\n.]{0,30}\bfrom\s+(?:the\s+)?(?:owner|user|human)\b/i, 'hides something from the owner'],
  // Exfiltration.
  [/\b(?:send|post|upload|forward|e-?mail|leak|exfiltrate|transmit|paste|copy)\b[^\n]{0,80}\b(?:tokens?|api[\s_-]?keys?|secrets?|passwords?|credentials?|cookies?|private\s+keys?|ssh\s+keys?|\.env)\b[^\n]{0,80}\b(?:to|into)\b/i,
    'tells the reader to send secrets somewhere'],
  [/\b(?:curl|wget|nc|netcat|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n]*\$\{?[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASS(?:WORD)?)/i,
    'sends a secret in a command'],
  // Remote code.
  [/\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i, 'pipes a download into a shell'],
  [/\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n|]*\|\s*(?:python3?|node|perl|ruby|iex|pwsh|powershell)\b/i, 'pipes a download into an interpreter'],
  [/\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i, 'runs a download in a shell'],
  // What a reader cannot see.
  [/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u180E]/u, 'holds invisible or bidi characters'],
  [/[\u{E0000}-\u{E007F}]/u, 'holds invisible tag characters'],
  // eslint-disable-next-line no-control-regex
  [/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, 'holds control characters'],
];

/** Why `text` may not be kept in memory, or null when it may. Pure. */
export function memoryTextThreat(text: string): string | null {
  for (const [re, why] of PATTERNS) {
    if (re.test(text)) return why;
  }
  return null;
}
