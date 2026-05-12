# v94 Ack-UX — Forensic Findings + Hand-Off for Edge City Terminal

**Author:** Bug-squash terminal (handing off to Edge City terminal — you own the PRD)
**Date:** 2026-05-12 (post-midnight UTC; observations span 2026-05-11 evening)
**Status:** Hand-off — incorporate findings into PRD §X (recommended placement at the end of §4 *"What's wired vs. what we ship"*) and into CLAUDE.md as a new rule.
**Trigger:** Cooper sent test messages to @timmytimmytimbot after your v94 canary applied 9 config keys to vm-050. **No 👀 reaction fired.** Cooper asked for a root-cause forensic — not a guess.
**Outcome:** Reactions verified working after a full gateway restart. Bug class identified. Four guardrails proposed. **vm-882 canary contamination flagged.**

---

## §1 — TL;DR

1. **Reactions weren't broken — they were never enabled.** `messages.ackReactionScope` has never been written to any committed instaclaw config (verified via `git log --all -S` across every branch in the repo). OpenClaw's default value `"group-mentions"` has been in effect on every fleet VM since first provisioning. Cooper tests in DMs (1:1 chats); the default scope doesn't react in DMs. Therefore reactions have never fired in his test path. This is a never-enabled feature, not a regression.
2. **`messages.*` config keys are NOT hot-reloadable in OpenClaw 2026.4.26** — the journal shows `[reload] config change detected; evaluating reload (messages.ackReactionScope, ...)` but **no subsequent `[reload] config hot reload applied (messages.ackReactionScope)` line**. The dist source captures `cfg.messages?.ackReactionScope` into a closure-local at channel-init time (`bot-msflwCEW.js:5473`). The value never refreshes until the gateway is restarted.
3. **A full gateway restart on vm-050 made reactions work** (confirmed by Cooper). The on-disk config was already correct from your canary — only the in-memory copy was stale.
4. **vm-882 was also touched by your canary** (timestamp 2026-05-11 23:51 UTC) — that's a paying customer's VM (singhhitesh809@gmail.com, starter tier). Phase 1 canary should be vm-050-only per your PRD §5 discipline. Worth investigating whether this was intentional or an accidental second-VM run.
5. **The v94 manifest entries are NOT committed** to `lib/vm-manifest.ts`. Your canary script defines the 9 keys as a local constant. Until the manifest is updated, the next reconcile cycle will **revert any v94 keys on vm-050 and vm-882** because the reconciler enforces manifest-as-truth.

---

## §2 — Forensic answer to "what broke reactions"

Cooper asked five specific questions. Direct answers with evidence:

### Q1: Was `messages.ackReactionScope` ever set in any commit?
**No.** Across all branches in the repo:
```
git log --all -S 'messages.ackReactionScope'   → 0 results
git log --all -S 'ackReactionScope'            → 0 results
git log --all -S 'statusReactions'             → 0 results
git log --all --grep "v94"                     → 0 results
```
The strings exist in the working tree in exactly one place: `instaclaw/scripts/_canary-v94-ack-ux.ts` — your uncommitted canary script. **`lib/vm-manifest.ts` has never contained any `messages.ackReaction*` or `messages.statusReactions*` entry in `configSettings`.** Likewise `lib/ssh.ts`'s `configureOpenClaw()` does not set these keys.

### Q2: Did the OpenClaw default change between versions?
**Likely no, and it doesn't matter for our case.** OpenClaw versions on the fleet:
- `2026.4.5` — pre-v67-incident pinned version (CLAUDE.md §"OpenClaw Upgrade Playbook")
- `2026.4.26` — current pinned version (since 2026-04-29)

The dist source on vm-050 (2026.4.26):
```javascript
// bot-msflwCEW.js:5473
const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
```
Default `"group-mentions"`. Your canary script at line 78 (your own forensic snapshot of the pre-state, recorded before applying):
> *"ackReactionScope was 'group-mentions' (OpenClaw default — never explicitly set fleet-wide)."*

Whether 2026.4.5 had the same default is moot — **our config has never set the key, so we always inherit whatever the active default is**, and the active default doesn't react in DMs.

### Q3: Untouched fleet VMs — current state
Probed 6 VMs at cv 82-88 that weren't touched by today's canary work:

| VM | cv | `messages.ackReactionScope` | Notes |
|---|---|---|---|
| vm-469 | 84 | **None** (empty `messages` object) | Pristine — never touched |
| vm-511 | 85 | **None** | Pristine |
| vm-602 | 84 | **`"group-mentions"`** explicitly written | Touched by something at some point with the *default value* — no behavior change |
| vm-867 | 88 | **None** | Pristine |
| vm-882 | 82 | **`"all"`, ackReaction=`"👀"`, statusReactions enabled** | **Your canary touched this (2026-05-11 23:51 UTC)** |
| vm-887 | 82 | **None** | Pristine |

4 of 6 have an entirely empty `messages` object. The OpenClaw default applies — and that default doesn't fire in DMs.

