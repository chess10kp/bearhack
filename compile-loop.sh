#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="${DEMO_DIR:-/tmp/gpms-demo}"
cd "${DEMO_DIR}"

if [[ ! -s stb_image.h ]]; then
  curl -fsSL -o stb_image.h https://raw.githubusercontent.com/nothings/stb/master/stb_image.h
fi

cat > build_stb_image.c <<'SRC'
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
SRC

pass=1
while :; do
  echo "$(date +%F-%T) pass=${pass}" >> compile.log
  gcc -c -O3 -g3 -o stb_image.o build_stb_image.c
  pass=$((pass + 1))
done
