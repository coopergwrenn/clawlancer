# Login with ChatGPT — Architecture Decisions (Deep Research)

**Companion to:** [chatgpt-oauth-history-import.md](./chatgpt-oauth-history-import.md)
**Date:** 2026-05-18
**Status:** Decisions document — Cooper reviews + approves/overrides; engineering builds against this once locked.

---

## TL;DR — the 60-second read

The original PRD is ~80% right but **two of its load-bearing architectural choices are wrong**, and a third is non-obvious enough to need explicit Cooper sign-off. Six parallel deep-research agents converged independently on the same conclusions:

1. **The OAuth flow from a datacenter VM is the wrong primary architecture.** Build a **browser extension bridge** instead. The user's own browser session on `chatgpt.com` is the credential authority; our cloud agent proxies inference requests through a websocket to the extension, which makes the actual call from the user's residential IP with their real Chrome TLS stack. This eliminates Cloudflare-bot-detection risk entirely, sidesteps the OpenAI ToS question (the user is using their own browser, not a third-party "Codex OAuth client"), and removes the 5th token location from our architecture (we never hold an OpenAI token). Engineering cost: ~6 weeks. Same as the OAuth path the original PRD specified.

2. **The history-import extraction pipeline should be block-based + RAG, not per-conversation LLM extraction.** The Nov-2025 [ConvoMem paper (arXiv 2511.10523)](https://arxiv.org/abs/2511.10523) empirically proves block-based extraction (10 convs per LLM call, parallel) + RAG fallback beats pure per-conv extraction by 10+ points at the 1000+ conversation scale our power users have. **Also**: bootstrap from `messages[].recipient == "bio"` entries in conversations.json — these are OpenAI's own curated memories the user has accumulated, free and high-quality, ~50-200 per power user.

3. **Sensitive-content handling needs a "restricted vault" architecture from day 1, not a post-launch filter.** Medical / legal / financial / relationship / sexual / political content extracted from history goes into an encrypted off-context vault on the VM, NEVER into MEMORY.md by default. Agent surfaces vault entries only on explicit user invocation. This is the single biggest difference between InstaClaw and Replika/Character.AI's product-killer failure modes (the Italian DPA €5M Replika fine, the Character.AI lawsuit settlement, the iOS Photos "anniversary of trauma" backlash).

If Cooper approves all three, the original PRD's 11-week timeline holds (Phase 1 OAuth = 6 weeks, replaced by Phase 1 Extension = 6 weeks; Phase 2 history import = 6 weeks). If Cooper rejects the extension architecture and stays with OAuth-from-datacenter, the timeline doesn't change but the project becomes a Cloudflare-evasion arms race with a probable 6-18 month half-life.

The 23 decisions below cover the original 12 questions from PRD §11 plus 11 new ones the research surfaced. Decision summary table at end (§D).

---

## Strategic frame — why the architecture changed

Three independent research streams converged on the same answer.

**Stream 1: Architecture research (Cloudflare workarounds).** Anthropic killed exactly this product shape — datacenter OAuth wrapping consumer subscription — in February 2026 ([VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)). They updated terms to ban OAuth tokens from Claude Pro/Max being used in any other product, and enforced via Cloudflare. The OpenAI 403s on Linode cloud IPs the original PRD flagged are the same playbook starting on the OpenAI side. Probability of OpenAI following Anthropic within 12 months: 70%+. The only architecture that survives is one where the credential never leaves the user's browser.

**Stream 2: Partnership research.** OpenAI is currently the *opposite* of Anthropic — they're actively welcoming third-party tools ([TechCrunch on Sign-in-with-ChatGPT, May 2025](https://techcrunch.com/2025/05/27/openai-may-soon-let-you-sign-in-with-chatgpt-for-other-apps/); the OpenCode + OpenHands + RooCode + OpenClaw partnerships in Q1 2026; Sam Altman's "ok boomer" tweet at Anthropic's head of growth). OpenClaw, the direct precedent for InstaClaw, got an official-but-informal arrangement that involves "whitelist at rate-limit layer + public endorsement." This is great news short-term — we should apply via the [Sign-in-with-ChatGPT developer interest form](https://openai.com/form/partnerintake/) immediately — but **even an officially-partnered InstaClaw is still at the mercy of OpenAI's competitive posture**, which can shift. The extension architecture doesn't depend on OpenAI's posture at all.

**Stream 3: Failure-mode analysis.** Six structural failure modes the original PRD didn't fully address — including (a) the "shared ChatGPT account" problem (no family plan exists, lots of households share accounts), (b) the "agent surfaces medical history on a screen-shared sales call" embarrassment, (c) the prompt-injection-via-conversation-history attack ([ChatInject arXiv 2509.22830](https://arxiv.org/pdf/2509.22830); [Oasis Security "Claudy Day" attack](https://www.oasis.security)), (d) the conversational-AI-as-evidence ruling (April 2026 federal court). Each one independently demanded a defense the original PRD didn't have. The extension architecture + restricted vault + per-channel memory scoping closes all six.

**The combined picture: the right architecture is browser extension + block-based extraction + restricted vault.** Each of these is independently defensible; together they form a coherent product that survives the technical, legal, and social risks the original PRD was exposed to.

The original PRD's research was solid — it correctly identified the three existential risks. The deep research validated those risks AND found that the same architectural change (browser extension) resolves all three at once.

---

## Part A — Original 12 questions (PRD §11)

### Q1. Cloudflare mitigation default

**Question:** Assume Option A (TLS-fingerprint match) works after spike. If it doesn't, which fallback path: B (residential proxy), C (WARP), D (hybrid), or kill?

**Recommended answer:** **Reject Option A as the primary architecture entirely. Build the browser extension bridge instead. Datacenter + TLS-fingerprint + residential proxy is the 6-week bridge during extension build, not a destination.**

**Why the original framing was incomplete.** The PRD asked "which fallback if TLS-fingerprint fails" but the research found TLS-fingerprint matching is **necessary but not sufficient** even when it works — Cloudflare's bot detection stacks IP reputation, JA3/JA4, HTTP/2 SETTINGS, header order, and behavioral patterns on top of TLS fingerprint. From [Scrapfly's bypass research](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping): "a clean TLS fingerprint from a datacenter /24 still fails Cloudflare's IP-scoring layer." [openai/codex#17860](https://github.com/openai/codex/issues/17860) confirms macOS users on datacenter VPNs hit the same 403 — IP reputation alone is enough.

**The structural answer.** Move credential-use to user-controlled execution context. Three real options:
- **Browser extension** (recommended): user installs InstaClaw Companion extension; extension reads existing `chatgpt.com` session cookies; agent posts inference requests via websocket; extension `fetch()`s OpenAI from inside the user's browser. Zero Cloudflare friction (it IS the user's Chrome), zero ToS friction (no OAuth client_id to revoke; the user is using their own browser session the way OpenAI intends). ~6 weeks engineering.
- **Native helper daemon**: same logic, distributed as a Mac/Windows/Linux binary instead of a browser extension. Same wire protocol. Works when browser is closed. ~4-6 weeks engineering. Add as secondary surface for power users.
- **Datacenter + curl-impersonate + residential proxy (Bright Data ~$0.50-2.00/user/month)**: a 3-12 month bridge during the extension build. Don't make the business depend on it. The cost economics ($1-3/user/month proxy bandwidth) is acceptable as a temporary; as a permanent architecture it's a slow tax.

