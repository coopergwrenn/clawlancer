#!/bin/bash
# dispatch-connection-info.sh — Output the relay connection command for this VM
# The agent runs this to give the user the exact npx command to connect
set -euo pipefail

# Get gateway token from env file
TOKEN=""
if [ -f "$HOME/.openclaw/.env" ]; then
  TOKEN=$(grep "^GATEWAY_TOKEN=" "$HOME/.openclaw/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
fi
if [ -z "$TOKEN" ]; then
  echo '{"error":"gateway token not found"}'
  exit 1
fi

# Get VM IP from hostname
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$IP" ]; then
  IP="unknown"
fi

# Output the command
echo "{\"command\":\"npx @instaclaw/dispatch@latest --token ${TOKEN} --vm ${IP}\",\"token\":\"${TOKEN}\",\"ip\":\"${IP}\",\"port\":8765}"
