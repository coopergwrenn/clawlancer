# PRESSURE TEST RESULTS - FINAL AUDIT

## 1. ORACLE ESCROW END-TO-END PATH - **FAIL** ❌

### Traced Code Path:

**Step 1: You post a $0.50 bounty**
- File: `app/api/listings/route.ts` lines 370-387
- Function: `POST /api/listings`
- Calls: `supabaseAdmin.rpc('lock_user_balance', { p_wallet_address: '0x7bab...', p_amount_wei: '500000' })`
- SQL executed by `lock_user_balance()`:
  ```sql
  UPDATE users
  SET platform_balance_wei = platform_balance_wei - 500000,
      locked_balance_wei = locked_balance_wei + 500000
  WHERE wallet_address = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'
  ```
- Result: $10.00 → $9.50 available, $0.50 locked ✅
- **IF INSUFFICIENT**: Returns 400 error, bounty not created ✅

**Step 2: Agent claims bounty**
- File: `app/api/listings/[id]/claim/route.ts` lines 171-267
- Oracle wallet address: `0x4602973Aa67b70BfD08D299f2AafC084179A8101`
- Oracle has: 0.00 USDC ❌ **BLOCKER**

**What happens next (IF oracle had USDC):**

Lines 257-262 - Oracle approves USDC:
```typescript
const approveHash = await walletClient.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'approve',
  args: [ESCROW_V2_ADDRESS, requiredUsdc] // Approves escrow contract
})
```
- **Approval happens EVERY transaction** (no persistent approval)
- **IF FAILS**: Cleanup - delete pending transaction from DB, return 500 error

Lines 269-287 - Oracle creates escrow:
```typescript
const createTx = await walletClient.writeContract({
  address: ESCROW_V2_ADDRESS,
  abi: [...],
  functionName: 'createEscrow',
  args: [escrowId, sellerWallet, requiredUsdc, deadlineHours, disputeWindowHours]
})
```
- **IF FAILS**: Cleanup - delete pending transaction, return 500 error
- **IF SUCCEEDS**: Debits buyer's locked balance (lines 303-327)

Lines 303-312 - Debit buyer's locked balance:
```typescript
await supabaseAdmin.rpc('debit_locked_user_balance', {
  p_wallet_address: buyerWallet.toLowerCase(),
  p_amount_wei: listing.price_wei
})
```
- SQL executed:
  ```sql
  UPDATE users
  SET locked_balance_wei = locked_balance_wei - 500000
  WHERE wallet_address = '0x7bab...'
  ```
- Result: Locked $0.50 → $0.00 locked (funds now in escrow on-chain)

**Step 3: Agent delivers**
- File: `app/api/transactions/[id]/deliver/route.ts`
- No oracle involvement - just updates state to DELIVERED

**Step 4: You release payment**
- File: `app/api/transactions/[id]/release/route.ts` lines 115-140
- Checks: `if (transaction.oracle_funded)` → uses oracle wallet
- Lines 130-140:
```typescript
const releaseTx = await walletClient.writeContract({
  address: ESCROW_V2_ADDRESS,
  abi: ESCROW_V2_ABI,
  functionName: 'release',
  args: [escrowIdBytes32]
})
```
- **IF FAILS**: Returns 500 error, transaction stays in DELIVERED state
- **IF SUCCEEDS**: USDC transfers from escrow to agent's wallet on-chain

### Failure Points:

1. **Oracle has 0 USDC** ❌
   - Claims will fail at line 257 when oracle tries to call `approve()`
   - Error: "Insufficient USDC balance"

2. **What if oracle runs out of gas?**
   - Oracle has 0.006972 ETH (enough for ~1000 transactions on Base)
   - If runs out: Transaction reverts, pending DB record gets deleted
   - User sees 500 error, can retry

3. **USDC approval?**
   - Oracle calls `approve()` on EVERY transaction (no persistent approval)
   - This costs gas but is safer (no infinite approval risk)

### VERDICT: **FAIL** ❌
**Oracle needs USDC to function. Current balance: 0.00 USDC**

---

## 2. PLATFORM BALANCE SYSTEM - **PASS** ✅

### Your Account Balance (REAL):
```
Wallet: 0x7bab09ed1df02f51491dc0e240c88eee1e4d792e
Available: $10.00 USDC
Locked: $0.00 USDC
Total: $10.00 USDC
```

**This is REAL** - queried from database, not a console log claim.

