# Viral Launch Playbook — InstaClaw / @coopwrenn

## §0. ACTIVATION (read this first)

This playbook is the **sister document** to `viral-copy-playbook.md`. Both must be loaded into active context whenever Cooper types one of the three activation keywords (`/viral`, `/launch`, `/post`) in any terminal in this repo. The Copy Playbook owns the full activation protocol (its §0); this doc does not duplicate it.

### §0.1 What each playbook owns

- **`viral-copy-playbook.md`** owns the LANGUAGE of the post — the bold claim, the three-question hook test, the weapons check, the banned-phrase scan, the receipts library, the voice templates. **WHAT you write.**
- **`viral-launch-playbook.md`** (this doc) owns the MECHANICS of the launch — the medium (video), the hook architecture (first frame), the CTA discipline, the first-hour orchestration. **HOW you ship.**

The two compose. Strong copy in a weak launch dies at 50K views. Strong launch mechanics around weak copy converts attention to nothing. **Both required.** When in doubt, load both — token cost is negligible compared to shipping a weak launch.

### §0.2 When this doc is load-required vs. optional

- **Required:** any product launch, feature drop, partnership announcement, manifest milestone, token milestone, or any creative artifact involving video.
- **Optional:** one-off replies, quote-tweets, reactive posts, internal comms. In these cases the Copy Playbook may be sufficient alone.

If unclear, load. The doc is ~900 lines; the cost is trivial.

### §0.3 Provenance

The five patterns documented here come from a quantitative analysis of 100 tech launches over a 12-month window. Every launch in the dataset cleared 500K views; some exceeded 5M. The analyst tracked 50+ data points per launch — hook, video, CTA, opening frame, amplification, engagement signature. The patterns are observational, not theoretical — they came out of the data, not someone's framework.

The headline finding: **the launches that hit big aren't doing different things. They're doing the same five things, with discipline most founders skip.**

This playbook codifies those five patterns, layers InstaClaw-specific application on top, and cross-references every place each pattern meets the Copy Playbook.

---

## §1. The five patterns — at a glance

| # | Pattern | What it earns | Skipping costs |
|---|---|---|---|
| 1 | **Video is mandatory** | Right to be watched | Text-only launches scroll past unread |
| 2 | **Hooks name new categories** | Right to be remembered | Generic hooks compete with every product the viewer has dismissed |
| 3 | **First frame = the hook** | Right to keep the viewer | Strong video with weak opening loses 80% of viewers in the first 2 seconds |
| 4 | **One destination, one verb** | Right to convert | Captured attention with nowhere to go is wasted attention |
| 5 | **First hour is a coordinated event** | Right to scale | Post-and-pray dies at 50K-200K views |

The patterns are not independent. They are a chain. Break one link and the chain doesn't carry the launch. See §7 for the composition logic.

---

## §2. Pattern 1 — Video is mandatory

### §2.1 The pattern

Every viral launch in the dataset had a video. Duration range: **42 seconds to 3 minutes.** Production tier varied wildly — some highly produced, some edited in a weekend. The format varied. The medium did not.

If you launch with a text-only post or a static image, you are not playing the game the top of the platform plays. **Not optional. Not "nice to have." Required.**

### §2.2 Why it works

Video earns motion-blocking attention on a scrolling feed. The X algorithm boosts video traffic; reposts of video carry more weight than reposts of text. The 2-second first-frame test (§4) forces a compression of message that benefits the launch even when the production budget is small.

### §2.3 What "good" looks like

- **Duration:** 42 seconds to 3 minutes. Sub-60-second clips outperform for B2B/AI launches.
- **Production tier flexibility:** highly-produced ≠ required. A weekend edit with a strong concept beats a 4-week production with a weak concept.
- **First frame:** see §4 — non-negotiable.
- **Sound design:** must work both with audio and on mute. Captions burned in. Music optional.
- **Aspect ratio:** 16:9 horizontal for desktop-dominant audience; square (1:1) or vertical (9:16) if mobile-dominant. X handles all three; pick the one that maximizes the visible product surface.

