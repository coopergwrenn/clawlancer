#!/bin/bash
#
# provision-clob-proxy.sh — Provision a Linode Nanode in Toronto (ca-central)
# to serve as an nginx reverse proxy for Polymarket CLOB API traffic.
#
# US-based VMs are geoblocked on CLOB write endpoints (POST /order → 403).
# This proxy sits in Canada and forwards CLOB requests, authenticated by a
# secret path token embedded in the host URL.
#
# Usage:
#   ./scripts/provision-clob-proxy.sh           # Provision and print proxy URL
#   ./scripts/provision-clob-proxy.sh --dry-run # Show what would be created
#
# Reads LINODE_API_TOKEN from .env.local.
# Output: Prints CLOB_PROXY_URL to add to .env.local and deploy to US VMs.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

load_env() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n'
}

LINODE_TOKEN=$(load_env "LINODE_API_TOKEN")
if [ -z "$LINODE_TOKEN" ]; then
  echo "Error: LINODE_API_TOKEN not found in .env.local"
  exit 1
fi

MODE="${1:---provision}"

NANODE_TYPE="g6-nanode-1"
NANODE_REGION="ca-central"
NANODE_IMAGE="linode/ubuntu24.04"
NANODE_LABEL="instaclaw-clob-proxy"

# Generate a random secret token for path-based auth
SECRET_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(24))")

# Build cloud-init user_data that installs nginx and configures the reverse proxy
CLOUD_INIT=$(cat <<CLOUDINIT_EOF
#!/bin/bash
set -euo pipefail
exec > /var/log/clob-proxy-bootstrap.log 2>&1
echo "=== CLOB proxy bootstrap started at \$(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx ufw

# Configure UFW
ufw allow 22/tcp
ufw allow 8080/tcp
ufw --force enable

# Harden SSH
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Write nginx config
cat > /etc/nginx/sites-available/clob-proxy <<'NGINX_EOF'
server {
    listen 8080;

    location /${SECRET_TOKEN}/ {
        rewrite ^/${SECRET_TOKEN}(/.*)$ \$1 break;
        proxy_pass https://clob.polymarket.com;
        proxy_set_header Host clob.polymarket.com;
        proxy_ssl_server_name on;
        proxy_ssl_protocols TLSv1.2 TLSv1.3;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
    }

    location / {
        return 403 "Unauthorized";
    }
}
NGINX_EOF

# Enable site, disable default
ln -sf /etc/nginx/sites-available/clob-proxy /etc/nginx/sites-enabled/clob-proxy
rm -f /etc/nginx/sites-enabled/default

# Test and reload nginx
nginx -t
systemctl reload nginx
systemctl enable nginx

echo "=== CLOB proxy bootstrap complete at \$(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
CLOUDINIT_EOF
)

if [ "$MODE" = "--dry-run" ]; then
  echo "=== DRY RUN: CLOB Proxy Nanode ==="
  echo ""
  echo "Would create:"
  echo "  Label:  $NANODE_LABEL"
  echo "  Type:   $NANODE_TYPE (1GB RAM, 1 CPU, \$5/mo)"
  echo "  Region: $NANODE_REGION (Toronto, Canada)"
  echo "  Image:  $NANODE_IMAGE"
  echo ""
  echo "Cloud-init installs:"
  echo "  - nginx (reverse proxy to clob.polymarket.com)"
  echo "  - UFW (ports 22, 8080 only)"
  echo "  - Path-based token auth (secret token in URL path)"
  echo ""
  echo "Output: CLOB_PROXY_URL=http://<IP>:8080/<TOKEN>"
  echo ""
  echo "Run without --dry-run to provision."
  exit 0
fi

echo "=== Provisioning CLOB Proxy Nanode ==="
echo "  Label:  $NANODE_LABEL"
echo "  Type:   $NANODE_TYPE"
echo "  Region: $NANODE_REGION (Toronto)"
echo ""

# Get SSH public key
SSH_PUB_KEY=$(curl -s 'https://api.linode.com/v4/profile/sshkeys' \
  -H "Authorization: Bearer ${LINODE_TOKEN}" \
  | python3 -c "import json,sys; keys=json.load(sys.stdin)['data']; print(next((k['ssh_key'] for k in keys if k['label']=='instaclaw-deploy'), ''))")

if [ -z "$SSH_PUB_KEY" ]; then
  echo "Error: SSH key 'instaclaw-deploy' not found on Linode"
  exit 1
fi

# Base64-encode cloud-init for Linode metadata
CLOUD_INIT_B64=$(echo "$CLOUD_INIT" | base64)

# Create the Nanode
CREATE_RESULT=$(export _IC_SSH_PUB_KEY="$SSH_PUB_KEY" && python3 -c "
import json, sys, os, secrets, string
root_pass = ''.join(secrets.choice(string.ascii_letters + string.digits + '!@#') for _ in range(32))
body = {
    'label': '${NANODE_LABEL}',
    'type': '${NANODE_TYPE}',
    'region': '${NANODE_REGION}',
    'image': '${NANODE_IMAGE}',
    'root_pass': root_pass,
    'authorized_keys': [os.environ['_IC_SSH_PUB_KEY']],
    'metadata': {
        'user_data': sys.stdin.read().strip()
    }
}
print(json.dumps(body))
" <<< "$CLOUD_INIT_B64" | curl -s -X POST 'https://api.linode.com/v4/linode/instances' \
    -H "Authorization: Bearer ${LINODE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d @-)

LINODE_ID=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$LINODE_ID" ]; then
  echo "ERROR: Failed to create Nanode"
  echo "$CREATE_RESULT" | python3 -m json.tool 2>/dev/null || echo "$CREATE_RESULT"
  exit 1
fi

echo "  Linode ID: $LINODE_ID — waiting for IP..."

# Poll until running with public IP (max 2 minutes)
IP=""
for attempt in $(seq 1 24); do
  sleep 5
  LINODE_DATA=$(curl -s "https://api.linode.com/v4/linode/instances/${LINODE_ID}" \
    -H "Authorization: Bearer ${LINODE_TOKEN}")
  STATUS=$(echo "$LINODE_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  IP=$(echo "$LINODE_DATA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ipv4=d.get('ipv4',[])
print(ipv4[0] if ipv4 else '')
" 2>/dev/null)

  if [ "$STATUS" = "running" ] && [ -n "$IP" ]; then
    break
  fi
  printf "."
done
echo ""

if [ -z "$IP" ]; then
  echo "ERROR: Nanode $LINODE_ID did not get an IP in time"
  exit 1
fi

PROXY_URL="http://${IP}:8080/${SECRET_TOKEN}"

echo ""
echo "=== CLOB Proxy Nanode Provisioned ==="
echo ""
echo "  Linode ID: $LINODE_ID"
echo "  IP:        $IP"
echo "  Region:    $NANODE_REGION (Toronto)"
echo "  Cost:      \$5/mo"
echo ""
echo "  Proxy URL: $PROXY_URL"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Wait ~2 minutes for cloud-init to finish installing nginx"
echo ""
echo "2. Verify proxy is up:"
echo "   curl http://${IP}:8080/${SECRET_TOKEN}/"
echo "   (should return \"OK\")"
echo ""
echo "3. Verify geoblock bypass:"
echo "   curl -X POST http://${IP}:8080/${SECRET_TOKEN}/order -d '{}'"
echo "   (should return 401 auth error, NOT 403 geoblock)"
echo ""
echo "4. Add to .env.local:"
echo "   CLOB_PROXY_URL=${PROXY_URL}"
echo ""
echo "5. Deploy to US VMs via fleet-push-polymarket-skill.sh"
