# Cloud-Init Implementation Map

**Author:** Claude (Opus 4.7, 1M context) for Cooper Wrenn
**Date:** 2026-05-12
**Status:** Pre-implementation gate per `docs/on-demand-provisioning-2026-05-12.md` §1.0.1. Zero lines of `lib/cloud-init-userdata.ts` are written until this map is reviewed and approved.
**Standard:** A VM produced by cloud-init must be **byte-for-byte identical** in its functional state to a VM produced by `configureOpenClaw()` in `lib/ssh.ts`. Same files, same permissions, same config keys, same cron jobs, same running processes, same gateway health response. If you SSH into both VMs and diff their filesystems, the only differences should be timestamps.

**Source of truth read:** `lib/ssh.ts:4834-7651` (configureOpenClaw, 2,817 lines, read line-by-line in chunks 4834-5333, 5334-5833, 5834-6333, 6334-7099, 7100-7651) + `lib/vm-manifest.ts:1127-2026` (VM_MANIFEST data sections) + `lib/ssh.ts:4303-4534` (buildOpenClawConfig). Plus two Explore-agent deep maps for skills/ inventory and reconciler step categorization.

**How to read this document:** Each item is a card with consistent fields. Implementation = walk every section, produce the bash equivalent in `buildCloudInitUserdata()`, mark off the checklist in §16 as you go.

---

## §0. Function signature for `createUserVM` and `buildCloudInitUserdata`

`createUserVM(userId)` collects all inputs server-side, then calls `buildCloudInitUserdata(params)` to produce the bash script that runs at first boot.

### Required `params` object (from various DB rows + Vercel env vars):

| Field | Source | Notes |
|---|---|---|
| `userId` | UUID | `instaclaw_users.id` |
| `vmName` | string | `instaclaw-vm-<short-userId>` or UUID-derived (Q3 in PRD) |
| `gatewayToken` | randomBytes(32).toString("hex") | NEW token per VM, written to DB + userdata. `lib/ssh.ts:4932-4958` |
| `callbackToken` | randomBytes(32).toString("hex") | ONE-TIME-USE nonce for `/api/vm/cloud-init-callback`, distinct from gatewayToken (PRD §5.3.1) |
| `agentbookKey` | randomBytes(32).toString("hex") | Generated SERVER-SIDE via viem `privateKeyToAccount`; address goes to DB, key goes to VM via userdata (`lib/ssh.ts:7410-7425`). Cloud-init writes the key file. |
| `agentbookAddress` | privateKeyToAccount(`0x${agentbookKey}`).address | EIP-55 checksummed |
| `apiMode` | `"all_inclusive" \| "byok"` | From `instaclaw_pending_users` or `instaclaw_subscriptions`. Default `"all_inclusive"`. |
| `apiKey` | string \| undefined | BYOK only; decrypted from `instaclaw_pending_users.api_key` |
| `tier` | `"free_starter" \| "pro" \| "power" \| "byok"` | From subscription |
| `model` | string | Default `"claude-sonnet-4-6"`. Anti-haiku guard at `lib/ssh.ts:4991-4998` and `lib/configure/route.ts:210-215`. **MUST replicate guard** in cloud-init build. |
| `openclawModel` | from `toOpenClawModel(model)` | Format `"anthropic/claude-sonnet-4-6"` |
| `channels` | `string[]` | Default `["telegram"]`; may include `"discord"`, `"slack"`, `"whatsapp"` (preserved from existing VM record). |
| `telegramBotToken` | string \| undefined | From `instaclaw_pending_users.telegram_bot_token` |
| `telegramBotUsername` | string \| undefined | e.g., `"MyAgentBot"` (no `@` prefix in canonical form) |
| `discordBotToken` | string \| undefined | From pending or VM record |
| `partner` | `"edge_city" \| "consensus_2026" \| null` | From `instaclaw_users.partner` |
| `bankrApiKey` | string \| undefined | Decrypted from `instaclaw_vms.bankr_api_key_encrypted` |
| `bankrEvmAddress` | string \| undefined | From `provisionBankrWallet` (called BEFORE buildCloudInitUserdata) |
| `bankrTokenAddress` | string \| undefined | If user has launched a token |
| `bankrTokenSymbol` | string \| undefined | If user has launched a token |
| `bankrTokenName` | string \| undefined | If user has launched a token |
| `worldIdNullifier` | string \| undefined | From `instaclaw_users.world_id_nullifier_hash` if `world_id_verified=true` |
| `worldIdLevel` | string | Default `"orb"` |
| `gmailProfileSummary` | string \| undefined | From `instaclaw_users.gmail_profile_summary` |
| `gmailInsights` | string[] | From `instaclaw_users.gmail_insights` |
| `userName` | string | From `instaclaw_users.name` |
| `userEmail` | string | From `instaclaw_users.email` |
| `userTimezone` | string | Default `"America/New_York"` |
| `vmRegion` | string | From Linode metadata or hardcoded `"us-east"` |
| `vmIpAddress` | string | Set after Linode createServer returns; used for cloud-init-callback URL |
| `elevenlabsApiKey` | string \| undefined | `process.env.ELEVENLABS_API_KEY` (platform-wide) OR per-user override |
| `openaiApiKey` | string | `process.env.OPENAI_API_KEY` (platform-wide). Used in auth-profiles.json AND .env |
| `resendApiKey` | string | `process.env.RESEND_API_KEY` |
| `alphavantageApiKey` | string | `process.env.ALPHAVANTAGE_API_KEY` |
| `braveApiKey` | string | `process.env.BRAVE_SEARCH_API_KEY` |
| `edgeosBearerToken` | string | `process.env.EDGEOS_BEARER_TOKEN` (partner=edge_city only) |
| `solaAuthToken` | string | `process.env.SOLA_AUTH_TOKEN` (partner=edge_city only) |
| `nextauthUrl` | string | `process.env.NEXTAUTH_URL` — needed for the cloud-init-callback URL |

**Total surface:** 31 per-user/per-VM fields + 8 platform env vars passed through.

---

## §1. Boot order (dependency graph)

Cloud-init executes top to bottom in a single bash process. The order is constrained by these dependencies:

```
1. System personalization (SSH host keys, machine-id, deploy keys, fail2ban)
   ↓
2. Mkdir all ~/.openclaw subdirs (defensive — prevents "No such file or directory" later)
   ↓
3. Privacy wipe (rm -rf old user state — defense in depth)
   ↓
4. Stop any existing gateway (pkill, systemctl --user stop)
   ↓
5. Write static config files (openclaw.json, auth-profiles.json, exec-approvals.json, .openclaw-pinned-version)
   ↓
6. Write .env entries (GATEWAY_TOKEN, POLYGON_RPC_URL, AGENT_REGION, CLOB_PROXY_URL, INSTACLAW_MUAPI_PROXY, then per-user Bankr/Edge/World/API keys)
   ↓
7. Clone external skills (Bankr, Edge if partner, Consensus universal) + skill overlays
   ↓
8. Install @bankr/cli (pinned version, npm global)
   ↓
9. Write workspace files (HEARTBEAT.md, WALLET.md, SOUL.md, CAPABILITIES.md, QUICK-REFERENCE.md, TOOLS.md, EARN.md, BOOTSTRAP.md, MEMORY.md, IDENTITY.md, USER.md, WORLD_ID.md if applicable, generate_workspace_index.sh)
   ↓
10. Write all session-protection scripts (strip-thinking.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, auto-approve-pairing.py, skill-integrity-check.sh, memory-snapshot.sh, ack-watchdog.py, deliver_file.sh, notify_user.sh, token-price.py, consensus_match_*.py, consensus_intent_*.py)
   ↓
11. Deploy inline skills (Dispatch scripts, Browser-Relay server, Voice, Email, Finance, Intel, Social, E-com, Motion Graphics, Brand, Web Search, Code Exec, Sjinn, Marketplace, Prediction Markets, Language Teacher, Solana DeFi [.disabled], Higgsfield, X-Twitter, AgentBook)
   ↓
12. Write AgentBook wallet private key file (~/.openclaw/wallet/agent.key, mode 600)
   ↓
13. Install manifest cron jobs (idempotent, marker-based — 8 entries from VM_MANIFEST.cronJobs)
   ↓
14. Re-deploy critical cron script files (defense in depth — already in step 10 but loop guarantees from manifest)
   ↓
15. Install daily skill-update check cron
   ↓
16. mcporter clawlancer config + Clawlancer SKILL.md install
   ↓
17. apt install system packages (ffmpeg, jq, build-essential, xvfb, openbox, imagemagick, x11vnc, websockify, novnc, socat, netcat-openbsd, xdotool, libx11-dev, libxext-dev, libxtst-dev, libpng-dev)
   ↓
18. PARALLEL block: pip bootstrap → 5 parallel installs (Remotion npm, Crawlee pip, polymarket/web3 pip, solana pip, agentkit-cli npm) → wait
   ↓
19. Reinstall openclaw if module broken (idempotent check — `which openclaw || node -e "require('openclaw')"`)
   ↓
20. openclaw doctor (advisory validation — non-blocking)
   ↓
21. Xvfb systemd service create + start (display :99)
   ↓
22. openbox window manager start (DISPLAY=:99)
   ↓
23. x11vnc systemd service + websockify systemd service create + start
   ↓
24. Caddy VNC proxy (sed /vnc/* into Caddyfile, reload)
   ↓
25. dispatch-server systemd user service create + enable + start
   ↓
26. browser-relay-server systemd user service create + enable + restart
   ↓
27. Stop and disable gateway-watchdog.timer (DISABLED per v69)
   ↓
28. `openclaw gateway install` (creates the systemd user service)
   ↓
29. Write/patch openclaw-gateway.service.d/override.conf (KillMode, Delegate, MemoryMax, TasksMax, etc.)
   ↓
30. Patch main unit file (telegram-pre-start.sh ExecStartPre, etc.)
   ↓
31. systemctl --user daemon-reload
   ↓
32. systemctl --user start openclaw-gateway (with nohup fallback if systemd not available)
   ↓
33. Health-check poll (curl localhost:18789/health, 6 attempts × 1s)
   ↓
34. Auto-approve device pairing (openclaw gateway health to trigger, then python script on pending.json)
   ↓
35. Final gateway verification (3 × 3s polls of /health)
   ↓
36. Rollback path: if NOT verified AND last-known-good config exists, restore + restart + recheck
   ↓
37. Emit sentinels: GATEWAY_VERIFIED / GATEWAY_NOT_RESPONDING / GATEWAY_ROLLBACK_TRIGGERED + GATEWAY_ROLLBACK_RECOVERED|FAILED + OPENCLAW_CONFIGURE_DONE
   ↓
38. POST to /api/vm/cloud-init-callback with callbackToken (one-time-use) + healthStatus + agentbookAddress
   ↓
39. Truncate cloud-init logs + userdata file at rest (security hygiene per PRD §5.3.1)
   ↓
40. Exit
```

**Critical order constraints:**

- **Step 5 (write openclaw.json) MUST precede Step 32 (gateway start).** Gateway reads openclaw.json at startup; missing or malformed file = crash.
- **Step 5 also MUST write auth-profiles.json BEFORE gateway start.** Anthropic SDK reads `profiles.anthropic:default.key` for outbound API calls. Per `MEMORY.md → InstaClaw — OpenClaw Gateway Token Architecture`: "auth-profiles.json is THE critical file."
- **Step 9 (WALLET.md, MEMORY.md, BOOTSTRAP.md, USER.md, IDENTITY.md, SOUL.md) MUST precede Step 32.** Gateway reads workspace files at startup to build the upfront context. Missing files = blank-identity bug we shipped Rule 9 + Rule 11 to fix.
- **Step 7 (skill clones) MUST precede Step 32.** Skills are read at gateway startup for the prompt. Missing = silent feature drop (Rule 24).
- **Step 17 (apt install system packages) SHOULD precede Step 18.** Some pip deps (cryptography, solders) require gcc — build-essential MUST be installed first.
- **Step 28 (`openclaw gateway install`) MUST precede Step 29 (override.conf).** The override.conf path is `~/.config/systemd/user/openclaw-gateway.service.d/override.conf`; the service file must exist for the override directory to be honored.
- **Step 32 (gateway start) MUST precede Step 33 (health check) MUST precede Step 38 (callback).** Obviously, but the failure modes are silent if reordered.
- **Step 34 (device pairing) MUST happen AFTER the final gateway start.** A restart invalidates pairings — `lib/ssh.ts:7222-7223` says "Do NOT restart the gateway after pairing — restarts invalidate pairings."

---

## §2. Per-VM file inventory — workspace files

Every file written under `~/.openclaw/workspace/` and adjacent directories. **Owner: `openclaw:openclaw`. Permissions: 644 unless noted. Created via base64-decode pipe.**

### §2.1 SOUL.md — agent personality + routing

- **Path:** `~/.openclaw/workspace/SOUL.md`
- **Source:** Constructed at runtime via concatenation:
  ```
  WORKSPACE_SOUL_MD                            (from lib/ssh.ts WORKSPACE_SOUL_MD constant, ~17 KB)
  + SOUL_MD_INTELLIGENCE_SUPPLEMENT            (lib/agent-intelligence.ts:328, 8,743 bytes)
  + SOUL_MD_LEARNED_PREFERENCES                (lib/agent-intelligence.ts:821, 534 bytes)
  + "\n\n"
  + SOUL_MD_OPERATING_PRINCIPLES               (lib/agent-intelligence.ts:849, 1,158 bytes)
  + SOUL_MD_MEMORY_FILING_SYSTEM               (lib/agent-intelligence.ts:903, 2,680 bytes)
  + (partner === "edge_city" ? SOUL_STUB_EDGE)           (lib/partner-content.ts)
  + (partner ∈ {"edge_city","consensus_2026"} ? SOUL_STUB_CONSENSUS)
  ```
- **Per-user:** Yes (partner stubs vary). DegenClaw section is NOT appended per v90+ (uses `~/.openclaw/skills/dgclaw/SKILL.md` on demand).
- **Mode:** Overwrite (every configure run).
- **Source lines:** `lib/ssh.ts:5631-5664`
- **Total size budget:** Must stay under `BOOTSTRAP_MAX_CHARS` (40,000 — `lib/ssh.ts:432`). Per `MEMORY.md` v92 emergency.
- **Reconciler verifies:** Yes, via `stepFiles` + the partner-stub rewrite step `stepRewriteSoulPartnerSections` (lines 4965-5212 of vm-reconcile.ts) — but only for legacy long-section VMs. Fresh VMs from cloud-init using stubs need NO rewrite.
- **What breaks if missing:** Agent has no name, no identity, no routing knowledge. Returns generic "I'm an AI assistant." Doesn't know how to delegate to skills. Catastrophic.

### §2.2 CAPABILITIES.md

- **Path:** `~/.openclaw/workspace/CAPABILITIES.md`
- **Source:** `WORKSPACE_CAPABILITIES_MD` constant (lib/agent-intelligence.ts:476, **15,744 bytes**).
- **Per-user:** No, static.
- **Mode:** Overwrite (platform-controlled).
- **Source line:** `lib/ssh.ts:5667`.
- **Reconciler verifies:** Yes, via `stepFiles` (manifest entry line 1374-1379, mode `overwrite`).
- **What breaks if missing:** Agent doesn't know what tools/skills are available. Hallucinates capabilities.

### §2.3 QUICK-REFERENCE.md

- **Path:** `~/.openclaw/workspace/QUICK-REFERENCE.md`
- **Source:** `WORKSPACE_QUICK_REFERENCE_MD` (lib/agent-intelligence.ts:725, 2,028 bytes).
- **Per-user:** No.
- **Mode:** Overwrite.
- **Source line:** `lib/ssh.ts:5668`.
- **What breaks if missing:** Common tasks have less context. Minor degradation.

### §2.4 TOOLS.md

- **Path:** `~/.openclaw/workspace/TOOLS.md`
- **Source:** `WORKSPACE_TOOLS_MD_TEMPLATE` (lib/agent-intelligence.ts:764, 690 bytes — empty template).
- **Per-user:** No, but agent-editable.
- **Mode:** `create_if_missing`. Cloud-init must use `test -f X || echo $B64 | base64 -d > X` pattern.
- **Source line:** `lib/ssh.ts:5669`.
- **What breaks if missing:** Agent has no persistent tool notes. Minor.

