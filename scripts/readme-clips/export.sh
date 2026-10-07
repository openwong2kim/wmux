#!/usr/bin/env bash
# mp4 -> README GIF (880 px, ~10 fps) under the size cap, using cuts instead of zooms.
#
#   scripts/readme-clips/export.sh in.mp4 out.gif [--cut "0-4,7.5-12,asked..answered"] [--max-mb 3]
#                                  [--width 880] [--fps 10]
#
# --cut keeps only the listed spans, in order, joined by hard cuts. A span is a-b in
# seconds, or a..b when a bound is a mark name from marks.json next to the mp4 (rec.mjs writes it). Without --cut the
# whole mp4 is used. The encoder tries fewer palette colours, then 8 fps, until the GIF
# fits; it prints duration, fps, colours and size, and warns outside 10-16 s.
set -euo pipefail

IN="${1:-}"; OUT="${2:-}"
[[ -f "$IN" && -n "$OUT" ]] || { echo "usage: export.sh in.mp4 out.gif [--cut spans] [--max-mb 3] [--width 880] [--fps 10]" >&2; exit 2; }
shift 2
CUT=""; MAXMB=3; WIDTH=880; FPS=10
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cut) CUT="$2"; shift 2;;
    --max-mb) MAXMB="$2"; shift 2;;
    --width) WIDTH="$2"; shift 2;;
    --fps) FPS="$2"; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
MARKS="$(dirname "$IN")/marks.json"
MAXBYTES="$(awk -v m="$MAXMB" 'BEGIN{printf "%d", m*1000*1000}')"

# A bound is a number of seconds or a mark name.
resolve() {
  if [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then echo "$1"; return; fi
  [[ -f "$MARKS" ]] || { echo "no $MARKS for mark '$1'" >&2; exit 2; }
  node -e 'const m=require(process.argv[1]).marks.find(x=>x.name===process.argv[2]); if(!m){console.error("no mark "+process.argv[2]);process.exit(2)} console.log(m.s)' "$MARKS" "$1"
}

FILTER=""; N=0
if [[ -n "$CUT" ]]; then
  IFS=',' read -ra SPANS <<<"$CUT"
  for span in "${SPANS[@]}"; do
    if [[ "$span" == *..* ]]; then a="${span%%..*}"; b="${span#*..}"; else a="${span%%-*}"; b="${span#*-}"; fi
    a="$(resolve "$a")"; b="$(resolve "$b")"
    FILTER+="[0:v]trim=start=$a:end=$b,setpts=PTS-STARTPTS[s$N];"
    N=$((N+1))
  done
  for ((i=0; i<N; i++)); do FILTER+="[s$i]"; done
  FILTER+="concat=n=$N:v=1:a=0[c];[c]"
else
  FILTER="[0:v]"
fi

try() { # fps colours
  ffmpeg -hide_banner -loglevel error -y -i "$IN" -filter_complex \
    "${FILTER}fps=$1,scale=$WIDTH:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=$2:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop 0 "$OUT"
  stat -f %z "$OUT"
}

for fps in "$FPS" 8; do
  for colors in 128 96 80 64 48; do
    size="$(try "$fps" "$colors")"
    if (( size <= MAXBYTES )); then
      dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
      printf '[export] %s  %.1f s  %s fps  %s colours  %.2f MB\n' "$OUT" "$dur" "$fps" "$colors" "$(awk -v s="$size" 'BEGIN{print s/1e6}')"
      awk -v d="$dur" 'BEGIN{exit !(d<10 || d>16)}' && echo "[export] warning: ${dur}s is outside the 10-16 s target" >&2
      exit 0
    fi
  done
done
echo "[export] still over ${MAXMB} MB at 8 fps / 48 colours ($size bytes): cut more" >&2
exit 1
