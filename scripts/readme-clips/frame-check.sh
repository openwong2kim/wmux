#!/usr/bin/env bash
# Privacy review of a clip before it is committed.
#
#   scripts/readme-clips/frame-check.sh docs/readme/hero.gif [outdir]
#
# Writes <outdir>/frames/*.png (one per second, at the clip's own resolution: read these,
# the sheet alone is too small to spot an email), <outdir>/sheet.png (contact sheet),
# <outdir>/ocr.tsv (every text line macOS Vision reads) and <outdir>/flags.tsv (OCR lines
# that look like an email, IP, token, hostname, home path or Korean text).
# OCR is a net, not the review: a person still looks at every frame in frames/.
set -euo pipefail

IN="${1:-}"
[[ -f "$IN" ]] || { echo "usage: frame-check.sh <clip.gif|mp4> [outdir]" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-${TMPDIR:-/tmp}/readme-clips-check/$(basename "${IN%.*}")-$(date +%H%M%S)}"
mkdir -p "$OUT/frames"

ffmpeg -hide_banner -loglevel error -y -i "$IN" -vf fps=1 "$OUT/frames/s%03d.png"
COUNT="$(find "$OUT/frames" -name 's*.png' | wc -l | tr -d ' ')"
ROWS=$(( (COUNT + 3) / 4 ))
ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -vf "fps=1,scale=440:-1,tile=4x${ROWS}:padding=6:color=white" -frames:v 1 "$OUT/sheet.png"

swift "$HERE/ocr.swift" "$OUT"/frames/s*.png >"$OUT/ocr.tsv" 2>/dev/null || echo "[check] OCR unavailable; review by eye only" >&2

# The public identity (GitHub openwong2kim, open.wong2kim@gmail.com) is allowed; anything else that
# matches is a finding. Only the frame and the kind are printed, never the matched text, so a
# leaked identifier does not travel on into logs or chat.
: >"$OUT/flags.tsv"
flag() { # kind regex
  sed -e 's/open\.wong2kim@gmail\.com//g' -e 's/127\.0\.0\.1//g' "$OUT/ocr.tsv" | { LC_ALL=en_US.UTF-8 grep -E -i "$2" || true; } \
    | cut -f1 | sort -u | while read -r f; do printf '%s\t%s\n' "$(basename "$f")" "$1"; done >>"$OUT/flags.tsv"
}
flag email '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
flag ip '([0-9]{1,3}\.){3}[0-9]{1,3}'
flag secret 'token|secret|api[_-]?key|sk-[a-z0-9]|bearer'
flag host '\.local\b|\.lan\b|\.internal\b|\.ts\.net'
flag home-path '/Users/|/home/'
flag korean '[가-힣]'
flag user-at-host "$(id -un)@"
# This machine's own names (read at run time, never written into the repo), compared with
# case, spaces and punctuation removed because OCR blurs them.
while IFS= read -r name; do
  key="$(printf '%s' "$name" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
  [[ ${#key} -ge 4 ]] || continue
  while IFS=$'\t' read -r f text; do
    norm="$(printf '%s' "$text" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
    [[ "$norm" == *"$key"* ]] && printf '%s\t%s\n' "$(basename "$f")" machine-name >>"$OUT/flags.tsv"
  done <"$OUT/ocr.tsv"
done < <(hostname -s; scutil --get LocalHostName 2>/dev/null; scutil --get ComputerName 2>/dev/null)

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")"
SIZE="$(stat -f %z "$IN")"
echo "[check] $IN  ${DUR}s  $(awk -v s="$SIZE" 'BEGIN{printf "%.2f", s/1e6}') MB  $COUNT frames sampled"
echo "[check] frames  $OUT/frames/"
echo "[check] sheet   $OUT/sheet.png"
if [[ -s "$OUT/flags.tsv" ]]; then
  echo "[check] FLAGGED frames (open them; the matched text is in ocr.tsv, do not paste it anywhere):"
  sort -u "$OUT/flags.tsv" | sed 's/^/          /'
  exit 1
fi
echo "[check] no OCR flags. Now look at every file in frames/ yourself before committing."
