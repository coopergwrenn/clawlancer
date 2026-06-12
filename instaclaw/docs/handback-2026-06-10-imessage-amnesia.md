# Handback — IR2 iMessage amnesia (2026-06-10)

For tonight's standing-rules wrap. INC-20260610-imessage-amnesia is CLOSED (fix a993ce25 live
in prod, full proof chain in `docs/incidents/2026-06-10-imessage-session-amnesia-INC-20260610.md`).

## Two class-level items to canonize as CLAUDE.md rules

### Item A — Backend gateway calls MUST pin their session explicitly; never rely on default keying
Any backend code that POSTs to a VM gateway's `/v1/chat/completions` (or `/v1/responses`) and
expects multi-turn memory MUST send an explicit, stable session identity — either `body.user`
(→ `agent:main:openai-user:<user>`) or header `x-openclaw-session-key` (verbatim). Default/implicit
session keying is **undefined gateway behavior** and is version-dependent: OpenClaw 2026.4.26
defaulted to a shared session; 2026.5.22 changed it to mint `openai:${randomUUID()}` per request,
silently converting every iMessage / shared-bot conversation into per-message amnesia. The web
dashboard (`chat/send`) is exempt by a different-but-valid design (it replays full history in the
body, so gateway session is irrelevant) — but any relay that sends only the new message MUST pin.
**Banned:** a stateful relay (sends one message, relies on gateway to restore history) with no
`user`/`x-openclaw-session-key`. **Detection:** grep backend for `/v1/chat/completions` fetches;
each must carry `user:` or `x-openclaw-session-key`, or replay full history like `chat/send`.
This is an OpenClaw Upgrade Playbook / Rule-65-adjacent rule.

### Item B — Nonce harness is a mandatory regression test at every OpenClaw upgrade (canary, pre-fleet)
Add to the OpenClaw Upgrade Playbook canary gate: before any fleet rollout of a new OpenClaw
version, run the two-call nonce harness against the canary VM's gateway via the relay's exact
request shape (model "openclaw", `user:"imessage:+test"`, header `x-openclaw-message-channel`,
NO body history):
  1. Call 1 plants a nonce; Call 2 (separate request, no history) must recall it.
  2. Confirm the session lands in `agent:main:openai-user:<user>` (stable), not `openai:<uuid>`.
  3. Rapid-fire: two concurrent same-session requests must both 200 and serialize cleanly
     (no `EmbeddedAttemptSessionTakeoverError`, no interleave).
If any step fails, HALT the upgrade — session-keying or concurrency semantics changed upstream.
This single test would have caught the 2026.5.22 regression on the canary instead of in prod.
(Harness commands are in the INC note's proof chain.)

## Carried forward — flagged, no chase (as-is)
`instaclaw_vms.last_user_activity_at` is **fleet-wide stale** — top values across the entire fleet
are early-May 2026; effectively a dead column (writers appear to have stopped). Noticed during
blast-radius triage. Not investigated per instruction. Worth a separate look because several
lifecycle/freeze paths key on it (CLAUDE.md Rule 50 freeze gating reads `last_user_activity_at`
fail-closed; if it's universally stale, freeze gating may be behaving off stale data). Logged
only; no action taken.

## Status
- Fix: a993ce25 (one file, `lib/channel-routing.ts`) — live in prod (instaclaw.io / 2dwezdi4n).
- Worktree retained at `/tmp/ic-imsg-fix` (branch `fix/imessage-session-key`).
- vm-1075 evidence sessions preserved for the queued auth audit (onboarding terminal).
- Parked.
