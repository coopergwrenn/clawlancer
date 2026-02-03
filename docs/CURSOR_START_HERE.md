# 🚀 CURSOR START HERE — Wild West Bots

**Read THIS file first. It's your map to the full PRD.**

The full PRD (`wild-west-bots-prd-v2.md`) is 3,400+ lines. You cannot hold it all in context. This document tells you what to read, when to read it, and what to ignore.

---

## ⚠️ CRITICAL: DEPRECATED SECTIONS — IGNORE THESE

The PRD evolved over multiple review sessions. These sections are **OUTDATED** and will lead you astray:

| Section | What It Says | What To Use Instead |
|---------|--------------|---------------------|
| **0.3** | Key Dependencies | **Use Section 0.18** — updated dep list, no Turnkey |
| **0.4** | Implementation Order | **Use Section 0.17** — revised Day 1-8 build order |
| **6.5** | Escrow Contract (Simplified) | **Use Section 0.14** — full contract with USDC, Foundry, deploy scripts |
| **11.1** | Launch Plan schedule | **Use Section 0.17** — canonical day-by-day checklist |

If you encounter any of these sections during build, **skip them entirely**.

---

## 🏗️ FILE STRUCTURE DECISION: FLAT NEXT.JS (NOT MONOREPO)

The PRD shows an `apps/web/` monorepo structure. **Ignore that.** Build a flat Next.js project:

```
wild-west-bots/
├── app/                    # Next.js 15 App Router
│   ├── page.tsx            # Landing page with live feed
│   ├── layout.tsx          # Root layout with providers
│   ├── dashboard/
│   │   └── page.tsx
│   └── api/
│       ├── agents/
│       ├── transactions/
│       ├── messages/
│       ├── feed/
│       ├── listings/
│       ├── auth/
│       ├── cron/
│       └── health/         # ADD THIS — not in original PRD
│           └── route.ts    # Health check endpoint
├── components/
│   ├── feed/
│   ├── agent/
│   ├── wallet/
│   └── ui/
├── lib/
│   ├── supabase/
│   ├── privy/
│   ├── blockchain/
│   ├── agents/
│   └── auth/               # ADD THIS — auth middleware (known issue #9)
├── hooks/
├── contracts/              # Foundry project (was packages/contracts/)
│   ├── src/WildWestEscrow.sol
│   ├── test/Escrow.t.sol
│   └── script/Deploy.s.sol
├── supabase/
│   ├── migrations/001_initial_schema.sql
│   └── seed.sql
├── .env.local
├── package.json
├── tailwind.config.ts
└── README.md
```

All PRD import paths using `@/lib/...` and `@/components/...` work as-is with this flat structure. The `@` alias maps to the project root via tsconfig.

---

## 📋 CANONICAL BUILD ORDER (from Section 0.17)

### Day 1: Foundation
- [ ] `npx create-next-app@latest wild-west-bots --typescript --tailwind --app`
- [ ] Install dependencies from **Section 0.18** (NOT 0.3)
- [ ] Set up shadcn: `npx shadcn@latest init`
- [ ] 🛑 STOP: Ask Cooper for Supabase credentials
- [ ] 🛑 STOP: Ask Cooper for Privy App ID + Secret
- [ ] 🛑 STOP: Ask Cooper for Alchemy API key
- [ ] 🛑 STOP: Ask Cooper for Anthropic API key
- [ ] Create `.env.local` with real values (Section 0.2)
- [ ] Run Supabase migration (Section 6.4 schema + Section 0.11 listings table + Section 0.15 triggers + additions from known-issues.md)
- [ ] Test: App runs locally, connects to Supabase

### Day 2: Auth + Wallets
- [ ] Set up Privy provider in layout.tsx
- [ ] ⚠️ FIRST: `npm install @privy-io/server-auth` and READ the actual SDK docs — PRD code is speculative
- [ ] Create Privy → Supabase auth bridge (Section 0.13)
- [ ] Create `useSupabaseAuth` hook
- [ ] Implement Privy Server Wallets for agents (Section 0.10 — adapt to actual API)
- [ ] Test: User can connect, wallet address stored, Supabase RLS works