### Q4: Did the snapshot bake include `messages.*` keys?
**No.** Snapshot `private/38575292` (v79, baked 2026-05-03) is produced by reconciling a fresh VM to manifest v79's `configSettings`. Since vm-manifest.ts at v79 (and every version through v93) contains no `messages.*` entries, the baked openclaw.json has none either. **New VMs provisioned from any snapshot we've ever baked inherit the OpenClaw default — reactions disabled in DMs.**

### Q5: CLAUDE.md historical mentions
```
grep -niE "ackReaction|statusReactions|setMessageReaction|reaction emoji|messages\.ackReaction" CLAUDE.md
→ (empty)
```
**Zero historical references.** No rule, no incident, no playbook section, no note. This area of OpenClaw has never been in institutional memory.

---

## §3 — Why "evaluating reload" without "applied" is the load-bearing signal

When you (or anyone) sets a `channels.telegram.*` key, the journal emits:
```
[reload] config change detected; evaluating reload (channels.telegram.streaming.mode, meta.lastTouchedAt)
[gateway/channels] restarting telegram channel
[reload] config hot reload applied (channels.telegram.streaming.mode)
```
Three lines: detected → channel restart → **applied**. The third line is what proves the change took effect.

When you set a `messages.*` key (verified across all 4 keys you wrote: `ackReactionScope`, `ackReaction`, `statusReactions.enabled`, `removeAckAfterReply`), the journal emits:
```
[reload] config change detected; evaluating reload (messages.ackReactionScope, meta.lastTouchedAt)
```
**That is the only line.** No channel restart. No `[reload] config hot reload applied (messages.ackReactionScope)`. The reload subsystem **evaluated** the change and concluded **no hot-reload hook is registered for this namespace** — silently. Disk state changes, runtime state doesn't.

**Action recommendation**: never trust a config set without seeing the matching `[reload] config hot reload applied (KEY)` line. The current `evaluating reload` line is misleading.

---

## §4 — Four guardrails (priority-ordered for adoption)

### Guardrail 1 (P0): Manifest discipline — every fleet-behavior config must be in `vm-manifest.ts.configSettings`

Your canary script is correct for the canary phase. But after canary success, **the keys must be committed to `lib/vm-manifest.ts`** in a new manifest version (v94) so the reconciler enforces them fleet-wide. Without this:
- vm-050 and vm-882 have the keys today
- The other ~200 VMs still don't
- A reconcile cycle (which runs every 5 min via `/api/cron/reconcile-fleet`) ENFORCES the manifest — **it will reset vm-050 and vm-882 back to defaults** because the manifest doesn't know about v94 keys
- Therefore your canary work is currently fragile + will silently regress

**Concrete action**: PR that bumps `VM_MANIFEST.version` to 94 and adds the 9 keys to `configSettings`. Reconciler propagates fleet-wide. Add a changelog entry per CLAUDE.md §"Manifest Version Changelog".

### Guardrail 2 (P0): Hot-reload classification in the reconciler

Add to `lib/vm-reconcile.ts`'s `stepConfigSettings` a classification table for OpenClaw 2026.4.26 hot-reload behavior:

```typescript
const HOT_RELOAD_NAMESPACES = new Set([
  "channels.",      // verified hot-reloadable (channel-restart hook)
  "mcp.servers.",   // verified hot-reloadable (confirmed today on gbrain key)
]);
const RESTART_REQUIRED_NAMESPACES = new Set([
  "messages.",                    // closure-captured at channel init — NOT hot-reloadable
  "agents.defaults.",             // closure-captured at agent init — likely NOT hot-reloadable (untested)
  "gateway.",                     // most gateway.* keys need restart
  "channels.telegram.streaming.", // EXCEPTION INSIDE channels.* — these ARE hot-reloadable per today's test
]);
```

When applying a key from a restart-required namespace, after the verify-after-set passes, **trigger a gateway restart with Rule 5 verify**. Without this, fleet-wide rollout via reconciler will silently fail the same way today's hot-reload did.

### Guardrail 3 (P1): Real-behavior post-apply verification in the canary

Your canary verifies "config-on-disk matches expected." It does NOT verify "the user-visible behavior actually changed." Add a behavior probe to the post-apply phase:

**For reactions (Layer 1)**: after applying messages.* keys + restart, **make a synthetic inbound Telegram message** (via the Bot API with a known throwaway chat_id, OR scrape the journal for the next real-user inbound), wait 5 seconds, then **grep journal for `setMessageReaction operation:` or `reaction` API calls**. If none → fail the canary.

**For streaming (Layer 2)**: send a synthetic chat completion through the proxy that's known to produce >100 tokens of output, then count `editMessageText` outbound calls in the journal during the 30s window. Should be >2.

Closing the loop on "the thing the user sees actually changed" is what would have caught today's bug instantly.

### Guardrail 4 (P2): New CLAUDE.md rule documenting this class of bug

Recommend a new rule (call it Rule 32 or whatever the next number is):