### §2.4 InstaClaw production tiers

Three viable paths depending on launch size:

- **Tier-A (4+ weeks):** outside agency, motion design, voice talent, multi-cut storyline. Reserve for token milestones, major partner launches, or anniversary-class events.
- **Tier-B (1 week):** in-house edit using the higgsfield-video, sjinn-video, or motion-graphics skills already deployed on the fleet. Agent-voice narration via xtts or voice-audio-production skill. Default for most launches.
- **Tier-C (1 day) — minimum viable:** screen recording of the product working + on-screen typography + a single piece of music. The 42-second viral launches in the dataset were often Tier-C. Use this when the alternative is "no launch."

If a launch's video cannot meet at minimum Tier-C standard, **the launch should be delayed.** Posting without video is not an acceptable trade.

### §2.5 Banned alternatives

- **Text-only launch post.** The viewer doesn't stop scrolling for a wall of text on launch day.
- **Static image of a product screenshot.** No motion, no attention capture.
- **"We made a video" as a bullet in a thread.** The video IS the launch, not a footnote inside it.
- **Founder-talking-head-only video.** Acceptable as supplementary content for tweets 2+, but fatal as the primary launch creative (see §4.3).

### §2.6 Cross-reference

- Copy Playbook §11 (post templates) assumes the post is the primary artifact. For a video-led launch, the post is the **frame** that holds the video. The post copy is still Copy-Playbook-governed; the video is this-playbook-governed.

---

## §3. Pattern 2 — Hooks name new categories

### §3.1 The pattern

The losing move is to describe your product in an **existing** category. "AI-powered email client." "Smart video editor." "Personalized AI assistant." These categories already live in the reader's head, and your launch immediately competes with every product they've already dismissed in that category.

The winning move is to **name a new category that didn't exist a minute ago and put your product inside it as the prototype.**

Receipts from the dataset:

- *"the first inbox with good judgment"* — 2.2M views. ("Inbox" is a dead category; "inbox with good judgment" is new.)
- *"the next AI interface for creation: a person"* — 3.5M views. ("AI tool" is saturated; "AI interface = a person" reframes.)
- *"your personal Talent Agent"* — 1M views. ("Career platform" is dead; "Talent Agent" is new.)

In each case, the launch did not enter an existing category. It declared a new one.

### §3.2 Category-naming vs. counter-positioning (two distinct hook shapes)

The Copy Playbook validates **counter-positioning** as a hook pattern (the "every X before us asked you to do something" shape). Category-naming is a **second** validated hook pattern, not a replacement. Use the right one for the launch.

| Hook shape | Claim type | Use when |
|---|---|---|
| **Category-naming** | Positive: "we are the first X" | Launching a product that genuinely creates a new shape, not a better version of an existing thing. We are the prototype. |
| **Counter-positioning** | Negative: "every other X requires Y; we don't" | Launching a feature/product that removes a friction every competitor still imposes. We removed the human from the loop. |

Both pass the Copy Playbook §3.1 three-question test. Both score well on §4 weapons check. Choose based on what is TRUE about the launch.

Validated InstaClaw examples:

- **Counter-positioning** (validated Hook A from tokenomics thread, 2026-05-16): *"every AI token before $INSTACLAW asked you to do something. stake. vote. lock. claim. provide LP."*
- **Category-naming** (live library candidates — §3.4): *"the first AI agent that owns its own wallet"*

### §3.3 The category-invention test

Before writing copy:

1. **Write down what your product does in plain language.** ("InstaClaw ships AI agents that have wallets and can launch their own tokens.")
2. **Ask: what NEW category could this be the first of?** ("The first AI agent that owns its own assets." "The first autonomous agent with a wallet baked in.")
3. **Test the candidate category against the Copy Playbook §3.1 three-question test.** (What is the claim / why does it matter / why has this never existed before.) Does it pass?

