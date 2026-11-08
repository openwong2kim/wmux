/**
 * Drop a leading UTF-8 byte order mark. Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` and `Out-File` write one, and `JSON.parse`
 * rejects it, so a hand-edited JSON file would otherwise read as unusable.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
