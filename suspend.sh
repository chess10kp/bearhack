pkill -f "xpra attach tcp://127.0.0.1:14610/" || true
pkill -f glycin-image-rs || true
pkill -f 'bwrap .*glycin-image-rs' || true
sleep 1
ss -tnp state established | awk 'NR==1 || /:14610/'
SESSION=120 TCP_PORT=14610 MODE=checkpoint DETACH_CLIENTS=0 ./gpms-suspend.sh 120
