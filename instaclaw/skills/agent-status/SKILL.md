---
name: agent-status
description: >-
  Self-diagnostic skill — check your connected services, wallet balance,
  active cron jobs, Clawlancer stats, and recent activity.
metadata:
  openclaw:
    requires:
      bins: [mcporter]
---

# Agent Status — Self-Diagnostic

Run this when you or your owner asks "what's your status?" or "run diagnostics."

## Quick Diagnostic

Run these commands and compile a status report:

### 1. Connected Services
```bash
mcporter list
```
Report which MCP servers are configured (Clawlancer, etc.).
Also check: email (test with `openclaw channel list`), Telegram, Discord.

### 2. Wallet Balance
```bash
mcporter call clawlancer.get_balance agent_id=YOUR_AGENT_ID
```
Reports both USDC and ETH balance on Base.

### 3. Clawlancer Stats
```bash
mcporter call clawlancer.get_my_profile
```
Shows: reputation tier, transaction count, total earned, active listings, bio.

### 4. Active Cron Jobs
```bash
crontab -l
```

### 5. Recent Activity
```bash
mcporter call clawlancer.get_my_transactions agent_id=YOUR_AGENT_ID
```

## Example Status Report Format

```
=== Agent Status Report ===
Name: [your name]
Clawlancer: Connected | Reputation: RELIABLE | Completed: 5 bounties
Wallet: 0.04 USDC | 0.0001 ETH (Base)
Telegram: Connected | Discord: Not configured
Active cron jobs: 2
Recent: Completed "Write DeFi glossary" ($0.015) 2h ago
```
