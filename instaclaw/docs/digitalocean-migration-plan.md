# InstaClaw — Cloud Provider Migration Plan: Hetzner → DigitalOcean

## Background

InstaClaw is a SaaS that provisions dedicated VMs for each user, running OpenClaw (an AI agent platform). Each user gets their own VM with a Telegram bot, SSH access, and a gateway. Currently hosted on Hetzner Cloud (CPX21 instances), but we've been locked out of our Hetzner account and need to migrate to a new provider ASAP. We have 300+ people on the waitlist and need to start onboarding users immediately.

## Current Architecture

### How it works today:
1. Admin runs `./scripts/open-spots.sh N` to provision N VMs from a Hetzner snapshot
2. VMs are inserted into Supabase (`instaclaw_vms` table) with status `ready`
3. When a user signs up with an invite code and picks a plan, a VM is assigned to them
4. The app SSHs into the VM and runs OpenClaw CLI commands to configure it (bot token, API key, model, etc.)
5. A Caddy reverse proxy is set up for TLS via Let's Encrypt + GoDaddy DNS

### Current Hetzner specs:
- **Server type**: CPX21 (2 vCPU, 4GB RAM, 40GB SSD)
- **Cost**: ~$7/month per VM
- **Region**: Ashburn (ash)
- **OS**: Ubuntu 24.04 (deployed from a pre-configured snapshot)
- **Provisioning time**: ~30 seconds

### Key files:
- `instaclaw/scripts/open-spots.sh` — Shell script that talks to Hetzner API + Supabase to provision VMs
- `instaclaw/lib/ssh.ts` — TypeScript module that SSHs into VMs to configure OpenClaw (provider-agnostic)
- `instaclaw/.env.local` — Contains `HETZNER_API_TOKEN` and `HETZNER_SNAPSHOT_ID`

## Cloud Provider Comparison

| Feature | Hetzner (current) | DigitalOcean | Vultr | Linode (Akamai) |
|---|---|---|---|---|
| **4GB/2vCPU price** | ~$7/mo | $20/mo | $20/mo | $24-30/mo |
| **API quality** | Good REST API | Excellent REST API | Good REST API | Good REST API |
| **Snapshots** | Free | $0.06/GB/mo | Free | Free (limited) |
| **Provisioning speed** | ~30s | ~60s | ~60s | ~60s |
| **US regions** | Ashburn only | NYC, SFO, TOR | 8+ US locations | Newark, Dallas, Fremont |
| **Firewall API** | Yes | Yes (Cloud Firewalls) | Yes (Firewall Groups) | Yes (Cloud Firewalls) |
| **SSH key API** | Yes | Yes | Yes | Yes |
| **Free credits** | None | $200 for 60 days (new accounts) | $100-250 (varies) | $100 for 60 days |
| **Startup program** | None | Hatch program ($5k+) | None notable | None notable |

### Recommendation: DigitalOcean

**Why DigitalOcean over Vultr:**
- Better documentation and larger community
- $200 free credits for new accounts (immediate relief)
- Hatch startup program for additional credits down the line
- More mature API with better SDKs
- Established brand — good for investor conversations
- Slightly better uptime track record

**The tradeoff:** $20/mo per VM vs Hetzner's $7/mo. That's ~3x the cost per user. Once Hetzner access is restored, we can run both providers simultaneously or migrate back. The code supports this since `instaclaw_vms` has a `provider` column.

## Migration Plan

### Phase 1: DigitalOcean Account Setup (manual, ~30 min)

1. **Create DigitalOcean account** at digitalocean.com
   - Use a referral link if available for $200 credit
2. **Upload SSH key**
   - Name it `instaclaw-deploy`
   - Use the same public key that matches `SSH_PRIVATE_KEY_B64` in `.env.local`
   - Decode the current key: `echo $SSH_PRIVATE_KEY_B64 | base64 -d` to get the private key, then extract the public key
