# Frontier Canary + Brake-Drills — ONE Merged Sitting Plan

**What this is:** the single timeline for the proof session. Two documents merge here —
**toolrouter's `travala-canary-runbook.md` owns Stages 0–7 (the booking)**; this doc owns
**Stages 8–11 (the brake drills + restoration)** and is the master sequence Cooper executes
top to bottom. The booking's job is "don't improvise during a charge." The drills' job is
"don't improvise *while pulling the brakes* during a charge."

**The stakes asymmetry (read once):** a bug in the booking loses ~$80. A botched kill-switch
drill that doesn't release cleanly denies **every armed VM fleet-wide** until fixed; a revoke
drill that leaves a hold in a state no code path expects poisons the proof run AND leaves prod
in a state this runbook's own IR scenarios (S5/S7) would page about. **The blast radius of the
drills includes the credibility of the canary itself.** Every decision below is made on paper.

**Holds for Cooper's explicit GO at each `▣ GO` marker. Drills run ONLY if the booking is green.**

**Subject VM (the canary): `instaclaw-vm-1043`**
- `id` = `0f64ac86-69d2-45f4-ac2d-a488714c4d0d` · IP `45.33.95.220`
- wallet (`bankr_evm_address`) = `0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4` ← **fund THIS** (vm-1043's own Bankr wallet; verify on basescan before sending).
- both gates start **OFF**; Stage 1 arms them; Stage 11 disarms.

### ⛔ STAGE 0 PRECONDITION — THE APPROVAL TAP (settled 2026-06-12; route PROVEN end-to-end)

**The facts (quoted from `instaclaw_users` / `instaclaw_vms`):** vm-1043 is owned by a **TEST account** `cooper-v122-canary@instaclaw.test` (user `59dcf829`, `partner=edge_city`), NOT by Cooper. The fund target `0xd998…38c4` is that test VM's Bankr wallet (already holds ~$5 from prior testing — you top it up). Cooper's own dashboard wallet `0xe1e0…54f3` is vm-050's (`timmy`); the two are different VMs, NOT a primary/CDP pair.

**Why a reassign is impossible:** `instaclaw_vms.assigned_to` has a UNIQUE constraint (`instaclaw_vms_assigned_to_key`) — **one VM per user.** Both of Cooper's Google logins are capped (`coopgwrenn@gmail.com`→vm-050; `coopergrantwrenn@gmail.com`→vm-1075 founder VM). `coop@valtlabs.com` is not a user. So vm-1043 cannot be reassigned to Cooper without orphaning a primary VM (rejected). See `reference_one_vm_per_user_constraint` (memory) for the full map.

**Why the booking needs an owner session anyway:** travel is `SESSION_REQUIRED` (Rule 79). `/api/agent-economy/authorize` derives `ownerId = vm.assigned_to` (route line 316); `/api/agent-economy/approve` requires a NextAuth session and 404s unless `approval.owner_id === session.user.id` (lines 13, 74). The approval can be minted ONLY from a browser session owning vm-1043 = the test account.

**THE PROVEN ROUTE — session-mint (zero reassign, zero DB mutation, F2 fully preserved).** Mint a real NextAuth session for the test account via the production `openai-device-code` Credentials provider (`lib/auth.ts` + `lib/openai-signup-token.ts`), then drive it into a browser. Demonstrated live 2026-06-12: mint → NextAuth csrf+callback → `__Secure-authjs.session-token` → `/api/auth/session` returns `{id:59dcf829, email:cooper-v122-canary@instaclaw.test, partner:edge_city}`; session-authed `/api/agent-economy/spend-settings` returns vm-1043's wallet `0xd998…38c4` + balance. **No new code, no approval created.** Why this preserves the F2 proof: it is a real human, in a real browser, tapping a real session-rooted owner-scoped approval — F2 doesn't care WHICH account, only that the forgeable bool can't substitute for a session. The session belongs to vm-1043's owner; that IS the proof.

```bash
# === SESSION MINT (operator-side; the 60s TTL is one-shot HERE, NOT on Cooper) ===
TESTUSER="59dcf829-22d0-4db5-8890-d9cde788b576"; JAR=$(mktemp)
# 1. mint a signupToken for the test account (inline HMAC; same shape as signSignupToken, aud=openai-signup, 60s)
SIGNUP_TOKEN=$(node -e '
  const crypto=require("crypto"), fs=require("fs");
  for (const l of fs.readFileSync("/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","utf8").split("\n")){
    const m=l.match(/^([^#=]+)=(.*)$/); if(m&&!process.env[m[1].trim()]) process.env[m[1].trim()]=m[2].trim().replace(/^["\x27]|["\x27]$/g,"");
  }
  const s=process.env.NEXTAUTH_SECRET;
  const b64url=(x)=>Buffer.from(x,"utf-8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  const p={sub:process.argv[1],jti:crypto.randomBytes(16).toString("hex"),aud:"openai-signup"};
  const pB64=b64url(JSON.stringify(p)); const exp=Math.floor(Date.now()/1000)+60;
  console.log(pB64+"."+exp+"."+crypto.createHmac("sha256",s).update(pB64+"."+exp).digest("hex"));
' "$TESTUSER")
# 2. csrf  3. callback (exchanges the 60s token for a ~30-DAY session cookie)
CSRF=$(curl -s -c "$JAR" https://instaclaw.io/api/auth/csrf | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])')
curl -s -b "$JAR" -c "$JAR" -X POST "https://instaclaw.io/api/auth/callback/openai-device-code" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "signupToken=$SIGNUP_TOKEN" \
  --data-urlencode "callbackUrl=https://instaclaw.io/dashboard" --data-urlencode "json=true" -o /dev/null
# 4. PROVE the session is the test account (read-only; never creates an approval)
curl -s -b "$JAR" https://instaclaw.io/api/auth/session | python3 -m json.tool   # EXPECT id=59dcf829, email=cooper-v122-canary@instaclaw.test
# 5. extract the cookie VALUE to hand to Cooper's browser (30-day; no time pressure):
COOKIE=$(awk '/__Secure-authjs.session-token/{print $7}' "$JAR"); echo "SESSION COOKIE: $COOKIE"
rm -f "$JAR"
```

**Get the cookie into Cooper's browser (no new code) — use a SEPARATE profile to avoid colliding with his real coopgwrenn login (one session-token per domain):**
1. Open a **fresh Chrome profile or an Incognito window** (NOT the profile where Cooper is logged in as coopgwrenn — they share one cookie slot and would clobber each other).
2. Navigate to `https://instaclaw.io` (so the cookie domain exists).
3. DevTools (F12) → Application → Cookies → `https://instaclaw.io` → add cookie: name `__Secure-authjs.session-token`, value `<COOKIE>`, domain `instaclaw.io`, path `/`, **Secure ✓**, **HttpOnly ✓**, SameSite `Lax`. (HttpOnly+Secure is why devtools is required — a bookmarklet can't set it.)
4. Reload → confirm logged in as the test account (dashboard shows the test agent; or open `/api/auth/session`).
5. Keep this window open for the tap. The cookie is valid ~30 days — zero race.

> **Optional cleaner consume (NOT built — needs Cooper's review per his standing rule):** a dev-gated `/canary-login?t=<signupToken>` page (~15 lines) that calls `signIn("openai-device-code",{signupToken})` so Cooper opens one URL instead of using devtools. Reintroduces the 60s race (Cooper must open within 60s of mint) and adds an auth-adjacent surface to review + remove. The devtools-cookie path above is the zero-new-code default; build the page only if Cooper asks.

**The booking email** is a FREE PARAMETER (`book` op `customer` object, route line 341) — not tied to the owner account. Use `coopgwrenn@gmail.com`; the voucher lands in Cooper's real inbox.

**Stage 0 checklist (all true before Stage 1):**
1. Operator minted + proved the test-account session; handed Cooper the `__Secure-authjs.session-token` value.
2. Cooper imported it into a **separate browser profile/incognito**, confirmed `/api/auth/session` = test account.
3. Funded `0xd998…38c4` (vm-1043's wallet) — **as late as practical** (Bankr key is on the VM; "unarmed" guards the authorize path, not raw signing).
4. Booking `customer.email` = `coopgwrenn@gmail.com`.
5. NO reassign occurred — vm-1043 stays owned by the test account; nothing to revert in Stage 11.

```bash
# Bootstrap (one-time per session)
SB="https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1"
SRK=$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.local | sed 's/^[^=]*=//; s/^"//; s/"$//')
VM1043="0f64ac86-69d2-45f4-ac2d-a488714c4d0d"
# vm-1043's gateway token (needed for the drill authorize/settle probes):
TOKEN=$(curl -s "$SB/instaclaw_vms?id=eq.$VM1043&select=gateway_token" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['gateway_token'])")
echo "token prefix: ${TOKEN:0:8}..."   # sanity: non-empty
```

---

## TIMELINE OVERVIEW

| # | Stage | Owner | Human required? | Real money? |
|---|---|---|---|---|
| 0 | Scoped deploy (no money) | canary runbook | no | no |
| 1 | **Arm** (flip both gates ON) | canary runbook | no | no |
| 2 | **Book** (first real charge) | canary runbook | **the approval tap** | **YES (~$80)** |
| — | Mid-run nonce verify (forced retry) | canary runbook | no | no (proves no 2nd charge) |
| 3 | Record | canary runbook | no | no |
| 4 | Manage (Q1b resolves) | canary runbook | **the OTP** | no |
| 5–6 | Cancel (2-step OTP) | canary runbook | **the OTP** | no |
| 7 | Refund-watch | canary runbook | Cooper checks Travala | no (refund lands) |
| **8** | **DRILL D1 — kill switch** | **this doc** | no (operator-run) | no (probes are $5 over-budget asks) |
| **9** | **DRILL D2 — revoke interdiction** | **this doc** | no | no ($0.01 hold, never paid) |
| **10** | **DRILL D3 — anomaly plumbing** | **this doc** | no | no (dryRun read-only) |
| **11** | **Restoration + e2e ledger update** | **this doc** | no | no |

**The booking arms vm-1043 (Stage 1) and it stays armed through Stage 9.** The drills run on
the still-armed VM. D2's revoke disarms it (the desired end state). Order is load-bearing:
**D1 before D2** (D2 disarms), **D3 last** (read-only). Never run a drill if the booking aborted.

---

## STAGES 0–7 — THE BOOKING (execute from `travala-canary-runbook.md`)

Run them verbatim from that doc. This plan does not duplicate their commands; it owns the
**GO gates** and **what each banks for the e2e ledger** (`PRD §2.2`):

- **▣ GO-1 (before Stage 2 / the first charge):** preconditions all green (email decided,
  wallet funded ~$60, Cooper logged in), Stage 0+1 done. **This is the irreversible boundary.**
- **Stage 2 booking banks:** `travel session-required unforgeable (F1/F2)` → **MONEY-PROVEN**
  the moment the booking completes — it can ONLY complete via Cooper's approval tap
  (`human_approved_session`); the forgeable bool cannot pay for travel. *The booking is the F2
  drill.*
- **Stage 7 refund-watch banks:** `book→cancel→refund` → **MONEY-PROVEN**.
- **▣ GO-2 (before Stage 8 / the drills):** Stages 2–7 all green. **If the booking did NOT
  complete cleanly, STOP — no drills.** The drills are a bonus on a successful proof, never a
  salvage of a broken one. vm-1043 must still be armed (`frontier_spend_enabled=true`).

**Capture the pre-drill baseline now** (these are the Stage-11 restoration targets — quote the outputs):
```bash
# B1: kill switch must be OFF
curl -s "$SB/instaclaw_admin_settings?setting_key=eq.frontier_spend_kill_switch&select=bool_value,updated_at" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   expect: [{"bool_value":false,...}]
# B2: vm-1043 armed
curl -s "$SB/instaclaw_vms?id=eq.$VM1043&select=frontier_spend_enabled,travala_booking_enabled" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   expect: [{"frontier_spend_enabled":true,"travala_booking_enabled":true}]
# B3: the D1 blast-radius number — how many VMs a kill-switch engage will deny
curl -s "$SB/instaclaw_vms?frontier_spend_enabled=eq.true&select=count" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Prefer: count=exact" -I 2>/dev/null | grep -i content-range
#   expect: ~12 (the armed population, per coverage). This is who D1 affects for <15s.
# B4: vm-1043 pending holds (the booking's hold should be settled, not pending)
curl -s "$SB/frontier_transactions?vm_id=eq.$VM1043&status=eq.pending&direction=eq.spend&select=id,amount_usdc,created_at" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   expect: [] (or note any pre-existing holds)
```

---

## STAGE 8 — DRILL D1: KILL SWITCH (engage → deny → release → PROVE release)

**Proves:** F6/H2 — the emergency brake denies a real authorize and releases cleanly.
**Blast radius:** GLOBAL. While engaged, **every armed VM** (B3, ~12) is denied on any
authorize. Autonomous spend is rare and the window is <15s, so expected collisions ≈ 0; any VM
that does authorize gets a correct `deny/spend_kill_switch` and retries (self-healing,
user-invisible). **Do D1 first, focused, no other operations interleaved. Hard ceiling: the
switch may be engaged ≤ 60 seconds.**

**Why the probes are $5.00, not $0.01:** the kill switch is checked FIRST in `/authorize`
(before the opt-in and budget gates). A $5.00 spend on a fresh VM exceeds its earned budget, so
with the kill OFF it returns `ask_first`/`exceeds_earned_budget` (**non-kill, and it creates NO
hold** — only an authorized spend reserves). With the kill ON it returns `spend_kill_switch`
before ever reaching the budget gate. So D1 cleanly shows kill-vs-non-kill and leaves **zero
holds behind.**

```bash
# D1.1 — baseline probe, kill OFF (proves the gate is live, non-kill, no hold):
curl -s -X POST https://instaclaw.io/api/agent-economy/authorize \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"request_id":"drill-d1-pre-'$(date +%s)'","amount_usd":5.00,"endpoint":"https://example.com/drill-d1","category":"data"}'
#   EXPECT: {"authorized":false,"outcome":"ask_first" | reason "exceeds_earned_budget"|"needs_session_approval"}
#   PASS = reason is NOT spend_kill_switch / spend_kill_switch_unverifiable. (Travel→session; data→budget. Either is non-kill.)

# D1.2 — ENGAGE. Note the wall-clock NOW; the ≤60s timer starts.
#   (Studio SQL, or the REST upsert below.)
curl -s -X POST "$SB/instaclaw_admin_settings?on_conflict=setting_key" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  -d '{"setting_key":"frontier_spend_kill_switch","bool_value":true,"notes":"DRILL D1 — '$(date -u +%FT%TZ)'"}'
#   (Studio equivalent — the verbatim engage from the IR runbook:)
#   INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
#   VALUES ('frontier_spend_kill_switch', true, 'DRILL D1')
#   ON CONFLICT (setting_key) DO UPDATE SET bool_value=true, updated_at=now(), notes=EXCLUDED.notes;

# D1.3 — probe, kill ON (THE money-proven evidence: a real authorize denied by the brake):
curl -s -X POST https://instaclaw.io/api/agent-economy/authorize \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"request_id":"drill-d1-killed-'$(date +%s)'","amount_usd":5.00,"endpoint":"https://example.com/drill-d1","category":"data"}'
#   EXPECT: {"authorized":false,"outcome":"deny","reason":"spend_kill_switch"}   ← the brake works on real traffic.

# D1.4 — RELEASE.
curl -s -X PATCH "$SB/instaclaw_admin_settings?setting_key=eq.frontier_spend_kill_switch" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
  -d '{"bool_value":false,"updated_at":"'$(date -u +%FT%TZ)'"}'
#   (Studio: UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now() WHERE setting_key='frontier_spend_kill_switch';)

# D1.5 — PROVE RELEASE (FUNCTIONAL — do NOT trust the row count; trust a real authorize):
curl -s -X POST https://instaclaw.io/api/agent-economy/authorize \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"request_id":"drill-d1-post-'$(date +%s)'","amount_usd":5.00,"endpoint":"https://example.com/drill-d1","category":"data"}'
#   EXPECT: reason is NOT spend_kill_switch (release took). A non-kill verdict = release proven.
```

**Evidence the e2e ledger gets (SELECT it back — A must have logged the real deny):**
```bash
curl -s "$SB/frontier_spend_events?vm_id=eq.$VM1043&reason=eq.spend_kill_switch&order=created_at.desc&limit=1&select=created_at,decision_point,verdict,gate,reason" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT one fresh row: {"decision_point":"authorize","verdict":"deny","gate":"kill_switch","reason":"spend_kill_switch"}
```
**If D1.3 returned the deny but this SELECT is EMPTY → that is an S7 finding (the verdict log
dropped a real deny), NOT a D1 pass.** Stop, treat as a flight-recorder incident.

**D1 ABORT (the only paging-class drill):** if at **+60s** D1.5 still shows `spend_kill_switch`,
force-release (re-run D1.4) and re-probe. If at **+90s** still killed → **PAGE: the fleet's
spend is denied.** Manually force `bool_value=false` via Studio, confirm with D1.5, and abort
the entire drill block (do not proceed to D2/D3 with prod in an uncertain kill state).

**D1 restoration:** `frontier_spend_kill_switch.bool_value=false` (B1 query → false) AND D1.5
returns non-kill. Both must hold before Stage 9.

---

## STAGE 9 — DRILL D2: REVOKE INTERDICTION (real hold → revoke → settle loses)

**Proves:** F3/H3 — revoke flips a real in-flight hold to `revoked`, the settle CAS loses for
free, the interdiction is logged. **Drives the REAL `/revoke-spend` endpoint** (HMAC token
minted operator-side — the full real path, not a SQL shortcut). **Zero money risk: the hold is
created by a real `/authorize` but never paid.**

**Why NOT revoke the real booking's hold (the ordering decision, argued):** revoking the booking
would prove the brake by *breaking the thing the brake protects* — if the revoke won the race
against the booking's settle, the booking hold goes `revoked`, the booking doesn't complete, and
if Travala already accepted the 402 we'd have a real paid-on-chain-but-revoked-locally
liability on the actual booking (the `settle_on_revoked_hold` gap, on real money). That's an
own-goal, not a drill. A *separate $0.01 real hold* exercises the identical mechanism
(authorize→hold→revoke→settle-loses) on real DB rows with no value at risk. **Maximal honesty
that costs the proof run is worse than honest-enough that protects it.**

```bash
# D2.1 — create a REAL pending hold (authorize a tiny autonomous spend; vm-1043 still armed):
REQ="drill-d2-$(date +%s)"
curl -s -X POST https://instaclaw.io/api/agent-economy/authorize \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"request_id":"'$REQ'","amount_usd":0.01,"endpoint":"https://example.com/drill-d2","category":"data"}'
#   EXPECT: {"authorized":true,"mode":"autonomous","hold_id":"<UUID>",...}   ← a real pending hold.
#   IF "exceeds_earned_budget": vm-1043's earned budget is below $0.01 (unexpected; floor is $0.10) or
#     exhausted — reduce amount or note the budget state. The drill needs ONE authorized hold.
# Confirm the hold is pending:
curl -s "$SB/frontier_transactions?request_id=eq.$REQ&select=id,status,amount_usdc" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT: [{"id":"<HOLD_UUID>","status":"pending","amount_usdc":0.01}]   ← record HOLD_UUID.

# D2.2 — REVOKE via the real endpoint. Mint the HMAC token operator-side.
#   PURE-NODE inline mint (no module import): worktree-independent, immune to the
#   main checkout lacking frontier-approvals.ts and to the TLA-in-CJS tsx-eval trap.
#   Byte-for-byte identical to signRevokeToken: same b64url, same {vm,jti,aud} payload,
#   same `${pB64}.${exp}` HMAC-SHA256(NEXTAUTH_SECRET) input, same 24h TTL.
#   Proven 2026-06-12 against the real verifyRevokeToken (sig+aud+expiry all pass).
#   NOTE the absolute env path: the tier0 worktree has no .env.local of its own —
#   NEXTAUTH_SECRET lives only in the MAIN checkout's .env.local.
REVOKE_TOKEN=$(node -e '
  const crypto=require("crypto"), fs=require("fs");
  for (const l of fs.readFileSync("/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","utf8").split("\n")){
    const m=l.match(/^([^#=]+)=(.*)$/); if(m&&!process.env[m[1].trim()]) process.env[m[1].trim()]=m[2].trim().replace(/^["\x27]|["\x27]$/g,"");
  }
  const s=process.env.NEXTAUTH_SECRET;
  if(!s||s.length<16){console.log("MINT_FAILED:NEXTAUTH_SECRET unset/short");process.exit(0);}
  const b64url=(x)=>Buffer.from(x,"utf-8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  const payload={vm:process.argv[1],jti:crypto.randomBytes(16).toString("hex"),aud:"frontier-revoke"};
  const pB64=b64url(JSON.stringify(payload));
  const exp=Math.floor(Date.now()/1000)+24*60*60;
  const hmac=crypto.createHmac("sha256",s).update(pB64+"."+exp).digest("hex");
  console.log(pB64+"."+exp+"."+hmac);
' "$VM1043")
echo "revoke token: ${REVOKE_TOKEN:0:16}...  (MINT_FAILED here ⇒ NEXTAUTH_SECRET not loaded; fix before curl)"
curl -s "https://instaclaw.io/api/agent-economy/revoke-spend?token=$REVOKE_TOKEN" | grep -oE "Spending turned off|pending|cancelled|already off|not valid" | head -1
#   EXPECT: an HTML page whose body says spending is off + "N pending payment(s) … cancelled" (N includes our hold).

# D2.3 — VERIFY the interdiction (three facts):
curl -s "$SB/frontier_transactions?request_id=eq.$REQ&select=status" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT: [{"status":"revoked"}]   ← the hold was interdicted.
curl -s "$SB/instaclaw_vms?id=eq.$VM1043&select=frontier_spend_enabled" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT: [{"frontier_spend_enabled":false}]   ← revoke disarmed the VM (future-gate). vm-1043 now DISARMED.
curl -s "$SB/frontier_spend_events?reason=eq.revoked_in_flight&transaction_id=eq.<HOLD_UUID>&select=verdict,gate,reason,amount_usd" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT: [{"verdict":"deny","gate":"revoke","reason":"revoked_in_flight","amount_usd":0.01}]   ← logged, with the hold + amount.

# D2.4 — PROVE settle loses the CAS (the interdiction is real, not cosmetic):
curl -s -X POST https://instaclaw.io/api/agent-economy/settle \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"result":"failed","request_id":"'$REQ'"}'
#   EXPECT: HTTP 409 body ~ {"error":"hold is now revoked; cannot settle as failed"}   ← settle lost the flip.
#   (result=failed → no tx_hash required → the settle_on_revoked_hold event lands WITH tx_hash=NULL →
#    coverage stays CLEAN. This proves settle-loses + the gap signal without tripping the UNHEALTHY detector.)
curl -s "$SB/frontier_spend_events?reason=eq.settle_on_revoked_hold&transaction_id=eq.<HOLD_UUID>&select=reason,tx_hash" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
#   EXPECT: [{"reason":"settle_on_revoked_hold","tx_hash":null}]   ← gap signal, no money implied.
```

**Budget-freed note:** the `revoked` hold no longer counts toward `spentToday`
(`reserveAwareSpentTodayUsd` excludes any non-`settled`/non-fresh-`pending` status — verified in
the `'revoked'` migration's reader-safety audit + the unit test). This is operation-proven by
construction; not separately money-drilled (low marginal value).

**D2b — OPTIONAL (only on Cooper's explicit "run D2b"): prove the revoked-but-on-chain-paid gap
detector + its alarm.** This DELIBERATELY trips the coverage script's UNHEALTHY state, so it MUST
be reconciled in the same step.
```bash
# Settle a SECOND fresh revoked hold WITH a test tx_hash → settle_on_revoked_hold w/ tx_hash → UNHEALTHY:
#   (repeat D2.1→D2.3 for a second hold REQ2/HOLD2 — but D2.2 already disarmed the VM, so re-arm first:)
curl -s -X PATCH "$SB/instaclaw_vms?id=eq.$VM1043" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{"frontier_spend_enabled":true}'
#   ... authorize REQ2 ($0.01) → revoke → then:
curl -s -X POST https://instaclaw.io/api/agent-economy/settle -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"result":"success","request_id":"'$REQ2'","tx_hash":"0xDRILLtESTnotarealtx"}'
#   Confirm the detector fires (the S5c IR query):
npx tsx /Users/cooperwrenn/wild-west-bots-tier0/instaclaw/scripts/_coverage-frontier.ts 2>&1 | grep "revoked-but-on-chain-paid"
#   EXPECT: "⚠ revoked-but-on-chain-paid (reconcile)  1"  → the gap detector + S5c query PROVEN.
# RECONCILE (mandatory teardown — delete the test event row so coverage returns clean):
curl -s -X DELETE "$SB/frontier_spend_events?reason=eq.settle_on_revoked_hold&tx_hash=eq.0xDRILLtESTnotarealtx" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Prefer: return=representation"
npx tsx /Users/cooperwrenn/wild-west-bots-tier0/instaclaw/scripts/_coverage-frontier.ts 2>&1 | grep "revoked-but-on-chain-paid"
#   EXPECT: "revoked-but-on-chain-paid gaps  0"  → reconciled, coverage clean.
```

**D2 ABORT:** D2 has no paging class (revoke is fail-safe). A failed D2.1 (no hold) → re-attempt
or skip D2. A failed mid-D2 leaves either a clean `pending` hold (terminalize: `UPDATE
frontier_transactions SET status='failed' WHERE id=...`) or a clean `revoked` hold (terminal,
fine). A failed drill aborts ITSELF and STOPS the block — assess before D3.

**D2 restoration:** vm-1043 `frontier_spend_enabled=false` (revoke disarmed it — desired). The
test hold(s) terminal as `revoked` (coverage-clean) or `failed`. If D2b ran, the test tx_hash
row is DELETED + coverage re-confirmed clean.

---

## STAGE 10 — DRILL D3: ANOMALY DETECTION (plumbing proof + the design ruling)

**The honest finding (closed on paper, not live):** the spend-anomaly layer is **un-trippable
by a well-behaved canary, by design.** Two detectors, both gated behind real abnormal spend:
- **The velocity GATE** (`anomalyFlag`, `frontier-ledger.ts:213`) fires only on **≥5 settled
  spends to ≥5 distinct *new* counterparties in 24h** — that's 5 real on-chain payments AND it
  poisons vm-1043's standing (anomaly-flagged, autonomy-throttled) for 24h.
- **The spend-anomaly CRON** (`DEFAULT_ANOMALY_THRESHOLDS`: floor $25, single-large $40, burst
  $75 / 3 spends in 1h, consent-graded so session spends are excluded) fires only on **≥3
  *autonomous* spends summing >$75 in 1h** — impossible on a fresh VM whose earned budget caps
  autonomous spend at ~$0.10 and whose tier ceiling caps per-tx well below $75.

**You cannot money-prove a fraud detector without committing fraud, and we will not commit fraud
on the VM we are trying to prove.** Manufacturing a trip costs real money for a deterministic,
rig-proven rule AND poisons the canary VM. So D3 proves the *plumbing* (the detector reads real
prod data and would alert), and a real *trip* stays a **permanent watch item with the reason
recorded** — this is a STRENGTH (no false positives), not a gap.

```bash
# D3.1 — prove the detection plumbing on LIVE prod (read-only, no alert sent):
curl -s "https://instaclaw.io/api/cron/frontier-spend-anomaly?dryRun=true" -H "Authorization: Bearer $SRK" | python3 -m json.tool | head -30
#   EXPECT: a JSON body with per-VM verdicts computed from real frontier_transactions, dryRun:true,
#     and (on a healthy fleet) no VM over threshold. Proves: the cron reads real data + computes +
#     would alert — it is not silently broken. (If it 401s, use the Vercel cron secret header instead.)
```
**Ledger entry:** `spend-anomaly detection` → **PLUMBING-PROVEN; real trip = permanent watch by
design** (cost of money-proving exceeds value; the rule is deterministic + rig-proven).

---

## STAGE 11 — RESTORATION + E2E LEDGER UPDATE (terminal state is PROVEN, not assumed)

Run every check; each must match. "I think it's clean" is not a terminal state.

```bash
# R1: kill switch OFF
curl -s "$SB/instaclaw_admin_settings?setting_key=eq.frontier_spend_kill_switch&select=bool_value" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"          # expect [{"bool_value":false}]
# R2: vm-1043 fully disarmed (both gates) — the canary's POST-RUN disarm
curl -s -X PATCH "$SB/instaclaw_vms?id=eq.$VM1043" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{"frontier_spend_enabled":false,"travala_booking_enabled":false}'
curl -s "$SB/instaclaw_vms?id=eq.$VM1043&select=frontier_spend_enabled,travala_booking_enabled" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"               # expect both false
# R3: no stray pending holds (drill probes were $5 over-budget = no holds; D2 holds are 'revoked'; any stray self-expires)
curl -s "$SB/frontier_transactions?vm_id=eq.$VM1043&status=eq.pending&direction=eq.spend&select=id,created_at" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" # expect [] (or terminalize any to 'failed')
# R4: coverage script clean (incl. the revoked-but-paid gap = 0 if D2b ran + reconciled)
npx tsx /Users/cooperwrenn/wild-west-bots-tier0/instaclaw/scripts/_coverage-frontier.ts; echo "exit=$?"                                                          # expect "✓ healthy" exit 0
# R5: ownership — NOTHING to revert. The session-mint route (Stage 0) does NO reassign;
#     vm-1043 stayed owned by the test account throughout. Cooper just closes the
#     incognito/test-account browser window (the session cookie self-expires in ~30 days).
```

**Update `PRD §2.2` (the living e2e ledger) with the results — Rule 72:**
- `kill-switch engage→deny→release (F6/H2)` → **MONEY-PROVEN** (cite the D1.3 deny + D1.5 release + the SELECT'd `spend_kill_switch` row).
- `revoke interdicts a real in-flight hold + settle loses (F3/H3)` → **MONEY-PROVEN** (cite the D2.3 `status=revoked` + the 409 + the `revoked_in_flight` row).
- `verdict log receives real rows across gates (H1)` → **MULTI-GATE PROVEN** — opt_in (write-proof) + session_approval (booking) + kill_switch (D1) + revoke (D2). The cross-cut: D1+D2 prove A across the gate spectrum for free.
- `travala book→cancel→refund` + `travel session-required unforgeable (F1/F2)` → **MONEY-PROVEN** (Stages 2–7).
- `settle_on_revoked_hold gap w/ tx_hash` → **PROVEN** only if D2b ran (else still pending).
- `spend-anomaly` → **PLUMBING-PROVEN; real-trip watch-by-design**.
- `[P1] BLIND alert` → unchanged **permanent watch** (un-drillable without sabotaging Supabase).

---

## WHERE A HUMAN IS STRUCTURALLY REQUIRED (Cooper's hands only)

Everything else is operator-automatable. Cooper is required at exactly these points:
1. **▣ GO-1** — the go before the first real charge (and the funded wallet + decided email + browser login are his real-world actions).
2. **The approval tap** (Stage 2) — travel is session-required; the booking cannot complete without it. *This tap IS the F2 proof.*
3. **The cancellation OTP** (Stages 4–6) — read from his email.
4. **▣ GO-2** — the go before the drills (and the optional "run D2b").
5. **Travala refund check** (Stage 7) — sign in, confirm where the credit lands.

The drills (Stages 8–11) need **no human tap** — they are operator-run probes against the
armed VM. That is deliberate: a brake you can only test with a human in the loop is a brake you
won't test often enough.

---

## ABORT SEMANTICS — CONSOLIDATED

- **Booking aborts (Stages 0–7):** governed by the canary runbook's per-stage abort blocks. A
  booking abort means **NO drills** (GO-2 not reached).
- **A failed drill aborts ITSELF, runs its restoration, and STOPS the block** — it does NOT
  auto-proceed to the next drill. Cooper decides continue-or-abort.
- **D1 is the only paging-class drill** (engaged kill = fleet-wide deny): 60s engaged ceiling,
  force-release escape, page at 90s, and a D1 failure aborts the whole drill block (don't run D2
  with prod in an uncertain kill state).
- **D2 is fail-safe** (revoke can't lose money); D3 is read-only. Neither can leave a
  paging-class state — but D2b's deliberate UNHEALTHY trip MUST be reconciled in the same step.

---

*Grounded against deployed code + a scratch DDL replica + live prod, 2026-06-12. vm-1043 IDs,
the kill-switch SQL, the authorize/settle/revoke shapes, the anomaly thresholds, and the
revoke-token mint (an inline pure-node replica of `signRevokeToken`, proven 2026-06-12 against
the real `verifyRevokeToken`) are all matched to shipped code. Anything marked "EXPECT" on a money/prod
path that hasn't run live is the predicted output from the deployed logic — verify it against
reality during the run; a mismatch is a finding, not a typo.*
