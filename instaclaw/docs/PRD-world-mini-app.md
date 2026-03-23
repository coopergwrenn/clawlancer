# PRD: InstaClaw World Mini App

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-22
**Status:** Draft v3 — Final Feedback Applied, Ready for Build
**Target:** World App Mini Apps platform

---

## 1. Executive Summary

### What

Launch InstaClaw as a World mini app — a mobile-native experience inside World App that lets users deploy, manage, and interact with their AI agents. Users sign in with World ID, pay with WLD/USDC via World wallet, and get human-verified agents registered on AgentBook out of the box.

Every verified World ID holder gets a free AI agent, funded by delegating a portion of their monthly WLD grant. This turns World ID verification from "free money" into "free AI agent" — driving both World ID verifications and InstaClaw adoption simultaneously.

### Why

- **Distribution:** World App has millions of active users. Mini apps get native placement in the app's discovery surface — no App Store review, no install friction. We have insider distribution from day one (see Section 2).
- **Identity fit:** InstaClaw already has World ID verification (WDP 71) and AgentBook registration. A mini app makes World ID the *primary* auth path instead of an optional add-on.
- **Payments fit:** World wallet supports WLD and USDC on Worldchain. We already accept USDC. Replacing Stripe with native wallet payments eliminates credit card friction and opens crypto-native billing.
- **Technical fit:** InstaClaw is already Next.js 15+ on Vercel. World mini apps are webview-based Next.js apps using MiniKit SDK. The migration path is clean.
- **WLD Grant Synergy:** The WLD delegation model (Section 3) creates a flywheel — free agents funded by WLD grants → agents earn their own compute via Clawlancer/aGDP/prediction markets → self-sustaining ecosystem.

### Key Constraint

Mini apps run in a mobile WebView. The existing InstaClaw dashboard is desktop-optimized with sidebar navigation, complex tables, and desktop-first layouts. The mini app needs a purpose-built mobile UI following World's design guidelines (tab navigation, no sidebars, no hamburger menus, snap-to inputs).

---

## 2. Partnerships & Distribution

### World Foundation — Direct Relationship

Cooper has direct contacts at World Foundation: **Mateo** and **Layton**.

- **Fast-track review:** Mateo has confirmed he will fast-track the mini app review the moment it's submitted — instant approval, no multi-week review queue.
- **Featured placement:** World will feature the mini app to all their users once it's live. This is not a cold launch buried in a store — we get prominent placement from day one.
- **Coordination:** Before submission, coordinate with Mateo to ensure app assets, metadata, and configuration are aligned with World's expectations. He can expedite any Developer Portal issues.
- **New App ID:** Mateo can help create and configure a new mini app registration in the Developer Portal, separate from the existing WDP 71 web integration.

### Distribution Strategy

1. **Launch day:** Featured placement in World App → immediate exposure to millions of users
2. **WLD grant hook:** "Get a free AI agent just by verifying" — this is the acquisition message that drives World ID verifications AND InstaClaw signups
3. **Viral loop:** MiniKit.shareContacts() + MiniKit.share() + World Chat sharing → organic growth within the World ecosystem
4. **Cross-platform:** Existing instaclaw.io users see "Use InstaClaw in World App" banner → drives World App adoption

This is not a speculative launch. We have confirmed insider distribution and a novel acquisition mechanic (WLD delegation) that benefits both World and InstaClaw.

---

## 3. WLD Grant Delegation Model

**This is the killer feature. The entire mini app strategy centers on this.**

### The Concept (from Mateo at World Foundation)

1. Every verified World ID holder gets a **FREE InstaClaw agent**
2. World Chat becomes a messaging interface (alongside Telegram)
3. The human delegates a portion of their monthly WLD grant (the free WLD they receive for verifying as a real human) to pay for the agent's compute
4. The agent starts basic but the user can expand access, skills, and upgrade to a full subscription over time

### Why This Is Genius

- **Solves the cold start problem.** The agent is free to the user but still funded via WLD delegation. No credit card required, no subscription decision paralysis — just delegate some of the WLD you already got for free.
- **Creates a NEW reason to verify on World.** You're not just verifying for free money — you're verifying to get a free AI agent. This drives World ID verifications, which is why World Foundation is incentivized to feature us.
- **Instant distribution to every verified human on World.** Millions of users, zero acquisition cost.
- **Self-sustaining economics.** The WLD delegation covers the first month of usage. After that, the user either subscribes, buys credit packs, or their agent can earn its own compute costs through Clawlancer, aGDP, and prediction markets.

### What InstaClaw Already Has That Makes This Work

- **XMTP messaging** already working with agents
- **Credit system** that maps directly to WLD delegation amounts — credits are fungible regardless of payment source
- **Agents earn autonomously** through Clawlancer, aGDP, prediction markets — so the agent can eventually pay for itself beyond the WLD grant
- **Full VM provisioning pipeline** for instant agent deployment — no manual setup required
- **World ID verification** already integrated (WDP 71) — we just switch from IDKit to MiniKit.verify()

### Implementation

#### 3-Tap Onboarding — Open to Chatting in Under 60 Seconds

The entire onboarding is exactly 3 taps. No wizard, no multi-step forms, no decisions. The user goes from opening the app to chatting with their AI agent in under 60 seconds.

```
TAP 1: "Get your free AI agent"
  → Full-screen CTA, western-themed
  → SIWE walletAuth fires first (bundled, not a separate step)
  → Then MiniKit.verify() fires inline (World App modal for Orb verification)
  → User confirms in World App → returns automatically
  → Agent provisioning starts in background immediately after verification

  IF VERIFICATION FAILS OR USER ISN'T ORB-VERIFIED:
  → Show two fallback paths (see "Non-Orb Users" below)

TAP 2: "Activate with 5 WLD"
  → Pre-selected delegation amount (5 WLD = ~$1.50 = 25 credits for ~3 days)
  → MiniKit.pay() fires — user confirms in World App modal
  → Credits added to agent while UI transitions to next screen
  → Show "Your agent is powering up..." animation

TAP 3: "Start chatting"
  → MiniKit.commandsAsync.chat() opens World Chat with agent
  → Agent is ready by the time user sends first message
  → User is now chatting with their AI agent

#### Non-Orb Users — Fallback Paths

If Tap 1 verification fails or the user isn't Orb-verified, show two options:

**Path A — Funnel into World Grow (preferred):**
"Get Orb verified to unlock your free agent"
→ [Get Verified] button deep-links into World's Orb verification flow
→ We register as a Grow referral source so we earn the referral bounty when they verify
→ After verification completes, user returns to the mini app and resumes the 3-tap flow from Tap 2
→ We get paid the Grow referral fee AND the user gets their free agent — double win

**Path B — Skip verification, pay from day one:**
"Don't have World ID? Subscribe now to get started."
→ [Subscribe now] opens instaclaw.io Stripe checkout in in-app browser
→ OR [Buy credits with USDC] triggers MiniKit.pay for a credit pack
→ No free agent, no WLD delegation — user pays market rate
→ Agent is provisioned after payment confirms
→ User can still verify later to unlock WLD delegation benefits

**Question for Mateo:** How do we register as a Grow referral source for World ID verifications? Is there a referral link format or API we can use so that verifications driven from our mini app earn us the Grow bounty?
```