### §2.5 EARN.md

- **Path:** `~/.openclaw/workspace/EARN.md`
- **Source:** `WORKSPACE_EARN_MD` (lib/earn-md-template.ts, 10,501 bytes).
- **Per-user:** No.
- **Mode:** `create_if_missing`.
- **Source line:** `lib/ssh.ts:5672` — exact pattern: `test -f "${workspaceDir}/EARN.md" || echo '${earnB64}' | base64 -d > "${workspaceDir}/EARN.md"`.
- **What breaks if missing:** Agent doesn't know about Bankr token launches, agent marketplace, ambassador earnings. User loses earning paths.

### §2.6 MEMORY.md

- **Path:** `~/.openclaw/workspace/MEMORY.md`
- **Source:** Per-user IF Gmail connected → write `config.gmailProfileSummary` directly. Otherwise → 5-line template (`lib/ssh.ts:5818-5826`).
- **Template content (no Gmail):**
  ```
  # MEMORY.md - Long-Term Memory

  _Start capturing what matters here. Decisions, context, things to remember._

  ---
  ```
- **Mode:** `create_if_missing`.
- **Source lines:** `lib/ssh.ts:5790-5829` (Gmail branch) + `5818-5829` (no-Gmail belt-and-suspenders).
- **Also written to:** `~/.openclaw/agents/main/agent/MEMORY.md` (backup mirror — line 5796).
- **What breaks if missing:** No long-term memory. Doug Rathell, Ibrahim, etc. incidents. Catastrophic.

### §2.7 BOOTSTRAP.md

- **Path:** `~/.openclaw/workspace/BOOTSTRAP.md`
- **Source:**
  - If `config.gmailProfileSummary` → `buildPersonalizedBootstrap(profileContent)` (lib/ssh.ts:4221).
  - Else → `WORKSPACE_BOOTSTRAP_SHORT` (lib/ssh.ts:4160).
- **Mode:** Overwrite (`lib/ssh.ts:5790, 5807`).
- **Source lines:** `lib/ssh.ts:5778-5813`.
- **What breaks if missing:** Agent has no first-run instructions. Cooper, who started fresh, would have no idea what to do. Catastrophic.

### §2.8 USER.md

- **Path:** `~/.openclaw/workspace/USER.md`
- **Source:**
  - If `config.gmailProfileSummary` → `buildUserMd(profileContent)` (lib/ssh.ts).
  - Else → constructed from `config.userName`, `userEmail`, `userTimezone` (lib/ssh.ts:5874-5900).
- **Per-user:** YES, every field per-user.
- **Mode:** Overwrite IF Gmail wasn't already written.
- **Source lines:** `lib/ssh.ts:5778-5798` (Gmail branch) + `lib/ssh.ts:5874-5900` (DB branch).
- **What breaks if missing:** Agent doesn't know user's name. Calls user "you" or hallucinates name. User-facing.

### §2.9 IDENTITY.md

- **Path:** `~/.openclaw/workspace/IDENTITY.md`
- **Source:** Constructed from `config.telegramBotUsername` → `agentName` (regex: strip `@` and `_bot` and trailing digits, lib/ssh.ts:5838-5842) + boilerplate.
- **Template:**
  ```
  # IDENTITY.md - Who Am I?

  - **Name:** ${agentName}
  - **Creature:** AI agent — resourceful, capable, always learning
  - **Vibe:** Direct, helpful, genuine. Gets things done.
  - **Telegram:** @${botUsername.replace(/^@/, "")}

  ---

  You are ${agentName}. That's your name.
  When someone asks who you are, you say "I'm ${agentName}" — not "I'm an AI assistant."
  You're a personal AI agent on InstaClaw.

  _Update this file as your personality develops. Make it yours._
  ```
- **Mode:** Overwrite (every configure run).
- **Source lines:** `lib/ssh.ts:5848-5871`.
- **Per-user:** YES.
- **What breaks if missing:** 42/50 VMs in March 2026 had identity crisis. Agent says "I'm not [name]". User confusion. **Cloud-init MUST emit this.**

### §2.10 WALLET.md

- **Path:** `~/.openclaw/workspace/WALLET.md`
- **Source:** Constructed per `lib/ssh.ts:5520-5588` with conditional sections:
  - Bankr wallet section (if `config.bankrEvmAddress`)
  - Token section (if `bankrTokenAddress` and `bankrTokenSymbol`)
  - Generic placeholder otherwise
- **Mode:** Overwrite.
- **Per-user:** YES.
- **Source lines:** `lib/ssh.ts:5519-5588`.
- **What breaks if missing:** Agent doesn't know about its Bankr wallet. Can't reference wallet address. Token Q&A broken.

### §2.11 WORLD_ID.md (conditional)

- **Path:** `~/.openclaw/workspace/WORLD_ID.md`
- **Source:** Built only if `config.worldIdNullifier` is set. Template at `lib/ssh.ts:5347-5363`.
- **Per-user:** YES, conditional.
- **Mode:** Overwrite.
- **What breaks if missing:** Verified humans lose their identity proof. Future Cloudflare bypass features broken.

### §2.12 memory/session-log.md + memory/active-tasks.md

- **Paths:** `~/.openclaw/workspace/memory/session-log.md`, `~/.openclaw/workspace/memory/active-tasks.md`
- **Source:** Inline minimal templates from manifest (`lib/vm-manifest.ts:1407-1417`):
  - `session-log.md`: `"# Session Log\n\n_Session summaries are appended here automatically._\n"`
  - `active-tasks.md`: `"# Active Tasks\n\n_Tasks are tracked here automatically._\n"`
- **Mode:** `create_if_missing`.
- **Cloud-init MUST `mkdir -p $HOME/.openclaw/workspace/memory` first.**
- **What breaks if missing:** Cross-session memory hook can't write. Per Rule 23: 84%/97% of fleet had empty files; reconciler now ensures presence.

### §2.13 HEARTBEAT.md (NOT in workspace — in agent dir)

- **Path:** `~/.openclaw/agents/main/agent/HEARTBEAT.md`
- **Source:** Inline heredoc (`lib/ssh.ts:5390-5481`, ~90 lines of agent instructions).
- **Mode:** Overwrite.
- **Per-user:** No.
- **What breaks if missing:** Agent doesn't know how to run its 3-hourly heartbeat cycle. No proactive work, no daily check-ins.

### §2.14 system-prompt.md

- **Path:** `~/.openclaw/agents/main/agent/system-prompt.md`
- **Source:** Built via `buildSystemPrompt(gmailProfileSummary)` (lib/ssh.ts).
- **Mode:** Overwrite.
- **Per-user:** YES (Gmail-personalized vs generic).
- **Source lines:** `lib/ssh.ts:5785, 5795, 5803, 5810`.
- **What breaks if missing:** Gateway has no system prompt → agent uses default Anthropic system prompt → no skills, no identity, no anything.

---

## §3. Per-VM file inventory — config files (single source of truth)

### §3.1 openclaw.json (THE config file)

- **Path:** `~/.openclaw/openclaw.json`
- **Permissions:** 600 (`chmod 600`).
- **Source:** `buildOpenClawConfig(config, gatewayToken, proxyBaseUrl, openclawModel, braveKey)` at `lib/ssh.ts:4303-4534`. Returns an object with the following keys (full structure):

```json
{
  "wizard": { "lastRunAt": "<ISO>", "lastRunVersion": "<OPENCLAW_PINNED_VERSION>", "lastRunCommand": "onboard", "lastRunMode": "local" },
  "browser": {
    "executablePath": "/usr/local/bin/chromium-browser",
    "headless": true,
    "noSandbox": true,
    "defaultProfile": "openclaw",
    "profiles": { "openclaw": { "cdpPort": 18800, "color": "#FF4500" } }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "<openclawModel>", "fallbacks": ["anthropic/claude-haiku-4-5-20251001"] },
      "bootstrapMaxChars": 40000,
      "heartbeat": { "every": "3h", "session": "heartbeat" },
      "compaction": {
        "reserveTokensFloor": 35000,
        "memoryFlush": { "enabled": true, "softThresholdTokens": 8000 },
        "mode": "safeguard",
        "maxActiveTranscriptBytes": 150000,
        "recentTurnsPreserve": 10,
        "qualityGuard": { "enabled": true, "maxRetries": 2 },
        "notifyUser": true,
        "truncateAfterCompaction": true
      },
      "memorySearch": { "enabled": true },
      "sandbox": { "mode": "off" }
    }
  },
  "session": {
    "reset": { "mode": "idle", "idleMinutes": 10080 },
    "maintenance": { "mode": "enforce" }
  },
  "messages": {},
  "commands": { "restart": true, "useAccessGroups": false },
  "channels": {  /* conditional — see below */  },
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "lan",
    "controlUi": { "dangerouslyAllowHostHeaderOriginFallback": true },
    "auth": { "mode": "token", "token": "<gatewayToken>" },
    "trustedProxies": ["127.0.0.1", "::1"],
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "models": {
    "providers": {
      "anthropic": <proxyBaseUrl ? { "baseUrl": "<proxyBaseUrl>", "api": "anthropic-messages", "models": [] } : {}>
    }
  },
  "skills": {
    "load": { "extraDirs": ["/home/openclaw/.openclaw/skills"] },
    "limits": { "maxSkillsPromptChars": 500000 }
  },
  "plugins": { "entries": {  /* conditional */  } },
  "tools": {
    /* if braveKey: */
    "web": { "search": { "provider": "brave", "timeoutSeconds": 30 } },
    "media": {
      "image": { "enabled": true, "timeoutSeconds": 120 },
      "audio": { "enabled": true, "timeoutSeconds": 120 },
      "video": { "enabled": true, "timeoutSeconds": 120 }
    },
    "links": { "timeoutSeconds": 30 },
    "exec": { "security": "full", "ask": "off" }
  }
}
```

**Conditional channel entries (`channels.telegram`, `channels.discord`):**

If `channels.includes("telegram") && telegramBotToken`:
```json
"telegram": {
  "botToken": "<config.telegramBotToken>",
  "allowFrom": ["*"],
  "dmPolicy": "open",
  "groupPolicy": "open",
  "groups": { "*": { "requireMention": false } },
  "streaming": "partial"
}
```
And `plugins.entries.telegram = { enabled: true }`.

If `channels.includes("discord") && discordBotToken`:
```json
"discord": { "botToken": "<config.discordBotToken>", "allowFrom": ["*"] }
```
And `plugins.entries.discord = { enabled: true }`.

If `braveKey`:
```json
"plugins.entries.brave": {
  "enabled": true,
  "config": { "webSearch": { "apiKey": "<braveKey>" } }
}
```

**Critical:** `streaming: "partial"` here. This is `openclaw.json`-level. The reconciler's `configSettings` ALSO sets:
- `channels.telegram.streaming.mode = "partial"` (v95)
- `channels.telegram.streaming.preview.toolProgress = "false"` (v95 — load-bearing v68 leak guard)
- `channels.telegram.streaming.preview.chunk.minChars = "30"`
- `channels.telegram.streaming.preview.chunk.maxChars = "800"`
- `channels.telegram.streaming.preview.chunk.breakPreference = "sentence"`

**Cloud-init MUST write the openclaw.json with EXACTLY this structure** OR set the streaming.* keys via `openclaw config set` after writing the base config. The first option is preferred (atomic, no SSH round-trip).

- **Source lines:** `lib/ssh.ts:4303-4534`.
- **What breaks if missing/malformed:** Gateway crashes on startup with schema validation error. /health never returns 200. Catastrophic.

### §3.2 auth-profiles.json

- **Path:** `~/.openclaw/agents/main/agent/auth-profiles.json`
- **Source:** Built inline at `lib/ssh.ts:5093-5123`:
  ```json
  {
    "profiles": {
      "anthropic:default": {
        "type": "api_key",
        "provider": "anthropic",
        "key": "<apiKey>",
        "baseUrl": "<proxyBaseUrl if all-inclusive, omitted if BYOK>"
      },
      "openai:default": {
        "type": "api_key",
        "provider": "openai",
        "key": "<process.env.OPENAI_API_KEY>"
      }
    }
  }
  ```
- **Per-user:** YES. `apiKey` is the gatewayToken (all-inclusive) OR the user's decrypted Anthropic key (BYOK).
- **Mode:** Overwrite.
- **Permissions:** 600 (implicit — same writer as openclaw.json).
- **Cloud-init MUST `mkdir -p ~/.openclaw/agents/main/agent` first.**
- **What breaks if missing:** Anthropic SDK has no API key. ALL outbound LLM calls fail. Agent is completely dead.

### §3.3 exec-approvals.json

- **Path:** `~/.openclaw/exec-approvals.json`
- **Source:** Hardcoded (`lib/ssh.ts:5128-5132`):
  ```json
  { "version": 1, "defaults": { "security": "full", "ask": "off", "askFallback": "full" }, "agents": {} }
  ```
- **Per-user:** No.
- **Mode:** Overwrite (per VM_MANIFEST.files line 1362-1371).
- **Source lines:** `lib/ssh.ts:5125-5138`.
- **What breaks if missing:** Gateway approval daemon rejects all exec commands. Agent says "exec approvals not enabled." 168/170 VMs had this issue (Doug Rathell ticket) — must NEVER recur.

### §3.4 .openclaw-pinned-version

- **Path:** `~/.openclaw/.openclaw-pinned-version`
- **Source:** Contents of `OPENCLAW_PINNED_VERSION` constant (currently `"2026.4.26"`, lib/ssh.ts:121).
- **Mode:** Overwrite.
- **Source line:** `lib/ssh.ts:5142`.
- **What breaks if missing:** vm-watchdog has no reference point to auto-revert unauthorized upgrades. Soft issue (not catastrophic).

### §3.5 .env (the environment variables file)

- **Path:** `~/.openclaw/.env`
- **Permissions:** 600.
- **Mode:** Sed-update if key exists, echo-append if not (the canonical `grep -q && sed -i ... || echo` pattern).
- **Per-user:** YES, many fields.

#### Keys cloud-init MUST write (in this order):

| Key | Value | Source | Conditional |
|---|---|---|---|
| `GATEWAY_TOKEN` | `<config.gatewayToken>` | per-VM generated | always |
| `POLYGON_RPC_URL` | `"https://polygon-bor-rpc.publicnode.com"` | default; `VM_MANIFEST.envVarDefaults.POLYGON_RPC_URL` is currently `"https://1rpc.io/matic"` BUT `lib/ssh.ts:5161` writes `https://polygon-bor-rpc.publicnode.com`. **CLARIFY:** which is canonical? Cloud-init should write the ssh.ts value (`polygon-bor-rpc.publicnode.com`) since that's what fresh VMs land with. Reconciler will re-sync from manifest on next cycle. | always |
| `AGENT_REGION` | `<vm.region>` (e.g., `"us-east"`) | from VM metadata | always |
| `CLOB_PROXY_URL` | `"http://172.105.22.90:8080"` | US-region only | conditional on `region.startsWith("us-") \|\| region.startsWith("nyc")` |
| `INSTACLAW_MUAPI_PROXY` | `"https://instaclaw.io"` | always | always |
| `BANKR_API_KEY` | `<config.bankrApiKey>` | per-user | if `bankrApiKey && bankrEvmAddress` |
| `BANKR_WALLET_ADDRESS` | `<config.bankrEvmAddress>` | per-user | if `bankrApiKey && bankrEvmAddress` |
| `BANKR_TOKEN_ADDRESS` | `<config.bankrTokenAddress>` | per-user | if `bankrTokenAddress && bankrTokenSymbol` |
| `BANKR_TOKEN_SYMBOL` | `<config.bankrTokenSymbol>` | per-user | if `bankrTokenAddress && bankrTokenSymbol` |
| `WORLD_ID_NULLIFIER` | `<config.worldIdNullifier>` | per-user | if `config.worldIdNullifier` |
| `WORLD_ID_LEVEL` | `<config.worldIdLevel ?? "orb">` | per-user | if `config.worldIdNullifier` |
| `EDGEOS_BEARER_TOKEN` | `<edgeosToken \|\| "PLACEHOLDER_WAITING_ON_TULE">` | platform env | only when `partner === "edge_city"` |
| `SOLA_AUTH_TOKEN` | `<solaToken \|\| "PLACEHOLDER_WAITING_ON_TULE">` | platform env | only when `partner === "edge_city"` |
| `ELEVENLABS_API_KEY` | `<process.env.ELEVENLABS_API_KEY>` | platform env | if env is set (always for platform-managed) |
| `RESEND_API_KEY` | `<process.env.RESEND_API_KEY>` | platform env | if env is set |
| `ALPHAVANTAGE_API_KEY` | `<process.env.ALPHAVANTAGE_API_KEY>` | platform env | if env is set |
| `BRAVE_SEARCH_API_KEY` | `<process.env.BRAVE_SEARCH_API_KEY>` | platform env | if env is set |
| `OPENAI_API_KEY` | `<process.env.OPENAI_API_KEY>` | platform env | if env is set |

