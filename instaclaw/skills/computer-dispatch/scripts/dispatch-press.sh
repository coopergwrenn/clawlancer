#!/bin/bash
# dispatch-press.sh "key" — Press key combo (e.g. ctrl+c, Return, Tab)
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

KEY=${1:?Usage: dispatch-press.sh "key"}
usecomputer press "$KEY"
echo "{\"success\":true,\"action\":\"press\",\"key\":\"$KEY\"}"