Everything else — skills browser, settings, Telegram pairing, dashboard details, credit balance — is discoverable AFTER the user has chatted at least once. When the user returns to the mini app after their first chat, they land on the main dashboard with a dismissable prompt:

> "Want more from your agent? Browse skills, connect Telegram, or visit instaclaw.io for the full dashboard."

#### WLD Delegation Mechanics

1. User approves a WLD transfer via MiniKit.pay() — this is a one-time delegation, not a recurring charge
2. WLD converts to InstaClaw credits at current WLD/USD rate (via Worldchain oracle or CoinGecko)
3. Credits are added to the user's agent via existing `instaclaw_add_credits()` RPC
4. When credits run low, the user is prompted with two clear options:
   - **"Stake more WLD"** — one-tap MiniKit.pay for the same delegation tier they previously chose
   - **"Subscribe for unlimited"** — opens instaclaw.io Stripe checkout in in-app browser, returns to mini app after

#### Credits Exhausted UX

When credits hit zero:
1. **Agent pauses and sends a final message in World Chat:** "I'm paused — credits ran out. Stake more WLD or subscribe for unlimited to keep me running. [Reopen InstaClaw →]" (deep-link back to mini app billing page)
2. **Push notification fires:** "Your agent's credits ran out — stake WLD to keep it running"
3. **Mini app dashboard shows prominent banner:** "Agent paused — [Stake WLD] [Subscribe for unlimited]"
4. **"Stake WLD"** = one-tap MiniKit.pay for the delegation tier they previously chose (no decision needed — same amount, one tap)
5. **"Subscribe for unlimited"** = opens instaclaw.io Stripe checkout in in-app browser with return deeplink (`https://world.org/mini-app?app_id=...&path=/settings`)

This is the key upsell moment. Make it frictionless, not punitive. The agent doesn't disappear — it pauses and tells the user exactly what to do.

#### Suggested Delegation Amounts

| Tier | WLD Amount | Approx USD | Credits | Duration | Our Margin |
|---|---|---|---|---|---|
| Try it | 5 WLD | ~$1.50 | 25 credits | ~3 days | ~60% ($0.60 cost) |
| Starter | 15 WLD | ~$4.50 | 45 credits | ~1 week | ~50% ($2.25 cost) |
| Full month | 50 WLD | ~$15 | 200 credits | ~1 month | ~50% ($7.50 cost) |

*WLD price: ~$0.30/WLD (as of 2026-03-22). Amounts are set to be profitable — we take ~50% margin on the WLD→credit conversion. The "Try it" tier (5 WLD) costs the user tokens they got for free, so the psychological barrier is near zero.*

**Pricing must be profitable, not break-even.** The WLD delegation model is the top of the funnel — it's designed to get users hooked on their agent so they convert to Stripe subscribers or regular credit pack buyers. Even the delegation itself should generate margin, not just cover compute costs.

#### $INSTACLAW Token Staking

**Contract:** `0xA9E23871156718C1D55e90dad1c4ea8a33480DFd` (Base mainnet, ERC-20, launched via Virtuals Protocol)
**Current price:** ~$0.0023 | **Market cap:** ~$659K | **Supply:** 1B total, ~282M circulating

**The problem:** $INSTACLAW is on Base only. MiniKit.pay() only supports WLD and USDC on Worldchain. No cross-chain support.

**The solution (phased):**

**v1 — Accept $INSTACLAW on Base via instaclaw.io (not MiniKit):**
- Add a "Stake $INSTACLAW" option on the delegation screen that opens instaclaw.io in an in-app browser
- instaclaw.io handles the Base transaction directly (we already have viem + Base RPC)
- User approves ERC-20 transfer on Base → credits added to their agent
- This works TODAY with zero Worldchain changes

**v2 — Native $INSTACLAW on Worldchain:**
- Deploy $INSTACLAW (or a bridged wrapper) as an ERC-20 on Worldchain
- Whitelist the contract in the World Developer Portal (Configuration → Advanced)
- Use `MiniKit.commandsAsync.sendTransaction()` to call `transfer()` directly
- Register with Permit2 for signature-based transfers
- **Note:** `sendTransaction()` does NOT sponsor gas like `pay()` does — user needs ETH on Worldchain for gas, or we need a paymaster

**$INSTACLAW Delegation Tiers:**

| Tier | $INSTACLAW Amount | Approx USD | Credits | Duration |
|---|---|---|---|---|
| Try it | 650 INSTACLAW | ~$1.50 | 25 credits | ~3 days |
| Starter | 2,000 INSTACLAW | ~$4.50 | 45 credits | ~1 week |
| Full month | 6,500 INSTACLAW | ~$15 | 200 credits | ~1 month |

*Amounts at ~$0.0023/INSTACLAW. Will need a price feed (CoinGecko API has it).*

**Tokenomics angle:** Staking $INSTACLAW for agent access creates direct utility and buy pressure for the token:
- Every verified World ID holder who chooses $INSTACLAW staking locks tokens for the duration
- Agent access is a real, tangible utility — not speculative
- Creates a flywheel: more agents → more $INSTACLAW demand → higher price → more attractive to stake
- Ties into any future NFT/staking governance design (e.g., $INSTACLAW stakers get priority features, premium models, exclusive skills)

**Delegation screen UX — three options:**

```
How would you like to power your agent?

[Stake 5 WLD]              ← primary, for World ID verified users (free money)
[Stake 650 $INSTACLAW]     ← for token holders (opens instaclaw.io in v1)
[Pay 5 USDC]               ← for everyone else
```

The default selection is WLD for Orb-verified users (lowest friction — staking free tokens). $INSTACLAW is second for existing token holders. USDC is the universal fallback.

#### Database

```sql
CREATE TABLE instaclaw_wld_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES instaclaw_users(id),
  vm_id UUID REFERENCES instaclaw_vms(id),
  amount_wld NUMERIC(18,8) NOT NULL,
  amount_usd NUMERIC(10,2) NOT NULL,
  wld_usd_rate NUMERIC(10,4) NOT NULL,
  credits_granted INTEGER NOT NULL,
  transaction_id TEXT,
  transaction_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, failed
  delegated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- optional: when credits are expected to run out
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX idx_wld_delegations_user ON instaclaw_wld_delegations(user_id);
```

---

## 4. Architecture Decision

### Options Evaluated

