# AgentBook Registration (World ID)
```yaml
name: agentbook
version: 1.0.0
updated: 2026-03-11
author: InstaClaw
phase: 1  # Registration only. x402 access modes in Phase 2.
triggers:
  keywords: [agentbook, world id, worldcoin, human verification, verified agent, agent registration, proof of humanity]
  phrases: ["register on agentbook", "verify my agent", "world id registration", "am I registered", "check agentbook", "human-backed", "proof of personhood"]
  NOT: [world cup, world news, world war, world record]
```

## MANDATORY RULES — Read Before Anything Else

These rules override everything else in this skill file.

**Rule 1 — Check Status First:** Before any registration attempt, always check current status:
```bash
python3 ~/scripts/agentbook-check.py status --json
```
If already registered, tell the user and show their status. Do NOT re-register.

**Rule 2 — Wallet Retrieval:** The agent's wallet address is NOT stored on disk. Retrieve it at runtime:
```bash
mcporter call clawlancer.get_my_profile
```
Extract `wallet_address` from the response. If null or missing, tell the user they must register on Clawlancer first (`mcporter call clawlancer.register_agent`).

**Rule 3 — Never Inline Registration:** NEVER write inline Python or shell commands to interact with the AgentBook contract directly. ALL registration MUST go through the official `@worldcoin/agentkit-cli`.

**Rule 4 — Human Required:** AgentBook registration requires the human operator to scan a QR code with the World App. The agent CANNOT complete registration alone. Present the QR/link to the user and wait.

---

## What Is AgentBook?

AgentBook is an on-chain registry (Base mainnet) that ties AI agent wallets to verified human operators via World ID. When an agent is registered in AgentBook, any other agent or service can verify on-chain that a real, unique human stands behind that agent.

- **Contract (Base):** `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`
- **Contract (Sepolia):** `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`
- **SDK:** `@worldcoin/agentkit` v0.1.3
- **CLI:** `@worldcoin/agentkit-cli` v0.1.3

## Registration Flow

### Step 1: Check current status
```bash
python3 ~/scripts/agentbook-check.py status --json
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
mcporter call clawlancer.get_my_profile
```

Extract `wallet_address`. If null, the agent needs Clawlancer registration first.

### Step 3: Run registration CLI
```bash
bash ~/scripts/agentbook-register.sh
```

This script:
1. Retrieves the wallet address via MCP
2. Runs `npx @worldcoin/agentkit-cli register --agent` with the wallet
3. Outputs a QR code / World App deep link for the human to scan
4. Waits for the human to complete verification in World App
5. Submits the registration via the gasless relay
6. Reports the registration result back to InstaClaw

### Step 4: Present QR to human
The CLI will output either:
- A QR code in the terminal (for Telegram, send as text)
- A clickable link: `https://worldcoin.org/verify?...`

Tell the user: "Scan this QR code with your World App to verify your agent. This proves a real human operates this agent, without revealing your identity."

### Step 5: Confirm registration
After the human scans, the CLI completes and the check script can verify:
```bash
python3 ~/scripts/agentbook-check.py status --json
```

Should now show `registered: true`.

---

## Commands Reference

| Action | Command |
|--------|---------|
| Check status | `python3 ~/scripts/agentbook-check.py status --json` |
| Register | `bash ~/scripts/agentbook-register.sh` |
| Lookup any agent | `python3 ~/scripts/agentbook-check.py lookup --address 0x... --json` |

---

## Troubleshooting

**"No wallet address found"** — Agent not registered on Clawlancer yet. Run `mcporter call clawlancer.register_agent` first.

**"Already registered"** — The wallet is already in AgentBook. No action needed.

**"World App not responding"** — The human must have World App installed and a verified World ID (Orb level recommended). Device verification also works but provides weaker trust signal.

**"Relay submission failed"** — The gasless relay at `https://x402-worldchain.vercel.app` may be down. Retry in a few minutes. The registration is free — agents pay no gas.
