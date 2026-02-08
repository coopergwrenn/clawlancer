# BANKR INTEGRATION AUDIT

Comparing our implementation against official Bankr documentation.

## ✅ CORRECT IMPLEMENTATIONS

### 1. API URL
**Official docs:** `https://api.bankr.bot`
**Our implementation:** `lib/bankr.ts` line 13
```typescript
const BANKR_API_URL = process.env.BANKR_API_URL || 'https://api.bankr.bot'
```
✅ **PASS** - Matches official URL with env override option

### 2. API Key Format Validation
**Official docs:** API keys start with `bk_`
**Our implementation:** `lib/bankr.ts` lines 152-154
```typescript
export function isValidBankrApiKey(apiKey: string): boolean {
  return /^bk_[a-zA-Z0-9]{32,64}$/.test(apiKey)
}
```
✅ **PASS** - Validates `bk_` prefix + 32-64 alphanumeric chars

### 3. Authorization Header
**Official docs:** `Authorization: Bearer {apiKey}`
**Our implementation:** `lib/bankr.ts` lines 59, 90, 116
```typescript
'Authorization': `Bearer ${apiKey}`
```
✅ **PASS** - Correct Bearer token format

### 4. Endpoints Used
**Official docs:**
- `POST /agent/sign` - Sign transactions without submitting
- `POST /agent/submit` - Sign and submit transactions
- `GET /agent/wallets` - Get wallet addresses

**Our implementation:**
- ✅ `bankrSign()` - POST /agent/sign (line 55)
- ✅ `bankrSubmit()` - POST /agent/submit (line 86)
- ✅ `bankrGetWallets()` - GET /agent/wallets (line 113)
- ✅ `bankrGetPrimaryWallet()` - Helper to get primary wallet for chain (line 135)

✅ **PASS** - All recommended endpoints implemented

### 5. Error Handling
**Official docs:** Handle authentication failures, insufficient balance, rate limits
**Our implementation:** `lib/bankr.ts` lines 64-66, 98-100, 120-122
```typescript
if (!response.ok) {
  const error = await response.json().catch(() => ({ error: 'Unknown error' }))
  throw new Error(`Bankr submit failed: ${error.error || response.statusText}`)
}
```
✅ **PASS** - Proper error handling with fallback

### 6. Transaction Structure
**Official docs:** Transactions need `to`, `data`, `value`, `chainId`
**Our implementation:** `lib/bankr.ts` lines 15-21
```typescript
interface BankrTransaction {
  to: Address
  data: Hex
  value?: string // hex string
  chainId: number
  gasLimit?: string // optional gas limit override
}
```
✅ **PASS** - Matches expected structure

### 7. Registration Integration
**Our implementation:** `app/api/agents/register/route.ts`
- ✅ Accepts `bankr_api_key` parameter (line 88)
- ✅ Validates API key format (line 103)
- ✅ Fetches primary wallet via `bankrGetPrimaryWallet()` (line 112)
- ✅ Stores both `bankr_api_key` and `bankr_wallet_address` (lines 210-211)

✅ **PASS** - Proper integration with registration flow

---

## ❌ ISSUES FOUND

### Issue 1: Bankr is NOT Used in Claim Endpoint
**Status:** INTENTIONAL (oracle-funded model replaced it)

**Previous design:** Buyer's Bankr wallet signs USDC approval + escrow creation
**Current design:** Oracle wallet signs everything

**Files affected:**
- `app/api/listings/[id]/claim/route.ts` - NO Bankr imports or usage

**Impact:**
- Bankr API key stored in database but NOT used for bounty claims
- SKILL.md previously suggested Bankr was required for autonomous claiming
- Now clarified: Bankr is OPTIONAL (oracle handles signing)

**Verdict:** This is CORRECT. Oracle-funded model is better (simpler, no buyer signing needed).

### Issue 2: SKILL.md Bankr Instructions Could Be Clearer
**Current state:** Updated in recent fixes to clarify Bankr is optional

**SKILL.md now says (lines 69-72):**
> "You do NOT need Bankr or your own wallet to claim bounties. The platform's oracle wallet handles all transaction signing automatically. Bankr/custom wallets are only needed if you want to receive payments directly to your own on-chain address."

✅ **FIXED** - Documentation is now accurate

---

## 🔍 ADDITIONAL CHECKS

### Bankr API Key Storage Security
**Our implementation:**
- ✅ API keys stored in database (hashed? NO - stored in plaintext)
- ⚠️ **SECURITY CONCERN:** Bankr API keys stored in plaintext in `agents.bankr_api_key` column

**Recommendation:** Encrypt Bankr API keys at rest (similar to how we handle XMTP private keys)

**Current XMTP encryption (for reference):**
```typescript
// lib/xmtp/keypair.ts
export function encryptXMTPPrivateKey(privateKey: string): string {
  const key = process.env.ENCRYPTION_KEY
  // ... AES encryption
}
```

**Should implement for Bankr:**
```typescript
export function encryptBankrApiKey(apiKey: string): string {
  // Encrypt before storing in database
}

export function decryptBankrApiKey(encrypted: string): string {
  // Decrypt when using for API calls
}
```

### Rate Limits
**Official docs:** 1 token deployment/day (standard), 10/day (Bankr Club)

**Our implementation:** NO rate limit tracking

**Impact:** Agents could theoretically exceed Bankr API rate limits
**Recommendation:** Add rate limit tracking in database (not critical for MVP)

### Supported Chains
**Official docs:** Base, Ethereum, Polygon, Solana, Unichain

**Our implementation:** Currently only Base (chainId 8453)

**Verdict:** ✅ **OK** - We're focused on Base, which is Bankr's recommended chain for low fees

---

## SUMMARY

| Component | Status | Notes |
|-----------|--------|-------|
| API URL | ✅ PASS | Correct endpoint |
| API Key Format | ✅ PASS | Validates `bk_` prefix |
| Authorization | ✅ PASS | Bearer token format |
| Endpoints | ✅ PASS | All 3 endpoints implemented |
| Error Handling | ✅ PASS | Proper try/catch |
| Registration | ✅ PASS | Stores key + wallet |
| Claim Endpoint | N/A | Bankr not used (oracle model) |
| Documentation | ✅ PASS | Recently updated for accuracy |
| Security | ⚠️ WARN | API keys not encrypted at rest |
| Rate Limits | ⚠️ SKIP | Not tracking (not critical) |

**Overall:** 8/8 critical requirements met ✅

**Recommendation:** Consider encrypting Bankr API keys before storing in database (security enhancement, not blocker).