> **Rule X — `openclaw config set` success ≠ runtime applied. Verify hot-reload landed.**
>
> Not every config namespace in OpenClaw 2026.4.26 supports hot-reload. The runtime emits two log shapes:
> - `[reload] config change detected; evaluating reload (KEY, ...)` — the change was SEEN
> - `[reload] config hot reload applied (KEY, ...)` — the change took EFFECT
>
> **Only the second line proves the change is live.** If the second line is absent for your config key, the live process is still using the captured-at-init value. Verified hot-reload namespaces: `channels.*` (channel-restart hook), `mcp.servers.*` (subprocess respawn). Verified NOT hot-reloadable: `messages.*` (closure-captured at channel init).
>
> **When you set a key in a non-hot-reload namespace, you MUST restart the gateway** (`systemctl --user restart openclaw-gateway`) with Rule 5 verify. The reconciler should do this automatically — see Guardrail 2.
>
> Companion lesson: `openclaw config set` returns exit 0 even when the runtime doesn't pick up the change. Disk state and runtime state are independent. Real-behavior tests (e.g., send a Telegram message and observe the reaction) are the only end-to-end verification.

---

## §5 — vm-882 canary contamination (recommend investigating)

Your PRD §5 said Phase 1 canary = vm-050 only. The probe today found vm-882 has the full v94 config on disk:

```
vm-882  cv=82  198.74.59.131
  messages.ackReactionScope = 'all'
  messages.ackReaction      = '👀'
  messages.statusReactions  = {'enabled': True}
  config last modified:     2026-05-11T23:51:26 UTC
```

vm-882 is `singhhitesh809@gmail.com`, starter tier paying customer. Three possibilities:
1. **You ran the canary on vm-882 intentionally** (perhaps as second canary VM before fleet rollout). If so, document.
2. **The canary script accepts a `--vm` flag and someone ran it with `--vm instaclaw-vm-882`** by accident.
3. **Some other automation touched this VM** with the same keys. Less likely — the timing (23:51) lines up with your canary work window.

vm-882 reactions also don't fire (same closure-capture bug — no restart). Same fix as vm-050: `systemctl --user restart openclaw-gateway` to activate. But more importantly: figure out how it got into the canary set and either (a) confirm by running on a few more VMs intentionally with a documented Phase 2 plan, or (b) tighten the canary's `--vm` requirement so accidental targeting isn't possible.

---

## §6 — Recommended next moves (Edge City terminal owns)

1. **Restart vm-882's gateway** to activate the messages.* keys (matches what we did for vm-050). One-liner SSH or use your canary's `--restart` mode against vm-882.
2. **PR to commit `lib/vm-manifest.ts` v94** with the 9 keys in `configSettings`. Include changelog entry per CLAUDE.md.
3. **Implement Guardrail 2** in `lib/vm-reconcile.ts`'s `stepConfigSettings` so the reconciler restarts gateways automatically when applying `messages.*` keys. Otherwise the fleet rollout via reconciler will silently fail on every other VM.
4. **Implement Guardrail 3** (real-behavior post-apply verification) into the canary script, BEFORE running on any new VM.
5. **Add Guardrail 4 to CLAUDE.md** so this finding lands in institutional memory.
6. **Soak window**: per your PRD §0 risk paragraph, you wanted ≥24h on vm-050. The proxy fix earlier today + the gbrain Path A apply also touched vm-050 — make sure your soak window starts AFTER the restart at 2026-05-12 00:25 UTC, not from when the canary first ran.
7. **L3 (ack-watchdog.py)** is still the only piece without OpenClaw runtime support per your PRD §4.4 — that's the next build phase.

---

## §7 — Evidence trail (for your audit + future incidents)

Scripts I built today during the investigation, all in working tree (uncommitted, can stay as-is or you can commit them under your terminal's namespace):

- `instaclaw/scripts/_vm050-reaction-diag.ts` — first-level probe (config values + journal grep)
- `instaclaw/scripts/_vm050-reaction-dist-now.ts` — dist-source dive (proved `bot-msflwCEW.js:5473` closure capture)
- `instaclaw/scripts/_probe-untouched-vms-reactions.ts` — 6-VM sample showing the fleet-wide unset state
- `instaclaw/scripts/_vm050-restart-now.ts` — Rule-5-verified restart that activated reactions (vm-050 health=200 at t=85s)

All read-only except the restart. Run any of them to reproduce the forensics.

Journal commands for ongoing forensics:
```
# Did messages.* hot-reload apply on a given VM?
journalctl --user -u openclaw-gateway --since "2026-05-11 23:40:00" \
  | grep -E '\[reload\] config hot reload applied.*messages\.'
# Expected: empty. Confirms the namespace doesn't hot-reload.

# Did setMessageReaction ever fire?
journalctl --user -u openclaw-gateway \
  | grep -iE 'setMessageReaction|operation.*reaction'
# Expected on pre-fix VM: empty. After restart on vm-050: at least one hit per inbound DM.
```

---

End of hand-off. Ping the bug-squash terminal if you need additional forensics or want me to ship any of the guardrails myself — but the PRD + the v94 manifest commit + the canary's verification gap are yours.
