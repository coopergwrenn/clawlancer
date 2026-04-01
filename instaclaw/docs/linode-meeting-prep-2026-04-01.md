# Linode/Akamai Meeting Prep — InstaClaw Infrastructure Audit
**Date: April 1, 2026**

---

## 1. FLEET HEALTH SNAPSHOT

| Metric | Value | Source |
|--------|-------|--------|
| **VM Type** | `g6-standard-2` (2 vCPU, 4GB RAM, 81GB SSD) | `lib/providers/linode.ts` |
| **Image** | `linode/ubuntu24.04` (or snapshot via `LINODE_SNAPSHOT_ID`) | |
| **Region** | `us-east` (all VMs, single region) | |
| **Max Fleet Size** | 250 VMs (hard ceiling via `MAX_TOTAL_VMS`) | `pool-monitor/route.ts` |
| **Ready Pool Target** | 20 VMs minimum | `MIN_POOL_SIZE` env var |
| **Auto-Provision Cap** | 10 VMs per cron cycle | `MAX_AUTO_PROVISION` |

**Status breakdown** (DB statuses): `provisioning` -> `ready` -> `assigned` -> `failed` / `terminated` / `suspended`

Pull live counts from `instaclaw_get_pool_stats()` RPC or `/hq/fleet-health` before the meeting.

---

## 2. SSH RELIABILITY

| Parameter | Value |
|-----------|-------|
| **Quarantine threshold** | 6 consecutive SSH failures |
| **SSH timeout (health check)** | 10 seconds normal, 5 seconds bulk audit |
| **Fallback** | HTTP gateway health check at `http://{ip}:18789/health` before quarantining |
| **False positive protection** | If SSH fails but HTTP health passes -> reset counter, don't quarantine |
| **Auto-recovery** | Quarantined VMs re-checked; if gateway responds -> un-quarantine |
| **Cloud reboots** | Max 2 per VM before triggering auto-migration |
| **Auto-migration** | 3 per health-check cycle (prevents thundering herd) |

**Key ask for Linode:** SSH failures are our #1 operational headache. The 6-failure threshold with HTTP fallback was added because we were getting false positives. Need to understand if this is a known issue with their SSH stack, especially in `us-east`.

---

## 3. CONFIGURE PERFORMANCE

| Phase | Timeout | Notes |
|-------|---------|-------|
| **Vercel endpoint** | 300s (5 min) | `maxDuration = 300` in configure/route.ts |
| **SSH script upload** | 60s | Single large shell script |
| **Gateway startup poll** | 6s | 1s intervals |
| **Gateway pair attempt** | 9s | 3s waits |
| **Typical total** | 60-150s | SSH + configure + health verify |
| **Rate limit** | 3 attempts per 10 minutes | Prevents configure storms |

**Bottleneck:** The main bottleneck is cloud-init on fresh VMs vs snapshot-based VMs. Snapshot-based provisioning only needs a lightweight personalization script (regenerate SSH keys, machine-id, reset config). Fresh installs need full OpenClaw bootstrap.

**OpenClaw version pinned:** `2026.3.22`

---

## 4. COST ANALYSIS

### Per-VM Cost
| Provider | Monthly | Daily | Notes |
|----------|---------|-------|-------|
| **Linode** | **$24/mo** | ~$0.80/day | g6-standard-2 |
| Hetzner (legacy) | ~$9/mo | ~$0.30/day | CX22, being phased out |
| DigitalOcean (legacy) | $24/mo | ~$0.80/day | Being phased out |

### Fleet Cost Projections
| Scenario | VMs | Monthly VM Cost | Notes |
|----------|-----|----------------|-------|
| **Current ready pool (idle)** | 20 | **$480/mo** | Doing nothing, waiting for users |
| **100 assigned VMs** | 120 total | **$2,880/mo** | 100 active + 20 pool |
| **200 assigned VMs** | 220 total | **$5,280/mo** | Near ceiling |
| **250 (ceiling)** | 250 total | **$6,000/mo** | Hard stop, admin alert |

### Subscription Revenue per User
| Tier | All-Inclusive | BYOK | VM Cost | Margin |
|------|-------------|------|---------|--------|
| Starter | $29/mo | $14/mo | $24/mo | **$5/mo or -$10/mo** |
| Pro | $99/mo | $39/mo | $24/mo | $75/mo or $15/mo |
| Power | $299/mo | $99/mo | $24/mo | $275/mo or $75/mo |

**Critical:** Starter tier all-inclusive barely breaks even on VM cost alone, before API costs. BYOK Starter is underwater. This is the strongest argument for volume discounts.