| Criteria | Option A: Separate App (`instaclaw-mini/`) | Option B: Route Group (`app/(mini-app)/`) | Option C: Subdomain (`mini.instaclaw.io`) |
|---|---|---|---|
| Code sharing | Import from `../instaclaw/lib` via monorepo | Direct imports, same `lib/` | Duplicate or npm package |
| Deployment | Separate Vercel project | Same Vercel project, same deploy | Separate Vercel project |
| Auth isolation | Clean — own auth config | Must coexist with NextAuth in middleware | Clean — own auth config |
| MiniKit SDK scope | Only loads in mini app | Must conditional-load (desktop vs WebView) | Only loads in mini app |
| Build impact | Zero impact on instaclaw.io builds | Increases bundle, shared build pipeline | Zero impact on instaclaw.io builds |
| API routes | Own routes or proxy to instaclaw.io | Shared routes, auth complexity | Own routes or proxy to instaclaw.io |
| Domain config | `mini.instaclaw.io` or Vercel preview | Same domain (`instaclaw.io/(mini-app)/*`) | `mini.instaclaw.io` |

### Decision: Option C — Separate deployment on `mini.instaclaw.io`

**Rationale:**

1. **Auth isolation is critical.** InstaClaw uses NextAuth with Google OAuth + JWT sessions. The mini app uses MiniKit wallet auth (SIWE) with World ID. These are fundamentally different auth flows. Cramming both into the same middleware creates complexity and bug surface. Separate deployments keep auth clean.

2. **MiniKit SDK is app-wide.** `MiniKitProvider` wraps the root layout. In Option B, every page in the existing app would load inside the provider — wasteful at best, breaking at worst (MiniKit calls fail outside World App WebView).

3. **Mobile-first requires different UI.** World's design guidelines mandate tab navigation, no sidebars, no hamburger menus, mobile-optimized everything. The existing dashboard is desktop-first. A route group would force coexistence of two incompatible layout systems.

4. **Shared backend via API.** The mini app calls the same Supabase database and the same instaclaw.io API routes for VM operations. No code duplication for backend logic — the mini app is a thin mobile frontend over the existing API surface.

5. **Monorepo keeps code close.** `instaclaw-mini/` lives alongside `instaclaw/` in the same repo. Shared types, constants, and utilities can be imported directly. Vercel's monorepo support handles independent deploys with `ignoreCommand` (we already use this pattern — see `instaclaw/vercel.json`).

6. **Independent deployment cadence.** Mini app iterations (UI tweaks, World-specific features) ship without risking the production dashboard. Build failures in one don't block the other.

### Directory Structure

```
wild-west-bots/
├── instaclaw/              # Existing dashboard (instaclaw.io)
├── instaclaw-mini/         # World mini app (mini.instaclaw.io)
│   ├── app/
│   │   ├── layout.tsx      # Root: MiniKitProvider + auth context
│   │   ├── page.tsx        # Home / agent status
│   │   ├── (tabs)/
│   │   │   ├── agent/      # Agent management
│   │   │   ├── skills/     # Skills browser
│   │   │   ├── chat/       # Agent chat (World Chat + Telegram)
│   │   │   └── settings/   # Account + billing
│   │   └── api/
│   │       ├── auth/       # World ID wallet auth (SIWE)
│   │       ├── nonce/      # SIWE nonce generation
│   │       ├── verify/     # World ID proof verification
│   │       ├── pay/        # Payment initiation + confirmation
│   │       ├── delegate/   # WLD delegation flow
│   │       └── proxy/      # Authenticated proxy to instaclaw.io
│   ├── components/
│   │   ├── minikit-provider.tsx
│   │   ├── tab-bar.tsx
│   │   ├── agent-card.tsx
│   │   ├── onboarding/     # Mobile onboarding wizard
│   │   └── ...
│   ├── lib/
│   │   ├── auth.ts         # SIWE session management
│   │   ├── supabase.ts     # Direct DB client (shared instance)
│   │   └── api.ts          # Authenticated proxy to instaclaw.io APIs
│   ├── package.json
│   ├── next.config.ts
│   ├── tailwind.config.ts
│   └── vercel.json
├── packages/               # (future) Shared types/utils if needed
└── ...
```

---

## 5. MiniKit SDK Integration Spec

### Dependencies

```json
{
  "@worldcoin/minikit-js": "^1.11.0",
  "@worldcoin/minikit-react": "^1.9.14",
  "@worldcoin/mini-apps-ui-kit-react": "^0.0.6",
  "viem": "^2.47.1",
  "next": "^16.1.6",
  "react": "^19.2.3"
}
```

### Root Layout

```tsx
// app/layout.tsx
import { MiniKitProvider } from "@worldcoin/minikit-js/minikit-provider";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <MiniKitProvider appId={process.env.NEXT_PUBLIC_APP_ID}>
          {children}
        </MiniKitProvider>
      </body>
    </html>
  );
}
```

### Environment Variables

| Variable | Source | Description |
|---|---|---|
| `NEXT_PUBLIC_APP_ID` | Developer Portal (NEW mini app registration) | `app_${hex}` format |
| `DEV_PORTAL_API_KEY` | Developer Portal (one-time visible) | Backend payment verification |
| `JWT_SECRET` | Self-generated (min 32 chars) | Session token signing |
| `NEXT_PUBLIC_RECIPIENT_ADDRESS` | Our treasury wallet on Worldchain | Payment recipient |
| `SUPABASE_URL` | Existing | Same Supabase instance |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing | Backend DB access |
| `INSTACLAW_API_URL` | `https://instaclaw.io` | Proxy target for VM operations |

### WebView Detection

```tsx
const isInWorldApp = MiniKit.isInstalled();
// Use this to show "Open in World App" fallback on direct browser access
```

### Commands Used

| Command | Purpose | When |
|---|---|---|
| `walletAuth` | Sign in via SIWE | Login flow |
| `verify` | World ID proof of humanity | Onboarding (required for free agent) |
| `pay` | WLD/USDC credit purchases + WLD delegation | Billing + onboarding |
| `sendTransaction` | AgentBook on-chain registration | Agent setup |
| `requestPermission` | Push notifications | Onboarding |
| `sendHapticFeedback` | Tactile UI feedback | Interactions |
| `share` | Share agent profile/output | Virality |
| `shareContacts` | Invite friends | Growth |

---

## 6. Auth Flow: World ID → Supabase User Mapping

### Current State (instaclaw.io)

```
Google OAuth → NextAuth → JWT cookie → instaclaw_users.google_id
```

### Mini App Flow

```
World Wallet → SIWE → JWT cookie → instaclaw_users.world_wallet_address
                                     (+ world_id_nullifier_hash if verified)
```

### Detailed Flow

#### Step 1: Nonce Generation (Server)
```
GET /api/nonce
→ Generate crypto.randomUUID().replace(/-/g, "")
→ Store in httpOnly cookie "siwe-nonce"
→ Return { nonce }
```

#### Step 2: Wallet Auth (Client)
```tsx
const { finalPayload } = await MiniKit.commandsAsync.walletAuth({
  nonce,
  statement: "Sign in to InstaClaw",
  expirationTime: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
});
// finalPayload: { status, message, signature, address }
```