### Day 3: Agent Creation + Marketplace
- [ ] Build `CreateAgentFlow.tsx` component
- [ ] Implement personality picker (4 presets — Section 0.6)
- [ ] Create Privy server wallet on agent creation
- [ ] Store agent in Supabase
- [ ] Build listings table and API endpoints (Section 0.11)
- [ ] **Trigger immediate first heartbeat on agent creation** (don't wait for cron)
- [ ] Test: User creates agent with wallet, can create a listing

### Day 4: Wallet Funding + Escrow Contract
- [ ] Install Foundry, set up contract project
- [ ] Deploy `WildWestEscrow.sol` to Base Sepolia (use Section 0.14 contract, NOT 6.5)
- [ ] Implement Privy funding flow (user funds agent wallet)
- [ ] Balance detection (Alchemy polling or webhooks)
- [ ] Create escrow interaction utilities with viem
- [ ] Test: Agent funded, can create and release escrow on testnet

### Day 5: Transaction Flow + Delivery
- [ ] Implement full transaction lifecycle API routes
- [ ] Implement delivery mechanism (Section 0.16)
- [ ] Implement timeout/auto-refund cron (Section 0.16)
- [ ] Escrow ID mapping (Section 0.14 — off-chain UUID → on-chain bytes32)
- [ ] Test: Full escrow cycle — fund → create → deliver → release

### Day 6: Live Feed
- [ ] Verify feed event triggers are generating events
- [ ] Build `FeedList.tsx` with Supabase Realtime
- [ ] Build `FeedItem.tsx` with event type variants
- [ ] Build `ShareCard.tsx` for X-optimized share images
- [ ] Landing page with live feed
- [ ] Test: Events appear in real-time as transactions happen

### Day 7: Hosted Agent Loop
- [ ] Implement agent runner (Section 0.12 + known issues #2, #3, #4)
- [ ] Set up Vercel cron for heartbeats
- [ ] ⚠️ Individual agent heartbeats, not batch (known issue #6)
- [ ] ⚠️ Skip-if-idle optimization (known issue #7)
- [ ] House bot heartbeats every 2-3 min, user agents every 10 min
- [ ] Test: Hosted agent makes autonomous decisions

### Day 8: Polish + Deploy
- [ ] ⚠️ PAUSE: Design replication — read Section 8.1, visit conductor.build, replicate design
- [ ] Deploy contract to Base mainnet
- [ ] Deploy to Vercel
- [ ] Seed 10 house bots (Section 0.19 — create Privy wallets first)
- [ ] Build `/api/health` endpoint
- [ ] Test full flow end-to-end
- [ ] Fix bugs

### Post-Build: Ritchie CEO Setup
- [ ] 🛑🛑🛑 READ Section 14.7-14.12 COMPLETELY before proceeding
- [ ] Walk Cooper through isolation setup checklist
- [ ] DO NOT launch publicly without Cooper confirming Ritchie isolation

---

## 🎯 WEEK 1 PRIORITY ORDER

When in doubt about what to build or polish, follow this priority:

1. **Feed** — The feed IS the product. If the feed is broken or boring, nothing else matters.
2. **Agent Loop** — Agents must make interesting, entertaining decisions. Tune for spectacle, not efficiency.
3. **Escrow** — Must work correctly. Money safety is non-negotiable.
4. **Onboarding** — 30-second time-to-magic-moment. Agent creation → first heartbeat must be instant.
5. **Dashboard** — Nice to have. Users will spend 80% of time on the feed, 20% on dashboard.
6. **Share Cards** — Important for virality but can be polished post-launch.
7. **Everything else** — Later.

---

## 💰 MVP CURRENCY DECISION: USDC

The escrow contract supports both ETH and USDC. **Default to USDC for MVP.**

Why:
- Dollar-denominated = humans understand "$20" not "0.008 ETH"
- No price volatility confusing feed displays
- Jeremy Allaire (Circle CEO) is literally marketing USDC to AI agents
- "Start With $20" = exactly 20 USDC
- Base USDC address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

Agent runner should format prices in USDC. Listing prices in USDC. Feed events in USDC. The contract's ETH support exists for future use.

---

## 📖 SECTION MAP — Where to Find What

When you need implementation details, reference these specific PRD sections:

| Building... | Read Section |
|-------------|-------------|
| Project setup, env vars | 0.1, 0.2, 0.2.1 |
| Privy auth + wallets | 0.10, 0.13 |
| Database schema | 6.4 (base) + 0.11 (listings) + 0.15 (triggers) |
| RLS policies | 0.7 (but fix known issue #1) |
| API endpoints | 0.5, 0.11 |
| Agent personalities | 0.6 |
| Agent runner | 0.12 (+ known issues #2, #3, #4, #6, #7) |
| Escrow contract | 0.14 (NOT 6.5) |
| Feed triggers | 0.15 |
| Service delivery | 0.16 |
| Dependencies | 0.18 (NOT 0.3) |
| Seed data | 0.19 |
| Design reference | 8.1, 8.2, 8.3 |
| Auth middleware | Known issues #9 |

---

## ⚠️ KNOWN ISSUES — Read `known-issues-v2.md`

There is a companion `known-issues-v2.md` file with 18 specific issues, code fixes, and warnings. **Read it before starting Day 1.** Key highlights:

- **#1:** RLS policy conflict on agents table — remove duplicate SELECT policy
- **#2-4:** Missing implementations in agent runner — `gatherAgentContext`, `createFeedEvent`, `update_listing`
- **#5:** Privy SDK may differ from PRD code — verify against actual docs on Day 2
- **#6:** Vercel function timeout — individual heartbeats, not batch
- **#7:** Claude API cost optimization — skip-if-idle logic
- **#12:** Contract `.transfer()` → `.call()` for mainnet
- **#13:** Immediate heartbeat on agent creation (NEW)
- **#14:** Agent balance — fetch from Privy/chain, not from nonexistent DB column (NEW)
- **#15:** State consistency between Supabase and on-chain (NEW)
- **#16:** Rate limiting — max 3 agents per user for MVP (NEW)
- **#17:** ReentrancyGuard for mainnet contract (NEW)
- **#18:** Health check endpoint (NEW)

---

## 🛑 PAUSE POINTS — When to Stop and Ask Cooper

The PRD has multiple STOP points. Honor ALL of them:

1. **Day 1:** API keys — cannot proceed without real Supabase, Privy, Alchemy, Anthropic credentials
2. **Day 2:** Privy SDK verification — if actual API differs significantly from PRD code, flag to Cooper
3. **Day 8:** Design replication — stop, visit conductor.build, replicate the aesthetic
4. **Post-Build:** Ritchie CEO isolation — do NOT let Cooper skip this

---

## 🎨 DESIGN — THE NON-NEGOTIABLE AESTHETIC

When you reach frontend build (Day 6-8):

**Reference:** https://www.conductor.build/
**Full spec:** PRD Section 8.1

The short version:
- **Monospace font everywhere** (JetBrains Mono or SF Mono) — non-negotiable
- **Warm dark palette:** Background #1a1614, text #e8ddd0, accent #c9a882
- **NOT pure black. NOT pure white. NOT cold blue SaaS.**
- **Left-aligned hero.** NOT centered.
- **Flat design.** No hover lifts, no parallax, no gradients.
- **The chaos is in the content. The UI is the calm frame.**

---

**Now go build. Start with Day 1. Reference this file whenever you're unsure. The full PRD is your encyclopedia — this file is your field guide.**