### API Costs (on top of VM)
| Model | Cost/call | Used for |
|-------|-----------|----------|
| Sonnet | $0.0165 | Default user model |
| Haiku | $0.0044 | Cheaper alternative |
| MiniMax | $0.001275 | Heartbeats (cheapest) |

**Daily spend cap:** $500/day (circuit breaker in margins endpoint)

---

## 5. WHAT WE NEED FROM LINODE

### A. Faster VM Provisioning
- **Current:** Fresh VM cloud-init takes several minutes. Snapshot-based is faster but still requires boot + personalization.
- **Ask:** Can Linode pre-warm VMs or offer faster snapshot restore? Our ready pool of 20 costs $480/mo just sitting idle. Faster provisioning = smaller pool needed = cost savings.

### B. SSH Reliability
- **Current:** We have a 6-failure quarantine threshold with HTTP fallback specifically because of SSH flakiness.
- **Ask:** Are there known SSH reliability issues in `us-east`? Can we get SLA guarantees on SSH uptime? Any recommended configurations for high-frequency SSH (we SSH into each assigned VM every health check cycle)?

### C. Volume Pricing
- **Current:** $24/mo per g6-standard-2 at list price.
- **Running:** 200+ VMs trending to 250 ceiling.
- **Monthly spend:** $4,800-$6,000/mo on compute alone.
- **Ask:** Volume discount tiers? At 200+ VMs we should be getting enterprise pricing. Even 20% off saves $960-$1,200/mo.

### D. Smaller VM Options
- **Current:** g6-standard-2 (4GB RAM). Our systemd config hard-limits OpenClaw to 3.5GB with OOM kill at that threshold.
- **Ask:** Would a 2GB RAM plan work? Our memory soft limit is 3GB, hard limit 3.5GB — but most agents use far less. A cheaper plan (Nanode @ $5/mo or g6-standard-1 @ $12/mo) could cut costs 50-75%.
- **Risk:** Need to validate that OpenClaw + Chrome + cron jobs fit in 2GB. Chrome is the memory hog.

### E. API Improvements
- **Provisioning API:** Batch creation endpoint? Currently we create one at a time.
- **Health monitoring:** Native health check endpoints we could hook into instead of SSH-polling?
- **Webhook/events:** Can we get notified of VM health events instead of polling?
- **Firewall API:** Bulk firewall attachment for fleet operations.

### F. Snapshot-Based Provisioning Performance
- **Current:** We use `LINODE_SNAPSHOT_ID` env var for snapshot-based deploys with a lightweight personalization script.
- **Ask:** Snapshot restore time guarantees? Can we maintain multiple snapshots per region? Snapshot size limits?

### G. Enterprise Support
- **Ask:** Dedicated support channel, faster response times for fleet-wide issues. Our users are paying $29-$299/mo and any outage directly impacts revenue.

### H. Multi-Region
- **Current:** Everything in `us-east`. Single point of failure.
- **Ask:** What's the path to multi-region? Cross-region snapshot copies? Region-aware DNS? Any latency data for `us-east` vs `us-west` vs `eu-west`?

---

## 6. GROWTH PROJECTIONS

| Timeframe | Assumption | VMs Needed | Monthly Cost |
|-----------|-----------|------------|-------------|
| Current | ~100 assigned | ~120 total | ~$2,880 |
| 30 days | +50 users | ~170 total | ~$4,080 |
| 60 days | +100 users | ~220 total | ~$5,280 |
| 90 days | +150 users (near ceiling) | ~250 total | **$6,000 (ceiling)** |

**Ceiling pressure:** At 250 VMs the system stops auto-provisioning and alerts admin. Need to either raise ceiling or get smaller VMs to stay under budget.

### Utilization Rate
- **Pool overhead:** 20 idle VMs out of ~120 total = ~17% idle overhead
- **Active utilization:** Check `instaclaw_daily_usage` for message_count > 0 per day — some assigned VMs may have low-activity users

---

## 7. INFRASTRUCTURE ARCHITECTURE (For Linode Context)

```
User -> Vercel (Next.js) -> Supabase (DB) -> Linode VM (OpenClaw gateway)
                                              |
                                        SSH management
                                        Cloud-init provisioning
                                        Health check polling (every minute)
                                        Config reconciliation
```

**Per-VM stack:**
- Ubuntu 24.04 + OpenClaw 2026.3.22
- 5 cron jobs (strip-thinking, auto-approve, watchdog, heartbeat, silence-watchdog)
- systemd service with memory limits (3GB soft / 3.5GB hard)
- Auto-restart: max 10 in 300s window, 24h forced restart
- ffmpeg + jq + Python openai SDK
- Manifest v51, auto-reconciled by health cron

---

## 8. THE #1 OPERATIONAL PROBLEM: VMs Going Unhealthy (Root Cause Analysis)

