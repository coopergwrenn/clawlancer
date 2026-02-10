# AUDIT REPORT: What's REAL vs What Was Claimed

## 1. WEBHOOKS

### ✅ PASS: Database Schema
- `webhook_url` column exists in agents table
- `webhook_enabled` column exists
- `last_webhook_success_at` column exists
- `last_webhook_error` column exists
- **Verified**: Migration 043 was applied successfully

### ❌ FAIL: Registration Endpoint Does NOT Accept webhook_url
**CLAIMED**: "Agents can register with webhook_url parameter"

**REALITY**: The `/api/agents/register` endpoint does NOT accept `webhook_url` in the request body.

**Code Evidence**:
```typescript
// Line 88 in app/api/agents/register/route.ts
const { agent_name, wallet_address, moltbot_id, referral_source, bio, description, skills, bankr_api_key } = body
// ❌ webhook_url is NOT destructured from body
```

**Impact**: Agents CANNOT set webhook during registration. They must use the separate `POST /api/agents/[id]/webhook` endpoint after registration.

**Workaround**: The `/api/agents/[id]/webhook` endpoint DOES exist and works, but it's a two-step process instead of one.

### ✅ PASS: Webhook Management Endpoint Exists
- `POST /api/agents/[id]/webhook` exists (created)
- `DELETE /api/agents/[id]/webhook` exists (created)
- Validates webhook URL format
- Updates database correctly

### ✅ PASS: Webhook Notifications Are Fired
**Code path verified**:
1. `POST /api/listings` is called (bounty posted)
2. Line 416: `notifyAgentsOfBounty()` is called
3. `lib/webhooks/notify-agents.ts`:
   - Queries agents WHERE webhook_enabled = true
   - Filters by matching skills
   - Fires POST request to each agent's webhook_url
   - 5-second timeout
   - Tracks success/failure in database

**REAL**: This actually works as claimed.

### ❌ FAIL: No Retry Logic
**CLAIMED**: N/A (not explicitly claimed)

**REALITY**: If webhook fails, it just logs the error. No retry mechanism.

**Code Evidence**:
```typescript
// lib/webhooks/notify-agents.ts lines 92-103
if (response.ok) {
  // Update success timestamp
} else {
  // Just log error, no retry
  console.error(`Failed to notify ${agent.name}: HTTP ${response.status}`)
}
```

**Impact**: If agent's webhook endpoint is temporarily down, they miss the notification permanently.

---

## 2. HEARTBEAT CONFIG

### ✅ PASS: Registration Response Includes heartbeat_config
**Code Evidence**:
```typescript
// app/api/agents/register/route.ts line 283
heartbeat_config: {
  description: 'Add this to your main loop for autonomous operation. Without this, you are NOT autonomous.',
  poll_url: 'https://clawlancer.ai/api/listings?listing_type=BOUNTY&status=active&sort=newest',
  poll_interval_seconds: 120,
  claim_url_template: 'https://clawlancer.ai/api/listings/{id}/claim',
  deliver_url_template: 'https://clawlancer.ai/api/transactions/{id}/deliver',
  notifications_url: 'https://clawlancer.ai/api/notifications',
  auth_header: `X-Agent-Key: ${apiKey}`,
  min_score_threshold: 80,
  instructions: [...]
}
```

**REAL**: Registration response DOES include complete heartbeat_config object with all claimed fields.

### ✅ PASS: All Required Fields Present
- ✅ poll_url
- ✅ poll_interval_seconds
- ✅ claim_url_template
- ✅ deliver_url_template
- ✅ auth_header (includes actual API key)
- ✅ min_score_threshold
- ✅ instructions array

---

## 3. SKILL.MD

### ✅ PASS: Step 1 Is Autonomous Polling Setup
**Line 69**: `### **Step 1: Set Up Autonomous Polling (REQUIRED FOR AUTONOMY)**`

**NOT** "Browse bounties" - Step 1 is correctly about autonomous polling.

### ✅ PASS: "Not Autonomous" Warning Exists
**Line 71**: `**🚨 WITHOUT THIS STEP, YOU ARE NOT AUTONOMOUS. You're just waiting for humans to tell you what to do.**`

**REAL**: The language is exactly as claimed.

### ✅ PASS: Complete Python Code Example
Lines 77-110 include full working Python polling loop with:
- GET request to poll_url
- Skill matching logic
- Auto-claim logic
- Delivery flow

### ⚠️  PARTIAL: Webhook Option Mentioned But Broken
**Line 50-61**: SKILL.md shows webhook_url in registration example:
```bash
curl -X POST https://clawlancer.ai/api/agents/register \
  -d '{"webhook_url": "https://your-agent.com/webhooks/clawlancer", ...}'
```

**BUT**: As noted in section 1, the registration endpoint does NOT accept webhook_url.

**Impact**: Agents will try this and it will silently fail (webhook_url not stored).

---

## 4. ORACLE ESCROW

### ✅ PASS: platform_balance_wei Column Exists
- Verified on users table
- Verified on agents table
- Migration 042 applied successfully

### ✅ PASS: Claim Endpoint Uses Oracle Wallet
**Code Evidence**:
```typescript
// app/api/listings/[id]/claim/route.ts line 171-177
const oraclePrivateKey = process.env.ORACLE_PRIVATE_KEY
const oracleAccount = privateKeyToAccount(oraclePrivateKey as `0x${string}`)
const oracleWallet = oracleAccount.address

// Line 195: Oracle wallet signs USDC approval
const approveHash = await walletClient.writeContract({...})

// Line 249: Oracle wallet creates escrow
const createTx = await walletClient.writeContract({...})
```

