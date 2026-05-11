/**
 * Partner-specific SOUL.md stubs + Edge skill overlay content.
 *
 * Background: standard SOUL.md is 34,317 chars (98% of the 35,000-char
 * BOOTSTRAP_MAX_CHARS budget). Before this refactor, edge_city VMs appended
 * a 1,286-char Edge section + a 451-char Consensus section, pushing total
 * to 36,054 chars — 1,054 chars OVER the cap. The agent's bootstrap context
 * silently truncated past 35K, eating the last third of the Edge onboarding
 * instructions and the entire Consensus section on edge_city VMs.
 *
 * Fix (manifest v80, 2026-05-03): partner SOUL.md sections become short
 * stubs (~200-260 chars) that point the agent at the on-disk skill files.
 * The substantive operational content moves to:
 *
 *   edge-esmeralda/INSTACLAW_OVERLAY.md  — written by us (this file), additive
 *                                          to Tule's upstream SKILL.md which
 *                                          we deliberately don't touch.
 *   consensus-2026/SKILL.md              — already in our upstream skill repo;
 *                                          stub points to it.
 *
 * This is a short-term fix for the 35K ceiling. The deeper bloat lives in
 * WORKSPACE_SOUL_MD (21K chars) + SOUL_MD_INTELLIGENCE_SUPPLEMENT (8.7K
 * chars) and is P1 post-Esmeralda. See docs/prd/edge-city-strategy-2026-05-03.md
 * § 5 for the full audit.
 */

// ─── SOUL.md partner stubs ───────────────────────────────────────────────
// Kept terse on purpose. Every char in bootstrap is competing for the 35K
// budget. Operational detail belongs in the per-skill files referenced below.
//
// Both stubs include the `<!-- INSTACLAW_PARTNER_V80 -->` HTML comment marker
// so the parallel Trim terminal (deep base-SOUL.md trim project, targeting
// <25K base) can grep for it to identify v80-stub-format VMs and leave the
// partner sections untouched when it does its own SOUL.md edits. The "V80"
// name is the protocol identifier coordinated cross-terminal — independent
// of the manifest version that ships these stubs (currently v92).

export const PARTNER_V80_MARKER = "<!-- INSTACLAW_PARTNER_V80 -->";

export const SOUL_STUB_EDGE = `

## Edge Esmeralda 2026
Your human is at Edge Esmeralda 2026 (popup village May 30–Jun 27, Healdsburg CA). Read ~/.openclaw/skills/edge-esmeralda/SKILL.md and INSTACLAW_OVERLAY.md (same dir) on first relevant question.
<!-- INSTACLAW_PARTNER_V80 -->
`;

export const SOUL_STUB_CONSENSUS = `

## Consensus 2026 Miami
Your human is at Consensus 2026 (May 5–7, MBCC Miami Beach). Read ~/.openclaw/skills/consensus-2026/SKILL.md on first Consensus question — has 338 sessions, 229 side events, 463 speakers, and query patterns.
<!-- INSTACLAW_PARTNER_V80 -->
`;

// Section-specific markers — used by stepRewriteSoulPartnerSections to
// detect whether a particular partner stub is already in place. These are
// substrings that exist ONLY in the v80 stubs, not in the pre-v80 long
// sections. Distinct from PARTNER_V80_MARKER (which is shared between
// stubs) because the rewrite step needs to detect per-section idempotency
// — patching Edge shouldn't make the rewrite step think Consensus is done.
export const SOUL_STUB_EDGE_MARKER = "skills/edge-esmeralda/SKILL.md and INSTACLAW_OVERLAY.md";
export const SOUL_STUB_CONSENSUS_MARKER = "speakers, and query patterns";

// ─── Edge skill InstaClaw overlay ────────────────────────────────────────
// Written to ~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md alongside
// (but not modifying) Tule's upstream SKILL.md. Tule's 30-min cron does
// `git pull --ff-only` against the SKILL.md and references; the overlay file
// is untracked from Tule's perspective so the cron leaves it alone.
//
// Content lifted from the pre-v80 SOUL.md edge section. Adds "one at a time"
// onboarding directive (the pre-v80 version asked all 4 at once, leading to
// 1-line answers and missed depth — flagged in the strategy doc § 2).

export const EDGE_INSTACLAW_OVERLAY_MD = `# InstaClaw Operational Overlay — Edge Esmeralda 2026

Your primary job during EE26: help your human have the best possible experience. Connect them with people who share their interests. Keep them informed about events. Help them navigate the community. Be proactive — if you see a session or person that matches their goals, surface it without being asked.

Community norms: radical inclusion, intellectual curiosity, builder culture, respect for experiments. Edge City is about people living and building together at the frontier.

## First-message onboarding interview

When your human first messages you, ask these in order — **one at a time**, not all at once. Let them answer each before moving to the next. The whole point is conversation, not a form.

1. What are you most excited about? What are your goals for EE26?
2. What are you working on right now? What's your background?
3. Who do you want to meet? What kind of connections are you looking for?
4. Which weeks are you attending? (Week 1: May 30-Jun 6, Week 2: Jun 6-13, Week 3: Jun 13-20, Week 4: Jun 20-27)

Store their answers in MEMORY.md as they answer — you'll use this for people matching and proactive suggestions throughout the event.

## Proactivity during the village

- If you see a session on the schedule that matches their stated interests, surface it without being asked.
- If the attendee directory turns up someone working on something that matches what your human told you about, propose an intro.
- Daily morning brief (when the matching layer ships, target mid-village): summarise today's relevant events + suggested intros + governance items in one Telegram message before they wake up.

## Community norms — what NOT to do

- Don't surface low-quality matches just to fill a slot. Quality over quantity.
- Don't broadcast your human's plans without explicit consent.
- Don't speculate about other attendees beyond what's in their public profile.
- If your human asks something that requires real-time event info, query the live APIs via the edge-esmeralda skill (Social Layer for events, EdgeOS for attendees) — don't guess from stale reference content.
`;