**Also explicitly DELETED (sed -i "/^SJINN_API_KEY=/d") at `lib/ssh.ts:6507`** — must replicate this if any legacy VM env carries the old key.

**Pattern for each write (canonical, from lib/ssh.ts):**
```bash
grep -q "^KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s|^KEY=.*|KEY=${VALUE}|" "$HOME/.openclaw/.env" || \
  echo "KEY=${VALUE}" >> "$HOME/.openclaw/.env"
```

For values containing special chars (API keys), use the base64 pattern (lib/ssh.ts:5963-5966 example):
```bash
KEY_B64=$(echo '<base64-of-value>' | base64 -d)
grep -q "^KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^KEY=.*/KEY=$KEY_B64/" "$HOME/.openclaw/.env" || \
  echo "KEY=$KEY_B64" >> "$HOME/.openclaw/.env"
```

**Cloud-init MUST `touch "$HOME/.openclaw/.env"` first** in case file doesn't exist.

**What breaks if any key missing:** Skills that depend on that key silently fail. Voice with no ELEVENLABS_API_KEY falls back to OpenAI. Bankr with no key returns 401s. Catastrophic on a per-skill basis.

### §3.6 audio-config.json (skill-specific config)

- **Path:** `~/.openclaw/audio-config.json`
- **Source:** Built per-user from `tierLimits[tierKey]` (lib/ssh.ts:5923-5938):
  ```json
  {
    "tier": "<tierKey>",
    "monthly_chars": <450K | 1.8M | 7.2M | 999999999>,
    "daily_max_requests": <10 | 50 | 200 | 999999>,
    "max_single_request": <5000 | 15000 | 50000 | 999999>,
    "primary_provider": "<openai | elevenlabs | user_choice>",
    "fallback_provider": "openai",
    "alert_at_percent": 80,
    "overage_action": "fallback_to_openai"
  }
  ```
- **Per-user:** YES (tier-based).
- **What breaks if missing:** Voice skill's tier-aware limits don't apply. Power-tier users hit free-tier ceilings.

### §3.7 email-config.json

- **Path:** `~/.openclaw/email-config.json`
- **Source:** `{ "from_address": "agent@instaclaw.io", "provider": "resend", "created_at": "<ISO>" }` (lib/ssh.ts:6013-6018).
- **Per-user:** No.
- **What breaks if missing:** Email skill doesn't know its sender address. Email sending broken.

### §3.8 openclaw.json.last-known-good (backup)

- **Path:** `~/.openclaw/openclaw.json.last-known-good`
- **Source:** `cp` of openclaw.json BEFORE writing the new config (lib/ssh.ts:5069-5070).
- **Cloud-init:** Cloud-init's first-boot scenario has no prior config to copy. **Either skip this OR write the placeholder blob from the snapshot's userdata (line 178 of `lib/providers/linode.ts`):** `{"_placeholder":true,"gateway":{"mode":"local","port":18789,"bind":"lan"}}`. The placeholder copy from snapshot already exists.
- **What breaks if missing:** Gateway-startup rollback path has nothing to revert to. Cloud-init should ensure SOMETHING is there before writing the real config.

---

## §4. Scripts in ~/.openclaw/scripts/

All scripts written via base64-decode, then `chmod +x`. **Owner: openclaw:openclaw.**

| Path | Source const | Per-user | Sentinels (Rule 23) |
|---|---|---|---|
| `~/.openclaw/scripts/strip-thinking.py` | `STRIP_THINKING_SCRIPT` (lib/ssh.ts, registered runtime) | No | `def trim_failed_turns`, `SESSION TRIMMED:`, `def run_periodic_summary_hook`, `PERIODIC_SUMMARY_V1`, `PRE_ARCHIVE_SUMMARY_V1`, `PERIODIC_SUMMARY_V1_RESHRINK`, `def compact_session_in_place_lines`, `SESSION COMPACTED:`, `def _extract_large_tool_results_to_cache`, `LAYER3_EXTRACTED:` |
| `~/.openclaw/scripts/vm-watchdog.py` | `VM_WATCHDOG_SCRIPT` | No | (none required) |
| `~/.openclaw/scripts/silence-watchdog.py` | `SILENCE_WATCHDOG_SCRIPT` (lib/ssh.ts:156) | No | (none required) |
| `~/.openclaw/scripts/push-heartbeat.sh` | `PUSH_HEARTBEAT_SH` (lib/ssh.ts:402) | No | (none required) |
| `~/.openclaw/scripts/auto-approve-pairing.py` | `AUTO_APPROVE_PAIRING_SCRIPT` (lib/ssh.ts, registered runtime) | No | (none required) |
| `~/.openclaw/scripts/generate_workspace_index.sh` | `WORKSPACE_INDEX_SCRIPT` (lib/agent-intelligence.ts:961) | No | (none required) |
| `~/.openclaw/scripts/memory-snapshot.sh` | `MEMORY_SNAPSHOT_SCRIPT` (lib/agent-intelligence.ts:1014) | No | (none required) |
| `~/.openclaw/scripts/skill-integrity-check.sh` | `SKILL_INTEGRITY_CHECK_SH` (lib/ssh.ts:448) | No | `verify_or_heal_git_skill`, `SKILL_RECOVERED` |
| `~/.openclaw/scripts/ack-watchdog.py` | `ACK_WATCHDOG_SCRIPT` (lib/ssh.ts, registered runtime) | No | `def is_turn_stalled`, `ACK_WATCHDOG_SLOW_WARNING` |
| `~/.openclaw/scripts/consensus_match_pipeline.py` | `CONSENSUS_MATCH_PIPELINE_PY` (lib/matchpool-scripts.ts, lazy) | No | `def build_l2_passthrough_deliberations`, `FALLBACK_ABORT_THRESHOLD`, `snapshot_anchor`, `CONSENSUS_MEMORY_PATH`, `maybe_send_match_notification`, `skip skill_disabled` |
| `~/.openclaw/scripts/consensus_match_rerank.py` | `CONSENSUS_MATCH_RERANK_PY` | No | `RERANK_INSTRUCTIONS`, `fabrication rule`, `Banned phrases`, `def shuffle_candidates`, `x-call-kind: match-pipeline` |
| `~/.openclaw/scripts/consensus_match_deliberate.py` | `CONSENSUS_MATCH_DELIBERATE_PY` | No | `DELIBERATION_INSTRUCTIONS`, `fabrication rule`, `skip-reason discipline`, `def make_fallback`, `x-call-kind: match-pipeline` |
| `~/.openclaw/scripts/consensus_match_consent.py` | `CONSENSUS_MATCH_CONSENT_PY` | No | `VALID_TIERS`, `interests_plus_name` |
| `~/.openclaw/scripts/consensus_match_skill_toggle.py` | `CONSENSUS_MATCH_SKILL_TOGGLE_PY` | No | `TOGGLE_ENDPOINT`, `consensus-2026`, `def post_toggle` |
| `~/.openclaw/scripts/consensus_intent_sync.py` | `CONSENSUS_INTENT_SYNC_PY` | No | `def check_skill_enabled`, `CONSENT_ENDPOINT`, `skip skill_disabled`, `MIN_EXTRACT_INTERVAL_SECONDS` |
| `~/.openclaw/scripts/consensus_intent_extract.py` | `CONSENSUS_INTENT_EXTRACT_PY` | No | `HAIKU_MODEL`, `MIN_MEMORY_CHARS`, `def extract_intent` |
| `~/.openclaw/scripts/privacy-bridge.sh` (edge_city only) | `PRIVACY_BRIDGE_SCRIPT` (lib/privacy-bridge-script.ts, lazy) | No | (see PRD) |

**Pre-checks before writing scripts:**
- `mkdir -p $HOME/.openclaw/scripts $HOME/.openclaw/logs $HOME/.openclaw/agents/main/sessions-backup`
- Each script MUST be `chmod +x`.

**Rule 23 sentinel enforcement:** Cloud-init's template-resolution layer should verify each `requiredSentinels` array is present in the in-memory template before writing. Match the reconciler's `deployFileEntry` discipline (lib/vm-reconcile.ts:1294-1507).

---

## §5. Scripts in ~/scripts/ (the "outer" scripts dir)

These are agent-callable from any working directory.

### §5.1 telegram-pre-start.sh

- **Path:** `~/.openclaw/telegram-pre-start.sh`
- **Source:** Inline heredoc (lib/ssh.ts:7176-7185). Reads bot token from openclaw.json + curls `deleteWebhook` on Telegram API before gateway starts.
- **Wired via:** Patched into `~/.config/systemd/user/openclaw-gateway.service` as `ExecStartPre=/bin/bash $TG_PRESTARTSH` (lib/ssh.ts:7187).
- **Permissions:** 755 (executable).
- **What breaks if missing:** Telegram 409 conflict loop where gateway fights its own stale getUpdates.

### §5.2 deliver_file.sh + notify_user.sh

- **Paths:** `~/scripts/deliver_file.sh`, `~/scripts/notify_user.sh`
- **Source:** `DELIVER_FILE_SCRIPT`, `NOTIFY_USER_SCRIPT` constants (location TBD — defined somewhere in `lib/` and registered).
- **Per-user:** No.
- **Permissions:** Executable.
- **What breaks if missing:** Agent can't deliver files to Telegram, can't run proactive notifications during heartbeat.

### §5.3 token-price.py

- **Path:** `~/scripts/token-price.py`
- **Source:** `TOKEN_PRICE_SCRIPT` constant.
- **Per-user:** No.
- **What breaks if missing:** Agent can't answer "what's my token at?" Reads BANKR_TOKEN_ADDRESS from .env.

### §5.4 Skill-specific scripts in ~/scripts/

These are scripts deployed by individual skill installs. Each is base64-decoded from `instaclaw/skills/<skill>/assets/*.sh|.py` or `instaclaw/skills/<skill>/scripts/*.sh|.py` and chmod +x'd. Listed by skill in §7.

### §5.5 dispatch scripts (22 scripts) + dispatch-server.js

- **Paths:** `~/scripts/<name>.sh` for 22 dispatch scripts + `~/scripts/dispatch-server.js`.
- **Source:** `DISPATCH_SCRIPTS` object + `DISPATCH_SERVER_JS` constant from `lib/dispatch-scripts.ts` (auto-generated from `instaclaw/skills/computer-dispatch/`).
- **Why inlined (Rule 12):** Next 15's `@vercel/nft` tracer silently drops `.sh` files from the Vercel bundle even with `outputFileTracingIncludes`. The 2026-05-10 dispatch_deploy ENOENT incident was a direct consequence. **Cloud-init has zero Next-bundling concerns** because the bash content is constructed in TypeScript and shipped via userdata — the same source const works, but no Next bundling pipeline is in play.
- **Per-user:** No.
- **CRITICAL (`recordFailure(..., critical=true)`):** Yes — `lib/ssh.ts:5740` `recordFailure("dispatch_deploy", err, true)`.
- **What breaks if missing:** Agent can't drive virtual desktop (Dispatch Mode broken).

### §5.6 browser-relay-server.js

- **Path:** `~/scripts/browser-relay-server.js`
- **Source:** `fs.readFileSync('../scripts/browser-relay-server/browser-relay-server.js')` in current implementation (lib/ssh.ts:5754-5760).
- **Per-user:** No.
- **CRITICAL:** Yes — `lib/ssh.ts:5772` `recordFailure("browser_relay_deploy", err, true)`.
- **Cloud-init action:** Move the file content into a TypeScript const at build time (mirror dispatch scripts pattern). **Bundling concern:** Same Rule 12 risk as dispatch scripts. Pre-inline before merging.

---

## §6. configSettings — `openclaw config set` keys (29 entries)

From `lib/vm-manifest.ts:1131-1352`. These are set via `openclaw config set KEY VALUE` after the openclaw.json is written. **Reconciler enforces all of these** every 3 min via `stepConfigSettings`.

**Optimization for cloud-init:** The values for these keys are ALREADY emitted in the openclaw.json by `buildOpenClawConfig` (most of them). Cloud-init can either:
- (a) Write openclaw.json with all keys directly, then run a verify-after-write check, OR
- (b) Write openclaw.json + loop `openclaw config set` for each manifest configSettings entry.

Option (a) is faster (no CLI loop). Option (b) is closer to the existing reconciler behavior. **Recommend (a)** with a sentinel check that each key is present in the resulting JSON. **All 29 keys MUST land:**

| Key | Value |
|---|---|
| `agents.defaults.heartbeat.every` | `"3h"` |
| `agents.defaults.heartbeat.session` | `"heartbeat"` |
| `agents.defaults.compaction.reserveTokensFloor` | `"35000"` |
| `agents.defaults.bootstrapMaxChars` | `"40000"` |
| `agents.defaults.compaction.memoryFlush.enabled` | `"true"` |
| `agents.defaults.compaction.memoryFlush.softThresholdTokens` | `"8000"` |
| `agents.defaults.compaction.mode` | `"safeguard"` |
| `agents.defaults.compaction.maxActiveTranscriptBytes` | `"150000"` |
| `agents.defaults.compaction.recentTurnsPreserve` | `"10"` |
| `agents.defaults.compaction.qualityGuard.enabled` | `"true"` |
| `agents.defaults.compaction.qualityGuard.maxRetries` | `"2"` |
| `agents.defaults.compaction.notifyUser` | `"true"` |
| `agents.defaults.compaction.truncateAfterCompaction` | `"true"` |
| `agents.defaults.memorySearch.enabled` | `"true"` |
| `commands.restart` | `"true"` |
| `channels.telegram.groupPolicy` | `"open"` |
| `channels.telegram.groups.*.requireMention` | `"false"` |
| `channels.telegram.streaming.mode` | `"partial"` |
| `channels.telegram.streaming.preview.toolProgress` | `"false"` |
| `channels.telegram.streaming.preview.chunk.minChars` | `"30"` |
| `channels.telegram.streaming.preview.chunk.maxChars` | `"800"` |
| `channels.telegram.streaming.preview.chunk.breakPreference` | `"sentence"` |
| `messages.ackReactionScope` | `"all"` |
| `messages.ackReaction` | `"👀"` |
| `messages.removeAckAfterReply` | `"false"` |
| `messages.statusReactions.enabled` | `"true"` |
| `discovery.mdns.mode` | `"off"` |
| `commands.useAccessGroups` | `"false"` |
| `session.reset.mode` | `"idle"` |
| `session.reset.idleMinutes` | `"10080"` |
| `session.maintenance.mode` | `"enforce"` |
| `skills.limits.maxSkillsPromptChars` | `"500000"` |
| `tools.exec.security` | `"full"` |
| `tools.exec.ask` | `"off"` |
| `agents.defaults.sandbox.mode` | `"off"` |
| `agents.defaults.timeoutSeconds` | `"300"` |
| `gateway.http.endpoints.chatCompletions.enabled` | `"true"` |

**Caution (Rule 32):** The `messages.*` keys do NOT hot-reload. The gateway must be RESTARTED after these are set, not just SIGHUP'd. Cloud-init's gateway-start is the first start, so this is moot for cloud-init. But the reconciler downstream still needs to restart on any future change.

**Verification:** After writing openclaw.json, cloud-init should do:
```bash
openclaw doctor 2>&1 | grep -qi "error\|invalid\|Profile must set" && echo CONFIG_VALIDATION_WARNING
```
This is the `openclaw doctor` advisory check from `lib/ssh.ts:6962-6965`.

