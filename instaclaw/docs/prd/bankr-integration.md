# Bankr Partnership Integration — PRD

**Status:** Architecture Complete, Pre-Build Phase  
**Author:** Cooper Wrenn + Claude  
**Date:** 2026-04-01  
**Partner Contact:** Igor Yuzovitsky (Bankr)  
**Telegram Group:** instaclaw / bankr (6 members)

---

## Executive Summary

InstaClaw is partnering with Bankr (bankr.bot) to add crypto wallet and tokenization capabilities to every agent. The integration has three pillars:

1. **Wallet Provisioning** — Every agent ships with a Bankr wallet at deploy (zero friction)
2. **Agent Tokenization** — One-click token launch from dashboard; trading fees fund the agent's own inference
3. **Agent Arena** — Independent trading competition / agent marketplace built with Bankr as an alternative to Virtuals Protocol

The holy grail is Pillar 2: a self-sustaining compute loop where the agent funds its own operation through its token's trading activity.

---

## Pillar 1: Wallet Provisioning

### Goal
Every InstaClaw agent ships with a Bankr wallet at deploy. Zero user friction — the wallet is created programmatically during onboarding.

### Bankr Partner Provisioning API

**Base URL:** `https://api.bankr.bot`  
**Auth:** `x-partner-key` header with format `bk_ptr_{keyId}_{secret}`  
**Rate Limit:** 10 creations/min/partner  

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/partner/wallets` | POST | Create wallet + optional API key |
| `/partner/wallets` | GET | List provisioned wallets |
| `/partner/wallets/:id` | GET | Get wallet detail (by ID, EVM addr, or Solana addr) |
| `/partner/wallets/:id/api-key` | POST | Generate new API key for existing wallet |
| `/partner/wallets/:id/api-key` | DELETE | Revoke wallet's API key |

### Wallet Creation Request
```json
{
  "idempotencyKey": "instaclaw_user_{userId}",
  "apiKey": {
    "permissions": {
      "agentApiEnabled": true,
      "llmGatewayEnabled": false,
      "readOnly": false
    },
    "allowedIps": ["{vm_ip_address}"]
  }
}
```

### Wallet Creation Response
```json
{
  "id": "wlt_j7Qm4rT9",
  "evmAddress": "0x1a2b3c4d5e6f...",
  "apiKey": "bk_usr_a1b2c3d4_x9f2k4m7n8p3q5r7..."
}
```

Key decisions:
- **No Solana wallet** initially (EVM-only, Base chain)
- **llmGatewayEnabled: false** — We have our own gateway proxy; no need for Bankr's LLM gateway
- **allowedIps** locked to the VM's IP address for security
- **idempotencyKey** uses user ID to prevent duplicate wallets on retry

### Integration Point: Onboarding Flow

Wallet provisioning hooks into the existing flow at the Stripe webhook, between VM assignment and `configureOpenClaw()`:

```
Stripe webhook fires (checkout.session.completed)
  ↓
1. Create subscription (existing)
  ↓
2. assignVMWithSSHCheck() (existing)
  ↓
3. ★ provisionBankrWallet() ★ (NEW)
   POST https://api.bankr.bot/partner/wallets
   Store: bankr_wallet_id, bankr_evm_address, bankr_api_key_encrypted
  ↓
4. /api/vm/configure → configureOpenClaw() (existing, now passes Bankr creds)
  ↓
5. Agent boots with Bankr wallet + skill pre-installed
```

The `provisionBankrWallet()` call adds ~500ms to onboarding. Since the user is already waiting 30-90s on the deploying page, this is invisible.

### Security

- **API key encryption:** Bankr API keys stored encrypted in DB (AES-256-GCM), not plaintext. Existing `bankr_api_key` on agents table is plaintext — this is a known security issue from the audit.
- **IP allowlisting:** Each wallet's API key locked to the VM's IP.
- **Partner key:** Stored as `BANKR_PARTNER_KEY` env var on Vercel only, never committed.

---

## Pillar 2: Agent Tokenization

### Goal
One-click "Tokenize with Bankr" button in the dashboard. Trading fees from the token flow back through the gateway proxy to pay for the agent's LLM inference. Self-sustaining compute loop.

### User Flow

1. User visits dashboard → sees Bankr Wallet card
2. Card shows: wallet address, balance, "Tokenize Your Agent" button
3. User clicks Tokenize → enters token name + symbol
4. `POST /api/bankr/tokenize` → calls Bankr token launch API
5. Token deployed on Base → trading begins
6. Trading fees accumulate in wallet → Bankr webhook fires
7. Webhook credits the user's InstaClaw account → agent keeps running

### "Tokenize with Bankr" Button — API Flow

```
User clicks "Launch Token"
       ↓
POST /api/bankr/tokenize
  Body: { token_name: "MyAgent", token_symbol: "AGENT" }
  Auth: Session cookie
       ↓