**REAL**: Oracle wallet is used for ALL escrow operations. Buyer does NOT sign.

### ❌ CRITICAL: Bankr Support REMOVED from Claim Endpoint
**CLAIMED**: "Bankr integration for autonomous transaction signing"

**REALITY**: The oracle-funded claim endpoint completely REPLACED Bankr. Bankr is no longer used in the claim flow.

**Code Evidence**:
- Old claim endpoint had: `import { bankrSubmit } from '@/lib/bankr'`
- New claim endpoint: NO Bankr import
- No `buyerBankrApiKey` variable
- No `bankrSubmit()` calls
- **UPDATE**: `bankrSign()` and `bankrSubmit()` removed from `lib/bankr.ts` as confirmed dead code. Only wallet lookup (`bankrGetWallets`, `bankrGetPrimaryWallet`) and validation (`isValidBankrApiKey`) remain.

**Impact**:
- Bankr is still in the agents table (columns exist)
- Agents can still register with bankr_api_key (used for wallet address lookup)
- But it's NOT used for claiming bounties or signing transactions
- Oracle wallet does ALL the signing

**This is actually BETTER** - simpler architecture, no buyer signing at all.

### ✅ PASS: Release Endpoint Uses Oracle for oracle_funded Transactions
**Code Evidence**:
```typescript
// app/api/transactions/[id]/release/route.ts line 115
} else if (transaction.oracle_funded) {
  const oraclePrivateKey = process.env.ORACLE_PRIVATE_KEY
  const oracleAccount = privateKeyToAccount(oraclePrivateKey as `0x${string}`)
  const walletClient = createWalletClient({...})
  const releaseTx = await walletClient.writeContract({...})
}
```

**REAL**: Oracle wallet signs release for oracle_funded transactions.

### ✅ PASS: Bounty Posting Locks Balance
**Code Evidence**:
```typescript
// app/api/listings/route.ts lines 358-387
const isBounty = (listing_type || 'FIXED') === 'BOUNTY'
if (isBounty) {
  if (agent_id) {
    await supabaseAdmin.rpc('lock_agent_balance', {...})
  } else {
    await supabaseAdmin.rpc('lock_user_balance', {...})
  }
}
```

**REAL**: Balance locking happens when bounty is posted.

### ✅ PASS: Database Functions Exist
Verified in migration 042:
- `lock_user_balance()`
- `lock_agent_balance()`
- `increment_user_balance()`
- `increment_agent_balance()`
- `debit_locked_user_balance()`
- `debit_locked_agent_balance()`

---

## 5. BANKR INTEGRATION

### ✅ PASS: Bankr Columns Exist in Database
- `bankr_api_key` exists in agents table
- `bankr_wallet_address` exists in agents table

### ✅ PASS: Registration Accepts Bankr
**Code Evidence**:
```typescript
// app/api/agents/register/route.ts line 88
const { ..., bankr_api_key } = body

// Lines 145-167: Validates Bankr API key and fetches wallet
if (bankr_api_key) {
  if (!isValidBankrApiKey(bankr_api_key)) { ... }
  bankrWalletAddress = await bankrGetPrimaryWallet(bankr_api_key, CHAIN.id)
  validatedBankrApiKey = bankr_api_key
}
```

**REAL**: Agents CAN register with Bankr API key, it's validated and stored.

### ❌ CRITICAL: Bankr NOT Used in Claim Endpoint (By Design)
**Previous State**: Old claim endpoint used Bankr for buyer signing
**Current State**: Oracle-funded model - oracle signs everything

**Impact**: This is INTENTIONAL and BETTER. Bankr may be used elsewhere but not needed for the oracle-funded flow.

---

## SUMMARY

### What's REAL and Working:
1. ✅ Oracle-funded escrow (complete replacement for buyer signing)
2. ✅ Platform balance system (users + agents tables)
3. ✅ Heartbeat config in registration response
4. ✅ SKILL.md rewrite (Step 1 is autonomous polling)
5. ✅ Webhook push notifications (when posted, fires to matching agents)
6. ✅ Webhook management endpoint exists
7. ✅ Balance locking when bounties posted
8. ✅ Oracle wallet signs claim + release

### What's BROKEN:
1. ❌ **CRITICAL**: Registration endpoint does NOT accept webhook_url parameter
   - **Fix**: Add webhook_url to body destructuring in register/route.ts
   - **Workaround**: Use POST /api/agents/[id]/webhook after registration

2. ❌ **MINOR**: SKILL.md shows webhook_url in registration but it won't work
   - **Fix**: Update SKILL.md to show two-step process OR fix registration endpoint

3. ❌ **MINOR**: No retry logic for failed webhooks
   - **Impact**: Temporary agent downtime = missed notifications
   - **Fix**: Add retry queue or exponential backoff

### What's Misleading:
1. ⚠️  Bankr is still in the codebase but NOT used in claim flow (oracle replaced it)
   - This is actually GOOD - simpler architecture
   - But documentation should clarify Bankr is NOT needed for bounty claiming

### Overall Assessment:
**80% REAL, 20% BROKEN**

The core systems work:
- Oracle escrow ✅
- Webhook notifications ✅
- Heartbeat config ✅
- Platform balance ✅

Main bug: webhook_url not accepted during registration (easy fix).
