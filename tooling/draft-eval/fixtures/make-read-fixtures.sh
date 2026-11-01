#!/bin/sh
# SPDX-FileCopyrightText: 2026 Konstantin Tarkus
# SPDX-License-Identifier: AGPL-3.0-only

# Makes the reading fixtures from text written for Braivo: a two-column page
# as a PDF, and a page photographed badly, as a PNG. Needs Ghostscript (gs)
# and ImageMagick (magick); run from this directory. The outputs are
# committed, so this runs only when the fixtures change.
set -eu

# Prints PostScript that shows each line of stdin at x, from y down.
lines() { # x y size
  awk -v x="$1" -v y="$2" -v size="$3" '{
    gsub(/[()\\]/, "\\\\&");
    printf "%d %d moveto (%s) show\n", x, y - (NR - 1) * size * 1.5, $0
  }'
}

{
  echo "%!PS"
  echo "<< /PageSize [595 842] >> setpagedevice"
  echo "/Helvetica-Bold findfont 18 scalefont setfont"
  echo "56 780 moveto (Fernwood Science, Year 7: The water cycle) show"
  echo "/Helvetica findfont 10.5 scalefont setfont"
  lines 56 740 10.5 <<'EOF'
Water moves between the sea, the air,
and the land in a cycle that never stops.
The sun warms the sea, and some water
evaporates: it turns into water vapour,
an invisible gas, and rises.
High in the air the vapour cools.
It condenses into tiny drops of water,
and the drops gather into clouds.
This step is called condensation.
EOF
  lines 312 740 10.5 <<'EOF'
When the drops in a cloud grow heavy,
they fall as rain, snow, or hail.
This step is called precipitation.
Rain that falls on land runs into
rivers, or soaks into the ground,
and most of it returns to the sea.
Then the sun warms the sea again,
and the cycle starts once more.
Question: what makes water evaporate?
EOF
  echo "/Helvetica findfont 9 scalefont setfont"
  echo "280 60 moveto (14) show"
  echo "showpage"
} > two-column.ps
gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sOutputFile=two-column.pdf two-column.ps

{
  echo "%!PS"
  echo "<< /PageSize [420 595] >> setpagedevice"
  echo "/Times-Bold findfont 16 scalefont setfont"
  echo "40 540 moveto (Fernwood Primary: Spelling, week 3) show"
  echo "/Times-Roman findfont 13 scalefont setfont"
  lines 40 500 13 <<'EOF'
Learn these words for Friday's test.
1. because
2. friend
3. beautiful
4. different
5. February
6. library
Write a sentence with each word.
My friend and I went to the library
because it was raining.
EOF
  echo "showpage"
} > hard-scan.ps
gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=png16m -r110 -sOutputFile=hard-scan.raw.png hard-scan.ps
# Photographed at an angle in poor light: tilted, shaded across the page,
# blurred, grainy, and saved small.
magick hard-scan.raw.png \
  -background '#d8d2c4' -rotate 4.5 \
  \( +clone -sparse-color Barycentric '0,0 #ffffff %w,%h #8a8378' \) -compose multiply -composite \
  -blur 0x1.1 -attenuate 0.6 +noise Gaussian \
  -colorspace Gray -depth 8 -resize 85% -strip hard-scan.png
rm two-column.ps hard-scan.ps hard-scan.raw.png
