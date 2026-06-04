# Ops Notes — follow-ups not blocking the current ship

## 2026-04-28 — Suspended VMs are getting their gateway service restart-looped

**Surfaced by:** vm-729 (45.33.76.93) failing `gw.health_responds` in the v64 pre-bake fleet audit. Re-probe ~1 min later passed. Triage showed the failure was transient — gateway happened to be in its `start-pre` window when the audit hit.

**The shape:** vm-729 is **suspended** (`suspended_at = 2026-04-11`, `assigned_user_id = null`, `last_assigned_to = null`) — it has no user, no agent traffic, no business reason for the gateway to be running at all. Yet `journalctl --user -u openclaw-gateway` shows a clean **~11.5-minute stop/start cycle** going back hours:

```
18:55:03 Started → 18:55:12 ready    (~11min healthy)
19:06:30 Stopping (SIGTERM) → 19:06:31 Started → 19:06:40 ready
19:18:01 Stopping → 19:18:03 Started → 19:18:12 ready
19:29:30 Stopping → ...               ← my SSH probe landed here
```

Pattern is `systemd[675]: Stopping ...` followed by `Starting ...` — **external `systemctl` invocations**, not crash-restarts, not unit-file `Restart=` triggered. Something is calling `systemctl --user stop openclaw-gateway && systemctl --user start openclaw-gateway` on a loop. On a *suspended* VM that should be quiescent.

**Why it's not the heal-suspended fix shipped today (`9f3aff5`):** that commit fixed *heal steps*. The restart loop runs every ~11.5 min, which doesn't match any heal cadence. Likelier candidates:

- A watchdog cron (`vm-watchdog.py`, `silence-watchdog.py`) that kicks the gateway when probes fail and isn't gating on `suspended_at`
- One of the new heal scripts (`_heal-fleet-gaps.ts`, `_audit_remote.sh`) running on a loop somewhere and calling restart
- A reconciler code path that drift-corrects suspended VMs as if they were active
- Some upstream watchdog at the systemd `override.conf` level (this VM has a Drop-In at `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` worth inspecting)

**Why it matters even though vm-729 is suspended:**

1. **Audit false positives** — any audit run during the start-pre window will red-flag the VM and force re-probes. Annoying for ops; could mask real failures if it normalizes "vm-729 is always flaky, ignore it."
2. **Wasted CPU + Linode cost** — the gateway is fully launching (43s CPU per cycle, ~628MB peak RSS per the journal), then being killed. ~125 cycles per day on a $29/mo dedicated VM that has no user.
3. **Class of bug** — if this hits one suspended VM it likely hits others. Probably more visible after running the next fleet audit with timing-aware probes.

**Investigation steps when picked up:**

1. `cat ~/.config/systemd/user/openclaw-gateway.service.d/override.conf` on vm-729 — see if Drop-In is doing anything weird
2. `systemctl --user list-timers` on vm-729 — any timers that match an 11.5min cadence?
3. `crontab -l` on vm-729 — anything restarting the gateway?
4. Grep the codebase for `systemctl.*restart.*openclaw-gateway` and check whether each call gates on `suspended_at IS NULL`
5. Check Vercel cron logs for any heal/reconcile job that ran around the SIGTERM timestamps (every ~11.5 min from 18:55 onwards on 2026-04-28)

**Other suspended VMs to check before fixing:** Once a code path is suspected, run `select id, name, ip_address, suspended_at from instaclaw_vms where suspended_at is not null` and SSH-spot-check 3-5 of them for the same restart pattern. If the symptom is fleet-wide on suspended VMs, that's confirmation.

**Severity:** medium — not a customer impact (suspended VMs have no users), but wastes resources and adds audit noise. Not blocking v64 bake.

