#!/bin/sh
# Rebuilds public/fonts/anton.woff2, the subset of the display face the two pages ship, from Anton Regular
# 2.116 (SIL Open Font Licence, licenses/OFL-Anton.txt; the TTF comes from the project named there). Needs
# fontTools with Brotli (pip install fonttools brotli).
#
#   sh scripts/subset-anton.sh path/to/Anton-Regular.ttf
#
# It covers Basic Latin, Latin-1 Supplement and Latin Extended-A, so a client's or a person's name (José, Zoë,
# Łódź) and brackets, quotes and £ stay in the display face; typographic quotes and dashes, the bullet, the
# ellipsis and the euro sign. Kerning is kept, as before. tests/font-coverage.test.ts checks the result.
set -eu
src="${1:?usage: sh scripts/subset-anton.sh path/to/Anton-Regular.ttf}"
out="$(dirname "$0")/../public/fonts/anton.woff2"
"${PYFTSUBSET:-pyftsubset}" "$src" \
  --unicodes="U+0020-007E,U+00A0-017F,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+20AC" \
  --layout-features="kern" \
  --name-IDs="*" \
  --notdef-outline \
  --flavor=woff2 \
  --output-file="$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