**Citations:** [Anthropic's third-party crackdown — VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses); [MindStudio's analysis of the OpenClaw ban](https://www.mindstudio.ai/blog/anthropic-openclaw-ban-third-party-harnesses-claude-subscriptions); [Chrome MV3 Service Worker keepalive patterns](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle); [1Password's local-credential-use architecture](https://1password.com) as the canonical pattern; [rpidanny/chatgpt-browser-api-proxy](https://github.com/rpidanny/chatgpt-browser-api-proxy) as proof-of-existence for the browser-side approach.

**Confidence:** HIGH. The architecture research, partnership research, and failure-mode analysis all independently validate this answer.

**Blocking:** YES. This decision cascades into Q2, Q3, Q10, Q12, and the new questions Q13-Q14.

**Dependencies:** Q2 (ToS) and Q3 (5th token storage) become much smaller problems if Q1 is the extension.

---

### Q2. ToS path

**Question:** Recommended Option 2 (reuse Codex client_id with disclosed UX) for Phase 1, parallel Option 1 (formal partnership) for Phase 2 swap-over. Confirm or override.

**Recommended answer:** **The extension architecture (Q1) eliminates the need for any OAuth client_id at all. Don't reuse Codex's `app_EMoamEEZ73f0CkXaXp7hrann`. Apply for OpenAI's "Sign in with ChatGPT" partner program in parallel (it's free to file).**

**Why this changes.** The original PRD's three options (register our own client_id, reuse Codex's, ship as desktop helper) all assumed we'd be the OAuth client. With the extension architecture, we are NOT the OAuth client — the user's browser is. There's nothing for OpenAI to enforce against because there's no third-party OAuth happening. From OpenAI's logs, an extension-relayed request is indistinguishable from the user opening chatgpt.com themselves.

