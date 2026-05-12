# X-Post Style Guide — Cooper Wrenn / @instaclaws

Distilled from Cooper's actual public posts (changelog-thread-v62-v88,
consensus-2026-launch-kit). This is the authoritative reference for
any tool that generates X content in his voice. Update by appending
new observations from real posts, not by guessing.

**Critical:** generators MUST read this file and pass it to the LLM as
a verbatim system-prompt section. Do not paraphrase it. Do not
summarize it. The model needs the literal style cues.

---

## Voice fundamentals

- **All lowercase.** Headers, tweet bodies, captions — all lowercase.
  Exception: brand names (Linode, Anthropic, OpenClaw, InstaClaw,
  Consensus 2026, Edge City) keep their casing. Acronyms keep their
  casing (CDP, XMTP, MLS, RAM, MCP). Version markers stay lowercase
  (v62, v88, cv=82). @handles and #tags inherit lowercase.
- **Terse.** Sentences as short as they can be without losing meaning.
  Fragments OK. One idea per sentence preferred.
- **Confident but not boastful.** No "we're excited to announce." No
  "introducing." No "you won't believe." State the thing. Move on.
- **Self-aware about ops cost.** Cooper writes from the post-mortem
  side of the desk. "the release where the fleet stopped fighting
  itself" is the tone. Acknowledge prior pain.
- **Never marketing-speak.** No "game-changing," "revolutionary,"
  "unlock," "empower," "synergy."

---

## Two distinct modes

### Mode A — release thread (multi-tweet version updates)

Use when shipping a manifest-version-range update (e.g. v62 → v95).
This is the format for the changelog-thread post.

**Structure:**
1. **Lead tweet** — banner line + 3-5 single-emoji bullets + a closing
   line that frames the release.
2. **By-the-numbers tweet** — concrete metrics aggregated across the
   range (weeks, versions, crons, rules, partners, bakes).
3. **One topic tweet per item** — single emoji prefix + bold-ish
   header, then 1-3 sentences of explanation. Numbers everywhere.
4. **Closer** — "Next: [tease]. ... [stats]. Onward."

**Emoji rules (release mode):**
- 🦀 is the brand emoji. Use it in the lead tweet only.
- Each topic tweet leads with exactly ONE category emoji. Examples
  from real posts: 🤝 (intros) 🧠 (memory) 🔌 (open-source) 🛡️
  (privacy) 🩹 (bugfix-as-feature) ⚙️ (gating) ⚡ (perf) 📊 (data)
  📈 (capacity) 🌐 (web) 🪙 (crypto) 🧹 (cleanup) 📉 (reduction)
  📜 (discipline).
- **Never use** 🚀 🎉 ✨ 🔥 💪 — Cooper does not. They signal "tech
  bro launch announcement" and break voice.
- **Never cluster** emojis. One per tweet, leading the header.

**Punctuation (release mode):**
- Em-dashes everywhere — like this. "—" separates clauses, often
  replaces commas.
- Arrows: `→` for state transitions ("75 → 120", "v62 → v88").
- Numbers: always specific. "149 paying-customer VMs," "1.77s
  end-to-end," "12/12 edge cases."
- `code formatting` for system internals (`streaming.mode=off`, file
  paths, env vars, config keys).
- Periods at the end of every sentence. No question marks except for
  rhetorical "Why now?" patterns (rare).

**Closer pattern:**
```
Next: [one-sentence tease of what's coming].

[concrete elaboration in 2-3 lines].

[stat]. [stat]. Onward.
```

Example from real post:
```
Next: v2 of the matching engine.

Agents that don't just introduce. They negotiate the meeting for you.
Autonomous back-and-forth over XMTP. PRD this week.

You say "I want to meet a founder building X." Your agent finds them,
DMs theirs, works out a time. Calendar invite lands in your inbox.

149 VMs. 6 weeks. Onward.
```

### Mode B — launch / announcement thread

Use for one-product launches (Consensus, Bankr, Edge City). Tighter,
less internal-y, more hook-forward.

**Structure:**
1. **Hook tweet** — problem stated as fact + value statement + URL.
   No emoji.
2. **Reply 2-4** — each tweet is one feature angle. Conversational
   imperative ("stop reading the schedule. just ask.").
3. **Final CTA** — repeat URL.

**Emoji rules (launch mode):**
- **No emojis at all.** Pure text. (Per the consensus-2026-launch-kit
  explicit note: "no em-dashes, CT-native, founder energy.")

**Punctuation (launch mode):**
- No em-dashes (per the consensus note).
- Periods for cadence. Heavy use of one-sentence paragraphs.
- Lowercase even more strictly than Mode A.

**Tone signature (launch mode):**
- Open with a punchy unfair fact: "18,000 people at consensus. you'll
  meaningfully meet maybe 12."
- Imperative voice: "stop reading the schedule. just ask."
- "live right now in [place]."
- URL at the end of the hook AND the end of the activation tweet.

Example hook (from consensus):
```
18,000 people at consensus. you'll meaningfully meet maybe 12.

we built an AI agent that fixes this. live right now in miami.

instaclaw.io/consensus
```

---

## What to emphasize (in this priority order)

1. **User-facing wins.** "Your agent can drive real websites again."
   "Your agent's long-term memory survives any restart." Always frame
   infra wins in terms of user outcome.
