#!/bin/bash
# check-skill-updates.sh — Daily skill dependency updater for OpenClaw VMs
# Fetches manifest.json from GitHub, compares installed pip versions,
# upgrades packages that are behind. Runs via cron at 3am UTC.
#
# Usage: /bin/bash ~/scripts/check-skill-updates.sh
# Logs:  ~/.openclaw/logs/skill-updates.log
# State: ~/.openclaw/skill-update-status.json

set -uo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
MANIFEST_URL="https://raw.githubusercontent.com/coopergwrenn/clawlancer/main/instaclaw/skills/manifest.json"
LOG_DIR="$HOME/.openclaw/logs"
LOG_FILE="$LOG_DIR/skill-updates.log"
STATUS_FILE="$HOME/.openclaw/skill-update-status.json"
MANIFEST_CACHE="/tmp/skill-manifest-$$.json"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"
}

# ── Fetch manifest ──────────────────────────────────────────────────────────
log "=== Skill update check started ==="

if ! curl -sfL --max-time 30 "$MANIFEST_URL" -o "$MANIFEST_CACHE" 2>/dev/null; then
  log "ERROR: Failed to fetch manifest from $MANIFEST_URL"
  echo "{\"last_checked\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"status\":\"fetch_failed\"}" > "$STATUS_FILE"
  rm -f "$MANIFEST_CACHE"
  exit 1
fi

# Validate JSON
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$MANIFEST_CACHE" 2>/dev/null; then
  log "ERROR: Manifest is not valid JSON"
  echo "{\"last_checked\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"status\":\"invalid_manifest\"}" > "$STATUS_FILE"
  rm -f "$MANIFEST_CACHE"
  exit 1
fi

MANIFEST_VERSION=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m.get('version',0))" "$MANIFEST_CACHE" 2>/dev/null)
log "Manifest fetched OK (version=$MANIFEST_VERSION)"

# ── Process each auto_update skill ──────────────────────────────────────────
UPDATED=0
SKIPPED=0
FAILED=0
ALREADY_CURRENT=0

# Extract auto_update skills with pip_deps
SKILLS_JSON=$(python3 -c "
import json, sys
m = json.load(open(sys.argv[1]))
for s in m.get('skills', []):
    if s.get('auto_update') and s.get('pip_deps'):
        for dep in s['pip_deps']:
            print(json.dumps({'skill': s['name'], 'dep': dep}))
" "$MANIFEST_CACHE" 2>/dev/null)

if [ -z "$SKILLS_JSON" ]; then
  log "No auto_update skills with pip deps found"
  echo "{\"last_checked\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"status\":\"ok\",\"updated\":0,\"already_current\":0,\"failed\":0}" > "$STATUS_FILE"
  rm -f "$MANIFEST_CACHE"
  exit 0
fi

while IFS= read -r line; do
  SKILL=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['skill'])" 2>/dev/null)
  DEP=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['dep'])" 2>/dev/null)

  if [ -z "$DEP" ]; then
    continue
  fi

  # Extract package name and target version from dep spec
  # Handle specs like "crawlee[beautifulsoup,playwright]==1.5.0" or "solders==0.27.1"
  PKG_NAME=$(echo "$DEP" | python3 -c "
import sys, re
dep = sys.stdin.read().strip()
# Remove extras and version spec to get bare name
name = re.split(r'[\[>=<!=~]', dep)[0]
print(name)
" 2>/dev/null)

  TARGET_VER=$(echo "$DEP" | python3 -c "
import sys, re
dep = sys.stdin.read().strip()
m = re.search(r'==([0-9][0-9a-zA-Z._]*)', dep)
print(m.group(1) if m else '')
" 2>/dev/null)

  if [ -z "$PKG_NAME" ]; then
    log "SKIP: Could not parse package name from '$DEP'"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Get currently installed version
  INSTALLED_VER=$(python3 -c "
import importlib.metadata as md
try:
    print(md.version('$PKG_NAME'))
except md.PackageNotFoundError:
    print('NOT_INSTALLED')
" 2>/dev/null) || INSTALLED_VER="UNKNOWN"

  log "[$SKILL] $PKG_NAME: installed=$INSTALLED_VER target=$TARGET_VER"

  # Compare versions
  if [ "$INSTALLED_VER" = "$TARGET_VER" ]; then
    log "[$SKILL] $PKG_NAME $INSTALLED_VER is current — no action"
    ALREADY_CURRENT=$((ALREADY_CURRENT + 1))
    continue
  fi

  # Install/upgrade
  log "[$SKILL] Upgrading $PKG_NAME: $INSTALLED_VER → $TARGET_VER"
  if python3 -m pip install --quiet --break-system-packages "$DEP" 2>>"$LOG_FILE"; then
    NEW_VER=$(python3 -c "import importlib.metadata as md; print(md.version('$PKG_NAME'))" 2>/dev/null) || NEW_VER="UNKNOWN"
    log "[$SKILL] SUCCESS: $PKG_NAME upgraded to $NEW_VER"
    UPDATED=$((UPDATED + 1))
  else
    log "[$SKILL] FAILED: pip install '$DEP' returned non-zero"
    FAILED=$((FAILED + 1))
  fi

done <<< "$SKILLS_JSON"

# ── Write status ────────────────────────────────────────────────────────────
log "=== Check complete: updated=$UPDATED already_current=$ALREADY_CURRENT failed=$FAILED skipped=$SKIPPED ==="

cat > "$STATUS_FILE" <<EOF
{
  "last_checked": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "manifest_version": $MANIFEST_VERSION,
  "status": "ok",
  "updated": $UPDATED,
  "already_current": $ALREADY_CURRENT,
  "failed": $FAILED,
  "skipped": $SKIPPED
}
EOF

rm -f "$MANIFEST_CACHE"
exit 0