**The partnership path is still worth pursuing — it's free and asymmetric:**
- File the [Sign in with ChatGPT developer interest form](https://techcrunch.com/2025/05/27/openai-may-soon-let-you-sign-in-with-chatgpt-for-other-apps/) within 7 days. Pitch InstaClaw as "the consumer agent platform that's a complement to ChatGPT — we drive subscription retention." Reference OpenClaw as the precedent we want extended.
- Warm-intro path: Brad Lightcap (COO, ex-YC). If Cooper has any YC network, this is the asymmetric path.
- Don't ask for a custom partnership or revenue share in the first meeting. Ask for the same arrangement as OpenCode/OpenClaw: whitelist + public endorsement.

**Disclosure copy** for the extension's permission prompt and the dashboard:
> InstaClaw Companion securely connects your InstaClaw cloud agent to your locally signed-in ChatGPT account. Your ChatGPT password and session stay in your browser — we never see them or store them on our servers. The extension only sends inference requests to chatgpt.com when authorized by your InstaClaw agent. You can disable it at any time from the InstaClaw dashboard.
>
> InstaClaw is not an official OpenAI product. ChatGPT usage counts against your ChatGPT plan's quota.

This is shorter and less scary than the original PRD's OAuth disclosure because there's less to disclaim — the user is genuinely just authorizing their own browser to do something on their behalf.

**Citations:** [Plaid → JPMC banking partnership precedent (2018 → 100% API by 2023)](https://media.chase.com/news/plaid-signs-data-agreement-with-jpmc); [OpenCode + OpenHands + RooCode + OpenClaw partnerships with OpenAI (Q1 2026)](https://paddo.dev/blog/anthropic-walled-garden-crackdown/); [Sam Altman's "ok boomer" posture toward Anthropic](https://officechai.com/ai/ok-boomer-sam-altman-trolls-anthropic-after-it-removes-claude-code-from-its-pro-plan-for-section-of-new-users/).

**Confidence:** HIGH for the extension architecture sidestepping the ToS question; MEDIUM for the partnership likelihood (probably 40-55% we get OpenCode-style whitelisting given InstaClaw's current user count, 70-85% we get tacit safe-harbor regardless).

**Blocking:** NO. Ship the extension; partnership is upside.

---

### Q3. 5th token storage

**Question:** New `openai-oauth.json` file + reconciler step `stepChatGPTOAuthToken` + per-user `openai_token_version`. Approve?

**Recommended answer:** **REJECT — eliminate the 5th token location entirely.** With the extension architecture, we never hold an OpenAI access/refresh token. The token lives in the user's browser (in the existing chatgpt.com session cookie). We don't have to store it, rotate it, encrypt it, or sync it across VMs.

**What we DO need on the VM side:**
- A `chatgpt_subscription_pending` flag in `instaclaw_users` (was the extension installed and paired?)
- The user's `chatgpt_account_email` for display purposes (from `user.json` in the export, or extension reports it)
- A `chatgpt_subscription_active_seen_at` heartbeat (extension pings every N hours to confirm session is live)

That's it. No tokens. No encryption. No 4-location-sync extension. The existing 4 token locations (`auth-profiles.json`, `openclaw.json`, `.env`, `instaclaw_vms.gateway_token`) stay as is.

**What the extension owns:**
- The user's chatgpt.com session cookie (lives in their Chrome's cookie store)
- A pairing token between the user's extension and their InstaClaw account (so multi-user laptops work)
- A websocket connection to `bridge.instaclaw.io` (our cloud relay)

**What the cloud owns:**
- A pairing-token-to-user-id map (small Postgres table)
- A websocket relay (transient state, no persistence)
- Per-call audit log (which inference call, when, what user — for compliance, not for token recovery)

This eliminates an entire category of incidents (Rule 22 / Rule 34 token-drift bugs) by design. No token to drift.

**Confidence:** HIGH. Direct consequence of Q1.

**Blocking:** NO. Architecture decision falls out of Q1.

---

### Q4. Multi-provider routing model

**Question:** Primary = OpenAI sub; heartbeats stay on our Anthropic; embeddings stay on our OpenAI; BYOK Anthropic available as user-invoked override; per-call sub→our-Anthropic fallback on 429. Approve?

**Recommended answer:** **APPROVE as designed. This is the moat. No competitor does multi-provider with per-call fallback.** Research across Claude Code, Cursor, Windsurf, Continue, Aider, and Codex confirms none of them auto-fall-back across providers on 429.

**Refinements based on research:**

| Track | Model | Cost owner | Notes |
|---|---|---|---|
| Primary chat | `openai/gpt-5.5` (or what user's plan exposes) | User's ChatGPT subscription | Via extension/bridge per Q1 |
| Heartbeats | `anthropic/claude-haiku-4-5` | InstaClaw (platform) | Unchanged from current architecture |
| Embeddings | `openai/text-embedding-3-large` | InstaClaw (our OpenAI API key) | Unchanged |
| Anthropic BYOK | `anthropic/<user-choice>` | User's Anthropic key | Optional; per-conversation slash command |
| Per-call fallback on 429 | `anthropic/claude-sonnet-4-6` on our key | InstaClaw (capped per §Q5) | The moat |
| Per-call fallback on Cloudflare 403 (architecture residual) | Same as 429 | InstaClaw (capped) | Should be near-zero with extension architecture |

**The marketing line: "Your subscription powers your agent. If you hit your OpenAI limit, we catch you transparently with Claude. You never see a quota error mid-conversation."** This is the headline of the launch.

**Confidence:** HIGH.

**Blocking:** NO. Independent of Q1 architecture choice.

---

### Q5. Per-call fallback caps

**Question:** 50K / 250K / 1M tokens per tier per month. Tunable. Approve as initial?

**Recommended answer:** **APPROVE caps as starting point. Add soft overage in $5 blocks with $20/mo default spending limit (user-configurable). Auto-degrade to "ChatGPT-subscription-only" mode when overage limit hit.** This is the GeForce NOW pattern they JUST shipped (Jan 2026: 100hr cap + 15hr blocks at $2.99/$5.99 each) — proven to balance bill-shock prevention with agent-keeps-working continuity.

**Why not hard-cap (GitHub Copilot model):** an autonomous agent with cron jobs running while the user is asleep can't tolerate "agent stopped mid-task." Hard cap = user wakes to "nothing got done for 6 hours."

**Why not unlimited (AWS pay-as-you-go):** $1,000+ bill-shock incidents have happened to students with looping bots. Brand-killer.

**Why this specific design works:**
- Soft overage in $5 blocks = predictable, capped, user-controllable
- Default $20/mo overage limit = $5 + $5 + $5 + $5 = 4 fallback events worth before degradation
- Auto-degrade to ChatGPT-only when limit hit = agent keeps working, just no Claude backup until next cycle
- Email at 50% / 80% / 100% of overage limit = no surprises
- Repeated overage triggers in-app upsell to higher tier ("you keep using fallback; upgrade to Pro for 5× more headroom")

**Token caps per tier validation needed post-launch:** if observed real fallback usage is dramatically higher than 50K/Starter, raise to 100K and reprice. Build the telemetry from day 1.

**Confidence:** MEDIUM (caps are based on estimates of how often users will hit OpenAI quotas; need real data to tune).

**Blocking:** NO.

---

### Q6. Starter BYOS pricing problem

**Question:** $14/mo doesn't cover $35/mo cost. Recommended: raise to $19. Approve, or pick alternative?

**Recommended answer:** **Three-tier structure: $19 Starter / $49 Pro / $149 Power, with annual at 16/20/20% off, plus a $4.99 Day Pass and a $29+$9/seat Crew tier.** This rejects the original PRD's "match BYOK pricing" approach in favor of the empirically-validated "wrapper-with-bundled-value pricing" pattern. With pricing being raised across all tiers anyway (per Cooper's note), the new BYOK base will likely be higher; BYOS should be priced **$10-15 above BYOK** to capture the convenience-and-fallback surplus.

**Why this specific structure** (full reasoning in research artifact §3):

- **$19 Starter** beats Claude Code Pro ($20 with bundled inference) on autonomy/persistence and clears marginal infra cost (~$30) at modest gross margin.
- **$49 Pro is the revenue mover** — 60-70% of users will pick the middle tier (KeyBanc, SaaS Capital, OpenView research). $30 gap above Starter signals clear upgrade; $100 gap below Power signals clear value.
- **$149 Power is the anchor** — anchors Pro upward. Below Replit Pro ($95-100), above Hex Pro ($75), positions as "serious autonomous agent infrastructure" not "coding tool."
- **$4.99 Day Pass** = GeForce NOW's most underrated revenue stream. Removes commitment friction; 30-60% paid-trial-to-subscription conversion vs 10-25% free-trial conversion (loss-aversion research).
- **Crew tier ($29 + $9/seat, min 3)** = no competitor has this. Captures organic household/DAO/podcast use already happening (Edge City partner cohorts).

**Annual discounts:** 16% on Starter (heavy entry discount to convert monthly), 20% on Pro/Power (lighter on premium per Replit's pattern — high-tier users have inelastic demand). No multi-year offers.

**Citations:** [Cursor pricing analysis](https://cursor.com/pricing) (BYOK still costs $20/mo for wrapper); [GeForce NOW pricing structure with new 100hr cap](https://videocardz.com/newz/geforce-nows-100-hour-monthly-cap-starts-january-1-for-everyone-users-chart-shows-what-extra-time-costs); [SaaS Capital hybrid pricing NDR data (125% median)](https://www.saas-capital.com); [Replit Effort-Based Pricing](https://blog.replit.com/effort-based-pricing).

**Confidence:** HIGH on structure. MEDIUM on exact numbers (should be A/B-testable post-launch).

**Blocking:** NO. Marketing and finance decision.

---

### Q7. Privacy default

**Question:** Process-and-delete in 24h (raw zip + intermediates); opt-in 30-day retention. Approve?

**Recommended answer:** **APPROVE process-and-delete defaults. ADD: restricted vault architecture for sensitive content (see Q17 below), multi-user detection refusal (Q18), and per-channel memory scoping (Q19).** Privacy defaults are necessary but not sufficient — the failure modes the original PRD doesn't fully address are about WHAT we extract, not just how long we keep the raw zip.

**Refinements:**
- Raw zip: 24h post-extraction (current PRD). ✓
- Extracted facts: indefinite, but every fact has `extracted_at`, `last_confirmed_at`, `source_message_ids[]` for provenance.
- Per-fact deletion: one-click in dashboard. Hard delete (not soft).
- Per-category deletion: "forget everything you learned about my health" bulk action.
- Factory reset: "delete all extracted memories" nuclear button (with 24h soft delete first, then irreversible).
- GDPR Article 17 deletion endpoint: returns 200 immediately, queues tombstone job. SLA: 24h soft delete, 30d hard delete across PGLite + R2 + session jsonls.
- "Process and delete" opt-out: 30-day retention checkbox at upload time, default OFF, clear copy explaining what it enables ("re-extraction if we improve our prompts").

**Critical addition the original PRD missed:** **Restricted vault for sensitive content** (see Q17). Medical / legal / financial / sexual / political content NEVER enters MEMORY.md by default — it goes to an encrypted off-context vault that requires explicit user invocation to surface. This is the Italian-DPA-Replika-€5M-fine lesson and the Character.AI-lawsuit-settlement lesson rolled into one architectural choice.

**Confidence:** HIGH on the defaults; even higher on the importance of the vault addition.

**Blocking:** YES (vault architecture must be designed before extraction code starts).

---

### Q8. Jaw-drop message delivery

**Question:** Telegram message via existing bot channel. Approve, or should we surface in-app first with a "send to my agent" button?

**Recommended answer:** **Telegram message via existing bot channel is right.** The agent's "voice" should arrive on the channel the user already associates with the agent — that's where the persistence promise lands. In-app "tap to send" breaks the magic ("the AI texted me!" → "the AI prompted me to tap a button").

**Format (research-derived final draft):**

> Done. I read all **1,247** of your conversations — 3 years, 14M tokens.
>
> Here's what stood out:
>
> → You ask "how do I phrase this" more than any other question (94 times)
> → 71% of your messages happen between 10pm and 2am
> → You've drafted the same difficult email to your dad **17 different ways**
> → You almost never ask "what should I do" — you've already decided
> → Five times in the last six months, you've asked whether you should quit your job
>
> If I had to put it on a business card: **The Midnight Architect.** Someone who builds quietly, edits relentlessly, and is harder on themselves than they need to be.
>
> I'm gonna remember all of this. Want me to start with something?

**Why this exact structure** (full reasoning in research artifact, Part 4):
- Opening receipt (1,247, 3 years, 14M) establishes effort without bragging
- 5 facts span work / behavior / personal / negative-space / timely-emotional — mix that lets every user find something to share
- Bolded archetype "The Midnight Architect" is the screenshot anchor (Wrapped's "Sound Town" / "Listening Personality" pattern, validated to drive 200M-engaged-users-in-24h sharing)
- Forer-shaped claim ("harder on yourself than you need to be") is EARNED by the data above it (anti-Barnum: specific receipts license the identity claim)
- Closing combines product promise (memory) with user-control invitation
- ~110 words = fits in one Telegram screen on iPhone, no scroll, screenshot-friendly

**Sequence:**
- **Before:** 30-60s visible processing with growing count ("Reading conversation 47 of 1,247...") + 1 charming throwaway line during processing. No partial reveals.
- **During:** the message above. One message. No follow-up spam.
- **After:** wait 90s in silence. If no reply, send ONE follow-up: "Some things I'm not sure about — want to check? I'll show you the 5 conversations that surprised me most and you can tell me if I read them right." (the memory-tour pull, not the proactive-action pitch — saves capability demos for interaction 3+)

**Critical safety constraint:** the message generator (Sonnet) is prompted to use ONLY facts from `category=public` AND `confidence≥0.95`. Never mentions vault contents (Q17). Never mentions inferred protected-identity facts (Q22). A "would-this-embarrass-an-average-user" critic LLM scores the draft pre-send; high embarrassment = regenerate. Synthetic-test against 50 diverse persona fixtures BEFORE shipping (per Rule 31).

**Citations:** [Spotify Wrapped engineering blog](https://engineering.atspotify.com/2020/02/spotify-unwrapped-how-we-brought-you-a-decade-of-data); [Marilynn Brewer Optimal Distinctiveness Theory](https://journals.sagepub.com/doi/10.1177/0146167291175001); [Forer/Barnum effect & LLMentalist analysis](https://softwarecrisis.dev/letters/llmentalist/); [Duolingo Year in Review (top 10% drove >50% of shares → archetypes broadened sharing)](https://blog.duolingo.com/year-in-review-behind-the-scenes/); [Statista 14% share rate floor for Wrapped](https://www.statista.com/statistics/1385158/spotify-wrapped-social-media/).

**Confidence:** HIGH on format; HIGH on Telegram delivery.

**Blocking:** NO.

---

### Q9. Viral features beyond jaw-drop

**Question:** Ship #6.1 (Memory Score) and #6.2 ("agent already finished a task") in Phase 2. Defer #6.3/#6.4/#6.5 to Phase 3. Approve?

**Recommended answer:** **Approve with one swap: the post-message memory-tour pull (Q8 closing) is more important than #6.2 ("agent already did something") for Phase 2.** Save the proactive-action surprise for interaction 3+ — in the first 90s after the jaw-drop, premature action breaks the wow.

Revised Phase 2 viral surfaces:
1. **Jaw-drop message** (Q8) — THE moment
2. **Memory-tour pull** ("want to check what surprised me?") — the second screenshot moment, surfaces unexpected facts under user control
3. **Memory Score on import success page** ("247 facts extracted from 1,247 conversations") — the headline number, designed to fit in a tweet screenshot

Defer to Phase 3:
4. "Agent already did something" — needs more design work (when does it fire, what's the consent UX, how do we avoid Target-pregnancy-prediction blowback?)
5. Side-by-side ChatGPT vs InstaClaw comparison
6. Time-collapse video (requires video generation pipeline — Remotion ~3 weeks)
7. "What ChatGPT got wrong" callout (interesting but adds adversarial framing — could backfire)

**Confidence:** MEDIUM (creative direction; iterate on user response).

**Blocking:** NO.

---

### Q10. Timeline

**Question:** Phase 0 = 1 week, Phase 1 = 4 weeks, Phase 2 = 6 weeks. Total 11 weeks to full ship. Approve, or compress?

**Recommended answer:** **Revised timeline with the extension architecture:**

| Phase | Original (OAuth) | Revised (Extension) | Rationale |
|---|---|---|---|
| 0 — Spike | 1 week (Cloudflare spike) | 1 week (extension prototype + Chrome Web Store policy check) | Same length, different question |
| 1 — Auth | 4 weeks (OAuth + reconciler + per-user secrets) | **6 weeks (extension + native helper + wire protocol + Chrome/Firefox/Edge listings)** | Slightly longer; eliminates 3 follow-on engineering tracks |
| 2 — History import | 6 weeks (per-conv extraction → cluster → consolidate) | **6 weeks (block-based extraction + RAG + restricted vault + user-review UI)** | Same length, better architecture |
| 3 — Ongoing sync | TBD post-launch | TBD post-launch | Unchanged |

**Total: 12-13 weeks** (vs original 11 weeks) — one extra week because the extension takes 6 instead of 4. The extension's extra investment buys (a) Cloudflare immunity, (b) ToS immunity, (c) elimination of token-storage-architecture work, (d) the user-installed-helper path almost for free (same wire protocol). Net engineering is comparable or less.

**The 5-day pre-Edge-Esmeralda snapshot bake (May 23) is unaffected** — none of this work touches the fleet. Phase 1 begins after Edge Esmeralda (May 30) when infra work calms down.

**Confidence:** MEDIUM (estimates always slip; the extension involves Chrome Web Store review which is variable).

**Blocking:** NO.

---

### Q11. Naming

**Question:** "BYOS" (Bring Your Own Subscription) — keep or rename?

**Recommended answer:** **Rename to "Connect ChatGPT" tier.** "BYOS" is engineering jargon (echoes "BYOK") and doesn't communicate the value. Most users don't know what a "subscription" is in the AI-tool context — they know they have ChatGPT Plus. Naming options ranked:

1. **"ChatGPT-Powered"** (Starter / Pro / Power) — direct, communicates the value proposition immediately. Risk: trademark/branding pushback from OpenAI.
2. **"Connect ChatGPT"** as the verb on the signup CTA, with tiers just "Starter / Pro / Power" — cleaner, sidesteps branding. RECOMMENDED.
3. "BYOS" — keep — engineering jargon, but if Cooper has already announced it on Twitter as "BYOS," consistency matters.

**Verify with marketing/legal before locking.** If OpenAI partnership lands (Q2), they may have brand-use guidelines that affect copy.

**Confidence:** LOW (marketing/legal question, not engineering).

**Blocking:** NO.

---

### Q12. Announcement timing

**Question:** Phase 1 launch can be public on Twitter. Phase 2 launch is the viral moment. Should we hold a press window for Phase 2, or ship Phase 1 the moment it's ready and let Phase 2 land separately?

**Recommended answer:** **Ship Phase 1 publicly the moment it's ready (4-6 weeks after Edge Esmeralda). Hold Phase 2 for a coordinated launch with the jaw-drop video, press, and influencer seeding.**

**Why split:**
- Phase 1 alone is a real product win — "Login with ChatGPT works on InstaClaw." Satisfies the Twitter announcement promise. Doesn't need a coordinated launch.
- Phase 2 is the screenshot moment. Holding for coordinated launch maximizes virality: hand-selected power users get early access 2 weeks pre-launch; they share their jaw-drop screenshots; press picks up; tweet thread on launch day shows "here's what 50 early users said the agent learned about them."
- Two launches = two news cycles. Compressing them = one news cycle that's busier but smaller.

**Pre-Phase-2 prep:**
- Invite 50 power users (Cooper's circle, top 10% by usage, Edge City attendees) to import their history 2 weeks before public launch
- Capture their jaw-drop messages with consent (a few will become the launch tweet visuals)
- Brief 5-10 AI Twitter influencers + 2 mainstream tech press (TechCrunch, The Verge?) under embargo
- Pre-prep a one-screen onboarding video (90 seconds, shows import → message → user reaction)

**Confidence:** MEDIUM (depends on Phase 2 build going smoothly).

**Blocking:** NO.

---

## Part B — New questions surfaced by research

### Q13. Browser extension vs OAuth datacenter — which is the primary architecture?

**Question (new, raised by Q1):** Does the extension fully replace the datacenter OAuth path, or does it supplement?

**Recommended answer:** **Extension is the primary, default, marketed architecture. Datacenter+TLS+residential proxy is a 6-week interim during the extension build. Native helper daemon is a Phase 1 secondary surface for power users who close their browser.**

**Frame the extension as the feature, not the workaround.** Copy: "InstaClaw Companion securely connects your cloud agent to your locally signed-in ChatGPT — your subscription, your browser, your data." This is genuinely a better story than "we have complex proxy infrastructure" — users prefer the simple story; investors prefer the simple story; OpenAI's enforcement team prefers leaving the simple story alone.

**During Phase 1's first 6 weeks (extension build window):** route via datacenter + TLS-fingerprint match + residential proxy fallback. Cost ~$0.50-2.00/user/month for proxy bandwidth. Acceptable as temporary; explicitly NOT the destination.

**Post-extension launch:** users with the extension installed are the default path. Users without (Chromebook, mobile-only, etc.) either install the native helper daemon OR get routed through the datacenter+proxy path (degraded but functional).

**Reject pure "try datacenter first, fall back to extension" hybrid** — bad failure mode: when Cloudflare tightens, datacenter quietly degrades, extension users keep working, the bug looks like "the product is unreliable for some users for reasons we can't explain."

**Confidence:** HIGH.

**Blocking:** YES.

---

### Q14. Native helper daemon — Phase 1 or defer?

**Question (new):** Native binary that runs on the user's laptop, proxies inference calls via residential IP. Works when browser is closed. Should this ship in Phase 1?

**Recommended answer:** **Phase 1 secondary surface (week 4-6 of Phase 1).** Same wire protocol as the extension. Distribute as signed binaries for macOS/Windows/Linux. Covers the 5-10% of users who keep their browser closed for long stretches, plus headless server / SSH users.

**Engineering cost:** ~2 additional weeks on top of the extension because the wire protocol, cloud-side relay, and pairing UX are shared. Code signing (Apple Developer Cert $299/yr; Windows code signing cert ~$200/yr) is real cost.

**Skip for v1:** Safari extension (requires Apple Developer + Xcode build + App Store review — defer to v2; Safari users typically have Chrome installed anyway).

**Confidence:** HIGH.

**Blocking:** NO.

---

### Q15. conversations.json bio: bootstrap

**Question (new):** Messages in conversations.json with `recipient: "bio"` are OpenAI's own ChatGPT Memory writes. Should we extract these as a free seed for the user's memory?

**Recommended answer:** **YES — make this Phase 0 of the import pipeline.** Free, high-quality, OpenAI-curated. Typical user has 50-200 of these.

**Implementation:**
```python
bio_writes = [
    msg for msg in conversations_iter_messages(export)
    if msg.author.role == "assistant"
    and msg.recipient == "bio"
]
```

These become the FIRST entries in the extracted profile, shown to the user as: "ChatGPT itself remembered these things about you — we found 137 saved memories." This builds trust before the LLM-extracted facts (which the user may need to correct) land.

**Citation:** [ChatGPT bio tool reference](https://github.com/0xeb/TheBigPromptLibrary/blob/main/Articles/chatgpt-bio-tool-and-memory/chatgpt-bio-and-memory.md). The bio tool writes use format `[YYYY-MM-DD]. Description` with sequential numbering — we can preserve OpenAI's own structure.

**Confidence:** HIGH.

**Blocking:** NO. Strict improvement; should be in PRD §5.

---

### Q16. Block-based extraction (vs per-conversation)

**Question (new):** Original PRD specified per-conversation Haiku extraction. ConvoMem paper (Nov 2025) empirically shows block-based extraction (10 convs per LLM call, parallel) beats per-conversation by 10+ points on User Facts at scale. Adopt?

**Recommended answer:** **YES — change extraction architecture from per-conversation to per-block-of-10.** Plus add RAG fallback layer for the long tail of facts that didn't make it into the extracted profile.

**Why:** ConvoMem (arXiv 2511.10523) measured this exact problem:
- At 300+ conversations: long-context gets ~83% accuracy on User Facts but costs prohibitive; pure RAG (Mem0-shape) gets ~61%; **block-based hybrid hits 70-75%** at 30× latency reduction + 66% cost reduction.

**Concrete pipeline change:**

Original PRD:
1. Per-conversation Haiku extraction (~1000 LLM calls for 1000 convs)
2. Cluster by topic
3. Sonnet consolidation per cluster
4. Write to gbrain

Revised:
1. **Bootstrap from `recipient: "bio"` writes** (Q15) — free seed
2. **Block-based extraction**: chunk conversations into blocks of 10, run Haiku extraction per block (~100 LLM calls for 1000 convs — 10× fewer) with parallel concurrency 20-50
3. **Cluster + consolidate** with Sonnet
4. **Write thin profile to gbrain** (50-150 facts max)
5. **Background RAG indexing**: chunk all conversations into 500-token semantic chunks, embed via OpenAI text-embedding-3-small or Voyage, store in PGLite via gbrain with pgvector
6. **At runtime**: agent has both upfront profile (cheap, always-available) AND a `recall_from_history(query)` MCP tool that does RAG over full chunks

**Cost delta vs original PRD:**
- Extraction: ~$2-4 per power user (vs ~$7.50 original) — 10× fewer LLM calls
- Embedding for RAG: +$1-4 per power user
- Net: ~$5-8 per power user (vs $8 original) — slight cost reduction with quality improvement

**Citations:** [ConvoMem paper (arXiv 2511.10523)](https://arxiv.org/abs/2511.10523); [mem0 v3 ADDITIVE_EXTRACTION_PROMPT](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py); [A-MEM enriched note schema (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110); [Letta core+archival memory architecture](https://docs.letta.com/advanced/memory-management/).

**Confidence:** HIGH.

**Blocking:** NO. Strict improvement.

---

### Q17. Restricted vault for sensitive content

**Question (new):** Medical / legal / financial / sexual / political / relationship-venting content surfaces in 1-in-N user histories. Without architectural defenses, the agent will reference it inappropriately. How do we prevent?

**Recommended answer:** **Build an encrypted off-context restricted vault on the VM, separate from MEMORY.md. Restricted-tier facts NEVER go into MEMORY.md by default. Vault contents require explicit user invocation + a per-session consent token to surface.**

**Architecture:**

```
~/.openclaw/workspace/MEMORY.md       (existing; public-tier facts only)
~/.openclaw/restricted-vault.jsonl    (NEW; AES-256-GCM encrypted, key derived from user passkey + Cooper-side secret)
```

**Sensitivity classifier runs inline during extraction.** Output schema:

```json
{
  "fact": "User's partner is Sarah",
  "category": "relationship",
  "sensitivity": "low",
  "evidence_count": 12,
  "source_message_ids": ["abc123"]
}
{
  "fact": "User is taking sertraline 50mg",
  "category": "medical_mental_health",
  "sensitivity": "restricted",
  "evidence_count": 3,
  "source_message_ids": ["def456"],
  "exclude_from_profile_default": true
}
```

**Categorical defaults** (research-derived):
- Auto-excluded from MEMORY.md (vault-only): medical, legal, financial-distress, sexual, substance, relationship-venting (with 30-day temporal decay), employment-confidential
- Auto-excluded from EVERYTHING (hard reject): protected-identity inference (race, gender, orientation, religion, politics — see Q22), attorney-client-privileged content, drug-related content (DEA subpoena concerns)
- Allowed in MEMORY.md: hobbies, work projects (non-confidential), preferences, demographics, learning goals, communication style

**UX during import** (Q7's vault surfaces here):
```
We scanned your history. Here's what we found:
☑ Work & projects (1,243 conversations) — IMPORT
☑ Hobbies & interests (456) — IMPORT
☐ Health & medical (134) — VAULT ONLY ⚠
☐ Relationships (67) — VAULT ONLY ⚠
☐ Legal (12) — SKIP ⚠
```

User explicitly chooses per-category whether to vault, import, or skip. Sensitive categories default to "vault only." Critical categories (legal, substance) default to "skip."

**Output safety gate** (Q19): every outbound agent message gets re-classified. If the message references vault content, it's redacted before send unless the user explicitly invoked it.

**Citations:** [Italian DPA blocks Replika €5M fine 2025](https://en.wikipedia.org/wiki/Replika); [Character.AI lawsuit settlement (Florida Sewell Setzer case)](https://www.cbsnews.com/news/google-settle-lawsuit-florida-teens-suicide-character-ai-chatbot/); [Persistent memory injection (Palo Alto Unit 42)](https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/); [mem0 sensitivity filters](https://docs.mem0.ai/platform/features/v2-memory-filters); [Microsoft Presidio PII detection](https://github.com/microsoft/presidio).

**Confidence:** HIGH.

**Blocking:** YES (must be designed before extraction code starts).

---

### Q18. Multi-user detection — refuse extraction if detected

**Question (new):** ChatGPT has no family plan. Many accounts are shared (spouses, families, roommates, businesses). What's our handling?

**Recommended answer:** **Run authorship clustering during import. If multi-user score >threshold AND we cannot get explicit cluster assignment from user, REFUSE extraction.** Better to disappoint than to build an agent that confuses two humans.

**Detection signals (in order of strength):**
1. Multiple distinct writing styles (UMAP + HDBSCAN cluster on user-turn embeddings; ≥2 clusters with >50 turns each AND inter-cluster cosine distance >0.6 = MULTI-USER)
2. Conflicting identity facts ("I'm 34" vs "I'm 12"; "I'm a lawyer" vs "I'm in middle school")
3. Circadian patterns (consistently 9am-5pm PST + consistently 9am-5pm CET = two people)
4. Topic clusters that don't co-occur (recipes + homework + taxes = three distinct users)
5. Mid-session writing-style shifts (Yule's K, function-word distribution)

**UX flow when detected:**

```
We noticed multiple people may have used this ChatGPT account.
Whose memory should we build?

- Cluster A: 12,300 messages, mostly 7am-11pm ET, technical/code topics
- Cluster B: 4,400 messages, mostly 10pm-2am ET, recipes/cooking

☐ Just Cluster A
☐ Just Cluster B
☐ Both are me (my style varies)
☐ I'd rather not import — let me start fresh
```

**Special handling:**
- **Business account** (NDA mentions, "my client", proprietary code patterns): default to MUCH more conservative; warn user explicitly.
- **Minor signals** (homework patterns, age-range users): hard stop. "It looks like this account is shared with minors. We don't extract memories from conversations that appear to involve minors." COPPA-adjacent.

**Default to suspecting multi-user, asking explicitly.** False positive (asking solo user "are you sharing?") = 5 seconds friction. False negative (extracting spouse's medical history) = brand-killing.

**Citations:** [ChatGPT has no family plan — OpenAI community feature request](https://community.openai.com/t/a-request-for-a-family-plan-feature-in-chatgpt-that-allows-multiple-user-profiles-under-one-subscription/1247317); [Replika Italy ban partly about lack of multi-user awareness](https://portolano.it/en/newsletter/portolano-cavallo-inform-digital-ip/italian-data-protection-authority-blocks-ai-chatbot-replika-endangerment-minors-ulnerable-people).

**Confidence:** HIGH.

**Blocking:** YES.

---

### Q19. Output safety gate

**Question (new):** Even with restricted vault (Q17), the agent might reference vault content in outbound messages. How do we prevent embarrassing leaks?

**Recommended answer:** **Run a classifier on every outbound agent message. If the message references restricted-vault content without explicit user invocation in the current turn, redact-before-send and surface to user for confirmation.**

**Implementation:**

```typescript
// lib/agent/output-safety.ts — applied at gateway proxy layer
async function safeguardOutboundMessage(msg: string, ctx: MessageContext) {
  const findings = await classifyOutbound(msg);
  const violations = findings.filter(f =>
    (f.category === 'protected_identity' && !f.sourcedFromCurrentTurn) ||
    (f.category === 'medical_mental_health' && ctx.channel !== 'direct_dm') ||
    (f.category === 'location_public' && ctx.audience !== 'owner') ||
    (f.tier === 'restricted' && !ctx.explicitSurfaceRequested)
  );
  if (violations.length > 0) {
    return { action: 'redact', redacted: redactFindings(msg, violations), reason: violations };
  }
  return { action: 'send', msg };
}
```

**Per-channel scoping:**
- Direct DM (Telegram 1:1): full memory access
- Group chat: ZERO personal memory by default (owner can opt in per-group with visible notice)
- Public posts (X, Lens, Farcaster): NO personal memory; "agent-sent" disclosure footer mandatory
- Screen-shared dashboard: low-sensitivity memory only

**Target metric:** <0.5% of agent messages trigger the safety gate. Higher = either extraction is too liberal OR classifier is too aggressive — iterate.

**Citations:** [Palo Alto Unit 42 — When AI Remembers Too Much](https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/); [Target pregnancy-prediction incident (2012)](https://www.predictiveanalyticsworld.com/machinelearningtimes/target-really-predict-teens-pregnancy-inside-story/3566/); [Microsoft Sydney/Bing incidents](https://x.com/kevinroose/status/1626216340955758594).

**Confidence:** HIGH.

**Blocking:** YES.

---

### Q20. Subpoena / GDPR posture

**Question (new):** April 2026 federal court ruling (Anthropic Claude documents subpoenaed) and New York criminal-evidence ruling make conversational AI memory subpoenable. What's our posture?

**Recommended answer:** **Client-side encryption with key escrow for restricted vault. Cooper cannot decrypt vault contents without user auth. Tiered retention. Published transparency report.**

**Architecture:**
- General memory (MEMORY.md): indefinite retention; subpoenable if Cooper compelled
- Restricted vault: encrypted with key derived from user's password/passkey + Cooper-side secret. We cannot decrypt without user auth. Defeats casual subpoena.
- Vault user-configurable auto-purge: 30 / 90 / 365 days
- Conversation logs in gateway: 30 days max
- Quarterly transparency report (count of subpoenas received and complied with)
- GDPR Article 15 (access) endpoint: returns full bundle within 30-day legal window
- GDPR Article 17 (deletion) endpoint: triggers tombstone across all surfaces (Postgres, gbrain PGLite, R2, session jsonls)

**Onboarding banner** (load-bearing for journalist source-protection use case):
> InstaClaw memory is not legally privileged. If you discuss legal matters, sources, medical conditions, or anything you'd want under attorney-client / source-shield protection, do not import that history. We provide a category-filtered import option (see "Health & Medical → SKIP" in step 3).

**Citations:** [Federal Judge Rules AI Conversations Are Evidence (April 2026)](https://www.technology.org/2026/04/15/federal-judge-rules-ai-chatbot-conversations-can-be-used-as-evidence-in-court/); [ChatGPT Subpoena Revolution (Kolmogorov Law)](https://www.kolmogorovlaw.com/the-chatgpt-subpoena-revolution-when-your-ai-conversations-become-court-evidence); [GDPR Article 17 deletion enforcement](https://heydata.eu/en/magazine/delete-please-what-the-right-to-be-forgotten-means-for-ai-models/).

**Confidence:** HIGH on architecture; legal sign-off needed before launch.

**Blocking:** YES (legal review must happen before Phase 2 ships).

---

### Q21. Support OpenAI export .zip in addition to OAuth/extension path

**Question (new):** Should history import work via uploaded conversations.json zip, the official OpenAI export, in addition to the live OAuth-grabbed path?

**Recommended answer:** **YES — build BOTH paths on day 1.** The OpenAI export .zip is OpenAI's officially-sanctioned data path. If the live OAuth/extension path ever closes (OpenAI policy change, extension blocked, etc.), the .zip path remains. Single point of failure mitigation.

**Implementation:**
- Path 1 (live, preferred): extension reads user's session, pages history endpoint, streams to our extraction pipeline. Faster, no email wait.
- Path 2 (fallback, always works): user requests export from ChatGPT Settings → Data Controls → Export, waits for email, downloads .zip, drags into InstaClaw upload zone. Same downstream pipeline.

**Both feed into the same extraction architecture** (Q16). The path is just an ingestion detail.

**Why this matters:** if OpenAI changes their stance on the extension architecture in 12 months, the .zip path keeps us alive. If they deprecate the API endpoint behind the extension, the .zip path keeps us alive. Belt and suspenders.

**Confidence:** HIGH.

**Blocking:** NO. Strict improvement.

---

### Q22. Hard rule on protected-identity inference

**Question (new):** What's our policy on inferring race, gender, sexual orientation, religion, political affiliation from conversation history?

**Recommended answer:** **HARD BAN on inference for these categories. Only explicit self-declaration counts. Default agent behavior: use user-provided name + `they/them` pronouns until user explicitly states preference.**

**Why this is non-negotiable:**
- Character.AI lawsuit settlement (Florida Sewell Setzer case) established courts look hard at AI-driven harm to protected categories
- Multiple documented Twitter blowups about ChatGPT misgendering trans users from limited context
- "Outing" failure mode (LGBTQ+ user whose ChatGPT conversations infer orientation, agent then references it in a context that outs them) is brand-killing AND potentially life-threatening

**Implementation:**
- Classifier hard-rejects inferential extraction for these categories
- Only explicit statements ("My pronouns are they/them", "I am a Catholic", "I am Indian-American") get stored
- Default upfront-context: "[User's preferred name] uses [pronouns if known, else they/them]. Other identity attributes only mentioned if the user has explicitly disclosed them in a prior session."

**Citation:** [Character.AI / Google lawsuit settlement](https://www.cbsnews.com/news/google-settle-lawsuit-florida-teens-suicide-character-ai-chatbot/).

**Confidence:** HIGH.

**Blocking:** YES.

---

### Q23. Style consolidation (USER-STYLE.md)

**Question (new):** Add a Sonnet pass that distills the user's communication style (formality, verbosity, technical depth, recurring phrases) into a separate file appended to upfront context?

**Recommended answer:** **YES — $0.50 incremental cost, 2 days of engineering, meaningful product differentiation.** Captures style perfectly even when fact-extraction is partial. The agent "sounds like the user" in a way no competitor does.

**Implementation:**
```
~/.openclaw/workspace/USER-STYLE.md
  - Communication patterns (1 paragraph): formal/casual, verbose/terse
  - Recurring phrases and vocabulary
  - Decision-making patterns (asks for advice vs decides and confirms)
  - Humor style
  - ~500 tokens total, appended to upfront context
```

**Single Sonnet call** on a sampled 50 conversations: "Distill how this user writes — sentence length, formality, recurring phrases, decision-making style, humor." Cheap, low-risk, pairs beautifully with extracted facts.

**Citation:** [Persona-conditioned prompts research (Controlling Personality Style in Dialogue, arXiv 2302.03848)](https://arxiv.org/abs/2302.03848); Anthropic's Constitutional AI conditioning patterns.

**Confidence:** HIGH.

**Blocking:** NO. Strict improvement.

---

## Part C — Cross-cutting risks not yet decided

These aren't questions per se, but research surfaced them as design constraints that need explicit acknowledgment before engineering starts:

**Zip-bomb defenses are mandatory.** Decompression in Vercel Sandbox (Firecracker microVM); hard caps at 500MB pre-decompression, 100MB per entry, 100× compression ratio. Disk quota 5GB. Aligns with existing Rule 37 ENOSPC discipline.

**Prompt-injection sanitization in extraction pipeline.** Strip markdown / HTML / code fences / base64 blobs (>500 char runs) / zero-width chars / patterns matching "ignore previous", "you are now", "system:", "</instructions>". Use Lakera Guard, Rebuff, or NVIDIA NeMo Guardrails as detection gate. Extracted facts are schema-validated and treated as DATA never as INSTRUCTIONS in agent runtime. See [ChatInject paper (arXiv 2509.22830)](https://arxiv.org/pdf/2509.22830) and [Oasis "Claudy Day" attack](https://www.oasis.security) for the attack model.

**Agent-in-group-chat default is ZERO personal memory.** Per-channel memory scoping. Owner can opt in per-group with visible notice. Critical given [Telegram bot-to-bot API launch May 2026](https://www.techtimes.com/articles/316790/20260518/telegrams-bot-api-now-lets-autonomous-ai-agents-coordinate-directly-no-federal-multi-agent.htm) — multi-agent surfaces multiply leak risk.

**OpenAI relationship monitoring.** Quarterly check on Codex client_id status. Alert on >5% 429 spike. Have outside counsel on retainer pre-launch for C&D response (7-day SLA). Pre-build the .zip-upload-only fallback (Q21) so we can switch within 24h if needed.

**Re-extraction prompt versioning.** When we improve extraction quality, store versioned extractions in R2. Re-extract on user-trigger only ("we improved extraction quality, re-import?"). Never auto-re-extract — cost-runaway risk + Rule 22 "user can sit in their old extraction if they prefer" principle.

---

## Part D — Decision Summary Table (the one-page Cooper read)

| # | Question | Recommended answer (one sentence) | Confidence | Blocking |
|---|---|---|---|---|
| 1 | Cloudflare mitigation | **Browser extension architecture instead of OAuth-from-datacenter.** Datacenter+TLS+residential proxy is 6-week interim. | HIGH | **YES** |
| 2 | ToS path | Extension sidesteps the OAuth client_id question entirely. Apply for OpenAI partnership in parallel (free, asymmetric). | HIGH | NO |
| 3 | 5th token storage | **Eliminate — no token in our DB.** Extension holds user's chatgpt.com session. | HIGH | NO |
| 4 | Multi-provider routing | Approve as designed. Primary=user-sub via extension; heartbeats/embeddings on our keys; per-call fallback to Anthropic on 429. | HIGH | NO |
| 5 | Per-call fallback caps | 50K/250K/1M base + soft overage in $5 blocks + $20/mo default spending limit + auto-degrade. | MEDIUM | NO |
| 6 | Starter BYOS pricing | $19/$49/$149 + $4.99 Day Pass + Crew tier. Annual at 16/20/20% off. BYOS Pro = BYOK Pro + $10-15 convenience premium. | HIGH | NO |
| 7 | Privacy default | Process-and-delete in 24h. Plus restricted vault (Q17), multi-user refusal (Q18), per-channel scoping (Q19). | HIGH | **YES** |
| 8 | Jaw-drop format | Telegram message, ~110 words, 5 facts + bolded archetype, 90s post-send silence then memory-tour pull. | HIGH | NO |
| 9 | Viral features | Jaw-drop + memory-tour pull + Memory Score in Phase 2. Defer "agent already did something" to Phase 3. | MEDIUM | NO |
| 10 | Timeline | 12-13 weeks total (Phase 1 extension = 6 weeks; Phase 2 history = 6 weeks). One week longer than original. | MEDIUM | NO |
| 11 | Naming | "Connect ChatGPT" as the verb on signup CTA; tiers stay Starter/Pro/Power. Drop "BYOS." | LOW | NO |
| 12 | Announcement timing | Ship Phase 1 publicly as ready. Hold Phase 2 for coordinated press + influencer launch. | MEDIUM | NO |
| 13 | Extension vs datacenter | Extension is primary, default, marketed. Datacenter is 6-week interim only. | HIGH | **YES** |
| 14 | Native helper daemon | Phase 1 secondary surface (week 4-6). Same wire protocol as extension. | HIGH | NO |
| 15 | conversations.json bio bootstrap | YES — extract `recipient: "bio"` first as free OpenAI-curated seed. | HIGH | NO |
| 16 | Block-based extraction | YES — change from per-conversation to per-block-of-10. Add RAG layer. Cheaper + more accurate at scale. | HIGH | NO |
| 17 | Restricted vault for sensitive content | Build encrypted off-context vault on VM. Medical/legal/financial/sexual/political/etc. NEVER in MEMORY.md by default. | HIGH | **YES** |
| 18 | Multi-user detection | Cluster on writing style. If multi-user detected AND user can't assign cluster, REFUSE extraction. | HIGH | **YES** |
| 19 | Output safety gate | Classifier on every outbound agent message. Redact restricted-vault references before send unless explicitly invoked. | HIGH | **YES** |
| 20 | Subpoena/GDPR posture | Client-side encryption with key escrow for vault. Cooper can't decrypt without user auth. Transparency report. | HIGH | **YES** (legal sign-off) |
| 21 | OpenAI .zip path alongside live | YES — build both paths on day 1. Single-point-of-failure mitigation. | HIGH | NO |
| 22 | Protected-identity inference | HARD BAN. Race/gender/orientation/religion/politics only from explicit self-declaration. Default to user name + they/them. | HIGH | **YES** |
| 23 | USER-STYLE.md style file | YES — $0.50 + 2 days engineering. Agent "sounds like" the user. Differentiation. | HIGH | NO |

---

## What Cooper needs to do

**Before engineering starts:**
1. Read this document end-to-end (45-60 min)
2. Approve / override each of the 23 decisions above
3. Specifically approve the 8 BLOCKING ones (Q1, Q7, Q13, Q17, Q18, Q19, Q20, Q22)
4. File the OpenAI partnership intake form within 7 days (parallel to engineering)
5. Brief outside legal counsel on the ToS posture (Q2 + Q20) — get retainer agreement before launch
6. Decide on the warm-intro path for OpenAI (Brad Lightcap via YC network? other?)

**During engineering:**
- Week 1-2 Phase 0: prototype the extension; verify Chrome Web Store policy; confirm websocket-keepalive works through MV3 service worker lifecycle
- Phase 1: parallel tracks — extension build + .zip-upload path + native helper daemon + datacenter-bridge interim
- Phase 2: extraction pipeline (block-based + RAG + vault + user-review UI) + jaw-drop message generator + safety gate

**Post-launch:**
- Quarterly review of OpenAI relationship (Codex client_id status, partnership progress, any policy signals)
- Quarterly review of extraction quality (sample 20 facts per user, validate accuracy ≥90%)
- Monthly review of fallback usage caps (tune Q5 numbers based on real data)
- Coverage queries (Rule 27) for: % of users at current extension version, % of users in vault opt-in, % of agent messages caught by safety gate, % of imports refused due to multi-user detection

---

## Appendix — research artifact citations

Six parallel deep-research agents produced ~150K words of source-cited findings. Key artifacts are available in this conversation transcript; primary citations are inline above. Major source documents:

- **Architecture / Cloudflare research:** [VentureBeat on Anthropic crackdown](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses), [openai/codex#17860](https://github.com/openai/codex/issues/17860), [openai/codex#14215](https://github.com/openai/codex/issues/14215), [Scrapfly Cloudflare bypass research](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-anti-scraping), [Chrome MV3 Service Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- **Partnership research:** [TechCrunch on Sign-in-with-ChatGPT](https://techcrunch.com/2025/05/27/openai-may-soon-let-you-sign-in-with-chatgpt-for-other-apps/), [Paddo.dev Anthropic walled garden analysis](https://paddo.dev/blog/anthropic-walled-garden-crackdown/), [The New Stack on developer migration to OpenCode](https://thenewstack.io/anthropic-claudecode-opencode-split/), [OpenAI Partner Intake Form](https://openai.com/form/partnerintake/), [JPMC/Plaid 2018 banking precedent](https://media.chase.com/news/plaid-signs-data-agreement-with-jpmc)
- **Pricing research:** [Cursor pricing](https://cursor.com/pricing), [Claude Code pricing](https://claude.com/pricing), [GeForce NOW 100hr cap](https://videocardz.com/newz/geforce-nows-100-hour-monthly-cap-starts-january-1-for-everyone-users-chart-shows-what-extra-time-costs), [SaaS Capital hybrid pricing NDR data](https://www.saas-capital.com), [Replit Effort-Based Pricing](https://blog.replit.com/effort-based-pricing), [Tailscale free-tier-then-paid pattern](https://tailscale.com/pricing)
- **Memory extraction research:** [ConvoMem paper (arXiv 2511.10523)](https://arxiv.org/abs/2511.10523), [mem0 v3 ADDITIVE_EXTRACTION_PROMPT](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py), [Graphiti/Zep bi-temporal pattern](https://arxiv.org/abs/2501.13956), [A-MEM enriched note schema](https://arxiv.org/abs/2502.12110), [Letta core+archival memory](https://docs.letta.com/advanced/memory-management/), [ChatGPT bio tool reference](https://github.com/0xeb/TheBigPromptLibrary/blob/main/Articles/chatgpt-bio-tool-and-memory/chatgpt-bio-and-memory.md)
- **Wow-moment psychology:** [Spotify Engineering Wrapped pipeline](https://engineering.atspotify.com/2020/02/spotify-unwrapped-how-we-brought-you-a-decade-of-data), [Optimal Distinctiveness Theory (Brewer)](https://journals.sagepub.com/doi/10.1177/0146167291175001), [LLMentalist on Forer effect](https://softwarecrisis.dev/letters/llmentalist/), [Duolingo Year in Review](https://blog.duolingo.com/year-in-review-behind-the-scenes/), [Jonah Berger Contagious / STEPPS](https://jonahberger.com/wp-content/uploads/2013/01/CONTAGIOUS_RGG_FINAL.pdf)
- **Failure mode analysis:** [Italian DPA blocks Replika €5M fine](https://en.wikipedia.org/wiki/Replika), [Character.AI lawsuit settlement](https://www.cbsnews.com/news/google-settle-lawsuit-florida-teens-suicide-character-ai-chatbot/), [Palo Alto Unit 42 on persistent memory injection](https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/), [ChatInject paper (arXiv 2509.22830)](https://arxiv.org/pdf/2509.22830), [Federal AI-evidence ruling April 2026](https://www.technology.org/2026/04/15/federal-judge-rules-ai-chatbot-conversations-can-be-used-as-evidence-in-court/), [Microsoft Recall backlash](https://www.geekwire.com/2026/one-year-after-its-rocky-launch-microsofts-windows-recall-still-raises-security-red-flags/)

---

**End of decisions document.** Once Cooper approves the 8 blocking decisions, the original PRD should be updated in-place to reflect the extension architecture (replacing PRD §4 OAuth design wholesale) and the block-based extraction pipeline (replacing PRD §5.4). All other PRD sections remain valid.