This section documents the results of a deep code-level root cause analysis. These are the specific, data-backed problems we'd like Linode's guidance or support on.

### The Problem in Numbers

Our health check cron runs **every 1 minute** against ~200 assigned VMs. It SSHes into each VM, curls the local gateway health endpoint, and marks VMs healthy or unhealthy. The system is producing a high rate of **false unhealthy marks** — VMs that are actually fine get flagged, causing user-visible outages, unnecessary restarts, and cascading failures. This is our #1 source of user complaints ("my agent went offline").

### Root Cause #1: SSH Flakiness Causes Instant False Unhealthy

**What happens:** A single SSH timeout (10-second threshold) immediately marks a VM `health_status = "unhealthy"`. The quarantine threshold is 6 failures, but the unhealthy flag flips on failure #1. On the next cycle (1 minute later), if SSH succeeds, it flips back to healthy. This creates constant flapping.

**Why SSH fails transiently:**
- Network blips between Vercel (serverless, ephemeral IPs) and Linode us-east
- VM kernel load spikes during gateway restart (CPU/IO contention makes sshd slow)
- Linode host-level maintenance or live migration causing brief unresponsiveness

**What we need from Linode:**
- Are there known SSH reliability patterns in `us-east`? Intermittent sshd unresponsiveness?
- Does Linode perform live migrations that could cause 5-15 second SSH blackouts? If so, is there an event/webhook we can subscribe to so we can suppress health checks during maintenance windows?
- Any recommended sshd tuning for high-frequency automated SSH (we connect ~200 VMs every minute from the same source)?

### Root Cause #2: Our Own Security Hardening Blocks Our Own Health Checks

**What happens:** We deploy fail2ban + UFW rate limiting to every VM (standard security hardening). But our health check cron connects to ~200 VMs **sequentially from a single Vercel IP**. Each VM gets 2-4 SSH connections per cycle.

**The conflict:**
- `fail2ban`: maxretry=5, bantime=3600s — if 5 SSH connections fail auth in 10 minutes, the source IP is banned for 1 hour
- `ufw limit ssh`: rate limit of 6 connections per 30 seconds per source IP
- `MaxStartups 10:30:60`: probabilistic rejection above 10 concurrent unauthenticated SSH connections

**The cascade:** If a Vercel IP gets banned by fail2ban on one VM (e.g., due to a key rotation issue), that same IP is used for ALL subsequent VMs in the cycle. But more critically — if the Vercel serverless function happens to reuse an IP that was previously banned, ALL VMs appear SSH-dead simultaneously. This is the most likely cause of "64 unhealthy VMs at once" events.

**What we need from Linode:**
- **Linode Longview or Managed Monitoring**: Could we use Linode's native monitoring instead of SSH-polling? We really just need to know "is port 18789 responding with HTTP 200?" — we don't need SSH for monitoring, only for remediation.
- **LISH API access**: When SSH is dead (fail2ban, sshd crash, network issue), can we use the Linode Shell (LISH) API as a fallback to diagnose and fix VMs without SSH? This would let us recover from fail2ban lockouts without waiting the 1-hour ban window.
- **Instance event webhooks**: Can Linode notify us when a VM is being migrated, rebooted by hypervisor, or experiencing host-level issues? We could suppress health checks during those windows.

### Root Cause #3: No Restart Grace Period + Multiple Independent Restart Sources

**What happens:** We have 7 independent things that restart the gateway process (systemd RuntimeMaxSec daily restart, silence watchdog, VM watchdog, strip-thinking cron, health cron itself, config reconciler, token resync). None of them coordinate. There is no `last_restarted_at` timestamp tracked anywhere.

The gateway takes 15-60 seconds to fully initialize after restart. Our health check runs every 1 minute. If it catches the VM mid-restart, it marks it unhealthy — which can trigger ANOTHER restart at the 3-failure threshold, creating a restart storm.

