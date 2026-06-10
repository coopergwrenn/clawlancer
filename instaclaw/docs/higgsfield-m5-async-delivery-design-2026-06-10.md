# M5 Fix — Async Video Delivery Design (2026-06-10)

**Status: DESIGN — pending Cooper's fork ruling. No build yet.**
Item 1 of `higgsfield-cloud-remaining-work-2026-06-10.md`. Kills the block-poll that
killed the video lane + triggered the 2026-06-10 cascade.

## Reframe (what M5 actually is, evidence-quoted)

The gate is **already async**. `route.ts:293 client.subscribe(endpoint, {input, withPolling:false, webhook})`
returns `request_id` immediately; Higgsfield calls the webhook on completion. **The 480s
block-poll lives ONLY in the skill** (`higgsfield-cloud.py cmd_generate`'s poll loop) — that's
the single thing OpenClaw's bash-tool timeout kills. So M5 is a **skill-shape** problem, not a
gate problem.

And the **server-side delivery path is already built AND proven**: `webhook/route.ts:205-309`
resolves the VM's bot token, sends native Telegram video (50MB→link fallback), handles
failed/nsfw/no-media — gated behind `if (!target.c) return ack()` (line 195). It fires whenever
a `chat_id` (`c`) is signed at submit, which the gate already supports (`route.ts:177,282`).
PRD §1a: this exact path **already delivered native video** (cost-calibration req `d2adde8d`).

So the machinery to kill M5 mostly exists. The real question is **the chat_id / who delivers.**

## The decision: how does the finished video reach the user (agent not in a turn)?

| Fork | Mechanism | Built? | Reliability | Survives VM restart? | chat_id needed? |
|---|---|---|---|---|---|
| **A — webhook delivers** (server-side push) | Higgsfield→webhook→`sendTelegramVideo` | **~95% built + proven** (`webhook:205-309`) | High (server-side) | **YES** (render+webhook+bot-token all off-VM) | **Yes** (signed at submit) |
| **B — agent polls across turns** (PRD sketch) | submit-only → agent re-checks `?action=status` on a later turn (heartbeat / next msg) → native `message`-tool delivery | partial (status action exists) | **Low** (needs VM alive + agent to get a turn + remember; heartbeat-session chat-resolution unclear; the AGENTS.md:189 cron-null hole) | No | No |
| **C — webhook injects an agent turn** (proactive primitive) | webhook → tells the VM's agent "deliver this" → agent delivers natively, conversationally | **not built** (needs instaclaw.io→VM turn-injection; the Ape Capital proactive-messaging gap) | High if it exists | Yes | No |

**Recommendation: Fork A.** It eliminates the block-poll, reuses the proven delivery path, is
**server-side so it survives VM restart / agent death** (Fork B's fatal weakness — if the render
takes 5 min and the VM restarts or the agent never gets a clean turn, Fork B silently drops the
video; Fork A doesn't care about VM state). Fork B is the PRD's sketch but research says it's the
**fragile** option. Fork C is the *ideal* (server-trigger + conversational native delivery + a
reusable proactive primitive) but needs a turn-injection mechanism that doesn't exist yet —
**worth a research spike as a follow-up**, not the v1.

## This REVERSES the H1 "chat_id unnecessary" conclusion — and here's why that's correct
H1 dropped chat_id capture because *the agent delivers natively while it block-polls in-turn.*
But the block-poll **is M5** — the thing we're killing. Once the agent stops waiting in-turn, it's
not present when the render completes, so a server-side deliverer (the webhook) is the reliable
path, and that needs the chat_id. **Killing M5 brings chat_id back.** H1 was right for the model
it described; we're replacing that model.

## Sub-decision (Fork A): the chat_id source
- **A1 — agent passes `--chat-id`.** Every inbound carries it in the conversation metadata
  (`"chat_id":"telegram:5918081163"`, observed in the 87303c11 trace). The agent strips the
  `telegram:` prefix and passes it; the gate signs it; the webhook delivers. **Smallest build**
  (skill arg + SKILL.md line; gate/webhook unchanged). **Risk:** relies on the agent passing it
  (it's "untrusted metadata" — the SKILL.md must explicitly authorize using it as the delivery
  target). If the agent omits it → webhook settle-only → G11 notifies (degraded, not silent).
- **A2 — server-side `telegram_chat_id` lookup.** The gate, on a create with no chat_id, looks up
  `vm.telegram_chat_id`. **Most robust (no agent reliance)** — BUT the column is populated on only
  **18/~150 VMs and is NULL on vm-050** (measured). So A2 needs a **backfill** (capture chat_id
  fleet-wide) to be the primary. **Recommendation: ship A1 now; backfill `telegram_chat_id` and
  add the A2 server-side fallback as the robustness upgrade** (gate prefers a passed chat_id, else
  falls back to the stored one).

## UX across the 1-8 min gap (Fork A)
- **Submit:** skill returns immediately; agent says *"On it — rendering now, usually 2-5 min. I'll
  send it here the moment it's ready."*
- **Mid-render:** normal turns — the user can chat; the agent responds; the render is independent.
- **Arrival:** the webhook pushes the native video to the chat server-side (fixed caption). Trade:
  less "conversational" than the agent saying "here's your cowboy!" (that's Fork C's edge) — the
  reliability win is worth it for v1.

## Failure modes (each defined, not accidental)
| Case | Behavior (Fork A) |
|---|---|
| Render fails / nsfw | webhook **releases** hold (no charge) + sends "didn't render" to chat_id (`webhook:222-234`) |
| Webhook never fires (Higgsfield drops it) | hold TTL (30 min) stops counting against availability; **G11 sweeper** marks failed + notifies user — **G11 is the orphan backstop, must ship WITH M5** |
| VM restarts mid-render | **delivery unaffected** — render at Higgsfield, webhook→instaclaw.io, bot token from DB; zero VM dependency |
| 2nd video while 1 renders | independent `request_id`+hold+webhook each; both deliver |
| chat_id omitted (A1 miss) | webhook settle-only; G11 notifies (degraded, not silent) |

## Hold lifecycle + G11 coupling
Hold placed at submit (`route.ts:215`); **settled** on completion / **released** on fail by the
webhook (`webhook:135-177`), already idempotent. Orphaned holds (no webhook) → TTL for
availability + **G11 sweeper** for user-notify. **M5 makes G11 non-optional** — pull work-list
item 3 (G11) into this build; they're one unit.

## The general primitive (worth more than a video fix)
Fork A is a **"submit → server-delivers-on-completion"** async primitive (webhook + bot token,
no live agent turn). It directly addresses the **Ape Capital proactive-messaging / async-callback
gap** for the video case. Fork C would generalize it further (any async result → conversational
agent delivery) — flag a **research spike** on OpenClaw turn-injection as the higher-value
follow-up.

## Constraints (non-negotiable, from the reconciliation)
- **Source, not on-disk.** Skill changes land in the skill repo + via `ssh.ts`/manifest (Rule 47);
  the integrity cron eats on-disk edits (proven hole).
- **Reachable webhook required.** Fork A's end-to-end (Higgsfield→webhook) **cannot be tested on
  the SSO-walled preview** (N-D: Higgsfield's callback can't carry the bypass token; 0 callbacks
  reached the canary gate). To test the full async loop we need the gate on a **reachable URL** —
  either G2 (merge to main → instaclaw.io) or a **preview with Deployment Protection OFF**.
  **Cooper: which test path?** (The bypass token you're revoking is fine to lose — Fork A doesn't
  use it; it needs a *publicly reachable* webhook, the opposite of the bypass.)

## Build scope once a fork is ruled (for sizing the work-list item)
- **Fork A1:** skill → submit-only + accept/pass `--chat-id`; SKILL.md delivery copy; **G11
  sweeper+alert** (coupled); ship via manifest. Gate/webhook **unchanged** (already built). ~1 day
  + the reachable-webhook test path.
- **+A2 (robustness):** gate server-side `telegram_chat_id` fallback + a fleet backfill of the
  column. ~0.5 day + backfill.
- **Fork B:** build the cross-turn poll/deliver loop (heartbeat hook or equivalent) + chat
  resolution; higher risk, no proven path. Not recommended.
- **Fork C:** research spike on turn-injection first; defer.

## STOP — fork points for Cooper
1. **Delivery fork: A (webhook, recommended) / B (agent-poll) / C (defer, spike later)?**
2. **If A — chat_id source: A1 (agent-passed, ship now) / A1+A2 (add server-side backfill)?**
3. **Test path for the reachable webhook: merge-to-main (G2) now, or a protection-off preview?**
4. **Pull G11 into this build (recommended — it's the orphan backstop the async model needs)?**

I rule-then-build on your call. No code yet.