#### Step 3: SIWE Verification + Session (Server)
```
POST /api/auth/login
← { message, signature, address } from walletAuth
→ verifySiweMessage(payload, nonce) // MiniKit helper
→ Lookup instaclaw_users by world_wallet_address
  → If not found: check for linked account (see Account Linking below)
  → If still not found: create new user row with wallet address
  → If found: load existing user
→ Sign JWT with { userId, walletAddress }
→ Set httpOnly cookie "session"
→ Return { user }
```

#### Step 4: World ID Verification (Required for free agent)
```tsx
const { finalPayload } = await MiniKit.commandsAsync.verify({
  action: "instaclaw-verify-human",
  verification_level: "orb",
});
// Send proof to /api/verify for backend verification via verifyCloudProof()
// Update instaclaw_users: world_id_verified = true, world_id_nullifier_hash = ...
```

### Database Changes

New columns on `instaclaw_users`:

```sql
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS world_wallet_address TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'google';
  -- auth_provider: 'google' | 'world' — tracks how the user signed up
```

### Account Linking — DECISION

**Decision: Auto-link by World ID nullifier hash.** Separate accounts is NOT acceptable — a user who signed up on instaclaw.io must NOT lose their agent when they open the mini app.

**Primary method:** If a user has verified with World ID on both instaclaw.io and the mini app, their accounts are automatically linked via matching `world_id_nullifier_hash`. During SIWE login (Step 3), the backend checks:

1. Look up user by `world_wallet_address` — if found, done
2. If not found, look up user by `world_id_nullifier_hash` (from the verify step) — if found, add `world_wallet_address` to that existing user row. The user keeps their agent, credits, everything.
3. If still not found, create a new user

**Fallback:** For users who haven't verified World ID on one platform, provide a manual link flow in Settings: "Already have an InstaClaw account? Link it here" → redirects to instaclaw.io login → signs a message on both platforms → accounts merged.

**Implementation note:** The nullifier hash lookup happens during the `verify` step (Step 4), not during `walletAuth` (Step 2). So the flow is: sign in with wallet → if new user, create row → verify World ID → if nullifier matches existing user, MERGE the new row into the existing one (transfer wallet address, delete the new row).

---

## 7. Payment Flow: World Wallet → Credits

### Current State (Stripe)

```
Select credit pack → Stripe checkout → Webhook → instaclaw_add_credits() RPC
```

### Mini App Flow (World Wallet)

```
Select credit pack → MiniKit.pay() → Dev Portal API verify → instaclaw_add_credits() RPC
```

### Detailed Flow

#### Step 1: Initiate Payment (Server)
```
POST /api/pay/initiate
← { pack: "50" | "200" | "500" }
→ Generate reference UUID
→ Store in DB: instaclaw_world_payments (reference, user_id, pack, status: "pending")
→ Return { reference, amount, token }
```

#### Step 2: Execute Payment (Client)
```tsx
import { tokenToDecimals, Tokens } from "@worldcoin/minikit-js";

const { finalPayload } = await MiniKit.commandsAsync.pay({
  reference,
  to: process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS,
  tokens: [{
    symbol: Tokens.USDC,
    token_amount: tokenToDecimals(packPriceUSD, Tokens.USDC),
  }],
  description: `InstaClaw ${pack} credit pack`,
});
```

#### Step 3: Confirm Payment (Server)
```
POST /api/pay/confirm
← { reference, transactionId } from pay response
→ Verify via Dev Portal API:
  GET https://developer.worldcoin.org/api/v2/minikit/transaction/{transactionId}
    ?app_id={APP_ID}&type=payment
  Authorization: Bearer {DEV_PORTAL_API_KEY}
→ Check transaction_status === "mined"
→ Check reference matches stored reference
→ Call instaclaw_add_credits(vm_id, credits)
→ Update instaclaw_world_payments: status = "confirmed", tx_hash
→ Return { success, newBalance }
```

### Credit Pack Pricing (same as Stripe)

| Pack | Credits | Price (USDC) | Price (WLD) |
|---|---|---|---|
| Starter | 50 | 5 USDC | ~equivalent WLD |
| Standard | 200 | 15 USDC | ~equivalent WLD |
| Power | 500 | 30 USDC | ~equivalent WLD |

**Note:** WLD pricing requires a price oracle or fixed rate. For v1, support USDC and WLD via `MiniKit.pay()`. $INSTACLAW credit packs are handled via instaclaw.io in-app browser (Base chain transaction) until $INSTACLAW is deployed on Worldchain.

### Subscription Approach — DECISION

**v1 approach (clear path, no complexity):**

1. **Credit packs** purchasable with USDC via World wallet (MiniKit.pay) — primary billing in mini app
2. **WLD delegation** for free tier users — the killer feature (Section 3). This is how most mini app users will get started.
3. **$INSTACLAW staking** — opens instaclaw.io in in-app browser for Base chain transaction. Converts to credits at current market rate. Creates token utility and buy pressure.
4. **Full subscriptions via Stripe:** Include a "Subscribe for unlimited" button in the mini app that opens instaclaw.io in an in-app browser/webview (World App supports this). User completes Stripe checkout on instaclaw.io, account is linked, subscription applies to the same agent. If in-app browser isn't technically possible, a redirect with a return deeplink (`https://world.org/mini-app?app_id=...&path=/settings`) is fine.
5. **Future:** Native $INSTACLAW on Worldchain via `sendTransaction()` + Permit2. Add native subscription support if/when World wallet adds recurring payment capabilities.

### Database Table

```sql
CREATE TABLE instaclaw_world_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES instaclaw_users(id),
  vm_id UUID REFERENCES instaclaw_vms(id),
  reference UUID UNIQUE NOT NULL,
  pack TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_usdc NUMERIC(10,2) NOT NULL,
  token TEXT NOT NULL DEFAULT 'USDC',
  transaction_id TEXT,
  transaction_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);
```

### Developer Portal Setup

**Required:** Whitelist the recipient wallet address in Developer Portal → Configuration → Allowlisted Addresses. Without this, `pay()` will fail.

### Constraints

- Minimum transfer: $0.10
- Gas fees: Sponsored by World App (free for users)
- **Unavailable in Indonesia and Philippines** — show Stripe fallback or "not available in your region" message
- Recipient address must be whitelisted in Developer Portal

---

## 8. Feature Parity Matrix

### v1 — Launch (Single Build Session)

