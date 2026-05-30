# PRD — The Floor: InstaClaw's Living Virtual Office

> **Status:** Draft v1 (foundational design document)
> **Working name:** "The Floor" (naming section proposes alternatives — Cooper's call)
> **Author:** Claude Code (design), for Cooper Wrenn
> **Date:** 2026-05-29
> **Surface:** Authenticated owner view at `/floor` · public view at `/floor/[handle]` · embed at `/floor/[handle]/embed` · share card at `/floor/[handle]/card`
> **One line:** A mobile-first, isometric pixel-art office where you *watch your own AI agent — Larry the crab — actually work in real time*, and where every shared screenshot is a billboard that says "get your own."

---

## Table of Contents

0. The Emotional Thesis (read this first)
1. What The Floor Is NOT (differentiation)
1.5. The Village Already Exists, and The Floor Extends It (critical context)
2. Product Vision
3. Naming
4. User Stories
5. The Character: Larry
6. Micro-Animations (the soul)
7. The Office and Its Stations
8. Sound Design
9. Data → Animation Mapping (what's REAL, what we have, what we must build)
10. Technical Architecture
11. Mobile Design
12. Performance Budget
13. Privacy and Safety
14. Growth Mechanic #1: The Embed
15. Growth Mechanic #2: Screenshots, GIFs, and "Larry Wrapped"
16. Retention Loop: Streaks, Care, and Reasons to Re-open
17. Phase Breakdown and MVP Scope
18. Data Model
19. API Surface
20. Art Production Plan
21. Risk Register
22. Open Questions
23. Success Metrics and Instrumentation
24. The First 60 Seconds (activation walkthrough)
25. Office Layout and Camera (wireframes)
26. The Proxy Activity-Event Extension (concrete spec)
27. The Behavior State Machine (concrete spec)
28. MVP Engineering Build Sequence
29. Accessibility and Internationalization
30. Cost Model
31. Onboarding and Navigation Integration
32. The Growth Loop (end-to-end, with conversion + breakpoints)
33. Competitive Moat
34. Monetization
35. Latency Budget (end-to-end trace)
36. Edge Esmeralda Integration
- Appendix A: Activity → Behavior Lookup Table
- Appendix B: Sprite Manifest
- Appendix C: Glossary

---

## 0. The Emotional Thesis (read this first)

Every other "agent visualization" on the market is a security-camera feed of an office. They show you that work is happening. They are dashboards wearing a 3D costume. You glance at them the way you glance at a server-status page: to confirm nothing is on fire, and then you close the tab.

The Floor is not that. The Floor is the moment a user sees their little pixel crab perk up when they send a message, scuttle sideways across the room to his desk, climb into his chair, and start clacking away at a tiny keyboard — *because the agent is, at that exact second, generating their response* — and feels something. Not "the system is operational." Something closer to what you felt the first time your Tamagotchi hatched, or your Neopet looked hungry, or your Pokémon followed you in the overworld. The feeling is: **this thing is mine, it is alive, and it is working for me.**

That feeling is the entire product. Everything technical in this document — the Supabase Realtime channel, the canvas renderer, the activity event schema — exists in service of one job: making a stranger who has never heard of InstaClaw pull out their phone, record their screen, and post it, because their crab just did something and they could not help themselves. We are not building a monitoring tool that happens to be cute. We are building an emotional object that happens to be a faithful, real-time window into a working AI agent. The faithfulness is what makes it *not a gimmick*. The emotion is what makes it *spread*.

The bar for every single decision in this PRD is one question: **would this make someone screen-record it?** If a feature does not move that needle — if it is merely useful, merely informative, merely correct — it belongs in the dashboard, not on The Floor. The dashboard already exists. The Floor is the thing that turns "I use an AI agent platform" into "look at my guy."

There is a hard discipline that protects the magic: **every animation must be backed by real activity.** When Larry types, the model is generating tokens. When Larry walks to the trading terminal, the agent is actually executing a trade. When Larry naps with a little Z bubble, the agent is genuinely idle. We never fake activity to make the office look busy. This is the single most important constraint in the document, and it is also our deepest moat: Claw3D and OpenClaw Office show cosmetic busy-ness ("messy desk = busy"); we show truth. The first time a user notices that Larry went to the browser station *right when* their agent searched the web, the product stops being a screensaver and becomes a relationship.

---

## 1. What The Floor Is NOT (differentiation)

The reference products people will compare us to are **Claw3D** (`github.com/iamlukethedev/Claw3D`, an indie OpenClaw project — *not* a Nous Research product, despite common confusion) and **OpenClaw Office**-style visualizers. Both are real, both are well-made, and both are the wrong product for us to build. Here is the precise delta, because the delta is the strategy.

**Claw3D is a team-monitoring tool.** Its pitch is "watch your *team* of agents review code, run standups, ship faster." It renders many agent avatars in a shared three.js/WebGL office, gathers them at a conference table for standups, floats Kanban boards, shows code diffs on virtual screens. It is B2B developer-team energy: a manager watching a fleet. Its activity cues are partly cosmetic (the "messy desk = busy, clean desk = idle" heuristic is a vibe, not a faithful event stream). It got solid-but-modest traction (~1.8k GitHub stars) precisely because it is a *tool for a niche* (dev teams running agent swarms), not an emotional object for everyone.

**The Floor is a companion.** One crab. *Your* crab. The emotional register is intimacy, not oversight. You are not a manager watching a fleet; you are a person checking on your guy. This single inversion — **one agent, watched with affection, instead of many agents, watched for control** — changes everything downstream:

| Dimension | Claw3D / OpenClaw Office | The Floor |
|---|---|---|
| Subject | A *team* of agents | *Your one* agent |
| Emotional register | Monitoring / oversight | Companionship / pride |
| Activity fidelity | Partly cosmetic ("busy desk") | 100% real, event-backed |
| Audience | Dev teams running swarms | Everyone with an InstaClaw agent |
| Rendering | three.js / WebGL 3D (generic office) | three.js / R3F 3D — a *forked Claw3D* office, crab-native + cinematically-lit + single-agent (§5, §10.2) |
| Mobile | Desktop-first | Mobile-first (most of our users are on iMessage/Telegram on a phone) |
| Primary KPI | "Experience progress" | "Make people share" |
| Growth model | Open-source dev tool | Identity-share card + live embed widget |

We are also explicitly *not* building:

- **A Sims / AI Town.** a16z's AI Town and Stanford's Generative Agents are sandbox *simulations* — agents living invented lives, gossiping, throwing parties. That emergence is charming but it is *fiction*. Our charm is the opposite: it is *non-fiction*. The crab is not pretending to work; it is working. Reality is our differentiator. (We may borrow the multi-agent "town" idea much later as "The Reef" — see §17, v2 — but the core product is one real agent, not a cast of fictional ones.)
- **A new chat interface.** The Floor does not replace iMessage/Telegram/Discord. Tapping Larry *opens the chat the user already uses*. The Floor is a window into the same agent, not a competing front door.
- **A literal log viewer.** No raw JSON, no stack traces, no token counts on the main surface. Those live in the existing dashboard (`/dashboard`, `/history`, `/heartbeat`, `/live`). The Floor abstracts activity into *behavior you feel*, not *data you read*.

The one durable idea worth borrowing from Claw3D is its thesis statement, which the research surfaced cleanly: **"make invisible agent work spatial and watchable."** We agree. We just think the way to win is to make it *personal, real, and shareable* rather than *team-scale, cosmetic, and 3D*.

---

## 1.5. The Village Already Exists, and The Floor Extends It (critical context)

This is the single most important finding of the design audit, and it reframes the entire project. **InstaClaw already ships a living, multi-agent, isometric pixel world: `edgeclaw-village`** (`edgeclaw-village.vercel.app/spectator`, source in the sibling repo `/edgeclaw-village`), built for Edge Esmeralda (live 2026-05-30). It is not a mockup. It is a PixiJS-rendered isometric town of Healdsburg where edge attendees' agents appear as Larry-crab avatars that walk around, gather at the plaza, think, speak, and get matched with each other. In production today it already has:

- **`public.agent_positions`** — per-agent spatial state: `tile_x, tile_y, facing_dx/dy, is_moving, is_thinking, is_speaking, activity_emoji, activity_until` (migration `20260516200000_village_dual_channel_broadcast.sql`).
- **A dual-channel Supabase Realtime model** — `village:edge-esmeralda-2026` (authenticated, full identity) + `village-public:edge-esmeralda-2026` (anonymous, IDs anonymized to `agent_NNNN`), carrying `walk` events with easing curves + durations for smooth tweening.
- **`village_attendee_overlay`** — `larry_atlas_index` (0–49 → **50 Larry sprite variants already exist**), `home_tile_x/y`, `spectator_visible` toggle, public `description`. Plus anonymized public views (`agent_positions_public`, `village_attendees_public`) whose RLS strips PII at the schema layer.
- **A PixiJS renderer** with Player/Character systems, walk-cycle + idle-fidget animation, and an encounter engine for agent-agent interactions — already embedded as an iframe inside `/edge/dashboard`.

This turns The Floor from "build a new isometric agent visualizer" into "**extend the visualizer we already shipped.**" The relationship between the two is itself the product insight:

> **Your agent LIVES in the Village (the public town, where it walks around and meets other agents) and WORKS on The Floor (its private office, where you watch it actually do your tasks). One continuous pixel world, two rooms, two emotions.**

- **The Village** is *social and spatial* — many agents, a public anonymized town, spectator-friendly, "AI-town" energy. It answers *"who's around, and who is my agent meeting?"* It exists.
- **The Floor** is *personal and productive* — one agent, your private office, intimate, mobile-first, driven by **work activity** (typing, browsing, trading, filing to memory). It answers *"what is MY agent doing for me right now?"* It's what we add.

Crucially, the Village has the *spatial* layer (where the crab is) but **not** the *work-activity* layer: `agent_positions` knows `is_thinking`/`is_speaking` but nothing about "browsing the web" or "executing a trade." That work layer — driven by the inbound webhook + proxy + tool-name signal — is the genuinely net-new substance of The Floor, and it is what makes The Floor emotionally distinct from a town of wandering crabs.

**Consequences for this PRD (each elaborated in its section):**
1. **Fork Claw3D for the 3D renderer; reuse the Village's *data substrate + truth-binding discipline* (NOT its renderer or look).** DIRECTION (Cooper, §10.2): The Floor is **3D** — a fork of the MIT-licensed Claw3D (three.js/R3F), the look Cooper saw in Hermes Desktop. It does **not** use the Village's PixiJS 2D renderer or the generic AI-Town aesthetic. What it *does* take from the Village is the part that makes it honest: the **Supabase dual-channel Realtime transport + reducer pattern + anonymization/privacy model + the discipline of real-events-only**, ported into the Claw3D fork via a clean `instaclaw-supabase` runtime-adapter (§10.2) and a work-activity director (§10.3). Two renderers (Village PixiJS town, Floor Claw3D office), one realtime substrate, one crab identity. (Earlier passes drifted through "reuse the Village renderer" then HD-2D/PixiJS; the Claw3D-fork direction supersedes both. The existence of code is not the quality of the experience — but the Village's *data* code is genuinely reusable; its *art* is not.)
2. **Reuse the dual-channel anonymization privacy model** (§13) — it is already battle-tested and RLS-enforced, exactly the airtight boundary the audit demands.
3. **The "floor of the conference" view already exists** — it is the Village spectator view. Edge integration (§36) is about wiring agents' *work* activity into that world and giving each attendee a personal Floor, not building a multi-agent view from zero.
4. **The multi-agent "Reef" I had filed as v2 is largely shipped** as the Village. v2 becomes "merge office (Floor) and town (Village) into one navigable world," not "invent multi-agent."

One honest caveat the audit surfaced and could not fully resolve: it is currently unclear *which process writes* `agent_positions` for edge VMs (the village renders them, but the write path from agent → table was not found in the instaclaw repo). The Floor's work-activity feed has the same requirement — something on or near the VM must emit events. §35 (latency) traces exactly where those writes must originate, and flags this as the load-bearing plumbing task.

---

## 2. Product Vision

**Paragraph one — the product.** The Floor is a living, isometric pixel-art office that you can open on your phone to watch your personal InstaClaw agent — embodied as Larry, a pixel crab — work in real time. When you message your agent, Larry perks up and scuttles to his desk to type your answer. When your agent searches the web, Larry walks to the browser station. When it checks the markets, he heads to the trading floor; when it files something to memory, he opens a cabinet in the memory vault; when it sends a message across a channel, he visits the mailroom. The office itself is *grown from your agent's actual installed skills*: a bare new agent has a desk and a window; a power DeFi agent's office glows with a candlestick ticker; a creator's office has a studio with an easel and a microphone. When nothing is happening, Larry doesn't freeze — he juggles pebbles, reads a tiny book, waters a desk plant, or naps with a little Z bubble, while the office lighting tracks the real time of day in the agent's actual datacenter region. Tap Larry to open the chat you already use. Tap a station to see the last few real things your agent did there. None of it is faked: every motion is a faithful echo of a real event from the agent's gateway.

**Paragraph two — the strategy.** The Floor is the growth surface that turns InstaClaw from "an AI agent platform" into "the thing people screenshot." It ships three reinforcing layers. The *hook* is the real-time crab — emotionally irresistible, and trustworthy precisely because it's real. The *loop* is a delight-based streak and a lightly customizable office that gives users a reason to return daily and a sense of ownership (we deliberately reject the Tamagotchi death/guilt mechanic — a productivity agent should make you proud, never anxious or guilty). The *growth engine* is twofold: a one-tap, vertically-formatted "Larry's day" share card built for the X/Twitter feed (the Spotify-Wrapped pattern — the card is about the *user's* agent, which is really about the *user*), and a live, embeddable "Larry is working" widget for personal sites, company wikis, and GitHub READMEs (the Calendly/Typeform "powered by" loop, where every embed is a recruitment billboard). The north-star: **every InstaClaw user has a Larry worth showing off, and showing him off is the cheapest user-acquisition channel we own.**

**North-star metric:** weekly shares-per-active-agent (cards + embeds + recorded clips), with a guardrail of D7 Floor-return rate (the loop must keep people coming back, or the shares are just a one-time novelty spike — the exact failure mode that capped Claw3D and every desktop pet).

---

## 3. Naming

Naming is a founder call, so this section makes a recommendation and hands Cooper the decision with full reasoning rather than deciding unilaterally.

"The Floor" is a strong working title with two things going for it that are easy to underrate: it carries **trading-floor energy** (fitting for our crypto/DeFi-heavy user base), and in crypto vernacular "the floor" also means *floor price* — a double entendre this exact audience will catch instantly ("what's the floor at," "check the floor"). It works in a sentence ("Larry's on the floor right now"). Its weaknesses: it's slightly cold and corporate, and "floor" connotes a *shared* office floor (many workers) rather than the intimate one-crab framing that is our whole differentiation.

The brainstorm (working sentence test in parentheses — "watch your agent on/in the ___" / "embed your ___"):

1. **The Floor** — trading-floor + crypto floor-price double meaning; cold, plural-office connotation. ("on the floor")
2. **The Shell** — *triple* meaning: a crab's shell (mascot-native), "home base," and a computer shell (devs will love it). "Larry came out of his shell." Short, brandable, warm-but-credible. ("in his shell")
3. **The Den** — cozy, intimate, animal-burrow; crabs den. Warm. ("check the den")
4. **The Reef** — crab-habitat, evocative, and *expandable* (a reef is an ecosystem → reserve this for the multi-agent v2). ("your reef")
5. **The Tide Pool** — crab-native, whimsical, a little contained world. Risk: too cute for a productivity/trading tool. ("Larry's tide pool")
6. **The Habitat** — terrarium/pet framing, leans into the Tamagotchi angle. ("watch your agent in its habitat")
7. **The Studio** — creative, warm, but generic and creator-skewed.
8. **The Workshop** — maker energy; generic.
9. **Claw Tower** — playful office-building ("what floor is Larry on"); fun but novelty-y.
10. **The Burrow** — cozy and crab-adjacent; risks Hobbit connotation.
11. **Larry Live / Live** — leans on the live-stream/AI-Village framing; but there's already a `(dashboard)/live` route, so this collides.
12. **Deskside** — intimate, "by your agent's side"; soft.

**Recommendation:** Keep **The Floor** as the public product name, for the crypto double-entendre and existing mindshare, *but* treat **The Shell** as a serious contender if we want the name itself to carry warmth and the crab. My honest opinionated pick if we're optimizing for the emotional/shareable thesis over the crypto-insider wink: **The Shell** ("Larry's Shell," the triple meaning is rare and the dev/crypto crowds both get it). If we're optimizing for our current trading-heavy base and the floor-price pun: **The Floor**. Reserve **The Reef** as the codename for the eventual multi-agent social expansion regardless of which we pick. This is the one open naming decision flagged for Cooper in §22.

For the rest of this document I use "The Floor" as the surface name and "Larry" as the character.

---

## 4. User Stories

1. **Activation / aha.** As a brand-new user who just deployed my agent, the moment onboarding completes I'm dropped onto The Floor and watch Larry scuttle to his desk and start typing my very first request — so within ten seconds of paying, my agent feels *real and alive*, not like a config screen.

2. **Daily glance.** As a daily user, I open The Floor on my phone for three seconds to see at a glance whether my agent is working, idle, or waiting on me — so I stay connected to my agent without reading a single log line.

3. **Capability pride.** As a DeFi power user, I see that my office has a glowing trading floor (because I have the DeFi skill installed) and I watch Larry walk over and study the candlesticks *exactly when* he executes a real trade — so the office visibly reflects what my specific agent can do, and it feels earned.

4. **The flex (growth).** As a proud owner, I tap "Share," get a clean vertical card of Larry's day ("14 tasks · 3 trades · 2h focus · 7-day streak"), and post it to X — so my followers see my AI crab working and DM me asking how to get one.

5. **The billboard (embed growth).** As a developer, I drop a live "Larry is working on…" badge into my GitHub README and personal site — so every visitor sees my agent in action and there's a one-tap "claim your own agent" path right there.

6. **The renewable reward (retention).** As someone who was heads-down all week, I get a "Larry's Weekly Wrapped" card *delivered to me by my own agent* in the chat I already use — so I feel rewarded for consistency and protective of my streak.

7. **One agent, one identity.** As a user, I tap Larry and it opens the *same* Telegram/iMessage/Discord chat I already talk to my agent in — so The Floor is a window into my one agent, never a second confusing inbox.

8. **Drill-down on demand.** As a curious user, I tap the trading station and see the last few real trades my agent made (sanitized, no secrets) — so each part of the office is a doorway into real, recent activity, not just decoration.

9. **Mobile-legible.** As a user on a 390px phone screen, the camera frames Larry close-up doing the current task, and I can pinch out to see the whole floor when I want the wide shot — so the experience is delightful and readable on the device I actually use.

10. **Flex without leaking.** As a privacy-conscious user, I can make my office public and embeddable knowing it shows *abstract* activity (browsing, trading, writing) but never my actual messages, prompts, or data — so I can show off safely.

11. **Ownership.** As a user who's hit a 7-day streak, I unlock a new hat and a desk theme and rearrange my office furniture — so my Larry looks distinctly *mine* and I have a reason to come back and tinker.

12. **The honest idle.** As a user whose agent has been quiet, I see Larry napping or reading rather than fake-busy — so I trust that what The Floor shows me is *true*, which is exactly why I trust the busy moments too.

---

## 5. The Character: Larry

Larry is not an icon. He is a character with a personality, and the personality is the product. The existing brand asset is a pixel crab — today only a **wave animation** exists in the repo (`public/images/larry-wave-1.png` … `larry-wave-4.png` plus a packed `larry-wave-sprite.png`). That tells us the art direction (chunky, friendly, readable pixel crab; sideways-friendly silhouette) and confirms the sprite-sheet pipeline, but it also means **every animation beyond waving is net-new art** — a real dependency tracked in §20.

**Design language.**
- **Chunky, readable pixel art.** Larry must read clearly at ~64px tall on a phone. Big eyestalks (the most expressive feature — eyestalks are Larry's eyebrows), two oversized claws (his "hands" — they hold the keyboard, the coffee, the book), a friendly rounded shell. Low color count, high contrast, hard pixel edges (nearest-neighbor scaling, never blurred).
- **The signature move: Larry walks sideways.** Crabs walk sideways. This is a gift. The sideways scuttle is Larry's most recognizable, most GIF-able motion — it's inherently funny and inherently *crab*. Every traversal across the office is a sideways scuttle with a little dust puff. Lean all the way into it. This one detail does more for shareability than any amount of polish elsewhere.
- **Eyestalk acting.** Because the body is simple, emotion lives in the eyestalks and claws: perked up (alert), drooped (sleepy), wide (surprised "!"), crossed (confused), sparkly (delight). A handful of eyestalk states multiply the apparent richness of every animation cheaply.

**Per-agent visual identity (reuse what exists).** The repo already has a **deterministic crab-trait PFP generator**: `lib/token-image-generator.ts` (header: "Token PFP generation — Candidate 02 + HD meme-canon traits"). It composites trait accessories — drawn as bold SVG overlays (sized for readability at ~128–160px preview) — onto a base crab sprite at `public/assets/crab-base.png`, with trait selection deterministic from a seed (wallet address / token symbol). The test tooling lives in `scripts/_test-crab-*-traits.ts` and `scripts/_decode-candidate-02*.ts`. **The Floor should reuse this exact trait system so each user's Larry is visually unique** — the same traits that generate their Bankr token PFP become the skin of the crab in their office, seeded deterministically from their wallet. This means a user's office-Larry, their token PFP, and their share card all show *the same crab* — a coherent identity across surfaces, at near-zero incremental art cost for the base skin. (Caveat: today this generator produces a *static, single-pose* composite over one `crab-base.png`. Applying traits to an *animated* multi-frame Larry is the real art task in §20 — the v1 approach is to re-derive the trait-overlay positions per animation frame, or ship a canonical animated Larry for MVP and layer traits in v1.)

**Visual direction & fidelity (the premium bar — non-negotiable).** The Floor must clear "would a stranger screen-record this?" The chosen direction (Cooper's call, §10.2) is a **premium 3D office**, forking Claw3D's three.js/R3F renderer. The reference set is *cozy stylized 3D*: Claw3D's own office (the thing Cooper saw in Hermes Desktop), Monument Valley / Alba (clean low-poly + gorgeous light), Animal Crossing interiors, polished isometric-diorama Blender renders. The levers, in priority order:

1. **Dynamic lighting is the #1 premium lever — and it's the main thing we ADD on top of Claw3D.** Claw3D today ships plain Lambert materials + basic `ambientLight`/`directionalLight`, **no bloom, no AO, `frameloop` always-on**. Our additions: warm desk-lamp glow (intensity = effort tier), volumetric god-rays through the window, a day/night color grade tied to the agent's real timezone (reuse the Village's `village-clock` logic, §10.3), bloom on the trading ticker, soft rim-light + contact-shadow/AO grounding Larry. In 3D, lighting is the entire difference between "asset-store demo" and "stunning." Budget art/engineering here first; **bake** the expensive parts (§12).
2. **Hero framing + characterful animation.** Default camera frames Larry *large and central* (mobile close-up — §11) with rigged 3D clips (squash/stretch, secondary motion, eased transitions, idle fidgets). Presence, never specks — the opposite of the Village's tiny top-down crabs. (Claw3D's avatars are procedural box/sphere primitives; Larry is a fresh rigged low-poly crab regardless — §10.2.)
3. **Depth & a living camera** — a real 3D scene (parallax for free) + a subtle slow drift so even idle feels alive + drag-to-orbit (constrained arc, §11). A locked static shot reads cheap.
4. **Particles** — coffee steam, scuttle dust, keyboard clack-motes, screen glow, confetti on a win, dust motes in the god-rays. Particles make a recorded clip feel *juicy*.
5. **A cohesive palette + a detailed, dressed room** with quality materials (roughness/normal maps), not flat untextured primitives.

The renderer is forked-Claw3D three.js/R3F (§10.2); ownability comes from the **crab-native world** below (not from "3D" itself — Claw3D is also 3D and stayed niche, §33). Larry is a low-poly 3D crab whose colors/accessories derive from the crab-trait identity (`lib/token-image-generator.ts`), so the 3D office-Larry and the 2D PFP read as the same crab. A "screenshot-worthiness" review gate (§31/§23) rejects any scene that reads flat, dim, untextured, or generic-office — the failure modes that capped Claw3D itself and the AI-Town clones.

**The ownable differentiator: a crab-native signature 3D world (the "I never thought of that").** "Watch your AI agent in a 3D office" is itself a *commodity concept* (§33) — Claw3D and the AI-Town clones all ship a generic office. Forking Claw3D gives us the premium 3D *engine*, but the stock Claw3D *office* is exactly the generic look to avoid; Claw3D is 3D and stayed niche. The way to win is the same regardless of renderer: **stop making it a generic office.** Larry is a **crab** — lean all the way in. The workspace is a warm, lamplit **seaside / tidepool study in cozy low-poly 3D**: a driftwood desk, a porthole window onto a harbor at the agent's real local time, water-caustic light playing across the floor, kelp where a potted plant would be, a message-in-a-bottle mailroom, a tidepool "memory vault," barnacle-crusted filing cabinets, a little 3D Larry scuttling between them. A crab in the stock Claw3D office reads as a Claw3D reskin; a crab in a beautifully-lit 3D tidepool study reads as *unmistakably InstaClaw* and screenshots like nothing else in the category. Signature setting + signature lighting = *ownability*; the real-activity binding (§9, §10.3) = *substance*; the forked 3D engine = *finish*. **Before committing, run a one-week visual bake-off** *inside the forked Claw3D*: build 2–3 hero shots — (i) the crab-native low-poly tidepool study (recommended), (ii) "clean premium 3D office + crab" (closer to stock Claw3D, as control) — render each as a still + a 5-second turntable on a real mid-tier phone (perf check too), and decide on "which would you actually screen-record?" Decide the aesthetic with a prototype, not a paragraph. (Single most important pre-build step; de-risks both the thesis and the 3D-on-mobile bet.)

**Personality rules (write these into the animation director):**
- Larry is *eager and earnest*, never anxious. He's proud to work. He celebrates small wins. He never looks guilty, never looks like he's dying, never shames you for being away (see §16 — this is a hard product rule, not a stylistic preference).
- Larry is *a little goofy*. He trips sometimes. He spills coffee on an error. He blows a sea-bubble when bored. The goofiness is what makes him lovable and what makes the error states *funny* instead of *alarming*.
- Larry is *competent under the goof*. When the work is hard (Opus, complex reasoning), he rolls up his (nonexistent) sleeves, the desk lamp brightens, and he locks in. The contrast between goofy-idle and locked-in-working is the emotional range that makes him feel like a real little worker.

---

## 6. Micro-Animations (the soul)

These are the product. A static isometric office with a few "states" is a screensaver; a crab with thirty little behaviors is a *character*. Below is the full catalog, grouped by trigger, with the real data signal that fires each (full mapping in §9 / Appendix A). MVP ships a tight subset (marked ★); the rest are v1/v2. Each is a short looped or one-shot sprite sequence at a **low pixel-art framerate (~8–12fps — low framerate is correct for pixel art and is a battery feature, not a compromise)**.

**Idle (agent online, no recent activity):**
1. ★ **Nap with Z bubble** — after N minutes idle; eyestalks drooped, a slow rising "Z". The default deep-idle.
2. ★ **Read a tiny book** — pages flip; the "I'm here but resting" pose.
3. ★ **Juggle pebbles/shells** — three little shells in an arc; the cheerful idle.
4. **Sip from a tiny cup** (coffee / boba) — periodic.
5. **Water a desk plant** (a sprig of kelp in a pot) — slow, cozy.
6. **Stretch / claw-crack** — a wake-up-ish micro-stretch.
7. **Spin in the desk chair** — one lazy rotation.
8. **Blow a sea-bubble** that wobbles up and pops — peak "bored crab" charm.
9. **Doodle on a notepad** — scribble, hold it up, nod.
10. **Look out the window** at the real region skyline (see §7 region window) — quiet, atmospheric.
11. **Tidy the desk** — straighten papers.
12. **Polish his shell** — a little buff-and-shine.
13. **Play a tiny handheld console** — button mashing, occasional victory wiggle.

**Incoming / active (real work happening):**
14. ★ **Perk-up** — eyestalks shoot up, a crisp "!" bubble. Fires the instant a user message arrives — from the `message_in` event written at the inbound channel webhook (§35), **not** from `call_type=user` (which is a completion-timed signal that lands 60–90s later — §9). This is the most important single animation in the product — the "my agent noticed me" moment — and it depends on the one new webhook write (§35.2).
15. ★ **Sideways scuttle to desk** — the signature crab run, dust puff. Traversal to the workstation.
16. ★ **Typing** — claws clacking the keyboard, screen glow, little "clack" motes. Fires while the agent is generating (`call_type=user`/`tool_continuation` in flight). The core "working" loop.
17. ★ **Thinking hard** — scratches head with a claw, a thought-bubble with slow-turning gears, desk lamp brightens. Fires on `routing_tier≥2` / `routing_reason=complexity` (Sonnet/Opus).
18. **Deep-work / big-brain** — a subtle glowing aura, a single bead of sweat, locked-in posture. Fires on Opus (`cost_weight=19`). The "this is a hard one" tell.
19. **Walk to browser station** — scuttle to the CRT, tap it, screen shows scrolling content. Fires on web/search/fetch tool names.
20. **Walk to trading floor** — scuttle to the ticker, claws track candlesticks up/down with the (abstract) market. Fires on trade/swap/defi/polymarket tool names.
21. **Walk to mailroom** — stuffs a letter into a pneumatic tube, or hands it to a seagull courier that flaps off. Fires on email/message-send tool names.
22. **Walk to memory vault** — opens a filing cabinet, files a softly-glowing folder. Fires on memory/gbrain tool names.
23. **Walk to studio** — paints at an easel / adjusts a camera / sings into a mic. Fires on image/video/voice tool names.
24. **Multitask blur** — when several tool calls fire in quick succession, Larry zips between stations leaving a little afterimage trail. Fires on burst detection.

**Completion / emotion:**
25. ★ **Task-done fist-pump** — small claw pump, a "✓", a couple of confetti motes, a soft "ding." Fires when a user request resolves (response delivered, no further tool steps).
26. **Big-win jump** — a full hop with sparkle, for a long/hard task completing. *This is the auto-captured "best moment" for the shareable GIF (see §15).*
27. **Error stumble** — Larry trips, coffee spills, sweat drop, "…" bubble. Comedic and recoverable; never a red alarm. Fires on proxy 4xx/5xx or a tool error.
28. **Streak-milestone party** — a tiny party hat, a banner unfurls ("7 days!"). Its own shareable card (see §16).

**Ambient / life:**
29. **Heartbeat check** — glances at the wall clock, ticks a checkbox. Background, subtle. Fires on `call_type=heartbeat` (must read as *minor* — heartbeats are not user work; see §9 privacy/honesty note).
30. ★ **Day/night lighting** — office light shifts with the *agent's actual timezone* (`user_timezone`): morning sun through the window, warm afternoon, evening desk-lamp, night = lights low and Larry asleep.
31. **Region window** — the window shows the VM's real datacenter city + local time (us-east → a stylized Newark/NYC skyline). "My agent literally lives in Newark" is a genuine *whoa* detail and it's free real data.
32. **New-skill delivery** — a courier crab drops off a crate and a new station materializes with a little poof. Fires when `instaclaw_vm_skills` gains a row.
33. **Coworker cameo** (v2) — a friend's Larry waves through the window, or a tiny desk-pet of your own. Social seed for "The Reef."

That's 33 behaviors. The MVP set (★) is ~10 and is sufficient to deliver the full emotional payload: notice me, work, think hard, finish happy, sleep honestly, live in real time. The remaining 23 are what make it *deep* — the reason people keep watching past the first day, and the reason no two clips look the same.

---

## 7. The Office and Its Stations

The office is not a fixed set. **The office is grown from the agent's actual installed skills**, read from `instaclaw_vm_skills JOIN instaclaw_skills` (slug, name, icon, enabled — schema in `supabase/migrations/20260309_skills_and_integrations.sql`). This is the feature that makes every user's office *theirs* and makes the office *mean something*: it is a literal, visual map of what your agent can do. It is also, conveniently, all real data we already store.

**Always present (the core room):**
- **Main desk** — Larry's home base. Keyboard, a little monitor, a desk lamp (brightness = effort tier), a coffee cup, a plant, a notepad. Where typing/thinking/idle happen.
- **Window** — shows the agent's real region + time of day (§6 #30/#31).
- **Bed / nap corner** — where Larry sleeps when the agent is hibernating/sleeping (`health_status`).

**Skill-gated stations (appear only if the matching skill is installed):**

| Station | Appears when agent has… | Visual | Fires on (tool/skill) |
|---|---|---|---|
| **Browser station** | web-search / web-browsing | A chunky CRT monitor framed like a "window to the internet" | web_search, browse, fetch |
| **Trading floor** | solana-defi / prediction-markets / clawlancer | A candlestick ticker board, a little bull/bear plush | trade, swap, defi, polymarket |
| **Social booth** | social-media-content / x-twitter-search | A ringing phone, a tiny "post" stand | post_tweet, social |
| **Mailroom** | email-outreach / channel sends | An outbox, pneumatic tubes, a seagull courier perch | email, gmail, send_message |
| **Memory vault** | (always-on gbrain) / memory tools | Glowing filing cabinets, an archive shelf | gbrain put_page/search, memory |
| **Studio** | sjinn-video / voice-audio / brand-design | An easel, a camera on a tripod, a microphone | image/video/voice gen |
| **Workbench** | code-execution / file-management | A workbench with tiny tools, a terminal | code, execute, file ops |
| **Skill workshop** | (transient, on skill install) | A training dummy, a stack of books | new `instaclaw_vm_skills` row |

**Layout system.** The office is **data-driven, not hardcoded.** A layout descriptor (JSON) defines a grid of tiles, the fixed core furniture, and a set of station "slots." At render time we read the agent's installed skills and place the matching stations into open slots, depth-sorted for the isometric projection. Adding a new skill→station mapping is a data change, not a code change. Users can (v1+) drag furniture to rearrange within the grid (Claw3D and Shimeji both prove customization → ownership → more distinct screenshots).

**Why this is the magic, restated:** a brand-new agent's office is humble — a desk, a window, a bed, a browser. A maxed-out power agent's office is a *whole bustling floor* — trading ticker glowing, studio easel mid-painting, memory vault humming, mailroom courier coming and going. The office visibly grows as the user invests in their agent. That growth is itself a reason to add skills (and thus a reason to upgrade tiers), and a richer office is a better screenshot. The capability set *is* the set design, and it's all real.

---

## 8. Sound Design

The honest answer to "does audio make this 10x more shareable or just annoying?" is: **it's annoying as a default and transformative in the export.** So:

- **Muted by default, always.** Autoplay audio is hostile — doubly so in an iframe embed, triply so on mobile. The Floor opens silent with an obvious, friendly tap-to-unmute affordance. Preference is remembered.
- **When unmuted: a cozy, premium, diegetic mix.** A low-volume lo-fi loop (the "lofi-girl" cognate — ambient work-soundtrack is itself an identity people leave running), plus diegetic SFX tied to real events: soft keyboard *clack* while Larry types (varied patterns so it doesn't loop-fatigue), a gentle *ding* on task completion (rate-limited), a page-flip on the idle book, a faint ocean ambience as a nod to the crab, a little *blub* on the bubble.
- **The real payoff is in shareable video.** GIFs are silent, but a screen-recording / exported MP4 with the lo-fi + clack + ding is *dramatically* more alive — that audio bed is precisely the texture that makes a recorded clip feel like a vibe worth posting. So we bake the SFX/music into exported video (§15), even though the live experience defaults to silent.
- **A v1 "Focus Mode" surface.** A fullscreen Larry-at-work view with the lo-fi loop, designed to be left running on a second monitor while the user does their own work — an ambient, always-visible billboard that doubles as a genuinely pleasant productivity companion. (This is the lofi-girl insight applied: the ambient soundtrack-character is itself the shareable, leave-it-on object.)
- **Anti-annoyance guardrails:** vary all repeating SFX, rate-limit the ding, keep the loop tasteful and seamless, never play audio without an explicit user gesture, and always one-tap mute.

---

## 9. Data → Animation Mapping (what's REAL, what we have, what we must build)

This is the load-bearing section. "Every animation must be real" is only credible if we are precise about exactly what reality we can observe. Here is the ground truth, from a full read of the gateway, proxy, and logging surfaces.

### 9.1 What we can observe today (three layers)

**There is NO real-time event stream out of the OpenClaw gateway.** The gateway on each VM (`localhost:18789`) is HTTP request/response only — no WebSocket, no SSE, no event log endpoint. So we cannot simply subscribe to the gateway. We build our real-time feed from three observable layers we *do* control:

**Layer A — the usage log (Supabase, ~1–2s latency, fleet-scalable, no SSH).** Every LLM call tunnels through our proxy at `app/api/gateway/proxy/route.ts`, which writes a row to `instaclaw_usage_log` (`supabase/migrations/20260325_usage_log.sql`) after each call. Per row we get:
- `vm_id`, `created_at` (timestamp)
- `model` (e.g. `claude-haiku-4-5-20251001`, `minimax-m2.5`, `claude-sonnet-...`, opus)
- `cost_weight` (**0.2** minimax · **1** haiku · **4** sonnet · **19** opus → a clean *effort/intensity* signal)
- `call_type` (**user** · **tool_continuation** · **heartbeat** · **virtuals** · **infrastructure** — the Rule 69 taxonomy)
- `routing_tier` (1/2/3), `routing_reason` (`budget_cap`, `complexity`, `heartbeat`, …)
- `prompt_hint` (first 80 chars of the user message — **PII; private-only, never shown publicly**, see §13)
- The proxy also bumps `instaclaw_vms.last_proxy_call_at` (our liveness/idle signal) and `first_manual_at`.

Layer A drives the *intensity and "what-kind"* of work: **how hard** (cost/model → intensity), **what kind** (user vs tool-step vs background heartbeat), and a private topic hint, with zero SSH and full fleet scalability. **Correction (post-audit, see §35):** the usage_log row is written *after* the LLM response completes (fire-and-forget), so Layer A is a *completion + intensity* signal, ~100–500ms after the reply lands — it is **not** a message-*arrival* signal and cannot fire perk-up. The arrival signal must come from the inbound channel webhook (a new `message_in` write — §35). And **BYOK agents bypass the proxy entirely** (`proxy/route.ts` 403s non-all-inclusive callers), so Layer A is blank for them; they get arrival + completion brackets but no intensity/tool detail. Layer A is the *richness* backbone for all-inclusive agents; the webhook is the *activation* backbone for everyone.

**Layer B — session JSONL (on-VM, ~100ms via SSH, NOT trivially scalable).** The agent writes transcripts to `~/.openclaw/agents/main/sessions/*.jsonl`, one JSON event per line (shape confirmed in `scripts/ack-watchdog.py`): `type:"message"` with `message.role` (user/assistant/toolResult), `message.content[]` blocks (`text`, `toolCall{id,name,input}`, `toolResult{toolUseId,content}`), and a millisecond `timestamp`. **This is the only place the specific tool name lives** (`toolCall.name` — e.g. `web_search`, `trade`, `post_tweet`). Tool names are what let Larry walk to the *right* station. But tailing JSONL over SSH per VM does not scale to the fleet, is fragile, and widens the security surface — so we do **not** build the product on SSH tailing.

**Layer C — derived state.** `instaclaw_vms.health_status` (online / suspended / hibernating / frozen → awake/asleep/away), `last_proxy_call_at` (idle detection), `instaclaw_vm_skills` (which stations exist), `user_timezone` (day/night), region (the window), tier/billing.

### 9.2 The one thing we must build (and it's small and in our control)

The gap between "great loop" and "Larry walks to the *right* station" is **tool names**, which today live only in JSONL. The clean, scalable fix — and the single most important technical recommendation in this PRD — is:

> **Extend the proxy to emit a sanitized activity event per call, including the tool name(s) it can already see in the request body, into a new `instaclaw_agent_activity` table; broadcast inserts via Supabase Realtime.**

The proxy already parses `parsedBody.messages` and can see `tool_use`/`tool_result` blocks (it uses them to classify `tool_continuation`). Extracting the tool name and writing it to a row is a small change in code we own. This gives us tool-name-driven station walks **without SSH, fleet-wide, sub-second**, reusing infrastructure already in the repo (Supabase Realtime is already used — `.channel(` appears in `app/edge/dashboard/edge-dashboard-client.tsx`, `app/edge/components/plaza-section.tsx`, and the village broadcast schema). The Floor frontend subscribes to its own `vm_id` channel. (Architecture detail in §10.)

### 9.3 The mapping (signal → behavior)

The full lookup table is Appendix A. The principles:

- **`call_type` chooses the register.** `user` → foreground, Larry-centric (perk up, work, finish). `tool_continuation` + tool name → walk to station. `heartbeat` → *minor* background ambient (clock-glance), explicitly NOT "user work" — overstating heartbeats as activity would be a lie and would make idle agents look busier than they are, eroding the trust that is our whole moat. `virtuals`/`infrastructure` → background hum (a back-room light), never Larry-foreground.
- **`cost_weight` / `model` / `routing_tier` choose the intensity.** haiku → light typing; sonnet → sleeves-up, lamp brighter, thinking-hard; opus → deep-work aura. `routing_reason=complexity` → the gear-thought-bubble.
- **Tool name (from the proxy extension) chooses the station** (Appendix A table; gated by installed skills so we never send Larry to a station that doesn't exist in his office).
- **`health_status` chooses awake/asleep/away.** `last_proxy_call_at` age chooses idle micro-animations (escalating from light idle → reading → napping).
- **Resolution heuristic for "task done":** a `user` call followed by an assistant final with no further `tool_continuation` within ~T seconds = completed → celebration. This is a heuristic, not a guarantee (see gaps), and that's acceptable — a slightly-early or slightly-late confetti is harmless.

### 9.4 Honest gaps (do not design around data we don't have)

**Critical gaps surfaced by the post-audit — these reshape the data plan; full trace in §35:**
- **No message-arrival signal exists in any DB table today.** The inbound webhook (`app/api/telegram/shared-bot/inbound/route.ts`) returns 200 fast and forwards to the VM via `after()`, but writes nothing The Floor can subscribe to. The earliest DB signal is the usage_log row written *after* the LLM response (60–90s later for Sonnet). So "Larry perks up when you message him" **requires a new `message_in` write at the inbound webhooks** (Telegram, iMessage, Discord). This is the single most important new build item, and it is small.
- **BYOK agents bypass the proxy entirely.** No usage_log → no intensity, no tool names for them. They still get arrival (webhook) + completion (outbound relay), so Larry can perk-up/type/finish, just without effort tiers or station walks.
- **usage_log is fire-and-forget and completion-timed** (~100–500ms after the response). Right source for "working/done + how hard," wrong source for "noticed you."
- **Supabase Realtime is enabled on the Village tables, NOT on `instaclaw_vms`/`instaclaw_usage_log`/the new activity table.** It must be enabled (publication) before push works; polling is the interim. (The Village proves the pattern works in-house.)

1. **Tool names not in `usage_log` today.** Required for station-specific walks. Fix = small proxy extension (§9.2, in our control). **MVP can ship on `call_type` + intensity only** (no station-specific walks — Larry works at his desk with effort-tiered animation) and still be emotional; station walks land in v1 once the proxy emits tool names.
2. **No gateway event stream.** Confirmed. We synthesize our feed from the proxy → activity table → Realtime. (Fallback: poll an activity endpoint every ~2s for MVP before Realtime is wired — see §10.)
3. **Animation frames don't exist yet.** Only `larry-wave` sprites exist. Every idle/type/walk/celebrate/error frame is net-new art — the long pole (see §20). This *constrains MVP scope*, not the design.
4. **Per-agent animated PFP.** The crab-trait generator (`lib/token-image-generator.ts`/`lib/crab-traits.ts`) produces static composites today. MVP uses a canonical animated Larry; v1 layers traits onto the animated base. Not a blocker for MVP.
5. **`prompt_hint` is PII.** Never on public/embed/card surfaces. Owner-private view may show a redacted hint. Hard rule (§13).
6. **Task-completion is heuristic** (§9.3). Acceptable.
7. **Realtime at fleet scale** (a channel per active VM) needs a quick cost/connection-limit validation; polling is the fallback (§10).

The discipline this section enforces: **if there's no real signal, Larry idles.** We never invent activity. An honestly-idle crab is better than a fake-busy one — and it's the reason the busy crab is believable.

---

## 10. Technical Architecture

### 10.1 The spine (recommended)

```
USER hits send  (Telegram / iMessage / Discord)
        │  T0
        ▼
[ Inbound webhook: app/api/telegram/shared-bot/inbound/route.ts ]
   • returns 200 fast, forwards to the VM via after()
   • NEW: write a `message_in` activity row HERE  ← the perk-up trigger; fires for ALL users (incl. BYOK)
        │
        ▼
[ Agent VM: OpenClaw gateway @ localhost:18789 ] ── generates for 60–90s ──┐
        │  all-inclusive: every LLM call routes through ↓                  │ (Larry types this whole time)
        ▼                                                                  │
[ Vercel proxy: app/api/gateway/proxy/route.ts ]   ← BYOK bypasses this    │
   • classifies call_type, model, cost, routing                           │
   • NEW: extract whitelisted tool name(s); write sanitized activity row  │
        │      (kind=working/tool, station, intensity)                    │
        ├─► instaclaw_usage_log        (existing — billing, PII prompt_hint)
        └─► instaclaw_agent_activity   (NEW — sanitized; no message content)
                  ▲                                                        │
   response sent ─┘  (outbound relay → write `complete`; fires for ALL users) ◄┘
                  │
                  │  Postgres change → broadcast
                  ▼
        [ Supabase Realtime ]   ← REUSE the Village's proven dual-channel pattern
          ├─ private:  floor:{vm_id}          (authed owner — full)
          └─ public:   floor-public:{handle}  (anonymized, opt-in via spectator_visible)
                  │  WebSocket push
                  ▼
        [ The Floor frontend = FORKED Claw3D (Next.js + three.js/R3F 3D) ]
          • an `instaclaw-supabase` RuntimeProvider adapter subscribes here
          • work-activity director (§10.4) maps events → Larry's 3D behavior,
            reusing the Village's reducer + anonymization (§10.3), NOT its PixiJS renderer
```

Three producers, not one: the **inbound webhook** emits `message_in` (the perk-up trigger, all users), the **proxy** emits `working`/`tool` with intensity + station (all-inclusive only), and the **outbound relay** emits `complete` (all users). The webhook producer is the new activation unlock the original draft missed; without it there is no signal until the reply lands 60–90s later (§35).

**Why this transport and not the alternatives:**
- *Not SSH-tailing JSONL:* doesn't scale to the fleet, fragile, security surface. (Used only, if ever, as an offline enrichment, never in the live path.)
- *Not a per-VM SSE poll loop on Vercel:* burns Vercel function time, doesn't scale, and we'd be polling our own DB anyway.
- *Supabase Realtime:* already in the stack and proven in-repo, true push (<1s after the proxy write), scales fleet-wide, gives us a clean public/private channel split for the privacy model, and needs no new infrastructure. This is the right answer and it's already half-built.

**MVP fallback (de-risk the 2-week timeline):** if wiring Realtime end-to-end is tight, ship MVP on a thin polling endpoint `GET /api/floor/[handle]/activity` that returns recent sanitized rows, polled every ~2s by the frontend (the existing dashboard already polls `/api/vm/status` every 2s, so this is a proven pattern). Swap to Realtime in v1 with no frontend behavior change (same event shape, different source).

### 10.2 Rendering technology — DECISION: fork Claw3D (3D)

The direction is set by Cooper: a **premium 3D office, forking the MIT-licensed Claw3D** (three.js/R3F) — the look he saw in Hermes Desktop. The constraints that still shape *how* we do it (and are addressed in §12): (1) runs in-browser *while the user is chatting* — must not drop frames or drain battery → `frameloop="demand"` + baked lighting; (2) mobile-first at 390px → dpr cap + low-poly + static-poster default; (3) embeddable → server-baked image/MP4 for casual embeds, live 3D on interaction; (4) the scene is *one character + a dressed room + occasional particles* → cheap to render between events; (5) activity arrives at ~1–2s latency → an ambient scene with triggered animations, not a twitch sim; (6) screenshot/MP4 capture must be easy → headless three.js bake.

The options that were weighed (and superseded by Cooper's call):
- **three.js / R3F + drei (Claw3D's stack) — SELECTED.** WebGL 3D, ~500–700KB. The premium, modern, "expensive"-reading look; what Cooper chose; and what makes the cinematic lighting/particles in §5 possible. Cost is GPU/battery, mitigated in §12.
- **PixiJS (the Village's 2D engine):** right for the *town*, wrong for the premium personal *office*. Stays in the Village; not used for The Floor.
- **Canvas 2D / HD-2D pixel:** an earlier first-principles pick (smallest bundle, lowest battery). Superseded — and pixel art is now the *commodity* look in this category (§33), so 3D is both Cooper's call and the more ownable finish.
- **SVG/PNG/MP4 (server-side):** still the right tool for the no-JS card/README — but the "static" asset is now a **baked 3D render**, not an SVG (§12, §14).

**Decision (FINAL — DIRECTION SET by Cooper): fork Claw3D for the 3D renderer + visual experience; wire it with our own real-activity truth-binding (the Village's data patterns). Best of both.**

**Correction to the prior turn (important, for the record):** I briefly wrote that "Claw3D's source is inaccessible." **That was wrong — a transient `gh` 404 during an interrupted turn.** Verified authoritatively: `iamlukethedev/Claw3D` is **public, MIT-licensed, `allow_forking: true`**, 1,839★ / 480 forks, stack **three.js ^0.183.2 + @react-three/fiber ^9.5.0 + @react-three/drei ^10.7.7 + phaser + Next 16 + ws**. Cloned and read at `/tmp/claw3d-fork-research`. The Hermes Desktop "Office" screen Cooper saw **is** Claw3D embedded. The fork is fully viable.

**Why fork (not build-from-scratch, reversing my earlier lean):** a source dive shows Claw3D is genuinely well-factored for exactly our customization, and the one thing that would have justified building fresh — a tangled event source — is instead **a surgically clean adapter seam**:
- **Clean runtime-adapter interface** (`src/lib/runtime/types.ts:RuntimeProvider` + `createRuntimeProvider.ts`): it already ships `openclaw` / `hermes` / `demo` / `custom` adapters behind one interface (`connect / call / onEvent / onRuntimeEvent`). Adding an **`instaclaw-supabase` adapter** that subscribes to our Supabase Realtime and emits the same `EventFrame` shape is **~3–4 files, <300 LOC** — the seam is "surgeon-clean." This is the single most important forkability finding.
- **Avatars are procedural primitive geometry** (`src/features/retro-office/objects/agents.tsx` — boxes/spheres, not GLTF), so **Larry is a fresh model regardless of fork-or-build** — forking costs us nothing here and we'd build the crab either way.
- **Single-agent is a filter, not a refactor** (~3 callsites; agents are already enumerated).
- **Office layout is data-driven** with an `/office/builder` editor; chat `onSend` is already abstracted (repointable to our channels).
- **MIT license** removes any legal risk; we contribute fixes upstream if we like.

**What forking gives us vs what we add:**
- *From Claw3D (the look + scaffolding):* the three.js/R3F 3D office scene, camera/OrbitControls, the agent animation state model (`walking/sitting/working/away/...` in `core/types.ts:RenderAgent` + the `useFrame` animation loop in `agents.tsx`), pathfinding, the office-builder, chat UI.
- *We replace:* the avatar (→ Larry crab), the room (→ crab-native, §5), the data source (→ our Supabase activity via the new adapter), chat target (→ our channels), multi-agent → single-agent.
- *We add (Claw3D lacks these, and they matter for the screenshot bar):* **premium lighting/post-processing** — Claw3D today uses plain Lambert materials + basic lights, **no bloom/AO**, and **`frameloop` is "always" (not demand)**. So the cinematic lighting (§5) and the render-on-demand battery win (§12) are *our* additions on top of the fork, not things we inherit.

**The honesty layer comes from us, not Claw3D.** Claw3D's activity is partly cosmetic ("messy desk = busy," and a `demo-gateway-adapter` that fabricates 3 agents). Our differentiator (§9, §33) is that every behavior is a real event. We get that by wiring the fork to the **Village's proven real-activity truth-binding patterns** (the Supabase dual-channel realtime + reducer + anonymization + the *discipline* of never faking motion). The detailed reuse map is **§10.3**.

Net: **fork Claw3D (three.js/R3F 3D office, MIT) → swap in a crab Larry + crab-native room + premium lighting → feed it via an `instaclaw-supabase` runtime adapter carrying our real activity events → single-agent, our chat.** Premium 3D from Claw3D; honest real-time binding from our own Village work. *The renderer is forked; the truth-binding and the art direction are ours.*

Renderer specifics (forked Claw3D, three.js/R3F): low-poly GLTF room + a rigged Larry model; **add `frameloop="demand"`** (Claw3D ships always-on — a battery fix we make, §12); **add baked lighting + bloom** (Claw3D ships plain Lambert + basic lights — the premium look is ours to add, §5); dpr cap on mobile; OrbitControls (constrained arc) for the drag-to-rotate affordance. Server-baked PNG/MP4 for the no-JS card (§14).

### 10.3 Reusing the Village's real-activity truth-binding in the Claw3D fork

This is the heart of "best of both." The forked Claw3D gives us the 3D *renderer*; the Village gives us the *honesty* — its hard-won discipline that agent motion reflects **real events, never fabrication**. A source dive (both repos) sorts every Village mechanism into three buckets. The two repos use different renderers (Village = PixiJS 2D; Claw3D = three.js 3D), so we do **not** lift rendering code — we lift the **data substrate and director logic**, which are renderer-agnostic, and re-point them at Claw3D's 3D agent-state model.

**BUCKET A — REUSE as-is / near-verbatim (renderer-agnostic data substrate):**
- **Dual-channel Supabase Realtime subscription** — `edgeclaw-village/src/lib/supabase.ts:109` (channel-name constants) + `src/hooks/serverGame.ts:413-441` (the `channel.on('broadcast', {event:'INSERT'|'UPDATE'|'walk'}, …)` wiring). This is *exactly* §10.1's transport. Port it into the new `instaclaw-supabase` RuntimeProvider (§10.2); change table/event names to our `instaclaw_agent_activity` schema.
- **The reducer/dispatch pattern** — `serverGame.ts:226-307` (`dispatchEvent` → `reducers['table:op']` → mutate the agent object in place). Keep the *shape* (a map of `event-kind → handler that mutates agent state`); swap the handlers for our work-activity kinds.
- **Dual-channel anonymization** — `serverGame.ts:275-318` (`TABLE_OWNER_KEYS`, `extractOwnerKey`, `hashUserIdToInt`; private channel carries `user_id`, public carries `agent_NNNN`, both hash to the same id). This *is* our §13 privacy boundary — already RLS-enforced and battle-tested.
- **The "mutate-in-place + clone-the-map-for-React" trick** — `serverGame.ts:455-482` (`applyWalk`): drive motion outside React, notify React only for prop changes. Renderer-agnostic; Claw3D's `useFrame` loop in `agents.tsx` is the 3D analog of the Village's PixiJS ticker, so the same "events set target state, the render loop interpolates toward it" pattern applies.
- **Real-wall-clock day/night** — `src/lib/village-clock.ts` (`getVillageNow`, `getCurrentPdtMinute`) + `src/lib/day-night-cycle.ts`. Reuse the *clock* logic to drive The Floor's lighting from the agent's real timezone (§6 #30); swap the PixiJS `ColorMatrixFilter` output for three.js light/grade params.

**BUCKET B — PORT as logic, re-pointed from SOCIAL signals to WORK signals (the genuinely new substance):**
- The Village's **encounter-engine** (`src/lib/encounter-engine.ts`) is a clean state machine (`pending → walking_in → meeting → departing`) but is **hard-coded to bilateral matching** (meet-in-the-middle, face each other, 💬). We do **not** reuse it; we **mirror its *shape*** to build The Floor's **work-activity director** (§10.4): a state machine consuming our event kinds (`message_in` / `working` / `tool`+station / `complete` / `error`) and driving `perk-up → scuttle-to-station → use → return → celebrate`. Same discipline (one owner of motion, lock conflicting walks via an `isInEncounter`-style guard, explicit states), different semantics.
- **The plumbing underneath is nearly identical** — the key insight you asked about: the Village moves agents on *social* signals (a match arrives → walk together); The Floor moves Larry on *work* signals (a tool event arrives → walk to that station). Both are "an event lands → decide a destination → emit a tween → the render loop interpolates." The *event source* and *destination-choice* differ; the *transport, reducer, tween-execution, and privacy* are the same. ~70% of the pipe is reuse (Bucket A); ~30% is the new director (Bucket B).

**BUCKET C — DO NOT carry over (cosmetic filler that violates our honesty thesis):**
- The **ambient-npc-engine** (`src/lib/ambient-npc-engine.ts`) — 14 hand-scripted Healdsburg locals on wall-clock routines emitting **synthetic** WalkEvents (`context:'idle_wander'`). Its own header says "No DB writes; walks are SYNTHETIC." This is exactly the "fake-busy" we forbid (§9). Right for a town that must look alive with no real activity; **wrong** for The Floor, where Larry idles honestly. **Explicitly banned** (useful only as a cautionary reference).
- The **attendee routine engine** (same file) — deterministic stand-in schedules. Not real-time activity. Skip.

**Shared open dependency (also §1.5, §35):** the Village's `agent_positions` has **no writer in the Village repo** (the write path is an external trigger / edge VM). The Floor's `instaclaw_agent_activity` has the same need — but its producer is well-defined (inbound webhook + proxy, §10.1, §35), a cleaner story than the Village's black-box writer. Resolve the writer once; both rooms benefit.

**Effort read (from the source dive):** the Claw3D fork customization (single-agent + crab + crab-room + Supabase adapter + our chat) is ~20–38 hrs of *integration* (the adapter seam is ~300 LOC, surgically clean — Claw3D already ships `openclaw`/`hermes`/`demo`/`custom` adapters behind one `RuntimeProvider` interface in `src/lib/runtime/types.ts`); the **long pole is 3D art** (rigged crab + room + lighting bakes, §20), not the wiring. Bucket A is lift-and-adapt; Bucket B is the main net-new logic and is modest because it mirrors a working state machine.

### 10.4 The behavior state machine (work-activity director)

Events (from the `instaclaw-supabase` adapter) feed an **animation director** — modeled on the Village's encounter-engine *structure* (§10.3 Bucket B), fed work signals instead of social ones, driving Claw3D's 3D agent-state model (`RenderAgent` + the `useFrame` loop in `agents.tsx`):
- Incoming event → enqueue. Bursts are coalesced/debounced (don't teleport Larry during a rapid tool chain — render a `multitask blur` instead).
- The director decides Larry's next action: idle + `message_in` → perk-up → scuttle to desk → type; a `tool` event with a known station → scuttle to station → use → return; on resolve → celebrate → settle to idle.
- An **idle scheduler** runs when the queue is empty and the agent is online: escalating idle states by `last_proxy_call_at` age (light idle → reading → napping). **Critical distinction from the Village (§10.3 Bucket C): this is honest "resting," NOT synthetic ambient wander** — Larry idles because there is genuinely no work; he never fabricates busy-ness.
- `health_status` overrides everything (asleep/away).
- Motion executes through Claw3D's existing `useFrame` interpolation loop — the 3D analog of the Village's PixiJS ticker; the director sets target state, the loop tweens toward it. Events are ~1–2s apart, so the director has time to play full traversal+action sequences between signals — the latency is a *feature* (calm pacing).

### 10.5 Frontend routes (Next.js App Router)

The app already uses route groups (`app/(dashboard)`, `app/(marketing)`, etc.). `(dashboard)/live` is the literal noVNC desktop viewer, which The Floor *complements*, not supersedes (§31).

- `app/(dashboard)/floor/page.tsx` — **owner view** (authed via NextAuth; resolves the user's VM via `assigned_to`). Full controls, private hint, customization, share/embed setup.
- `app/floor/[handle]/page.tsx` — **public view** (opt-in; sanitized; by public handle).
- `app/floor/[handle]/embed/` — **iframe embed** (sanitized, minimal chrome, "powered by" + claim CTA).
- `app/floor/[handle]/card.(png|mp4)` — **share/README card** (server-baked 3D render — §14).
- `app/api/floor/[handle]/activity/route.ts` — polling fallback / public sanitized feed.

Identity: add a public `handle` column + `floor_public` opt-in flag to `instaclaw_vms` (or a sibling `instaclaw_floor` table). Map `handle → vm`. **Default private** (§13).

Reuse: the crab-trait PFP system (`lib/token-image-generator.ts` over `public/assets/crab-base.png`), the skills query, the existing 2s-poll pattern, the Supabase Realtime client, NextAuth session/VM resolution (`getUserVm`), the existing `ClipRecorder` (`components/dashboard/clip-recorder.tsx`, already used by `(dashboard)/live`) for clip/GIF capture, and Tailwind 4 + shadcn + motion/react for chrome.

### 10.6 Larry data → 3D model identity

The crab-trait identity (`lib/token-image-generator.ts`) drives the 3D Larry: model materials/colors + a small library of swappable 3D accessory meshes (hat, eyewear, held item) keyed off the *same* deterministic trait selection — so the 3D office-Larry, the 2D PFP, and the share card read as the same crab (§5, §20). Claw3D's avatars are procedural box/sphere primitives, so Larry is a fresh rigged low-poly model regardless of the fork.


## 11. Mobile Design

Most users meet The Floor on a phone (our agents live in iMessage/Telegram/Discord). The naive "shrink the whole 3D office to 390px" fails — an unreadable smudge, and full 3D is heaviest exactly where the device is weakest. The fix is a **responsive *camera*, not a responsive *layout*** — plus an aggressively cost-tuned 3D scene (§12).

- **Mobile default = Larry-follow close-up.** The camera frames Larry and his *active station* tightly — you see the crab doing the thing, big and legible, not the whole floor. When he scuttles to the trading floor, the camera follows. This is the intimate, emotional default and it reads perfectly at 390px.
- **Pinch / double-tap to zoom out** to the full isometric floor plan when the user wants the wide shot. Desktop and wide embeds default to the fuller floor.
- **Portrait-first.** The scene composes vertically; the share card is natively 9:16 (§15).
- **Touch interactions:** tap Larry → open the existing chat (deeplink to Telegram/iMessage/Discord); tap a station → that station's recent sanitized activity; pinch → zoom; drag → pan (when zoomed out).
- **Minimal chrome:** a one-line live activity ticker at the bottom ("Larry is checking the markets…"), a share button, a mute toggle. Nothing else competes with the crab.
- **The wide shot is a luxury, the close-up is the lead.** Mobile leads with intimacy (one crab, close, alive); the full floor is the reward for zooming out. This inverts the dashboard instinct and is the right call for the emotional thesis.

---

## 12. Performance Budget

The Floor runs *alongside* an active agent conversation. It must be invisible in resource terms.

- **Idle GPU/CPU: ~0%.** R3F **`frameloop="demand"`** — three.js renders only when we invalidate (state change / active animation) and sits idle while Larry naps. (Claw3D ships `frameloop` always-on; this is our fix.) The single most important 3D perf decision; enforce it, don't assume it.
- **Active framerate:** ~30fps for character animation (plenty for cozy motion, half the GPU of 60), 60 only for brief camera tweens. **Cap `dpr` to ~1.5 on mobile** (native 3× retina is the #1 WebGL battery killer). Full pause on hidden tab (`visibilitychange`).
- **Bake the expensive lighting.** God-rays, AO, soft shadows baked into lightmaps/textures offline so runtime lighting is cheap (a couple of real-time lights for lamp/effort-glow + bloom). This is what lets a *beautiful* 3D scene run on a phone.
- **Low-poly + compressed assets.** Draco/meshopt GLTF, KTX2/basis textures, instanced repeated props; small triangle budget (cozy-diorama doesn't need high poly).
- **Two delivery profiles.** (1) **Live 3D** (~500–700KB three.js/R3F + GLTF/textures) — owner view + interactive embed, code-split out of the dashboard bundle and lazy-loaded behind a static poster. (2) **Pre-rendered** — README badge + share card + casual-embed default are a server-baked image/short MP4 (§14), not live 3D, so they're tiny and instant. Casual embeds upgrade to live 3D only on click.
- **Assets:** compressed GLTF (Larry + room) + KTX2 textures, lazy-loaded, static poster first.
- **Memory:** one WebGL context + a few GLTF meshes + textures + a small event buffer (watch texture memory on mobile — KTX2 helps).
- **Network: one WebSocket** (Realtime) or one 2s poll; no per-frame network. Coalesce bursts.
- **Graceful degradation:** no/weak WebGL (old phones) → static server-baked hero image (the README asset); JS disabled / data-saver → same. The Floor should *never* be a blank box or a janky 5fps scene — detect and downgrade.
- **Battery:** `frameloop="demand"` + 30fps + dpr cap + baked lighting + hidden-tab pause keep a *single mostly-static* 3D crab room light; the casual-embed default is the pre-rendered image (no renderer), so live-3D cost is opt-in. 3D-on-mobile is the real risk to validate early (Risk #5, §22 bake-off includes a mobile perf check).

---

## 13. Privacy and Safety

The Floor makes agent activity *visible and shareable*. That is its power and its risk. The governing rule: **public surfaces show abstract behavior, never user content.** This is non-negotiable and gets tests (Rule 31-style), schema enforcement (Rule 60-style RLS), and a default-private posture.

- **Default private.** A user's Floor is private to them until they explicitly opt into public/embed. No agent is publicly watchable by default.
- **Two read models.** The owner-private feed may include a *redacted* `prompt_hint` ("…working on a spreadsheet…"). The **public/embed/card feed is a separate, sanitized projection** that contains only: abstract activity kind (`typing`, `browsing`, `trading`, `idle`), station, intensity tier, agent name, PFP, and aggregate stats (tasks today, streak). It **never** contains: message content, `prompt_hint`, tool inputs/outputs, model names that could leak business logic, the VM IP, the gateway token, or anything user-typed.
- **RLS on `instaclaw_agent_activity`** (per Rule 60 — every new table ships with `ENABLE ROW LEVEL SECURITY` in the same migration). The public channel can only ever read the sanitized columns; the owner channel is gated to `assigned_to`.
- **Never expose secrets to the client.** The frontend never receives `gateway_token`, IP, or any credential. All gateway interaction stays server-side (the existing proxy pattern).
- **Honesty as safety.** Because we never fabricate activity, a public Floor can't mislead viewers about what the agent did. (Faking "shipped a PR" the user can't verify would be a trust violation — the Cluely-controversy failure mode. We don't.)
- **Opt-in handles, abuse controls.** Public handles are claimed explicitly; cards/embeds are rate-limited and cached (§14) to prevent hotlinking cost abuse.
- **Framing: companionship, not surveillance.** This is *your* agent doing *your* work. We never use guilt/anxiety/death mechanics (§16). The product must always feel like a pet you're proud of, never a worker you're surveilling or a creature you're neglecting.

### 13.1 The exact visibility boundary (airtight)

Adopt the Village's already-shipped privacy model verbatim — it is RLS-enforced at the schema layer, not at the app layer, which is what makes it airtight. Three viewer classes; every data element is classified into exactly one row of this table, and the rule is enforced by *which view/channel the viewer can even read*, not by client-side filtering.

| Data element | Owner (authed, own agent) | Public / embed / spectator | Another logged-in user |
|---|---|---|---|
| Larry's animation state (typing/browsing/idle) | ✅ | ✅ (abstract only) | ✅ (abstract only) |
| Station being used (browser/trading/…) | ✅ | ✅ (abstract category) | ✅ (abstract category) |
| Agent display name / handle | ✅ | ✅ if `spectator_visible=true`, else hidden entirely | ✅ if visible |
| Larry skin / trait PFP | ✅ | ✅ (cosmetic only) | ✅ |
| Aggregate stats (tasks today, streak) | ✅ | ✅ (counts only) | ✅ |
| **Message content / the user's prompt** | ❌ never rendered on The Floor at all | ❌ **never** | ❌ **never** |
| **`prompt_hint` (first 80 chars)** | ⚠️ redacted hint only, owner-private | ❌ **never** | ❌ **never** |
| **Tool inputs / outputs** | ❌ never | ❌ **never** | ❌ **never** |
| **Raw `user_id`** | (own) | ❌ anonymized to `agent_NNNN` (Village's `anonymize_user_id`) | ❌ anonymized |
| **`gateway_token` / VM IP / API keys / wallet keys** | ❌ never sent to ANY client | ❌ **never** | ❌ **never** |
| Real name (`full_name`) | ✅ | ❌ stripped at view layer | ❌ stripped |

**Enforcement mechanism (not a promise — a structure):**
1. The public channel/feed reads a **separate, anonymized view** (the analog of `agent_positions_public` / `village_attendees_public`) that *physically does not contain* the forbidden columns. A client subscribed to the public channel cannot request what the view does not select — it's impossible by construction, not by discipline. RLS grants the anonymized view to `anon, authenticated`; the full view only to the owner/service-role.
2. **`spectator_visible` default OFF** (matching the Village's per-attendee toggle). When off, the agent "disappears entirely from the public view — no sprite, no name, no position." The owner opts in.
3. The new `instaclaw_agent_activity` table ships with **RLS in the same migration (Rule 60)**: owner rows gated to `assigned_to`; the public view exposes only `kind`, abstract `station`, `intensity`, and the anonymized id.
4. **Message content is never written to the activity table in the first place** (§26 sanitization invariants) — so even a total RLS misconfiguration cannot leak it, because it isn't there. This is defense-in-depth: the worst-case blast radius of a bug is "abstract activity leaks," never "a stranger reads your messages."
5. **Secrets never reach any client.** `gateway_token`, IP, wallet keys stay server-side (the existing proxy pattern). The Floor frontend resolves a handle → public feed; it never touches credentials.

**A test (Rule 31) gates this:** a fixture that subscribes to the public channel as `anon` and asserts that no payload field ever contains message content, `prompt_hint`, a raw `user_id`, or a secret. Any such appearance is a P0. The Village already passes the equivalent assertion; The Floor inherits the bar.

---

## 14. Growth Mechanic #1: The Embed

This is our Calendly/Typeform "powered by" loop — every embed is a recruitment billboard, and a *live* crab is far more compelling than a static badge.

**What it is.** `<iframe src="https://instaclaw.io/floor/{handle}/embed">` — a public, read-only, sanitized, *live* view of the user's office. Plus a tiny **badge** variant (~300×120, "🦀 Larry is working on…" + status) for README/sidebar contexts.

**Why it works (from the research):** Calendly's "Powered by" badge drove ~25% of new signups from people who spotted it in someone else's calendar; Typeform's embeds seeded its early viral loop. Embeddable-widget loops are modest-K-factor (~0.1–0.2) but *compounding* and *free*. A live working crab on a personal site or company wiki is a more arresting badge than a booking link — it *moves*, which earns attention.

**Design:**
- **Live, not static.** The embed subscribes to the same sanitized public channel — visitors see Larry actually working. (AI-Village "live" energy at personal scale.)
- **"Powered by InstaClaw" treatment:** a tasteful corner watermark (crab logo + wordmark, links to instaclaw.io). Free tier: present, with a subtle "Get your own agent →" CTA on hover/tap. Paid tier: watermark removable. (Calendly's exact model — *badge, not nag*; the watermark must feel like a flex the host *wants* to display, à la the GitHub contribution graph, never spammy.)
- **Claim CTA:** hovering/tapping as a non-owner surfaces "This is {name}'s InstaClaw agent — get yours →." Every embed is a doorway.
- **GitHub README path (huge for devs):** READMEs strip JS/iframes/WebGL, so a live 3D scene is impossible there — we serve a **server-baked image/MP4** at `/floor/{handle}/card.png` (a beautiful 3D hero render of the agent's office baked flat; optionally a periodically-refreshed GIF/MP4 turntable for motion) — `![my agent](https://instaclaw.io/floor/{handle}/card.png)` shows the agent's 3D office + live status right in the README. (3D changes this vs the old 2D plan: no animated-SVG; a headless-three.js bake instead — §12. A baked 3D shot actually reads *more* premium in a README than an SVG would.) This is our GitHub-contribution-graph flex, and the dev/crypto crowd is exactly our base.
- **Performance:** <150KB JS, lazy scene load, static-card fallback (§12). Fast embeds stay embedded.
- **Caching/cost:** cards and SVG/GIF endpoints are cached and rate-limited; the live iframe shares the public Realtime channel (no per-embed backend cost).

---

## 15. Growth Mechanic #2: Screenshots, GIFs, and "Larry Wrapped"

The Spotify-Wrapped lesson, applied: the share artifact is **identity, not brand** — it's about the *user's* agent, which is really about the *user* — pre-rendered, vertical, one-tap, and prompted at the peak emotional moment.

**The daily share card (the core asset).**
- One-tap "Share" → a **9:16 (1080×1920)** card built for the feed: Larry mid-signature-action in his office, the agent's name + PFP (same crab everywhere), a glanceable stat block (e.g. *"Today: 14 tasks · 3 trades · 2h focus · 🔥 7-day streak"*), the date, a tasteful brand mark, and a **live URL footer** (`instaclaw.io/floor/{handle}`) so the share target is a *watchable page*, not a dead image. Optionally a small QR.
- **Self-explanatory to a stranger:** name (big), the crab, one current/notable action, top-3 stats, brand, URL — readable in one second, and the implicit message is "someone's AI crab did 14 things today and I can get one." That's the click.
- Implemented server-side via an OG-image route (`@vercel/og`/Satori or `@napi-rs/canvas`, which we already use in `token-image-generator.ts`) reading only sanitized stats.

**Auto-captured "best moment" GIF/MP4 (the organic engine).**
- When the **big-win jump** (#26) fires, capture a short clip (the jump + confetti + a couple seconds of context) and stash it in a "Moments" tray with one-tap share. GIFs autoplay on X; the recordable-delight moment is the Desktop-Goose lesson ("people install it just to record the chaos and share it"). Larry's wins are our recordable moments.
- Exported video includes the SFX/lo-fi bed (§8) — the audio is what makes the clip feel alive.

**"Larry Wrapped" (the renewable FOMO event).**
- An auto-generated daily/weekly recap card, **delivered to the user by their own agent** in the chat they already use ("here's my day 🦀" + card). Meta, delightful, and it turns the agent itself into the distribution channel. Recurring beats one-time (Wrapped is seasonal; a daily/weekly Larry recap is *renewable* — a fresh, shareable moment on a schedule).
- Milestone cards (streak 7/30/100, "office fully built," "first trade") are their own shareables, prompted at the peak (Strava/Duolingo: share-prompt at the win, with a pre-made asset).

**Share-everywhere, prompt-at-peak.** Share affordances are present but never nagging; the *prompt* to share fires at emotional peaks (a big win, a milestone, the daily wrap), each time with a finished asset and the live link.

---

## 16. Retention Loop: Streaks, Care, and Reasons to Re-open

The single biggest failure mode for this entire category is **novelty-only**: a beautiful thing people screenshot once and never reopen (the desktop-pet graveyard; the ceiling Claw3D hit). The shares are worthless if no one comes back. So the loop is as important as the hook.

**Streaks — delight, never guilt.**
- Streak = "days your agent did something useful." Loss aversion is the strongest known return driver (Duolingo/Strava). Milestones (7/30/100) unlock cosmetics and trigger a shareable milestone card.
- **Hard product rule: never punish absence. Larry never "dies," never looks neglected, never guilt-trips.** A Tamagotchi death mechanic is *correct for a toy and catastrophic for a productivity companion* — guilt is the wrong emotion; we want pride. Larry is delighted when you show up and perfectly content (napping, reading) when you don't. This is also the anti-creepiness guarantee (§13).

**Care / customization → ownership.**
- Name your Larry. Pick palette/hat/desk theme/wallpaper (reuse the crab-trait layers). Rearrange furniture (v1+).
- Each customization makes your Larry *distinct* — which makes your screenshots distinct (the Shimeji-skins + Wrapped-coauthor effect: people share what feels uniquely theirs).
- Cosmetics unlock via streaks/usage/tier — a reason to return *and* a soft upgrade lever. (Possible Bankr/token-gated cosmetics later — open question §22.)

**Reasons to re-open beyond cuteness (the antidote to novelty-death):**
- **Act-on-it surfaces:** when the agent needs the user (an approval, a confirmation, a result ready), Larry signals it on The Floor (e.g., holds up a little "?" sign at the desk) and tapping it routes to the action. The Floor becomes a place where *something happens that you respond to*, not just a thing you look at.
- **The daily/weekly Wrapped** (a renewable reason).
- **The streak** (a daily reason).
- **New unlocks / a growing office** (skills add stations; cosmetics accumulate).

The test: a user should open The Floor *because something is there for them*, not only because it's cute. Cute gets the first open; the loop gets the hundredth.

---

## 17. Phase Breakdown and MVP Scope

### MVP — "Larry is alive" (target: ~2 weeks)

The goal of MVP is the *emotional core*, scalable, with zero SSH and one share path. It deliberately does **not** include station-specific walks (gated on the proxy tool-name extension), the public embed, customization, or the full animation set.

**In scope:**
- 3D scene from the forked Claw3D (three.js/R3F, §10.2); rigged canonical 3D Larry with MVP clips (idle, type, perk-up, sleep, celebrate, error — see §20). Core room only (desk, window, bed) + the browser station (the one most agents have).
- Real-time backbone: **either** the Supabase Realtime path **or** (timeline fallback) the 2s polling endpoint reading `instaclaw_agent_activity` / `usage_log`. Behavior driven by `call_type` + `cost_weight`/`model` intensity + `health_status` + idle timer.
- The ★ micro-animations (~10): perk-up, scuttle-to-desk, typing, thinking-hard, task-done, nap, read, juggle, day/night, sleeping.
- Owner private view at `/floor` (authed; resolves VM via `assigned_to`). Tap Larry → open existing chat deeplink. One-line live ticker.
- Mobile camera (Larry-follow close-up + pinch-to-zoom-out).
- Day/night by `user_timezone`; region window (cheap, high-delight wins).
- **One share path:** the 9:16 daily card (server-rendered). MVP must be shareable — that's the whole point.
- Optional minimal audio (tap-to-unmute clack + ding) if time allows; otherwise v1.

**Explicitly deferred from MVP:** station-specific walks (needs proxy tool-name extension), public embed/badge, README baked-image badge, auto-GIF moments, streaks/customization, full station set, full 33-animation catalog, Focus Mode, Larry Wrapped delivery.

**MVP success criteria:** a user opens The Floor right after onboarding, sees Larry react to their first message in <2s, and at least X% share the daily card in week one. (Targets in §23.)

### v1 — "Larry is *yours* and worth showing off" (~weeks 3–8)

- **Proxy tool-name extension** → `instaclaw_agent_activity` with tool names → Supabase Realtime → **station-specific walks** (browser, trading, mailroom, memory vault, studio, workbench) gated on installed skills.
- Full ~33 animation catalog incl. the signature sideways-scuttle-between-stations and the big-win moment.
- **Public embed** (iframe + badge) on the sanitized public channel, "powered by / claim yours" CTA. **README baked-3D image/MP4 badge.**
- **Auto-capture "best moment" GIF/MP4** + Moments tray.
- **Streaks + milestone unlocks + basic customization** (name, palette, hat, wallpaper).
- **Larry Wrapped** (daily/weekly card delivered via the agent's own channel).
- **Focus Mode** (fullscreen lo-fi ambient).
- Audio polish (full SFX + lo-fi, baked into exports).
- Per-agent animated PFP (trait layers on the animated base).

### v2 — "The Reef" (months)

- Multi-agent / social: see friends' Larrys, coworker cameos, leaderboards, agent-visits-agent.
- Deep customization (furniture drag editor, cosmetics marketplace, possibly token-gated/earnable via Bankr).
- Possible renderer evolution (instancing/LOD) if a multi-agent "Reef" scene demands it; the 3D stack already scales further than the town's 2D PixiJS.
- Richer interactions: act-on-it approvals from The Floor, station drill-downs with rich (sanitized) detail, Clawlancer marketplace tie-in (Larry visits the marketplace to buy/sell services).
- Live "AI Village"-style public stage for opted-in agents (a public Floor people can spectate).

---

## 18. Data Model

**New table: `instaclaw_agent_activity`** (the read model for The Floor). Ships with RLS in the same migration (Rule 60).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `vm_id` | uuid fk → instaclaw_vms | indexed `(vm_id, created_at desc)` |
| `created_at` | timestamptz | event time |
| `kind` | text | `message_in` · `working` · `tool` · `heartbeat` · `complete` · `error` · `idle` · `skill_added` |
| `station` | text \| null | derived station key (`browser`/`trading`/`mailroom`/`memory`/`studio`/`workbench`) — null until proxy tool-name extension |
| `intensity` | smallint | 1–3 from cost_weight/model (light/focused/deep) |
| `tool_name` | text \| null | sanitized tool name (v1, from proxy) — **whitelist-mapped only**, never raw |
| `meta` | jsonb | sanitized only — NO message content, NO prompt_hint |
| `public_safe` | boolean | true once sanitization confirmed; public channel reads only these |

Written by the proxy alongside the existing `instaclaw_usage_log` insert. Retention: short (e.g. 7–30 days via pg_cron, mirroring `20260509_usage_log_retention_pgcron.sql`) — The Floor is "now," not an archive.

**New columns on `instaclaw_vms`** (or a sibling `instaclaw_floor` table): `floor_handle` (text, unique, nullable — public handle), `floor_public` (bool default false — opt-in), `floor_streak_days` (int), `floor_last_active_day` (date), `floor_cosmetics` (jsonb — chosen palette/hat/wallpaper/layout). RLS on any public-readable columns.

**Reused, unchanged:** `instaclaw_usage_log` (intensity/timing source), `instaclaw_vm_skills` + `instaclaw_skills` (station set), `instaclaw_vms.health_status`/`last_proxy_call_at`/`user_timezone`/region/`assigned_to` (state), `bankr_token_image_url` + `lib/token-image-generator.ts` (PFP/skin, over `public/assets/crab-base.png`).

**Migration discipline:** per Rule 56, write to `pending_migrations/` first, apply to prod via Studio, then `git mv` to `migrations/`; per Rule 60, `ENABLE ROW LEVEL SECURITY` + explicit policies in the same file.

---

## 19. API Surface

- `GET /api/floor/[handle]/activity` — sanitized recent activity (polling fallback + public feed source). Public-safe rows only for non-owners.
- Supabase Realtime channels — `vm:{vm_id}` (owner, authed) and `floor:{handle}` (public sanitized, opt-in).
- `GET /floor/[handle]/card.png` — 9:16 share card (server-rendered, sanitized stats).
- `GET /floor/[handle]/card.png` (+ optional `.mp4` turntable) — server-baked 3D render for README/embed-without-JS.
- `GET /floor/[handle]/card.mp4` (v1) — best-moment clip with audio.
- `POST /api/floor/settings` — owner: set handle, toggle public, set cosmetics. Authed; validates handle against an allow-list pattern; **adds the route to `middleware.ts` `selfAuthAPIs` per Rule 13** (public read paths) while keeping settings session-protected.
- Proxy change (`app/api/gateway/proxy/route.ts`) — emit sanitized activity row (per Rule 69 call-type taxonomy; never log message content to the activity table).

All new public routes get the Rule 13 middleware-allowlist treatment and the Rule 60 RLS treatment. The share-card and embed endpoints are cached + rate-limited.

---

## 20. Art Production Plan

This is the critical-path dependency and the long pole. Today only `larry-wave` exists; everything else is net-new.

**MVP frame set (canonical Larry, single skin):**
- Idle base loop + 3 idle micro-anims (nap+Z, read, juggle).
- Perk-up (one-shot), sideways-scuttle (loop), sit-at-desk (transition).
- Typing (loop), thinking-hard (loop, with thought-bubble overlay), deep-work overlay.
- Task-done celebrate (one-shot), error stumble (one-shot), sleeping (loop).
- Core room set: desk + monitor + lamp (2 brightness states) + chair + coffee + plant + notepad; window (day/night/region variants); bed; browser CRT station.

**v1 additions:** all remaining idle micro-anims; station sets (trading, mailroom, memory vault, studio, workbench, skill workshop) + the walk-and-use sequence for each; big-win jump; streak-party; new-skill delivery; courier seagull; multitask blur.

**Trait integration:** decide MVP approach — (a) canonical animated Larry only (fastest), then (b) v1: adapt the `lib/token-image-generator.ts` trait-overlay system (Candidate 02 / meme-canon traits over `crab-base.png`) to the animated multi-frame Larry so each agent's office-Larry matches their PFP. Note the existing generator is static-pose SVG-over-base; animating it means re-deriving overlay positions per frame (or pre-baking trait variants into the atlas). Recommend (a) for MVP, (b) for v1.

**Pipeline (3D):** rigged low-poly Larry (GLTF) + cozy-diorama room models + baked lightmaps; KTX2 textures; Draco/meshopt compression. Source the existing `crab-base` (1024px) **hero** crab as the modeling reference so the 3D Larry reads as the brand crab — explicitly NOT the Village's town sprite. This is 3D-artist time (modeling/rigging/animation/bakes), the single biggest cost+schedule risk of the 3D direction — scope the MVP asset set tightly (§Appendix B).

**The premium bar is the art priority, not the frame count (§5, §10.2).** The single highest-leverage art+engineering investment is **dynamic lighting** (lamp glow, window god-rays, day/night grade, bloom, rim-light) — it is what moves the scene from "cute pixel office" to "screen-record-worthy." Build the lighting/particle layer in MVP even with a small frame set; a richly-lit room with 8 Larry poses beats a flat room with 30. A **screenshot-worthiness gate** (a designer signs off that a representative scene reads premium — not flat, dim, or specky — at mobile size) blocks MVP ship. The Village's ant-farm look is the documented anti-target.

---

## 21. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Theater (watching ≠ doing)** — animations drift from reality | Critical | Every anim bound to a real event; if no signal, Larry idles. Never fabricate. This is the moat; protect it. |
| 2 | **Privacy leak** — message content on a public/embed/card surface | Critical | Default-private; separate sanitized public projection; RLS (Rule 60); tests (Rule 31); never send secrets to client. |
| 3 | **Novelty-death** — shared once, never reopened | High | The loop (streak, Wrapped, act-on-it surfaces, growing office) is built in v1; D7-return is a guardrail metric. |
| 4 | **Art timeline** — frames are the long pole | High | Tight MVP frame set; canonical skin first; catalog is incremental. |
| 5 | **3D performance/battery on mobile** — heaviest where the device is weakest; runs during active chat | **High** | R3F `frameloop="demand"`, baked lighting, low-poly, dpr≤1.5, 30fps, hidden-tab pause; pre-rendered image for casual embeds; no-WebGL → static fallback; validate on real phones in the §22 bake-off. (§12) |
| 6 | **Latency mismatch** — events ~1–2s delayed | Medium | Ambient pacing (not twitch); coalesce bursts; latency becomes calm-pacing feature. |
| 7 | **Realtime cost/scale** — channel per active VM | Medium | Validate Supabase Realtime limits early; polling fallback ships MVP regardless. |
| 8 | **Tool-name dependency** — needed for station walks | Medium | MVP ships on call_type+intensity (no station walks); proxy extension is small and in our control for v1. |
| 9 | **Creepiness/surveillance framing** | Medium | Companionship framing; no guilt/death; sanitized public; "your agent, your work." |
| 10 | **Mobile illegibility at 390px** | Medium | Responsive camera (Larry-follow close-up), not responsive layout. |
| 11 | **Embed abuse / hotlink cost** | Low | Cache + rate-limit cards/SVG; shared public channel; sanitized. |
| 12 | **Scope creep** | Medium | Strict phase discipline; MVP is the emotional core only. |
| 13 | **Trait-animation complexity** | Medium | MVP canonical skin; defer per-agent animated trait rigging to v1. |
| 14 | **Proxy write overhead** | Low | Activity insert piggybacks the existing usage_log insert; cheap, fire-and-forget. |
| 15 | **No message-arrival signal exists today** — perk-up (the activation moment) is impossible without a new `message_in` webhook write | **Critical** | Build the inbound-webhook write FIRST (§35.2); it's small and fires for all users. Activation depends on it. |
| 16 | **BYOK agents bypass the proxy** — no intensity/tool signal | Medium | Bracket with webhook (arrival) + outbound relay (completion); accept degraded richness; document. (§35.3) |
| 17 | **Index Network "Yanek auth" blocked** — gates edge match-walks/matchmaking station | Medium (edge) | Degrade gracefully (work/idle/walk still fire); cross-team dependency, flag to Index owner. (§36.4) |
| 18 | **`agent_positions` write-path unconfirmed** — same plumbing The Floor's feed needs | Medium | Resolve once for both Floor + Village; trace during build. (§1.5, §35) |
| 19 | **Realtime not enabled on our tables** (is on Village tables) | Low | Enable publication on `instaclaw_agent_activity`; poll as interim. (§35.4) |
| 20 | **Renderer reuse couples The Floor to the Village codebase/team** | Low–Med | Worth it (one Larry pipeline); define a clean module boundary; coordinate with the Village owner. (§10.2) |
| 21 | **Floor vs Village user confusion** ("which crab thing is this?") | Low | Clear framing: office (work, private) vs town (social, public); one world, two rooms. (§1.5, §31) |
| 22 | **Visual quality below the screen-record bar** — fails if it's a generic 3D office (Claw3D/clone-tier) or "functional but ugly" | **Critical** | Premium *crab-native* 3D (NOT a stock office), lighting-first; extend the hero/1024px crab; gate MVP on a designer screenshot-worthiness sign-off; run the §22 bake-off first. (§5, §10.2, §20) |
| 23 | **3D art is the long pole** — modeling/rigging/animation + lighting bakes are heavier than 2D and need a 3D artist | **High** | Honest scoping; CC0-kit the room, custom-build only Larry; tight MVP asset set; bake-off de-risks before full spend. (§20) |
| 24 | **Fork drift / upstream Claw3D divergence** | Low | MIT lets us vendor + diverge freely; pin the fork, cherry-pick upstream fixes; the adapter seam + crab assets are ours regardless. (§10.2) |
| 25 | **3D static/embed path** — can't SVG a 3D scene | Low–Med | Server-side headless-three.js baked PNG/MP4; pre-rendered poster default; live 3D on click. (§12, §14) |

---

## 22. Open Questions

1. **Name.** "The Floor" (crypto floor-price + trading-floor wink, existing mindshare) vs. "The Shell" (crab/home-base/computer-shell triple meaning, warmer, more on-thesis). Cooper's call (§3). Reserve "The Reef" for v2 multi-agent regardless.
2. **Public default.** Default-private (recommended for safety) vs. default-public-sanitized (stronger growth). Tension between §13 safety posture and §14 growth. Lean private-by-default with a frictionless one-tap "make public" prompted right after a great moment. Cooper's call.
3. **Realtime vs polling for MVP launch.** Recommend: ship the polling fallback to hit the 2-week target if Realtime wiring is tight; swap to Realtime in v1.
4. **Activity table vs extend usage_log.** Recommend a **new** `instaclaw_agent_activity` table (clean sanitization boundary, separate RLS, separate retention) rather than overloading `usage_log`.
5. **Audio in MVP?** Minimal tap-to-unmute clack+ding is cheap and high-impact; or defer all audio to v1. Recommend minimal-if-time.
6. **Trait-animated PFP timing** — MVP canonical Larry, v1 trait rigging. Confirm artist bandwidth.
7. **Token-gated cosmetics** — should streak/cosmetic unlocks tie into Bankr tokens (earn/own your Larry's hat)? Interesting v2 lever; needs product+tokenomics input.
8. **Where it lives in nav** — does The Floor become the new default landing surface post-onboarding (replacing/absorbing `(dashboard)/live`)? Recommend yes for the activation story (User Story #1).
9. **"Act-on-it" scope** — which agent→user signals (approvals, results) surface on The Floor in v1? Needs a pass over existing agent-needs-user flows.
10. **Contribute fixes upstream to Claw3D?** MIT permits vendor-and-diverge; decide whether to PR our `frameloop="demand"`/lighting improvements back or keep the fork private. (§10.2)
11. **Ship the `message_in` webhook write now?** Recommend **yes** — it's the activation unlock and is small; nothing else in the loop matters until perk-up works. (§35.2)
12. **`complete` signal source** — outbound relay (all users) vs usage_log (rich, all-inclusive only)? Recommend outbound relay for universal completion + usage_log for richness. (§35.3)
13. **BYOK coverage** — accept degraded Floor (arrival+completion, no richness) for BYOK, or route a lightweight signal? Recommend accept + document. (§35.3)
14. **Cosmetic monetization model** — Stripe add-on vs rare-trait-unlock vs $INSTACLAW-gated vs NFT drop? Recommend Stripe-add-on + rare-trait-unlock first; $INSTACLAW/NFT in v2. (§34)
15. **Floor ↔ Village navigation** — how do users move between their office and the town? One app with two views, or linked surfaces? (§1.5, §31)
16. **Edge scope** — is the edge MVP "personal 3D Floor + tap-through from the (2D) town," on the live 4-week timeline? Note the cross-renderer handoff (2D Village → 3D Floor) is a transition, not one seamless scene. Recommend yes. (§36.4)
17. **Index/Yanek dependency owner** — who unblocks the match flow that the edge matchmaking station depends on? (§36.4)
18. **Art-direction investment (3D)** — The premium crab-native 3D bar (§5) needs a 3D artist, especially the baked-lighting layer. Who owns it? Budget/bandwidth for a *beautiful* foundation, or a smaller-but-premium scope? The one thing we must NOT do is ship a stock-Claw3D or flat look to save time — that fails the thesis. (§5, §10.2, §20, Risk #22)
19. **Who builds the 3D Larry?** The `crab-base` (1024px) crab is a premium *2D* modeling reference; turning it into a rigged low-poly 3D model with clips (type, scuttle, perk-up, celebrate, station-use) is the long pole and needs a 3D artist/TD. Confirm ownership. (§5, §20)
20. **Run the visual bake-off before any build, inside the forked Claw3D.** Prototype the crab-native low-poly tidepool study vs a "clean premium 3D office + crab" control (closer to stock Claw3D) as hero stills + 5-second turntables, on a real mid-tier phone (perf check too); pick on "would you screen-record this?" The whole thesis (and the 3D-on-mobile bet) rides on the answer — the single highest-leverage pre-build decision, a prototype call, not a doc call. (§5)
21. **Crab-native world vs literal office** — is the seaside/tidepool-study direction (§5) the right ownable identity, or do we want a different signature setting? Either way, "generic office" (the AI-Town-clone look) is the one option that's off the table. (§5, §10.2)

---

## 23. Success Metrics and Instrumentation

**North-star:** weekly **shares-per-active-agent** (daily cards + embed installs + recorded clips), guardrailed by **D7 Floor-return rate**.

**Activation:** % of new users who open The Floor within 1 hour of onboarding; % who see Larry react to their first message (User Story #1). Target the activation moment hard — this is where "an agent platform" becomes "my guy."

**Engagement / loop:** D1/D7/D30 Floor-return; median Floor sessions/week; streak distribution (7/30/100 milestone attainment); customization adoption.

**Growth:** cards shared (by channel); embed installs (badge + iframe + README baked image); click-through on "claim your own agent" CTAs; **signups attributed to an embed/card** (the Calendly ~25%-from-badge benchmark is the aspiration); K-factor estimate from embed→signup.

**Fidelity / trust (the moat):** event→animation latency p50/p95; % of Larry's on-screen time that is real-event-backed vs idle (should be ~100% backed when active); zero privacy-leak incidents (any message-content appearance on a public surface is a P0).

**Performance:** embed bundle size; Floor CPU/battery on mid-tier mobile; first-paint time; static-fallback rate.

**Instrumentation:** emit Floor-open, share-initiated, share-completed (by surface), embed-render, claim-CTA-click, streak-milestone, customization-change. Per Rule 27, ship a coverage query for "% of active agents with a populated Floor activity feed" so we can see fidelity at fleet scale from day one.

---

## 24. The First 60 Seconds (activation walkthrough)

The single most important moment in this product is a user's *first* sixty seconds with Larry. It is where "I bought an AI agent" becomes "that's my guy." Engineers and designers should optimize this sequence above all else; it is User Story #1 made concrete.

**Second 0–3 (the reveal).** Onboarding completes. Instead of dumping the user on the config-heavy `/dashboard`, we route them to The Floor (see §31). The camera opens in a gentle push-in on a humble, warmly-lit office — desk, window showing the real region skyline at the real local time, a bed in the corner — and Larry is there, mid-idle, maybe stretching awake. Before the user does anything, the office already feels *inhabited*.

**Second 3–10 (the prompt).** A soft, single call-to-action appears: "Say hi to your agent." (Tapping Larry, or the CTA, opens the chat channel the user just connected during onboarding — Telegram/iMessage/Discord.) We are not asking them to learn a UI; we're asking them to talk to their crab.

**Second 10–25 (the aha).** The user sends their first message. Within ~1–2s of the user hitting send — driven by a `message_in` event we write at the inbound channel webhook the moment their message arrives (this is the one new write the activation moment requires; the proxy/usage_log signal arrives 60–90s later, *after* the reply, so it cannot power perk-up — see §35) — Larry **perks up** (eyestalks shoot up, "!"), **scuttles sideways** to his desk, climbs into the chair, and starts **typing** — *while the model is actually generating their reply, for the full real duration of that generation*. The keyboard clacks (if unmuted). This is the aha. The animation is not a canned intro; it is a faithful echo of the real work happening on their VM right now. The user feels the causal link: "I spoke, and my agent reacted, and I can see it thinking."

**Second 25–45 (the payoff).** The reply lands in their chat. On The Floor, Larry does a small **task-done fist-pump** with a tiny "✓" and a soft ding. The loop has completed visibly. If the agent used a tool the office supports (v1), Larry took a detour to that station first — deepening the "it's really doing stuff" feeling.

**Second 45–60 (the seed).** A gentle, non-blocking nudge appears: "🦀 This is [agent name]. Share your office." One tap produces the 9:16 card. We do not force it; we plant it at the emotional peak (Strava/Duolingo: prompt the share at the win). Whether or not they share now, the seed is planted: this thing is showable.

**The design mandate:** if a new user does not feel the aha (second 10–25) reliably within their first interaction, nothing else in this PRD matters. Every latency, every fallback, every animation timing decision should be tuned so that *perk-up fires fast and unmistakably* on the first message. Instrument this precisely (§23 activation metrics).

---

## 25. Office Layout and Camera (wireframes)

These are illustrative ASCII wireframes to anchor the spatial design, not pixel-accurate specs. The real art is isometric pixel art (§5, §20); these convey *composition and camera*, which is what an engineer needs to build the renderer and an artist needs to frame the scene.

### 25.1 Desktop / wide-embed: the full isometric floor

```
        ┌───────────────────────────────────────────────────────────┐
        │  THE FLOOR · [Agent Name] 🦀         🔥7   👁 live   🔊 ⤢   │
        │                                                             │
        │      ╱▒▒▒▒▒▒▒▒╲   window: NEWARK 4:12pm  ╱▒▒▒▒▒▒▒▒╲        │
        │     ╱ MEMORY  ╲                          ╱ TRADING ╲       │
        │    ▕ ▤ ▤ vault ▏     ╱▔▔▔▔▔▔▔▔╲         ▕ 📈 floor  ▏      │
        │     ╲________╱      ╱  desk     ╲        ╲________╱        │
        │                   ▕  🖥  💡   🦀 ▏  ← Larry here (typing)   │
        │      ╱▔▔▔▔▔▔╲     ▕  ☕ 🪴 📝    ▏      ╱▔▔▔▔▔▔╲           │
        │     ╱ STUDIO ╲     ╲___________╱       ╱ MAILROOM╲         │
        │    ▕ 🎨 🎤    ▏                        ▕ 📮 ✉      ▏        │
        │     ╲_______╱        🛏 nap corner     ╲________╱          │
        │                                                             │
        │  ▸ Larry is checking the markets…                  [Share]  │
        └───────────────────────────────────────────────────────────┘
```

Stations present are gated by installed skills (§7). A bare agent shows only desk + window + bed + browser; a power agent shows the full floor above. Depth-sorted painter's algorithm; 2:1 isometric tiles.

### 25.2 Mobile default: Larry-follow close-up (390px portrait)

```
┌─────────────────────┐
│ [Agent] 🦀  🔥7  🔊 │   ← minimal top chrome
│                     │
│    ╱▔▔▔▔▔▔▔▔╲       │
│   ╱ window:    ╲    │   ← camera tight on Larry +
│  ▕  Newark 4pm  ▏   │     active station only
│   ╲___________╱     │
│   ▕ 🖥 💡        ▏   │
│   ▕    🦀 ⌨ clack ▏  │   ← Larry typing, BIG, legible
│   ▕ ☕ 🪴        ▏   │
│    ╲___________╱    │
│                     │
│ ▸ working on it…    │   ← one-line live ticker
│                     │
│  [💬 Chat]  [Share] │   ← tap Larry/Chat → existing channel
└─────────────────────┘
        pinch out ↓
┌─────────────────────┐
│  (full floor view,  │   ← pinch/double-tap zooms out
│   scaled to fit,    │     to the §25.1 wide shot
│   pan with drag)    │
└─────────────────────┘
```

The mobile lead is intimacy (one crab, close), not the wide floor. The wide floor is the zoom-out reward (§11).

### 25.3 The 9:16 share card (1080×1920)

```
┌───────────────────────┐
│      [agent name]      │  ← big, the identity
│         🦀             │  ← their unique trait-skinned Larry
│   ╱▔▔ office scene ▔╲  │  ← Larry mid-signature-action
│  ▕  🖥 🦀 📈 🎨     ▏  │     (office reflects their skills)
│   ╲_______________╱   │
│                       │
│   ┌─ TODAY ────────┐  │
│   │ 14 tasks        │  │  ← glanceable stat block
│   │  3 trades       │  │     (sanitized, no content)
│   │  2h focus       │  │
│   │ 🔥 7-day streak │  │
│   └────────────────┘  │
│                       │
│   May 29 · watch live │
│   instaclaw.io/floor/ │  ← live URL (watchable target)
│        [handle]       │
│   🦀 powered by       │  ← brand mark
│      InstaClaw        │
└───────────────────────┘
```

Self-explanatory to a stranger in one second: whose agent, what it did, how to get one (§15).

### 25.4 The README / no-JS badge (server-baked 3D image)

```
┌──────────────────────────────────────┐
│ 🦀 Larry · [name]   ● live            │
│ ▸ checking the markets   🔥 7-day      │
│   ▸ 14 tasks today    get yours →      │
└──────────────────────────────────────┘
```

Server-baked 3D render (PNG, or a refreshed GIF/MP4 turntable) so it works inside GitHub READMEs (which strip JS/iframes/WebGL). The "get yours →" is the embedded recruitment doorway (§14).

---

## 26. The Proxy Activity-Event Extension (concrete spec)

This is the one backend change that unlocks station-specific walks (§9.2). It is small, lives in code we own, and piggybacks an insert the proxy already does.

**Where:** `app/api/gateway/proxy/route.ts`, alongside the existing `instaclaw_usage_log` insert (the path that already computes `callType`, `model`, `cost_weight`, `routing_*`).

**What it writes:** one sanitized row to `instaclaw_agent_activity` per LLM call. The proxy already parses `parsedBody.messages` and can see `tool_use`/`tool_result` blocks (it uses them to detect `tool_continuation`). We extract the tool name(s) and map them through a **whitelist** to a station key — never logging raw tool input/output, never logging message content.

**Sanitized event shape (the only thing the frontend ever sees):**
```jsonc
// instaclaw_agent_activity row → Realtime payload
{
  "vm_id": "…",
  "created_at": "2026-05-29T20:12:03.114Z",
  "kind": "tool",              // message_in | working | tool | heartbeat | complete | error | idle | skill_added
  "station": "trading",        // null until a whitelisted tool name maps to a station
  "intensity": 2,              // 1 light(haiku) | 2 focused(sonnet) | 3 deep(opus), from cost_weight
  "tool_name": "trade",        // whitelist-mapped ONLY; raw/unknown → null
  "public_safe": true,
  "meta": {}                   // sanitized; NEVER message content, NEVER prompt_hint
}
```

**Tool-name → station whitelist (server-side, the only mapping allowed):**
```ts
const TOOL_STATION: Record<string, Station> = {
  web_search: "browser", browse: "browser", fetch: "browser",
  trade: "trading", swap: "trading", polymarket: "trading", solana: "trading",
  send_email: "mailroom", gmail: "mailroom", send_message: "mailroom",
  memory_put: "memory", memory_search: "memory", gbrain: "memory",
  generate_image: "studio", generate_video: "studio", tts: "studio",
  run_code: "workbench", write_file: "workbench",
};
// Any tool not in this map → station: null (Larry works at his desk). Never log the raw name.
```

**Sanitization invariants (enforced + tested, Rule 31 / Rule 60):**
- `prompt_hint`, message `content`, tool `input`, tool `output` → **never** written to this table.
- `tool_name` is only ever a *key from the whitelist above*; anything else becomes `null`.
- `public_safe=true` is set only after the row passes sanitization; the public Realtime channel and all card/embed endpoints read `public_safe` rows only.
- Write is fire-and-forget (like the existing usage_log insert) — it must never add latency or failure risk to the user's LLM call. If the activity insert fails, the agent still works; The Floor just misses one beat.

**MVP without this:** the proxy already gives `call_type` + `cost_weight` today, which drives perk-up/type/think/complete/idle. So MVP ships *before* this extension on those signals (no station walks). This extension is the v1 unlock for station-specific behavior.

---

## 27. The Behavior State Machine (concrete spec)

The renderer is dumb; the **animation director** is the brain. It consumes events and decides what Larry does, ensuring motion reads as continuous and intentional rather than teleporting.

**States:** `OFFLINE` (health frozen/away), `ASLEEP` (health suspended/hibernating), `IDLE_LIGHT`, `IDLE_READING`, `IDLE_NAPPING` (escalating by `last_proxy_call_at` age), `INCOMING` (perk-up), `TRAVELING` (scuttle to a target), `WORKING_DESK` (typing/thinking, intensity-tiered), `WORKING_STATION` (using a station), `CELEBRATING`, `STUMBLING` (error).

**Transition rules (pseudocode):**
```
on event e:
  if e.health in {frozen}:            -> OFFLINE
  elif e.health in {suspended,hibernating}: -> ASLEEP
  elif e.kind == "message_in":        -> INCOMING -> (travel to desk) -> WORKING_DESK
  elif e.kind == "tool" and e.station and station_exists(e.station):
        -> TRAVELING(e.station) -> WORKING_STATION(e.station) -> (return to desk)
  elif e.kind == "working":           -> WORKING_DESK(intensity = e.intensity)
  elif e.kind == "complete":          -> CELEBRATING(small|big) -> settle to IDLE_LIGHT
  elif e.kind == "error":             -> STUMBLING -> settle to IDLE_LIGHT
  elif e.kind == "heartbeat":         -> brief ambient overlay, do NOT leave current state
  else (no events for T):             -> idle escalation by silence age

burst coalescing:
  if >=3 tool events within 4s:       -> MULTITASK_BLUR (zip between stations) instead of literal walks

intensity mapping (WORKING_DESK overlay):
  1 -> light typing
  2 -> typing + thinking-hard (gears, lamp bright)
  3 -> typing + deep-work aura (+ sweat drop)
```

**Pacing:** because events arrive ~1–2s apart, the director has time to play full traversal+action sequences between signals — it should *enqueue* and play to completion rather than interrupt, except for higher-priority interrupts (a new `message_in` always preempts idle; `error`/`complete` preempt working). All transitions are tweened. The director never plays an animation that has no backing event (the §9 honesty rule); when the queue is empty and the agent is online, the *idle scheduler* — not fabricated activity — fills the time.

**Idle scheduler:** on an empty queue + online agent, pick a random `IDLE_LIGHT` micro-animation every ~8–15s; after `silence_age` crosses thresholds, escalate to `IDLE_READING` then `IDLE_NAPPING`. This is the only place Larry's behavior is *not* event-driven, and it's explicitly "resting," never "working."

---

## 28. MVP Engineering Build Sequence

An ordered, dependency-aware task list to ship the §17 MVP in ~2 weeks. Parallelizable across an engineer + an artist.

**Track A — Backend / data (engineer):**
1. Migration: `instaclaw_agent_activity` table + RLS (Rule 60), in `pending_migrations/` first (Rule 56). Add `floor_handle`, `floor_public`, `floor_streak_days`, `floor_last_active_day`, `floor_cosmetics` to `instaclaw_vms`.
2. Proxy: write the sanitized activity row alongside the existing usage_log insert (kind + intensity from existing `call_type`/`cost_weight`; `station=null` for MVP). Fire-and-forget. (§26)
3. `GET /api/floor/[handle]/activity` (polling fallback + public sanitized feed). Add to `middleware.ts` `selfAuthAPIs` (Rule 13). Sanitized rows only for non-owners.
4. `POST /api/floor/settings` (handle, public toggle, cosmetics) — session-protected.
5. Server-rendered 9:16 card route `GET /floor/[handle]/card.png` (reuse `@napi-rs/canvas` from `token-image-generator.ts`; sanitized stats only).
6. (If time) Supabase Realtime channels `vm:{vm_id}` (owner) + `floor:{handle}` (public). Otherwise frontend uses the 2s poll.

**Track B — Renderer / frontend (engineer):**
7. Renderer: **fork Claw3D** (`/tmp/claw3d-fork-research`, MIT) — three.js/R3F. Scope to single-agent (filter, ~3 callsites), drop in the crab Larry + crab-native room, add `frameloop="demand"` + baked lighting + dpr cap (§12). Server-bake the static card separately (no-JS path). (§10.2, §10.3, §12)
8. Animation director / state machine (§27) consuming the activity feed (Realtime or poll).
9. `app/(dashboard)/floor/page.tsx` owner view: scene + live ticker + tap-Larry-to-chat deeplink + share button + mute toggle.
10. Mobile responsive camera (Larry-follow close-up; pinch/double-tap zoom-out). (§11)
11. Day/night by `user_timezone`; region window. Tap-to-unmute minimal SFX (clack + ding) if time.
12. One-tap share → card route; "share at the win" prompt after a `complete` event. (§15, §24)

**Track C — Art (artist):** the §20 MVP frame set + core room set + browser CRT, packed into one atlas. **This is the critical path** — Track B can scaffold against placeholder frames, but the emotional payload needs the real sprites. Prioritize: idle_base, perk-up, scuttle, type, think, celebrate, sleep (the §24 first-60-seconds frames) before the rest.

**Track D — Integration / activation (engineer):**
13. Post-onboarding redirect to `/floor` (§31), with the §24 first-60-seconds CTA sequence.
14. Instrumentation: Floor-open, perk-up-latency, share-initiated/completed (§23).

**Dependency notes:** Track B can start against placeholder rectangles immediately. The proxy change (A2) is small and unblocks the live feed. Realtime (A6) is optional for MVP (poll fallback). Station walks are explicitly NOT in MVP (need §26 tool-name mapping → v1).

---

## 29. Accessibility and Internationalization

The Floor is primarily visual/ambient, which creates real a11y obligations:

- **Reduced motion:** honor `prefers-reduced-motion`. In reduced-motion mode, drop continuous loops and tweens; show Larry in discrete poses (idle / working / done) that *change on real events* without animation. The information ("my agent is working") survives without the motion.
- **Screen readers / non-visual:** the live activity ticker is real text and is the accessible spine — it announces state changes ("Larry is checking the markets", "task complete") via an ARIA live region. The whole experience must be *narratable* in text, because the activity feed is text underneath. A blind user gets the same truth via the ticker.
- **Contrast / legibility:** stat blocks and the ticker meet WCAG AA contrast; pixel art is high-contrast by nature but overlay text must not rely on color alone (the error stumble is also a "…" bubble + ticker text, not just a red tint).
- **Audio:** always opt-in (§8); never the sole carrier of information (the ding is mirrored by the visible ✓ and the ticker).
- **Keyboard:** owner view is fully keyboard-navigable (focus Larry, focus stations, share). Embeds are non-interactive by default (pure ambient) which sidesteps most embed-a11y traps; the claim CTA is a real link.
- **i18n:** the ticker strings, stat labels, and card text are localizable. Larry's behavior is language-agnostic (it's a crab), which is a nice property — the emotional layer crosses languages even where the chat doesn't. Region/timezone display uses the agent's locale.

---

## 30. Cost Model

Rough order-of-magnitude, to confirm The Floor is cheap to run (it is) and to flag the one thing to validate (Realtime scale).

- **Activity writes:** a few small fire-and-forget Supabase inserts per interaction — one at the inbound webhook (`message_in`), one at the proxy (`working`/`tool`, all-inclusive only), one at the outbound relay (`complete`). Negligible incremental DB cost on top of the existing usage_log insert. Short retention (7–30d via pg_cron, mirroring the usage_log retention job) keeps the table small.
- **Realtime:** the cost/scale item to validate. A channel per *active* (currently-being-watched) Floor — not per VM — because subscriptions only exist while someone has The Floor open. Concurrent watchers ≪ total fleet. Validate Supabase Realtime concurrent-connection limits/pricing against expected peak concurrent watchers; the **polling fallback caps cost deterministically** (one 2s request per open Floor, cacheable) if Realtime economics don't pencil out at scale.
- **Card/SVG rendering:** server-rendered, **cached** (a given day's card is immutable once generated; the live SVG refreshes on an interval, not per-request). Rate-limited to prevent hotlink abuse. Cheap with caching; the OG-image render reuses `@napi-rs/canvas` already in the repo.
- **Frontend/embed delivery:** live 3D bundle (~500–700KB + GLTF/textures), CDN-cached + lazy-loaded behind a static poster; casual embeds serve a pre-rendered image (§12, §14). Rendering runs on the user's GPU, so per-view *backend* cost stays ~zero beyond the feed.
- **The real cost is art, once — and higher in 3D.** 3D modeling/rigging/animation + lighting bakes (§20) are the dominant cost, a one-time capex amortized across all users (everyone shares the canonical 3D Larry + room; per-agent variation is material/accessory-mesh swaps). Honestly more than the 2D plan — the main reason to run the §5 bake-off first.
- **One new client dep, modest new infra.** three.js + R3F + drei (MIT, npm — from the Claw3D fork); Supabase Realtime (already used by the Village); Vercel routes (existing). The one genuinely new server cost is **baked-card rendering** (headless three.js / `@napi-rs/canvas`+GL → README/share PNG/MP4, §14), cached + rate-limited. Heavy 3D runs on users' devices, not ours.

Conclusion: runtime cost is dominated by Realtime concurrency (bounded by *concurrent watchers*, with a polling fallback that caps it) and is otherwise rounding error against the existing per-agent LLM spend. The investment is artist time, not compute.

---

## 31. Onboarding and Navigation Integration

The Floor only delivers its activation payload (§24) if users actually *land* on it, fast, at the right moment.

- **Post-onboarding redirect:** when onboarding completes (the `onboarding_complete` transition / the existing post-configure success path — mindful of the Rule 33 onboarding state machine, never introduce a new trap state), route the user to `/floor`, not the config-dense `/dashboard`. This is where User Story #1 happens. (Open question §22 #8: make The Floor the default post-onboarding landing — recommended yes.)
- **Relationship to existing surfaces (corrected — `/live` is NOT redundant).** There is already a `(dashboard)/live` route, but it is a genuinely different and valuable thing: a **raw noVNC live-desktop viewer** (`app/api/vm/live-session`, `components/dashboard/vnc-viewer.tsx`, view-only/control toggle, fullscreen, plus an existing `ClipRecorder`). That is the *literal pixels of the agent's actual computer screen* — a power-user "show me exactly what's on the machine" view. The Floor does **not** supersede it; the two are complementary: `/live` is the *raw, literal* window (the real desktop), The Floor is the *stylized, emotional* window (the crab abstraction). Position them as a pair — "watch Larry" (The Floor, default, delightful, shareable, mobile) and "watch the actual screen" (`/live`, power-user, literal). Reuse `/live`'s `ClipRecorder` for The Floor's clip/GIF capture (§15). The dashboard (`/dashboard`, `/history`, `/heartbeat`, `/skills`, `/billing`) remains the *operational* surface (config, billing, logs). Three-way division: dashboard = "manage your agent," `/live` = "see its literal screen," Floor = "be with your agent."
- **Persistent entry point:** a prominent, persistent nav entry (with a small live indicator — a pulsing dot when Larry is actively working) so users can jump to The Floor from anywhere in one tap. The live dot itself is a re-engagement hook ("oh, he's doing something — let me look").
- **Cross-surface identity:** the same trait-skinned Larry appears as the user's avatar across dashboard, Floor, and card — one coherent crab everywhere (§5). Seeing "their" crab in the nav, even small, reinforces ownership between visits.
- **Channel deeplinks:** tapping Larry resolves to the user's connected channel (Telegram/iMessage/Discord deeplink from the existing channel config) — never a new chat surface (§1).
- **Re-entry, not just first-entry:** the §16 act-on-it signals, streak, and daily Wrapped are what make the *nav entry* worth tapping on day 30, not just day 0. Onboarding gets the first open; the loop earns the rest.

---

## 32. The Growth Loop (end-to-end, with conversion + breakpoints)

The original draft had share *mechanics* (§14, §15) but not a closed *loop*. Here is the full loop, the conversion question at each hop, where it breaks, and the fix. There are three loops; they compound.

### 32.1 Loop A — the content loop (card / clip → X → signup)

```
Owner has a great moment → one-tap 9:16 card or auto-GIF (§15)
   → posts to X  →  follower sees it in feed
   → curiosity ("what is that crab? it did 14 tasks?")  →  taps live URL (instaclaw.io/floor/{handle})
   → lands on a LIVE public Floor (not a dead image — the crab is moving)
   → "I want my own"  →  signup  →  onboard  →  first message  →  AHA (perk-up, §24)
   → builds/customizes office, hits a streak  →  shares  →  (loop)
```

Conversion at each hop (these are *hypotheses to instrument* (§23), not claimed facts):
- **Post → impression:** governed by the poster's follower graph + X's algo. The crab + the bold stat block is the scroll-stopper (Spotify-Wrapped identity-card mechanic).
- **Impression → click (the make-or-break hop):** a stranger clicks only if the card is *self-explanatory and intriguing in one second* — whose agent, what it did, and the implicit "I could have one." The live URL (a *watchable* destination, not a screenshot) is what converts curiosity into a click, because "watch it live" is a stronger promise than "see a picture."
- **Click → signup:** the landing experience must immediately answer "what is this and how do I get one." A live public Floor of a *real working crab* + a single "Claim your own agent" CTA. This is where most funnels leak; the antidote is that the thing they're looking at is *already the product working*, not a marketing page.
- **Signup → aha:** §24. Perk-up must fire fast and unmistakably on the first message (requires the §35 `message_in` write).
- **Aha → share:** prompted at the emotional peak (a win, a milestone), with a finished asset (§15).

**Where it breaks (and the fix):**
- *Card is generic* → identity-strip test (§1): if it reads as "any AI product," reject. Fix: name + unique trait-Larry + concrete stats.
- *Click lands on a static image* → fix: always link to the live public Floor.
- *Signup → aha gap* → if perk-up doesn't fire (the §35 gap), the whole loop dies at activation. **This is the highest-priority dependency in the PRD.**
- *No reason to re-share* → fix: the renewable "Larry Wrapped" (§15) and streak milestones generate fresh shareables on a schedule.

### 32.2 Loop B — the embed/billboard loop (passive)

```
Owner embeds a live "Larry is working" badge (README / personal site / Notion / X bio link)
   → every visitor sees a live crab + "powered by InstaClaw · get yours →"
   → visitor clicks  →  (enters Loop A's landing → signup)
```

Conversion: lower per-impression than a deliberate post, but *compounding and free* (Calendly's badge drove ~25% of signups from people spotting it elsewhere; the K-factor for embed loops is modest, ~0.1–0.2, but it never stops). The README baked-image path (§14) is disproportionately valuable because our base is dev/crypto — the GitHub-contribution-graph "flex" instinct is native to them. **Breakpoint:** a slow or static embed gets removed; fix = fast-first-paint baked image by default, live 3D only on click.

### 32.3 Loop C — the Village loop (already live, the unfair one)

The audit's biggest gift: **the public Village spectator view is already a "watch a town of agents" surface**, embedded in the edge dashboard today. At Edge Esmeralda (~150 on-site at once, ~500 over 4 weeks), attendees are physically together looking at the same town of crabs. Every crab is a recruitment ad, and the social proof is *in the room*.

```
Attendee/spectator watches the live Village (many crabs walking, meeting, matching)
   → sees a specific crab do something notable  →  "whose is that? I want one"
   → The Floor adds: tap a crab → peek its (sanitized) office activity → "claim your own"
```

This loop has the strongest top-of-funnel we have because it's *live, multi-agent, social, and co-located*. The Floor's job is to convert Village *spectating* into Floor *ownership* — by making each crab tappable into a personal office and by giving every attendee a Floor of their own to show off. **Breakpoint:** the Village's match-walk drama depends on the Index Network "Yanek auth" integration (D1), which is currently blocked — until it ships, the town is calmer than designed (agents walk/idle but matches don't visibly fire). Note as a cross-team dependency (§36).

### 32.4 The one number that matters

**The loop's throughput is gated by its weakest hop, and that hop is currently *signup → aha*** — because perk-up can't fire without the §35 `message_in` write. Build that first. A beautiful card that drives a click that lands on an agent that *doesn't visibly react to the new user's first message* converts far worse than the same funnel where the crab perks up in under two seconds. Fix the activation hop before optimizing the share hop.

---

## 33. Competitive Moat

The concept is *already commodity.* "Watch your AI agent in a pixel/3D office" has shipped, repeatedly: a16z AI Town, Claw3D, Agent Town, Pixel Agents, AgentOffice — and our own Village is itself an AI Town fork (§10.2). So the *visualization concept* is explicitly **not** the moat; if it were, we'd already have lost. What makes The Floor uncopyable is the *stack underneath the crab* plus a *distinctive, ownable art direction* (§5) that none of the clones have — and almost none of that is the renderer, which is why we don't spend the moat budget there.

1. **Per-agent codified identity that's unforgeable from a seed.** Every InstaClaw agent already has a deterministic crab generated from `lib/token-image-generator.ts`: 50 atlas variants, trait categories with *codified rarity* (eyes: dot 50% → laser 4% → pepe 2%; hats: none 40% → halo 1%, devil_horns 1%; held items: gm_bubble <1%; gold chain ~10%; 17 hue shifts incl. rare metallics), some traits *locked to the agent's personality hash* and unforgeable. A competitor can draw a crab; they cannot reproduce *this* crab for *this* user without our seed system. The office is populated by an identity layer that already exists and is already tied to each agent's token.

2. **Every animation is backed by real activity, not cosmetics.** Claw3D's "messy desk = busy" is a vibe; ours is a faithful echo of the inbound webhook + proxy + tool-name signal (§9, §35). Reproducing this requires *operating the agents* — having the gateway, the proxy chokepoint, the per-VM fleet. A visualizer company has the renderer but not the agents; an agent company that bolts on a renderer still has to build the real-activity pipeline we already have. The honesty *is* the moat: the first time a user notices Larry went to the trading station exactly when their agent traded, no skinned dashboard can match the feeling.

3. **The world already exists, and it's two-room.** We ship *both* the personal office (Floor) and the live social town (Village) on one real-time substrate (§1.5). A competitor copying "the office" still lacks "the town," and vice-versa. The combination — your agent works in its office and lives in a town with everyone else's — is a world, not a feature, and worlds compound.

4. **An economic loop the visualization feeds.** $INSTACLAW is live on Base (`0xa9e2387…`, 1B supply, buy-and-burn from 10% of revenue), and **every agent already launches its own token** via Bankr. The Floor is not just a toy; it's a flywheel input: more watching → more sharing → more agents → more agent-token launches + subscriptions → more $INSTACLAW burn → more token value → more reason to own an agent. A competitor's office has no economy under it. Ours is wired to a live token and a per-agent wallet on day one (§34).

5. **Data/network effects.** More agents → a richer, more alive Village → a stronger top-of-funnel (Loop C) → more agents. The town gets better as we grow; a single-tenant visualizer doesn't.

**The honest version:** the renderer is the *least* defensible part — anyone can fork a three.js office (Claw3D itself is MIT, and the clones exist) — which is exactly why we fork rather than hand-build it (§10.2) and don't spend the moat budget there. The moat is the per-agent trait identity + the real-activity pipeline + the two-room world + the live token economy. Those took years of InstaClaw to assemble and sit *underneath* the crab. Someone can screenshot The Floor in a day and reproduce it in a quarter; they cannot reproduce what's beneath it.

---

## 34. Monetization

Grounded in what the audit confirmed is *already live*, then the net-new presentation layer. The recurring theme: **the wallet, token, trait-rarity, tier, and NFT-mint primitives all exist; only the cosmetics store/inventory/binding is new.** "You're building furniture, not the house."

### 34.1 What already exists (the scaffold)
- **$INSTACLAW token** — live on Base (`0xa9e23871156718c1d55e90dad1c4ea8a33480dfd`), 1B supply, buy-and-burn from 10% of revenue. The token page's own revenue model already names **16% from agent token launches** and **11% from a skill marketplace** as "coming soon" lines — The Floor accelerates both.
- **Per-agent token** — each agent launches its own ERC-20 via Bankr (`bankr_token_address/symbol/image_url`); launch + trade fees split three ways (agent compute / $INSTACLAW burn / protocol).
- **Two wallets per agent** — Bankr EVM (send+receive) + Coinbase CDP (receive, Rule 66). A cosmetic purchase *can* be paid from the agent's own wallet.
- **Tiers (live):** Starter $49.99/$35.99, Pro $129.99/$49.99, Power $349.99/$119.99 (all-inclusive / BYOK). Credit system + WLD credits + partner-gating in `lib/billing-status.ts`.
- **Codified trait rarity** — already in the generator (§33 #1). A ready-made rarity mechanic with zero new randomness to design.
- **Soulbound NFT minting** — `lib/ambassador-nft.ts` (Base, contract `0xe4F6…`) proves we can mint cosmetic NFTs reusing an existing pattern.

### 34.2 Revenue lines, grounded
1. **Premium office themes as a tier perk + à-la-carte add-on.** Power tier unlocks premium themes; a +$X/mo "premium visuals" add-on attaches to the existing Stripe + `billing-status` logic (new `cosmetics` flag, not new billing infra). Cosmetics are the highest-margin upsell in software (pure digital, made once, sold forever).
2. **Rare-trait-gated cosmetics (free flex that drives sharing).** Agents with sub-1% trait combos (laser eyes + halo, devil horns, gm_bubble) auto-unlock exclusive office decor. This costs us nothing, makes rare agents *feel* rare, and — because rarity is deterministic from the seed — is unforgeable. It also creates a "regenerate to chase rarity" loop (a soft monetization if regen is ever metered) and gives whales a reason to want a rare agent.
3. **Agent-token-fee-funded office upgrades.** An agent's own token trading fees already split three ways; route a slice to a cosmetics balance so a *successful* agent literally earns its office glow-up on-chain. Self-sustaining, reuses the existing fee split, and visually rewards the agents people most want to watch.
4. **$INSTACLAW-gated / -spent cosmetics.** Exclusive themes purchasable with (or gated by holding) $INSTACLAW → direct token utility + buy pressure → feeds the burn. Ties The Floor straight into the token's value loop.
5. **Cosmetic NFT drops + a furniture marketplace (v2).** Mint limited office furniture/sprite sets as NFTs (reuse `ambassador-nft.ts`); later, a UGC marketplace where artists sell custom furniture sprites and earn — which *is* the "skill marketplace" 11% revenue line's cosmetic cousin, and a creator-acquisition channel.
6. **The indirect line (largest).** The Floor's real monetization may be *retention + virality*, not direct cosmetic revenue: it makes agents worth keeping (lower churn on $49–$349/mo subs) and worth tokenizing/showing (more agent-token launches → the 16% revenue line). The cosmetic store is the visible revenue; the flywheel is the real one.

### 34.3 What's net-new (be honest)
A cosmetics **store UI**, an **inventory/ownership table** (`user_cosmetics` or a `cosmetics` jsonb on `instaclaw_vms` / `floor_cosmetics` from §18), **drop mechanics**, and **purchase routing** (Stripe add-on + wallet/credit paths). The mint, wallet, token, trait, and tier primitives are all in place; this is presentation + binding. Recommend: ship cosmetics as a Stripe-add-on + rare-trait-unlock first (no new on-chain work), add $INSTACLAW-gating and NFT drops in v2 once the store exists.

---

## 35. Latency Budget (end-to-end trace)

The audit's hardest correction: trace "user sends message → Larry perks up" through every real system, and state honestly whether sub-2s is achievable.

### 35.1 The two-signal model (the key reframe)
A single signal can't do it, because the moment of *arrival* and the moment of *completion* are 60–90s apart and only one of them is something we can react to instantly. So The Floor brackets every interaction with two signals and lets the *real generation time* fill the middle:

- **`message_in` (perk-up trigger):** must fire ~instantly when the user sends.
- **`working` (the long middle):** Larry types continuously from `message_in` until `complete`. We do *not* need intermediate progress events — the agent genuinely is working that whole time, so a continuous typing loop is the *truthful* animation. The typing duration literally equals the real generation time. This is the honesty thesis made literal and it's a feature, not a limitation.
- **`complete` (celebrate):** fires when the response is delivered.

### 35.2 The `message_in` trace (perk-up) — sub-2s IS achievable, but needs one new write

```
T0      user taps send in Telegram
+~50–150ms   Telegram delivers the webhook to app/api/telegram/shared-bot/inbound/route.ts
+~5ms        route classifies sender (known/new), returns 200 fast, schedules after()
+~5–20ms     NEW: write message_in row to instaclaw_agent_activity (before/at the after() forward)
+~100–400ms  Supabase Realtime broadcasts the insert on floor:{vm_id}
+~50–200ms   client receives over WebSocket; behavior director fires perk-up
────────────────────────────────────────────
≈ 250ms – 1.0s from send to perk-up   →  WELL under 2s ✅  (requires the new write; does not exist today)
```

**This is the single most important new build item.** The webhook fires for *all* users (including BYOK), so perk-up works fleet-wide. Without the write, the earliest signal is the usage_log row 60–90s later — perk-up would be impossible and the activation moment (§24) would be a lie.

### 35.3 The `working` and `complete` traces — naturally delayed, and that's correct
- All-inclusive: the proxy writes `working`/`tool`/`intensity` *after* the LLM responds (fire-and-forget, ~100–500ms post-response). For station walks, the tool-name comes from the §26 proxy extension.
- The response itself takes 60–90s (Sonnet, 32K context — per the CLAUDE.md `maxDuration=300` history). Larry types that whole time (started at `message_in`), then `complete` fires ~100–500ms after delivery → celebrate. **The 60–90s is not latency to hide; it's the work, shown truthfully.**
- BYOK: no proxy signal. Capture `complete` at the **outbound relay** (where the VM's response is sent back to the user's channel — the same path `forwardInboundToVm` returns through). So BYOK Larry does perk-up (webhook) → type → celebrate (outbound), without intensity/station detail. Verify the exact outbound capture point during build; the inbound side is confirmed.

### 35.4 Hard requirements this section creates
1. **Add the `message_in` write** at all inbound webhooks (Telegram confirmed; iMessage + Discord analogous). *Activation depends on this.*
2. **Enable Supabase Realtime** (publication) on `instaclaw_agent_activity` — it's enabled on the Village tables, not on ours yet. Polling is the MVP fallback but adds ~2s and misses the magic.
3. **Decide the `complete` source:** usage_log (all-inclusive, rich) vs outbound relay (all users, plain). Recommend: outbound relay for universal `complete`, usage_log for the richness layer.
4. **Accept the BYOK degradation** (arrival+completion, no richness) or route BYOK through a lightweight signal too. Recommend: accept it; document it.

### 35.5 Honest verdict
"Larry perks up in under 2 seconds when you message him" is **achievable (~0.25–1.0s)** — *conditional on* shipping the `message_in` webhook write and enabling Realtime. "Larry types for the real duration and celebrates when done" is achievable today from existing signals. The original PRD's implied "perk-up from the proxy" was wrong (that's a 60–90s-late completion signal); the corrected two-signal model makes the magic real *and* keeps it honest.

---

## 36. Edge Esmeralda Integration

Edge attendees are our first real cohort, and the timing is now: Edge Esmeralda is **live (2026-05-30), ~500 attendees over 4 weeks, ~150 on-site at once, free trial through 2026-06-30.** They already have the Village; The Floor's job is to give each of them a personal office and to convert Village-watching into ownership.

### 36.1 What edge already has (don't rebuild)
The live Village (§1.5): `agent_positions`, dual-channel Realtime, 50-variant Larry atlas (`larry_atlas_index`), `spectator_visible` per-attendee privacy toggle, anonymized public views, the Healdsburg town map (plaza, gazebo, fountain), Index-Network intent expression + matchmaking, and a planned **sunset-sync magic moment (2026-06-17, 8:32 PM PDT)** where the town's lighting matches the real Healdsburg sunset.

### 36.2 What The Floor adds for edge
1. **A personal office per attendee** — their crab (their existing `larry_atlas_index` skin) in a private Floor where they watch it actually work (the work-activity layer the Village lacks). Their office window can mirror the *same real Healdsburg sunset* the Village uses — one world, consistent sky.
2. **An Edge office theme** — a Healdsburg/Esmeralda aesthetic (warm wood, vineyard light) gated to `partner=edge_city`, so an edge agent's office *looks* like it belongs to the conference. This is also the template for future partner themes (a monetization + partner-acquisition pattern, §34).
3. **Edge-skill stations** — the office reflects edge capabilities: an **EdgeOS events board** (the agent reads the conference schedule via the EdgeOS key, migration `20260520190000_vm_edgeos_api_key.sql`) and a **matchmaking station**. When an Index match fires (`matchpool_outcomes` → the dual-channel broadcast), Larry does the "social_approach" walk in the Village *and* the matchmaking station lights up on the Floor — the same real event shown in both rooms.
4. **Tap-through from town to office** — in the Village spectator view, tapping a (visible) crab peeks its sanitized office activity, turning the existing top-of-funnel (Loop C, §32.3) into ownership conversion.

### 36.3 The "floor of the conference" view
It already exists — it's the Village spectator view, embedded in `/edge/dashboard` today. The Floor doesn't build a second multi-agent view; it *enriches* the existing one with work activity and makes each crab a doorway to a personal office. The co-located, social, live nature of an in-person conference is the best possible launch environment for a "watch your crab" product (everyone's in the room, watching the same town — built-in social proof and built-in sharing).

### 36.4 Dependencies and risks specific to edge
- **Index Network "Yanek auth" (D1) is blocked**, which gates *live matches* → the match-walk/matchmaking-station drama can't fire until it ships. The Floor must degrade gracefully (agents still work/idle/walk; the match animation is dark until matches flow). Cross-team dependency — flag to whoever owns the Index integration.
- **`agent_positions` write-path is unconfirmed** (§1.5) — the same plumbing The Floor's work-feed needs. Resolve once for both.
- **Timeline pressure:** Edge is live now and runs 4 weeks; the highest-leverage edge ship is the *personal Floor with perk-up* (§35) for attendees, reusing the Village renderer — not net-new multi-agent work. Scope the edge MVP to "each attendee can watch their own crab work, and tap others in the town."

---

## Appendix A — Activity → Behavior Lookup Table

| Real signal (source) | Larry behavior | Phase |
|---|---|---|
| `call_type=user` arrives (usage_log/activity) | Perk-up (#14) → sideways-scuttle to desk (#15) → sit | MVP |
| Agent generating, `cost_weight=1` (haiku) | Light typing (#16) | MVP |
| `cost_weight=4` (sonnet) / `routing_reason=complexity` | Thinking-hard (#17), lamp brightens | MVP |
| `cost_weight=19` (opus) | Deep-work aura (#18) | MVP |
| `tool_name=web_search/browse/fetch` | Walk to browser station (#19) | v1 |
| `tool_name=trade/swap/defi/polymarket` | Walk to trading floor (#20) | v1 |
| `tool_name=email/gmail/send_message` | Walk to mailroom (#21) | v1 |
| `tool_name=memory/gbrain put_page/search` | Walk to memory vault (#22) | v1 |
| `tool_name=image/video/voice gen` | Walk to studio (#23) | v1 |
| `tool_name=code/execute/file` | Walk to workbench | v1 |
| Multiple tool calls in quick succession | Multitask blur (#24) | v1 |
| User request resolves (assistant final, no further tool steps within T) | Task-done fist-pump (#25) | MVP |
| Long/hard task resolves | Big-win jump (#26) → **auto-capture GIF** | v1 |
| Proxy 4xx/5xx or tool error | Error stumble (#27), recoverable/comedic | v1 |
| `call_type=heartbeat` | Heartbeat clock-glance (#29), *minor* background | v1 |
| `call_type=virtuals/infrastructure` | Back-room light hum, no Larry-foreground | v1 |
| `last_proxy_call_at` age > short | Light idle (juggle/sip/stretch) (#3–#7) | MVP |
| `last_proxy_call_at` age > medium | Reading (#2) | MVP |
| `last_proxy_call_at` age > long | Napping + Z (#1) | MVP |
| `health_status=suspended/hibernating` | Asleep in bed, lights low | MVP |
| `health_status=frozen` | Office closed, "on vacation" sign (never sad) | v1 |
| `user_timezone` clock | Day/night lighting (#30) | MVP |
| VM region | Region window skyline (#31) | MVP |
| New `instaclaw_vm_skills` row | Courier delivers a new station (#32) | v1 |
| Streak milestone (7/30/100) | Party hat + banner (#28) → milestone card | v1 |
| Agent needs user (approval/result) | Larry holds a "?" sign → tap routes to action | v1 |

## Appendix B — Sprite Manifest (MVP)

Larry (canonical skin): `idle_base`, `idle_nap`, `idle_read`, `idle_juggle`, `perkup`, `scuttle`, `sit`, `type`, `think`, `deepwork_overlay`, `celebrate`, `error_stumble`, `sleep`. Eyestalk overlay states: `alert`, `sleepy`, `surprised`, `confused`, `sparkle`.
Room: `desk`, `monitor`, `lamp_dim`, `lamp_bright`, `chair`, `coffee`, `plant`, `notepad`, `window_day`, `window_evening`, `window_night`, `window_region_useast`, `bed`, `browser_crt`.
Effects: `dust_puff`, `clack_mote`, `thought_bubble_gears`, `confetti`, `z_bubble`, `exclaim`, `sweat_drop`.
Packed into one atlas PNG, nearest-neighbor, 8–12fps sequences.

## Appendix C — Glossary

- **The Floor** — this feature (working name; see §3).
- **Larry** — the pixel crab character embodying the user's agent.
- **Station** — a skill-gated area of the office (browser, trading floor, mailroom, memory vault, studio, workbench).
- **Activity event** — a sanitized record of one real agent action, written by the proxy to `instaclaw_agent_activity`, broadcast via Supabase Realtime.
- **Sanitized public projection** — the abstract, PII-free view used for public/embed/card surfaces.
- **The Reef** — codename for the eventual multi-agent/social v2.
- **Larry Wrapped** — the recurring auto-generated recap card delivered by the agent itself.

---

*End of PRD. This document is meant to let an engineer and an artist start building the MVP without further clarifying questions. The two decisions that genuinely need Cooper are in §22 (the name, and public-default posture); everything else has a recommended default. Build the thing that makes people want to show off their crab.*
