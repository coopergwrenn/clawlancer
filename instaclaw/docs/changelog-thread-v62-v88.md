# Changelog thread — @instaclaws v62 → v88

For posting on X. 18 tweets. Lead + by-the-numbers + 15 topic tweets + closer.

Posting notes:
- 🦀 is our brand emoji (we are a crab, not a lobster).
- Each topic tweet leads with a single emoji + bold header, mirroring OpenClaw's release-thread style.
- A few tweets run longer than 280 chars; split at the natural blank line if not on Premium.
- Specific customer VM IDs intentionally redacted ("some VMs", "a slice of the fleet").
- Privacy-bridge QA fix details intentionally omitted — the shipping is the story; the fixes belong in an internal post-mortem.

---

## 1/ Lead

@instaclaws v62 → v88 🦀  —  149 paying-customer VMs, six weeks, no downtime.

🤝 1.77s end-to-end agent-to-agent intros (Consensus 2026)
🧠 Cross-restart memory + 1000× cheaper system-prompt edits
🔌 Open-sourced an 8-year-old libuv zombie that tini doesn't catch
🛡️ Privacy mode where even our team can't read your sessions
🩹 Removed the watchdog that was killing healthy gateways

The release where the fleet stopped fighting itself.

---

## 2/ By the numbers

6 weeks. 27 manifest versions. 9 new cron jobs. 14 new mandatory rules — each tracing to a real incident we won't repeat. 4 partner integrations live. 2 base-image rebakes (44 reconciler fixes during the v79 bake alone). 1 npm package open-sourced.

All shipped to a live fleet of 149 VMs with paying customers using their agents the whole time.

---

## 3/ 🤝 Consensus 2026 matching

L1 extracts intents (Haiku) → L2 dual-embedding retrieval → L3 listwise rerank (Sonnet) + per-candidate deliberation → agent-to-agent XMTP intro DM. First real production intro fired in 1.77s end-to-end. Live for the conference May 5–7.

---

## 4/ 📨 Agent-to-agent DMs that actually work

Receiver chat_id from DB. XMTP-user fallback + pending-disk recovery. Per-receiver intro cap (3/24h). Self-healing telegram_handle backfill via getChat. Kill-switch + 30-min health alert cron. Edge-case suite: 12/12 passing.

---

## 5/ ⚙️ Skill toggle gating

v83 gates the whole pipeline on the consensus-2026 skill state. Non-attendees pay zero Haiku/Sonnet cost. v84 added Organic Activation — mention "Consensus 2026" in chat with skill OFF and your agent offers to enable matching.

---

## 6/ 🩹 Watchdog removed

Some VMs were taking 20+ SIGTERMs in 24h. Others were dying 17ms after `[gateway] ready`. Root cause: watchdog was reading a daily log that survived restarts, judging fresh gateways "frozen" forever. v69 disabled it fleet-wide. systemd Restart=on-failure handles real crashes. The right fix was "remove the thing."

---

## 7/ 🧠 Memory that doesn't forget

ExecStopPost snapshots MEMORY.md before every shutdown. ExecStartPre restores ONLY if current is <50B (template-empty). Never overwrites populated files. Your agent's long-term memory survives any restart, crash, or upgrade.

---

## 8/ ⚡ 1000x cheaper learning

Added `<!-- OPENCLAW_CACHE_BOUNDARY -->` to SOUL.md. The system prompt splits — stable prefix gets Anthropic-cached, dynamic suffix re-prefills on edits. A Learned Preferences edit went from ~14,000 input tokens to ~10 cache_write tokens.

---

## 9/ 📊 Periodic summary unblocked

Caught the summary hook silently blocked on a slice of the fleet — `last_periodic_msg_count` was a pre-shrink count, `new_msgs` went negative after compaction, gate fired forever. Negative-handler re-baselines without advancing the throttle.

---

## 10/ 🛡️ Maximum Privacy Mode

For Edge City attendees. SSH bridge enforces a command allowlist + sensitive-path denylist when `privacy_mode_until > NOW()`. 24h auto-revert. Toggle at /dashboard/privacy. Even our team can't read your conversations or memory while it's on.

---

## 11/ 🔌 Open-sourced prctl-subreaper@0.1.1

npm package that fixes an 8-year-old libuv bug (#1911). Node calls `uv_close` BEFORE `waitpid`; child's exit notification gets dropped → zombie that tini-as-PID-1 cannot reap (the parent already missed the SIGCHLD).

Fix: gateway Node process becomes `PR_SET_CHILD_SUBREAPER`. Polling /proc walker on a background thread reaps any orphaned descendant in the same process tree. N-API addon, MIT, Bun-compatible.

v0.1.1 dropped a `npm install || exit 0` mask from v0.1.0 that was hiding native-build failures. We caught it because gcc was absent on a slice of the fleet — so the install "succeeded" and the addon silently never loaded.

github.com/coopergwrenn/prctl-subreaper. @garrytan is testing it.

---

## 12/ 📈 More headroom for parallel work

TasksMax 75 → 120 on the openclaw-gateway cgroup. Audited fork-error spikes on busy VMs and found the cliff was per-cgroup TasksMax, not zombie pile-up. Chrome ~50 + Node ~11 + agent burst → 61–80 typical. Headroom restored without going back to pre-incident risk.

---

## 13/ 🌐 Browser that actually works

Chrome extension still speaks OpenClaw's 2026.2.24 protocol, so we run a local relay on `127.0.0.1:18792` that emulates CDP and translates. Before v65, port 18792 was unbound — every install hit "cannot reach relay." Your agent can drive real websites again.

---

## 14/ 🪙 Bankr launches stay on Base

The agent's training prior was framing every "launch a token" as Solana. Skill-level directives didn't fix it (agents lazy-load skills). v67 moved the framing into upfront context — SOUL.md routing table + CAPABILITIES.md wallet table. Turn-1 routing now Base-only. Solana commands still go to Solana.

---

## 15/ 🧹 Cleaner agent responses

`streaming.mode=off` — OpenClaw's default surfaces tool-call internals in chat; we ship "off" everywhere. `discovery.mdns.mode=off` — Bonjour broadcast was triggering a CIAO probe-cancel race on SIGTERM. Split systemd overrides into [Unit] vs [Service] — kill-loop protection was non-functional until v75.

---

## 16/ 📉 Database load reduction

health-check Pass 0 timestamp UPDATEs: 855 queries → 2 (batched). health-check 1m → 2m, cloud-init-poll 2m → 5m. In-memory cache for daily_usage SELECT (30s TTL). reconcile-fleet batch 10 → 3 to fit under 300s.

---

## 17/ 📜 Discipline codified

14 new rules in CLAUDE.md, each tracing to a real incident. R11: every LLM route sets `maxDuration = 300` (Vercel default 60). R22: trim, don't nuke. R24: skill install verify + self-healing. The fleet is more boring to operate every week.

---

## 18/ Closer

Next: v2 of the matching engine.

Agents that don't just introduce. They negotiate the meeting for you. Autonomous back-and-forth over XMTP. PRD this week.

You say "I want to meet a founder building X." Your agent finds them, DMs theirs, works out a time. Calendar invite lands in your inbox.

149 VMs. 6 weeks. Onward.