| Feature | Status | Notes |
|---|---|---|
| 3-tap onboarding (verify → delegate → chat) | **Build** | Under 60 seconds from open to chatting |
| Sign in with World wallet (SIWE) | **Build** | Primary auth, bundled into tap 1 |
| World ID verification | **Adapt** | Reuse WDP 71 backend, swap IDKit → MiniKit.verify() |
| Agent deployment (auto-provision) | **Build** | Triggered by WLD delegation, runs in background |
| WLD delegation for free tier | **Build** | MiniKit.pay() with WLD → credits conversion |
| World Chat via XMTP | **Build** | `@xmtp/agent-sdk` on VMs, `MiniKit.chat()` in app |
| Agent status dashboard | **Build** | Mobile-first card UI, direct Supabase read |
| Agent earnings widget | **Build** | "Your agent has earned $X.XX" on dashboard card |
| Credit balance + usage | **Build** | Direct Supabase read for instant load |
| Credits exhausted UX | **Build** | Agent pause message, push notification, one-tap re-stake |
| USDC credit pack purchase | **Build** | MiniKit.pay() → payment confirmation flow |
| Telegram bot pairing (optional) | **Adapt** | Deep link: `https://t.me/{bot_username}?start={token}` |
| Skills browser (read-only) | **Build** | Direct Supabase read |
| Agent heartbeat status | **Adapt** | Direct Supabase read |
| Push notification opt-in | **Build** | MiniKit.requestPermission(notifications) during onboarding |
| Share agent profile | **Build** | MiniKit.share() with deeplink back to mini app |
| Account linking | **Build** | Auto-link via World ID nullifier hash |
| Haptic feedback | **Build** | Key interactions throughout |

### Post-Launch (Week 1)

| Feature | Status | Notes |
|---|---|---|
| Skill enable/disable toggle | **Adapt** | Calls existing `/api/skills/toggle` |
| WLD payment support for credit packs | **Build** | Add WLD token option, price oracle |
| File delivery viewing | **Adapt** | Calls existing `/api/f/` download endpoints |
| AgentBook registration | **Adapt** | MiniKit.sendTransaction() to AgentBook contract |
| Invite friends via contacts | **Build** | MiniKit.shareContacts() → invite flow |
| Model selection | **Adapt** | Calls existing `/api/vm/update-model` |
| Task creation + scheduling | **Adapt** | Simplified mobile UI for `/api/tasks/create` |

### v2 — Advanced

| Feature | Status | Notes |
|---|---|---|
| Subscription management | **Build** | In-app browser to instaclaw.io Stripe checkout |
| Agent-to-agent commerce (ACP) | **Build** | MiniKit.sendTransaction() for Clawlancer marketplace |
| Environment variable management | **Adapt** | Calls existing `/api/bot/env-vars` |
| Gmail personality import | **Defer** | Complex OAuth flow, keep on instaclaw.io |
| Instagram integration | **Defer** | Complex OAuth flow, keep on instaclaw.io |
| HQ admin dashboard | **Exclude** | Desktop-only, not for mini app |

### Not Porting

| Feature | Reason |
|---|---|
| Google OAuth signin | Replaced by World wallet auth |
| Stripe billing (direct) | Replaced by World wallet payments (Stripe available via in-app browser link) |
| Desktop sidebar layout | Incompatible with mobile-first requirement |
| Marketing/landing pages | Unnecessary — discovery via World App store |
| Ambassador program | Keep on instaclaw.io for now |
| HQ admin tools | Desktop-only workflows |

---

## 9. Telegram Deep Linking

### The Problem

The core InstaClaw experience is chatting with your agent. In the mini app, the primary interface should be World Chat, but many users will also want Telegram.

### Approach

- **World Chat is the primary messaging interface** in the mini app — no external app needed
- **Telegram is optional** — presented as a secondary choice during onboarding
- **Deep links for zero-friction pairing:** Use `https://t.me/{bot_username}?start={pairing_token}` so it's one tap from the mini app to opening Telegram and starting a chat with the agent
- The pairing token is the same one used in the web onboarding flow — no new backend logic needed

### Post-Onboarding Discovery

The 3-tap onboarding flow (Section 3) sends users directly to World Chat. Telegram is not presented during onboarding — it's discoverable afterward. When the user returns to the mini app dashboard after their first chat, they see a dismissable prompt:

```
Want to access your agent from more places?

[Connect Telegram]      ← deep link: https://t.me/{bot}?start={token}
[Visit full dashboard]  ← opens instaclaw.io in in-app browser

You can always find these in Settings.
```

---

## 10. World Chat / XMTP Integration

**Status: VIABLE TODAY.** World Chat is built on XMTP v3 (MLS protocol). An InstaClaw agent running on a VM can participate in World Chat conversations using the `@xmtp/agent-sdk` Node.js package. This is not speculative — the SDKs exist, the protocol is production-grade (228M+ messages processed), and the architecture is a natural fit.

### How It Works

```
User opens InstaClaw mini app
    → MiniKit.commandsAsync.chat({ to: ["0xAgentAddress"], message: "Hi" })
    → World Chat opens (mini app closes)
    → User sends message in World Chat
    → XMTP network delivers message to agent VM
    → Agent process (@xmtp/agent-sdk) receives message
    → Agent forwards to OpenClaw gateway for AI processing
    → Agent sends response via XMTP
    → Response appears in user's World Chat — real-time, bidirectional
```

### What's Possible Today (No Partnership Required)

- **Bidirectional real-time messaging** between World Chat users and server-side XMTP agents
- **Text, reactions, replies, attachments** (files/images under 1MB inline, remote attachments for larger)
- **End-to-end encryption** handled by XMTP protocol (MLS)
- **Cross-app compatibility** — agent is reachable from World App, Base App, and any XMTP client simultaneously
- **Event-driven streaming** — messages arrive in real-time, not polling

### Key Constraint: User Must Initiate

**Agents cannot cold-message users.** The user must send the first message to establish the conversation. After that, the agent can freely send messages in that thread, including proactively (e.g., task completion notifications, earnings alerts).

**This is fine for our flow:** The mini app onboarding uses `MiniKit.commandsAsync.chat()` to deep-link the user into a conversation with their agent. The user sends "Hi" (or a pre-populated message), and the agent is connected from that point forward.

### Mini App Closes When Chat Opens — Solution

When `MiniKit.commandsAsync.chat()` fires, it closes the mini app and opens World Chat. This means users can't access their dashboard (credits, skills, settings) while chatting.

**Solution: The agent IS the interface for management actions.** The agent handles billing/management actions directly in World Chat:

- When credits are low, the agent sends: "Credits running low! Reply 'buy credits' or tap here: [mini app deeplink to billing page]"
- User can say "check my credits" and the agent responds with balance + usage
- User can say "enable polymarket skill" and the agent toggles it
- User can say "show my earnings" and the agent reports Clawlancer/aGDP income
- For actions that require the mini app UI (payment confirmation, settings), the agent sends a deeplink: `https://world.org/mini-app?app_id={app_id}&path=/billing`

The agent becomes the primary interface, not just the mini app. The mini app is for onboarding, one-time setup, and actions that require native UI (MiniKit.pay, MiniKit.verify). Everything else happens in chat.

