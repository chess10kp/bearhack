# 4) verify checkpoint files exist
CKPT=$(cat /var/tmp/gpms/checkpoints/latest)
echo "$CKPT"
ls -lah "$CKPT" | egrep 'inventory.img|dump.log|metadata.env'
# 5) restore from checkpoint
SESSION=120 MODE=checkpoint CONNECT_URI='tcp://127.0.0.1:14610/' ./gpms-resume.sh "$CKPT" 120
