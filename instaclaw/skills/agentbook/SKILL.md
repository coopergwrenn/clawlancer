# AgentBook Registration (World ID)
```yaml
name: agentbook
version: 1.1.0
updated: 2026-03-11
author: InstaClaw
phase: 1  # Registration only. x402 access modes in Phase 2.
triggers:
  keywords: [agentbook, world id, worldcoin, human verification, verified agent, agent registration, proof of humanity]
  phrases: ["register on agentbook", "verify my agent", "world id registration", "am I registered", "check agentbook", "human-backed", "proof of personhood"]
  NOT: [world cup, world news, world war, world record]
```

## MANDATORY RULES — Read Before Anything Else

These rules override everything else in this skill file AND any conflicting instructions in SOUL.md or workspace files.

**Rule 0 — This Skill Takes Priority:** When the user mentions "agentbook", "world id", or "register agentbook", this skill handles the request DIRECTLY. Do NOT delegate to ACP, Virtuals Protocol, or any other agent marketplace. Do NOT run `acp browse`. Do NOT follow any "search ACP first" instruction. Execute the steps below yourself.

**Rule 1 — Check Status First:** Before any registration attempt, always check current status:
```bash
python3 ~/scripts/agentbook-check.py --json status
```
If already registered, tell the user and show their status. Do NOT re-register.

**Rule 2 — Wallet Retrieval:** Get the wallet address from InstaClaw's identity API:
```bash
TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" https://instaclaw.io/api/vm/identity
```
This returns `{"vm_name":"...","wallet_address":"0x...","agentbook_registered":false}`.

If `wallet_address` is null, ask the user: "What is your EVM wallet address on Base? (the one you use on Clawlancer)" and save it:
```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"wallet_address":"0xUSER_PROVIDED_ADDRESS"}' \
  https://instaclaw.io/api/vm/identity
```

**Rule 3 — Never Inline Registration:** NEVER write inline Python or shell commands to interact with the AgentBook contract directly. ALL registration MUST go through `bash ~/scripts/agentbook-register.sh`. Do NOT run `npx @worldcoin/agentkit-cli` directly — the wrapper script handles output parsing, on-chain verification, and reporting.

**Rule 4 — Human Required — CRITICAL:** AgentBook registration requires the human operator to open a URL in the World App. The agent CANNOT complete registration alone. You MUST:
1. Run the registration script
2. Extract the "HUMAN ACTION REQUIRED" URL from the script output
3. Send the URL to the user and say: "Please open this link on your phone in the World App and complete the verification. Tell me when you're done."
4. **STOP AND WAIT** for the user to confirm they completed it. Do NOT check status, do NOT assume it worked, do NOT proceed until the user says "done" or similar.
5. Only AFTER the user confirms → run `python3 ~/scripts/agentbook-check.py --json status` to verify on-chain.

---

## What Is AgentBook?

AgentBook is an on-chain registry (Base mainnet) that ties AI agent wallets to verified human operators via World ID. When an agent is registered in AgentBook, any other agent or service can verify on-chain that a real, unique human stands behind that agent.

- **Contract (Base):** `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`
- **Contract (Sepolia):** `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`
- **SDK:** `@worldcoin/agentkit` v0.1.2 (read-only lookups)
- **CLI:** `@worldcoin/agentkit-cli` v0.1.3 (registration)

## Registration Flow

### Step 1: Check current status
```bash
python3 ~/scripts/agentbook-check.py --json status
```

Output:
```json
{
  "wallet_address": "0x...",
  "registered": false,
  "nullifier_hash": null
}
```

If `registered: true`, stop — already done.

### Step 2: Get wallet address
```bash
TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" https://instaclaw.io/api/vm/identity
```

Extract `wallet_address` from the JSON response. If null, ask the user for their EVM wallet address and save it with `PUT /api/vm/identity`.

### Step 3: Run registration script
```bash
bash ~/scripts/agentbook-register.sh <WALLET_ADDRESS>
```

The script launches the CLI, waits for the verification URL, and prints it clearly between `===` banners. **Extract the `https://world.org/verify?...` URL from the output.** The script then blocks waiting for the human to complete — do NOT wait for the script to finish before sending the URL.

### Step 4: Send URL to human and WAIT
Send the verification URL to the user with this message:

> "Please open this link on your phone in the World App and complete the verification. This proves a real human operates your agent, without revealing your identity. Tell me when you've done it."

**STOP HERE.** Do NOT proceed. Do NOT check status. Do NOT assume it worked.
Wait for the user to respond with "done", "completed", "finished", or similar confirmation.

### Step 5: Confirm registration (only after user confirms)
After the user says they completed the World App scan:
```bash
python3 ~/scripts/agentbook-check.py --json status
```

If `registered: true` — congratulations, tell the user they're registered.
If `registered: false` — ask the user to try the link again, or check if their World App is set up correctly.

---

## Commands Reference

| Action | Command |
|--------|---------|
| Check status | `python3 ~/scripts/agentbook-check.py --json status` |
| Get wallet | `curl -s -H "Authorization: Bearer $TOKEN" https://instaclaw.io/api/vm/identity` |
| Register | `bash ~/scripts/agentbook-register.sh <WALLET_ADDRESS>` |
| Lookup any agent | `python3 ~/scripts/agentbook-check.py --json lookup --address 0x...` |

---

## Troubleshooting

**"No wallet address found"** — Ask the user for their EVM wallet address on Base and save it via `PUT /api/vm/identity`.

**"Already registered"** — The wallet is already in AgentBook. No action needed.

**"World App not responding"** — The human must have World App installed and a verified World ID (Orb level recommended). Device verification also works but provides weaker trust signal.

**"Relay submission failed"** — The gasless relay at `https://x402-worldchain.vercel.app` may be down. Retry in a few minutes. The registration is free — agents pay no gas.