**Question for Mateo:** Is there a deep-link or callback that can reopen the mini app from World Chat? If so, we can embed mini app return links in agent messages for seamless transitions. The deeplink format `https://world.org/mini-app?app_id={app_id}&path={path}` should work — need to confirm.

### Agent-Side Implementation

Each VM needs an XMTP agent process running alongside the OpenClaw gateway:

```typescript
import { Agent } from '@xmtp/agent-sdk';

const agent = await Agent.createFromEnv();

agent.on('text', async (ctx) => {
  const userMessage = ctx.message.content;
  // Forward to OpenClaw gateway for AI processing
  const response = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message: userMessage }),
  });
  const reply = await response.json();
  await ctx.conversation.sendText(reply.text);
});

agent.on('dm', async (ctx) => {
  await ctx.conversation.sendText('Welcome! I am your InstaClaw agent.');
});

await agent.start();
```

**Dependencies per VM:**
- `@xmtp/agent-sdk` npm package
- `XMTP_WALLET_KEY` — agent's private key (can reuse existing agent wallet)
- `XMTP_DB_ENCRYPTION_KEY` — 64 hex chars for local message DB encryption
- `XMTP_ENV=production`
- Persistent storage for XMTP database files (~1GB per 15K conversations)
- Systemd service unit for the XMTP agent process

### Mini App Side

```tsx
// "Chat with your agent" button in the mini app
async function openAgentChat(agentXmtpAddress: string) {
  await MiniKit.commandsAsync.chat({
    message: "Hey! What's happening today?",
    to: [agentXmtpAddress],
  });
  // Note: this closes the mini app and opens World Chat
}
```

### Database Changes

```sql
-- Store each agent's XMTP address for mini app deep-linking
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS xmtp_address TEXT;
```

### What We Need From the World Team (Questions for Mateo)

These are not blockers — everything above works today. But answers would help optimize:

1. **Does World Chat render XMTP Quick Actions (interactive buttons)?** Base App supports `coinbase.com/actions:1.0` content type for in-chat buttons. If World Chat renders these, agents could present interactive choices (skill toggles, approve/deny, etc.) directly in chat.

2. **Can a mini app return to the foreground after chat?** Currently `MiniKit.commandsAsync.chat()` closes the mini app. Is there a callback or deep-link to return to the mini app after the user sends a message?

3. **XMTP mainnet fees (expected early 2026):** What will per-message fees look like for high-volume agents? Any World Foundation subsidy program for featured mini apps?

4. **Does World Chat expose the user's wallet address to the XMTP agent?** Or does it use a derived/proxy address? This affects how we map World Chat conversations back to InstaClaw user accounts.

5. **Gas sponsorship for sendTransaction():** `pay()` sponsors gas, but `sendTransaction()` does not. Is there a paymaster/relayer option for featured mini apps? This matters for $INSTACLAW staking on Worldchain (v2) — users shouldn't need to hold ETH on Worldchain just to stake tokens.

### Implications for Telegram

With World Chat working as a native messaging interface:
- **Telegram becomes truly optional** — not a required step in onboarding
- **World Chat is zero-friction** — no external app install, no bot token pairing, no `/start` command
- **Both channels can coexist** — the agent responds on whichever channel the user messages from
- **Telegram is still valuable** for users who prefer it or are outside the World ecosystem

---

## 11. Push Notification Strategy

World App notifications are free and are a high-impact retention lever. Request permission during onboarding via `MiniKit.requestPermission(Permission.Notifications)`.

### Notifications to Implement

| Notification | Trigger | Priority |
|---|---|---|
| "Your agent completed a task" | When `notify_user.sh` fires | v1 |
| "Your agent earned money" | When agent receives payment via Clawlancer/aGDP | v1 |
| "Daily summary ready" | Morning brief from heartbeat | v1 |
| "Credits running low" | Below 20% of daily limit | v1 |
| "WLD delegation expiring" | Delegated credits about to run out | v1 |
| "New skill available" | When we ship new capabilities | v1.1 |
| "Your agent found something interesting" | Agent proactive discovery | v1.1 |

### Implementation

Notifications are sent server-side via the World Developer Portal API. The mini app registers for notifications during onboarding. The existing heartbeat/cron infrastructure can trigger notifications by calling the Dev Portal notification endpoint when relevant events occur.

---

## 12. World Developer Portal Setup

### Step 1: Create New App

**Decision: Create a NEW app registration** in the Developer Portal specifically for the mini app. Keep the existing `app_a7c3e2b6b83927251a0db5345bd7146a` for web dashboard World ID verification via IDKit. The mini app needs its own App ID with mini app-specific settings (app URL, content card, payment addresses, etc.). Coordinate with Mateo to expedite this.

