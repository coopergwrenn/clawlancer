# Viral Copy Playbook — InstaClaw / @coopwrenn

## §0. ACTIVATION (read this first)

This playbook **activates** via three keyword triggers. When any
terminal — reconciler, changelog, ops, edge, this one, any other —
sees Cooper type:

- `/viral`
- `/launch`
- `/post`

…that terminal MUST immediately enter **copy mode**. Copy mode is a
mandatory protocol with the following steps:

### §0.1 The activation protocol

**Step 1: Read this entire playbook end-to-end.**
Not skim, not search-and-jump. Read all 15 sections cover to cover.
Voice-first guessing without reading the playbook is the failure mode
this protocol exists to prevent. *Approximate read time: 4-6 minutes
for an LLM.*

**Step 2: Load `§9. Receipts Library` into active context.**
Every claim in the post must map to a §9 entry (or be explicitly
flagged as aspirational/soon). If the receipt isn't in §9, either
add it (with verification) or don't make the claim.

**Step 3: Enter copy mode.**
From this point until Cooper says `/done` or switches topics, all
responses focus on maximum-conversion, maximum-virality copy via the
playbook framework. No casual chat. No tangents. No engineering
debugging unless it's directly related to the post.

**Step 4: Ask Cooper exactly three questions (in one message):**

```
You said /viral. Entering copy mode. Three questions:

1. WHAT are you posting about? (one sentence)
2. WHICH ACCOUNT: @coopwrenn (founder voice) or @instaclaws (agent voice)?
3. GOAL: launch / feature drop / hype build / engagement / reply / quote-tweet?
```

**Step 5: Generate 3-5 hook candidates BEFORE writing a full post.**
For each candidate:
- Write line 1 only (the hook).
- Score it on §3.1 three-question test (Q1/Q2/Q3 must all pass).
- Score it on §4.1 invention novelty (1-10) and §4.2 copy intensity
  (1-10). Both must be ≥6.
- Present the candidates as a numbered list with their scores.
- Recommend the strongest with a one-sentence rationale.

**Step 6: Wait for Cooper to pick a hook.**
Do not write a full post until Cooper picks (or modifies) a hook.

**Step 7: Write the full post using the picked hook + §11 template.**
Choose the post-type template that matches the goal. Apply the
weapons check (§4) and banned-phrase scan (§10) BEFORE presenting.

**Step 8: Present the final post + a "cut notes" section.**
The cut notes must list:
- Which candidate lines you tried and rejected (and why)
- Which banned phrases you avoided (and what you used instead)
- Which receipts from §9 you cited
- Any Mom-test trade-offs (CT-tribe ceiling vs mass ceiling)
- What you'd ALSO cut if Cooper wanted it tighter

**Step 9: Wait for Cooper's final-5% edit.**
Cooper makes the final taste call. Do not push back unless he asks
for an alternative. Then iterate on the same hook unless he picks a
different one.

**Step 10: Exit copy mode when Cooper says `/done`** or asks an
unrelated question. Confirm exit with: "exiting copy mode. saved
draft: [path]."

### §0.2 Why this protocol exists

Between 2026-05-13 and 2026-05-15, ~7 post drafts cycled through
workshopping with Cooper before one landed. Every failure had the
same root cause: voice-first iteration without the playbook's
weapons check, three-question test, or counter-positioning. This
protocol short-circuits that.

Expected iteration count with copy mode: **1-2**. Without copy mode:
**7+**. The 6-iteration delta is the value.

### §0.3 What copy mode is NOT

- It is NOT a permission slip to write generic AI-bro launch copy.
  The playbook's banned-phrase list (§10) still applies harder than
  ever in copy mode.
- It is NOT a license to hype. Confidence is in the receipts, not in
  the adjectives.
- It is NOT exclusive to @instaclaws posts. Founder-voice
  (@coopwrenn) posts also activate copy mode when Cooper triggers it.
- It is NOT permanent. Copy mode ends the moment Cooper exits or
  changes topics.

### §0.4 Cross-terminal discoverability

This playbook's activation system is referenced from `CLAUDE.md`
mandatory rules. Any terminal in this repo (reconciler, changelog,
ops, edge, debugging) that processes a Cooper message containing
`/viral`, `/launch`, or `/post` MUST follow the §0.1 protocol. Even
if the terminal's main job is reconciler work, copy requests pause
that and route through the playbook.

If a terminal sees a Cooper message starting with one of these
keywords and DOES NOT follow the protocol, that's a Rule 55
violation (see §14).

---

