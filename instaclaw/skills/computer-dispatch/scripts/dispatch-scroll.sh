#!/bin/bash
# dispatch-scroll.sh direction [amount] — Scroll up/down/left/right
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR=${1:?Usage: dispatch-scroll.sh direction [amount]}
AMT=${2:-3}
usecomputer scroll "$DIR" "$AMT"
echo "{\"success\":true,\"action\":\"scroll\",\"direction\":\"$DIR\",\"amount\":$AMT}"
