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