**This is primarily our code problem** (we're implementing fixes), but Linode context would help:
- How long does a systemd service typically take to restart on g6-standard-2? Is there variance?
- When RuntimeMaxSec triggers a forced restart, does systemd send a SIGTERM with a grace period, or SIGKILL? (Affects whether the gateway can shut down cleanly)
- Any recommendations for "warm restart" patterns where the new process is ready before the old one stops?

### Root Cause #4: OOM Kills from Chrome/Browser Tool

**What happens:** Our gateway runs a browser automation tool (Chromium headless) for web browsing tasks. Chrome processes can consume 1-2GB RAM. Our systemd MemoryMax is 3.5GB. When Chrome + gateway + cron jobs exceed 3.5GB, the kernel OOM-kills the gateway process.

**Current mitigation:** We kill Chrome processes >30 minutes old or using >40% RAM. But Chrome can spike memory rapidly on complex pages.

**What we need from Linode:**
- **Memory pressure metrics via API**: Can we get real-time or near-real-time memory usage per instance via Linode API? Currently we SSH in and read `/proc/meminfo`, which adds to the SSH load.
- **OOM event notifications**: Can Linode alert us when a cgroup OOM kill happens? We'd like to know immediately when a VM's gateway gets OOM-killed, rather than discovering it on the next health check cycle.
- **Would upgrading to g6-standard-4 (8GB) help?** At volume pricing, would it be cost-effective to double RAM? Our current g6-standard-2 (4GB) is tight — the gateway itself uses ~500MB-1GB, Chrome uses 1-2GB, and cron jobs + system use ~500MB. That's 2-3.5GB typical, spiking to 4GB+ on complex browser tasks. 8GB would give breathing room.

### Root Cause #5: Sequential SSH Processing (~33 Minutes for Full Fleet)

**What happens:** Our health check processes ~200 VMs sequentially in a single Vercel serverless function invocation (maxDuration=600s / 10 minutes). At 10-second SSH timeout per VM worst case, this takes ~33 minutes. Since the cron fires every minute, multiple instances run simultaneously and can interfere with each other.

**What we need from Linode:**
- **Bulk instance status API**: Instead of SSHing into each VM, can we query Linode's API for instance health status in bulk? Something like `GET /linode/instances?tags=instaclaw&fields=status,ipv4` that returns all 200+ VMs in one call.
- **Custom health check endpoint**: Can Linode's infrastructure monitor a custom port (18789) and report health status? Similar to a load balancer health check, but for standalone instances.
- **NodeBalancer with health checks**: Even if we don't load-balance traffic, could we use a NodeBalancer purely for its health check monitoring? It already monitors backend ports and reports status.

---

## 9. SPECIFIC QUESTIONS FOR LINODE TEAM

### SSH & Networking
1. Are there known intermittent SSH reliability issues on `us-east` g6-standard-2 instances?
2. Does Linode perform live migrations on g6-standard-2? If so, typical duration of network disruption?
3. Is there an events/webhooks API for host maintenance, migrations, or network issues affecting an instance?
4. Recommended sshd configuration for automated fleet management (200+ VMs, per-minute health checks)?
5. Can we get Vercel-compatible egress IP ranges to whitelist in fail2ban, or is there a better approach?

### Monitoring & Observability
6. Can Linode Longview (or equivalent) monitor a custom HTTP health endpoint (port 18789) and expose status via API?
7. Is there a bulk API to query instance status/health for all instances with a given tag?
8. Can we receive webhooks/notifications for OOM kills, instance reboots, or resource exhaustion events?
9. Is LISH accessible via API for emergency remediation when SSH is blocked/down?

### Infrastructure
10. Can we use NodeBalancers purely for health check monitoring (not load balancing)?
11. What's the fastest path to snapshot-based provisioning? Current boot + cloud-init personalization time?
12. Is there a private networking option between Vercel and Linode (VPC peering, private IPs) to reduce SSH latency/failures?
13. For g6-standard-2 at 200+ instances: volume pricing options? Would g6-standard-4 at volume be cost-competitive?

### Scaling
14. Any hard limits on instances per account/region we should plan for?
15. Batch instance creation API? Currently we provision one at a time.
16. Multi-region snapshot replication? We want to expand beyond us-east.

---

## 10. WHAT WE'RE FIXING ON OUR SIDE (For Context)

These are the code-level fixes we're implementing regardless of Linode's answers. Sharing for context so they understand our architecture:

| Fix | Description | Status |
|-----|-------------|--------|
| **Restart grace period** | Add `last_gateway_restart` column. Health check skips VMs restarted in last 2 minutes. | Planned |
| **SSH failure debounce** | Don't mark unhealthy on first SSH failure. Require 2+ consecutive failures. | Planned |
| **HTTP-first monitoring** | Use direct HTTP to port 18789 as primary health check instead of SSH. SSH only for remediation. | Planned |
| **Restart lock file** | Coordinate all 7 restart sources via `/tmp/ic-restart.lock` on each VM. | Planned |
| **Cron dedup** | Prevent overlapping health check runs via DB lock. | Planned |
| **Flapping detection** | Track health state transitions. Quarantine VMs with 10+ flips in 24 hours. | Planned |
| **fail2ban whitelist** | Whitelist health check IPs in jail.local. | Planned |

If Linode has native monitoring (Longview, NodeBalancer health checks, bulk status API), fixes 2-3 become less critical because we'd eliminate SSH from the monitoring path entirely.