**Files of interest:**
- `instaclaw/scripts/_full-configureOpenClaw-audit.ts` — audit script (consider adding retry-on-start-pre logic to its `gw.health_responds` probe so transient windows don't show as red)
- `instaclaw/scripts/_audit_remote.sh` — remote probe script
- `instaclaw/scripts/_heal-fleet-gaps.ts` — recently added; check its `suspended_at` gating
- `lib/ssh.ts` — central place restarts may originate from

---

## 2026-04-28 — Browser Relay extension is fundamentally broken: OpenClaw upstream removed the relay subsystem

**P0 customer-facing.** Multiple users (Worldcoin community thread, support tickets) report "Cannot reach relay — check Gateway URL" when configuring the just-published `InstaClaw Browser Relay` Chrome extension (id `ondclglahfaiajfomkhmpdnocadfkdpo`). Reproduces 100% on Chrome and Brave, on multiple healthy VMs. Misleading — neither URL nor token is wrong; the **server-side relay endpoint does not exist**.

**Root cause.** The extension's `background.js` is a fork of the OpenClaw chrome-extension at version **2026.2.24**. The protocol it implements (`openclaw-extension-relay-v1`, port 18792, `connect.challenge`/`connect`/`forwardCDPCommand`/`forwardCDPEvent`) was **removed** from upstream OpenClaw in a breaking change. From the openclaw npm package's `CHANGELOG.md`:

> **Browser/Chrome MCP: remove the legacy Chrome extension relay path, bundled extension assets, `driver: "extension"`, and `browser.relayBindHost`.** Run `openclaw doctor --fix` to migrate host-local browser config to `existing-session` / `user`. (#47893)

The fleet runs OpenClaw **2026.4.5** (per `manifest v63`), which doesn't ship the relay code. Confirmed via `grep -r 'openclaw-extension-relay-v1' .../node_modules/openclaw` → zero hits. Gateway logs show no relay subsystem starting (heartbeat / health-monitor / browser-control / MCP loopback / acpx — that's the full plugin list).

**Symptom chain:**
1. Caddyfile has `handle /relay/* { reverse_proxy localhost:18792 }` baked into the snapshot (assumed the relay would run there).
2. Nothing listens on 18792 — Caddy returns **502 Bad Gateway** for every `/relay/*` request.
3. Caddy access log: `dial tcp [::1]:18792: connect: connection refused` repeatedly.
4. Extension's options.js fetch to `${gatewayUrl}/relay/extension/status` gets non-2xx → `throw` → catches → renders `"Cannot reach relay — check Gateway URL"`. Misleading copy: it's not the user's URL, the backend is gone.
5. Dashboard's `/api/vm/extension-status` route silently returned `{connected: false}` on 5xx, so the dashboard's "Not Connected" indicator has been meaningless for an unknown duration.

**Triage shipped tonight (this commit):**
- Dashboard `BrowserExtensionSection` now distinguishes `unavailable` (backend 5xx) from `disconnected` (backend OK, no extension yet) and renders a clear "Service Temporarily Unavailable" state with an explanatory amber banner. Install CTAs hidden in unavailable state to avoid wasted installs.
- `/api/vm/extension-status` route now returns `{ available, status, upstreamStatus? }` so the client can render correctly.
- `/browser-relay` docs page has a red maintenance banner near the top.
- Extension itself is **not modified** — any client-side change requires a Chrome Web Store re-submission and review wait.

**What still needs Cooper's call (NOT shipped):**

Three real-fix paths, in order of effort:

1. **Pin OpenClaw to a version that still has the relay** (e.g., last 2026.3.x). Update `vm-manifest.ts`, bake new snapshot, roll fleet. **Cost:** ~1.5 months of upstream fixes lost. Re-bake + roll is multi-hour. Likely needs a dependency-version sweep to make sure other things still work.
2. **Build an InstaClaw-owned `browser-relay-server.js`** following the same pattern as `dispatch-server.js` (which is our owned process for the user-side computer-control feature). Listen on 18792, implement the protocol verbatim from `instaclaw-chrome-extension/background.js`, bridge to Chrome via the gateway's existing CDP control endpoint on `127.0.0.1:18791`. **Cost:** real engineering. Multiple hours minimum to write + test the protocol bridge. But: the protocol is fully visible in our extension code, no reverse-engineering needed, and it gives us upstream-independent control.
3. **Pull the extension from the Chrome Web Store** (Cooper's dev console action) to stop new installs, switch the dashboard CTAs and docs to "coming back soon," and pick (1) or (2) at leisure. Most honest with users; least engineering tonight.

**Pulling the Chrome Web Store listing should probably happen regardless.** Every minute it's live, more users install something that can't work and walk away frustrated.

**Files of interest:**
- `instaclaw-chrome-extension/background.js` — the client side of the protocol; full reference for option (2)
- `instaclaw-chrome-extension/options.js` — where the misleading error string is
- `instaclaw/scripts/dispatch-server.js` (referenced from `lib/ssh.ts`) — pattern to follow for option (2); already deployed fleet-wide on port 8765 for the *other* relay (user computer control)
- `instaclaw/lib/ssh.ts` — `CHROME_CLEANUP` is the relay-port reservation note ("18792-18799 reserved for future one-off services")
- `app/api/vm/extension-status/route.ts` — now exposes upstream availability
- `vm-manifest.ts` — where to pin if we go (1)
- The Caddyfile baked into the snapshot — currently misconfigured (proxies to dead 18792); needs alignment with whichever fix wins

**Verification command** (any healthy VM):
```bash
curl -sI https://<vm-id>.vm.instaclaw.io/relay/extension/status
# Expect: HTTP/2 502 (broken). Once fixed, expect HTTP/2 200 with JSON body.
```

**Severity:** P0 customer-facing. Triage state shipped buys time — real fix needed within days.


## 2026-05-04 — Gateway proxy `x-model-override` routing is unstable + format-translation gap

**Surfaced by:** Component 3 (`scripts/consensus_intent_extract.py`) testing during the matchpool build today. Same prompt, same `x-model-override: claude-haiku-4-5-20251001` header, ran twice ~30 minutes apart on vm-780:

- 17:30 UTC: response `model: "MiniMax-M2.5"` with `thinking` content blocks
- 18:24 UTC: response `model: "claude-sonnet-4-6"` (Sonnet, not Haiku)

Direct probe via curl with the same payload at 18:25 UTC also returned `claude-sonnet-4-6`.

**The shape — two distinct issues:**

### Issue 1: `x-model-override` header not respected

We send `x-model-override: claude-haiku-4-5-20251001`. Gateway returns *something else* — sometimes MiniMax-M2.5, sometimes Sonnet-4-6, never Haiku. The override header appears to be advisory or ignored entirely.

For matchmaking Component 3 (intent extraction), output quality is fine in either case. **For Component 8 (Layer 3 deliberation, ships Wednesday), this is a real blocker.** Layer 3 explicitly needs Sonnet quality — the architecture commitment in the PRD is that Sonnet's nuanced reasoning catches MEMORY.md signals (e.g., "user mentioned frustration with current auditor in passing") that Haiku and MiniMax often miss. Routing roulette breaks the moat.

### Issue 2: Format translation across providers

OpenAI/MiniMax accept `{role: 'system', content: ...}` in the messages array. Anthropic Claude rejects it and requires `system` as a top-level parameter. Component 3's first version sent OpenAI-format and worked when proxy routed to MiniMax; failed when it routed to Sonnet with:

```
"messages: Unexpected role \"system\". The Messages API accepts a top-level
`system` parameter, not \"system\" as an input message role."
```

Workaround applied in Component 3: send Anthropic-format (top-level `system`). This works for Claude routes; works for MiniMax routes because MiniMax accepts the top-level field too apparently. But it's fragile — it depends on every provider being lenient about the format we happen to send.

**Why both matter:**

- **Cost predictability:** MiniMax pricing differs from Anthropic. Users' tier credits drain at different rates depending on which provider gets routed to. We're billing Anthropic credits for what might be MiniMax inference.
- **Quality consistency:** Layer 3 deliberation (the Wednesday ship that's the central matchmaking moat) relies on consistent Sonnet quality. If routing flips to MiniMax mid-conference, deliberation quality degrades silently.
- **Determinism:** Operators can't reason about model behavior when "claude-haiku-4-5-20251001" might respond as Haiku, MiniMax, or Sonnet on any given call.
- **Format gap:** The proxy should normalize/translate request formats per the actual provider it routes to, not pass through whatever shape the client sent.

**Suspected root cause (not verified):** the gateway proxy at `https://instaclaw.io/api/gateway/proxy` likely has a routing logic that picks a provider based on availability, capacity, or cost — but the routing decision isn't honoring the `x-model-override` header, and it isn't translating the request format to the picked provider's expected shape.

**Where to look:**

- `instaclaw/app/api/gateway/proxy/route.ts` — the proxy handler
- Anything that picks a model/provider from a routing table
- `lib/model-fallback*` if it exists
- The `x-model-override` header parsing path

**Remediation (rough estimate, not committed):**

1. **Honor `x-model-override` strictly.** If the header specifies `claude-haiku-4-5-20251001`, route to Anthropic Haiku — period. If Anthropic is unavailable, return an error rather than silently substituting MiniMax. Predictability > availability for this case.
2. **Translate request format per provider.** If routing decides to use Anthropic, lift `role: system` messages into the top-level `system` parameter. If routing to OpenAI/MiniMax, fold a top-level `system` parameter into a `role: system` message. This should be a pre-dispatch normalization in the proxy.
3. **Log the actual model used in the response payload** (already happens via `model:` field) AND **emit telemetry showing the requested-vs-served model mismatch rate.** Build observability for the issue.

**Severity for the matchmaking sprint:**

- Component 3 (intent extraction, Tuesday): ✅ unblocked. Anthropic-format payload works regardless of which provider gets routed to.
- Component 5/6 (platform endpoint + scoring, Tuesday): ✅ unaffected (no LLM calls).
- Component 7 (Layer 2 listwise rerank, Tuesday afternoon): ⚠️ would prefer Sonnet quality but tolerates MiniMax/Sonnet roulette.
- Component 8 (Layer 3 per-candidate deliberation, Wednesday): 🚨 **blocks the central moat** if routing remains unstable. Must fix before Layer 3 ships, OR have a deterministic Sonnet path the deliberation lib can rely on.

**Action item:** assign before Wed 9am.

---

## 2026-06-03 — Frontier policy-controls: deferred test coverage + observability (from §5.1 self-audit)

Shipped: per-VM spend-policy enforcement (gate now honors band + category overrides via `lib/frontier-overrides-db.ts`), the tighten-only category override + dashboard control, migration `20260603220000_frontier_policy_allowed_categories` applied to prod. Self-audit found no bugs; these are the documented follow-ups (PRD §5.1 GAP-3 / GAP-4):

- **GAP-4 (test coverage, Rule 31 spirit) — not blocking, do before the next Frontier feature touches this code.**
  - `lib/frontier-overrides-db.ts:readPolicyOverrides` has no automated test: the snake→camel band parse, the `Array.isArray` category guard, the table-missing (`PGRST205`/`42P01`) and column-absent paths are verified-by-inspection only. Add a fake-`supabase` unit test feeding it various row shapes (no row, null cols, `[]` cats, `["data"]`, garbage strings, table-missing error).
  - `/api/agent-economy/policy` PUT category validation (non-array → 400, unknown-category → 400, `PGRST204` column-missing retry → bands persist + `allowed_categories_persisted:false`) has no route-level test.
  - The authorize-route → gate wiring (route actually feeds the stored override into `evaluateSpend`) is integration-untested. Pure logic is covered (`_test-frontier-categories.ts` 14/14).

- **GAP-3 (observability) — defer until W12 produces real authorize volume.** Nothing records the gate-decision distribution (how often agents hit `just_do_it` vs `ask_first` vs `deny`, and the deny-reason breakdown — `category_not_allowed`, `exceeds_earned_budget`, `would_drain_wallet`, etc.). This is the data needed to TUNE the bands (§5 Q2/Q3) after rollout. Cheapest path: a lightweight `frontier_authz_events` rollup or a counter incremented in the authorize route, surfaced on `/economy` + an admin view. Pointless before there's autonomous-spend traffic (gated behind opt-in + W12), so this is a post-W12 ops item, not a pre-W12 one.

---

## 2026-06-04 — Frontier: `loadVmStanding` duplicates authorize's inline standing pipeline (consolidation)

**RESOLVED 2026-06-04** — authorize now calls `loadVmStanding` for its standing + reserve read; the inline copy is gone (C29). Shipped test-first: `_test-frontier-standing-db.ts` (17 assertions) landed BEFORE the swap. Equivalence was re-verified line-by-line against current main immediately before the swap, which surfaced (and fixed) the one real divergence — the ledger-read error path was fail-CLOSED (500) in the gate but fail-degraded (swallowed → empty ledger → fresh standing) in `loadVmStanding`; the helper now throws `LedgerReadError` so the gate keeps its 500 and `/policy` GET degrades to `autonomyError`. Assurance level: static-equivalence + the new unit test + authz suite 41/0 (NOT suite-catches-the-swap; authorize's full handler is canary-tested by design).

**Surfaced by:** the §5.1 PRD reconciliation (2026-06-04). `lib/frontier-standing-db.ts:loadVmStanding` (PRD §2 C29) feeds read-only dashboard surfaces (the `/policy` GET autonomy snapshot) the SAME credit standing the authorize gate enforces, and deliberately mirrors the gate's standing-input fetch: recent-ledger select (`RECENT_SCAN_LIMIT = 500`, must match the authorize route's), same-human resolution (`isSameHuman`), owner World-ID verification.

**The shape:** the COMPUTATION can't drift — both paths call the same pure functions (`deriveTrackRecord` + `creditStanding` + `reserveAwareSpentTodayUsd`). Only the *fetch* could diverge: `app/api/agent-economy/authorize/route.ts` still carries its own inline copy of the ledger-select / same-human / world-id block rather than calling `loadVmStanding`. A one-sided future edit to either fetch (e.g. changing the ledger select or the scan limit on the gate side without mirroring it in the helper) would make the dashboard number silently disagree with what the gate enforces. The helper's own docblock flags this and recommends refactoring the gate to call it.

**Fix when picked up:** refactor `authorize/route.ts` to call `loadVmStanding` for its standing-input fetch, deleting the inline duplicate — one fetch path, one place to edit. Verify the gate's behavior is unchanged afterward (pure-fn outputs must be identical): `_test-frontier-authz.ts` + `_test-frontier-standing.ts` still pass, and re-run the W11 canary harness (`_canary-frontier-proof.ts`) on the canary for the end-to-end confirm.

**Severity:** low — not customer-facing, no drift today (the duplication is exact). A latent footgun, not an active bug. Do it before the next change touches either the gate's standing fetch or the helper, so they don't get edited out of sync.

**Files of interest:**
- `lib/frontier-standing-db.ts` (`loadVmStanding`) — the canonical helper; its docblock already documents this debt.
- `app/api/agent-economy/authorize/route.ts` — the inline copy to remove.