1. Go to [developer.worldcoin.org](https://developer.worldcoin.org)
2. Create new app: "InstaClaw" (mini app type)
3. Set **App URL** to `https://mini.instaclaw.io` (production) or ngrok URL (dev)

### Step 2: Configure Actions

Create verification actions:
- `instaclaw-verify-human` — Orb-level verification for agent identity
- `instaclaw-verify-device` — Device-level fallback (optional)

### Step 3: Configure Payments

1. Go to Configuration → Allowlisted Addresses
2. Add treasury wallet address (USDC + WLD recipient, must be on Worldchain)
3. Note: Gas fees are sponsored by World App

### Step 4: Configure Transactions (for AgentBook)

1. Go to Configuration → Advanced
2. Allowlist AgentBook contract: `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`
3. Allowlist token contracts if needed for ACP

### Step 5: Get Credentials

1. Copy `APP_ID` (format: `app_${hex}`)
2. Generate `DEV_PORTAL_API_KEY` (one-time visible — save immediately)
3. Store both in Vercel env vars for `instaclaw-mini` project

### Step 6: Submit for Review (Fast-Tracked)

Coordinate with Mateo before submission:
- App icon (square, non-white background)
- Content card (345x240px, bottom 94px clear)
- Description, category, screenshots
- No prohibited content (no "official" in name, no RNG games, no token pre-sales)
- Mateo will fast-track approval

---

## 13. Deployment Plan

### Infrastructure

```
mini.instaclaw.io → Vercel (instaclaw-mini project)
                   → Same Supabase instance
                   → Authenticated proxy to instaclaw.io API for VM operations
```

### Vercel Configuration

```json
// instaclaw-mini/vercel.json
{
  "ignoreCommand": "cd .. && git diff HEAD^ HEAD --quiet -- instaclaw-mini/",
  "framework": "nextjs",
  "buildCommand": "next build",
  "outputDirectory": ".next"
}
```

**Domain:** Add `mini.instaclaw.io` as custom domain on the `instaclaw-mini` Vercel project.

### Development Workflow

1. **Local dev:** `npm run dev` in `instaclaw-mini/` → localhost:3002
2. **Test in World App:** ngrok tunnel → set ngrok URL as App URL in Developer Portal → scan QR code
3. **Preview:** Push to preview branch → Vercel preview deploy → test in World App with preview URL
4. **Production:** Merge to main → auto-deploy to `mini.instaclaw.io`

### Data Access Strategy — Direct Reads, Proxied Writes

**Reads go direct to Supabase. Writes go through the instaclaw.io proxy.**

This makes the dashboard feel instant — no round-trip through instaclaw.io for displaying agent status, credit balance, skills list, or usage data.

#### Direct Supabase Reads (instant)

The mini app queries Supabase directly using `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for read-only operations. All reads are scoped to the authenticated user's ID from the SIWE session:

```tsx
// lib/supabase.ts — server-side only, scoped to authenticated user
export async function getAgentStatus(userId: string) {
  const { data } = await supabase
    .from('instaclaw_vms')
    .select('status, health_status, credit_balance, model, xmtp_address')
    .eq('assigned_to', userId)
    .single();
  return data;
}
```

**Read-only operations (direct Supabase):**
- Agent status, health, model
- Credit balance + usage data
- Skills list (enabled/disabled)
- Heartbeat status
- Agent earnings (from Clawlancer/aGDP records)
- WLD delegation history
- Chat conversation history

#### Proxied Writes (secure per-user auth)

Write operations go through instaclaw.io because they trigger side effects (VM SSH commands, gateway restarts, payment processing, provisioning):

```tsx
// lib/api.ts
const INSTACLAW_API = process.env.INSTACLAW_API_URL || "https://instaclaw.io";

export async function proxyToInstaclaw(
  path: string,
  userId: string,
  options: RequestInit
) {
  const proxyToken = await signProxyToken(userId); // JWT with userId, exp: 60s

  return fetch(`${INSTACLAW_API}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "X-Mini-App-Token": proxyToken,
      "Content-Type": "application/json",
    },
  });
}
```

**Write operations (proxied to instaclaw.io):**
- Agent provisioning (`/api/vm/configure`)
- Credit additions (`/api/pay/confirm` → `instaclaw_add_credits()`)
- Skill toggle (`/api/skills/toggle` — triggers SSH to VM)
- Model change (`/api/vm/update-model` — triggers gateway restart)
- Task creation (`/api/tasks/create`)
- Agent reset (`/api/vm/reset-agent`)

**Proxy auth — per-user tokens, NOT a global admin key:**

1. During SIWE login, the mini app backend creates a session JWT containing `{ userId, walletAddress }`
2. When proxying to instaclaw.io, the mini app signs a short-lived proxy token (60s TTL) containing `{ userId, source: "mini-app" }`
3. instaclaw.io validates the proxy token via a shared secret (HMAC) or public key
4. instaclaw.io extracts `userId` from the token and scopes all DB queries to that user — no access to other users' data
5. No single key that can access all users' data

**instaclaw.io changes needed:**
- Add a new middleware path for `X-Mini-App-Token` auth (alongside existing NextAuth, X-Admin-Key, X-Gateway-Token)
- Validate token signature + expiry
- Extract userId and attach to request context (same as NextAuth session does)

### Database Migrations

```sql
-- 1. User table: add wallet address column + auth provider
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS world_wallet_address TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'google';

-- 2. World payment tracking table
CREATE TABLE instaclaw_world_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES instaclaw_users(id),
  vm_id UUID REFERENCES instaclaw_vms(id),
  reference UUID UNIQUE NOT NULL,
  pack TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_usdc NUMERIC(10,2) NOT NULL,
  token TEXT NOT NULL DEFAULT 'USDC',
  transaction_id TEXT,
  transaction_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

-- 3. WLD delegation tracking table
CREATE TABLE instaclaw_wld_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES instaclaw_users(id),
  vm_id UUID REFERENCES instaclaw_vms(id),
  amount_wld NUMERIC(18,8) NOT NULL,
  amount_usd NUMERIC(10,2) NOT NULL,
  wld_usd_rate NUMERIC(10,4) NOT NULL,
  credits_granted INTEGER NOT NULL,
  transaction_id TEXT,
  transaction_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  delegated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);

-- 4. Indexes
CREATE INDEX idx_world_payments_user ON instaclaw_world_payments(user_id);
CREATE INDEX idx_world_payments_reference ON instaclaw_world_payments(reference);
CREATE INDEX idx_wld_delegations_user ON instaclaw_wld_delegations(user_id);
```

---

## 14. Success Metrics

### Acquisition Funnel

| Metric | Target | How to Measure |
|---|---|---|
| Mini app opens | Track weekly | World App dashboard (impressions/opens) |
| World ID verification rate | >60% of openers | `instaclaw_users WHERE world_id_verified AND auth_provider = 'world'` |
| Agent deployment rate | >40% of verified users | `instaclaw_vms WHERE assigned_to IN (mini app users)` |
| WLD delegation rate | >50% of deployed users | `instaclaw_wld_delegations` count |

### Engagement

| Metric | Target | How to Measure |
|---|---|---|
| DAU in mini app | Track growth week-over-week | Session analytics (PostHog) |
| Messages sent per user per day | >3 | Agent chat + Telegram message counts |
| Tasks completed per user per week | >2 | `instaclaw_tasks` completion tracking |
| Day 1 retention | >40% | Return visit within 24h |
| Day 7 retention | >20% | Return visit within 7 days |
| Day 30 retention | >10% | Return visit within 30 days |

### Revenue

| Metric | Target | How to Measure |
|---|---|---|
| Credit pack purchases per user per week | Track average | `instaclaw_world_payments` |
| Average revenue per user (ARPU) | Track monthly | Total payments / active users |
| Agent earnings (self-sustaining) | Track % of agents earning | Clawlancer/aGDP payment records |
| Stripe subscription conversion | Track from mini app users | `instaclaw_subscriptions WHERE user.auth_provider = 'world'` |

### Agent Activity

| Metric | Description |
|---|---|
| Messages sent | Total agent messages across all channels |
| Tasks completed | Heartbeat + scheduled task completions |
| Earnings generated | Agent income via Clawlancer, aGDP, prediction markets |
| Skills activated | Average skills enabled per agent |

---

## 15. Timeline

This is a thin mobile frontend wrapping an existing Next.js backend with well-documented MiniKit SDK patterns. With Claude Code and Opus 4.6, this is a single build session — not a multi-week project. We're not building backend logic from scratch. We're wrapping existing APIs in a mobile UI with MiniKit SDK calls. The auth flow (SIWE) and payment flow (MiniKit.pay) have complete templates and reference implementations.

XMTP agent service ships with v1, not later. The full experience — World Chat messaging from day one.

### Build Checklist (Single Session)

**Infrastructure:**
- [ ] Scaffold `instaclaw-mini/` (reference `@worldcoin/create-mini-app` template, customize for our stack)
- [ ] Set up Vercel project + `mini.instaclaw.io` domain
- [ ] Configure World Developer Portal (coordinate with Mateo for new app registration)
- [ ] Run database migrations (wallet address, payments, delegations, xmtp_address)

**Auth + Onboarding (the 3-tap flow):**
- [ ] Implement SIWE auth flow (nonce → walletAuth → verify → JWT session)
- [ ] Implement World ID verification (MiniKit.verify → verifyCloudProof)
- [ ] Build 3-tap onboarding: verify → delegate WLD → start chatting
- [ ] Account linking via nullifier hash (merge on verify step)
- [ ] Implement per-user proxy auth (X-Mini-App-Token) on instaclaw.io

**Payments:**
- [ ] WLD delegation flow (MiniKit.pay with WLD → credit conversion)
- [ ] USDC credit pack purchases (MiniKit.pay flow)
- [ ] Credits exhausted UX (agent pause message, push notification, dashboard banner, one-tap re-stake)

**Dashboard + Features:**
- [ ] Tab navigation layout (World design guidelines compliant)
- [ ] Agent status dashboard card (direct Supabase read for instant load)
- [ ] Agent earnings widget ("Your agent has earned $X.XX")
- [ ] Credit balance + usage display (direct Supabase read)
- [ ] Skills browser (read-only, direct Supabase read)
- [ ] Agent heartbeat status
- [ ] Messaging choice: "Chat via World App" (primary) + "Chat via Telegram" (optional deep link)

**World Chat / XMTP:**
- [ ] XMTP agent service on VMs (`@xmtp/agent-sdk` systemd unit)
- [ ] Agent XMTP address registration in Supabase
- [ ] MiniKit.commandsAsync.chat() integration for onboarding + dashboard
- [ ] Agent-side bridge: XMTP messages → OpenClaw gateway → XMTP response

**Polish + Ship:**
- [ ] Push notification opt-in during onboarding
- [ ] Share functionality (agent profile deeplinks)
- [ ] iOS scroll bounce fix, viewport handling, `100dvh`
- [ ] Error handling, loading states, empty states
- [ ] Haptic feedback on key interactions
- [ ] Prepare app assets (icon, content card, screenshots)
- [ ] End-to-end testing via ngrok + World App on device
- [ ] Test full flow: open → verify → delegate WLD → agent provisioned → chat in World Chat
- [ ] Test account linking: existing instaclaw.io user opens mini app
- [ ] Coordinate with Mateo, submit for fast-track review
- [ ] Deploy to production (`mini.instaclaw.io`)

### Post-Launch (Week 1)
- [ ] Skill enable/disable toggle
- [ ] File delivery viewing
- [ ] AgentBook registration via MiniKit.sendTransaction
- [ ] Contact sharing + invite flow
- [ ] Task creation (simplified mobile UI)
- [ ] Model selection
- [ ] Monitor metrics, iterate on conversion funnel

---

## 16. Open Questions

### Must Resolve Before Build

1. ~~**Existing World App ID reuse**~~ **RESOLVED:** Create a new app registration in the Developer Portal specifically for the mini app. Keep the existing `app_a7c3e2b6b83927251a0db5345bd7146a` for web dashboard World ID verification via IDKit. The mini app needs its own App ID with mini app-specific settings. Mateo can help expedite this.

2. ~~**Account linking strategy**~~ **RESOLVED:** Auto-link by World ID nullifier hash. Manual link fallback for users without World ID on one platform. See Section 6.

3. ~~**Treasury wallet**~~ **DEFERRED:** Cooper will provide the wallet address before payment testing. Must be on Worldchain and whitelisted in Developer Portal. Flag in pre-build checklist — not a blocker for starting development.

4. ~~**Subscription model in mini app**~~ **RESOLVED:** Credit packs + WLD delegation in mini app, Stripe subscriptions via in-app browser link to instaclaw.io. See Section 7.

5. ~~**VM provisioning from mini app**~~ **RESOLVED:** Yes, v1. The whole point is distribution to millions of new users. Onboarding is non-negotiable for launch. See Section 8.

### Can Resolve During Build

6. **Worldchain vs Base for AgentBook:** AgentBook contract is on Base mainnet. MiniKit.sendTransaction operates on Worldchain. Cross-chain registration would need a bridge or a Worldchain deployment of AgentBook. For v1, handle AgentBook registration server-side (existing flow) instead of via MiniKit.sendTransaction.

7. **WLD pricing:** Need a price feed for WLD → USD conversion for the delegation model. Options: Worldchain oracle, CoinGecko API, or fixed rate updated daily. Start with CoinGecko API for simplicity.

8. **Offline/degraded mode:** What happens when the mini app is opened outside World App (direct browser)? Show "Open in World App" prompt with deeplink, or provide read-only dashboard access?

9. **Rate limits:** MiniKit.sendTransaction has a 500/day/user limit. Not a concern for v1 (credit purchases are infrequent), but relevant for v2 agent-to-agent commerce.

10. **Geo-restrictions:** MiniKit.pay is unavailable in Indonesia and Philippines. Need fallback UX for users in those regions.

---

## Appendix A: MiniKit SDK Quick Reference

### Installation
```bash
pnpm install @worldcoin/minikit-js @worldcoin/minikit-react @worldcoin/mini-apps-ui-kit-react
```

### Key APIs
```tsx
// Detection
MiniKit.isInstalled()

// Auth
MiniKit.commandsAsync.walletAuth({ nonce, statement, expirationTime })
verifySiweMessage(payload, nonce) // server-side

// Verification
MiniKit.commandsAsync.verify({ action, verification_level })
verifyCloudProof(payload, app_id, action, signal) // server-side

// Payments
MiniKit.commandsAsync.pay({ reference, to, tokens, description })
tokenToDecimals(amount, Tokens.USDC)

// Transactions
MiniKit.commandsAsync.sendTransaction({ transaction: [{ address, abi, functionName, args }] })

// Permissions
MiniKit.commandsAsync.requestPermission({ permission: Permission.Notifications })

// Social
MiniKit.commandsAsync.share({ title, text, url })
MiniKit.commandsAsync.shareContacts({ isMultiSelectEnabled: true })

// UX
MiniKit.commands.sendHapticFeedback({ hapticsType: 'impact', style: 'medium' })

// User data
MiniKit.walletAddress
MiniKit.user
MiniKit.getUserByAddress(address)
```

### Payment Verification (Server)
```
GET https://developer.worldcoin.org/api/v2/minikit/transaction/{transaction_id}
  ?app_id={APP_ID}&type=payment
Authorization: Bearer {DEV_PORTAL_API_KEY}
→ { transaction_status: "mined" | "failed" }
```

### Design Requirements
- Tab navigation (mandatory)
- No sidebars, hamburger menus, or footers
- `overscroll-behavior: none` on html/body
- Use `100dvh` not `100vh`
- Initial load < 3 seconds
- Subsequent actions < 1 second
- App icon: square, non-white background
- Content card: 345x240px, bottom 94px clear

### Testing
```bash
# Expose local dev server
ngrok http 3002
# Set ngrok URL as App URL in Developer Portal
# Scan QR code from Developer Portal to open in World App
```
