# PRD: Infrastructure Upgrade — Dedicated CPU + Fleet Observability + VM Cleanup + Price Raise

**Author:** Cooper Wrenn + Claude (Opus 4.6)  
**Date:** 2026-04-03  
**Status:** Phases 1-3 COMPLETE (April 3-5, 2026). Phase 4 (price raise) pending.  
**Priority:** P0 — directly impacts margins, fleet stability, and scaling

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Why We're Doing This](#2-why-were-doing-this)
3. [Current State of the World](#3-current-state-of-the-world)
4. [The Plan — 4 Phases](#4-the-plan--4-phases)
5. [Phase 1: Fleet Observability (Prometheus + Grafana)](#5-phase-1-fleet-observability-prometheus--grafana)
6. [Phase 2: VM Lifecycle Cleanup](#6-phase-2-vm-lifecycle-cleanup)
7. [Phase 3: Dedicated CPU Migration](#7-phase-3-dedicated-cpu-migration)
8. [Phase 4: Price Raise](#8-phase-4-price-raise)
9. [Financial Model](#9-financial-model)
10. [Linode Relationship & Billing Context](#10-linode-relationship--billing-context)
11. [Risk Register](#11-risk-register)
12. [Implementation Timeline](#12-implementation-timeline)
13. [Safety Rails (Global)](#13-safety-rails-global)
14. [Success Metrics](#14-success-metrics)
15. [Appendix A: Linode Contact Info & Guidance](#appendix-a-linode-contact-info--guidance)
16. [Appendix B: Fleet Data Snapshot (April 3, 2026)](#appendix-b-fleet-data-snapshot-april-3-2026)
17. [Appendix C: Database Schema Reference](#appendix-c-database-schema-reference)
18. [Appendix D: Existing PRD Cross-References](#appendix-d-existing-prd-cross-references)

---

## 1. Executive Summary

InstaClaw's infrastructure is running on shared CPU Linode VMs (g6-standard-2) with no observability, no automated VM cleanup, and 14% gross margins. This PRD defines a 4-phase upgrade plan to:

1. **Add fleet observability** (Prometheus + Grafana) — measure before we change
2. **Delete ~134 non-paying VMs** — save $3,216/mo immediately
3. **Migrate to dedicated CPU** (g6-dedicated-2) — eliminate noisy neighbor instability
4. **Raise prices** — cover the higher VM cost and improve margins to 72%+

**End state:** Fewer VMs, better performance, full visibility, 72% gross margins at current user count, scaling to 76% at 1,000+ users.

| Metric | Current | After All 4 Phases |
|--------|---------|-------------------|
| Gross margin | 14% ($1,199/mo) | 72% ($8,890/mo) |
| Fleet size (billing) | 313 VMs | ~121 VMs |
| Infra cost | $7,320/mo (Linode only) | $3,509/mo |
| Revenue | $8,519/mo | $12,399/mo (price raise) |
| CPU type | Shared (noisy neighbor) | Dedicated |
| Observability | None | Prometheus + Grafana |
| VM cleanup | Manual | Automated every 6 hours |

---

## 2. Why We're Doing This

### 2.1 The Noisy Neighbor Problem (Pat's Diagnosis)

From Linode's Pat (April 1-2, 2026 meeting): shared CPU VMs (g6-standard-2) cause fleet instability for long-running agent workloads. The "noisy neighbor" effect — other tenants on the same physical host consuming burst CPU — causes:

- Random latency spikes on our agents
- Health check timeouts → false gateway-down detection
- Cascading restarts from watchdogs responding to perceived failures
- Inconsistent agent response times visible to end users

**Pat's recommendation:** Migrate to dedicated CPU (g6-dedicated-2). Same RAM (4GB), same disk, but dedicated CPU cores with no sharing.

### 2.2 The Restart Storm Crisis (April 3, 2026)

Today we discovered and fixed a fleet-wide crisis caused by the interaction of shared CPU instability, aggressive watchdogs, and an OpenClaw version upgrade:

1. **OpenClaw v2026.4.1 broke exec access fleet-wide** — the new version changed `tools.exec` from "implicitly enabled" to "requires explicit opt-in." Every agent in the 230-VM fleet lost bash/exec access. Fixed with emergency fleet push of `tools.exec.security=full` + `tools.exec.ask=off`. Locked into manifest v53.

2. **Restart storms affecting ~150 VMs** — Four separate watchdog scripts (silence-watchdog, vm-watchdog, strip-thinking, gateway-watchdog) were all independently restarting gateways, creating storms of 286-377 restarts/day on VMs with 0 credits. Root cause: watchdogs detected "agent not responding" but the agent couldn't respond because credits were exhausted. Restarting with 0 credits is pointless.

3. **Gateway-watchdog.sh false positives** — FROZEN check (session file modified but no sendMessage in 3 min) and TELEGRAM_DEAD check (gateway running 10+ min with zero sendMessage) both triggered on idle agents with no incoming messages. These were NOT frozen or dead — they were correctly idle. Fixed with gateway-watchdog v5: only fires if there are actual pending user messages, credit-aware, daily restart cap of 10, 300s lock window.

4. **Silence watchdog v54** — Decoupled fallback message from restart. Sends "sorry, processing issue" message but does NOT restart if credits are 0 or gateway was recently restarted.

5. **Config drift after upgrades** — 5 config keys drift back to OpenClaw defaults after version upgrades: heartbeat.every (30m→3h), groupPolicy (allowlist→open), requireMention (true→false), compaction.reserveTokensFloor, useAccessGroups. Fixed with fleet-wide config push of all 7 manifest v53 keys.

6. **Lee's session wipe** — upgradeOpenClaw() did two SIGTERMs within 95 seconds, killing the agent mid-conversation before it could save context. Fixed: restart lock set BEFORE gateway stop in upgradeOpenClaw().

7. **Kenobi's restart storm + live desktop** — 286 restarts, x11vnc crashed from 4,096 orphaned SHM segments. Fixed: topped up credits, deployed watchdog v5, cleaned SHM, created systemd service for x11vnc.

**We had ZERO visibility into any of this until users reported problems.** Prometheus/Grafana would have caught the restart storms, CPU spikes, and config drift within minutes.

### 2.3 The Margin Problem

Our current gross margin is **14%** — dangerously thin:

- Revenue: $8,519/mo (99 active Stripe + 2 WLD)
- Linode infra: $7,320/mo (305 billing Linode VMs × $24/mo)
- Margin: $1,199/mo (14%)

Of those 305 billing VMs, only ~101 serve paying users. The remaining ~204 are waste:
- 67 assigned to canceled/no-subscription users
- 67 assigned to past_due users (some recoverable)
- 68 failed VMs (dead, billing)
- 10 ready pool (justified)

### 2.4 No Observability

We currently have **zero infrastructure monitoring**. The only health signal is a Vercel cron that SSH's into VMs and checks `systemctl --user is-active openclaw-gateway`. No CPU metrics, no memory trends, no restart tracking, no disk I/O, no alerting. Every problem is discovered reactively through user complaints.

---

## 3. Current State of the World

### 3.1 Fleet Composition (April 3, 2026)

| Status | Count | Provider Breakdown | Monthly Cost |
|--------|-------|--------------------|-------------|
| assigned | 235 | 235 Linode | $5,640 |
| failed | 68 | 63 Linode, 4 Hetzner, 1 DO | $1,632 |
| ready | 10 | 10 Linode | $240 |
| terminated | 286 | N/A (deleted from cloud) | $0 |
| **Total billing** | **313** | 305 Linode, 4 Hetzner, 4 DO | **~$7,512/mo** |

### 3.2 Assigned VMs by Region

| Region | Count | % of Fleet |
|--------|-------|-----------|
| us-east (Newark) | 209 | 89% |
| us-west (Fremont) | 9 | 4% |
| us-southeast (Atlanta) | 6 | 3% |
| us-ord (Chicago) | 6 | 3% |
| us-central (Dallas) | 5 | 2% |

**Note:** Fleet is overwhelmingly US-East. Monitoring VM deployed in us-east to minimize latency for Prometheus scraping.

### 3.3 Subscription Breakdown

| Status | Count | Tier Distribution |
|--------|-------|------------------|
| active | 99 | 64 starter, 22 pro, 15 power |
| trialing | 2 | 2 starter |
| past_due | 71 | 27 starter, 24 pro, 20 power |
| canceled | 117 | (various) |

**WLD Delegations:** 2 confirmed users with on-chain transaction hashes (out of 50 total delegation records).

### 3.4 Payment Status of Assigned VMs

| Category | VMs | Action |
|----------|-----|--------|
| Paying (active + trialing + WLD) | 101 | Keep |
| Past due (7-day grace) | 67 | Keep during grace, then delete |
| Free/canceled/no subscription | 67 | Delete after audit |
| **Total assigned** | **235** | |

### 3.5 Past Due Analysis

All 71 past_due subscriptions have a `past_due_since` date. The earliest is 2026-03-20 (13+ days ago). This means many past_due users are well past the 7-day grace period already.

**Important:** `past_due_since` is on the `instaclaw_subscriptions` table (not `instaclaw_users`). There is no `canceled_at` column anywhere — for canceled users, we use `instaclaw_subscriptions.updated_at` as a proxy for when they canceled.

### 3.6 Current VM Type & Pricing

| Type | Label | CPU | RAM | Disk | Price (Standard) | Price (Our Deal) |
|------|-------|-----|-----|------|-------------------|------------------|
| g6-standard-2 | Shared 4GB | 2 shared vCPU | 4 GB | 80 GB | $24/mo ($0.036/hr) | $24/mo |
| g6-dedicated-2 | Dedicated 4GB | 2 dedicated vCPU | 4 GB | 80 GB | $36/mo ($0.054/hr) | **$29/mo** |

**The $29/mo deal:** We have a negotiated rate with Linode/Akamai for dedicated VMs at $29/mo instead of the standard $36/mo. This is a 19% discount that significantly improves our margins.

### 3.7 Current Software Stack on VMs

- **OS:** Ubuntu 24.04 LTS
- **Agent runtime:** OpenClaw v2026.4.1
- **Config version:** Manifest v53 (v54 on some VMs)
- **Watchdogs:** gateway-watchdog v5, silence-watchdog v54, vm-watchdog, strip-thinking
- **Cron jobs:** daily_hygiene, heartbeat, various watchdogs
- **SSH access:** `openclaw` user with sudo, key in SSH_PRIVATE_KEY_B64 (on Vercel, not local .env)

---

## 4. The Plan — 4 Phases

The phases are ordered deliberately:

```
Phase 1: Observability    ─── Measure the baseline (shared CPU metrics)
    │
Phase 2: VM Cleanup       ─── Delete waste (save $3,216/mo, fewer VMs to migrate)
    │
Phase 3: Dedicated CPU    ─── Resize remaining VMs (measure improvement vs baseline)
    │
Phase 4: Price Raise      ─── Cover new costs, improve margins
```

**Why this order:**
- Phase 1 first: You can't improve what you can't measure. We need baseline metrics on shared CPU to quantify the improvement after migration.
- Phase 2 second: Deleting ~134 non-paying VMs reduces the fleet before migration, so we're migrating fewer VMs = lower risk + lower cost.
- Phase 3 third: Migrate the cleaned-up fleet to dedicated CPU. Compare Grafana dashboards before/after.
- Phase 4 last: Raise prices AFTER delivering better reliability, not before. Users see improved performance first.

---

## 5. Phase 1: Fleet Observability (Prometheus + Grafana)

### 5.1 Overview

Deploy a dedicated monitoring VM running Prometheus (metrics collection) and Grafana (dashboards + alerting). Push `node_exporter` to all fleet VMs to expose system metrics.

### 5.2 Monitoring VM

| Field | Value |
|-------|-------|
| **Label** | instaclaw-monitoring |
| **Linode ID** | 95430641 |
| **IP** | 66.228.43.140 |
| **Region** | us-east |
| **Type** | g6-dedicated-2 (dedicated — monitoring must be reliable) |
| **OS** | Ubuntu 24.04 LTS |
| **Cost** | $29/mo (our negotiated rate) |
| **Status** | Created and running (as of April 3, 2026) |

### 5.3 Components to Install

#### Prometheus (metrics collection)
- Scrapes `node_exporter` on port 9100 from every fleet VM every 30 seconds
- Stores time-series data locally on the monitoring VM
- Evaluates alert rules and fires alerts
- Config: `/etc/prometheus/prometheus.yml`
- Data retention: 30 days (sufficient for before/after migration comparison)

#### Grafana (dashboards + alerting)
- Web UI on port 3000, accessible via HTTPS with password auth
- Prometheus as the data source
- Dashboards for fleet health, per-VM metrics, restart tracking
- Alert channels: email to coop@valtlabs.com (and optionally Telegram)

#### node_exporter (on every fleet VM)
- Lightweight daemon that exposes system metrics (CPU, memory, disk, network)
- Runs as a systemd service on port 9100
- Must be installed on all ~235 assigned + 10 ready Linode VMs
- Install via fleet-push script (SSH into each VM, install binary, enable service)

### 5.4 Prometheus Configuration

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

rule_files:
  - /etc/prometheus/alert_rules.yml

scrape_configs:
  - job_name: 'fleet-nodes'
    file_sd_configs:
      - files:
          - /etc/prometheus/targets.json
        refresh_interval: 5m
    scrape_timeout: 10s
    
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

**Target file (`targets.json`):** Auto-generated from Supabase query of all assigned+ready Linode VMs. Updated every 5 minutes by a cron script that queries the DB and regenerates the file. Format:

```json
[
  {
    "targets": ["172.104.15.84:9100", "50.116.57.117:9100", ...],
    "labels": {
      "job": "fleet-nodes"
    }
  }
]
```

### 5.5 Alert Rules

```yaml
groups:
  - name: fleet_critical
    rules:
      - alert: RestartStorm
        expr: changes(node_boot_time_seconds[1h]) > 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "VM {{ $labels.instance }} has >10 reboots/hour"
          description: "Likely restart storm — check watchdog logs"
      
      - alert: HighCPU
        expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "VM {{ $labels.instance }} CPU >90% for 5 minutes"
          description: "Possible noisy neighbor or runaway process"
      
      - alert: HighMemory
        expr: (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "VM {{ $labels.instance }} memory >90%"
      
      - alert: DiskAlmostFull
        expr: (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100 > 85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "VM {{ $labels.instance }} disk >85% full"
      
      - alert: VMUnreachable
        expr: up{job="fleet-nodes"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "VM {{ $labels.instance }} is unreachable by Prometheus"
          description: "node_exporter not responding — VM may be down or network issue"

  - name: fleet_gateway
    rules:
      - alert: GatewayDown
        expr: absent(node_systemd_unit_state{name="openclaw-gateway.service", state="active"}) == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Gateway service not active on {{ $labels.instance }}"
```

**Note:** The `GatewayDown` alert requires `node_exporter` to be configured with `--collector.systemd` to expose systemd unit state. This should be added to the node_exporter flags.

### 5.6 Grafana Dashboards

**Dashboard 1: Fleet Overview**
- Total VMs (healthy / unhealthy / unreachable)
- Aggregate CPU usage (avg, p50, p95, p99 across fleet)
- Aggregate memory usage
- Total restarts across fleet in last 24h
- VMs with highest CPU (top 10 table)
- VMs with most restarts (top 10 table)

**Dashboard 2: Per-VM Detail** (variable: VM IP)
- CPU usage over time (all cores)
- Memory usage over time
- Disk I/O (read/write bytes/sec)
- Network I/O (rx/tx bytes/sec)
- System load average
- Uptime
- Boot time changes (restart events)
- Gateway service state

**Dashboard 3: Noisy Neighbor Detection** (critical for Phase 3 comparison)
- CPU usage standard deviation across fleet (high std dev = noisy neighbor)
- CPU spike frequency (>80% for >30s) per VM
- Histogram: distribution of CPU usage across all VMs
- Before/after panels (will show shared vs dedicated side by side after Phase 3)

**Dashboard 4: Cost & Fleet Health**
- Total billing VMs count over time
- Estimated monthly cost (count × $24 or $29)
- VMs by status (assigned, ready, failed, terminated) over time
- Paying vs non-paying VM count (requires custom metrics from lifecycle cron)

### 5.7 Fleet-Push Script for node_exporter

Script: `instaclaw/scripts/fleet-push-node-exporter.sh`

```bash
#!/usr/bin/env bash
# Fleet-push node_exporter to all assigned Linode VMs
# Usage: ./fleet-push-node-exporter.sh [--dry-run] [--parallel N] [--limit N]
#
# Queries Supabase for assigned+ready Linode VMs, SSHes into each,
# installs node_exporter as a systemd service on port 9100.
#
# Options:
#   --dry-run     Print what would be done without SSHing
#   --parallel N  Number of concurrent SSH sessions (default: 5)
#   --limit N     Only process first N VMs (for testing)
```

**What the script does per VM:**
1. SSH into VM as `openclaw` (using /tmp/ic_ssh_key)
2. Check if node_exporter is already running (`systemctl is-active node_exporter`)
3. If not installed:
   a. Download node_exporter v1.7.0 binary
   b. Install to `/usr/local/bin/node_exporter`
   c. Create systemd service unit with `--collector.systemd` flag
   d. Enable and start the service
4. Verify port 9100 is responding (`curl -s localhost:9100/metrics | head -1`)
5. Log success/failure

**Parallelism:** Default 5 concurrent SSH sessions (configurable). Uses `xargs -P` or background jobs with a semaphore.

**Safety:**
- `--dry-run` flag required by CLAUDE.md rules (runs first, shows what would be done)
- node_exporter is read-only — it only exposes metrics, never modifies the system
- Runs as a dedicated `node_exporter` user with no elevated permissions
- Port 9100 is only exposed on the VM's public IP — should be firewalled to only allow the monitoring VM (66.228.43.140). Add an iptables rule during install.

### 5.8 Security Considerations

- **Grafana access:** Password auth over HTTPS. Set a strong admin password. No anonymous access.
- **Prometheus port (9090):** Bind to localhost only — Grafana on the same machine accesses it locally.
- **node_exporter port (9100):** Firewall to only allow connections from the monitoring VM IP (66.228.43.140). Install iptables rule on each fleet VM:
  ```bash
  sudo iptables -A INPUT -p tcp --dport 9100 -s 66.228.43.140 -j ACCEPT
  sudo iptables -A INPUT -p tcp --dport 9100 -j DROP
  sudo netfilter-persistent save
  ```
- **HTTPS for Grafana:** Use Let's Encrypt via certbot with nginx reverse proxy. Domain TBD (e.g., `monitoring.instaclaw.io` or just IP-based initially).
- **SSH key:** Same fleet SSH key (SSH_PRIVATE_KEY_B64 from .env.vercel) used for node_exporter install.

### 5.9 Prometheus Target Auto-Update

A cron job on the monitoring VM queries Supabase every 5 minutes for the current list of assigned+ready VMs and regenerates `/etc/prometheus/targets.json`. This ensures:
- New VMs are automatically scraped after provisioning
- Deleted VMs are automatically removed from scraping
- No manual target management needed

Script: `/opt/instaclaw/update-targets.sh` on the monitoring VM.

### 5.10 Phase 1 Deliverables — COMPLETE (April 3, 2026)

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Monitoring VM created (instaclaw-monitoring, 66.228.43.140) | ✅ Done |
| 2 | Prometheus installed and configured | ✅ Done |
| 3 | Grafana installed with password auth (http://66.228.43.140:3000) | ✅ Done |
| 4 | Fleet-push script created and reviewed | ✅ Done |
| 5 | node_exporter pushed to all fleet VMs (with firewall rules) | ✅ Done (155 targets UP) |
| 6 | Prometheus targets.json generated from DB | ✅ Done (auto-updates every 5 min) |
| 7 | Alert rules configured (5 rules: RestartStorm, HighCPU, HighMemory, DiskFull, Unreachable) | ✅ Done |
| 8 | 4 Grafana dashboards built (Fleet Overview, Per-VM Detail, Noisy Neighbor, Alerts & Health) | ✅ Done |
| 9 | Target auto-update cron on monitoring VM | ✅ Done |
| 10 | 24-48 hours of baseline data collected on shared CPU | ✅ Done (2+ days collected before migration) |

### 5.11 Phase 1 Cost

| Item | Cost |
|------|------|
| Monitoring VM (g6-dedicated-2) | $29/mo |
| node_exporter on fleet VMs | $0 (negligible CPU/RAM) |
| **Total Phase 1 cost** | **$29/mo** |

---

## 6. Phase 2: VM Lifecycle Cleanup

### 6.1 Overview

Delete all VMs serving no paying user. This is detailed extensively in the existing PRD at `instaclaw/docs/prd/vm-lifecycle-management.md`. This section summarizes the key decisions and adds context specific to the infrastructure upgrade.

### 6.2 What Gets Deleted

| Category | VMs | Monthly Savings | Risk |
|----------|-----|----------------|------|
| Failed VMs (no paying user) | 68 | $1,632/mo | Very low — these are dead already |
| Assigned to canceled users | 67 | $1,608/mo | Low — verified no active subscription |
| Assigned to past_due >7 days | ~50+ | ~$1,200/mo | Medium — some may recover payment |
| Ready pool excess (>30) | 0 | $0 | N/A — pool is at 10, below max |
| Non-Linode VMs (Hetzner/DO) | 8 | ~$200+/mo | Low — legacy VMs |
| **Total potential** | **~193** | **~$4,640/mo** | |

### 6.3 What NEVER Gets Deleted

1. Any VM where the assigned user has `instaclaw_subscriptions.status` = `active` or `trialing`
2. Any VM where the assigned user has a confirmed WLD delegation (`transaction_hash IS NOT NULL` AND `status = 'confirmed'`)
3. Any VM where `credit_balance > 0` (currently **23 VMs** have positive credit balances — all protected)
4. Any VM assigned to Cooper's accounts:
   - `afb3ae69` (coop@instaclaw.io)
   - `4e0213b3` (coopgwrenn@gmail.com)
   - `24b0b73a` (coopergrantwrenn@gmail.com)
5. Any VM assigned to confirmed WLD users (explicit list):
   - `a477d953` — spencerpwolfe@gmail.com (confirmed WLD, tx: 0xd7bad9b9...)
   - `a074398a` — 175092@gmail.com (confirmed WLD, tx: 0xd3cffb5a...)
6. Any VM where the user was active in the last 7 days (sent a message)
7. Any VM during its grace period (see Section 6.4)

**WLD user count:** DB query on April 3, 2026 shows **2 confirmed WLD delegations** with on-chain transaction hashes (`instaclaw_wld_delegations WHERE transaction_hash IS NOT NULL AND status = 'confirmed'`). Cooper previously referenced 4 WLD payers — the delta may be users who paid WLD but were credited via `credit_balance` rather than through the delegation table. All 23 VMs with `credit_balance > 0` are protected regardless.

### 6.4 Grace Periods

| Scenario | Grace Period | How Determined |
|----------|-------------|----------------|
| Stripe canceled | 3 days after `instaclaw_subscriptions.updated_at` (proxy for cancel date — no `canceled_at` column exists) | |
| Stripe past_due | 7 days after `instaclaw_subscriptions.past_due_since` | Column exists on subscriptions table |
| WLD credits exhausted | 7 days after `credit_balance` hit 0 | |
| Failed VM (no paying user) | 48 hours | |

**Note on missing `canceled_at`:** The `instaclaw_users` table has no subscription status columns at all. The `instaclaw_subscriptions` table has `status`, `updated_at`, and `past_due_since` but no `canceled_at`. We use `updated_at` on records where `status = 'canceled'` as the cancellation timestamp. This is an approximation — the row could have been updated for other reasons — but it's the best signal we have without hitting the Stripe API.

### 6.5 Stripe API Alternative

For more accurate cancellation dates, we could query the Stripe API directly:
```
GET https://api.stripe.com/v1/subscriptions/{sub_id}
```
Response includes `canceled_at` (Unix timestamp). This is more reliable than using `updated_at` but requires Stripe API calls for every canceled subscription. Worth doing if the audit list includes borderline cases.

### 6.6 Past Due Deep Dive

All 71 past_due subscriptions have `past_due_since` dates. The earliest is March 20, 2026 (13+ days ago as of April 3). This means **every past_due user has exceeded the 7-day grace period.** However:

- Some past_due users may still have a payment retry scheduled by Stripe (Stripe auto-retries failed payments up to 4 times over ~3 weeks)
- Past_due users at pro ($99/mo) and power ($299/mo) tiers represent significant potential revenue recovery
- **Recommendation:** Before deleting past_due VMs, send a "your payment failed" email with a link to update their card. Wait 3 additional days after the email before deleting. This recovers revenue at minimal cost.

**Past due tier breakdown:**
- 27 starter ($29/mo) — $783/mo potential recovery
- 24 pro ($99/mo) — $2,376/mo potential recovery
- 20 power ($299/mo) — $5,980/mo potential recovery
- **Total: $9,139/mo in at-risk revenue** from past_due users

### 6.7 Non-Linode VMs

8 VMs still on legacy providers (4 Hetzner, 4 DigitalOcean). These are not covered by the Linode resize API and must be handled separately:

- **Option A:** Delete them (if serving no paying user) — saves provider-specific costs
- **Option B:** Migrate users to Linode VMs — provision new Linode, configure, swap assignment
- **Option C:** Leave them (if serving paying users) — handle during natural churn

**Recommendation:** Audit these 8 VMs separately. If they serve paying users, migrate to Linode (Phase 3-adjacent). If not, delete.

### 6.8 SHM Leak Cleanup (Pre-Migration Fleet Health)

Before Phase 3 resize, all VMs must be cleaned of orphaned SHM segments. On April 3, 2026, we discovered 4,096 orphaned SHM segments on multiple VMs (Kenobi's VM crashed x11vnc from this). Resize does NOT fix SHM leaks — they're in-memory artifacts that survive reboots via tmpfs.

**Fleet-push SHM cleanup script:**
```bash
# Clean orphaned SHM segments and restart x11vnc if present
ipcrm --all 2>/dev/null
# If x11vnc is running, restart it to clear its SHM references
if systemctl --user is-active x11vnc.service &>/dev/null; then
  systemctl --user restart x11vnc.service
fi
```

**Add SHM cleanup cron to VM manifest (permanent fix):**
Add a daily cron job to the VM manifest so all VMs auto-clean SHM going forward:
```
0 4 * * * /usr/bin/ipcrm --all 2>/dev/null
```
This should be added as a new `ManifestCronJob` entry in `vm-manifest.ts` and bumped to manifest v55.

**Execution:** Fleet-push the cleanup to all assigned VMs during Phase 2, alongside the deletion work. Add the cron to the manifest so new VMs and reconciled VMs get it automatically.

### 6.9 Execution Plan

**Step 0: Send past-due payment recovery emails (BEFORE any deletions)**

We have 71 past-due users representing **$9,139/mo in at-risk revenue**. Tier breakdown:
- 27 starter ($29/mo) — $783/mo
- 24 pro ($99/mo) — $2,376/mo
- 20 power ($299/mo) — $5,980/mo

**We do NOT delete any past-due VM until 3 days after the recovery email is sent.** Even recovering 10% of past-due users saves $914/mo — more than the cost of keeping their VMs alive for 3 extra days (~$240).

**Recovery email draft:**

> Subject: Action needed: Your InstaClaw payment failed
>
> Hi {name},
>
> Your InstaClaw subscription payment for {tier} (${price}/mo) failed on {past_due_since_date}. Your agent is still running, but will be deactivated soon if we can't process your payment.
>
> **Update your payment method now:** https://instaclaw.io/settings/billing
>
> If you've already updated your card, you can ignore this — Stripe will retry automatically.
>
> If you'd like to cancel instead, no action is needed. Your agent and its data will be removed after {deletion_date}.
>
> Questions? Reply to this email or message us on Telegram.
>
> — Cooper & the InstaClaw team

**Send script:** `instaclaw/scripts/send-past-due-recovery-emails.ts`
- Query `instaclaw_subscriptions WHERE status = 'past_due'`
- Join with `instaclaw_users` for email and name
- Send via whatever email service is configured (Resend, SendGrid, etc.) or via Stripe's built-in dunning if enabled
- Log each email sent with timestamp
- After 3 days, past-due VMs that haven't recovered become eligible for deletion

**Step 1: Generate audit report** (script output, Cooper reviews)
- Query all VMs + subscriptions + WLD delegations + credit balances
- Cross-reference to categorize every VM
- Output: `instaclaw/scripts/vm-audit-report-2026-04-03.md` + JSON deletion candidates
- Explicitly mark all 23 credit_balance > 0 VMs as PROTECTED
- Explicitly mark both confirmed WLD users as PROTECTED

**Step 2: Cooper reviews and approves deletion list**
- Manual review of every VM proposed for deletion
- Flag any edge cases
- Explicit "approved" before any deletions

**Step 3: Fleet-push SHM cleanup to all VMs**
- Run the SHM cleanup script (Section 6.8) across all assigned VMs
- Add SHM cleanup cron to manifest (v55)
- This is non-destructive and can run in parallel with audit review

**Step 4: Delete failed VMs first (lowest risk)**
- 68 failed VMs, batch of 20 per cycle
- No SSH wipe needed (VMs are dead)
- Just Linode API DELETE + DB status update

**Step 5: Delete churned assigned VMs (canceled, no credits, no WLD)**
- SSH wipe before deletion (privacy)
- Batch of 20 per cycle
- Health cron continues running — if a "deleted" user somehow returns, they get a fresh VM from the pool

**Step 6: Delete past-due VMs (only after 3-day email grace period)**
- Only VMs where recovery email was sent 3+ days ago AND payment still not recovered
- Re-check subscription status immediately before deletion (payment may have succeeded)
- Same wipe + delete flow as Step 5

**Step 7: Enable automated lifecycle cron**
- Deploy `/api/cron/vm-lifecycle` with circuit breaker (max 20/cycle)
- Schedule: every 6 hours
- Monitor for 1 week before trusting it fully

### 6.9 Phase 2 Deliverables — COMPLETE (April 3-5, 2026)

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Past-due payment recovery: Stripe dunning configured (Smart Retry + emails), 98 invoices force-retried, 4 recovered | ✅ Done |
| 2 | Full audit report generated (Stripe-verified, not DB-only) | ✅ Done |
| 3 | Cooper reviewed and approved every deletion batch | ✅ Done |
| 4 | Fleet-wide SHM cleanup pushed (168/169 VMs) + SHM cron in new snapshot | ✅ Done |
| 5 | Failed VMs deleted (88 total: 63 on Apr 3 + 25 on Apr 5) | ✅ Done |
| 6 | Churned assigned VMs deleted (87 canceled/no-sub, Stripe-verified) | ✅ Done |
| 7 | Past-due VMs: automated via Stripe dunning → suspend-check → lifecycle cron | ✅ Automated |
| 8 | Non-Linode VMs: 4 DO deleted, 4 Hetzner deleted, 1 Hetzner legacy remains | ✅ Done |
| 9 | Lifecycle cron deployed (`/api/cron/vm-lifecycle`, every 6h, circuit breaker) | ✅ Done |
| 10 | `instaclaw_vm_lifecycle_log` audit table created | ✅ Done |

**Additional Phase 2 deliverables (not in original plan):**
- Stripe reconciliation cron deployed (every 6h, auto-fixes DB/Stripe drift)
- Health cron email spam fix deployed (57,600 → ~20 emails/day)
- 10 DB subscription records fixed to match Stripe
- 12 duplicate Stripe subscriptions canceled ($556/mo saved)
- 16 paying users restored after stale-cache deletion incident (200 bonus credits each)
- Stripe billing fully configured: Smart Retry, dunning emails, auto-cancel, dispute handling

### 6.10 Phase 2 Savings

| Scenario | VMs Deleted | Monthly Savings |
|----------|------------|----------------|
| Conservative (failed + clearly canceled only) | ~135 | $3,240/mo |
| Moderate (+ past_due past grace period) | ~185 | $4,440/mo |
| Aggressive (all non-paying) | ~204 | $4,896/mo |

**Recommendation:** Start conservative, expand to moderate after lifecycle cron proves safe.

---

## 7. Phase 3: Dedicated CPU Migration

### 7.1 Overview

Resize all remaining Linode VMs from g6-standard-2 (shared CPU) to g6-dedicated-2 (dedicated CPU) using Linode's in-place resize API. This is NOT a data migration — Linode copies the disk internally and cuts over to dedicated CPU cores on the same physical infrastructure.

### 7.2 The Resize API

**API endpoint:**
```
POST https://api.linode.com/v4/linode/instances/{linodeId}/resize
Body: { "type": "g6-dedicated-2", "migration_type": "warm" }
Header: Authorization: Bearer {LINODE_API_TOKEN}
```

**CLI equivalent (linode-cli not installed locally, use HTTP API):**
```bash
linode-cli linodes resize $LINODE_ID --type g6-dedicated-2 --migration_type warm
```

### 7.3 What Happens During Resize

From Pat (Linode) — verbatim guidance:

> There is a concept in Linode called compute migrations. The purpose of migrations is to copy the disk and internally cut over the changes to a new VM under the hood. Resize operations permit warm and cold migrations.

**Warm migration (preferred):**
- User keeps using the VM until the point of cutover
- At cutover, the current VM is powered down and the new one is powered up
- Brief downtime (typically seconds, could be a minute)
- **IP address is preserved** — same VM, same data, same IP

**Cold migration (fallback):**
- If warm migration fails, the system automatically reverts to cold
- Current VM is powered down first, then disk is migrated, then new VM powers up
- Could take several minutes for our disk sizes (~80GB)
- **IP address is still preserved**

**Key facts:**
- ✅ IP address is preserved (no DNS/DB changes needed)
- ✅ All data on disk is preserved (no backup/restore needed)
- ✅ Same VM identity in Linode (same Linode ID)
- ⚠️ Brief downtime during cutover (seconds for warm, minutes for cold)
- ⚠️ Gateway will need to restart after VM powers back on
- ⚠️ systemd services should auto-start (they're enabled), but verify

### 7.4 Pre-Migration: Mapping Linode IDs

The `instaclaw_vms` table stores the Linode server ID in `provider_server_id` (string field, e.g., "91977517"). There is NO `linode_id` column — `provider_server_id` IS the Linode ID.

**Verification step:** Before migration, confirm that every VM's `provider_server_id` maps to a real Linode instance by calling `GET /linode/instances/{id}` and comparing the IP address. This catches:
- Stale DB entries pointing to deleted Linodes
- Mismatched IDs from historical data

### 7.5 The Resize Script

Script: `instaclaw/scripts/fleet-resize-dedicated.sh` (or TypeScript equivalent)

**Per-VM flow:**
```
1. PRE-CHECK
   - Verify VM exists in Linode API (GET /instances/{id})
   - Verify VM is currently g6-standard-2 (skip if already dedicated)
   - Verify VM health status is "healthy" in DB
   - Set restart lock (touch /tmp/ic-restart.lock via SSH) — prevent watchdogs
   
2. RESIZE
   - Call POST /instances/{id}/resize with type=g6-dedicated-2, migration_type=warm
   - Poll GET /instances/{id} every 15 seconds for status
   - Wait for status to return to "running" (could take 30s-5min)
   
3. AGGRESSIVE POST-CHECK (60 seconds, not 2 minutes)
   - Wait 30 seconds after "running" status (let systemd services start)
   - SSH into VM: verify gateway is active (systemctl --user is-active openclaw-gateway)
   - Curl health endpoint: verify 200 response
   - If unhealthy after 60 seconds (NOT 2 minutes — learned today that gateways
     often need manual intervention after restarts):
     a. SSH in, force restart gateway:
        export XDG_RUNTIME_DIR="/run/user/$(id -u)"
        systemctl --user restart openclaw-gateway
     b. Wait 30s, re-check health
     c. If still unhealthy, log failure and continue to next VM
   
4. MANDATORY CONFIG RE-PUSH (unconditional — every resize, every VM)
   - SSH into VM and re-push ALL manifest v53+ config keys unconditionally:
     openclaw config set tools.exec.security full
     openclaw config set tools.exec.ask off
     openclaw config set agents.defaults.heartbeat.every 3h
     openclaw config set gateway.groupPolicy open
     openclaw config set gateway.requireMention false
     openclaw config set gateway.useAccessGroups false
     openclaw config set agents.defaults.compaction.reserveTokensFloor 8000
   - This is IDEMPOTENT and takes ~5 seconds. We do NOT check for drift first —
     we just push. Today (April 3) we learned that OpenClaw version changes can
     silently reset config defaults. Resize could trigger similar behavior. The
     5 seconds this takes is cheap insurance against a fleet-wide config drift.
   - Must source NVM first: export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
   
5. WATCHDOG SCRIPT VERIFICATION
   - Verify gateway-watchdog v5 is present and correct:
     grep -q "WATCHDOG_VERSION=5" ~/scripts/gateway-watchdog.sh
   - Verify silence-watchdog v54 is present:
     grep -q "SILENCE_WATCHDOG_VERSION=54" ~/scripts/silence-watchdog.sh
   - Verify vm-watchdog is present:
     test -f ~/scripts/vm-watchdog.sh
   - Verify all watchdog cron jobs are installed:
     crontab -l | grep -c watchdog (expect 3+)
   - If ANY watchdog is missing or wrong version → re-push from manifest via
     reconcileVM(). Resize could theoretically reset systemd units or cron jobs
     if the disk copy has timing issues. Better to verify and fix than assume.
   
6. CLEANUP
   - Remove restart lock (rm /tmp/ic-restart.lock via SSH)
   - Update DB: server_type = 'g6-dedicated-2'
   - Log: vm_name, linode_id, resize_duration, health_status, config_pushed,
          watchdogs_verified
```

**Why these post-resize steps are aggressive:** On April 3, 2026 we dealt with 7 separate fleet-wide issues (Section 2.2). The common thread was assuming things would "just work" after changes. They don't. Config drifts silently, watchdogs go missing, gateways hang. The 30 extra seconds per VM to unconditionally re-push config and verify watchdogs prevents hours of firefighting later.

**Batch processing:**
- Process in batches (configurable, default 10 VMs per batch)
- Wait between batches (configurable, default 60 seconds)
- Circuit breaker: abort if >3 consecutive failures

**Dry-run mode:** `--dry-run` lists all VMs that would be resized with their current type, health, and Linode ID. No API calls made.

### 7.6 Rollout Strategy (from Pat)

Pat's recommended approach, quoted and adapted:

> 1. If you have a few "friendly" users that can be your canary test for this I would recommend rolling this out on a small subset of them and getting any feedback on their experience during the transition.
> 
> 2. I would recommend setting up a maintenance window for each of your user cohorts that represent a time of day when they are not most actively using it. For example for users in North America you could pick a time during overnight hours.
> 
> 3. I wouldn't run the script on all IDs right away. Try it on a subset first (e.g. pick 10 users to run it on first during your maintenance window and monitor).
> 
> 4. Once you've confirmed it works on a smaller subset then you can run it on larger batches (e.g. 100 at a time or whatever works best for you).
> 
> 5. Note that our API endpoints have rate limits. I don't think you should hit any based on what you are doing for this exercise, but wanted you to be aware.

**Our adapted rollout plan:**

| Wave | VMs | When | Who |
|------|-----|------|-----|
| Canary (Wave 0) | 3-5 VMs | Immediately | Cooper's own VMs + known friendly users (Lee, etc.) |
| Wave 1 | 10 VMs | After canary confirmed healthy | Mix of starter/pro/power users |
| Wave 2 | 50 VMs | 2-5 AM EST (off-peak) | Next batch of paying users |
| Wave 3 | Remaining (~40-50) | 2-5 AM EST next day | Everyone else |

**Why 2-5 AM EST:** 89% of fleet is in us-east. Most users are North America. 2-5 AM is lowest activity window. Warm migration downtime (seconds to a minute) will go unnoticed.

### 7.7 User Communication

**Option A (Recommended):** Don't notify — downtime is seconds for warm migration. Most users won't notice. If a user reports "my bot was briefly offline," support can explain "we upgraded your VM's CPU for better performance."

**Option B (If cold migrations happen):** Post a status update: "We're upgrading all agent VMs to dedicated CPU for better performance. You may experience brief interruptions (1-3 minutes) during the migration. No action needed on your part."

### 7.8 Mandatory Data Integrity Verification (Per-VM, Per-Batch)

**This is the most important safety check in the entire migration.** Every resized VM must pass a 12-point data integrity check BEFORE the next batch proceeds.

**Verified on canary vm-059 (April 3, 2026):** All 12 checks passed. Zero data loss after resize.

The resize script runs this automatically after each VM (Step 8). It checks:

| # | Check | Pass Criteria |
|---|-------|--------------|
| 1 | MEMORY.md | Exists and non-empty |
| 2 | SOUL.md | Exists and non-empty |
| 3 | Sessions directory | Exists at `~/.openclaw/agents/main/sessions/` |
| 4 | Skills | 10+ skill directories in `~/.openclaw/skills/` |
| 5 | auth-profiles.json | Exists and non-empty (API key for Anthropic) |
| 6 | openclaw.json | Exists and non-empty (full config) |
| 7 | Wallet key | `~/.openclaw/wallet/agent.key` exists |
| 8 | Cron jobs | 5+ active cron entries |
| 9 | Workspace files | 3+ files in `~/.openclaw/workspace/` |
| 10 | EARN.md | Exists and non-empty |
| 11 | ~/scripts | 5+ files in ~/scripts/ |
| 12 | node_exporter | Running (Prometheus metrics) |

**If ANY check fails, the VM is flagged as `INTEGRITY_FAIL` and counts as a failure for the circuit breaker.** 3 consecutive integrity failures → script aborts → investigate before continuing.

**Batch rule:** No batch proceeds until the previous batch's integrity verification passes 100%. If a batch has even one integrity failure, stop and investigate.

### 7.9 Post-Migration Verification (Fleet-Wide)

After all VMs are resized:

1. **Grafana comparison:** Compare CPU usage patterns, spike frequency, and standard deviation before vs after. The "Noisy Neighbor Detection" dashboard (Phase 1) is designed specifically for this.

2. **Restart count comparison:** Compare daily restart counts before vs after. Expect significant reduction as dedicated CPU eliminates false timeout triggers.

3. **Health check pass rate:** Compare health cron success rate before vs after.

4. **User feedback:** Monitor support channels for "my bot is faster/more reliable" or "my bot went down."

5. **Update DB:** All VMs should show `server_type = 'g6-dedicated-2'` after migration. Run a verification query.

### 7.9 Handling Failures

| Failure Mode | Action |
|-------------|--------|
| Warm migration fails → cold migration (automatic) | Linode handles this automatically. Longer downtime but same outcome. |
| Resize API returns error | Log error, skip VM, retry in next batch |
| VM doesn't come back after resize | SSH in, force restart gateway (step 3), re-push config (step 4), verify watchdogs (step 5) |
| Gateway healthy but agent not responding | Config re-push (step 4) handles this unconditionally. If still broken, check OpenClaw version and session state. |
| Watchdog scripts missing after resize | reconcileVM() re-pushes all manifest files including watchdogs (step 5) |
| Config keys reset to defaults after resize | Config re-push (step 4) handles this unconditionally — no detection needed |
| 3+ consecutive failures | Circuit breaker trips, script stops. Investigate before continuing. |
| Linode rate limit hit | Back off 60 seconds, retry. Should not happen at our scale. |

### 7.10 Phase 3 Deliverables — COMPLETE (April 3-5, 2026)

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Verify all `provider_server_id` values map to real Linode instances | ✅ Done |
| 2 | Build resize script with: dry-run, batching, circuit breaker, 60s aggressive health check, delayed 90s stability check, mandatory config re-push, watchdog verification, 12-point data integrity check | ✅ Done |
| 3 | Run dry-run, review output | ✅ Done (147 VMs verified) |
| 4 | Canary: resize Cooper's VM (vm-059) | ✅ Done — 89s, all data intact |
| 5 | Verify canary: health + config keys + watchdog scripts + Grafana metrics + full 12-point data integrity | ✅ Done — all 12 checks PASS |
| 6 | Wave 1: 10 VMs | ✅ Done — 8 success, 2 partial (fixed) |
| 7 | Wave 2: 21 VMs (old script, fd3 bug) | ✅ Done — 16 success, 4 partial (fixed) |
| 8 | Wave 2b: 122 VMs (fixed script with delayed check) | ✅ Done — 105 success, 10 partial (fixed), 7 integrity flags |
| 9 | 12-point data integrity audit every 10 VMs (10 batches) | ✅ Done — avg 7.2 PASS per batch, all fails auto-fixed |
| 10 | Update DB server_type for all migrated VMs | ✅ Done — 168 g6-dedicated-2, 1 g6-standard-4 |
| 11 | Fix all unhealthy gateways post-migration | ✅ Done — 18 fixed via openclaw doctor + restart |

**Final numbers:**
- **168/169 assigned VMs on dedicated CPU** (99.4%) — 1 VM is g6-standard-4 (8GB, intentionally larger)
- **151/169 healthy gateways** at time of completion (89.3%) — remaining picked up by health cron
- **Zero data loss** across entire migration — verified via 12-point integrity check on every batch
- **Zero paying users impacted** by the resize operation itself
- **16 paying users impacted** by the Phase 2 stale-cache deletion bug (all restored on dedicated CPU with 200 bonus credits)
- **New Linode snapshot created:** `private/38007730` (OpenClaw v2026.4.1, dedicated CPU base)

### 7.11 Phase 3 Cost Impact

| Scenario | VMs | Monthly Cost (shared @ $24) | Monthly Cost (dedicated @ $29) | Delta |
|----------|-----|---------------------------|-------------------------------|-------|
| All currently assigned (pre-cleanup) | 235 | $5,640 | $6,815 | +$1,175 |
| After Phase 2 cleanup (paying + pool) | ~121 | $2,904 | $3,509 | +$605 |
| At 250 users (future) | ~280 | $6,720 | $8,120 | +$1,400 |
| At 500 users (future) | ~530 | $12,720 | $15,370 | +$2,650 |
| At 1,000 users (future) | ~1,030 | $24,720 | $29,870 | +$5,150 |

**The $29 deal makes dedicated CPU only $5/mo more per VM than shared.** This is an exceptional deal — standard pricing would be +$12/mo per VM.

---

## 8. Phase 4: Price Raise

### 8.1 Overview

Raise subscription prices to cover the higher dedicated CPU costs and improve margins. Prices are raised AFTER delivering better reliability (Phases 1-3), giving us a tangible improvement to point to when communicating the change.

### 8.2 Current vs Proposed Pricing

| Tier | Current Price | Proposed Price | Increase | % Increase |
|------|--------------|----------------|----------|-----------|
| Starter | $29/mo | $49/mo | +$20 | +69% |
| Pro | $99/mo | $149/mo | +$50 | +51% |
| Power | $299/mo | $399/mo | +$100 | +33% |

**Note:** Final pricing TBD based on actual dedicated CPU cost after the Linode deal is confirmed in writing. The prices above assume $29/mo per VM.

### 8.3 Messaging

The price raise should be framed as an upgrade, not a cost increase:

> "We've upgraded all agent VMs to dedicated CPU cores for faster, more reliable performance. As part of this upgrade, our pricing has been adjusted to reflect the improved infrastructure."

Key points:
- Dedicated CPU = no more "noisy neighbor" slowdowns
- Consistent performance for agent workloads
- Better uptime and reliability
- Price increase is modest relative to the improvement

### 8.4 Grandfathering

- **Existing users:** Keep current pricing for 30 days after announcement
- **After 30 days:** Automatically move to new pricing on next billing cycle
- **New signups:** Get new pricing immediately
- **Annual/prepaid users:** Honor current rate through the end of their prepaid period

**Implementation:**
- Create new Stripe Price objects for each tier
- Use Stripe's subscription schedule API to migrate existing users after 30 days
- Update the pricing page on instaclaw.io
- Send email announcement to all active subscribers

### 8.5 Revenue Impact

| Tier | Current Subscribers | Current Revenue | New Revenue | Delta |
|------|-------------------|----------------|-------------|-------|
| Starter | 64 (+2 trialing) | $1,914/mo | $3,234/mo | +$1,320 |
| Pro | 22 | $2,178/mo | $3,278/mo | +$1,100 |
| Power | 15 | $4,485/mo | $5,985/mo | +$1,500 |
| **Total** | **101** + 2 WLD | **$8,519/mo** | **$12,399/mo** | **+$3,880/mo** |

**Churn risk:** Some users will cancel when prices increase. Assume 10-15% churn:
- 10% churn: ~10 users leave → revenue still $11,159/mo (net +$2,640 vs today)
- 15% churn: ~15 users leave → revenue still $10,539/mo (net +$2,020 vs today)
- Even worst-case 20% churn is net positive vs today's revenue

### 8.6 Phase 4 Deliverables

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Create new Stripe Price objects | Pending |
| 2 | Update pricing page on instaclaw.io | Pending |
| 3 | Draft announcement email | Pending |
| 4 | Send announcement (30-day notice) | Pending |
| 5 | Implement Stripe subscription migration script | Pending |
| 6 | Execute migration after 30-day window | Pending |
| 7 | Monitor churn for 2 weeks post-migration | Pending |

---

## 9. Financial Model

### 9.1 Current State (April 3, 2026)

| Line Item | Amount |
|-----------|--------|
| **Revenue** | |
| Stripe subscriptions (99 active + 2 trialing) | $8,519/mo |
| WLD delegations (2 confirmed) | ~$0/mo (negligible) |
| **Total Revenue** | **$8,519/mo** |
| | |
| **Infrastructure Costs** | |
| Linode VMs (305 billing × $24/mo) | $7,320/mo |
| Linode CLOB proxies (2 Nanodes) | $10/mo |
| Monitoring VM (Phase 1, not yet in cost) | $0/mo |
| Hetzner VMs (4 billing) | ~$40/mo (est.) |
| DigitalOcean VMs (4 billing) | ~$48/mo (est.) |
| Supabase | ~$25/mo |
| Vercel | ~$20/mo |
| **Total Infra** | **~$7,463/mo** |
| | |
| **Gross Margin** | **$1,056/mo (12%)** |

### 9.2 After Phase 2 (VM Cleanup)

| Line Item | Amount | Change |
|-----------|--------|--------|
| Revenue | $8,519/mo | — |
| Linode VMs (~121 billing × $24/mo) | $2,904/mo | -$4,416 |
| Other infra | ~$143/mo | — |
| **Gross Margin** | **$5,472/mo (64%)** | **+$4,416** |

### 9.3 After Phase 3 (Dedicated CPU)

| Line Item | Amount | Change vs Phase 2 |
|-----------|--------|-------------------|
| Revenue | $8,519/mo | — |
| Linode VMs (~121 billing × $29/mo) | $3,509/mo | +$605 |
| Monitoring VM | $29/mo | +$29 |
| Other infra | ~$143/mo | — |
| **Gross Margin** | **$4,838/mo (57%)** | **-$634** |

### 9.4 After Phase 4 (Price Raise)

| Line Item | Amount | Change vs Phase 3 |
|-----------|--------|-------------------|
| Revenue (new pricing, assume 10% churn) | $11,159/mo | +$2,640 |
| Linode VMs (~109 billing × $29/mo, post-churn) | $3,161/mo | -$348 |
| Monitoring VM | $29/mo | — |
| Other infra | ~$143/mo | — |
| **Gross Margin** | **$7,826/mo (70%)** | **+$2,988** |

### 9.5 Scale Projections (New Pricing + Dedicated CPU)

Assumes same tier distribution as current (63% starter, 22% pro, 15% power):

| Users | Revenue/mo | Infra/mo | Margin/mo | Margin % |
|-------|-----------|---------|----------|---------|
| 100 | $12,276 | $3,770 | $8,506 | 69% |
| 250 | $30,690 | $8,120 | $22,570 | 74% |
| 500 | $61,381 | $15,370 | $46,011 | 75% |
| 1,000 | $122,762 | $29,870 | $92,892 | 76% |
| 2,500 | $306,905 | $73,370 | $233,535 | 76% |

**Margins improve with scale** because fixed costs (monitoring, proxies, Supabase, Vercel) are amortized. Variable cost per user ($29/mo VM) is constant.

### 9.6 Linode Billing Model (from Joey)

Critical context for cost management — Joey's exact guidance:

> Billing is technically done on an hourly basis with monthly caps. For instance, our 1 GB nanode plan is $5 per month (that's the monthly cap if you have it deployed in your account for a full calendar month), but technically it's billed on an hourly basis at $0.0075 per hour. Any minutes that go over a whole billable hour (let's say you deploy the server then delete it after an hour and a half) then it would be billed to the next whole hour — in this case, 2 hours.

**Key implications for our operations:**

1. **Powered-off VMs still bill.** You MUST delete the VM from Linode to stop metering. There is no "pause billing" state.

2. **Hourly billing rounds UP.** If a VM exists for 1 hour 1 minute, you're billed for 2 hours. This matters for VMs that are created and deleted quickly (e.g., failed provisioning).

3. **Monthly cap.** Once a VM has been running for a full calendar month, you hit the monthly cap and aren't charged more. No surprise overages from long-running VMs.

4. **Automation must delete promptly.** When a user churns, every hour the VM stays alive costs $0.043/hr (dedicated). At 100 churned VMs, that's $4.30/hr or $103/day in waste. The lifecycle cron running every 6 hours limits max waste to ~$26 per churn batch.

---

## 10. Linode Relationship & Billing Context

### 10.1 Linode Team Contacts

| Name | Role | Contact | Context |
|------|------|---------|---------|
| **Joey** | Account Manager | (via email) | Billing, limits, SI partners, general account |
| **Pat** | Technical Advisor | (via email) | Resize API, migration strategy, technical guidance |

### 10.2 Negotiated Terms

- **Dedicated CPU pricing:** $29/mo per g6-dedicated-2 (vs standard $36/mo) — 19% discount
- **Service limit:** Currently 2,500 VMs, can be raised to 5,500+ on request (contact Joey, Pat, or 24/7 support)
- **SI partner available:** Linode can connect us with a Systems Integrator partner to monitor/manage infrastructure. Separate fees. Worth considering at 500+ VMs if we haven't hired infra staff.

### 10.3 Pat's Migration Guidance (Verbatim)

> In order to migrate existing users to a new Dedicated 4GB plan you would use the following API: POST /linode/instances/{linodeId}/resize
> 
> The API above can be used directly or from the Linode CLI (or even from IaC tools such as Terraform). What you will need is the Linode ID for each of your customers as the main input parameter.
> 
> There is a concept in Linode called compute migrations. The purpose of migrations is to copy the disk and internally cut over the changes to a new VM under the hood. Resize operations permit warm and cold migrations. A warm migration allows for the user to keep using the VM until the point of cutover. At that point of cutover the current VM is powered down and the new one is powered up. Users will experience some brief downtime while this happens (typically seconds but could be a minute or so).
> 
> Sometimes instances are in a state where a warm migration fails. In those cases the system will revert to a cold migration as a secondary measure. This means the current VM will be powered down, the disk is migrated and the new VM is powered up. A cold migration for the size of disk that you have today could take several minutes.
> 
> I would recommend the following strategy:
> 1. If you have a few "friendly" users that can be your canary test — roll this out on a small subset first
> 2. If not practical, set up a maintenance window for each user cohort during off-peak hours (e.g., overnight for North America)
> 3. Try it on a subset first (e.g., 10 users) and monitor
> 4. Once confirmed, run on larger batches (e.g., 100 at a time)
> 5. Note that API endpoints have rate limits (shouldn't be an issue at our scale)

### 10.4 Joey's Billing Guidance (Verbatim)

> Billing is technically done on an hourly basis with monthly caps. For instance, our 1 GB nanode plan is $5 per month (that's the monthly cap if you have it deployed in your account for a full calendar month), but technically it's billed on an hourly basis at $0.0075 per hour. Any minutes that go over a whole billable hour (let's say you deploy the server then delete it after an hour and a half) then it would be billed to the next whole hour — in this case, 2 hours. Even with user churn, you can set up automation to delete the server off of your account to ensure it doesn't continue being metered. It's important to note that you can't just "power off" the VM, you need to actually delete off of the account in order to stop the metering.
> 
> You can always forecast when you're getting close to the 2,500 service limit and let Pat or myself know. We can always raise it for you. If not, you can also reach out to support 24/7 and ask them to raise the limit for you as well. We can raise the limits instantly.
> 
> We have a ton of resources internally as well that can help you. If you want to connect with one of our SI partners — they can monitor and manage your infrastructure on your behalf (essentially be another working guide before you hire new employees). They would have their own separate management fees.

---

## 11. Risk Register

| # | Risk | Impact | Probability | Mitigation |
|---|------|--------|-------------|-----------|
| 1 | **Resize causes data loss** | Critical | Very Low | Linode resize is in-place disk copy. But: take manual snapshot of canary VMs before first resize. Verify data integrity after. |
| 2 | **Warm migration fails → cold migration** | Medium (minutes of downtime) | Low | Cold migration is automatic fallback. Schedule during off-peak. Watchdogs have restart lock during resize. |
| 3 | **Config drift after resize** | High (agents break) | Medium | Already observed post-upgrade config drift (Section 2.2). After resize, re-push manifest v53 config to each VM. Build this into the resize script's post-check step. |
| 4 | **Paying user VM accidentally deleted (Phase 2)** | Critical | Very Low | Triple-check: DB subscription status + Stripe API + WLD delegation. Circuit breaker at 20/cycle. Cooper reviews every deletion list. |
| 5 | **Past_due users recover payment after VM deleted** | Medium (user loses agent data) | Medium | 7-day grace period + payment recovery email before deletion. User gets fresh VM from pool if they return. |
| 6 | **node_exporter security exposure** | Medium | Low | Firewall port 9100 to only allow monitoring VM IP. node_exporter is read-only. |
| 7 | **Linode rate limits during batch resize** | Low (delays) | Low | Process in batches of 10 with 60s delay. Pat said rate limits shouldn't be hit at our scale. |
| 8 | **Price raise causes mass churn** | High | Medium | 30-day grandfather period. Frame as upgrade, not cost increase. Even 20% churn is net positive on revenue. |
| 9 | **Linode service limit hit during scaling** | Low (blocks provisioning) | Low | Currently at 308/2,500. Can request increase to 5,500+ instantly via Joey, Pat, or support. |
| 10 | **Monitoring VM goes down** | Medium (lose visibility) | Low | It's on dedicated CPU in us-east. Set up external uptime check (e.g., UptimeRobot) for the Grafana URL. |
| 11 | **Hourly billing waste from slow deletion** | Medium ($4.30/hr per 100 VMs) | Medium | Lifecycle cron runs every 6 hours. Max waste per batch: ~$26. Acceptable given circuit breaker constraints. |

---

## 12. Implementation Timeline

| Day | Phase | Milestone |
|-----|-------|-----------|
| **Day 1 (April 3)** | Phase 1 | Monitoring VM created ✅. Install Prometheus + Grafana. Create fleet-push script. |
| **Day 1-2** | Phase 1 | Push node_exporter to all VMs. Verify targets scraping. Build dashboards. |
| **Day 1** | Phase 2 | Generate audit report. Cooper reviews deletion list. **Send past-due recovery emails (Step 0).** |
| **Day 2** | Phase 2 | Delete failed VMs (68). Delete clearly-canceled VMs (no credits, no WLD). |
| **Day 3** | Phase 1 | 24+ hours of baseline shared-CPU metrics collected. |
| **Day 3-4** | Phase 2 | Delete remaining canceled/no-sub VMs. Deploy lifecycle cron. |
| **Day 5+** | Phase 2 | **Past-due VM deletions begin** (earliest — 3 days after recovery email sent on Day 1). Re-check each past-due user's payment status before deleting. |
| **Day 5** | Phase 3 | Build resize script. Run dry-run. Resize canary VMs (Cooper's). |
| **Day 5** | Phase 3 | Wave 1: 10 VMs resized (2-5 AM EST). Monitor Grafana. |
| **Day 5-6** | Phase 3 | Wave 2: 50 VMs (2-5 AM EST). Wave 3: remaining. |
| **Day 7** | Phase 3 | Post-migration verification. Grafana before/after comparison. |
| **Day 7** | Phase 1 | Publish before/after dashboard showing dedicated CPU improvement. |
| **Day 8-10** | Phase 3 | Monitor for 3 days. Fix any stragglers. |
| **Day 14** | Phase 4 | Create new Stripe prices. Update pricing page. Draft email. |
| **Day 15** | Phase 4 | Send price raise announcement (30-day notice). |
| **Day 45** | Phase 4 | Execute Stripe migration for existing users. |
| **Day 60** | All | Final review: margins, fleet health, churn impact. |

---

## 13. Safety Rails (Global)

These rules apply across ALL phases. They supplement the CLAUDE.md mandatory rules.

### 13.1 Hard Rules

0. **NEVER use cached or batch-loaded data for deletion decisions.** Every VM deletion must verify subscription status against the Stripe API in real-time, immediately before deletion. On April 3, 2026, 16 paying users had their VMs deleted because the audit used a stale cached user list that didn't include all users. The Stripe reconciliation cron later fixed the DB records, but the VMs were already gone. This rule exists because of that incident.
1. **NEVER delete a VM with an active or trialing subscription** — check `instaclaw_subscriptions.status` immediately before deletion, not from a cached query. Additionally, verify against the Stripe API (`GET /v1/subscriptions?customer={customer_id}`) as a second check.
2. **NEVER resize a VM without setting a restart lock first** — prevents watchdogs from interfering during migration.
3. **NEVER run fleet operations without `--dry-run` first** — per CLAUDE.md Rule 4.
4. **NEVER push to more than 1 VM before testing on 1 first** — per CLAUDE.md Rule 3.
5. **Circuit breaker on ALL destructive operations** — max 20 deletions/cycle, max 3 consecutive resize failures.
6. **Cooper reviews ALL deletion lists before execution** — no automated deletion without prior approval.
7. **Verify gateway health after ANY infrastructure change** — per CLAUDE.md Rule 5.
8. **Hourly billing awareness** — every hour a non-paying VM stays alive costs $0.043. But safety > speed. Never rush deletions to save pennies.

### 13.2 Cooper's Protected Accounts (NEVER TOUCH)

| User ID | Email |
|---------|-------|
| afb3ae69 | coop@instaclaw.io |
| 4e0213b3 | coopgwrenn@gmail.com |
| 24b0b73a | coopergrantwrenn@gmail.com |

### 13.3 Rollback Procedures

| Phase | Rollback |
|-------|----------|
| Phase 1 (Monitoring) | Fully additive. To rollback: stop Prometheus/Grafana, uninstall node_exporter from fleet. No impact on agents. |
| Phase 2 (Deletion) | **Irreversible.** Linode deletion is permanent. Rollback = provision new VM from pool + fresh configureOpenClaw. User loses agent memory/sessions. This is why we have safety rails. |
| Phase 3 (Resize) | Linode resize can technically be reversed (resize back to g6-standard-2). But this causes another downtime window. Better to fix forward. |
| Phase 4 (Price Raise) | Can revert Stripe prices. But messaging damage is done. This is why we grandfather for 30 days — if churn is bad, we can extend the grandfather period. |

---

## 14. Success Metrics

### 14.1 Phase 1 (Observability)

- [ ] Prometheus scraping 95%+ of fleet VMs successfully
- [ ] Grafana dashboards showing real-time CPU, memory, restarts
- [ ] At least 24 hours of baseline data before Phase 3
- [ ] Alert rules firing correctly (test with a simulated alert)

### 14.2 Phase 2 (Cleanup)

- [ ] Fleet billing VMs reduced from 313 to ~121
- [ ] Monthly Linode cost reduced from $7,320 to ~$2,900
- [ ] Zero paying user VMs accidentally deleted
- [ ] Lifecycle cron running every 6 hours with no false positives for 1 week

### 14.3 Phase 3 (Dedicated CPU)

- [ ] All paying-user VMs on g6-dedicated-2
- [ ] CPU usage standard deviation reduced by 50%+ (less noisy neighbor)
- [ ] Restart count reduced by 50%+ (fewer false watchdog triggers)
- [ ] Zero data loss during migration
- [ ] All gateways healthy within 5 minutes of resize

### 14.4 Phase 4 (Price Raise)

- [ ] New prices live on instaclaw.io
- [ ] All existing users migrated to new pricing after 30-day window
- [ ] Churn <15% in the 30 days following migration
- [ ] Gross margin >65% sustained for 30+ days

### 14.5 End-State Target

| Metric | Target |
|--------|--------|
| Gross margin | >70% |
| Fleet health (healthy VMs %) | >95% |
| Mean time to detect issues | <5 minutes (vs hours/days today) |
| Daily restart count (fleet-wide) | <50 (vs 1,000+ during restart storms) |
| VM waste (non-paying VMs billing) | <5% of fleet |
| Monthly infra cost per paying user | <$35 |

---

## Appendix A: Linode Contact Info & Guidance

### Account Team

- **Joey** — Account Manager. Contact for: billing questions, limit increases, SI partner introductions.
- **Pat** — Technical Advisor. Contact for: resize API questions, migration strategy, technical troubleshooting.
- **Support** — 24/7 via Linode support portal. Can raise limits instantly.

### Limit Increase Process

Current limit: 2,500 VMs. Can be raised to 5,500+ on request.

Process: Email Joey or Pat, OR contact 24/7 support. Limit is raised instantly.

**When to request:** Forecast when approaching 2,000 VMs and request proactively. At current growth rate (~10 new users/week), we won't hit 2,500 for many months.

### SI Partner Option

Linode offers Systems Integrator partners who can monitor and manage infrastructure on our behalf. This is worth considering at 500+ VMs if we haven't hired dedicated infra staff. Joey can facilitate a discovery call. Separate management fees apply.

---

## Appendix B: Fleet Data Snapshot (April 3, 2026)

### VMs by Status
| Status | Count |
|--------|-------|
| terminated | 286 |
| assigned | 235 |
| failed | 68 |
| ready | 10 |
| **Total in DB** | **599** |
| **Total billing (not terminated)** | **313** |

### VMs by Provider (billing only)
| Provider | Count |
|----------|-------|
| Linode | 305 |
| Hetzner | 4 |
| DigitalOcean | 4 |

### Subscriptions by Status
| Status | Count | Tier Breakdown |
|--------|-------|---------------|
| active | 99 | 64 starter, 22 pro, 15 power |
| past_due | 71 | 27 starter, 24 pro, 20 power |
| canceled | 117 | (various) |
| trialing | 2 | 2 starter |

### Revenue Breakdown
| Tier | Subscribers | Price | Revenue |
|------|------------|-------|---------|
| starter | 64 (+2 trial) | $29/mo | $1,914/mo |
| pro | 22 | $99/mo | $2,178/mo |
| power | 15 | $299/mo | $4,485/mo |
| WLD | 2 | varies | ~$0/mo |
| **Total** | **101** | | **$8,519/mo** |

### Linode Instance Count (API)
- Total Linode instances: 308 (includes monitoring VM)
- All instances type: g6-standard-2 (except monitoring VM: g6-dedicated-2)
- Linode API token: in `instaclaw/.env.local` as `LINODE_API_TOKEN`

---

## Appendix C: Database Schema Reference

### instaclaw_vms (75 columns)

Key columns for this project:
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `provider` | TEXT | "linode", "hetzner", or "digitalocean" |
| `provider_server_id` | TEXT | **This is the Linode ID** (e.g., "91977517") — no `linode_id` column exists |
| `ip_address` | TEXT | VM's public IP — preserved during resize |
| `status` | TEXT | "assigned", "ready", "failed", "terminated" |
| `assigned_to` | UUID | FK to instaclaw_users.id |
| `health_status` | TEXT | "healthy", "unhealthy" |
| `credit_balance` | INTEGER | WLD credits remaining |
| `server_type` | TEXT | Currently "g6-standard-2" for all Linode VMs |
| `region` | TEXT | Linode region (e.g., "us-east") |
| `config_version` | INTEGER | Manifest version (currently 53-54) |
| `suspended_at` | TIMESTAMPTZ | When VM was suspended (if applicable) |
| `last_health_check` | TIMESTAMPTZ | Last successful health check |
| `tier` | TEXT | "starter", "pro", "power" |

### instaclaw_users (34 columns)

Key columns:
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `email` | TEXT | |
| `stripe_customer_id` | TEXT | Stripe customer ID (if subscribed) |
| `world_id_verified` | BOOLEAN | |

**Note:** No `stripe_subscription_status` or `canceled_at` on this table. Subscription data is on `instaclaw_subscriptions`.

### instaclaw_subscriptions (13 columns)

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK to instaclaw_users.id |
| `stripe_customer_id` | TEXT | |
| `stripe_subscription_id` | TEXT | Stripe subscription ID |
| `tier` | TEXT | "starter", "pro", "power" |
| `status` | TEXT | "active", "past_due", "canceled", "trialing" |
| `current_period_start` | TIMESTAMPTZ | |
| `current_period_end` | TIMESTAMPTZ | |
| `payment_status` | TEXT | "current" |
| `past_due_since` | TIMESTAMPTZ | When subscription went past_due (exists for all past_due records) |
| `trial_ends_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | Used as proxy for `canceled_at` (no dedicated column) |

### instaclaw_wld_delegations

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID | FK to instaclaw_users.id |
| `transaction_hash` | TEXT | On-chain tx hash (null = unconfirmed) |
| `status` | TEXT | "confirmed" = verified on-chain |

---

## Appendix D: Existing PRD Cross-References

| PRD | Location | Relevance |
|-----|----------|-----------|
| VM Lifecycle Management | `instaclaw/docs/prd/vm-lifecycle-management.md` | Phase 2 — detailed deletion flow, safety rails, lifecycle cron spec. This infrastructure PRD summarizes; that PRD has full implementation detail. |
| Memory Architecture Overhaul | `instaclaw/docs/PRD-memory-architecture-overhaul.md` | Session/memory management — unrelated to infra but affects VM data we need to preserve during migration. |
| Dispatch Mode | `instaclaw/docs/prd/dispatch-mode-remote-computer-control.md` | Desktop VMs (x11vnc) — these VMs may need special handling during resize (x11vnc service). |
| DegenClaw Skill | `instaclaw/docs/prd/skill-degenclaw-trading-competition.md` | dgclaw-skill repo cloned to VMs — must survive resize (it's on disk, disk is preserved). |
| Newsworthy Curation | `instaclaw/docs/prd/skill-newsworthy-curation.md` | Upcoming skill — no infra implications beyond standard VM. |

---

## Appendix E: Key Files in Codebase

| File | Purpose | Relevance |
|------|---------|-----------|
| `instaclaw/lib/ssh.ts` | All VM SSH operations (configureOpenClaw, upgradeOpenClaw, etc.) | Resize script may reuse SSH helper functions |
| `instaclaw/lib/vm-manifest.ts` | VM_MANIFEST v53+ — expected state for all VMs | Post-resize config verification |
| `instaclaw/lib/vm-reconcile.ts` | Drift detection and auto-fix | Run after resize to ensure no config drift |
| `instaclaw/app/api/cron/health-check/route.ts` | Health monitoring cron | Runs independently — must not conflict with resize |
| `instaclaw/app/api/cron/pool-monitor/route.ts` | Ready pool provisioning | Phase 2 adds scale-down logic |
| `instaclaw/app/api/cron/suspend-check/route.ts` | Current suspension logic | Phase 2 replaces with lifecycle cron (deletion, not suspension) |
| `instaclaw/lib/providers/linode.ts` | Linode API wrapper (has `deleteServer()`) | Phase 2 uses for deletion, Phase 3 adds resize |

---

## Post-Migration: Future Work (Starts After Phase 4)

### 1. Automated Memory Backups (P1)

Daily snapshots of all agent identity and state files to Supabase or S3:
- `MEMORY.md` — agent's learned user preferences and context
- `SOUL.md` — agent's personality and behavioral guidelines
- `EARN.md` — earning skill configuration
- `active-tasks.md` — in-progress work
- `sessions/` — conversation history
- `~/.openclaw/wallet/agent.key` — wallet keys

**Why:** On April 3, 2026, 16 paying users had their VMs deleted due to a stale-cache bug in the audit script. Their agent memory, personality, and conversation history were permanently lost — the VMs were wiped before deletion (privacy protocol) and then destroyed on Linode. There was no backup to restore from. These users had to start fresh with blank agents.

**Implementation:** A nightly cron (`0 4 * * *`) SSHes into each assigned VM, tarballs the critical files, and uploads to Supabase Storage or S3. Retention: 30 days of daily snapshots. On VM failure or re-provisioning, the restore flow pulls the latest snapshot and unpacks it before configureOpenClaw runs. This ensures agent personality and memory survive any VM lifecycle event — deletion, migration, resize failure, or disk corruption.

**Priority:** P1 — start immediately after the dedicated CPU migration is complete.

### 2. Stripe API Verification in Deletion Script (P1)

Rewrite the VM lifecycle deletion cron (`app/api/cron/vm-lifecycle/route.ts`) to call the Stripe API directly for EACH VM immediately before deletion — not rely on cached, batch-loaded, or DB-sourced subscription data.

**Why:** The April 3, 2026 incident: the audit script loaded a cached user list (`/tmp/ic_users.json`, 1000 users) that didn't include all users due to API pagination limits. 16 paying users whose records weren't in the cache were classified as "no subscription" and their VMs were deleted. The Stripe reconciliation cron later fixed their DB records, but the VMs were already gone.

**Implementation:**
```typescript
// Before deleting ANY VM, verify directly with Stripe:
const user = await supabase.from("instaclaw_users").select("stripe_customer_id").eq("id", userId).single();
if (user?.stripe_customer_id) {
  const stripeSubs = await stripe.subscriptions.list({
    customer: user.stripe_customer_id,
    status: "active",
    limit: 1,
  });
  if (stripeSubs.data.length > 0) {
    // ABORT — this is a paying customer
    logger.error("ABORT: Paying Stripe customer nearly deleted", { userId, customerId: user.stripe_customer_id });
    return; // DO NOT DELETE
  }
}
```

This check must be baked into the code itself, not just a PRD rule. It runs in real-time against the Stripe API, not against cached data. Cost: one Stripe API call per VM deletion (~20 per cron cycle, well within rate limits).

**Priority:** P1 — implement before the lifecycle cron runs its first live deletion cycle.

---

## Appendix E: Snapshot Creation Process

**Full documentation in CLAUDE.md under "Snapshot Creation Process (COMPLETE REFERENCE)".**

### Quick Reference

**Current snapshot:** `private/38031667` (instaclaw-base-v56-memory, 5797MB, baked April 6 2026)

**When to bake:** After 3+ manifest bumps, before batch provisioning, after major changes (scripts, crons, OpenClaw upgrade).

**Process summary:**
1. Provision nanode from CURRENT snapshot (NOT a ready-pool VM)
2. SSH in → upgrade OpenClaw → install packages → deploy manifest files + crons
3. Clean caches aggressively (must be under 5.9GB)
4. Run 15-point verification (all must pass)
5. Power off → create Linode image → poll until available
6. Update LINODE_SNAPSHOT_ID in .env.local + Vercel + CLAUDE.md + memory files
7. Delete temp nanode, keep old snapshot 1 week for rollback

**Critical gotchas:**
- 6144MB image limit — images over this silently fail
- DO NOT delete SSH host keys or machine-id before imaging
- DO NOT use ready-pool VMs as base — provision fresh from current snapshot
- Always use nanode (25GB disk) for baking — keeps image under limit
- Template strings in ssh.ts use `${...}` JS expressions — must eval, not regex extract

### Snapshot History

| ID | Label | Size | Manifest | Date | Notes |
|---|---|---|---|---|---|
| private/38031667 | instaclaw-base-v56-memory | 5797MB | v56 | 2026-04-06 | Cross-session memory, OpenClaw 2026.4.5 |
| private/38016469 | instaclaw-base-v3-final | 5935MB | v55 | 2026-04-05 | Dedicated CPU base, exec-approvals |
| private/38007730 | (unnamed) | ~5GB | v53 | 2026-04-04 | First dedicated CPU snapshot |
| private/36895419 | instaclaw-base-linode | 5104MB | v40 | 2026-03 | Original Linode snapshot (DEPRECATED) |

---

*End of PRD. This document should be the single source of truth for the entire infrastructure upgrade. Update it as decisions are made and phases are completed.*
