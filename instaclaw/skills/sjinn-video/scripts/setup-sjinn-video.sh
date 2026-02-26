#!/bin/bash
#
# setup-sjinn-video.sh — Initialize Sjinn AI Video Production environment
#
# Creates directories, video history template, and cleanup cron jobs.
# Run once during VM provisioning or skill deployment.
#

set -euo pipefail

echo "=== Setting up Sjinn AI Video Production Studio ==="

# Create workspace directories
mkdir -p ~/workspace/videos
mkdir -p ~/workspace/tmp-media
mkdir -p ~/memory
echo "  [OK] Directories created: ~/workspace/videos, ~/workspace/tmp-media, ~/memory"

# Create video-history.json template if it doesn't exist
if [ ! -f ~/memory/video-history.json ]; then
  cat > ~/memory/video-history.json << 'EOF'
{
  "pending": [],
  "completed": []
}
EOF
  echo "  [OK] Created ~/memory/video-history.json template"
else
  echo "  [OK] ~/memory/video-history.json already exists, preserving"
fi

# Verify GATEWAY_TOKEN in .env (used for proxy authentication)
if grep -q "^GATEWAY_TOKEN=" ~/.openclaw/.env 2>/dev/null; then
  echo "  [OK] GATEWAY_TOKEN found in ~/.openclaw/.env"
else
  echo "  [WARN] GATEWAY_TOKEN not found — video generation will not work"
fi

# Set up auto-cleanup cron for videos (7-day retention)
CRON_VIDEO='0 3 * * * find ~/workspace/videos/ -type f -mtime +7 -delete 2>/dev/null'
CRON_MEDIA='*/30 * * * * find ~/workspace/tmp-media/ -type f -mmin +60 -delete 2>/dev/null'

# Add cron jobs if not already present
CURRENT_CRON=$(crontab -l 2>/dev/null || true)

if echo "$CURRENT_CRON" | grep -q "workspace/videos.*mtime"; then
  echo "  [OK] Video cleanup cron already exists"
else
  (echo "$CURRENT_CRON"; echo "$CRON_VIDEO") | crontab -
  echo "  [OK] Added video cleanup cron (7-day retention)"
fi

# Re-read after potential update
CURRENT_CRON=$(crontab -l 2>/dev/null || true)

if echo "$CURRENT_CRON" | grep -q "workspace/tmp-media.*mmin"; then
  echo "  [OK] tmp-media cleanup cron already exists"
else
  (echo "$CURRENT_CRON"; echo "$CRON_MEDIA") | crontab -
  echo "  [OK] Added tmp-media cleanup cron (1-hour retention)"
fi

echo ""
echo "=== Sjinn Video Setup Complete ==="
echo "  Videos:      ~/workspace/videos/ (7-day retention)"
echo "  Tmp media:   ~/workspace/tmp-media/ (1-hour retention)"
echo "  History:     ~/memory/video-history.json"
echo "  Auth:        ~/.openclaw/.env (GATEWAY_TOKEN)"
