# INC-20260610-imessage-amnesia: iMessage / shared-bot per-message amnesia

## Severity & scope
P0 (Edge-blocking). Affected ALL iMessage + ALL Telegram-shared-bot (`@myinstaclaw_bot`)
relay traffic on the current fleet OpenClaw version (2026.5.22). Native-telegram (own bot)
and web dashboard unaffected. Pre-Edge population small (imessage 2, telegram-shared ~9),
but structural — every channel-first Edge attendee would have been hit.

## Root cause (one-liner)
`forwardInboundToVm` (`lib/channel-routing.ts`) POSTed `/v1/chat/completions` with no `user`
field and no session header; OpenClaw 2026.5.22's `resolveSessionKey` (`dist/http-utils`)
mints `openai:${randomUUID()}` **per request** when `user` is absent → every inbound message
landed in a brand-new context-free session (`agent:main:openai:<uuid>`, labeled `webchat`) =
total per-message amnesia. Empty MEMORY.md was a downstream symptom (throwaway sessions never
run end-of-session memory hooks).

## Why it regressed
The relay relied on **undefined** gateway behavior. Two sequential calls shared a session on
OpenClaw 2026.4.26 (verified vm-1028, 2026-05-27); the 2026.5.22 upgrade changed openai-endpoint
keying under us. Classic OpenClaw Upgrade Playbook / Rule-65-class regression. Red herrings
correctly killed: Sendblue secret rotation (auth verified fine — messages reached the agent),
the image-skill failure (separate muapi lane; per-request UUID sessions can't cross-poison).

## Fix
Commit **a993ce25** (one file, `lib/channel-routing.ts`, +27/−5). Pin a stable per-conversation
session: `body.user = `${channel}:${channelIdentity}`` (→ `agent:main:openai-user:<channel>:<identity>`)
plus header `x-openclaw-message-channel: <channel>` (correct label, not "webchat"). The
misleading "verified on vm-1028" comment corrected in-place to record the regression.

## Proof chain
1. **Code + on-disk:** 10 distinct `openai:<uuid>` keys on vm-1075, zero stable keys; pattern
   reproduced on vm-1104 + vm-1102 (all 2026.5.22).
2. **Nonce harness (vm-1075, live):** planted `ZEBRA-4417` in call 1, recalled in call 2 with
   no body history; created `agent:main:openai-user:imessage:+15550000000`; evidence untouched.
3. **Rapid-fire / double-text:** two concurrent same-session requests both 200, ordered
   (`ALPHA-OK`/`BETA-OK`), B's prompt_tokens included A's persisted turn → gateway serializes;
   no takeover error. "Queues fine."
4. **Prod human test (Cooper's phone, post-deploy):** planted "mango", recalled on follow-up,
   held context across an in-between turn. 3 texts → ONE session
   `agent:main:openai-user:imessage:+15033544840` (user:3/assistant:4), zero new UUIDs.
   First reply correctly noted prior session rotated with no context (forward-looking boundary).

## Blast radius / impact
Customer-visible amnesia on every channel-relay message until deploy. Forward-looking fix;
pre-fix throwaway sessions not retroactively recovered (expected). Edge unblocked.

## Prevention (see handback → standing-rules wrap)
1. Playbook rule: backend gateway calls MUST pin their session explicitly; never rely on
   default/implicit keying (version-dependent).
2. Nonce harness becomes a mandatory regression test at every OpenClaw upgrade, run on the
   canary before fleet rollout.

## Deploy
a993ce25 → main (clean fast-forward) → Vercel prod `instaclaw-2dwezdi4n` (● Ready) → instaclaw.io.
Shipped via isolated worktree off origin/main; delta exactly one file; tsc --noEmit clean.

## Artifacts
- Test session on vm-1075: `agent:main:openai-user:imessage:+15550000000` (harness; harmless).
- Cooper's evidence sessions (10 × `openai:<uuid>`) preserved for the queued auth audit.

## Fleet-wide post-deploy verification (final receipt)
Deploy-live boundary: 4qawo29b6 Ready ~18:48 UTC (epoch ms ≥ 1781117280000 = post-fix).
All 6 resolved channel users (the full blast-radius set with assigned VMs), registry keys only:

| VM      | User     | Channel  | Stable openai-user key | Post-fix throwaway UUIDs | Verdict |
|---------|----------|----------|------------------------|--------------------------|---------|
| vm-1075 | 66afc149 | imessage | Y `openai-user:imessage:+15033544840` (upd 1781118367235) | 0 | **PROVEN** — messaged post-fix (prod human test: mango recalled, 3 texts→1 session) |
| vm-1104 | 161ffa7e | telegram | N (real user); test-harness PROVEN | 0 | ARMED + **telegram-leg proven** via harness |
| vm-1103 | a0ac9624 | telegram | N | 0 | ARMED (fires on next message) |
| vm-1102 | 73110234 | telegram | N | 0 | ARMED (fires on next message) |
| vm-1100 | d6a18a12 | telegram | N | 0 | ARMED (fires on next message) |
| vm-1099 | d3a54cca | telegram | N | 0 | ARMED (fires on next message) |

**Zero post-fix `openai:<uuid>` throwaways on any VM** → the broken (random-session) path is dead
fleet-wide. ARMED = user hasn't texted since deploy; nothing more is verifiable until they do, but
no new amnesia sessions are being minted.

**Telegram-leg harness (vm-1104, test identity `telegram:harness-test-9999`):** planted
`MANGO-TELEGRAM-88` (call 1), recalled it in call 2 with no body history; stable key
`agent:main:openai-user:telegram:harness-test-9999` created; real user sessions untouched. The
relay shares one code path (`forwardInboundToVm`) across both channels, so this proves the second
leg identically to the iMessage prod test.

Both channel legs verified. INC closed.