3. **Create a Cloud Firewall** named `instaclaw-firewall`
   - Inbound rules:
     - TCP 22 (SSH) — from anywhere
     - TCP 80 (HTTP) — from anywhere (for Let's Encrypt ACME challenge)
     - TCP 443 (HTTPS) — from anywhere (for Caddy TLS)
     - TCP 18789 (OpenClaw gateway) — from anywhere
   - Outbound: allow all
4. **Create a base droplet** (Ubuntu 24.04, s-2vcpu-4gb, nyc1 region)
   - SSH in as root, create `openclaw` user
   - Install nvm, Node 22, OpenClaw CLI
   - Install fail2ban, configure SSH hardening
   - Match the exact setup of the current Hetzner snapshot
5. **Take a snapshot** of the configured droplet
   - Name it `instaclaw-base-YYYY-MM-DD`
   - Note the snapshot ID
6. **Destroy the base droplet** (you only need the snapshot)

### Phase 2: Environment Variables

Add to `.env.local` and Vercel environment variables:
```
DIGITALOCEAN_API_TOKEN="dop_v1_xxxxxxxxxxxxxxxxxxxxx"
DIGITALOCEAN_SNAPSHOT_ID="123456789"
```

### Phase 3: Update `open-spots.sh` (~30 min code change)

The script needs these specific changes:

#### API Endpoint Changes:
```
# Hetzner → DigitalOcean
https://api.hetzner.cloud/v1/servers     → https://api.digitalocean.com/v2/droplets
https://api.hetzner.cloud/v1/ssh_keys    → https://api.digitalocean.com/v2/account/keys
https://api.hetzner.cloud/v1/firewalls   → https://api.digitalocean.com/v2/firewalls
```

#### Auth Header:
```
# Hetzner
-H "Authorization: Bearer ${HETZNER_TOKEN}"

# DigitalOcean
-H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}"
```

#### Create Server Request Body:
```json
// Hetzner
{
  "name": "instaclaw-vm-08",
  "server_type": "cpx21",
  "image": "356063424",
  "location": "ash",
  "ssh_keys": [12345],
  "firewalls": [{"firewall": 67890}]
}

// DigitalOcean
{
  "name": "instaclaw-vm-08",
  "size": "s-2vcpu-4gb",
  "image": "123456789",
  "region": "nyc1",
  "ssh_keys": ["ab:cd:ef:..."],
  "tags": ["instaclaw"],
  "user_data": "..."
}
```

Note: DigitalOcean firewalls are applied via tags, not directly in create request. Apply firewall to tag `instaclaw` after creation, or pre-configure it.

#### Response Parsing:
```
# Hetzner
server.id                          → droplet.id
server.status                      → droplet.status
server.public_net.ipv4.ip          → droplet.networks.v4[0].ip_address (where type="public")

# Polling for status
GET /v1/servers/{id}               → GET /v2/droplets/{id}
status == "running"                → status == "active"
```

#### Cloud-Init / User Data:
Both providers support cloud-init user_data. The existing cloud-init script works as-is on DigitalOcean — no changes needed.

### Phase 4: Update Supabase Records

When inserting new VMs into `instaclaw_vms`, set:
```json
{
  "provider": "digitalocean",
  "provider_id": "droplet-id-here",
  "server_type": "s-2vcpu-4gb",
  "region": "nyc1"
}
```

The `hetzner_server_id` column can be ignored (nullable) — or optionally renamed to `provider_server_id` if we want to be clean.

### Phase 5: What Does NOT Change

These files/systems require ZERO modifications:
- `lib/ssh.ts` — All SSH-based VM configuration is provider-agnostic
- `lib/godaddy.ts` — DNS record creation for TLS
- `lib/security.ts` — Token generation, encryption
- `lib/auth.ts` — User authentication
- `lib/email.ts` — Invite/welcome emails
- All API routes — Dashboard, onboarding, billing, health checks
- All frontend components
- Supabase schema (the existing columns support this)
- The entire user-facing onboarding flow

## DigitalOcean API Quick Reference

### Create a Droplet
```bash
curl -X POST "https://api.digitalocean.com/v2/droplets" \
  -H "Authorization: Bearer $DO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "instaclaw-vm-08",
    "region": "nyc1",
    "size": "s-2vcpu-4gb",
    "image": SNAPSHOT_ID,
    "ssh_keys": [SSH_KEY_FINGERPRINT],
    "tags": ["instaclaw"],
    "user_data": "BASE64_CLOUD_INIT"
  }'
```

### Get Droplet (poll for status)
```bash
curl "https://api.digitalocean.com/v2/droplets/{droplet_id}" \
  -H "Authorization: Bearer $DO_TOKEN"
```

### List SSH Keys
```bash
curl "https://api.digitalocean.com/v2/account/keys" \
  -H "Authorization: Bearer $DO_TOKEN"
```

### Delete a Droplet
```bash
curl -X DELETE "https://api.digitalocean.com/v2/droplets/{droplet_id}" \
  -H "Authorization: Bearer $DO_TOKEN"
```

### Take a Snapshot
```bash
curl -X POST "https://api.digitalocean.com/v2/droplets/{droplet_id}/actions" \
  -H "Authorization: Bearer $DO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "snapshot", "name": "instaclaw-base-2026-02-11"}'
```

## Base VM Snapshot Setup Checklist

When creating the DigitalOcean base snapshot, the VM must have:

- [ ] Ubuntu 24.04 LTS
- [ ] `openclaw` user created with SSH key authorized
- [ ] nvm installed for `openclaw` user
- [ ] Node.js 22 installed via nvm
- [ ] OpenClaw CLI installed globally: `npm install -g openclaw@2026.2.3`
- [ ] fail2ban installed and configured
- [ ] SSH hardened (disable root password login)
- [ ] UFW configured (ports 22, 80, 443, 18789)
- [ ] `/home/openclaw/.openclaw/` directory created with correct permissions
- [ ] Placeholder config at `/home/openclaw/.openclaw/openclaw.json`

This matches the existing Hetzner snapshot exactly. The same cloud-init script in `open-spots.sh` will personalize each new VM on first boot (regenerate SSH host keys, reset machine-id, etc.).

## Cost Analysis

| Scenario | Hetzner Cost | DigitalOcean Cost |
|---|---|---|
| 10 users | $70/mo | $200/mo |
| 50 users | $350/mo | $1,000/mo |
| 100 users | $700/mo | $2,000/mo |
| 300 users | $2,100/mo | $6,000/mo |

At $29/mo Starter plan pricing, DigitalOcean margins:
- Revenue per user: $29/mo
- VM cost: $20/mo
- Gross margin: $9/mo per user (31%)

At $49/mo Pro plan pricing:
- Revenue per user: $49/mo
- VM cost: $20/mo
- Gross margin: $29/mo per user (59%)

Note: Once Hetzner access is restored, we can migrate users back for better margins, or run a multi-cloud setup.

## Rollback Plan

If DigitalOcean doesn't work out:
1. All existing Hetzner VMs are still running (J Wrenn's VM 161 + 3 ready VMs)
2. The `provider` column in `instaclaw_vms` tracks which cloud each VM is on
3. `lib/ssh.ts` doesn't care about the provider — it just needs an IP
4. We can run both providers simultaneously with zero code conflicts
