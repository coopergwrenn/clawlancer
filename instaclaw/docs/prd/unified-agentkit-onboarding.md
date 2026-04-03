# PRD: AgentKit Registration from World Mini App

**Date:** 2026-04-03 (updated from 2026-04-02 draft)
**Author:** Claude (with Cooper)
**Status:** Phase 1 proven E2E — building Phase 2 workaround while waiting on World mobile fix
**Andy Wang (World team):** Confirmed approach, working on inline drawer fix (2-3 weeks)

---

## 1. What We're Doing

Enabling AgentBook (AgentKit) registration from inside the World mini app. Users verify their humanity with World ID and their agent gets registered on-chain in the AgentBook contract on World Chain.

**Current state (proven working 2026-04-03):**
```
User taps "Register now" → CLI generates bridge URL on VM →
User taps "Verify with World ID" → <a href> navigates to bridge URL →
World App drawer appears ("Connect your World ID to AgentKit") →
User taps "Approve" → CLI receives proof → Relay submits to World Chain →
On-chain registration confirmed → User reopens mini app → Badge shows
```

**Problem:** The `<a href>` navigation exits the mini app. User has to manually come back.

**Andy's recommended workaround (ship now):**
```
1. Trigger bridge URL link
2. Close mini app with MiniKit.closeMiniapp()
3. User approves in drawer on World App home
4. Send push notification: "Registration Complete!"
5. User taps notification → mini app reopens → badge shows
```

**Andy's mobile fix (2-3 weeks):** Drawer opens as overlay inside mini app — no navigation away.

## 2. Technical Findings (from 2-day investigation)

### What DOESN'T work from inside a mini app:

| Approach | Result |
|----------|--------|
| `MiniKit.commandsAsync.verify()` | Popup works, but proof bound to OUR app_id. AgentBook contract rejects (ProofInvalid). |
| IDKit v4 native transport with our rp_id | Same — rp_id binds proof to our app_id regardless of app_id param. |
| Direct postMessage to native layer | Native layer ignores per-request app_id in v1 format. |
| `window.location.href = bridgeUrl` | Navigates WebView to worldcoin.org — no drawer triggered. |
| Hidden iframe with bridge URL | Silently blocked — no drawer. |
| `window.open(bridgeUrl)` | WebView prohibits new windows. |
| `worldapp://` deep link scheme | No such scheme exists. |

### What DOES work:

| Approach | Result |
|----------|--------|
| `<a href={bridgeUrl}>` (user tap) | **Works!** World App intercepts the navigation and shows native drawer with correct AgentKit app_id. |
| CLI v0.1.8 → World Chain relay | **Works!** Relay sponsors gas on World Chain. Base gas sponsorship discontinued. |

### Key technical details:

- **AgentKit app_id:** `app_a7c3e2b6b83927251a0db5345bd7146a`
- **Action:** `agentbook-registration`
- **Contract (World Chain):** `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`
- **Contract (Base, legacy):** `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`
- **Relay:** `https://x402-worldchain.vercel.app/register` (World Chain only)
- **CLI:** `@worldcoin/agentkit-cli@latest` (v0.1.8+, targets World Chain by default)
- **Bridge URL format:** `https://worldcoin.org/verify?t=wld&i=<request_id>&k=<key>`
- **Cooper's agent registered on World Chain:** `0x12d9D7aFBEce5eDc2417f30060e4f3EF8BE6f627` ✅

### Why `<a href>` works but nothing else does:

The bridge URL (`worldcoin.org/verify?...`) is intercepted by World App's navigation handler when triggered by a user-initiated link tap. This is similar to iOS Universal Links — but only fires from top-level navigation, not from iframes, JS navigation, or programmatic approaches. World App shows a native drawer with "Connect your World ID to AgentKit" which generates the proof with AgentKit's app_id (not ours).

## 3. Architecture

### Current flow (working, ships as Phase 2 workaround):

```
┌─────────────────────────────────────────────┐
│ Mini App (instaclaw-mini)                   │
│                                             │
│  1. User taps "Register now"                │
│  2. POST /api/proxy/agentbook/              │
│     start-registration                      │
│  3. Poll GET /api/proxy/agentbook/          │
│     get-bridge-url                          │
│  4. Show "Verify with World ID" button      │
│  5. <a href={bridgeUrl}> + closeMiniapp()   │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│ instaclaw.io (backend)                      │
│                                             │
│  start-registration:                        │
│    SSH → VM → npx agentkit-cli@latest       │
│    register <wallet> --auto                 │
│    (setsid, detached, logs to /tmp/)        │
│                                             │
│  get-bridge-url:                            │
│    SSH → VM → cat /tmp/agentbook-           │
│    register.log → regex extract URL         │
│                                             │
│  check-registration:                        │
│    lookupHuman(wallet) on World Chain       │
│    + Base (legacy)                          │
└─────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│ VM (agent's server)                         │
│                                             │
│  agentkit-cli register <wallet> --auto      │
│    1. Read nonce from World Chain contract   │
│    2. Create bridge session (idkit-core)     │
│    3. Output bridge URL to log              │
│    4. Poll bridge for verification          │
│    5. User approves → proof received        │
│    6. Submit to relay (World Chain)          │
│    7. Relay sponsors gas, submits tx        │
│    8. Registration confirmed on-chain       │
└─────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│ Post-registration                           │
│                                             │
│  Option A: Push notification via World API  │
│    POST developer portal notification API   │
│    → wallet address, title, message,        │
│      mini app path, API key                 │
│    → User taps → mini app reopens           │
│                                             │
│  Option B: return_to URL param              │
│    Append to bridge URL → auto-redirect     │
│    back to mini app after approval          │
│    (pending confirmation from Andy)         │
└─────────────────────────────────────────────┘
```

