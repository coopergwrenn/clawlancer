# Higgsfield-Cloud Canary — Verdict (vm-050, 2026-06-10)

Single-VM canary of the new `higgsfield-cloud` gate on vm-050 (Cooper's @timmytimmytimbot),
under reconcile-quarantine, with The Director hidden + higgsfield-video narrowed to extend.
Triggered by a real "make me a video" from Cooper at 06:53 EDT (10:53 UTC). Torn down +
un-quarantined same session. **The fleet rollout decision is Cooper's, informed by this doc.**

---

## PROVEN (green, evidence-backed)

- **Routing to `higgsfield-cloud` is clean.** The agent ran `higgsfield-cloud.py generate
  --kind image` then `--kind video --image-url` (the correct text→image→video flow). **Zero**
  references to `higgsfield-video`/Muapi (`higgsfield-generate`/`-edit`/`-character`) or
  `sjinn`/Director in the agent's tool calls. *(session 87303c11 trace)*
- **Gate metering holds are correct.** First-ever `instaclaw_video_transactions` rows:
  `soul/standard` (image, hf_cost 1) + `dop/lite` (video, hf_cost 2), both `is_free=true`,
  `est_credits=0`, `vm_id` correct, `tier: starter`. Reserve/hold logic works. *(DB)*
- **402 fail-closed is correct.** A 3rd generation (retry) hit `video reserve denied,
  reason=insufficient_balance` (HTTP 402) once the starter free cap (2) was spent by
  image+video. The gate refused over-cap spend exactly as designed. *(gate Vercel logs
  10:56:47)*
- **skill → gate → Higgsfield plumbing is green end-to-end.** The deployed skill, reading
  `GATEWAY_TOKEN` + `INSTACLAW_GATEWAY_BASE` + `HIGGSFIELD_GATE_BYPASS` from `.env`, reached
  the SSO-walled preview gate via the bypass header, passed the secret check, and Higgsfield
  itself responded (404 on a bogus id, using `HIGGSFIELD_CLOUD_KEY`). Reachability proven
  from vm-050's perspective. *(skill self-test + gate logs)*
- **The agent degrades gracefully** on free-exhausted: it delivered the image it made and
  explained, rather than erroring. *(screenshots + post-unpin re-probe: "today's free
  generations are already used up… reset at midnight UTC")*

## SURFACED (real issues the canary exposed — none would have been seen without it)

- **M5 — the video block-poll is killed by OpenClaw's bash-tool timeout.** `higgsfield-cloud.py
  generate` block-polls up to 480s; the tool was killed mid-poll (`{"status":"failed",
  "exitCode":0,"aggregated":""}`), leaving a failed/empty tool artifact in the session and the
  DB row stuck `pending`. The PRD predicted "the canary reveals it." It did. **Fix direction:**
  submit-only + agent-poll-across-turns (don't hold a single 480s bash call).
- **Settle-webhook gap on SSO-walled previews.** Settle is webhook-driven; Higgsfield's
  callback can't carry the Vercel bypass token, so it dies at the preview's SSO wall (**0
  webhook callbacks logged**). Holds never settle on the canary (even the delivered image
  stayed `pending`). Largely a **canary-environment artifact** (the isolation wall we needed
  blocks Higgsfield→gate), but it means **settle is unprovable on a dark preview** — needs a
  webhook bypass path or settle-via-status-poll to test.
- **Empty completions BILL (`cost_weight: 38` each).** The 2 failed turns (see below) each
  billed 38 on `claude-fable-5`. Charging for `payloads=0` is a revenue-integrity issue at
  announce scale. **Fix direction:** don't bill incomplete/empty turns; add model-fallback on
  empty (retry tier-2 before surfacing an error — the recovery turn proved sonnet works).
- **Integrity-cron playbook hole.** `skill-integrity-check.sh` (hourly `:17`) + the daily
  skill-update cron **silently reverted the canary on-disk edits at 05:09** (higgsfield-video
  SKILL.md back to canonical, sjinn-video re-created) — **reconcile-quarantine does NOT cover
  these crons.** Canary on-disk skill/workspace edits are **not durable**; the playbook must
  disable those crons for the window, treat edits as ephemeral, or land changes via
  source/manifest.

## The fable-5 incident (separate from the canary's gate, same session)

vm-050 was pinned to `claude-fable-5` (explicit-pick-only, weight 38, pinned via the
dashboard for prod verification of the 01:29 promote). On 2 **tool-heavy** turns in the
video-saga session, fable-5 returned **empty completions** (`stopReason=stop, payloads=0`) →
"Agent couldn't generate a response" ×2, billed 38 each. **Discriminated:** not the promote
(fleet green: 24 VMs/132 calls), not the canary edits (cron-reverted before the failure), not
gbrain (quiet), not Telegram (no timeouts in-window), not a transport error (HTTP 200). fable-5
works on simple turns + worked on the 10:54 video turn → the differentiator is fable-5 ×
heavy/accumulated context, with M5 as the upstream trigger that produced that context.
**Resolved:** Cooper unpinned fable (~07:30); post-unpin verification green (plain + video both
auto-route to sonnet, content, no `payloads=0`). vm-050 recovered (intermittent).

## UNPROVEN (the canary did NOT establish these — gating items for any rollout)

- **A2 — the extend lane.** Never exercised. "extend this video" → old higgsfield-video rail,
  served — not tested.
- **Live native delivery.** The clip was never delivered as native inline video to the chat
  (the run hit free-exhausted + M5 before a completed video). PRD prereq #3 remains open.
- **The fable-empty mechanism (named dead-end).** Whether fable-5 empties from (a) its own
  behavior on that context, (b) the pin-bypass sending a malformed tool-heavy request, or (c)
  a model×context interaction — **not provable**: the content router won't deterministically
  serve fable-5 on controlled probes (routes them to sonnet), and prod proxy-log retention
  didn't reach the window. **Instrumentation to close it:** replay session 87303c11's exact
  messages-as-of-11:02 to the proxy with `x-model-override: claude-fable-5` vs
  `:claude-sonnet-4-6` and compare; or add proxy output-token/response logging for
  pinned-model calls. (Mooted operationally by unpinning fable, but open if fable is re-pinned.)

## Teardown state (reconciled to canonical, un-quarantined)

- skills: `sjinn-video` + `higgsfield-video` only (`.disabled` + `higgsfield-cloud` removed);
  higgsfield-video SKILL.md = canonical. All `.bak-canary` removed. Canary env vars
  (`INSTACLAW_GATEWAY_BASE`, `HIGGSFIELD_GATE_BYPASS`) removed (backup `/tmp/.env.pre-teardown.bak`).
- DB: `reconcile_quarantined_at = null`, `pinned_model = null`, `health = healthy`, `cv = 128`.
- The `higgsfield-cloud` skill + bypass-header edit remain on the canary branch
  (`worktree-higgsfield-official-rail`, commit 3667484c) for the next attempt.

## Recommendation for a clean re-run (Cooper's call)

Before re-canarying: fix M5 (submit-only polling), solve settle on a dark preview (webhook
bypass or status-poll settle), don't-bill-empty + model-fallback-on-empty, and either disable
the integrity crons for the window or land canary edits via source. Then a single VM can prove
A1 (happy-path delivered+settled), A2, and live delivery with credits/cap headroom.

---

## Closeout audit addendum (devil's-advocate self-audit)

**Probe billing (diagnostic spend on a real VM).** The diagnosis billed vm-050's real daily
`usage_log` **~54-58 cost_weight** via CLI probes — including one **38-weight charge** (the
11:23 UTC fresh probe, which routed to fable-5 *before* the ~11:30 unpin). Rest were sonnet@4 +
tool_continuations. Real (Cooper) turns today billed ~153. **Consider noting/refunding the
~54-58 diagnostic weight** — it's not user-driven usage.

**OPEN SPEND SURFACE — gate still live (ACTION: Cooper, Vercel-side).** The branch-alias preview
gate (`…-git-worktree-higgsfield-dffa85…`) is **live + reachable via the bypass token**
(http=200 post-teardown), holding `HIGGSFIELD_CLOUD_KEY` + `HIGGSFIELD_WEBHOOK_SECRET` → real
Higgsfield spend. Nothing on vm-050 points at it (env removed), but anyone with the bypass token
(exposed in session history + Vercel config) can trigger spend. **Close it:** revoke the
Protection-Bypass-for-Automation token OR remove the preview HF secrets. **Keep for the re-run:**
risk window = as long as bypass + secrets are live. (I can't do Vercel takedowns.)

**Cross-terminal handoff — empty-completion guard (onboarding terminal).** Three findings that
contradict likely design assumptions:
1. **The empty is NOT an API error** — HTTP 200, `stopReason=stop`, `payloads=0`. A guard
   catching only 4xx/5xx/timeouts **misses it.** Hook the incomplete-turn/`payloads=0` signal.
2. **Two layers, two fixes:** detection+surfacing is VM-side (OpenClaw `agent/embedded`
   "incomplete turn detected"); **billing is proxy-side** (`cost_weight` charged regardless). A
   complete guard needs BOTH model-fallback-on-empty (VM) AND don't-bill-empty (proxy).
3. **The empty followed tool calls** — a naive fallback that re-sends the user message
   **re-runs the tools** (double-spend/side-effects: the "some tool actions may have already
   been executed" hazard). Resume from existing tool results, don't replay the turn.

**Unnamed loose end (seam 6): fable-5 is fleet-wide-pinnable with this failure mode.**
`claude-fable-5` empties on tool-heavy turns in heavy context and bills 38/turn. It's an
explicit-pick option in the model browser (tier-gating Fable→Pro+ "still HELD/unbuilt" per the
promote PRD). **Any user who pins fable hits the same empties + 38 billing** — not vm-050-
specific. The model-browser/pin owner should know before fable is broadly pickable.

**Residue disposition (swept + justified).**
- vm-050 `/tmp`: all canary files removed, incl. the full-secrets `.env.pre-teardown.bak`. ✓
- mac `/tmp`: `gate_probe.txt`, `vm050_ip.txt`, `canary050/` removed; **kept `/tmp/ic_ssh_key`**
  (shared fleet key, re-derivable, other terminals may be mid-SSH — removing would disrupt them).
- 5 isolated test sessions on vm-050 (`freshdiag-*`, `verify-*`): **left** — inert, isolated from
  the main session, removal needs sessions.json surgery (Rule 22 risk), they age out.
- vm-050 gateway **not restarted** (avoided cold-start risk) → running process still holds canary
  env vars + maybe `higgsfield-cloud` in its in-memory skill registry. **Inert** (skill file
  removed, `.env` cleaned → can't reach the gate even if invoked). Next restart clears it.
- 2 `video_transactions` holds remain `pending` (free, est 0) — consume vm-050's free-video cap
  until midnight-UTC reset; harmless.
- Session `87303c11` (recovered timmy session) still carries the video-saga context — recovered,
  not nuked (Rule 22); ages out on rotation.

**Knowledge-capture status:** this doc + the gap register/M5/settle notes in
`higgsfield-gate-to-user-path-prd-2026-06-09.md` are the durable record; both live on branch
`worktree-higgsfield-official-rail`. Committed (not left as uncommitted working-tree files).