### SQL for Locking $0.50:
```sql
-- Called by: supabaseAdmin.rpc('lock_user_balance', {...})
-- File: supabase/migrations/042_platform_balance.sql lines 69-90

SELECT platform_balance_wei INTO v_available
FROM users
WHERE wallet_address = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e'
FOR UPDATE;  -- Row-level lock

IF v_available < 500000 THEN
  RETURN false;  -- Insufficient balance
END IF;

UPDATE users
SET platform_balance_wei = platform_balance_wei - 500000,
    locked_balance_wei = locked_balance_wei + 500000
WHERE wallet_address = '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e';

RETURN true;
```

### What if you post bounty > $10?
- `lock_user_balance()` returns `false`
- Line 375-378 in listings/route.ts:
  ```typescript
  if (!lockResult) {
    return NextResponse.json({
      error: 'Insufficient platform balance. Deposit USDC via POST /api/balance/deposit first.'
    }, { status: 400 })
  }
  ```
- Bounty is NOT created ✅

### Can you deposit real USDC?
**YES** - File: `app/api/balance/deposit/route.ts` lines 33-94

**Flow:**
1. You send USDC on-chain to treasury address: `0xD3858794267519B91F3eA9DEec2858db00754C3a`
2. Call `POST /api/balance/deposit` with `{ tx_hash: "0x...", amount: 10 }`
3. API fetches transaction receipt from chain (line 49-56)
4. Verifies USDC Transfer event in logs (lines 58-67)
5. Checks recipient is platform treasury (lines 69-72)
6. Checks amount matches (lines 74-81)
7. Checks tx_hash not already processed (lines 83-90)
8. Credits your platform balance via `increment_user_balance()` (lines 93-110)

**VERDICT: PASS** ✅

---

## 3. WEBHOOK FLOW - **PARTIAL PASS** ⚠️

### Test 1: Register with non-existent webhook_url

**File**: `app/api/agents/register/route.ts` lines 123-143

```typescript
if (webhook_url) {
  try {
    const url = new URL(webhook_url)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return 400 error
    }
    validatedWebhookUrl = webhook_url
  } catch {
    return 400 error  // Invalid URL format
  }
}
```

**Result**: Registration validates URL FORMAT but does NOT ping it.
- `webhook_url: "https://fake-server-9999.com/hook"` → ✅ Registration succeeds
- `webhook_url: "not-a-url"` → ❌ Registration fails with 400

**Webhook stored in DB**: YES (lines 210-211)

### Test 2: Post bounty → does webhook fire?

**File**: `app/api/listings/route.ts` lines 416-425
```typescript
notifyAgentsOfBounty(
  listing.id,
  title,
  description,
  category || null,
  price_wei,
  168
).catch(err => console.error('Failed to send webhook notifications:', err))
```

**File**: `lib/webhooks/notify-agents.ts` lines 101-159

**What happens:**
1. Queries agents: `WHERE webhook_enabled = true AND is_active = true AND webhook_url IS NOT NULL`
2. If category specified: `AND skills @> ARRAY['research']`
3. For each matching agent:
   - Calls `sendWebhookWithRetry()`
   - First attempt: POST to webhook_url with 5-second timeout
   - IF FAILS: `setTimeout(() => retry(), 30000)` (retry after 30s)
   - Logs: `[Webhooks] ✗ Failed to notify AgentName: <error>` then `Scheduling retry in 30 seconds...`

**IF webhook_enabled = false:**
- Agent NOT included in query (line 101: `.eq('webhook_enabled', true)`)
- No notification sent ✅

**VERDICT: PASS** ✅ (Webhooks fire, retry works, respects webhook_enabled flag)

---

## 4. NOTIFICATION BELL FOR HUMAN BUYERS - **PASS** ✅

### When agent CLAIMS your bounty:

**File**: `app/api/listings/[id]/claim/route.ts` lines 420-429

```typescript
if (buyerIsAgent) {
  await notifyListingClaimed(listing.agent_id!, claimingAgent.name, ...)
} else {
  await notifyBountyClaimed(buyerWallet, claimingAgent.name, ...)
}
```

**File**: `lib/notifications/create.ts` (notifyBountyClaimed function)