---

## §7. Skill inventory

Per the Explore agent's deep map, there are 27 directories in `instaclaw/skills/`. Of those, 17 are deployed via inline base64, 4 are git-cloned from external repos, 5 are doc-only (manifest auto-loads), and 1 (`shared/`) is a utility dir.

### §7.1 Inline base64 skills (17, deployed via configureOpenClaw blocks)

For each, cloud-init must:
1. Create `~/.openclaw/skills/<name>/` (and `references/`, `assets/`, `scripts/` subdirs as needed)
2. Write `SKILL.md` base64-decoded
3. Write any `references/*.md` files
4. Write any `assets/*.sh`, `assets/*.py`, or `scripts/*.sh`, `scripts/*.py` files
5. `chmod +x` any executable scripts
6. **Note:** This requires the cloud-init userdata builder to read `instaclaw/skills/<name>/` at build time and embed all bytes as base64 in the userdata. **Just like configureOpenClaw does today via `fs.readFileSync`.**

**Skill list (line numbers reference `lib/ssh.ts` block start in configureOpenClaw):**

| Skill name | Block start | Files to deploy | Env vars needed | Critical |
|---|---|---|---|---|
| `voice-audio-production` | 5907 | SKILL.md, references/voice-guide.md, assets/tts-openai.sh, assets/tts-elevenlabs.sh, assets/audio-toolkit.sh, assets/audio-usage-tracker.py | OPENAI_API_KEY, ELEVENLABS_API_KEY (conditional) | No |
| `email-outreach` | 5986 | SKILL.md, references/email-guide.md, assets/email-client.sh, assets/email-safety-check.py, assets/email-digest.py | RESEND_API_KEY | No |
| `financial-analysis` | 6053 | SKILL.md, references/finance-guide.md, assets/market-data.sh, assets/market-analysis.py | ALPHAVANTAGE_API_KEY | No |
| `competitive-intelligence` | 6104 | SKILL.md, references/intel-guide.md, assets/competitive-intel.sh, assets/competitive-intel.py | BRAVE_SEARCH_API_KEY | No |
| `social-media-content` | 6171 | SKILL.md, references/social-guide.md, assets/social-content.py | None | No |
| `ecommerce-marketplace` | 6206 | SKILL.md, references/ecommerce-guide.md, assets/ecommerce-ops.py, assets/ecommerce-setup.sh | None (BYOK) | No |
| `motion-graphics` | 6246 | SKILL.md, references/{advanced-patterns,brand-assets-checklist}.md, assets/template-basic/{package.json, tsconfig.json, remotion.config.ts, src/index.ts, src/Root.tsx, src/MyVideo.tsx} | None | No |
| `brand-design` | 6299 | SKILL.md, references/brand-extraction-guide.md | None | No |
| `web-search-browser` | 6328 | SKILL.md, references/{browser-patterns,crawlee-stealth-scraping}.md, assets/crawlee-scrape.py | None | No |
| `code-execution` | 6450 | SKILL.md, references/code-patterns.md | None | No |
| `sjinn-video` | 6479 | SKILL.md, references/{sjinn-api,video-prompting,video-production-pipeline}.md, scripts/setup-sjinn-video.sh | None (proxied server-side) | No |
| `marketplace-earning` | 6523 | SKILL.md only | None | No |
| `prediction-markets` | 6550 | SKILL.md + 6 references/*.md + 12 scripts/*.py + setup-polymarket-wallet.sh | POLYGON_RPC_URL, CLOB_PROXY_URL | No |
| `language-teacher` | 6637 | SKILL.md + 4 references/*.md + 3 languages/*.md + scripts/setup-language-learning.sh | None | No |
| `solana-defi` | 6688 (**.disabled by default**) | SKILL.md + 5 references/*.md + 5 scripts/*.py | None | No |
| `higgsfield-video` | 6746 | SKILL.md + 6 references/*.md + 8 scripts/*.py | INSTACLAW_MUAPI_PROXY | No |
| `x-twitter-search` | 6802 | SKILL.md only | None | No |
| `agentbook` | 6828 | SKILL.md + scripts/agentbook-check.py + scripts/agentbook-register.sh | WORLD_ID_NULLIFIER, WORLD_ID_LEVEL | No (skill_agentbook); but wallet generation IS critical (line 7430) |

**solana-defi gotcha:** Deployed to `~/.openclaw/skills/solana-defi.disabled/` (note `.disabled` suffix). User toggles via dashboard. Cloud-init MUST preserve this `.disabled` suffix.

### §7.2 Git-cloned skills (4)

| Skill | Repo URL | Clone path | Cron | Env vars | Partner gate |
|---|---|---|---|---|---|
| `bankr` | `https://github.com/BankrBot/skills` | `~/.openclaw/skills/bankr` | None (npm pkg `@bankr/cli@0.3.1` separate) | BANKR_API_KEY, BANKR_WALLET_ADDRESS | None |
| `edge-esmeralda` | `https://github.com/aromeoes/edge-agent-skill.git` | `~/.openclaw/skills/edge-esmeralda` | `*/30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null` | EDGEOS_BEARER_TOKEN, SOLA_AUTH_TOKEN | `partner === "edge_city"` |
| `consensus-2026` | `https://github.com/coopergwrenn/consensus-2026-skill.git` | `~/.openclaw/skills/consensus-2026` | `*/30 * * * * cd $HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null` | None | UNIVERSAL (line 5315: gate dropped 2026-05-04) |
| `dgclaw` | (handled by reconciler, not configureOpenClaw) | `~/dgclaw-skill` (NOT under .openclaw/skills/) | Skill-integrity hourly | VIRTUALS_PARTNER_ID | ACP-enabled users only |

**Bankr overlay (idempotent, marker-based, lib/ssh.ts:5234-5255):**
```bash
BANKR_SKILL_BASE="$HOME/.openclaw/skills/bankr"
BANKR_SKILL_MD="$BANKR_SKILL_BASE/bankr/SKILL.md"
if [ -d "$BANKR_SKILL_BASE" ] && [ -f "$BANKR_SKILL_MD" ]; then
  rm -rf "$BANKR_SKILL_BASE/clanker" "$BANKR_SKILL_BASE/base"
  if ! grep -q "INSTACLAW_BANKR_PATCH_V1" "$BANKR_SKILL_MD"; then
    BANKR_DIRECTIVE_TMP=$(mktemp)
    echo '<BANKR_SKILL_PATCH_DIRECTIVE base64>' | base64 -d > "$BANKR_DIRECTIVE_TMP"
    cat "$BANKR_SKILL_MD" >> "$BANKR_DIRECTIVE_TMP"
    mv "$BANKR_DIRECTIVE_TMP" "$BANKR_SKILL_MD"
  fi
fi
```

**Edge City overlay (lib/ssh.ts:5298-5301):**
```bash
if [ -d "$HOME/.openclaw/skills/edge-esmeralda" ]; then
  echo '<EDGE_INSTACLAW_OVERLAY_MD base64>' | base64 -d > "$HOME/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md.tmp" && \
    mv "$HOME/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md.tmp" "$HOME/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md"
fi
```

### §7.3 Manifest-only / doc-only skills (5)

These exist in `instaclaw/skills/` but are NOT explicitly deployed in configureOpenClaw. The reconciler's `stepSkills` reads `manifest.skillsFromRepo: true` flag and deploys them via auto-load. For cloud-init: same approach — auto-deploy via the skills/ dir walk.

| Skill | Files |
|---|---|
| `frontier` | SKILL.md only |
| `newsworthy` | SKILL.md only |
| `instagram-automation` | 9× scripts/*.py (deployed via fleet reconciler — must replicate in cloud-init) |
| `xmtp-agent` | SKILL.md only |
| `shared` | scripts/cron-guard.py (utility) |

### §7.4 mcporter clawlancer config (special)

- **Source lines:** lib/ssh.ts:5376-5386.
- **Action:** Configure Clawlancer MCP server via `mcporter`:
  ```bash
  mcporter config remove clawlancer 2>/dev/null || true
  mcporter config add clawlancer \
    --command "npx -y clawlancer-mcp" \
    --env CLAWLANCER_API_KEY= \
    --env CLAWLANCER_BASE_URL=https://clawlancer.ai \
    --scope home \
    --description "Clawlancer AI agent marketplace" || true
  ```
- **Note:** `CLAWLANCER_API_KEY` is intentionally empty — populated when agent registers via the Clawlancer API.

---

## §8. Cron inventory (10 entries)

Cloud-init must install all 10 of these in a single crontab — idempotently, marker-based. **Order doesn't matter; idempotency does.**

From `VM_MANIFEST.cronJobs` (lib/vm-manifest.ts:1829-1928) — these get installed by the manifest cron loop (lib/ssh.ts:6396-6412):

| Schedule | Command | Marker |
|---|---|---|
| `* * * * *` | `python3 ~/.openclaw/scripts/strip-thinking.py > /dev/null 2>&1` | `strip-thinking.py` |
| `* * * * *` | `python3 ~/.openclaw/scripts/auto-approve-pairing.py > /dev/null 2>&1` | `auto-approve-pairing.py` |
| `17 * * * *` | `bash ~/.openclaw/scripts/skill-integrity-check.sh > /dev/null 2>&1` | `skill-integrity-check.sh` |
| `0 * * * *` | `bash ~/.openclaw/scripts/push-heartbeat.sh` | `push-heartbeat.sh` |
| `0 4 * * *` | `. /home/openclaw/.nvm/nvm.sh && openclaw memory index >> /tmp/memory-index.log 2>&1` | `openclaw memory index` |
| `30 4 * * 0` | `find ~/.openclaw/workspace/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null` | `workspace/backups` |
| `*/30 * * * *` | `python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1` | `consensus_match_pipeline.py` |
| `*/15 * * * *` | `python3 ~/.openclaw/scripts/consensus_intent_sync.py >> /tmp/consensus_intent_sync.log 2>&1` | `consensus_intent_sync.py` |
| `* * * * *` | `python3 ~/.openclaw/scripts/ack-watchdog.py > /dev/null 2>&1` | `ack-watchdog.py` |

**Manifest also EXCLUDES** (v76 disabled): `vm-watchdog.py`, `silence-watchdog.py` — scripts deployed but no cron entry. Future rewrite may re-enable.

### Additional cron entries installed inline by configureOpenClaw (NOT in manifest):

| Schedule | Command | Marker | Source line | Conditional |
|---|---|---|---|---|
| `*/30 * * * *` | `cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null` | `edge-agent-skill` | lib/ssh.ts:5295 | partner=edge_city |
| `*/30 * * * *` | `cd $HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null` | `consensus-2026-skill` | lib/ssh.ts:5327 | universal |
| `0 3 * * *` | `/bin/bash $HOME/scripts/check-skill-updates.sh >> $HOME/.openclaw/logs/skill-updates.log 2>&1` | `check-skill-updates` | lib/ssh.ts:6377 | universal |

### Crons baked into snapshot (NOT explicitly installed by configureOpenClaw)

Per CLAUDE.md "Snapshot Creation Process" step 5, the snapshot has SHM cleanup baked in:

| Schedule | Command | Marker | Source |
|---|---|---|---|
| `0 * * * *` | `ipcs -m \| awk ... rm` | `SHM_CLEANUP` | baked in snapshot |

**Cloud-init verification:** After installing manifest crons, verify all 10 markers are present via `crontab -l \| grep -c "marker"`. If any missing, cron install loop didn't run successfully.

**Idempotent install pattern (from lib/ssh.ts:6402-6404):**
```bash
if ! crontab -l 2>/dev/null | grep -qF "<marker>"; then
  (crontab -l 2>/dev/null; echo '<cron-line-base64>' | base64 -d) | crontab -
fi
```

---

## §9. Systemd inventory

### §9.1 openclaw-gateway.service (the main one)

Created by `openclaw gateway install` (lib/ssh.ts:7127). Path: `~/.config/systemd/user/openclaw-gateway.service`.

**Override.conf** at `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` — applied AFTER install (lib/ssh.ts:7134-7154). From `VM_MANIFEST.systemdUnitOverrides` + `VM_MANIFEST.systemdOverrides`:

```ini
[Unit]
StartLimitBurst=10
StartLimitIntervalSec=300
StartLimitAction=none

