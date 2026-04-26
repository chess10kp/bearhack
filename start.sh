#!/usr/bin/env bash
set -euo pipefail

# Demo workload: download a large single-file C codebase and keep compiling it.
# This gives a long-running, checkpoint-friendly process tree.

DISPLAY_NUM="${DISPLAY_NUM:-120}"
TCP_PORT="${TCP_PORT:-14610}"
DEMO_DIR="${DEMO_DIR:-/tmp/gpms-demo}"
DEMO_SCRIPT="${DEMO_DIR}/compile-loop.sh"

mkdir -p "${DEMO_DIR}"

cat >"${DEMO_SCRIPT}" <<'EOF'
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
EOF

chmod +x "${DEMO_SCRIPT}"

CHILD_CMD="bash ${DEMO_SCRIPT}"

DISPLAY_NUM="${DISPLAY_NUM}" \
TCP_PORT="${TCP_PORT}" \
READY_REQUIRE_WINDOWS=0 \
CHILD_CMD="${CHILD_CMD}" \
./gpms-xpra-mvp.sh start
