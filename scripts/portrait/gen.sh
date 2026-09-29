#!/usr/bin/env bash
# Draw Aida, or one of her expressions, with FLUX.2 [klein] 4B on Cloudflare Workers AI.
#
#   scripts/portrait/gen.sh base                 # the portrait, from prompts/base.txt
#   scripts/portrait/gen.sh small                # an edit of .tmp/portrait/base.png
#
# Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the environment and
# writes .tmp/portrait/<name>.png (gitignored). Every image uses seed 23 at
# 1024x1024; the expressions pass the portrait as the reference image, so only
# the mouth or eyes change. One image costs about 125 Workers AI neurons.
set -euo pipefail
name=$1
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../.tmp/portrait"
mkdir -p "$out"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}" "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
args=(-F "prompt=<$here/prompts/$name.txt" -F width=1024 -F height=1024 -F seed=23)
[ "$name" = base ] || args+=(-F "input_image_0=@$out/base.png")
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "${args[@]}" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/black-forest-labs/flux-2-klein-4b" |
  python3 -c 'import base64, json, sys; d = json.load(sys.stdin); r = d.get("result") or {}; sys.exit(json.dumps(d.get("errors"))) if "image" not in r else open(sys.argv[1], "wb").write(base64.b64decode(r["image"]))' "$out/$name.png"
echo "$out/$name.png"