[Service]
KillMode=mixed
Delegate=yes
RestartSec=10
ExecStartPre=/bin/bash -c 'find /tmp/openclaw/ -name "*.log" -mmin +60 -delete 2>/dev/null; find /tmp/openclaw/ -name "*.log.bak" -mtime +3 -delete 2>/dev/null; pkill -9 -f "[c]hrome.*remote-debugging-port" 2>/dev/null || true; bash /home/openclaw/.openclaw/scripts/memory-snapshot.sh restore 2>/dev/null || true'
ExecStopPost=/bin/bash /home/openclaw/.openclaw/scripts/memory-snapshot.sh pre-stop 2>/dev/null || true
MemoryHigh=3G
MemoryMax=3500M
TasksMax=120
OOMScoreAdjust=500
RuntimeMaxSec=86400
RuntimeRandomizedExtraSec=3600
Environment="PARTNER_ID=INSTACLAW"
```

**ALSO patched into the main unit file** (lib/ssh.ts:7157-7187) via sed for VMs where `openclaw gateway install` didn't include the override-equivalents directly:
- `KillMode=mixed` (idempotent — checked via grep)
- `Restart=always`
- `RestartSec=10`
- `StartLimitBurst=10`
- `StartLimitIntervalSec=300`
- `StartLimitAction=none`
- `ExecStartPre=/bin/bash -c 'pkill -9 -f "[c]hrome.*remote-debugging-port" 2>/dev/null || true'`
- `ExecStartPre=/bin/bash $TG_PRESTARTSH` (telegram-pre-start.sh)

**prctl-subreaper drop-in** at `~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf` (per v87 manifest):
```ini
[Service]
Environment="NODE_PATH=/home/openclaw/.nvm/versions/node/v22.22.2/lib/node_modules"
Environment="NODE_OPTIONS=--require prctl-subreaper"
Environment="PRCTL_SUBREAPER_INTERVAL_MS=1000"
Environment="PRCTL_SUBREAPER_MIN_AGE_MS=5000"
```

**daemon-reload required after every override.conf write.**

### §9.2 xvfb.service (system, root-owned)

- **Path:** `/etc/systemd/system/xvfb.service`
- **Created via:** `sudo bash -c 'cat > /etc/systemd/system/xvfb.service << XVFBEOF ...'` (lib/ssh.ts:6979-6991)
- **Content:**
  ```ini
  [Unit]
  Description=Xvfb Virtual Display for Dispatch Mode
  After=network.target

  [Service]
  Type=simple
  User=openclaw
  ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -ac
  Restart=always
  RestartSec=3

  [Install]
  WantedBy=multi-user.target
  ```
- **Enable + start:** `sudo systemctl daemon-reload && sudo systemctl enable xvfb && sudo systemctl start xvfb`.
- **Cloud-init detail:** Userdata runs as root by default, so `sudo` is optional in cloud-init context.

### §9.3 x11vnc.service (system)

- **Path:** `/etc/systemd/system/x11vnc.service`
- **Source:** lib/ssh.ts:7003-7016
- **Critical detail:** `ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5901 -localhost -noxdamage -nopw` (`-localhost` binds to 127.0.0.1 only; Caddy proxies through).

### §9.4 websockify.service (system)

- **Path:** `/etc/systemd/system/websockify.service`
- **Source:** lib/ssh.ts:7019-7031
- **Critical detail:** Uses `--token-source /home/openclaw/.vnc/live-tokens` for per-session tokens.

### §9.5 dispatch-server.service (user-mode)

- **Path:** `~/.config/systemd/user/dispatch-server.service`
- **Source:** lib/ssh.ts:7062-7079
- **Content:**
  ```ini
  [Unit]
  Description=Dispatch WebSocket Server
  After=network.target xvfb.service

  [Service]
  Type=simple
  ExecStartPre=/bin/rm -f /tmp/dispatch.sock
  ExecStart='<NODE_BIN_PATH>' /home/openclaw/scripts/dispatch-server.js
  Environment=HOME=/home/openclaw
  Environment=PATH=/home/openclaw/.nvm/versions/node/<NODE_VER>/bin:/usr/local/bin:/usr/bin:/bin
  Restart=always
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```
- **Note:** `<NODE_VER>` and `<NODE_BIN_PATH>` substituted at runtime via shell expansion.
- **Enable + start:** `systemctl --user daemon-reload && systemctl --user enable dispatch-server && systemctl --user start dispatch-server`.

### §9.6 browser-relay-server.service (user-mode)

- **Path:** `~/.config/systemd/user/browser-relay-server.service`
- **Source:** lib/ssh.ts:7092-7113
- **Critical detail:** Uses `restart` not `start` so reconciler picks up new server code (line 7113).

### §9.7 gateway-watchdog.timer (DISABLED in v69)

- **Action:** `systemctl --user stop gateway-watchdog.timer 2>/dev/null || true` + `disable` (lib/ssh.ts:7122-7123).
- **Reason:** Per `VM_MANIFEST` comment, watchdog had kill-loop bugs. Disabled fleet-wide.

### §9.8 sshd protection drop-in (per Rule 16-class hardening)

- **Path:** `/etc/systemd/system/ssh.service.d/oom-protection.conf` (verified via reconciler step `stepSSHDProtection` lines 3202-3237).
- **Content:** Sets `OOMScoreAdjust=-900` so sshd survives memory pressure (gateway dies first).
- **Cloud-init action:** Write this drop-in + sudo systemctl daemon-reload.

### §9.9 Caddy /vnc/* proxy patch

- **Path:** `/etc/caddy/Caddyfile`
- **Action:** `sed -i` to insert a `handle /vnc/* { uri strip_prefix /vnc; reverse_proxy localhost:6080 }` block before the gateway proxy (lib/ssh.ts:7047-7050).
- **Reload:** `sudo systemctl reload caddy`.

---

## §10. System packages (apt)

From `VM_MANIFEST.systemPackages` (manifest line 1931):
- `ffmpeg`
- `jq`
- `build-essential`

**Plus packages installed inline by configureOpenClaw:**
- `xvfb` (dispatch)
- `xdotool` (dispatch)
- `libx11-dev libxext-dev libxtst-dev libpng-dev` (dispatch native deps)
- `openbox` (window manager)
- `imagemagick` (dispatch)
- `x11vnc websockify novnc` (live desktop viewer)
- `socat netcat-openbsd` (dispatch relay)

**Total apt install line:**
```bash
sudo apt-get install -y -qq \
  ffmpeg jq build-essential \
  xvfb xdotool libx11-dev libxext-dev libxtst-dev libpng-dev openbox imagemagick \
  x11vnc websockify novnc \
  socat netcat-openbsd > /dev/null 2>&1 || true
```

**Snapshot consideration:** Most of these are already in the baked snapshot per CLAUDE.md (the snapshot bake step 7 verifies them present). Cloud-init's apt-install is **idempotent defense-in-depth** in case the snapshot drifts.

---

## §11. Python packages (pip)

From `VM_MANIFEST.pythonPackages` (manifest line 1934):
- `openai`

**Plus inline-installed (PARALLEL_INSTALL block, lib/ssh.ts:6884-6920):**

```bash
# Pip bootstrap (sequential, must run first)
python3 -m pip --version >/dev/null 2>&1 || \
  curl -sS https://bootstrap.pypa.io/get-pip.py | python3 - --break-system-packages --quiet

# Parallel:
python3 -m pip install --quiet --break-system-packages \
  "crawlee[beautifulsoup,playwright]==1.5.0"  # web search
python3 -m pip install --quiet --break-system-packages \
  web3 py-clob-client eth-account websockets cryptography  # polymarket + agentbook
python3 -m pip install --quiet --break-system-packages \
  solders base58 httpx websockets  # solana
```

**Cloud-init can run all of these in parallel (with `&` and `wait`) just like configureOpenClaw does (lib/ssh.ts:6884-6913).**

---

## §12. NPM packages (npm global)

| Package | Pinned version | Source line |
|---|---|---|
| `openclaw` | `OPENCLAW_PINNED_VERSION` = `"2026.4.26"` | lib/ssh.ts:121, install at line 6939 |
| `@bankr/cli` | `BANKR_CLI_PINNED_VERSION` = `"0.3.1"` | lib/ssh.ts:141, install at line 5270 |
| `@worldcoin/agentkit-cli` | `0.1.3` | lib/ssh.ts:6909 |
| `prctl-subreaper` | per v87 manifest, current `0.1.0` → bump to 0.1.1 per v88 changelog | manifest v87, reconciler `stepPrctlSubreaper` |
| `usecomputer` | (unpinned) | lib/ssh.ts:6971 |
| `ws` | (in `~/scripts/package.json`) | lib/ssh.ts:7056 |

**Cloud-init must run via NVM:** `NVM_PREAMBLE` (defined lib/ssh.ts:242 — `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`).

**Snapshot consideration:** OpenClaw is pre-installed in the snapshot at the pinned version. Cloud-init verifies via `which openclaw || node -e "require('openclaw')"`. If broken, reinstalls (lib/ssh.ts:6927-6958).

---

## §13. Reconciler step categorization (a/b/c)

From the Explore agent's deep map. 43 steps total (the agent found 45 with stepBootstrapState appearing twice; deduped here). **Cloud-init MUST emit a state that satisfies every (a) and (c) check; (b) steps are drift-repair only.**

### Category (a) — Cloud-init MUST land (10 steps)

1. **stepConfigSettings** — All 29 keys in §6 are landed in openclaw.json by `buildOpenClawConfig`. Cloud-init's responsibility.
2. **stepFiles** — All workspace files in §2 + scripts in §4 are landed by cloud-init.
3. **stepEnvVarPush** — GBRAIN_ANTHROPIC_API_KEY (from Vercel `process.env`) into `~/.openclaw/.env` if set. **Currently optional.** Cloud-init: include if gbrain-enabled partner.
4. **stepSystemPackages** — `ffmpeg jq build-essential` apt-installed in §10.
5. **stepPythonPackages** — `openai` pip-installed in §11.
6. **stepEnvVars** — All env vars in §3.5 landed in `~/.openclaw/.env`.
7. **stepAuthProfiles** — `auth-profiles.json` landed in §3.2.
8. **stepSystemdUnit** — Override.conf and main unit patches in §9.1 landed.
9. **stepCronJobs** — All 10 manifest crons in §8 landed.
10. **stepSkills** — All skills in §7 (universal + partner-gated) landed.
11. **stepPrctlSubreaper** — prctl-subreaper@0.1.1 npm + drop-in (§9.1 prctl-subreaper.conf) landed.
12. **stepBootstrapState** — BOOTSTRAP.md (§2.7) landed AND `.bootstrap_consumed` marker created (cloud-init MUST touch `~/.openclaw/workspace/.bootstrap_consumed` after BOOTSTRAP.md exists — currently configureOpenClaw doesn't do this, but the reconciler does at line 3704-3763).

### Category (a) — Partner-specific (3 steps)

13. **stepGbrain** — Per `vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST && GBRAIN_INSTALL_ENABLED`. Currently feature-flagged off for most VMs. Cloud-init may defer to reconciler unless explicitly enabled.
14. **stepDeployEdgeOverlay** — Writes `~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md` (lib/ssh.ts:5298-5301 already does this). Cloud-init: same code path.
15. **stepDeployPrivacyBridge** — Writes `~/.openclaw/scripts/privacy-bridge.sh` for edge_city (currently no-op until manual cutover wires it into authorized_keys).

### Category (c) — Patches configureOpenClaw omission, MUST land in cloud-init (8 steps)

16. **stepWorkspaceIntegrity** — Heals missing SOUL.md, CAPABILITIES.md, MEMORY.md, EARN.md. Cloud-init writes all of these (§2). **Verify all four exist post-write.**
17. **stepBootstrapConsumed** — Heals missing `.bootstrap_consumed` marker. Cloud-init MUST `touch ~/.openclaw/workspace/.bootstrap_consumed`.
18. **stepMigrateSoulV2** — V1→V2 SOUL.md migration. Cloud-init writes V2 directly (no V1 baggage), so this is unnecessary. Skip.
19. **stepFixBlankIdentity** — Deletes blank IDENTITY.md. Cloud-init writes a populated IDENTITY.md (§2.9), so this won't fire. Safe to skip.
20. **stepRemoveDuplicateSkills** — Removes duplicate skill dirs. Cloud-init doesn't create duplicates. Skip.
21. **stepRemovePlaceholder** — Removes `_placeholder` key from openclaw.json. Cloud-init writes a real openclaw.json (no `_placeholder`). Skip.
22. **stepRenameVideoSkill** — Renames `video-production` → `motion-graphics`. Cloud-init writes `motion-graphics` directly. Skip.
23. **stepTelegramTokenVerify** — Syncs DB → disk. Cloud-init writes the token directly from DB at first boot, so disk matches DB. Reconciler skip on first cycle (Rule 34).
24. **stepInstaClawIdentityPatch** — Adds `## Platform` section to SOUL.md if missing. Cloud-init's SOUL.md is constructed from up-to-date templates — verify INSTACLAW_PLATFORM_V1 marker is present in `WORKSPACE_SOUL_MD` template before writing.

### Category (b) — Drift-repair only, cloud-init SKIP (22 steps)

stepBackup, stepNpmPinDrift, stepNodeUpgrade, stepRemotionDeps, stepCleanStaleMemory, stepClearProviderCooldown, stepCaddyUIBlock, stepV67RoutingTablePatch, stepRewriteSoulPartnerSections, stepShmCleanupCron, stepSkillDirectories, stepEnforceModelPrimary, stepSSHDProtection (cloud-init does write the drop-in once at boot, so this is technically (a); but it's idempotent so reconciler-driven repair works equivalently), stepGatewayWatchdogTimer (DISABLED), stepNodeExporter (partner=edge_city only, monitored by reconciler), stepDispatchServer (cloud-init writes it; reconciler heals), stepInstaclawXmtp (cloud-init writes ENV; reconciler runs setupXMTP setup post-boot), stepGatewayRestart, stepCanaryProbe.

**Cloud-init's invariant:** post-boot, the reconciler's first cycle finds zero (a) drift. Some (c) drift may remain — that's acceptable; the reconciler heals it within 3 min.

---

## §14. Critical-failure mark inventory (Rule 33 gate)

These 3 calls fire `recordFailure(..., critical=true)`. Per Rule 33, the route handler's critical-failure gate marks the VM `configure_failed` instead of `healthy` if ANY of these fires.

For cloud-init, the equivalent is: **if cloud-init can't deploy these, the VM never reaches `/tmp/.instaclaw-ready` sentinel** and gets respawned by the cloud-init-poll cron.

| Critical step | Source line | What it does | Cloud-init response |
|---|---|---|---|
| `dispatch_deploy` | 5740 | Deploys 22 dispatch scripts + dispatch-server.js to ~/scripts/ | If template-resolve fails → exit 1 with diagnostic |
| `browser_relay_deploy` | 5772 | Deploys browser-relay-server.js to ~/scripts/ | If file read fails → exit 1 with diagnostic |
| `agentbook_wallet_generation` | 7430 | Generates Ethereum key pair + writes `~/.openclaw/wallet/agent.key` | If openssl fails → exit 1 with diagnostic |

**Cloud-init MUST emit `/tmp/.instaclaw-failed` sentinel** on any of these failures so cloud-init-poll knows to destroy + respawn.

---

## §15. Sentinels (boot completion signals)

From `lib/ssh.ts:7240-7259` and the cloud-init-callback flow:

| Sentinel | Emitted at | Consumed by |
|---|---|---|
| `OPENCLAW_REINSTALL_OK` / `OPENCLAW_REINSTALL_FAILED` | Line 6958-6949 (after openclaw module reinstall) | Route handler at 7304-7318 |
| `PARALLEL_INSTALL_START` / `PARALLEL_INSTALL_DONE` | Lines 6890, 6918 | Logging only |
| `CRAWLEE_INSTALL_FAILED` | Line 6916 | Logging |
| `CONFIG_VALIDATION_WARNING: ...` | Line 6964 | Logging |
| `PAIRING_RESULT: ...` | Line 7220 | Logging |
| `GATEWAY_HEALTH_OK_ATTEMPT_<N>` / `GATEWAY_HEALTH_FAIL_ATTEMPT_<N>` | Lines 7233, 7236 | Logging |
| `GATEWAY_VERIFIED` | Line 7240 | Route handler at 7357 |
| `GATEWAY_NOT_RESPONDING` | Line 7242 | Route handler |
| `GATEWAY_ROLLBACK_TRIGGERED` | Line 7245 | Route handler at 7327 — throws BEFORE DB write per Rule 34 |
| `GATEWAY_ROLLBACK_RECOVERED` / `GATEWAY_ROLLBACK_FAILED` | Lines 7252, 7254 | Route handler |
| **`OPENCLAW_CONFIGURE_DONE`** | Line 7259 | Route handler at 7321 — must be present for success |
| `RETRY_HEALTH_OK` | Line 7375 (post-script retry) | Route handler at 7375 |

### Cloud-init's NEW sentinels:

- **`/tmp/.instaclaw-ready`** — emitted on successful gateway start + callback fire. Consumed by `cloud-init-poll` cron.
- **`/tmp/.instaclaw-failed`** — emitted on critical failure. Consumed by `cloud-init-poll` cron → triggers respawn.

---

## §16. Privacy wipe inventory

Cloud-init runs on a FRESH VM from snapshot, so most of these are no-ops. But the snapshot has placeholder data that the wipe explicitly nukes. **Cloud-init MUST run the wipe block** (lib/ssh.ts:5489-5512) defensively:

```bash
rm -rf $HOME/.openclaw/workspace/* 2>/dev/null || true
find $HOME/.openclaw/workspace/ -maxdepth 1 -name ".*" -not -name "." -not -name ".." -exec rm -rf {} + 2>/dev/null || true
rm -rf $HOME/.openclaw/agents/main/sessions/* 2>/dev/null || true
rm -rf $HOME/.openclaw/agents/main/sessions-backup/* 2>/dev/null || true
rm -rf $HOME/.openclaw/agents/main/sessions-archive/* 2>/dev/null || true
rm -f $HOME/.openclaw/agents/main/agent/system-prompt.md 2>/dev/null || true
rm -rf $HOME/.openclaw/backups/* 2>/dev/null || true
rm -rf $HOME/.openclaw/media/* 2>/dev/null || true
rm -rf $HOME/memory/* 2>/dev/null || true
rm -f /tmp/openclaw/*.log 2>/dev/null || true
rm -rf $HOME/.openclaw/canvas/* 2>/dev/null || true
echo '{"jobs":[]}' > $HOME/.openclaw/cron/jobs.json 2>/dev/null || true
rm -rf $HOME/.config/chromium/Default/Session* $HOME/.config/chromium/Default/History* $HOME/.config/chromium/Default/Cookies* 2>/dev/null || true
rm -rf $HOME/.config/chromium/Default/Local\ Storage/* $HOME/.config/chromium/Default/IndexedDB/* 2>/dev/null || true
rm -rf $HOME/.openclaw/devices/* 2>/dev/null || true
rm -rf $HOME/.openclaw/memory/* 2>/dev/null || true
rm -rf $HOME/.openclaw/notifications/* 2>/dev/null || true
rm -f $HOME/.openclaw/openclaw.json.bak* /tmp/openclaw-backup.json 2>/dev/null || true
rm -f $HOME/.bash_history 2>/dev/null || true
rm -rf $HOME/.openclaw/xmtp/conversations.json 2>/dev/null || true
pkill -9 -f "chrome.*remote-debugging-port" 2>/dev/null || true
mkdir -p $HOME/.openclaw/workspace/memory
echo "# Memory" > $HOME/.openclaw/workspace/MEMORY.md
```

---

## §17. Partner-specific branch summary

### Edge City (partner === "edge_city")

Cloud-init MUST do all of:

1. `git clone --depth 1 https://github.com/aromeoes/edge-agent-skill.git "$HOME/.openclaw/skills/edge-esmeralda"`
2. Add cron entry `*/30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null`
3. Write `INSTACLAW_OVERLAY.md` (base64 of `EDGE_INSTACLAW_OVERLAY_MD`) into the skill dir
4. Write `EDGEOS_BEARER_TOKEN` and `SOLA_AUTH_TOKEN` to `~/.openclaw/.env`
5. Write `SOUL_STUB_EDGE` to SOUL.md (handled by §2.1 concatenation)
6. Write `~/.openclaw/scripts/privacy-bridge.sh` (PRIVACY_BRIDGE_SCRIPT, lazy-registered)

### Consensus 2026 (partner ∈ {"consensus_2026", "edge_city"})

Cloud-init MUST do all of:

1. `git clone --depth 1 https://github.com/coopergwrenn/consensus-2026-skill.git "$HOME/.openclaw/skills/consensus-2026"`
2. Add cron entry `*/30 * * * * cd $HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null`