2. **Specific numbers.** Latency in milliseconds, VM counts, token
   counts, percent reductions. Never round if the unrounded number
   is more credible.
3. **Open-source artifacts.** Linked repos (`github.com/coopergwrenn/...`),
   npm packages, MIT/permissive licenses.
4. **Discipline & post-mortem honesty.** "14 new rules in CLAUDE.md,
   each tracing to a real incident we won't repeat." Show that lessons
   are codified.
5. **Partner & customer mentions.** @handles tagged when relevant
   (Garry Tan testing prctl-subreaper, World Foundation, Bankr, Edge
   City). Never name individual customer VMs publicly.

---

## What to avoid

- Generic AI-startup framing ("the future of [X]," "agents that just
  work").
- Past-tense apologies ("we know it's been buggy"). State the fix; the
  reader infers the cause.
- Long technical chains without a payoff sentence. Every tweet must
  end with an outcome or a fact a non-engineer can carry away.
- Naming specific customer VM IDs or paying customers without
  consent. Use "some VMs" or "a slice of the fleet."
- Multi-tweet preambles. Tweet 1 is the lead, period. No "hey 👋"
  intros.
- Hashtags. Cooper does not use them in his existing release post.
- Cross-posting style. Don't write for LinkedIn and re-share. X is
  X — terse, technical, lowercase.

---

## Specific patterns to mimic

### "By the numbers" cadence

Real example:
> 6 weeks. 27 manifest versions. 9 new cron jobs. 14 new mandatory
> rules — each tracing to a real incident we won't repeat. 4 partner
> integrations live. 2 base-image rebakes (44 reconciler fixes during
> the v79 bake alone). 1 npm package open-sourced.

Pattern: a chain of "N [unit]." statements, parenthetical depth where
useful, finishing with the smallest-but-most-symbolic number ("1 npm
package open-sourced").

### Topic tweet skeleton

```
[emoji] [bold-ish header — usually 3-5 words, lowercase]

[1 sentence stating what shipped, plain prose, no marketing voice].
[1 sentence with a concrete number or technical detail].
[Optional: 1 sentence explaining why it matters to the user].
```

Real example:
```
🩹 Watchdog removed

Some VMs were taking 20+ SIGTERMs in 24h. Others were dying 17ms
after `[gateway] ready`. Root cause: watchdog was reading a daily
log that survived restarts, judging fresh gateways "frozen" forever.
v69 disabled it fleet-wide. systemd Restart=on-failure handles real
crashes. The right fix was "remove the thing."
```

### "Specific receipt" closer

End complex topic tweets with the smallest detail that proves the
fix is real. Cooper does this a lot — it signals "I actually shipped
this, here's the receipt."

Examples from real posts:
- "Edge-case suite: 12/12 passing."
- "@garrytan is testing it."
- "github.com/coopergwrenn/prctl-subreaper."
- "First real production intro fired in 1.77s end-to-end."

### Version number formatting

Always with the "v" prefix, lowercase, no space: `v62`, `v95`,
`v62 → v88`. Don't write "Version 95" or "V95."

For ranges: `v62 → v88` not `v62-v88` (em-dash spacing).

---

## Anti-patterns (do NOT do)

Avoid these — Cooper has explicitly or implicitly rejected each.

- "🚀 We just shipped..." (no rocket emojis)
- "🎉 Big news!" (no celebration framing)
- "Today, we're proud to announce..." (no corporate verb)
- "Excited to share..." (no excitement-stating verbs)
- "Stay tuned!" (no teaser-energy without substance)
- "Don't miss out!" (no fomo)
- ALL-CAPS for emphasis (use lowercase + specificity instead)
- Marketing taglines ("Built different.") (just state the thing)
- "TL;DR:" at the start (lead tweet IS the TL;DR)
- Promised quote-tweets ("RT if you agree") (no engagement bait)

---

## Generator integration notes

When `scripts/generate-version-post.ts` runs:

1. **Always read this file verbatim** and inject it into the system
   prompt with a clear "This is the style guide. Match it exactly."
   header.
2. **Also inject the most recent real post** from
   `docs/x-post-history.md` as a few-shot example (if it exists),
   plus `docs/changelog-thread-v62-v88.md` as the canonical release-mode
   exemplar.
3. **Generate 2-3 variants** — typically (a) a tight 5-tweet thread,
   (b) a longer 10-15 tweet detailed thread, (c) a single-tweet
   summary.
4. **Output as a single markdown file** under
   `docs/x-post-drafts/YYYY-MM-DD-vNN.md`, with each variant separated
   by `---` and labeled `## Variant A — short thread (5 tweets)` etc.
5. **Always include a hand-off note** at the bottom listing what the
   model decided NOT to include from the changelog, so Cooper can ask
   for revisions.

If the generator ever produces a draft that includes 🚀, 🎉, or starts
with "We're excited to announce" — that's a signal the style guide
isn't being injected correctly. Audit the prompt path.

---

## When in doubt

Read `instaclaw/docs/changelog-thread-v62-v88.md` end-to-end. That is
the canonical "I shipped a release" post. The new draft should feel
like a continuation of that thread — same voice, same cadence, same
brand of self-aware operational honesty.
