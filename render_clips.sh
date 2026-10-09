#!/usr/bin/env bash
# Render the Energy Commission (2026-10-06) clip picks with ffmpeg.
#
# Usage:
#   ./render_clips.sh                 # 16:9 clips
#   VERTICAL=1 ./render_clips.sh      # also make 9:16 versions (blurred background)
#   SRC="/path/to/segments" ./render_clips.sh
#   ONLY="^(03|07|08)" ./render_clips.sh   # render only clips whose name matches
#
# Timecodes are in/out points inside each segment .mp4 (from the SRTs).
# Multi-range clips are cut piece by piece and joined in order.
set -euo pipefail

SRC="${SRC:-$HOME/Documents/Vid/Livestream /Energy Commission 2026-10-06 Clips/01 Full Breakdown - All Speeches}"
OUT="${OUT:-$SRC/../02 Clip Picks}"
VERTICAL="${VERTICAL:-0}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found. Install it with: brew install ffmpeg"; exit 1; }
[ -d "$SRC" ] || { echo "Can't find segment folder: $SRC  (set SRC=...)"; exit 1; }
mkdir -p "$OUT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

S02="02_ed-baine-dominion-merger-commitments-presentation.mp4"
S04="04_merger-qa-del-sullivan-to-pimentel-clean-energy-goals-and-af.mp4"
S05="05_merger-qa-chair-to-pimentel-ring-fencing.mp4"
S09="09_merger-qa-del-shin-to-pimentel-robo-memo-fec-and-ferc.mp4"
S12="12_energy-plan-chief-energy-officer-allman-policy-scenarios.mp4"
S13="13_energy-plan-qa-chair-investment-and-gas-plants.mp4"
S15="15_energy-plan-qa-del-sullivan-fuel-prices.mp4"
S17="17_energy-plan-qa-del-shin-cost-allocation.mp4"
S19="19_energy-plan-qa-del-webert-bill-impacts-and-land-use.mp4"
S20="20_energy-plan-qa-sen-lucas-load-growth.mp4"
S21="21_energy-plan-qa-del-sullivan-emissions-and-farmland.mp4"
S23="23_tim-mccormick-vcfur-qa.mp4"
S27="27_public-comment-full-block.mp4"

# output name | piece ; piece ; ...   where piece = file@start-end
CLIPS=(
  "01_yes-but_tight|$S04@01:22-01:40;$S04@03:41-04:02"
  "01_yes-but_full|$S04@01:22-04:28"
  "02_robo-memo-plus-insurance|$S09@03:08-03:37;$S09@06:00-06:53;$S27@05:39-06:55"
  "03_ring-fencing-encore|$S05@02:22-03:10;$S05@03:34-04:08"
  "04_ten-dollars-stop-the-merger|$S02@00:27-00:54;$S27@04:06-05:33"
  "05_fuel-savings-114B-285B|$S15@01:09-03:37"
  "06_repeal-vcea-doubles-emissions|$S21@00:34-02:34"
  "07a_pipelines-eminent-domain|$S19@05:26.4-06:57.5"
  "07b_nine-cumberland-gas-plants|$S13@00:23-01:25"
  "08a_data-centers-200B|$S12@09:15-10:28"
  "08b_cost-allocation-25pct|$S17@00:09-01:49"
  "09_foskey-affordability-stats|$S27@01:48-03:07"
  "10_pastor-lee-disconnections|$S27@10:50-12:01"
  "11_speculative-load-aep-ohio|$S20@00:12-01:47"
  "12_we-are-not-data-centers|$S23@00:04-00:17"
  "13_gonzalez-clean-virginia|$S27@09:58-10:40"
  "14_wiegard-marry-in-haste|$S27@07:03-08:27"
  "15_higgins-ccan|$S27@08:27-10:05"
)

to_sec() { awk -F: '{ printf "%.2f", $1 * 60 + $2 }' <<<"$1"; }

for entry in "${CLIPS[@]}"; do
  name="${entry%%|*}"; pieces="${entry#*|}"
  if [ -n "${ONLY:-}" ] && ! [[ $name =~ $ONLY ]]; then continue; fi
  echo "▶ $name"
  list="$TMP/$name.txt"; : >"$list"; i=0
  IFS=';' read -ra parts <<<"$pieces"
  for p in "${parts[@]}"; do
    file="${p%@*}"; range="${p#*@}"
    a=$(to_sec "${range%-*}"); b=$(to_sec "${range#*-}")
    [ -f "$SRC/$file" ] || { echo "  missing $file, skipping clip"; continue 2; }
    piece="$TMP/${name}_$i.mp4"
    ffmpeg -hide_banner -loglevel error -y -ss "$a" -i "$SRC/$file" -t "$(awk -v a="$a" -v b="$b" 'BEGIN{ printf "%.2f", b - a }')" \
      -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 \
      -c:a aac -b:a 192k -ar 48000 -ac 2 -sn "$piece"
    echo "file '$piece'" >>"$list"; i=$((i + 1))
  done
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$list" -c copy "$OUT/$name.mp4"

  if [ "$VERTICAL" = "1" ]; then
    ffmpeg -hide_banner -loglevel error -y -i "$OUT/$name.mp4" -filter_complex \
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:5[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" \
      -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy -sn "$OUT/${name}_9x16.mp4"
  fi
done

echo "Done → $OUT"