The hook is hiding inside the answer to question 2. If you can't name a new category your product is the prototype of, the product may not have a viral hook — or the launch isn't a launch, it's an update. Treat the latter accordingly.

### §3.4 InstaClaw category library (live; append as new framings test well)

These are seeded category candidates for /viral and /launch sessions to draw from. When a launch lands well with a new framing, append it here.

- *"the first AI agent that owns its own wallet"*
- *"the first AI agent with a built-in token launchpad"*
- *"the first AI agent that pays for itself"* (heartbeat self-funding mechanic)
- *"the first AI agent that earns its rent"*
- *"the operating system for autonomous AI agents"*
- *"the platform where the next wave of agent tokens comes from"* (validated in the 2026-05-16 tokenomics thread)
- *"the first AI agent that came pre-onboarded to crypto"* (World Mini App angle)
- *"the first AI agent that ships with a soul"* (SOUL.md persistence angle)
- *"the first AI agent whose token gets bought every time someone pays for it"* (silent-engine angle)

### §3.5 Banned hooks

- **Existing-category descriptions:** "AI-powered X," "Smart Y," "Personalized Z."
- **Three-word product taglines that name an existing thing:** "AI Agent Platform." "Smart Email Tool." Forgettable on contact.
- **Hooks that grant the existing-category frame and try to compete inside it:** "the best AI assistant," "the most advanced agent platform." Implies the category exists and we are a contestant. Category-naming denies the category exists yet.
- **Hooks that lead with "we" or "I":** the founder's identity is not the category. The product's category is the category.

---

## §4. Pattern 3 — First frame = the hook

### §4.1 The pattern

The first 2 seconds of the launch video do the same job as the first line of a tweet: **stop the scroll, or nothing else matters.** Every viral launch in the dataset opened with one of three frame archetypes. **None** opened with a founder on camera saying "Hey, we're launching..."

### §4.2 The three frame archetypes

**Archetype 1 — Buyer's pain stated bluntly in bold typography.**

Black background, white text, one sentence. Names the problem the viewer has felt. No music, or stripped instrumental. Maximum signal density. The viewer reads the line and either feels seen (continues watching) or doesn't (scrolls). Both outcomes are useful — the wrong audience is filtered, the right audience is captured.

*Example pattern:* "You spend 4 hours a week on email. Most of it is bullshit." → cut to product.

**Archetype 2 — The product in real time.**

No setup, no narration intro. The product is doing its thing in frame 1, and the viewer sees the value in motion. Works best when the product's "magic" is visual.

*Example pattern:* product opens, agent ships a token on Bankr live on screen, supply chart visibly decrements — all in the first 2 seconds.

**Archetype 3 — Pattern interrupt with a deferred promise.**

An incongruous opening image or claim that doesn't make sense, followed by a tease that you'll explain. Forces continued watching. The pattern interrupt should be specific to the product (not generic "wait... what?" content).

*Example pattern:* "$INSTACLAW just burned itself. Watch what happens next." → cut to mechanic.

### §4.3 Banned openings

- **Founder-talking-head intro:** "Hey everyone, I'm [name], and today we're excited to announce..." (also a Copy Playbook §10 banned-phrase territory: "excited to announce.")
- **Title cards / logo reveals:** any opening that prioritizes the brand over the viewer's attention. Brand goes at the END.
- **Background music with no visual hook for 3+ seconds:** "B-roll" openings that defer the value.
- **"What is X?" rhetorical opening:** imposes question-answer framing the viewer didn't agree to.
- **A founder walking somewhere with voiceover:** generic announcement-video grammar. Boring on contact.

### §4.4 InstaClaw video opener candidates

For agent-voice launches:

- **Pain typography (Archetype 1):** "your agent forgets you after one error." → cut to InstaClaw's Rule-22 session-preservation in action.
- **Product real-time (Archetype 2):** screen of an agent launching a token on Bankr in one click, supply chart visibly decrementing in the corner.
- **Pattern interrupt (Archetype 3):** "$INSTACLAW destroys itself every day. nobody decides when. watch." → cut to BurnRouter contract firing on-chain.