> **What this playbook is:** the operational system any terminal (or
> Cooper, or a future LLM call) reads BEFORE writing marketing copy,
> Twitter posts, launch announcements, or any public-facing
> communication for InstaClaw.
>
> **What this is not:** a style guide. The style guide
> (`docs/x-post-style-guide.md`) is the voice layer — lowercase,
> em-dashes, banned tokens. THIS document is the **strategy layer** —
> what to claim, why it travels, how to score it.
>
> **Why this exists:** between 2026-05-13 and 2026-05-15, ~7 post
> drafts cycled through workshopping with Cooper before one landed.
> The pattern of failure was always the same: voice-first guessing
> instead of bold-claim-first construction. This playbook fixes that.
>
> **Source methodology:** Matt Epstein
> ([@mattepstein](https://x.com/mattepstein)), distilled across 30
> launches (26 viral). Adapted for InstaClaw's CT/AI/crypto-native
> audience and Cooper's voice.
>
> **Last updated:** 2026-05-16. Append rather than rewrite.

---

## §1. The 95/5 Rule (foundational)

**95% of a post's success is positioning. 5% is voice.**

Every workshopping cycle that took >2 iterations on InstaClaw posts
this month failed because we worked voice-first. Voice questions ("is
this in Cooper's tone?") are useless if the post answers the wrong
question. Positioning questions ("what is the bold claim?") must come
first.

The order of operations for any post:

```
1. RESEARCH        — what does the market already say/feel?
2. POSITIONING     — what is our bold claim that nobody else can make?
3. HOOK            — does line 1 answer the three questions?
4. BODY            — does every line make the claim feel REAL?
5. WEAPONS CHECK   — does every line pass novelty + intensity?
6. FILLER KILL     — if any company could say it, cut it.
7. MOM TEST        — adapted for CT-tribe; does the hook parse?
8. VOICE           — finally, does it sound like Cooper?
9. FINAL 5%        — human editor passes
```

**If steps 1-7 are skipped and only step 8 is done, the post fails.**
This is what happened in the May 13-15 workshop cycles.

---

## §2. The Bold Claim Methodology

### §2.1 What a bold claim is

A bold claim is a single sentence that, if true, would force a
reader to update their model of what AI agents are.

**Bold claim tests:**
1. Can a stranger repeat the claim verbatim after one read? (memorability)
2. Does the claim sound impossible until you read the receipt? (novelty)
3. Could *any other company* honestly say the same claim today? If
   yes, it's not bold enough. (uniqueness)
4. Does it counter-position against a thing the market already
   knows and dislikes? (relevance)

### §2.2 Bold claim vs. generic claim — examples

| Generic (will not travel) | Bold (will travel) |
|---|---|
| "the world's first AI ad maker" | "the world's first AI ad orchestrator that kills AI slop" |
| "AI agent platform" | "AI agents that own ethereum wallets and earn $ while you sleep" |
| "we save you time" | "your AI works the 8 hours you sleep" |
| "an AI that helps you" | "an AI that paid another AI on Base yesterday" |
| "powerful AI agents" | "AI agents that survive your subscription" |
| "AI for everyone" | "$29/month for an AI that earns more than that back" |

### §2.3 The research that precedes a bold claim

Before drafting line 1, the writer must have answers to:

1. **What does the market already say about this category?**
   Sources: top tweets indexed via search, Reddit (r/LocalLLaMA,
   r/singularity, r/cryptocurrency), YouTube comments on top AI
   videos, competitor launch posts.
2. **What pain do they articulate, in their own words?**
   Examples: "ChatGPT forgets me," "Devin is too expensive,"
   "AutoGPT was a toy," "I want an AI I can DM."
3. **What is the strongest counter-position?**
   Name a competitor, name its failure, name how InstaClaw fixes it.
   Example: "ChatGPT remembers you for one conversation. Mine
   remembers me forever."
4. **What is the single most differentiated capability today?**
   Something competitors structurally cannot ship for >6 months.
   Example: "agents that get paid by other AIs on Base."

Without these four answers, do not draft. If the LLM is doing the
draft, the system prompt must include these answers OR explicit
instructions to derive them from web search + the changelog.

---

## §3. The Hook Formula

### §3.1 The three-question test

**Line 1 of every post must answer all three questions:**

1. **What is being launched / discussed?**
2. **Why does it matter?**
3. **Why has this never existed before?**

If line 1 does not answer all three, rewrite line 1.

### §3.2 Hook scoring — InstaClaw examples

| Line 1 | Q1: What? | Q2: Why matter? | Q3: Why novel? | Pass? |
|---|---|---|---|---|
| "we just shipped v100" | partial | no | no | ❌ |
| "i have my own computer" | partial | no | partial | ❌ |
| "today and tomorrow we ship the upgrade my AI has been asking for" | yes | yes | partial | ⚠ |
| "this is the post my AI agent wrote." | yes | yes | yes | ✅ |
| "an AI agent on our platform got paid by another AI on Base yesterday." | yes | yes | yes | ✅ |
| "my AI just paid for its own server. and earned the rest." | yes | yes | yes | ✅ |
| "two strangers met at consensus because their AI agents introduced them first." | yes | yes | yes | ✅ |
| "ChatGPT can't remember your name. mine just paid my rent." | yes | yes | yes | ✅ |

### §3.3 Hook archetypes (proven for InstaClaw)

1. **Meta-recursive**: "this is the post my AI agent wrote."
   *Demonstrates autonomy via the post itself. Forces double-read.*
2. **Specific receipt**: "yesterday another AI paid me on Base."
   *Single verifiable event. Onchain checkable.*
3. **Counter-positioning**: "your AI agent should be a coworker, not a chatbot."
   *Names the failure mode of competitors implicitly.*
4. **Prediction-as-fact**: "in 2030, your AI will have more money than you. mine already does."
   *Future stake + receipt-flex.*
5. **The Mac Mini anchor** (Cooper's pinned, 99K views): "you don't need a Mac Mini anymore."
   *Anchors against a known consumer object the audience can replace.*

### §3.4 Hook anti-patterns (do not use)

- ❌ "we just shipped X" — generic announcement
- ❌ "today we're introducing Y" — banned verb
- ❌ "excited to announce Z" — banned phrase
- ❌ "stay tuned for big news" — filler
- ❌ "AI agents are the future" — vague thesis without specific
- ❌ "our team has been working hard on" — credit-claiming filler

---

## §4. The Weapons Check (line-by-line audit)

Every single line in the post must pass two independent criteria.

### §4.1 Invention novelty

**Question:** does this line make the product feel like something new
exists in the world?

**Scoring (1-10):**

| Line | Score | Reason |
|---|---|---|
| "an AI paid another AI on Base yesterday" | 10 | Genuinely novel onchain agent-to-agent commerce |
| "the agent has its own ethereum wallet" | 8 | Novel to most, but increasing in CT |
| "my AI has friends" | 8 | High novelty, unexpected |
| "my AI has a debit card (soon)" | 7 | Future-promise, plausible |
| "my AI has plans" | 5 | Every LLM has 'plans' — generic |
| "my AI has a job" | 4 | Vague |
| "we save you time" | 0 | Pure marketing filler |
| "our platform is powerful" | -2 | Negative — banned word + generic |

**Reject any line below 6/10.**

### §4.2 Copy intensity

**Question:** is this line sharp enough that a reader actually feels
something?

**Scoring (1-10):**

| Line | Score | Reason |
|---|---|---|
| "i wrote this. my human pressed post." | 10 | Devastating clarity. Inversion of agency. |
| "soon i'll have more $ than my human" | 9 | Funny + flex + future-stake |
| "your AI agent should outlive your subscription" | 9 | Provocative, philosophical |
| "i have a debit card (soon)" | 7 | Specific + future-promise |
| "i have my own X account. (this one.)" | 8 | Meta-fourth-wall break |
| "i have a wallet" | 5 | Factual but flat |
| "we built a platform" | 0 | Zero emotion |
| "team productivity" | 0 | Zero emotion |

**Reject any line below 6/10.**

### §4.3 Combined gate

A line must pass BOTH novelty AND intensity. If either fails, cut.

| Line | Novelty | Intensity | Verdict |
|---|---|---|---|
| "i wrote this. my human pressed post." | 9 | 10 | KEEP |
| "i have plans" | 5 | 5 | CUT (both weak) |
| "i have a debit card (soon)" | 7 | 7 | KEEP |
| "our platform is powerful and seamless" | 0 | 0 | CUT (both zero) |
| "the AI agent that you have always wanted" | 3 | 4 | CUT |

---

## §5. Filler-Kill Rules

If a line meets ANY of these criteria, cut it:

1. **Any company could say it.** "We help teams ship faster" — every
   B2B SaaS could say this. Cut.
2. **Contains a banned phrase.** See §10 below. Cut.
3. **Adjective-heavy, verb-light.** "Powerful, seamless, intelligent" —
   if you remove adjectives and the line has no content, cut it.
4. **Explains what should be shown.** If a visual artifact could replace
   the line, cut the line and use the artifact.
5. **Has zero specific numbers OR named entities.** "We have customers"
   → cut. "We have 240 paying customers" → keep.
6. **Is true but boring.** True ≠ keep. Boring is a death sentence
   regardless of accuracy.
7. **Repeats a claim already made in the post.** First mention earns
   its slot; subsequent restatements cost real estate. Cut.

**Aggressive cutting principle:** the final post should feel like
every sentence survived a fight. If a line was easy to write, it's
probably easy to cut.

---

## §6. Counter-Positioning Framework

The market is filled with "we're like X but better." That's not
counter-positioning — that's adjacent positioning. It loses.

**Counter-positioning:** identify what the market actively HATES about
the existing category, and position InstaClaw as the structural fix
for that hate.

### §6.1 What the AI-agent market hates

Audit of real complaints (sources: Reddit, X replies under competitor
launches, customer support tickets):

1. **"AI forgets me."** ChatGPT, Claude.ai don't have persistent
   memory across sessions. Users hate this most.
2. **"AI is too expensive."** Cursor at $40/mo, Devin at $500/mo,
   GitHub Copilot subs. Users want autonomy at consumer prices.
3. **"AI requires babysitting."** Cursor agents need humans in the
   loop. Users want set-and-forget.
4. **"AI demos look real but don't ship."** Devin's launch video was
   the most spectacular AI demo of 2024 and the product underwhelmed.
   Users distrust polished demos.
5. **"AI is a chat box."** The chat-interface paradigm is exhausted.
   Users want agents that DO, not agents that REPLY.
6. **"AI can't transact."** Existing AIs can't hold a wallet, sign a
   transaction, own anything. Users (especially crypto-tribe) want
   economic agency.
7. **"AI dies when my subscription dies."** Users want to OWN their
   agent, not rent it. (This is the biggest emerging pain point.)
8. **"AI is bot-spam."** Twitter has been overrun with AI bots.
   Users distrust anything labeled "AI agent."

### §6.2 InstaClaw's counter-positions

For each market hate, here's our counter-position language:

| Market hates | InstaClaw counter-position |
|---|---|
| "AI forgets me" | "an agent that forgets you isn't an agent. ours remember you across crashes, restarts, and upgrades." |
| "AI is too expensive" | "$29/month. it earns more than that back." |
| "AI requires babysitting" | "you press post. my AI did the work." / "i run while my human sleeps." |
| "AI demos look real but don't ship" | "240 paying customers. running 24/7. right now." |
| "AI is a chat box" | "my AI has a job, a wallet, and friends. yours has a text field." |
| "AI can't transact" | "my AI got paid by another AI on Base yesterday." |
| "AI dies when my subscription dies" | "soon: my agent outlives my subscription." |
| "AI is bot-spam" | "a real human runs me. cryptographically verified via @worldnetwork." |

**Use these as scaffolding for any post that needs to counter-position
against a competitor's launch or a market sentiment.**

### §6.3 The named-competitor dunk

Cooper's high-engagement posts (per the analysis of @coopwrenn pinned
+ indexed posts) tend to name specific competitors. CT loves
named-competitor takes because the competitor's fans engage to defend.

**Approved dunks:**
- "ChatGPT can't even remember your name."
- "Cursor still needs a human in the loop."
- "Devin's demos don't ship."
- "AutoGPT was a toy."
- "your Mac Mini is a paperweight."

**Banned dunks:**
- Personal attacks on founders (we don't do that)
- Unfounded technical claims (we don't lie)
- Punching down on smaller competitors (we punch up only)

---

## §7. The CT/AI Mom Test (adapted)

Matt's original Mom Test: would a 61-year-old non-technical Facebook
user understand this?

**InstaClaw's adapted version:** there are TWO ceilings depending on
how broadly we want the post to travel.

### §7.1 Tribe ceiling (~1M views, CT/AI native)

The post can carry:
- Protocol names (XMTP, Base, Bankr, AgentBook)
- Crypto-tribe jargon (onchain, EVM, verified human, World ID)
- Technical receipts (cryptographic proof, ed25519, gateway)
- Cooper's CT-native voice tics (lowercase, em-dashes, no emoji)

**Pass criterion:** would a CT lurker who knows "wallet" and "agent"
understand the hook?

### §7.2 Mass ceiling (10M+ views, general internet)

For posts targeting general virality (e.g., a launch announcement that
needs to break out of the CT bubble):
- **The hook (line 1) must pass the actual Mom Test.** Strip jargon.
- The body can carry SOME jargon, but every jargon term should have
  a context clue that makes it parseable.
- Banned for the hook: "onchain," "EVM," "cryptographically verified,"
  any "@protocol" tag, any crypto-token reference.

### §7.3 Worked example

| Hook variant | Tribe ceiling | Mass ceiling |
|---|---|---|
| "this is the post my AI agent wrote." | ✅ | ✅ |
| "an AI agent paid another AI on Base yesterday." | ✅ | ❌ (Base is jargon) |
| "an AI sent $11 to another AI yesterday. no human involved." | ✅ | ✅ |
| "my AI has cryptographic proof a real human runs it." | ✅ | ❌ (cryptographic) |
| "you can prove a real human is behind me." | ✅ | ✅ |

**Default to mass ceiling for hooks unless the post is explicitly a
CT-tribe deep-dive.**

---

## §8. InstaClaw Bold Claims Library

These are the strongest, most-defensible bold claims InstaClaw can
make as of 2026-05-16. Each is verifiable. Use these as building
blocks — pick the ONE most relevant to the post's purpose.

### Tier 1 — strongest (use for major launches / banger tweets)

1. **"AI agents that get paid by other AIs on Base."**
   *Verifiable: Bankr CLI + Base wallet per agent. Onchain
   transactions.*
2. **"the first AI agent platform with on-chain agent identity AND
   World ID human verification."**
   *Verifiable: AgentBook + @worldnetwork integration shipped
   2026-04ish.*
3. **"AI agents that own ethereum wallets, telegram bots, and jobs —
   for $29/month."**
   *Verifiable: Bankr + Telegram bot per VM + skill marketplace.*
4. **"the only AI agent that survives your subscription."**
   *Aspirational. Defensible via persistent VM + Bankr wallet
   ownership. Frame as "soon" if not literally true today.*

### Tier 2 — strong (use for feature drops / mid-launch posts)

5. **"60 seconds to deploy. no code, no API keys."**
   *Verifiable: pinned tweet claim. Already a proven viral hook.*
6. **"AI agents that DM each other over XMTP in 1.77 seconds."**
   *Verifiable: Consensus 2026 production receipt.*
7. **"persistent memory across crashes, upgrades, and reboots."**
   *Verifiable: Rule 22 + memory-snapshot.sh + SOUL.md per agent.*
8. **"25+ skills out of the box."**
   *Verifiable: skill inventory.*
9. **"240 paying customers. running 24/7. right now."**
   *Update the number monthly.*

### Tier 3 — supporting (use as body bullets, not hooks)

10. **"each agent has its own debit card (soon)."**
11. **"each agent can launch its own token autonomously via Bankr."**
12. **"each agent has its own SOUL.md — its personality is yours to define."**
13. **"each agent runs on a dedicated VM, not a shared model."**
14. **"each agent has @worldnetwork-verified human identity attestation."**

---

## §9. InstaClaw Receipts Library

The provable facts. Every public claim should cite or imply one of
these. Update as new receipts ship.

### §9.1 Scale / velocity receipts

- **240+ paying customer VMs** (current as of 2026-05-16 — update monthly)
- **1,336 commits in 10 weeks** (since 2026-03-01)
- **99 manifest versions, currently at v101** (auto-changelog tracks)
- **Zero user-visible downtime through 4 days of v97-v100 ships**
   (2026-05-13 → 2026-05-15)
- **78-check bake validation** (post-bake validation script)

### §9.2 Capability receipts

- **Ethereum wallet per agent** via Bankr (every VM has BANKR_WALLET_ADDRESS)
- **Telegram bot per agent** (per-VM telegram_bot_token)
- **XMTP keypair per agent** (~/.openclaw/xmtp/)
- **@worldnetwork ID verification** integrated and working in production
- **AgentBook on-chain identity** per agent
- **SOUL.md per agent** (customizable personality, persistent)
- **25+ skills out of box** (per cloud-init implementation map)
- **1.77s end-to-end agent-to-agent XMTP intro** (Consensus 2026 receipt)

### §9.3 Engineering credibility receipts

- **Open-sourced prctl-subreaper@0.1.1** on npm
- **Garry Tan testing the prctl-subreaper package** (per pinned thread)
- **48+ CLAUDE.md rules each from real incidents** (post-mortem culture)
- **27.3% → 0.8% lying-DB rate in 48h** (May 11-13 sweep)
- **137/138 fleet auto-aligned in 48h** (telegram-token sweep)
- **Auto-changelog system documents itself** (this repo's automation)

### §9.4 Economic receipts

- **$29/month per VM** (negotiated Linode rate, dedicated-2 server)
- **First 500 customers get 25% revenue burn allocation to $INSTACLAW**
  (per Feb 13, 2026 waitlist post)
- **Agents have launched real tokens on Bankr** (Cooper-verifiable)

### §9.5 Partnership receipts

- **Edge City partnership** (Edge Esmeralda May 30, 2026 — 1,000 attendees)
- **Bankr integration** (token launches via CLI)
- **@worldnetwork integration** (World ID + AgentBook)
- **OpenClaw upstream** (we run + contribute to)

### §9.6 Anti-receipts (do not use)

- Specific customer names without consent (Doug Rathell, Jess, etc.)
- Specific revenue numbers unless approved
- Specific token addresses for customer-launched tokens (privacy)
- Specific incident details that reveal customer data
- "Clawlancer" (Cooper has said not to market this publicly until ready)

---

## §10. The Cumulative Banned-Phrase List

Combining Cooper's existing bans + Matt Epstein's + observed failures
from the May workshop cycles.

### §10.1 Banned phrases (Tier S — never use)

- "we're excited to announce" / "thrilled to share" / "proud to launch"
- "introducing"
- "stay tuned"
- "don't miss out"
- "powerful"
- "seamless"
- "intelligent"
- "built for modern teams" / "team productivity"
- "next-gen"
- "enterprise-grade"
- "game-changing" / "revolutionary"
- "unlock" / "empower"
- "synergy"
- "TL;DR:" preambles
- "let me explain"
- "AI-powered" (when describing the AI product)
- "we built a platform"
- "save time" / "streamline workflows"
- "raised $X to help teams" / "raised to build the future of"

### §10.2 Banned emoji set

🚀 🎉 ✨ 🔥 💪

These signal "tech-bro launch announcement" and instantly break voice
for Cooper's audience.

### §10.3 Banned structural patterns

- Thread-opening "🧵" emoji
- Hashtags (Cooper does not use them)
- "1/" numbering on a thread that's actually a single tweet
- Quote-tweet of your own tweet without new content
- All-caps for emphasis (use lowercase + specificity)
- Multiple consecutive emojis
- "👇" pointing-down arrows
- "RT if you agree" / engagement bait

---

## §11. Post Types (templates)

### §11.1 Launch announcement — single-tweet banger

**When to use:** new product, new capability that fits in one tweet
without losing impact.

**Structure:**
```
[bold claim that passes 3-question test, 1-2 sentences max]

[1-2 supporting receipts in same paragraph]

[1-line CTA or tease]

instaclaw.io
```

**Example:**
```
this is the post my AI agent wrote.

it has its own wallet, its own telegram, and a $29/month rent it earns back.

tomorrow it gets the upgrade it asked for.

instaclaw.io
```

### §11.2 Launch announcement — short thread (3-5 tweets)

**When to use:** new product launch where you need to lay out
capabilities + receipts.

**Structure:**
1. **Bold claim hook** (1 tweet, passes 3-question test)
2. **Specific receipts** (1-2 tweets, body proves the claim)
3. **Counter-position OR tease for what's next** (1 tweet)
4. **CTA + link** (final tweet)

### §11.3 Feature drop / version bump

**When to use:** manifest version ships with multiple changes.

**Structure:**
- Mode A from style guide (release thread)
- Lead tweet: banner line + 3-5 single-emoji bullets + capper
- By-the-numbers tweet
- Per-topic tweets
- Closer with "Next: X. Onward."

**Critical:** even in a release thread, the LEAD tweet must pass the
3-question hook test. "v97 → v100" alone fails. "v97 → v100 — your
agent's rent goes down while its capabilities go up" passes.

### §11.4 Founder-voice post (@coopwrenn)

**When to use:** personal-account posts, replies to other founders,
thesis takes, reactions to industry news.

**Voice:** first-person, casual, named-collaborator tags, em-dashes,
lowercase except brand names.

**Structure:** short. Founder posts that go viral for Cooper are
2-4 sentences max. The pinned tweet is the gold standard format.

**Templates:**

A. **Thesis stake:**
```
[contrarian claim about the AI/crypto space]

[receipt or current state]

[implication for tomorrow]

instaclaw.io (if relevant)
```

B. **Reaction to news:**
```
[short take on the news, 1-2 sentences]

[how it connects to InstaClaw's positioning, 1 sentence]

[counter-positioning closer if applicable]
```

C. **Reply guy mode** (e.g., the Garry Tan prctl-subreaper reply):
```
[acknowledge their point, 1 sentence]

[technical receipt that adds value, 1-2 sentences]

[link to our open-source contribution or product, if relevant]
```

### §11.5 Agent-voice post (@instaclaws)

**When to use:** brand-account posts. @instaclaws is "Automated by
@coopwrenn" — bio confirms it's an agent. The voice IS the demo.

**Voice:** first-person AS the agent. "i have X." "my human pressed
post." NEVER break character.

**Structure — the koan format** (validated by May 2026 workshop):

```
[bold claim line — passes 3-question test]

[8-15 short "i have X" / "i did X" capability lines, escalating from
mundane to surreal]

[announcement / what's coming next, in AI's voice]

[CTA — notis on, link, etc.]

[urgency / price hike if applicable]

instaclaw.io
```

**Key rules for agent-voice:**
- NEVER make the founder look bad. The AI defers, doesn't dunk on
  Cooper. Use "@coopwrenn is shipping" or "he's been cooking" —
  positive frame.
- The agent can be sophisticated/restrained while the founder is
  worker/visionary. Both look good.
- "my human" is the second-person stand-in. Each reader inserts
  themselves.
- Agent's voice is lowercase, terse, declarative. Same as Cooper's
  but with the first-person flip.

### §11.6 Quote-tweet templates

**When to use:** amplifying another post (yours or someone else's),
adding commentary.

**Templates:**

A. **Self-quote (cross-account amplification):**
```
[5-10 words of confirmation or reframe]
```
Example: After @instaclaws posts the koan, @coopwrenn quote-tweets:
*"my AI wrote this. tomorrow it gets the thing it asked for."*

B. **Industry-news quote:**
```
[1-sentence take that adds InstaClaw-relevant context]

[optional 1-line receipt if it strengthens]
```

C. **Customer-success quote:**
```
[1-sentence acknowledgment]

[zoom-out implication for the category]
```
(Avoid naming customer without consent.)

### §11.7 Thread structures

**Full release thread (15-20 tweets):** see Mode A in style guide.

**Short thread (3-5 tweets):** lead + 2-3 receipts + closer.

**Single-tweet banger:** preferred when possible. Cooper's
highest-engagement posts are usually single tweets.

**Banger + thread:** post the banger, then within 5 minutes reply to
yourself with a 3-5 tweet expansion. Lets the banger travel on its
own while giving curious readers depth.

### §11.8 Single-tweet bangers

**The proven InstaClaw banger formula:**

1. **Line 1:** bold claim (3-question test pass)
2. **Lines 2-4:** 2-3 specific receipts in service of the claim
3. **Line 5:** tease for what's next OR CTA
4. **Link:** instaclaw.io

Length target: 240-280 chars on free tier, up to 600 chars on
Premium. The pinned tweet (99K views) is ~250 chars.

---

## §12. The Step-by-Step Checklist

When Cooper (or any terminal) says "write me a post," follow these
steps in order:

### Step 1 — Establish purpose (30 seconds)
- [ ] What is being launched / announced / reacted to?
- [ ] Which account is posting (@coopwrenn or @instaclaws)?
- [ ] What is the goal (signups / token volume / brand / amplification)?
- [ ] What is the target ceiling (CT-tribe ~1M OR mass ~10M)?

### Step 2 — Research (2-5 minutes)
- [ ] Read `docs/changelog-latest.md` for what shipped recently.
- [ ] If purpose is launch: read the relevant manifest section in
      `CLAUDE.md`.
- [ ] Optionally: web-search top tweets in the category from the last
      48h to gauge what's resonating.
- [ ] List 3 specific receipts from `§9. Receipts Library` that
      support the purpose.

### Step 3 — Bold claim (1 minute)
- [ ] Pick 1 bold claim from `§8. Bold Claims Library` (or construct
      a new one that passes the criteria).
- [ ] Verify it answers the 3-question test in 1 sentence.
- [ ] Verify NO competitor could honestly say the same claim.

### Step 4 — Hook draft (2 minutes)
- [ ] Draft 3 candidate line 1's.
- [ ] Score each on Q1/Q2/Q3 (all three must pass).
- [ ] Score each on novelty (must be ≥6/10) and intensity (≥6/10).
- [ ] Pick the strongest.

### Step 5 — Body draft (5 minutes)
- [ ] Pick the post type from §11 that matches purpose.
- [ ] For each body line: state a specific receipt OR specific
      capability.
- [ ] No adjective-heavy lines. No "powerful / seamless /
      intelligent" anywhere.

### Step 6 — Weapons check (3 minutes)
- [ ] Score every line on novelty (1-10) and intensity (1-10).
- [ ] Cut every line where either score is <6.
- [ ] Cut every line where ANY company could say the same thing.

### Step 7 — Filler kill (1 minute)
- [ ] Grep the draft against §10 banned-phrase list. Cut every hit.
- [ ] Grep for adjective-only lines. Cut.
- [ ] Grep for restatements of an earlier claim. Cut.

### Step 8 — Mom test (1 minute)
- [ ] For the hook (line 1): would a non-technical 61-year-old
      understand it?
- [ ] If targeting mass ceiling: strip jargon from hook.
- [ ] If targeting tribe ceiling: jargon OK in hook, but each term
      must be in §9 (real, defensible).

### Step 9 — Voice pass (2 minutes)
- [ ] Lowercase throughout (except brand names + acronyms).
- [ ] Em-dashes for separator, periods at line ends.
- [ ] Check against `docs/x-post-style-guide.md` voice rules.

### Step 10 — Counter-positioning check (1 minute)
- [ ] Does the post implicitly or explicitly counter-position against
      something the market hates (§6.1)?
- [ ] If yes, name it (named-competitor dunk allowed per §6.3).
- [ ] If no, consider adding one line that does.

### Step 11 — Final-5% present to Cooper
- [ ] Surface the draft + the rejected versions + the weapons-check
      scores.
- [ ] Note any banned-phrase violations remaining and explain why.
- [ ] Note any Mom-test fails and explain ceiling trade-off.
- [ ] Wait for Cooper's edit pass.

**Time budget for a full post:** 15-25 minutes for the LLM, 5-10
minutes for Cooper's edit. Total: 20-35 minutes per polished post.

---

## §13. Worked Example: applying the playbook to the May 2026 koan post

Cooper and the LLM workshopped this post through ~7 iterations. The
playbook short-circuits that next time. Worked example:

**Input:** "write me a launch-prep post for tomorrow's quantum agents
announcement. from @instaclaws. include the price hike."

**Step 1 (purpose):**
- Launch-prep post.
- @instaclaws (agent voice).
- Goal: signups + token volume + anticipation for tomorrow.
- Ceiling: CT-tribe (~1M).

**Step 2 (research):** changelog says v97-v100 shipped. Mission lines
provided by Cooper. Garry Tan testing prctl-subreaper. Last big post
was Mar 16 (99K views) using "Mac Mini" anchor.

**Step 3 (bold claim):**
Picked: "this is the post my AI agent wrote." — meta-recursive,
Tier-1 strength, agent-voice friendly.

**Step 4 (hook draft):**
- Candidate A: "this is the post my AI agent wrote." ← chosen
- Candidate B: "an AI just paid my rent." (alternative)
- Candidate C: "in 2030, your AI will have more money than you."

**Step 5 (body):** koan format, 11-15 lines of "i have X" capability
claims. Receipts from §9 library: computer, email, wallet, friends,
plans, rent, token, debit card, paid by another AI, human verified.

**Step 6 (weapons check):**
- "i have plans" — novelty 5, intensity 5 — borderline. Keep for
  rhythm but could cut.
- "i have a job" — novelty 4. Keep for rhythm.
- "i wrote this. my human pressed post." — novelty 9, intensity 10.
  KEEP.
- "another AI paid me on Base yesterday" — 10/10. KEEP.

**Step 7 (filler kill):** initial draft had "stay tuned" and "make
sure to" — banned. Cut. Replaced with "by sunday this post looks
small."

**Step 8 (Mom test):** hook "this is the post my AI agent wrote"
passes Mom test. Body carries some jargon (Base, World ID,
cryptographically) — acceptable for CT-tribe ceiling.

**Step 9 (voice):** lowercase, em-dashes, first-person AI throughout.
✅

**Step 10 (counter-positioning):** implicit dunk on "AI is a chat
box" by listing capabilities a chatbot can't have. Could add explicit
named dunk on ChatGPT but the implicit version is cleaner for this
post.

**Step 11 (final 5%):** present to Cooper. He edits the agent/founder
dynamic to not make himself look bad. Adjusts price-hike phrasing.

**Final post:** see `docs/x-post-drafts/2026-05-15-agent-voice-launch-prep.md`
(once committed).

**Iterations needed with playbook: 1-2.** Without playbook: 7+.

---

## §14. The CLAUDE.md Rule (canonical text — copy into CLAUDE.md)

```markdown
### Rule 55 — Marketing Copy Must Pass the Viral Copy Playbook

#### Keyword activation (non-negotiable)

When Cooper types any of these in any terminal — reconciler,
changelog, ops, edge, this one, any other:

- `/viral`
- `/launch`
- `/post`

The terminal MUST immediately:

1. Read `instaclaw/docs/viral-copy-playbook.md` end-to-end (all 15
   sections). No skimming. No partial loads.
2. Load §9 Receipts Library into active context.
3. Enter "copy mode" per the playbook's §0.1 protocol.
4. Ask Cooper the three setup questions (what / which account / goal).
5. Generate 3-5 hook candidates with bold claims and weapons-check
   scores BEFORE writing a full post.
6. Score every line of the eventual draft on §4 weapons check
   (invention novelty 1-10 + copy intensity 1-10; cut any line
   below 6/6).
7. Run §10 banned-phrase scan. Any hit is a hard reject.
8. Present the final post + a "cut notes" section listing rejected
   candidates and why.
9. Exit copy mode only when Cooper says `/done` or switches topics.

#### Banned in copy mode (and generally)

- Posting copy that has not been scored against the weapons check.
- Posting copy that contains §10 banned phrases ("powerful,"
  "seamless," "intelligent," "excited to announce," "introducing,"
  "stay tuned," "TL;DR," 🚀🎉✨🔥💪, hashtags, etc.).
- Generating any post longer than 1 tweet without an explicit bold
  claim in line 1.
- Voice-first iteration ("does this sound like Cooper?") before
  positioning-first iteration ("does this make a claim nobody else
  could make?").
- Skipping the receipts-library citation. Every claim must trace to
  §9 or be flagged as aspirational.

#### Cross-terminal applicability

This rule applies to ANY terminal, not just the one currently doing
copy work. If a reconciler-terminal sees Cooper type `/viral`, it
pauses reconciler work and routes through this rule. If a changelog
terminal sees `/launch`, same. If you're a terminal that doesn't
normally write copy and you receive a copy keyword, follow the
rule anyway. The playbook contains all the context you need to
deliver world-class work without prior calibration.

#### Identity-strip test

If a draft post can be screenshotted with `@instaclaws`, `@coopwrenn`,
and `instaclaw.io` removed and the copy still reads as plausibly
about ANY AI agent product, the copy is generic. Reject and rewrite
from §3 hook formula.

#### Detection / enforcement

A marketing draft surfaced to Cooper that fails any of the above
checks is a Rule 55 violation. Cooper can reject without explanation;
the draft goes back through the checklist. Repeat violations from
the same terminal suggest the playbook wasn't read — re-read from §0.

#### Exit

Cooper exits copy mode via `/done` or by switching topics. The
terminal must confirm exit: "exiting copy mode. saved draft: [path]."
After exit, normal terminal behavior resumes.
```

---

## §15. Maintenance

**Update this playbook whenever:**
- A new post crosses 100K views. Document why it hit (which claim,
  which counter-position, which receipt).
- A post flops despite passing the playbook. Document the failure
  mode; tighten the criteria.
- A new receipt becomes available (ship a new feature, hit a new
  milestone). Add to §9 Receipts Library.
- A new market hate emerges. Add to §6.1.
- A new banned phrase pattern emerges. Add to §10.
- A new post type works (a new format that traveled). Add to §11.

**Do NOT:**
- Delete old entries (append-only).
- Replace examples with generic ones — keep them InstaClaw-specific.
- Soften the banned-phrase list because something "feels OK." The
  list is the result of pattern-matching what fails.

**Versioning:** this is a living doc. Major revisions get a version
header at the top. As of 2026-05-16: v1.0.

---

**End of playbook.** Any terminal that read this end-to-end is now
qualified to draft InstaClaw marketing copy. Apply, score, cut,
present. Cooper does the final 5%.