## 4. Phase 2: Ship the Workaround

### Files to change:

| File | Change |
|------|--------|
| `instaclaw-mini/components/agentbook-card.tsx` | Add `closeMiniapp()` after bridge URL tap. Update messaging. |
| `instaclaw/app/api/agentbook/start-registration/route.ts` | Already updated — CLI v0.1.8, World Chain |
| `instaclaw/app/api/agentbook/check-registration/route.ts` | Already updated — checks both chains |
| `instaclaw/lib/agentbook.ts` | Already updated — World Chain support |
| NEW: `instaclaw/app/api/agentbook/notify-complete/route.ts` | Webhook called by CLI script after registration. Sends push notification. |
| `instaclaw/app/api/agentbook/start-registration/route.ts` | Update CLI launcher script to call webhook after success |

### Notification flow:

1. CLI launcher script modified to call webhook after successful registration:
   ```bash
   npx agentkit-cli@latest register <wallet> --auto > /tmp/agentbook-register.log 2>&1
   if grep -q "registered" /tmp/agentbook-register.log; then
     curl -s "https://instaclaw.io/api/agentbook/notify-complete?wallet=<wallet>"
   fi
   ```

2. `notify-complete` endpoint:
   - Looks up user by wallet address
   - Gets user's World App wallet address
   - Calls World Developer Portal notification API:
     ```
     POST https://developer.worldcoin.org/api/v2/minikit/send-notification
     {
       wallet_addresses: [userWalletAddress],
       title: "Agent Registered! ✓",
       message: "Your agent is now verified in AgentBook",
       mini_app_path: "/home",
       api_key: WORLD_NOTIFICATION_API_KEY
     }
     ```
   - Updates DB: `agentbook_registered = true`

3. User taps notification → mini app opens at `/home` → card shows badge

### Card UX (agentbook-card.tsx):

**Before tap:**
```
Register in AgentBook
Prove a real human runs your agent. On-chain, free, one tap.
[Register now]
```

**After "Register now" tapped:**
```
Preparing verification...
(spinner, 10-20 seconds while CLI generates bridge URL)
```

**Bridge URL ready:**
```
Verify with World ID
You'll leave the app briefly to verify. We'll notify you when done.
[Verify with World ID]
```

**After verification tap:**
```
MiniKit.closeMiniapp() called → mini app closes cleanly
World App home → drawer appears → user approves
Notification arrives → user taps → mini app reopens → badge shows
```

## 5. Phase 3: Andy's Mobile Fix (2-3 weeks)

When Andy ships the inline drawer:
- Remove `closeMiniapp()` call
- Remove notification flow
- The `<a href>` will trigger an overlay drawer inside the mini app
- User stays in the mini app the entire time
- After approval, card polls and shows badge immediately

## 6. Open Questions for Andy

1. **return_to:** Can we append `return_to` as a URL query param on the bridge URL? If yes, user auto-redirects back to mini app after approval (no notification needed).

2. **Notification API:** We found the notification panel in the Developer Portal (wallet addresses + title + message + mini app path + API key). Is there a REST API endpoint we can call programmatically? What's the endpoint URL?

## 7. Environment Variables Needed

| Variable | Project | Value |
|----------|---------|-------|
| `NEXT_PUBLIC_MAINTENANCE` | instaclaw-mini | `true` (remove when ready for signups) |
| `NEXT_PUBLIC_AGENTBOOK_NATIVE` | instaclaw-mini | Remove (no longer used) |
| `RP_SIGNING_KEY` | instaclaw-mini | `92b1a2...` (no longer used for AgentBook, still needed for World ID v4) |
| `RP_ID` | instaclaw-mini | `rp_1330...` (same) |
| `WORLD_NOTIFICATION_API_KEY` | instaclaw | TBD — get from Developer Portal API Keys tab |

## 8. Rollout Plan

### Phase 1: Validate ✅ DONE
- [x] Bridge URL flow works from mini app (drawer appears)
- [x] On-chain registration confirmed on World Chain
- [x] CLI v0.1.8 + relay gas sponsorship on World Chain works
- [x] Card shows "Registered in AgentBook" badge after reopening

### Phase 2: Ship Workaround (NOW)
- [ ] Add `closeMiniapp()` to card after bridge URL tap
- [ ] Update card messaging ("You'll leave the app briefly...")
- [ ] Get notification API key from Developer Portal
- [ ] Build notify-complete webhook endpoint
- [ ] Update CLI launcher to call webhook after success
- [ ] Test full flow: register → close → approve → notification → reopen → badge
- [ ] Remove maintenance gate
- [ ] Ship to all users

### Phase 3: Inline Drawer (when Andy ships)
- [ ] Remove closeMiniapp() and notification flow
- [ ] Drawer opens as overlay inside mini app
- [ ] Seamless one-tap registration

## 9. Success Criteria

- [ ] New users can register in AgentBook from the mini app
- [ ] Registration completes on World Chain (gasless via relay)
- [ ] User receives notification after registration
- [ ] Mini app shows "Registered in AgentBook" badge
- [ ] Existing users (already registered) see badge immediately
- [ ] No impact on existing onboarding flow
- [ ] Maintenance gate can be removed safely