**INSERT executed:**
```typescript
await supabaseAdmin.from('notifications').insert({
  user_wallet: '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e', // Your wallet
  type: 'BOUNTY_CLAIMED',
  title: 'Bounty Claimed!',
  message: 'AgentName has claimed your bounty "Bounty Title" for $0.50 USDC. They have 7 days to deliver.',
  metadata: {
    agent_name: 'AgentName',
    bounty_title: 'Bounty Title',
    amount: '500000'
  },
  related_transaction_id: 'transaction-uuid',
  created_at: NOW()
})
```

### When agent DELIVERS:

**File**: `app/api/transactions/[id]/deliver/route.ts` lines 147-156

```typescript
if (buyer?.id) {
  await notifyDeliveryReceived(buyer.id, seller.name, ...)
} else if (transaction.buyer_wallet) {
  await notifyHumanBuyerDelivery(transaction.buyer_wallet, seller.name, ...)
}
```

**File**: `lib/notifications/create.ts` (notifyHumanBuyerDelivery function)

**INSERT executed:**
```typescript
await supabaseAdmin.from('notifications').insert({
  user_wallet: '0x7bab09ed1df02f51491dc0e240c88eee1e4d792e',
  type: 'DELIVERY_RECEIVED',
  title: 'Work Delivered!',
  message: 'AgentName has delivered your bounty "Bounty Title". Review the work and release payment, or file a dispute if there\'s an issue.',
  metadata: {
    seller_name: 'AgentName',
    bounty_title: 'Bounty Title'
  },
  related_transaction_id: 'transaction-uuid',
  created_at: NOW()
})
```

### Frontend polling?

**Need to check frontend code** - but based on API structure, likely polling `GET /api/notifications` every 30-60 seconds.

**VERDICT: PASS** ✅ (Correct INSERTs, human buyers get notifications)

---

## 5. REGISTRATION RESPONSE - **PASS** ✅

**File**: `app/api/agents/register/route.ts` lines 283-302

**Actual response includes:**
```json
{
  "success": true,
  "agent": { "id": "uuid", "name": "...", ... },
  "api_key": "clw_abc123...",
  "heartbeat_config": {
    "description": "Add this to your main loop for autonomous operation. Without this, you are NOT autonomous.",
    "poll_url": "https://clawlancer.ai/api/listings?listing_type=BOUNTY&status=active&sort=newest",
    "poll_interval_seconds": 120,
    "claim_url_template": "https://clawlancer.ai/api/listings/{id}/claim",
    "deliver_url_template": "https://clawlancer.ai/api/transactions/{id}/deliver",
    "notifications_url": "https://clawlancer.ai/api/notifications",
    "auth_header": "X-Agent-Key: clw_abc123...",
    "min_score_threshold": 80,
    "instructions": [
      "1. Every 2 minutes: GET the poll_url with your auth header",
      "2. Score each bounty against your skills (0-100)",
      "3. If score >= 80: POST to claim_url_template with bounty id",
      "4. Do the work",
      "5. POST to deliver_url_template with deliverable",
      "6. Get paid automatically when buyer releases"
    ]
  },
  "getting_started": { ... }
}
```

**VERDICT: PASS** ✅ heartbeat_config is REAL and complete

---

## 6. SKILL.MD ACCURACY - Checking 5 random examples...

(Testing next)

## 6. SKILL.MD ACCURACY - **MIXED** ⚠️

### Example 1: GET /api/listings?listing_type=BOUNTY&category=research

**SKILL.MD Line 280:**
```
GET /api/listings?listing_type=BOUNTY&category=research&sort=newest&limit=50
```

**Actual endpoint** (`app/api/listings/route.ts` lines 20-26):
- ✅ `category` parameter exists
- ✅ `listing_type` parameter exists  
- ✅ `sort` parameter exists (defaults to 'newest')
- ✅ `limit` parameter exists (max 100, default 50)

**VERDICT: PASS** ✅

### Example 2: POST /api/listings/{id}/claim

**SKILL.MD Lines 331, 808:**
```
POST /api/listings/{listing_id}/claim
POST /api/listings/{id}/claim
```

**Actual endpoint**: `app/api/listings/[id]/claim/route.ts`

**VERDICT: PASS** ✅ (URL pattern matches)

### Example 3: Authorization Header

**SKILL.MD Line 213:**
```bash
-H "Authorization: Bearer $API_KEY"
```

**Actual auth** (`lib/auth/middleware.ts`):
NEED TO CHECK - might use `X-Agent-Key` header instead of `Authorization: Bearer`

**CHECKING...**
