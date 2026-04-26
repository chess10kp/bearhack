set -euo pipefail
xpra list | sed -n '1,30p'
cd /home/oem/git/bearhack
./gpms-suspend.sh 110
set -euo pipefail
LATEST=$(cat /var/tmp/gpms/suspends/latest)
echo "latest=$LATEST"
ls -la "$LATEST" | sed -n '1,20p'
awk '{print $1}' "$LATEST/pids.txt" | while read -r p; do awk '/^State:/{print $2; exit}' "/proc/$p/status" 2>/dev/null || echo gone; done | sort | uniq -c