For founder-voice launches:

- **Pain typography:** "every AI 'agent' you've used is a chatbot with extra steps." → cut to InstaClaw doing real autonomous work.
- **Product real-time:** screen of an agent shipping a video on Higgsfield + posting to X + collecting payment in USDC, all unattended.

### §4.5 The 2-second test

Before approving any opening: imagine the video playing in a muted feed of an X user who is scrolling at normal pace. Does the first frame stop the scroll? If unsure, scrap and try another archetype. There is no "kind of stopping the scroll" — it stops or it doesn't.

---

## §5. Pattern 4 — One destination, one action verb, zero ambiguity

### §5.1 The pattern

Viral launches end with **one clear destination and one action verb.** The CTA names exactly where the viewer goes and exactly what they do when they get there.

Failing launches end with "let us know what you think," "DM me for early access," "stay tuned," or nothing at all. The viewer leaves with nowhere to go — and most viewers do not invent a destination on their own. **Captured attention with no exit is wasted attention.**

### §5.2 The single-CTA test

Before shipping, answer this question in one sentence: **what is the single most valuable action a viewer could take 5 seconds after the video ends?**

That's the CTA. One destination, one action, one click of distance. If the answer requires more than one sentence, the launch isn't ready.

### §5.3 Winning vs. losing closes

**Winning closes (one verb + one destination):**

- *"Buy $INSTACLAW. → virtuals.io/instaclaw"*
- *"Get your agent. → instaclaw.io"*
- *"See the math. → instaclaw.io/token"*
- *"Verify on BaseScan. → 0xa9e2…"*

**Losing closes (multi-path, ambiguous, or absent):**

- "Let us know what you think."
- "DM me for early access."
- "Stay tuned for more." (also a Copy Playbook §10 banned phrase)
- "Follow us for updates."
- "Buy or learn more or join the waitlist." (multi-CTA)
- (no CTA at all — the most common failure)

### §5.4 InstaClaw CTA library

| Launch type | Primary destination | Action verb |
|---|---|---|
| Tokenomics / burn mechanic | `instaclaw.io/token` | "see the math" |
| Token buy | `app.virtuals.io/virtuals/43920` | "buy $INSTACLAW" |
| Agent product | `instaclaw.io` | "get an agent" |
| Earn / partner | `instaclaw.io/earn` | "earn $INSTACLAW" |
| Edge City | `instaclaw.io/edge` | "join Edge" |
| World Mini App | World App link | "open in World" |
| Contract verification | BaseScan link | "verify on BaseScan" |
| Skill / partner-specific | varies | varies — name the specific verb and destination in the launch plan |

This is the live CTA library. New destinations get added when a launch creates a new endpoint. Never invent an ad-hoc destination at launch time.

### §5.5 Banned closes

- Multi-verb CTAs.
- "Stay tuned." (Copy Playbook §10 banned phrase.)
- Implicit CTAs ("here's what we built"). State the verb explicitly.
- Email-collection forms as the primary destination. Force the click to the live product or token-buy page.
- Internal subdomains, staging URLs, or unverified links.
- A bare contract address with no verb. ("0xa9e2..." is not a CTA — "verify on BaseScan: 0xa9e2..." is.)

---

## §6. Pattern 5 — First hour is a coordinated event

### §6.1 The pattern

The accounts hitting 1M+ views are not writing better tweets than the accounts hitting 50K. They are **orchestrating the first 60 minutes.**

The launches that die at 50K-200K skip this entirely. They post a single tweet and hope. **Post-and-pray is the single most common cause of launch failure in the dataset.** The fix is procedural, not creative.

### §6.2 The three-tier amplification model

Every viral launch's engagement signature shows the same pattern in the first 60 minutes:

- **Tier 1 — Founder real-time engagement (T+0 to T+5 min).** The founder is online and replies to every comment within 5 minutes. Algorithmic signal: this account believes in this post enough to defend it. Drives early engagement velocity and tells the algorithm to push wider.
- **Tier 2 — Recognizable accounts amplify (T+15 min to T+30 min).** 5-15 weighted accounts in the founder's network repost, quote-tweet, or reply with their own angle. These must be **PRE-WARMED** — they know the launch is coming, they have the link, they've been briefed on the tone. Cold pings at T+0 have lower hit rate.
- **Tier 3 — Mid-tier accounts layer in (T+1 hr to T+2 hr).** 20-50 mid-tier accounts (followers in the 1k-100k range) engage organically. These often spread through the original network's secondary connections. By T+2hr, the X algorithm has decided whether to push the post into broader recommendation feeds.

The launches that hit 1M+ all have this signature. The launches that die at 50K-200K have a flat-line: one tweet, then nothing.

### §6.3 Choreography — T-7 days through T+2 hr

**T-7 days (one week before launch):**

- Identify 20-30 people whose engagement carries weight with your specific buyer. Not generic crypto-Twitter — people whose audience overlaps your conversion funnel.
- DM each of them the launch date + the angle in one sentence. Do not share the copy yet.
- Block out 2 hours on launch day. Cancel everything in that window.
- Confirm video, post copy, and CTA are all locked.

**T-24 hours:**

- Send the launch copy to Tier 2 amplifiers (the 5-15 highest-weight names). Tell them the exact link they will receive at T+0.
- Schedule the post for an exact time you have optimized for (peak hours for the target audience, not for your local timezone).
- Pre-draft the cross-account quote-tweet (@coopwrenn ↔ @instaclaws) and have it ready in a draft.
- Confirm video uploads correctly on X by uploading to a separate scratch account or X Studio.

**T-0 (post goes live):**

- DM the direct link to all Tier 2 amplifiers within 30 seconds.
- Begin replying to every comment within 60 seconds of the comment landing.
- Send the cross-account quote-tweet 5-10 minutes after the primary post.

**T+5 min to T+30 min:**

- Maintain reply velocity. Every comment in <5 minutes.
- Watch Tier 2 amplification land. If a key amplifier hasn't engaged by T+20, DM them again — they may have missed the first ping.
- Track view count trajectory. Healthy launches double from T+5 to T+30.

**T+30 min to T+2 hr:**