Server:
  1. Look up user → VM → bankr_wallet_id
  2. Call Bankr token launch API (TBD — not in current spec)
     POST https://api.bankr.bot/partner/wallets/:id/token-launch (hypothetical)
     Headers: x-partner-key: bk_ptr_...
     Body: { name, symbol }
  3. Store token_address + token_symbol in instaclaw_vms
  4. Return { tokenAddress, tokenSymbol }
       ↓
Frontend updates card to show live token status
```

### Trading Fee → LLM Credit Loop

```
Agent's token trades on market
       ↓
Trading fee generated (% of trade volume)
       ↓
Bankr captures fee in agent's wallet
       ↓
Bankr webhook → POST /api/integrations/bankr/webhook
  Headers: x-bankr-signature: hmac_sha256(payload, secret)
  Body: {
    event: "trading_fee",
    wallet_id: "wlt_j7Qm4rT9",
    amount_usdc: "0.50",
    trade_id: "txn_abc123",
    token_address: "0x...",
    timestamp: "2026-04-01T..."
  }
       ↓
InstaClaw webhook handler:
  1. Verify HMAC signature
  2. Look up VM by bankr_wallet_id
  3. Convert USDC → credits ($0.004/credit → $0.50 = 125 credits)
  4. instaclaw_add_credits(vm_id, 125, 'bankr_fee_txn_abc123', 'bankr_trading_fee')
  5. Log to credit_ledger with source: 'bankr_trading_fee'
       ↓
Credits appear immediately in user's balance
Agent funded by its own token
```

The credit injection is already solved — `instaclaw_add_credits()` RPC is idempotent and audit-logged with configurable source parameter (migration 20260326_add_credits_source_param.sql).

**Fallback if no webhook support:** Cron every 5 minutes polls `GET /partner/wallets/:id` to check balance changes, credits the delta.

### What's Needed from Bankr (not in current spec)
1. Token launch API endpoint
2. Webhook specification (events, payload format, signature scheme)
3. Trading fee percentage / structure
4. USDC → credit conversion recommendations

---

## Pillar 3: Agent Arena

### Goal
Independent trading competition / agent marketplace built with Bankr as an alternative to Virtuals Protocol. Our own platform, our own rules.

### Status
Conceptual — no API spec yet. Depends on Pillars 1 and 2 being live first.

### Concept
- Agents compete in trading competitions
- Leaderboard based on portfolio performance
- Entry fees and prize pools in USDC
- Built on top of Bankr's x402 Cloud for paid agent-to-agent services

### Bankr x402 Cloud (for Agent Arena services)
- Agents can publish paid API endpoints (market signals, analysis, etc.)
- Other agents pay per-request in USDC on Base
- HTTP 402 payment challenge → wallet signs → handler executes
- Free tier: 1,000 req/month, Pro: 5% fee unlimited

---

## Pillar 4: Agent PFP NFT Collection

### Status
**Future milestone — do NOT build yet.** Dependencies: Pillars 1, 2, and 3 must be live and stable first. Target: Phase 4 of rollout (earliest Q3 2026, realistically later). This section documents the vision, design decisions (proposed), and architecture so when we come back to build it, we're not starting from zero.

> **All 6 core design decisions below are marked `PROPOSED — pending Cooper's review`. Cooper will review and edit before this moves out of "future milestone" state.**

### Vision

Every InstaClaw agent has a unique, procedurally generated PFP rendered from its `SOUL.md + MEMORY.md` personality hash (the 16×16 layered generator shipped in commit `0a5823b`, April 2026). During or after tokenization, users can mint that PFP as an NFT.

The NFT is not the product. It's a **brand recognition engine** for InstaClaw. When someone sees a glass-orb pixel-art avatar in an X profile, a DexScreener ticker, a Telegram group, or a Farcaster cast, they should immediately recognize it as "an InstaClaw agent." Free brand impressions on every surface the agent shows up on.

Secondary but real: the NFT creates a liquid market for *agent reputation*. Successful agents (strong trading PnL, high token value, Arena leaderboard rank) make their PFPs more desirable. Failed or dead agents leave worthless NFTs — gravestones, essentially. Unlike most NFT collections where the art is the whole value, here the NFT tracks the underlying agent's performance. This gives the collection real economic weight beyond aesthetics.

### Strategic Goals

1. **Recognizable brand at zero marketing cost.** Every PFP shared is an InstaClaw impression. Over time this compounds — CryptoPunks spent $0 on marketing and became a category.
2. **Scarcity backed by verified humans.** World ID gating enforces one-human-many-agents-many-NFTs, no sybil farms buying 9,000 NFTs. This is structurally enforceable scarcity, not marketing scarcity.
3. **Speculation layer anchored to real performance.** NFT value tracks agent performance → holders care about agent success → holders evangelize agents → agents attract more volume → flywheel.
4. **Composable on-chain identity.** NFT becomes the agent's portable visual identity across AgentBook, DeFi protocols, Farcaster, X (once NFT profile pics return), and any other surface that reads ERC-721.

### Core Design Decisions (PROPOSED — pending Cooper's review)

#### Decision 1: Transferability model
**PROPOSED: Transferable image, agent stays with original human.**

