#!/bin/bash
# dispatch-windows.sh — List open windows on the VM virtual desktop (JSON)
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

usecomputer window list --json 2>/dev/null || echo '{"error":"window list failed"}'