- Continue real-time engagement.
- Quote-reply top-of-thread comments that add useful angle (extends thread reach via the commenter's network).
- Mid-tier accounts begin layering in. Engage each — even a one-word reply ("yes") to a small-account reply earns disproportionate algorithmic signal.

**T+2 hr to T+24 hr:**

- Reply rate can slow to <1 hr per response.
- Track trajectory. If view count stalls between T+4hr and T+8hr, prepare a thread-extension reply with a second-day angle (e.g., "I forgot to mention this is the 5th burn engine going live"). Restart momentum.

### §6.4 InstaClaw amplifier roster (template)

The actual roster is private and Cooper-maintained. As a template for what categories to think about:

- **Crypto / token launches:** crypto-founder Twitter, Bankr / Virtuals leadership, Base ecosystem accounts, well-known InstaClaw early users, on-chain analytics accounts.
- **AI agent / product launches:** AI builder accounts, World ecosystem (Andy and team), agent-economy thought leaders, hot-AI-take Twitter.
- **Partner launches (Edge City, Newsworthy, etc.):** the partner's own network FIRST (they distribute to their tribe better than we do), then the broader rollout.
- **Manifest / engineering wins:** infrastructure-Twitter (Linode/Joey, gbrain/Garry, etc.), engineering culture accounts.

Before any launch ≥ Tier 2 importance, **Cooper should be asked to confirm the roster is current and pre-warmed.** If a /launch session lands without confirming the roster, the launch isn't ready.

### §6.5 Banned launch patterns

- **Post-and-pray.** Post the tweet and walk away. Fatal.
- **No T-7 pre-warming.** Pinging amplifiers cold at T+0 has lower hit rate.
- **Single-timezone-only amplifiers.** If all 30 amplifiers are in the same timezone, you get 30 retweets in 5 minutes then silence. Stagger the roster across timezones if possible.
- **Founder unavailable during launch window.** No real-time engagement = no Tier-1 signal = no algorithmic push. The 2-hour window is not negotiable.
- **Launching during peak chaos hours.** Sunday evening / Friday late afternoon / national holidays / major news events kill velocity.
- **Letting Tier 2 amplifiers see the copy for the first time at T+0.** They need 24h of marination to write a quality quote-tweet that adds angle, not just a generic RT.

---

## §7. How the five patterns compose

The five patterns are not independent levers you can pull individually. They are a **chain**. Each link enables the next:

| Pattern | Earns you | Skipping it means |
|---|---|---|
| 1. Video | Right to be watched | P3 is moot, P2's hook lands in a less amplified post |
| 2. Category hook | Right to be remembered | P1's video is forgettable, P3 wastes its first-frame on a hook that doesn't ladder up to anything |
| 3. First frame | Right to keep the viewer | P1's video is watched 0.5 seconds and lost, P2's hook never reaches the viewer |
| 4. Single CTA | Right to convert | P1-P3's captured attention dies at the moment of conversion |
| 5. First-hour orchestration | Right to scale | P1-P4's quality launches into a void with no early signal for the algorithm to amplify |

**Break one link and the chain doesn't carry.**

This is the part nobody internalizes until they've watched a launch with great copy and a great video die at 80K views because the first-hour engagement signature was flat. The discipline is "execute all five with the same rigor." There is no version of this where four out of five is good enough.

---

## §8. Cross-reference — where this meets the Copy Playbook

| This playbook (§) | Copy Playbook (§) | How they compose |
|---|---|---|
| §3 Category hooks | §3.1 Bold claim 3-question test | Category-naming is one shape of bold claim; counter-positioning is another. Both must pass the 3-question test. |
| §3.5 Banned hooks | §10 Banned phrases | Existing-category hooks are banned at BOTH the category level (this playbook) AND the language level (Copy Playbook). Both filters apply. |
| §4 First frame | §3 Hook architecture | The first frame of a video is the hook. The same 3-question test applies to the visual + on-screen text. |
| §5 Single CTA | §6 CTA discipline | This playbook adds the launch-day CTA-library requirement; the Copy Playbook covers the LANGUAGE of the CTA (verb choice, brevity, banned closes). |
| §6 First-hour orchestration | (not covered in Copy Playbook) | This is OPERATIONAL. The Copy Playbook covers WHAT you write. This covers WHEN/HOW you ship. New territory. |

When in doubt, the Copy Playbook wins on language questions; this playbook wins on mechanics questions. They do not contradict.

---

## §9. Launch readiness checklist

Before any launch ≥ Tier 2 importance, walk this checklist. If ANY box is unchecked, the launch is not ready. Delay over ship-weak.

### §9.1 Copy and creative

- [ ] **Hook passes the 3-question test.** Names a new category OR counter-positions against an existing one. Validated against Copy Playbook §3.1.
- [ ] **Weapons check passed.** Invention novelty ≥6, copy intensity ≥6 on every line of the post. (Copy Playbook §4.)
- [ ] **Banned-phrase scan clean.** No "powerful," "seamless," "intelligent," "stay tuned," etc. (Copy Playbook §10.)
- [ ] **Identity-strip test passed.** Post can't be stripped of `@instaclaws` / `@coopwrenn` / `instaclaw.io` and still read as generic. (Copy Playbook §10.)
- [ ] **Every claim traces to a receipt.** Either in Copy Playbook §9 Receipts Library or flagged as aspirational. (Copy Playbook §9.)

### §9.2 Video

- [ ] **Video exists.** Meets at minimum Tier-C standard (§2.4). Duration 42s-3min.
- [ ] **First frame is one of the three archetypes** (§4.2). Founder-talking-head intro is NOT the first frame.
- [ ] **2-second scroll-stop test passed** (§4.5). Imagine in a muted scrolling feed — does it stop?
- [ ] **Captions burned in.** Works on mute.
- [ ] **Aspect ratio appropriate for target audience.**

### §9.3 CTA

- [ ] **One destination, one verb** (§5.2). Named in one sentence.
- [ ] **Destination is in the InstaClaw CTA library** (§5.4) — or deliberately added as a new entry.
- [ ] **No banned closes** (§5.5).

### §9.4 Launch mechanics

- [ ] **Amplifier roster is current and pre-warmed.** T-7 DMs sent. T-24h copy shared with Tier 2 amplifiers.
- [ ] **Founder calendar is cleared for T+0 to T+2hr.** No meetings, no demos, no other work.
- [ ] **Cross-account quote-tweet pre-drafted** (@coopwrenn ↔ @instaclaws). Ready to send 5-10 min after primary.
- [ ] **Launch time is optimized for buyer's timezone**, not founder's. No Sunday-evening / Friday-late-afternoon launches.
- [ ] **Video upload tested on a scratch account** to confirm no X compression / format issues.

### §9.5 Final gate

- [ ] **All four playbook docs in active context** — this one, the Copy Playbook, the Receipts Library, the relevant CLAUDE.md rule (Rule 55).
- [ ] **Cooper has reviewed and approved final draft.** Per durable instructions, no launch ships without explicit Cooper sign-off.

If ANY checkbox is unchecked: **stop. Delay. Fix.** A delayed launch ships strong; a rushed launch dies at 50K views and burns the topic for future attempts.

---

## §10. Companion rule (for CLAUDE.md)

Rule 55 in `CLAUDE.md` currently activates the Copy Playbook on `/viral` / `/launch` / `/post`. With this playbook landed, Rule 55 must be updated to load **both** docs on activation. The two-doc load is mandatory; the keyword triggers do not differentiate.

Proposed Rule 55 update (already specified in the commit that lands this playbook):

> When Cooper types `/viral`, `/launch`, or `/post`, the terminal MUST immediately:
> 1. Read `instaclaw/docs/viral-copy-playbook.md` end-to-end (all 15 sections) AND `instaclaw/docs/viral-launch-playbook.md` end-to-end (all 10 sections). Both, not either. No skimming. No partial loads.
> 2. Load Copy Playbook §9 Receipts Library AND Launch Playbook §3.4 Category Library + §5.4 CTA Library into active context.
> 3. Enter copy mode per the Copy Playbook's §0.1 protocol.
> 4. If the request involves shipping a launch (not just a one-off post), additionally walk the Launch Playbook §9 Launch Readiness Checklist before drafting.

The rest of Rule 55 (banned-in-copy-mode patterns, identity-strip test, exit criteria) carries over unchanged.

---

## §11. Document maintenance

### §11.1 When to update

- A launch lands that validates a new category framing → append to §3.4.
- A launch lands that validates a new opener archetype → append to §4.2.
- A launch lands that uses a new CTA destination → append to §5.4.
- A pattern from the dataset proves to NOT apply to InstaClaw context → flag it in the relevant section but do not remove it from the chain (the chain is canonical).

### §11.2 When NOT to update

- A single failed launch is not evidence to remove a pattern. The dataset is N=100. One counter-example doesn't override the trend. Investigate the failed launch's execution before blaming the playbook.
- A new "hot framework" from a content marketer's thread is not evidence to add a pattern. The 5 patterns here came out of 100-launch quantitative analysis. Bar for new patterns: equivalent or better evidence.

### §11.3 Append-only conventions

This doc is **append-only** for the live libraries (§3.4 Category Library, §4.4 Opener Candidates, §5.4 CTA Library). Receipts get added; nothing gets quietly deleted. If a category framing stops working, mark it deprecated but leave the entry — institutional memory matters more than tidiness.

---

*End of Viral Launch Playbook. Total sections: §0 through §11. Companion doc: `viral-copy-playbook.md` (15 sections). Both must be loaded for any /viral, /launch, or /post invocation.*