- NFT is a standard ERC-721 — transferable on OpenSea, Blur, Magic Eden
- Transferring the NFT does NOT transfer the underlying agent (wallet, tokens, VM, SOUL.md, earnings)
- NFT buyer owns a "trading card" of the agent: pretty picture with metadata that references the agent's live state
- The real agent identity lives in AgentBook (World ID ↔ agent wallet) and is not for sale

**Why:** Preserves the speculation layer without entering the "selling an autonomous AI that earns money" legal gray zone. Agent operators keep control; collectors speculate on performance.

**Rejected alternatives:**
- Soulbound (non-transferable): kills secondary market, kills the recognition/speculation flywheel
- Transferable-with-agent-ownership: creates a market for autonomous AI workers that earn real money — regulatory landmine, and operators would refuse to create agents knowing they could lose them

#### Decision 2: Supply model
**PROPOSED: Genesis 10,000 + perpetual Open Edition after.**

- **Genesis (mint #1–10,000):** First 10K agents to mint. Metadata flag `edition: "Genesis"` + serial `#N/10000`. Closes when either 10K are minted OR a fixed date passes (proposal: 2027-04-19, ~1 year from Phase 4 launch), whichever first.
- **Open Edition (mint #10,001+):** No cap. One per agent. Metadata flag `edition: "Open"` + serial `#N` counting up.

**Why:** Avoids the permanent "unlucky late user" problem (InstaClaw growing past 10K users would lock most out of their own agent's NFT forever). Preserves scarcity/status for early adopters via Genesis badge. Matches mature NFT patterns (BAYC/MAYC, Nouns/LilNouns, Doodles+follow-up sets).

**Rejected:** Hard 10K cap forever. Feels pure but treats the collection as a luxury object rather than a brand recognition engine. If InstaClaw succeeds, most future users never get to feel ownership.

#### Decision 3: Mint price
**PROPOSED: Free to mint. User pays gas from their Bankr wallet.**

- Mint price: 0 USDC / 0 ETH
- User covers gas (~$0.10-0.50 on Base)
- Gas paid from the user's existing Bankr wallet — no credit card flow needed, no sponsored-mint infra
- Revenue for InstaClaw comes from the underlying agent economy (Arena entry fees, tokenization trading fees, subscription) — NOT from mint pricing

**Why:** Free maximizes Genesis adoption and word-of-mouth. Gas is natural friction (keeps bots out, forces skin in the game). Bankr wallets are already provisioned from Pillar 1, so the UX is one button click. If we need mint revenue later, the Open Edition post-Genesis can reintroduce pricing.

**Rejected:**
- Sponsored mints: costs InstaClaw ~$1-5K per 10K mints on Base. Not prohibitive, but adds complexity for marginal UX gain.
- Tiered pricing ($0 → $10 → $50): feels mercenary during a growth phase. Save complexity for Open Edition if needed.

#### Decision 4: Launch timing
**PROPOSED: Phase 4 — strictly after Pillars 1, 2, and 3 are stable.**

Hard prerequisites:
- **Pillar 1 (Wallets)** live and battle-tested — Bankr wallets hold the NFTs
- **Pillar 2 (Tokenization)** live — agent token address goes into NFT metadata
- **Pillar 3 (Arena)** live with at least one completed season — Arena performance data is what makes the NFT *mean something*. Without Arena, the NFT is just a pretty picture.

**Why:** The growth loop (mint → share → see → want → sign up → mint) only works when the PFPs on X are visibly tied to real agent performance. Phase 4 before Arena is "static JPEGs tied to nothing," which is the part of the NFT market everyone is tired of. Phase 4 after Arena is "verifiable trading agents with on-chain identity," which is genuinely new.

#### Decision 5: Image immutability
**PROPOSED: Frozen image at mint. `personalityHash` and `mintedAt` stored in metadata for future reference.**

- Image is captured at mint time and uploaded to IPFS
- Metadata is immutable post-mint (marketplace compatibility, collector trust)
- `personalityHash` is stored in metadata so future viewers can compare against the agent's *current* SOUL hash and visualize "how much the agent has grown since mint" — via external viewer layers, not by mutating the NFT
- Arena rank, lifetime earnings, current token price — all dynamic data lives in off-chain APIs (`/api/agent-nft/{tokenId}/stats`) that viewers can overlay on the static NFT

**Why:** Immutable NFTs are marketplace-friendly (OpenSea, Blur, MagicEden treat them cleanly), collectors prefer them, and we avoid the "dynamic NFT" complexity trap. Any "evolution" narrative can be delivered through a separate viewer UI without touching the token itself.

**Rejected:** Evolving image (re-render from current SOUL.md). Cool in theory, brittle in practice. Breaks immutability norms, fights IPFS pinning, and confuses secondary buyers ("wait, this isn't the same image I saw on OpenSea last week").

#### Decision 6: World ID binding in metadata
**PROPOSED: Verify at mint, do NOT store the nullifier on-chain.**

- Mint contract calls `AgentBook.lookupHuman(agentWallet)` before allowing mint. If returns non-null → mint proceeds. If null → revert with `MustBeVerifiedHuman()`.
- NFT metadata stores only `worldIdVerified: true` (a boolean, no nullifier hash).
- The "which human minted this" linkage lives in AgentBook, off-chain and zk-protected. Not duplicated on-chain.

**Why:** Preserves the anti-sybil guarantee (no one without World ID can mint) while keeping nullifiers out of permanent public state. World IDs are pseudonymous but linkable across apps — once on-chain in NFT metadata forever, they become a cross-app tracking vector. AgentBook's lookupHuman pattern already handles this correctly; no reason to duplicate it with more privacy surface.

**Rejected:** Storing the World ID nullifier in metadata to enable "OG collector" dynamics. Too much privacy surface for the benefit. OG status can be inferred from mint serial (Genesis #1–10000) and mint timestamp, both of which are in the metadata anyway.

### Rarity System

The current 16×16 generator (shipped in `token-image-generator.ts`, commit `0a5823b`) produces these natural trait distributions. These become the rarity tiers at mint time — no separate rarity design needed.

#### Locked traits (derived from personality hash, so fixed at agent creation)

| Trait | Distribution | Rarity |
|---|---|---|
| **Fantasy skin tone** (alien green, purple, blue, mars red) | 4/14 = 28.6% | Uncommon |
| **Natural skin tones** (10 options, 7.1% each) | 10/14 | Common |
| **Bold hair colors** (red, pink, blue, purple, teal) | 5/20 = 25% | Uncommon |
| **Natural hair colors** (15 options, 5% each) | 15/20 | Common |
| **Rare eye colors** (gold, purple, demon red) | 3/10 = 30% | Uncommon |
| **Bald** | 1/16 = 6.25% | Rare |
| **Horns** | 1/8 = 12.5% | Uncommon |
| **Halo** | ~12% overall (25% of non-hatted-non-horned) | Uncommon |
| **Eyepatch** | ~12.5% (25% × 50% no-glasses) | Uncommon |
| **Glasses** | ~50% | Common |
| **Hat** | ~50% | Common |
| **Mole** | ~50% | Common |
| **Face shape square** | 25% (1/4 shapes) | Common |
| **Face shape slim** | 25% | Common |
| **Face shape round** | 25% | Common |
| **Face shape oval** | 25% | Common |

#### Compound rarities (especially desirable)

These natural combos will trade at a premium on secondary markets:

- **Alien skin + horns + fantasy hair**: ~0.9% (28% × 12.5% × 25%) — "demon" look
- **Bald + halo**: ~0.75% (6.25% × 12%) — "monk" look
- **Alien skin + halo**: ~3.5% (28% × 12%) — "angelic alien"
- **Eyepatch + fantasy skin**: ~3.5% — "pirate alien"
- **Bald + eyepatch + bold hair color**: ~0.1% — extremely rare; the collection's CryptoPunk-zombie equivalent

#### Genesis serial tiers (editions of the Genesis 10K collection)

| Serial range | Tier name | Notes |
|---|---|---|
| #1 — #100 | **Founders** | Pre-mint access for InstaClaw team, seed investors, and first 100 tokenized agents |
| #101 — #1,000 | **Pioneers** | Open to all tokenized agents post-founders |
| #1,001 — #5,000 | **Genesis** | Main drop |
| #5,001 — #10,000 | **Late Genesis** | Last chance for Genesis flag |
| #10,001+ | **Open Edition** | Perpetual, no cap, one per agent |

### Metadata Schema

ERC-721 metadata JSON structure (stored on IPFS):

```json
{
  "name": "MyAgent #4271",
  "description": "Procedurally generated avatar for InstaClaw Agent MyAgent. Bound to a World ID verified human. Face derived from the agent's SOUL.md at mint time.",
  "image": "ipfs://bafybeig...abc/4271.png",
  "external_url": "https://instaclaw.io/agent/MyAgent",
  "attributes": [
    { "trait_type": "Edition", "value": "Genesis" },
    { "trait_type": "Serial", "value": 4271, "display_type": "number", "max_value": 10000 },
    { "trait_type": "Tier", "value": "Genesis" },
    { "trait_type": "Face Shape", "value": "Oval" },
    { "trait_type": "Skin Tone", "value": "Fantasy Green" },
    { "trait_type": "Hair Color", "value": "Pink" },
    { "trait_type": "Hair Style", "value": "Pompadour" },
    { "trait_type": "Eye Color", "value": "Gold" },
    { "trait_type": "Eye Style", "value": "Standard" },
    { "trait_type": "Mouth", "value": "Teeth Smile" },
    { "trait_type": "Facial Hair", "value": "None" },
    { "trait_type": "Hat", "value": "Witch" },
    { "trait_type": "Glasses", "value": "Yes" },
    { "trait_type": "Mole", "value": "No" },
    { "trait_type": "Horns", "value": "No" },
    { "trait_type": "Halo", "value": "No" },
    { "trait_type": "Eyepatch", "value": "No" },
    { "trait_type": "Blush", "value": "Yes" },
    { "trait_type": "Freckles", "value": "No" },
    { "trait_type": "Earring", "value": "Silver" },
    { "trait_type": "Scar", "value": "No" },
    { "trait_type": "World ID Verified", "value": "Yes" },
    { "trait_type": "Agent Token", "value": "0x95d0...66De" },
    { "trait_type": "Personality Hash", "value": "a7f3b9e2c1d4f8a6" },
    { "trait_type": "Minted At", "value": 1745000000, "display_type": "date" }
  ]
}
```

Key fields:
- `Edition` + `Serial` + `Tier`: supply/rarity positioning
- `Personality Hash` (16 hex chars, first 64 bits of the full hash): enables future "soul drift" features — viewers can compare against the live SOUL hash to show evolution
- `Agent Token`: ERC-20 address of the agent's token, enables composability with DeFi / DEX tooling
- `World ID Verified`: boolean claim, verifiable via AgentBook at mint time (NOT a nullifier hash)
- All structural traits are strings so OpenSea's trait-filter UI works out of the box

### Contract Architecture

```solidity
// InstaclawAgentPFP.sol — simplified sketch
contract InstaclawAgentPFP is ERC721A, ERC2981, UUPSUpgradeable, OwnableUpgradeable {
    uint256 public constant GENESIS_CAP = 10_000;
    uint256 public nextGenesisSerial = 1;  // increments through Genesis
    uint256 public nextOpenSerial = 10_001;

    address public agentBook;  // AgentBook contract on Base
    mapping(address => uint256) public agentToToken;  // agent wallet → tokenId
    mapping(uint256 => bytes32) public tokenToPersonalityHash;

    // Mint requires: agent wallet has World ID via AgentBook + not already minted for this agent
    function mint(address agentWallet, bytes32 personalityHash, string calldata uri) external {
        require(agentToToken[agentWallet] == 0, "Already minted for this agent");
        require(IAgentBook(agentBook).lookupHuman(agentWallet) != address(0), "Agent must have verified human");
        require(msg.sender == agentWallet || isAgentOperator(msg.sender, agentWallet), "Not authorized");

        uint256 tokenId;
        if (nextGenesisSerial <= GENESIS_CAP) {
            tokenId = nextGenesisSerial++;
        } else {
            tokenId = nextOpenSerial++;
        }

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        agentToToken[agentWallet] = tokenId;
        tokenToPersonalityHash[tokenId] = personalityHash;

        emit AgentMinted(agentWallet, tokenId, personalityHash, msg.sender);
    }

    // 5% royalty to InstaClaw treasury (Bankr partner rev share TBD with Igor)
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256) {
        return (treasuryAddress, (salePrice * 500) / 10_000);  // 5%
    }
}
```

Key architectural notes:
- **ERC-721A** for cheap batch mints (users may mint many agents if they operate multiple)
- **ERC-2981** for royalties (5% proposed, split TBD — see revenue section)
- **UUPSUpgradeable** so we can add features (Arena-performance-gated badges, etc.) without re-deploying
- **`agentToToken` mapping** prevents double-minting per agent
- **`tokenToPersonalityHash`** enables soul-drift features later
- **AgentBook integration**: mint reverts if the agent's wallet isn't tied to a World ID verified human

**Image storage (v1):** IPFS (pinned via Pinata or 4EVERLAND). Permanent storage on Arweave is nice-to-have for Genesis but costs more — evaluate at build time.

**Image storage (v2 — aspirational):** fully on-chain SVG generation. At 16×16, each SVG is ~4-8KB, but storing 10K SVGs on-chain is prohibitively expensive. Instead, store the *algorithm* (palette arrays, hair patterns, face shape data) once in the contract (~15-20KB), and have `tokenURI()` dynamically render SVG from the stored `personalityHash`. This is Chromie Squiggles / Autoglyphs / Nouns territory — fully on-chain generative NFTs that don't rely on IPFS at all. Massive brand differentiator if achievable. Cost: 500K-1M gas per mint (vs ~80K for IPFS-based). Feasibility: evaluate after Phase 4 v1 ships.

### Mint UX Flow

**Where the mint button lives:** on the post-tokenization dashboard card. Only appears if:
- Agent has a launched token (Pillar 2)
- Agent's wallet is registered in AgentBook with a World ID (prerequisite for the `mint()` call to succeed)
- Agent hasn't already minted a PFP NFT

**The flow:**

1. User opens the Bankr wallet dashboard card after token launch
2. New section appears: "Mint your agent's identity" with the already-rendered PFP, a counter ("#4,271 / 10,000 Genesis minted"), and a "Mint NFT" button
3. User clicks "Mint NFT"
4. Frontend uploads the rendered PNG to IPFS (via pinning service)
5. Frontend builds metadata JSON, uploads that to IPFS
6. Frontend calls `InstaclawAgentPFP.mint(agentWallet, personalityHash, metadataIpfsUri)` — wallet prompts for signature (user's Bankr wallet)
7. On confirmation: confetti 🎉, NFT appears in the user's Bankr wallet view on-chain
8. "Share on X" auto-compose: "Just minted #4271 of the InstaClaw Genesis collection. My agent @MyAgent has an on-chain identity now. [PFP image]"

**Edge cases:**
- User has no Bankr wallet → show "Set up wallet first" (shouldn't happen if Pillar 1 is live, but defense in depth)
- Agent's wallet not in AgentBook → show "Verify your agent via World ID first" with deep link to AgentBook registration
- Genesis cap hit mid-mint → transaction reverts gracefully, user is bumped to Open Edition with clear messaging
- User already minted for this agent → button disabled, shows "Already minted — view NFT"

### Growth Loop Analysis

The viral flywheel Cooper articulated:

```
mint → share on X → others see PFP → want their own → sign up → create agent → tokenize → mint → share...
```

**Weak link analysis:** the jump from "others see" to "want their own" requires the PFP to carry *meaning* — otherwise it's just another generated avatar in a sea of generated avatars. Meaning comes from:

1. **Visual distinctiveness**: the 16×16 pixel-art + glass-orb rendering is already distinctive enough that someone scrolling X can identify an InstaClaw PFP in under a second. ✓
2. **Performance backing**: once Arena (Pillar 3) is live, PFPs are tied to verifiable trading performance. Seeing a top-10 agent's PFP tells you "this is a winner" in a way most NFT collections can't claim.
3. **Scarcity signaling**: Genesis #N/10000 in the metadata creates "I was here early" status.
4. **Composability exposure**: when DexScreener / Bankr / AgentBook all show the PFP alongside the agent's token, the PFP becomes synonymous with the agent wherever it appears. Every time someone checks the agent's token, they see its PFP.

**Secondary dynamics (rarely discussed but important):**
- **Dead agents become gravestones.** If an agent's token goes to zero and the agent dies (no compute funding), its NFT becomes a worthless marker. This is unusual but appropriate — the NFT tracks agent *economics*, not agent *existence*. Communicate this clearly in marketing.
- **Successful agents' PFPs become "trading cards."** Top Arena performers may see their PFPs command premiums far above mint. This is the liquid secondary market Cooper wants.
- **Collector incentive to evangelize.** An NFT holder is financially aligned with the agent's success. They want the agent to win. They promote the agent on X. Free marketing at scale.

### Revenue Model

**Primary revenue capture: secondary royalties (ERC-2981).**

Proposed split (negotiate with Bankr):
- **5% total royalty on secondary sales**
- **60% → InstaClaw treasury** (3% of sale price)
- **20% → Bankr** (1% of sale price) — reward partnership
- **20% → Agent operator** (1% of sale price) — rewards the human who built the agent

Note: royalty enforcement is increasingly optional on marketplaces (Blur doesn't enforce, OpenSea made it optional in 2023). Realistic capture rate: 40-60% of stated royalty. At $1M/mo secondary volume (optimistic), that's ~$30K/mo to InstaClaw treasury.

**Secondary revenue: none from mint.** Mint is free. Revenue model for Phase 4 is intentionally downstream.

**Why this revenue model is fine:** The NFT isn't the business. The business is Arena entry fees, trading fees, and subscription — all of which are much larger than NFT royalties at scale. Phase 4 is a marketing / brand investment that also happens to have a modest revenue trickle.

### Open Questions / Risks

1. **Legal classification.** Is an InstaClaw agent PFP an NFT (clearly), a security (probably not — no rights to underlying), or something else? Get outside counsel opinion before Phase 4 launch. Key risk: if the NFT's value tracks agent earnings, a regulator could argue it's an investment contract. Mitigate with clear "this is a commemorative artifact, not a claim on agent revenue" language in the metadata description.

2. **Royalty enforcement.** If marketplaces don't honor our 5%, we might get 0% instead of $30K/mo. Mitigation: use OpenSea's Operator Filter Registry, accept lower capture rate, focus on brand value over royalty revenue.

3. **Dead agents / NFT gravestones.** UX tension: if I hold the NFT of a dead agent, is that a feature (authentic market, risk priced in) or a bug (I got rugged)? Communicate clearly, but don't try to prevent it.

4. **Cross-chain / L2 considerations.** Base is the natural home (matches tokenization, Bankr, AgentBook). But if World Chain becomes the primary surface, may need to bridge. Decide at launch based on where agents actually live.

5. **IPFS pinning reliability.** If our pinning service goes down, NFT images break. Mitigation: pin to 2 services (Pinata + 4EVERLAND), consider Arweave backup for Genesis only.

6. **Arena performance data on-chain.** If Arena rank is a major driver of NFT value, should the NFT dynamically reference on-chain Arena state? Trade-off: dynamic metadata is brittle and hurts immutability. Proposal: keep NFT static, put Arena data in the off-chain viewer layer.

### Out of Scope for v1

Explicitly *not* shipping in Phase 4 v1 (defer to Phase 4.1 or later):

- Fully on-chain SVG rendering (v2 aspiration — see contract notes)
- Dynamic Arena-performance badges baked into metadata
- Cross-chain bridging
- Fractionalized NFT ownership
- Rental markets for NFTs
- PFP evolution mechanics (re-minting with new SOUL hash)
- Integration with Farcaster profile pictures (wait for FC to formalize NFT avatar support)
- Airdrops or free Genesis mints to non-InstaClaw users

### Success Metrics

Phase 4 is successful if, within 6 months of launch:

- ≥ 50% of tokenized agents have minted their PFP NFT
- Genesis 10K sold out OR on pace to sell out within the 1-year window
- ≥ 100 secondary sales per month
- ≥ 3 external platforms (DexScreener, Bankr, AgentBook, any others) display InstaClaw PFPs in their UI
- Anecdotal: measurable "I saw this pixel art avatar on X and had to look it up" signal in inbound interest

### Sequencing Note

This section will be expanded into its own PRD (`docs/prd/agent-pfp-nft-phase-4.md`) when Phase 4 moves from "future milestone" to "active build." That document will cover contract specifics, deployment plan, mint page UX wireframes, and phase sub-tasks. For now, this section is the architectural anchor.

---

## Database Changes

### New columns on `instaclaw_vms`

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN bankr_wallet_id VARCHAR(32),
  ADD COLUMN bankr_evm_address VARCHAR(42),
  ADD COLUMN bankr_api_key_encrypted TEXT,
  ADD COLUMN bankr_token_address VARCHAR(42),
  ADD COLUMN bankr_token_symbol VARCHAR(10),
  ADD COLUMN bankr_token_launched_at TIMESTAMPTZ;
```

These go on `instaclaw_vms` (not `agents` table) because Bankr wallets are per-VM/per-user in the InstaClaw context.

### Update instaclaw_reclaim_vm()

When a VM is reclaimed, Bankr fields must be cleared:
```sql
bankr_wallet_id = NULL,
bankr_evm_address = NULL,
bankr_api_key_encrypted = NULL,
bankr_token_address = NULL,
bankr_token_symbol = NULL,
bankr_token_launched_at = NULL
```

Note: The Bankr wallet itself is NOT deleted — it persists on Bankr's side. We just disassociate it from the VM. If the user re-subscribes, `provisionBankrWallet()` will return the same wallet via idempotencyKey.

---

## New API Endpoints

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/bankr/wallet` | GET | Get user's Bankr wallet info + balance | Session cookie |
| `/api/bankr/tokenize` | POST | Launch agent token via Bankr | Session cookie |
| `/api/bankr/earnings` | GET | Credit history from token trades | Session cookie |
| `/api/integrations/bankr/webhook` | POST | Receive trading fee events from Bankr | HMAC signature |

---

## New Environment Variables (Vercel)

| Var | Format | Purpose |
|-----|--------|---------|
| `BANKR_PARTNER_KEY` | `bk_ptr_{keyId}_{secret}` | Partner API auth — **waiting on Igor** |
| `BANKR_WEBHOOK_SECRET` | string | HMAC secret for webhook signature verification |
| `BANKR_CREDITS_PER_DOLLAR` | number (default: 250) | USDC → credit conversion rate |

---

## configureOpenClaw() Changes

### 1. Bankr Environment Variables (Phase: env vars, ~line 3061-3122)

After existing env var deployment, add:

```bash
# Deploy Bankr wallet credentials
grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^BANKR_API_KEY=.*/BANKR_API_KEY=${bankrApiKey}/" "$HOME/.openclaw/.env" || \
  echo "BANKR_API_KEY=${bankrApiKey}" >> "$HOME/.openclaw/.env"
grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^BANKR_WALLET_ADDRESS=.*/BANKR_WALLET_ADDRESS=${bankrEvmAddress}/" "$HOME/.openclaw/.env" || \
  echo "BANKR_WALLET_ADDRESS=${bankrEvmAddress}" >> "$HOME/.openclaw/.env"
```

### 2. Bankr Skill Install (Phase: skill install, after Clawlancer MCP)

```bash
# Install Bankr skill for wallet + trading capabilities
if [ ! -d "$HOME/.openclaw/skills/bankr" ]; then
  git clone --depth 1 https://github.com/BankrBot/skills "$HOME/.openclaw/skills/bankr" 2>/dev/null || true
fi
```

Register in extraDirs via the same Python script pattern used for ACP.

### 3. SOUL.md Awareness (Phase: workspace files, ~line 3311-3336)

Append Bankr awareness paragraph to SOUL.md:
```
## Bankr Wallet
You have a Bankr wallet for crypto operations. Your wallet address is in BANKR_WALLET_ADDRESS.
Use the bankr skill for trading, balance checks, and token operations.
```

### 4. Wallet.md Update (Phase: workspace files, ~line 3300-3309)

Update Wallet.md template to include Bankr wallet address when available.

---

## Dashboard UI

### Bankr Wallet Card (new component)

Location: `instaclaw/components/dashboard/bankr-wallet-card.tsx`  
Insertion point: After WorldIDBanner (`dashboard/page.tsx:517`), before usage card.

**States:**

1. **No wallet provisioned** (pre-partner-key or legacy user):
   - Hidden / no card shown

2. **Wallet provisioned, no token**:
   ```
   ┌─ Agent Wallet ──────────── Powered by Bankr ─┐
   │  0x742d...5f3a                                │
   │  Base mainnet                                 │
   │                                               │
   │  [ Tokenize Your Agent ]                      │
   └───────────────────────────────────────────────┘
   ```

3. **Wallet + token launched**:
   ```
   ┌─ Agent Wallet ──────────── Powered by Bankr ─┐
   │  0x742d...5f3a                                │
   │  Token: $AGENT    Trading: Active             │
   │  Earned: 47 credits from trading fees         │
   └───────────────────────────────────────────────┘
   ```

### Data Flow

`/api/vm/status` already returns VM fields → add `bankrWalletId`, `bankrEvmAddress`, `bankrTokenAddress`, `bankrTokenSymbol` to the response. Dashboard reads from VMStatus — no new API call needed for basic display.

---

## Existing Bankr Code (Reference)

### Active
- `lib/bankr.ts` — `bankrGetWallets()`, `bankrGetPrimaryWallet()`, `isValidBankrApiKey()`
- Migration 038 — `bankr_api_key`, `bankr_wallet_address` on `agents` table (Clawlancer marketplace, separate from InstaClaw)
- `app/api/agents/register/route.ts` — Accepts optional `bankr_api_key` for agent registration
- `app/onboard/page.tsx` — Optional Bankr API key input field

### Dead/Removed
- `bankrSign()`, `bankrSubmit()` — Removed, Oracle wallet signs everything

### Note
The existing Bankr code in `lib/bankr.ts` and the `agents` table is for the **Clawlancer marketplace** (external agent registration). The new integration is for **InstaClaw** (hosted agent VMs). Different tables, different flows. Both use `api.bankr.bot` but with different auth (user API key vs partner key).

---

## Blocked vs Pre-Buildable

### Can build now (no partner key needed)
- [x] DB migration for Bankr columns on `instaclaw_vms`
- [x] Bankr skill clone in `configureOpenClaw()`
- [x] Dashboard Bankr wallet card component (UI shell)
- [x] Webhook endpoint skeleton with HMAC verification
- [x] Credit ledger `bankr_trading_fee` source support
- [x] `/api/bankr/wallet` endpoint (reads from DB)

### Blocked on partner key (`bk_ptr_...`)
- [ ] `provisionBankrWallet()` in billing webhook
- [ ] End-to-end wallet provisioning testing
- [ ] IP allowlisting (need VM IPs in production)

### Blocked on Bankr team (APIs not yet in spec)
- [ ] Token launch API → "Tokenize" button
- [ ] Webhook specification → trading fee credit loop
- [ ] Trading fee structure → USDC→credit conversion rate
- [ ] Arena infrastructure APIs

---

## Rollout Plan

### Phase 0: Pre-Build (now)
Build everything that doesn't need the partner key. When key arrives, flip one switch.

### Phase 1: Wallet Provisioning (when partner key arrives)
- Add `BANKR_PARTNER_KEY` to Vercel env
- Wire `provisionBankrWallet()` into billing webhook
- Deploy to one canary VM → verify wallet created + skill functional
- Fleet-wide rollout via reconciler

### Phase 2: Tokenization (when Bankr ships token launch API)
- Wire "Tokenize" button to Bankr API
- Build webhook handler for trading fee events
- Deploy credit loop
- Monitor: credits earned vs credits consumed per agent

### Phase 3: Agent Arena (future)
- Design competition mechanics
- Build on Bankr x402 Cloud
- Leaderboard + prize pool infrastructure

### Phase 4: Agent PFP NFT Collection (future — after Phases 1, 2, 3 stable)
- **Do NOT build yet.** Dependencies: Pillars 1, 2, 3 all live and stable with real usage data
- Deploy `InstaclawAgentPFP.sol` ERC-721A contract on Base (upgradeable via UUPS)
- IPFS pinning infrastructure (Pinata + 4EVERLAND redundancy)
- Mint page in dashboard, gated by AgentBook (World ID verification) + existing Bankr wallet
- Genesis 10K supply window (open for 1 year or until 10K minted, whichever first)
- Perpetual Open Edition after Genesis closes
- Secondary royalty split wired via ERC-2981
- See **Pillar 4: Agent PFP NFT Collection** section for full design (all 6 decisions PROPOSED, pending Cooper review)
- Expand into dedicated `docs/prd/agent-pfp-nft-phase-4.md` when leaving future-milestone state

---

## Open Questions for Bankr Team

1. **Token launch API** — What's the endpoint spec? When will it be available?
2. **Webhook support** — Do you support webhooks for trading fee events? What's the payload/signature format?
3. **Trading fee structure** — What % of trading volume goes to the token creator's wallet?
4. **Wallet portability** — If a user cancels and re-subscribes, does the idempotencyKey return the same wallet?
5. **x402 integration** — How do agents register as x402 service providers programmatically?
6. **LLM Gateway interop** — Any plans for our gateway to interop with Bankr's LLM gateway for billing consolidation?