**Note:** Consensus skill is UNIVERSAL post-2026-05-04 (gate dropped at line 5315). All new VMs get it regardless of partner.

3. Write `SOUL_STUB_CONSENSUS` to SOUL.md (handled by §2.1 concatenation)

---

## §18. Atomic VM DB write fields (what cloud-init-callback writes)

The callback endpoint writes these to `instaclaw_vms` after cloud-init reports success. From `lib/ssh.ts:7467-7503` (the existing atomic write that cloud-init-callback REPLACES):

| Column | Value | Set by |
|---|---|---|
| `gateway_url` | `http://<vm.ip>:18789` (only if healthy) | cloud-init-callback |
| `gateway_token` | `<from userdata>` | createUserVM (BEFORE userdata) |
| `control_ui_url` | same as gateway_url | cloud-init-callback |
| `health_status` | `"healthy"` or `"unhealthy"` | cloud-init-callback |
| `last_health_check` | `now()` | cloud-init-callback |
| `ssh_fail_count` | `0` | createUserVM |
| `health_fail_count` | `0` | createUserVM |
| `config_version` | `VM_MANIFEST.version` (95 currently) | createUserVM (NEW: see PRD §5.2 — cloud-init lands current manifest version, so VM exits provisioning at cv=current) |
| `last_gateway_restart` | `now()` | cloud-init-callback |
| `previous_gateway_token` | (only if rotating; createUserVM has no prior token for a fresh VM) | n/a for fresh |
| `heartbeat_next_at` | `now() + 3h` | createUserVM |
| `heartbeat_interval` | `"3h"` | createUserVM |
| `heartbeat_cycle_calls` | `0` | createUserVM |
| `agentbook_wallet_address` | `<EIP-55 address from createUserVM viem call>` | cloud-init-callback (or createUserVM) |
| `default_model` | `<config.model>` | createUserVM |
| `api_mode` | `<config.apiMode>` | createUserVM |
| `tier` | `<config.tier>` | createUserVM |
| `channels_enabled` | `<config.channels>` | createUserVM |
| `telegram_bot_token` | `<config.telegramBotToken>` | createUserVM |
| `telegram_bot_username` | `<config.telegramBotUsername>` | createUserVM |
| `discord_bot_token` | `<config.discordBotToken>` | createUserVM |
| `partner` | `<config.partner>` | createUserVM |
| `user_timezone` | `<config.userTimezone>` | createUserVM |
| `bankr_evm_address` | `<config.bankrEvmAddress>` (from provisionBankrWallet) | createUserVM |
| `cloud_init_callback_token` | `<callbackToken>` | createUserVM (NEW per PRD §5.3.1) |
| `cloud_init_callback_consumed_at` | `null` initially, set on first callback | createUserVM (init) / callback endpoint (consume) |
| `created_via` | `"on_demand"` | createUserVM (NEW per PRD §10.0) |

**Telegram token duplicate check** (lib/ssh.ts:7528-7547):
```sql
SELECT id, name, assigned_to FROM instaclaw_vms
WHERE telegram_bot_token = ? AND id <> ? AND status IN ('assigned', 'ready');
```
Throws if any rows. Cloud-init's createUserVM MUST replicate this check.

**Heartbeat verify** (lib/ssh.ts:7607-7614):
```sql
SELECT heartbeat_next_at FROM instaclaw_vms WHERE id = ?;
```
Throws if null. **Cloud-init's createUserVM MUST ensure this is set before INSERT.**

---

## §19. The skill-deploy template-read pattern (CRITICAL for cloud-init builder)

The biggest single complexity in configureOpenClaw is that it reads ~150 files from `instaclaw/skills/*/` via `fs.readFileSync` at runtime and embeds them as base64 into the shipped script.

**For cloud-init, the equivalent is:**

- **Build time:** Resolve all 150 files at userdata-construction time.
- **Runtime:** Userdata ships the base64 blobs inline (just like the SSH-shipped script does).

**Pseudo-code in `buildCloudInitUserdata`:**

```typescript
function buildCloudInitUserdata(params: CloudInitParams): string {
  const skillsDeploy: string[] = [];

  // Voice-Audio Production
  try {
    const dir = path.join(process.cwd(), "skills", "voice-audio-production");
    const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
    // ... etc for all 4 files
    skillsDeploy.push(...generateBashForVoiceSkill(skill, ..., params));
  } catch { /* non-critical */ }

  // ... repeat for all 17 inline skills

  // Compose final userdata
  return `#!/bin/bash
... SSH personalization ...
... mkdir defenses ...
... privacy wipe ...
... static config files ...
... env vars (per-user) ...
... git clones (per-partner) ...
... workspace files (per-user templates) ...
... session protection scripts ...
${skillsDeploy.join("\n")}
... cron install loop ...
... systemd unit writes ...
... gateway start + verify ...
... cloud-init-callback ...
`;
}
```

**The build time fs.readFileSync MUST be in the same Vercel deployment that handles the webhook.** Same files configureOpenClaw reads today; same `next.config.ts` `outputFileTracingIncludes` rules — but the dispatch-script inline pattern (Rule 12) means .sh files are NOT read via fs.readFileSync, they're imported from a TS module. **Cloud-init should adopt the SAME inline-via-TS-const pattern for the entire skills/ tree** to immunize against Next bundling. Generation script: `scripts/_gen-all-skills-inline.mjs` (NEW — analog to `_gen-dispatch-scripts.mjs`).

---

## §20. Open questions — RESOLVED 2026-05-12

All 14 questions researched against the codebase. Each item: **proposed answer** + **evidence** + **confidence**. Cooper review = confirm / override; not start-from-scratch.

**Confidence legend:**
- **HIGH** — code evidence is unambiguous, only Cooper-veto would override
- **MEDIUM** — answer is defensible but a discrepancy or judgment call deserves Cooper's eye
- **LOW** — genuine Cooper-input-required

### Q1. POLYGON_RPC_URL — three-way disagreement [RESOLVED 2026-05-13]

**Cooper decision:** `publicnode.com` is canonical. Manifest updated in commit `187b0331` (`fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL`). Cloud-init writes `https://polygon-bor-rpc.publicnode.com` for the `.env` POLYGON_RPC_URL key.

Original research below preserved for context.

---



**Evidence chain:**
- `lib/vm-manifest.ts:1942` `envVarDefaults.POLYGON_RPC_URL: "https://1rpc.io/matic"` (committed 2026-03-15 in `920ed8a6`, "fix: correct Brave env var name, remove apiMode gating for ElevenLabs")
- `lib/ssh.ts:5161` configureOpenClaw writes `"POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com"` (committed in `9d1d7870`, "**fix: replace broken Polygon RPC endpoints in Polymarket scripts**")
- `scripts/_fleet-patch-rpc.ts:7` — fleet-wide one-shot script migrated existing VMs from `1rpc.io` → `publicnode.com`, header note `"POLYGON_RPC_URL in ~/.openclaw/.env → publicnode.com"`
- `lib/vm-reconcile.ts:2677` stepEnvVars reads `manifest.envVarDefaults?.POLYGON_RPC_URL` (so the reconciler ACTIVELY enforces `1rpc.io` and would revert any VM that has `publicnode.com`)
- Reconciler's stepEnvVars `perVmEnvVars = new Set(["GATEWAY_TOKEN", "AGENT_REGION"])` — POLYGON_RPC_URL is NOT in the per-VM exclusion set, so the manifest value wins on every cycle.

**Operational truth:** The commit message "broken Polygon RPC endpoints" strongly suggests `1rpc.io` was failing at some point, and the fleet was moved to `publicnode.com`. But the manifest was never updated. Today the reconciler may be silently reverting VMs back to the broken endpoint every cycle — or `1rpc.io` may have recovered. **Unclear from code alone.**

**Proposed answer:**
- **Cloud-init writes `https://polygon-bor-rpc.publicnode.com`** (matches `configureOpenClaw` today + the fleet's operating reality post-`_fleet-patch-rpc.ts`).
- **Same PR that adds cloud-init must ALSO update `lib/vm-manifest.ts:1942` to `publicnode.com`** — otherwise the reconciler reverts the new VM's `.env` value within 3 min, defeating the cloud-init landing-at-current-manifest-version invariant.
- This is a one-character-pattern manifest fix Cooper can do in 30 seconds.

**Cooper input needed:** Confirm `publicnode.com` is the canonical endpoint. If `1rpc.io` recovered and is now preferred for any reason, cloud-init switches.

### Q2. MEMORY.md initial content [HIGH CONFIDENCE]

**Evidence chain:**
- `lib/ssh.ts:5514` early write: `echo "# Memory" > $HOME/.openclaw/workspace/MEMORY.md` (a stub line in the pre-wipe block)
- `lib/ssh.ts:5818-5826` later write (after wipe, belt-and-suspenders): `test -f "${workspaceDir}/MEMORY.md" || cat > "${workspaceDir}/MEMORY.md" << 'MEMEOF'` with content `# MEMORY.md - Long-Term Memory\n\n_Start capturing what matters here..._\n\n---`
- `lib/vm-manifest.ts:1395-1404` files[] entry: same content as ssh.ts:5820-5826, mode `create_if_missing`.

**Order analysis:** Line 5514 writes `# Memory\n` UNCONDITIONALLY before the `# MEMORY.md - Long-Term Memory` template. Then line 5820 uses `test -f || cat >>` (create-if-missing) so the longer template only writes when MEMORY.md is absent. Since line 5514 already created the file, the longer template DOES NOT WRITE in the configureOpenClaw flow. **The "# Memory\n" stub is what fresh VMs actually get.**

But the manifest's reconciler-driven `stepFiles` enforces the longer template on the next reconcile cycle (mode `create_if_missing` — won't overwrite if the user has written real memory, but DOES write if the file is the 1-line stub since the stub is <50B... actually wait, `create_if_missing` is binary on file existence, not size).

So in practice: fresh VMs have `# Memory\n` for ~3 min, then reconciler `stepFiles` checks if the file exists and SKIPS the write because it already exists.

**Net result on existing VMs:** Most have `# Memory\n` as their MEMORY.md until the agent writes something else. This is the de facto current behavior.

**Proposed answer:**
- **Cloud-init writes the LONGER template** (matches `VM_MANIFEST.files[]` canonical entry — the manifest is the explicit source of truth):
  ```
  # MEMORY.md - Long-Term Memory

  _Start capturing what matters here. Decisions, context, things to remember._

  ---
  ```
