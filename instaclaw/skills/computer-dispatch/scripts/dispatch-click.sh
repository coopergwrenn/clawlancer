#!/bin/bash
# dispatch-click.sh X Y — Click at screenshot coordinates
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

X=${1:?Usage: dispatch-click.sh X Y}
Y=${2:?Usage: dispatch-click.sh X Y}
usecomputer click "$X,$Y"
echo "{\"success\":true,\"action\":\"click\",\"x\":$X,\"y\":$Y}"