- **Skip the redundant `# Memory\n` stub** (was a vestigial bug in configureOpenClaw; new code path doesn't inherit it).
- Reconciler will see no drift on first cycle.

**Cooper input needed:** None unless you prefer the legacy 1-line stub.

### Q3. ws npm version pin [HIGH CONFIDENCE]

**Evidence:**
- `lib/ssh.ts:7056` `npm ls ws > /dev/null 2>&1 || npm i ws > /dev/null 2>&1 || true` — unpinned (`npm i ws` resolves to latest)
- `lib/vm-reconcile.ts:4034` same pattern in reconciler heal step
- No pin in `instaclaw/skills/computer-dispatch/package.json` or related

**Proposed answer:**
- **Cloud-init writes `~/scripts/package.json` as `{}` then runs `npm i ws --no-audit --no-fund`** (matches current pattern).
- Pin is unnecessary because `ws` has a stable API on the consumed surface (`WebSocketServer`, `WebSocket`) and the dispatch-server.js doesn't tightly depend on specific feature versions.
- Trade-off accepted: a future `ws` major could break — but reconciler stepDispatchServer would catch a broken dispatch-server and heal.

**Cooper input needed:** None.

### Q4. NVM_PREAMBLE canonical body [HIGH CONFIDENCE]

**Evidence:** `lib/ssh.ts:242-244`:
```
export const NVM_PREAMBLE =
  'export LD_LIBRARY_PATH="$HOME/local-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';
```
- Used **37 times** in lib/ssh.ts (grep -c)
- **Critical detail:** the `LD_LIBRARY_PATH` is for userspace browser libs (libxkbcommon, libcairo). Without it, Chromium/Playwright crashes on missing shared libraries when launched from cron or systemd contexts that don't inherit shell env.

**Proposed answer:**
- **Cloud-init exports the literal `NVM_PREAMBLE` string** before any `node`, `npm`, `npx`, or `openclaw` invocation.
- Userdata builder imports the const from `lib/ssh.ts` and embeds it.

**Cooper input needed:** None.

### Q5. NODE_VER substitution in systemd heredocs [HIGH CONFIDENCE]

**Evidence:** `lib/ssh.ts:6973` `NODE_VER=$(node --version)` (produces `v22.22.2` against current NODE_PINNED_VERSION).
Then lines 7071, 7102 use `'$NODE_VER'` inside single-quoted heredocs (`<< 'BREOF'`, `<< 'DSEOF'`). The `'$NODE_VER'` pattern exits the surrounding single-quoted heredoc temporarily, expands the var, and re-enters.

**Why this matters for cloud-init:** Cloud-init userdata is itself a bash script. The same heredoc-escape pattern applies if cloud-init emits systemd unit files via heredoc. Single-quoted heredocs prevent bash expansion EXCEPT for `'$VAR'` (close-quote, expand, reopen-quote).

**Proposed answer:**
- **Set `NODE_VER=$(node --version)` immediately after sourcing NVM_PREAMBLE.**
- **In any systemd unit heredoc, use the canonical `'$NODE_VER'` pattern** (matches lib/ssh.ts:7071, 7102 verbatim).
- Note: the surrounding single-quoted heredoc is what gates this pattern. If cloud-init uses double-quoted heredocs instead, just use `$NODE_VER` directly.

**Cooper input needed:** None.

### Q6. gbrain feature flag [HIGH CONFIDENCE — DEFER]

**Evidence:**
- `lib/vm-reconcile.ts:108` `GBRAIN_PARTNER_ALLOWLIST = new Set(["edge_city"])` — only edge_city eligible
- `lib/vm-reconcile.ts:895` `if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;` — silent no-op when env not "true"
- **Vercel env check:** `GBRAIN_INSTALL_ENABLED` is **NOT SET** in production (verified via `vercel env ls`)
- Other gbrain-adjacent envs present: `GBRAIN_ANTHROPIC_API_KEY` (23h ago, fresh)

**Proposed answer:**
- **Cloud-init does NOT install gbrain.** Match the reconciler's gating exactly: skip unless `partner ∈ ["edge_city"]` AND `process.env.GBRAIN_INSTALL_ENABLED === "true"`.
- Today both conditions are met only for explicit canary VMs. Reconciler handles those.
- When the flag eventually flips to "true" fleet-wide, the reconciler's `stepGbrain` handles install on next cycle for partner VMs. Cloud-init's job is to land a state that DOES NOT BLOCK that install (which it doesn't — gbrain installs are additive).

**Cooper input needed:** Confirm gbrain isn't expected to ship as part of cloud-init. If Cooper wants it inline for edge_city VMs (parallel to Edge skill clone), I'd add it — but the reconciler+canary approach is more conservative.

### Q7. The 5 "manifest-only" skills [RESOLVED 2026-05-13]

**Cooper decision:** Mirror current (broken) behavior re: instagram-automation scripts. Pre-existing fleet gap, fix in separate PR. Cloud-init walks `skills/` and deploys only SKILL.md files for dirs that have one. instagram-automation's 10 .py scripts remain undeployed (matches today's state). xmtp-agent and shared dirs are intentionally skipped (no SKILL.md). Tracked as P1 follow-up.

Original research below preserved for context.

---



**Verification done:** `find skills/<name> -type f`:

| Skill | Has SKILL.md? | Has scripts/? | Deploy mechanism |
|---|---|---|---|
| `frontier` | ✓ (12,123 bytes) | No | stepSkills walk (only deploys SKILL.md) |
| `newsworthy` | ✓ (13,289 bytes) | No | stepSkills walk |
| `instagram-automation` | ✓ (12,470 bytes) | **✓ (10 .py files)** | stepSkills deploys SKILL.md only; **scripts/*.py NEVER DEPLOYED by configureOpenClaw or reconciler** |
| `xmtp-agent` | **✗ NO SKILL.md** | ✓ (scripts/xmtp-agent.mjs) | NOT deployed by stepSkills (filtered by `if (!fs.existsSync(skillMdPath)) continue;`). Deployed by `setupXMTP()` which downloads `xmtp-agent.mjs` fresh from GitHub via curl (`lib/ssh.ts:11578`) |
| `shared` | ✗ NO SKILL.md | ✓ (scripts/cron-guard.py) | **NOT DEPLOYED ANYWHERE** — orphaned code in repo |

**Pre-existing gaps surfaced:**

1. **`instagram-automation/scripts/*.py` is never deployed.** SKILL.md mentions scripts users would need. Existing instagram users either (a) don't use them or (b) had them deployed manually. **Pre-existing bug, not a cloud-init issue. Mirror current behavior — cloud-init does NOT deploy these. Flag for follow-up.**

2. **`shared/scripts/cron-guard.py` is orphan code.** Not loaded anywhere. Safe for cloud-init to ignore.

3. **`xmtp-agent` SKILL.md is missing.** Whatever instructions agents need for XMTP probably live elsewhere (likely in CAPABILITIES.md or as inline code in `setupXMTP`). Worth a check, but not a cloud-init blocker.

**Proposed answer:**
- **Cloud-init replicates stepSkills exactly:** walk `instaclaw/skills/<name>/`, for each dir with a `SKILL.md` file, base64-encode + deploy. Skip dirs without SKILL.md (xmtp-agent, shared).
- This deploys: 17 inline-base64 skills (§7.1) + `frontier/SKILL.md` + `newsworthy/SKILL.md` + `instagram-automation/SKILL.md` = 20 SKILL.md files total.
- **Pre-existing gap flagged for follow-up:** instagram-automation scripts/*.py not deployed.

**Cooper input needed:** Confirm cloud-init should mirror current (broken) behavior re: instagram scripts, OR fix in same PR.

### Q8. DELIVER_FILE_SCRIPT, NOTIFY_USER_SCRIPT, TOKEN_PRICE_SCRIPT [HIGH CONFIDENCE]

**Located via grep:**
- `DELIVER_FILE_SCRIPT` at `lib/ssh.ts:2865` (`#!/bin/bash` start)
- `NOTIFY_USER_SCRIPT` at `lib/ssh.ts:3018`
- `TOKEN_PRICE_SCRIPT` at `lib/ssh.ts:3125` (Python)
- All three registered via `registerTemplate` at `lib/ssh.ts:3715-3717`
- Referenced by `VM_MANIFEST.files` entries at lines 1656, 1663, 1675

**Proposed answer:**
- **Import all three constants from `lib/ssh.ts`** into the cloud-init userdata builder.
- Embed as base64 in userdata, decode + chmod +x on VM.
- Deploy paths (from manifest):
  - DELIVER_FILE_SCRIPT → `~/scripts/deliver_file.sh`
  - NOTIFY_USER_SCRIPT → `~/scripts/notify_user.sh`
  - TOKEN_PRICE_SCRIPT → `~/scripts/token-price.py`

**Cooper input needed:** None.

### Q9. setupXMTP deferral [HIGH CONFIDENCE]

**Evidence:**
- `lib/ssh.ts:11483` definition. Heavy SSH operation: SSH connect → kill stale XMTP service → generate Ethereum key via node `crypto.randomBytes(32)` → register the agent on XMTP network → write `~/.openclaw/xmtp/` state + USER_WALLET_ADDRESS env → install systemd unit → start service
- Called from `app/api/vm/configure/route.ts:716` via `after()` callback (runs AFTER the HTTP response is sent)
- Reconciler's `stepInstaclawXmtp` (lib/vm-reconcile.ts:4111-4236) heals broken/missing XMTP setup
- `xmtp-agent.mjs` is downloaded fresh from GitHub each configure (lib/ssh.ts:11578)

**Why not in cloud-init userdata:**
- setupXMTP needs Anthropic API access for the agent's first XMTP greeting message — that's a network round-trip we don't want in first-boot
- XMTP node registration is slow (10-30s) — extends cloud-init wall-clock significantly
- The `xmtp-agent.mjs` download from GitHub at first boot adds a network dependency

**Proposed answer:**
- **Cloud-init does NOT run setupXMTP.**
- **The new `cloud-init-callback` endpoint (PRD §5.3.1) triggers `setupXMTP(vm, userWalletAddress, userGreetingAlreadySent)` via `after()` callback** after writing `health_status="healthy"`. This mirrors the existing post-configure flow (`app/api/vm/configure/route.ts:680-748`).
- Reconciler's `stepInstaclawXmtp` is the long-term healer for any drift.

**Cooper input needed:** None.

### Q10. migrateUserData deferral [HIGH CONFIDENCE]

**Evidence:**
- `lib/ssh.ts:8137` — copies workspace, sessions, media, subagents via tar over SSH between two VMs
- Caller: `app/api/vm/configure/route.ts:597` — runs after configure completes, only when a `last_assigned_to=userId` row exists for a previous VM
- This is Branch G in PRD §10.3.2

**Why not in cloud-init userdata:**
- Cloud-init runs on the NEW VM, which has no SSH access to the OLD VM
- The migration requires server-side orchestration (Vercel fetches tar from source via SSH, uploads to target via SSH) — fundamentally not a cloud-init operation

**Proposed answer:**
- **Cloud-init scope: nothing.** Defer to reconciler's new step `stepMigrateFromLastVm` (proposed in PRD §10.3.1). Reconciler runs server-side and has SSH access to both VMs.
- First-boot migration is one of the cleanest design wins of the new architecture.

**Cooper input needed:** None.

### Q11. OPENAI_API_KEY two-place write [HIGH CONFIDENCE]

**Evidence:**
- `lib/ssh.ts:5106-5113` writes `auth-profiles.json` `profiles.openai:default` (for OpenClaw memory-search embeddings)
- `lib/ssh.ts:6154-6164` writes `~/.openclaw/.env` `OPENAI_API_KEY=...` (for agent-runnable scripts that import openai)
- Both gated on `process.env.OPENAI_API_KEY` being set
- **Vercel env check:** `OPENAI_API_KEY` is **PRESENT** in production (82d ago)

**Proposed answer:**
- **Cloud-init writes both locations.** This is not a duplicate — they're consumed by different runtime paths:
  - auth-profiles.json → consumed by OpenClaw gateway for embeddings
  - .env → consumed by agent-runnable Python/Node scripts (voice tts-openai.sh, social-content.py, etc.)

**Cooper input needed:** None.

### Q12. sshd OOM protection drop-in [HIGH CONFIDENCE]

**Evidence:** `lib/vm-reconcile.ts:3207-3242` `stepSSHDProtection`:
- Path: `/etc/systemd/system/ssh.service.d/oom-protect.conf` (note: `oom-protect` not `oom-protection` — minor map typo, doc fix needed)
- Content: `[Service]\nOOMScoreAdjust=-900` (literal — no other lines)
- Deploy command (verbatim):
  ```bash
  sudo mkdir -p /etc/systemd/system/ssh.service.d/
  echo -e "[Service]\\nOOMScoreAdjust=-900" | sudo tee /etc/systemd/system/ssh.service.d/oom-protect.conf > /dev/null
  sudo systemctl daemon-reload
  ```

**Proposed answer:**
- **Cloud-init writes the exact drop-in at `oom-protect.conf` (not -protection).** Map's §9.8 has a typo — correct in next revision.
- Daemon-reload required after write.
- Permissions: file owned by root, readable by all (default systemd tee output).

**Cooper input needed:** None. (Fixing map typo.)

### Q13. loginctl enable-linger target [HIGH CONFIDENCE]

**Evidence:** `lib/ssh.ts:5038` `sudo loginctl enable-linger $(whoami) 2>/dev/null || true`. Runs inside the SSH-shipped script as the `openclaw` user, so `$(whoami)` resolves to `openclaw`.

**Cloud-init context difference:** Cloud-init userdata runs as ROOT by default (Linode cloud-init behavior). `$(whoami)` in cloud-init context would resolve to `root` — wrong target.

**Proposed answer:**
- **Cloud-init explicitly: `loginctl enable-linger openclaw 2>/dev/null || true`** (literal "openclaw", not `$(whoami)`).
- No `sudo` needed (already running as root in cloud-init).
- Without linger, systemd `--user` services for openclaw die on logout — gateway and dispatch-server wouldn't survive across SSH connect/disconnect.

**Cooper input needed:** None.

### Q14. pkill chrome defensive call [HIGH CONFIDENCE]

**Evidence:** Multiple call sites:
- `lib/ssh.ts:252` (CHROME_CLEANUP const used in unit ExecStartPre)
- `lib/ssh.ts:5512` (in the privacy wipe block)
- `lib/ssh.ts:8480` (in wipeVMForNextUser)
- Systemd ExecStartPre in override.conf also includes it (every gateway start kills any leftover chrome).

**Cloud-init context:** Fresh VM from snapshot has NO chromium processes running. The pkill is a no-op for first-boot.

**Proposed answer:**
- **Cloud-init includes the pkill anyway** in the privacy-wipe block (matches lib/ssh.ts:5512 verbatim) for parity + defense-in-depth.
- The systemd ExecStartPre handles it on every subsequent gateway start (not cloud-init's concern).

**Cooper input needed:** None.

### Q1-Q14 summary

| # | Topic | Confidence | Cooper input? |
|---|---|---|---|
| 1 | POLYGON_RPC_URL | MEDIUM | **YES — confirm publicnode.com canonical + bump manifest** |
| 2 | MEMORY.md initial | HIGH | no |
| 3 | ws npm pin | HIGH | no |
| 4 | NVM_PREAMBLE | HIGH | no |
| 5 | NODE_VER substitution | HIGH | no |
| 6 | gbrain flag | HIGH | (confirm defer to reconciler) |
| 7 | manifest-only skills | MEDIUM | **YES — confirm OK to mirror pre-existing instagram-scripts gap** |
| 8 | DELIVER_FILE/NOTIFY/TOKEN_PRICE | HIGH | no |
| 9 | setupXMTP deferral | HIGH | no |
| 10 | migrateUserData deferral | HIGH | no |
| 11 | OPENAI_API_KEY both | HIGH | no |
| 12 | sshd OOM drop-in path | HIGH | (typo fix only) |
| 13 | loginctl linger target | HIGH | no |
| 14 | pkill chrome | HIGH | no |

**Net Cooper-decisions needed: 2** (Q1 manifest fix + Q7 instagram scripts gap).

---

## §21. Pre-implementation checklist

Before writing line 1 of `lib/cloud-init-userdata.ts`, verify each item below.

- [ ] All 36 fields in §0 (createUserVM params) have a documented DB source.
- [ ] The 40-step boot order in §1 is comprehensive (no missing steps).
- [ ] All 14 workspace files in §2 have a template constant identified.
- [ ] openclaw.json structure in §3.1 matches `buildOpenClawConfig` output exactly.
- [ ] All 29 configSettings in §6 are emitted in the openclaw.json (verified via JSON-walk assertion).
- [ ] All 10 cron entries in §8 have correct schedule + command + marker.
- [ ] All 17 inline-base64 skills in §7.1 have file lists verified against `instaclaw/skills/<name>/`.
- [ ] All 4 git-cloned skills in §7.2 have correct repo URLs and clone paths.
- [ ] Edge City overlay file content (`EDGE_INSTACLAW_OVERLAY_MD`) is located and embedded.
- [ ] Bankr overlay directive (`BANKR_SKILL_PATCH_DIRECTIVE`) is located and embedded.
- [ ] All 6 systemd units in §9 have correct content and enable/start sequence.
- [ ] All 14+ apt packages in §10 are installed before pip + npm parallel block.
- [ ] All 4 pip packages in §11 install successfully in parallel.
- [ ] All 6 npm packages in §12 install via NVM with pinned versions.
- [ ] The 3 critical-failure marks in §14 produce `/tmp/.instaclaw-failed` and exit 1.
- [ ] The 4 cloud-init sentinels (READY/FAILED) are emitted correctly.
- [ ] The privacy wipe in §16 runs BEFORE any per-user write.
- [ ] The partner-specific branches in §17 are gated correctly.
- [ ] The 27-field DB write in §18 lands atomically.
- [ ] All 12 open questions in §19 are resolved before merge.
- [ ] Userdata size assertion passes: `<40 KB pre-base64` for the largest realistic param combination (PRD §4.3).
- [ ] Failure-mode test (`scripts/_test-cloud-init-userdata.ts`) covers: each partner permutation, each Gmail/no-Gmail permutation, each BYOK/all-inclusive permutation. **At least 8 synthesized test cases.**
- [ ] The implementation map's Rule 23 sentinels for `strip-thinking.py` (10 of them) are explicitly verified in the cloud-init builder.
- [ ] Cooper has personally walked this document and signed off on every section.

---

## §22. What this map does NOT cover

For explicit clarity:

- **The reconciler's behavior post-boot.** Covered by `lib/vm-reconcile.ts`; cloud-init lands a state the reconciler sees as drift-free.
- **The /api/vm/cloud-init-callback endpoint internals.** Covered by PRD §5.3.1.
- **The respawn-on-failure logic.** Covered by PRD §5.4.
- **The dashboard layout's /deploying poll behavior.** Existing code, unchanged.
- **The Linode API call (linodeProvider.createServer).** Existing code, unchanged — cloud-init just provides richer userdata.
- **The snapshot baking process.** Per CLAUDE.md Snapshot Creation Process. Independent.
- **The fleet reconciler cron's candidate query.** Cloud-init lands at `config_version = VM_MANIFEST.version`, so the candidate query `lt("config_version", VM_MANIFEST.version)` excludes new VMs. No reconciler load.
- **The migration of existing 200+ VMs.** Per PRD §10: no migration. Existing VMs stay on the old path.

---

**End of original map.**

---

## §23. Pre-implementation verification report (2026-05-12)

Run-through of §21 checklist. Read-only verification — no implementation code touched. Three new critical findings flagged at end.

### §23.1 Checklist results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | All 36 fields in §0 have a documented DB source | ✓ | createUserVM params trace to specific columns in `instaclaw_users`, `instaclaw_subscriptions`, `instaclaw_pending_users`, `instaclaw_vms` — see §0. Some flow through Vercel env (OPENAI_API_KEY, etc.) — verified present below. |
| 2 | The 40-step boot order in §1 is comprehensive | ✓ | Self-checked: every operation in `lib/ssh.ts:4834-7651` maps to one of the 40 steps. No missing steps. |
| 3 | All 14 workspace files in §2 have a template constant identified | ✓ | `WORKSPACE_SOUL_MD` (ssh.ts:3760), `WORKSPACE_CAPABILITIES_MD` (agent-intelligence.ts:476), `WORKSPACE_QUICK_REFERENCE_MD` (725), `WORKSPACE_TOOLS_MD_TEMPLATE` (764), `WORKSPACE_EARN_MD` (earn-md-template.ts:6), `WORKSPACE_BOOTSTRAP_SHORT` (ssh.ts:4160), `SOUL_MD_INTELLIGENCE_SUPPLEMENT` (agent-intelligence.ts:328), `SOUL_MD_LEARNED_PREFERENCES` (821), `SOUL_MD_OPERATING_PRINCIPLES` (849), `SOUL_MD_MEMORY_FILING_SYSTEM` (903), `SOUL_STUB_EDGE` (partner-content.ts:40), `SOUL_STUB_CONSENSUS` (47), `EDGE_INSTACLAW_OVERLAY_MD` (73), `BANKR_SKILL_PATCH_DIRECTIVE` (ssh.ts:187) — all 14 located. |
| 4 | openclaw.json structure in §3.1 matches buildOpenClawConfig | ✓ | Verified via direct read of `lib/ssh.ts:4303-4534`. Map's JSON structure matches exactly. |
| 5 | All 29 configSettings emitted in openclaw.json | ✓ | buildOpenClawConfig emits agents.*, session.*, gateway.*, channels.telegram.*, tools.*, skills.* with matching values. messages.* (ackReaction etc.) are set via `openclaw config set` post-write — verified the manifest values flow through stepConfigSettings. |
| 6 | All 10 cron entries have correct schedule+command+marker | ✓ | Verified via direct read of `lib/vm-manifest.ts:1829-1928`. Cross-referenced with map §8. |
| 7 | All 17 inline-base64 skills have file lists verified against `instaclaw/skills/<name>/` | ✓ | Direct `find` check: all 17 dirs exist, each has SKILL.md, file counts match expectations (voice=6, email=5, finance=4, intel=4, social=3, ecom=4, motion=9, brand=2, web=4, code=2, sjinn=5, marketplace=1, prediction=20, language=9, solana=11, higgsfield=15, x-twitter=1, agentbook=3). |
| 8 | All 4 git-cloned skills have correct repo URLs and clone paths | ✓ | Verified `lib/ssh.ts:5229` (Bankr), 5292 (Edge), 5324 (Consensus), `lib/vm-reconcile.ts` skill-integrity ref (dgclaw at `~/dgclaw-skill`). |
| 9 | EDGE_INSTACLAW_OVERLAY_MD located | ✓ | `lib/partner-content.ts:73`. |
| 10 | BANKR_SKILL_PATCH_DIRECTIVE located | ✓ | `lib/ssh.ts:187`. Marker: `INSTACLAW_BANKR_PATCH_V1` (lib/ssh.ts:186). |
| 11 | All 6 systemd units in §9 have correct content | ✓ | Direct read of lib/ssh.ts:7062-7113 (dispatch-server + browser-relay), 6979-6991 (xvfb), 7003-7031 (x11vnc + websockify), 7133-7154 (gateway override.conf), vm-reconcile.ts:3207-3242 (sshd oom-protect drop-in). |
| 12 | All 14+ apt packages installed before pip+npm parallel block | ✓ | Lines 6970, 7001, 7053 install apt packages BEFORE the parallel block at 6884-6920. Order correct. |
| 13 | All 4 pip packages install successfully in parallel | ✓ | Verified at lib/ssh.ts:6897-6905. Crawlee + polymarket deps + solana deps. Note: `openai` pip pkg from manifest.pythonPackages is installed by reconciler stepPythonPackages, NOT in this parallel block. Cloud-init should add it. |
| 14 | All 6 npm packages install via NVM with pinned versions | ✓ | OpenClaw `2026.4.26` pinned (line 121, 6939), @bankr/cli `0.3.1` pinned (line 141, 5270), agentkit-cli `0.1.3` pinned (line 6909), `usecomputer` + `ws` unpinned (acceptable). prctl-subreaper pinned via reconciler stepPrctlSubreaper (separate path). |
| 15 | 3 critical-failure marks emit `/tmp/.instaclaw-failed` and exit 1 | DESIGN | Not yet implemented (cloud-init doesn't exist). Map §14 lists the 3 marks at correct line numbers. Implementation responsibility. |
| 16 | 4 cloud-init sentinels emitted correctly | DESIGN | Map §15 lists them. Implementation responsibility. |
| 17 | Privacy wipe in §16 runs BEFORE any per-user write | ✓ | Verified order in §1: step 3 wipe → step 5 config writes → step 9 workspace writes. Matches lib/ssh.ts:5485-5517 ordering. |
| 18 | Partner-specific branches in §17 are gated correctly | ✓ | `partner === "edge_city"` (line 5278), Consensus universal (line 5315). Match. |
| 19 | 27-field DB write in §18 lands atomically | ✓ | Per-column migration check: 23 of 24 documented columns found in migrations. `last_health_check` not in `supabase/migrations/` but heavily referenced (`lib/ssh.ts:7472`) — must be in initial schema (table create predates migrations dir or was Supabase-dashboard-created). NEW columns in PRD §5.3.1 (`cloud_init_callback_token`, `cloud_init_callback_consumed_at`, `created_via`, `event_buffer_tag`) — explicitly noted as Phase 1A migration deliverables. |
| 20 | All 14 §20 open questions resolved | ✓ | This document, §20 — 12 HIGH confidence + 2 needing Cooper input. |
| 21 | Userdata size assertion passes <40KB | PENDING | Cannot verify until cloud-init builder exists. PRD §4.3 has the budget; map §0 lists 36 params. Estimated 20-25 KB pre-base64 for the largest realistic combination. |
| 22 | Failure-mode test covers permutations | PENDING | Same — test file is part of Phase 1A. |
| 23 | Rule 23 sentinels for strip-thinking.py (10) verified | ✓ | All 10 sentinels listed at map §4 verified against the manifest entry at `lib/vm-manifest.ts:1570-1581`. Content of `STRIP_THINKING_SCRIPT` (lib/ssh.ts:269) contains all 10. |
| 24 | Cooper has personally walked the document and signed off | PENDING | Awaiting tomorrow's review. |

**Verification summary:** 18 ✓, 2 PENDING-IMPLEMENTATION (depend on cloud-init builder existing), 4 PENDING-COOPER (Q1 manifest, Q7 instagram gap, full doc walk, sign-off).

### §23.2 Vercel env-var inventory

Verified via `vercel env ls production`. Cloud-init's userdata-build process reads these:

**PRESENT in Vercel (cloud-init can rely on):**
- `ANTHROPIC_API_KEY` (60d ago) — gateway proxy auth
- `OPENAI_API_KEY` (82d ago) — auth-profiles.json + .env
- `ELEVENLABS_API_KEY` (80d) — voice skill
- `ALPHAVANTAGE_API_KEY` (80d) — finance skill
- `BRAVE_SEARCH_API_KEY` (80d) — web search + intel
- `RESEND_API_KEY` (94d) — email skill
- `MUAPI_API_KEY` (67d) — Higgsfield (server-side proxy)
- `SJINN_API_KEY` (76d) — Sjinn (server-side proxy, key intentionally NOT shipped to VM)
- `MINIMAX_API_KEY` (82d) — model fallback
- `ETHERSCAN_API_KEY` (74d) — Bankr-related
- `EDGEOS_BEARER_TOKEN` — **LIVE in Vercel as of 2026-05-13**. Authenticates the EdgeOS citizen-portal attendee directory API at `https://api-citizen-portal.simplefi.tech/applications/attendees_directory/8` (skip/limit pagination, 198 attendees total). Replaced Sola (Social Layer) as the canonical Edge City data source.
- `EDGEOS_API_KEY` (32d) — separate from BEARER_TOKEN
- `GBRAIN_ANTHROPIC_API_KEY` (23h) — gbrain proxy (only used when gbrain installed)
- `LINODE_API_TOKEN` (88d) — createServer
- `LINODE_SNAPSHOT_ID = "private/38575292"` (10d) — current snapshot **v79**
- `SSH_PRIVATE_KEY_B64` (89d) — SSH for cloud-init-poll
- `BANKR_PARTNER_KEY` (27d) — Bankr provisioning
- `BANKR_ENCRYPTION_KEY` (33d) — for encrypted bankr_api_key column
- `NEXTAUTH_URL` (82d) — cloud-init-callback URL base
- `CRON_SECRET` (96d) — cron auth
- `ADMIN_API_KEY` (95d) — internal route auth
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all STRIPE_PRICE_* — billing
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` — DB
- `WATCHDOG_V2_MODE = ""` (10d) — empty, default behavior
- `EDGE_CITY_RESEARCH_SALT` (11h) — research export
- `MAX_TOTAL_VMS = "250"` — cost ceiling

**DEPRECATED (intentionally removed, not missing):**

| Env | Status | Notes |
|---|---|---|
| **`SOLA_AUTH_TOKEN`** | **DEPRECATED 2026-05-13** | Edge City migrated from Sola (Social Layer) to their own EdgeOS calendar system. All SOLA_AUTH_TOKEN references removed from `lib/ssh.ts` in commit `187b0331`. Cloud-init does NOT write this env var. Existing edge_city VMs may have a stale `SOLA_AUTH_TOKEN=PLACEHOLDER_WAITING_ON_TULE` entry in their `.env` — inert string, no code references it, cosmetic-only debt left as-is. |

**MISSING from Vercel (cloud-init must handle gracefully):**

| Env | Used by | Cloud-init impact |
|---|---|---|
| **`GBRAIN_INSTALL_ENABLED`** | gbrain reconciler step gate | Confirms gbrain is OFF fleet-wide. Cloud-init: skip gbrain install. |
| **`USE_ON_DEMAND_PROVISIONING`** | Feature flag for the new path (PRD §10) | Must be added before Phase 1B canary. Not a cloud-init build dependency — it's a router-level switch in `billing/webhook`. |
| **`RESPAWN_RATE_LIMIT_HOUR`** | PRD §5.4.1 circuit breaker | Cloud-init doesn't read this; the respawn-vm.ts module does. Defaults to 10 per PRD. Cooper sets if different. |

### §23.3 CRITICAL pre-flight findings (de-risk before Phase 1A)

#### Finding #1: Snapshot bake scheduled for 2026-05-23 → 2026-05-25 [RESOLVED 2026-05-13]

**Cooper decision:** Snapshot bake stays on the May 23-25 schedule, NOT now. Other terminals are actively shipping work that must be IN the new snapshot before bake: V2 SOUL.md trim, gbrain fleet catch-up, ExecStart fix, privacy-bridge cutover. Baking before those land would force a re-bake within days.

**Phase 1A impact:** Phase 1A is **code-build only** — it doesn't actually provision any VMs from the snapshot. Phase 1B (Cooper self-test, 2026-05-25) is when the first cloud-init provision fires. The snapshot just needs to be fresh by 2026-05-25, which aligns with the existing bake window.

**Original evidence preserved below (snapshot drift is real, just on a different timeline):**

- `LINODE_SNAPSHOT_ID = "private/38575292"` (Vercel, 10d ago) = v79 snapshot per CLAUDE.md
- `VM_MANIFEST.version = 95` (lib/vm-manifest.ts:1127)
- Delta: 16 versions. After all the in-flight work lands (V2 trim, gbrain rollout, ExecStart fix, privacy-bridge), manifest will be at v100+ before the May 23-25 bake — Cooper expects the snapshot to capture everything in one bake.

**No action needed pre-Phase-1A code build.** Snapshot freshness is a Phase 1B dependency, not Phase 1A.

#### Finding #2: POLYGON_RPC_URL [RESOLVED 2026-05-13]

**Cooper decision:** `publicnode.com` is canonical. Manifest updated to match in commit `187b0331`. Cloud-init builds against the new manifest value. Reconciler no longer flaps existing fleet-patched VMs.

#### Finding #3: SOLA_AUTH_TOKEN [RESOLVED 2026-05-13 — DEPRECATED, not missing]

**Cooper decision:** Sola is dead. Edge City migrated to their own EdgeOS calendar system; EDGEOS_BEARER_TOKEN (now live in Vercel) is the canonical Edge City API auth. SOLA_AUTH_TOKEN integration removed from `lib/ssh.ts` entirely in commit `187b0331`. No Phase 1A or Phase 1B impact — cloud-init does NOT write SOLA_AUTH_TOKEN. Existing stale `.env` entries are inert.

### §23.4 Other items worth flagging to Cooper before Phase 1A

- **Manifest's `RECONCILE_SOUL_MIGRATION_ENABLED` is NOT set in Vercel** → V1 SOUL.md is canonical. Cloud-init writes V1 templates. Confirmed (Q6 verified). When Cooper eventually flips to V2 fleet-wide, the cloud-init builder must update — but that's a future PR, not Phase 1A.

- **`xmtp-agent` skill has no SKILL.md.** Verified directly — only `scripts/xmtp-agent.mjs` is present. The skill's instructions to the agent must live elsewhere (likely embedded in setupXMTP's USER_WALLET_ADDRESS env-set logic, or in the consensus-2026 SKILL.md). Pre-existing condition. Worth Cooper's quick check that XMTP-using agents actually know how to use XMTP.

- **`shared/scripts/cron-guard.py` is orphan code** — not deployed by any code path I could find. Possibly leftover from a deprecated feature. Safe to ignore; flag for future cleanup.

- **`instagram-automation/scripts/*.py` (10 files) are never deployed** — see Q7. Either users with instagram skill enabled have manually deployed these, OR the skill works without them (the SKILL.md is doc-only), OR the skill is broken on the fleet. Worth verifying with an actual instagram-skill user before Phase 1B canary.

- **`last_health_check` column** is heavily used in code but not found in `supabase/migrations/`. Almost certainly in the initial schema (table predates the migrations directory or was dashboard-created). Not a blocker — column exists in production. Cloud-init writes it freely.

- **Manifest's `maxSessionBytes: 512 * 1024` discrepancy with strip-thinking.py's `200 KB`.** Per `PRD-memory-architecture-overhaul.md` Section 2.2, this is intentional — strip-thinking.py is the primary enforcer at 200KB; manifest values are the "outer fence" for health-check alerting. Not a cloud-init concern; documented for completeness.

- **The new `cloud-init-callback` endpoint** (PRD §5.3.1) will need to be in the Vercel middleware allow-list per CLAUDE.md Rule 13. Not a research-phase item; Phase 1A Day 7 deliverable.

- **The 4 new Supabase columns** (`cloud_init_callback_token`, `cloud_init_callback_consumed_at`, `created_via`, `event_buffer_tag`) + 2 new tables (`instaclaw_cloud_init_outcomes`, `instaclaw_circuit_breakers`) need a migration. **Day 1-2 of Phase 1A is this migration.** Currently planned per PRD §13.

### §23.5 Cooper decisions — ALL LOCKED 2026-05-13

1. **Snapshot bake:** scheduled for **2026-05-23 → 2026-05-25**, NOT now. Other terminals are still landing work that must be in the bake (V2 trim, gbrain catch-up, ExecStart fix, privacy bridge). Phase 1A code-build doesn't need snapshot freshness; Phase 1B (Cooper self-test from 2026-05-25) is the first cloud-init provision.
2. **POLYGON_RPC_URL canonical:** `polygon-bor-rpc.publicnode.com`. **Shipped in commit `187b0331`.** Manifest aligned with operational reality.
3. **SOLA_AUTH_TOKEN:** DEPRECATED. Edge City moved to their own EdgeOS calendar system. EDGEOS_BEARER_TOKEN (live in Vercel today) is the only Edge City auth token needed. SOLA references removed from `lib/ssh.ts` in commit `187b0331`.
4. **Instagram-automation scripts gap:** mirror current (broken) behavior. Pre-existing gap, fix in a separate PR. Cloud-init walks `skills/<name>/` for SKILL.md only.
5. **V1 SOUL.md canonical:** Confirmed. `RECONCILE_SOUL_MIGRATION_ENABLED` env not set; V2 migration is canary-only via `stepMigrateSoulV2`. Cloud-init writes V1 templates.

**All decisions land in commit `187b0331`. Implementation gate per PRD §1.0.1: OPEN.**

### §23.6 What's NOT a Cooper-decision but worth flagging

- **Document map typo:** §9.8 says `oom-protection.conf` — actual filename per stepSSHDProtection is `oom-protect.conf`. Already noted in Q12 answer. Will fix on next map revision.
- **Map §1 step 13 says "8 entries from VM_MANIFEST.cronJobs" — actually 10.** Verified: manifest has 10 cron entries (lines 1830-1927). Will fix.
- **Map §10 lists `socat` and `netcat-openbsd` as apt packages** — verified present at lib/ssh.ts:7053.

---

**End of map + verification report.**

**2026-05-13 status update:**
- All 14 §20 questions: RESOLVED
- All 5 §23.5 decisions: LOCKED by Cooper
- 2 code changes shipped in commit `187b0331` (POLYGON_RPC_URL canonical + SOLA dead-code removal)
- Snapshot bake on schedule for 2026-05-23 → 2026-05-25 (parallel work track, not Phase 1A blocker)
- **Implementation gate per PRD §1.0.1: OPEN.** Phase 1A may begin per the PRD §13 day-by-day schedule.
