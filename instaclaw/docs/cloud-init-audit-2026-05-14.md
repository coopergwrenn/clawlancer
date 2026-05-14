# Cloud-Init Wrapper Audit — Paranoid Mode

**Author:** Claude (Opus 4.7) for Cooper Wrenn
**Date:** 2026-05-14
**Trigger:** Cooper's directive to stop and audit before Day 8 ships.
**Scope:** Everything in `lib/cloud-init-tarball.ts`, `lib/cloud-init-setup-sh.ts` (WIP), `lib/cloud-init-userdata.ts`, `scripts/_test-cloud-init-tarball.ts`, plus cross-reference against `lib/ssh.ts:configureOpenClaw` (lines 4830-7651, ~2,822 lines).

**Headline:** the audit found **several byte-parity-breaking bugs** I would not have caught with the existing tests. The "byte-parity with the SSH path" claim in commit messages is **not yet substantiated** — none of my tests actually compared against SSH-path output. The chunk-1 wrappers (IDENTITY.md, WALLET.md, WORLD_ID.md, .env, auth-profiles.json) are **hand-written from the contract doc**, NOT lifted from SSH-path content. They produce plausible-looking files that differ from what `configureOpenClaw` actually writes.

This is exactly the failure mode Cooper feared: looks right, silently wrong.

## §1. Byte-parity bugs (BLOCKING — Phase 1B-2 will fail)

### §1.1 `buildIdentityMd` — completely different content from SSH path

**My wrapper** (lib/cloud-init-tarball.ts:381-399) emits:
```markdown
# Identity

## Bot Identity

You are connected via Telegram bot **@{telegramBotUsername}**.

When asked your name, identify with the bot handle above. Do not reveal
internal usernames, file paths, or implementation details.

Bot username: @{telegramBotUsername}
User ID:      {userId}
VM:           {vmName}

<!-- INSTACLAW_IDENTITY_V1 -->
```

**SSH path** (lib/ssh.ts:5849-5864) emits:
```markdown
# IDENTITY.md - Who Am I?

- **Name:** {agentName-derived-from-botUsername}
- **Creature:** AI agent — resourceful, capable, always learning
- **Vibe:** Direct, helpful, genuine. Gets things done.
- **Telegram:** @{botUsername}

---

You are {agentName}. That's your name.
When someone asks who you are, you say "I'm {agentName}" — not "I'm an AI assistant."
You're a personal AI agent on InstaClaw.

_Update this file as your personality develops. Make it yours._
```

**Differences:**
- Heading text different (`# Identity` vs `# IDENTITY.md - Who Am I?`)
- SSH derives an `agentName` from botUsername via regex (`Mucus09bot` → `Mucus`). My wrapper doesn't do this.
- SSH has Creature/Vibe lines my wrapper lacks.
- SSH has an explicit `You are {agentName}` statement. Mine has no name claim.
- My wrapper includes UserID + VM in the file. SSH doesn't.
- My wrapper has an INSTACLAW_IDENTITY_V1 sentinel. SSH has none.

**Impact:** Phase 1B-2 byte compare fails on every cloud-init-provisioned VM. The agent's first-message identity behavior diverges — SSH-path agents say "I'm Mucus" but cloud-init-path agents have no name to say.

**Why I missed it:** my docstring at line 374 claims "Mirrors lib/ssh.ts:configureOpenClaw's IDENTITY.md write" — that claim is **false**. I didn't cross-reference. My test (`id.includes('@fucking1999_bot')` + `id.includes('<!-- INSTACLAW_IDENTITY_V1 -->')`) only checks two strings, neither of which exists in the SSH-path output.

### §1.2 `buildWalletMd` — substantially less content than SSH path

**My wrapper** (lib/cloud-init-tarball.ts:407-442) emits ~10 lines.

**SSH path** (lib/ssh.ts:~5500-5582) emits ~50+ lines including:
- A `## Wallet Summary` section listing Bankr / Virtuals / AgentBook wallets
- A `## Key Rules` section
- A more elaborate `## Your Token` section (with BaseScan link, Bankr launches link, fee mechanics, "do NOT attempt to launch another token" guard)
- Bankr section explains creator share % + token-launch fee
- AgentBook section refers to World ID purpose

**Impact:** Phase 1B-2 byte compare fails. Agent's wallet knowledge differs significantly.

**Why I missed it:** same pattern — wrote from scratch using the contract doc as a sketch, not lifting from the SSH path.

### §1.3 `buildWorldIdMd` — different content + WORLD_ID env vars missing

**My wrapper** (lib/cloud-init-tarball.ts:450-464) emits:
```markdown
# World ID

Your human is verified-human via World ID (verification level: orb).

Nullifier hash: `0x...`

This human-uniqueness signal is verifiable on-chain via the World ID protocol.

<!-- INSTACLAW_WORLD_ID_V1 -->
```

**SSH path** (lib/ssh.ts:5347-5363) emits:
```markdown
# World ID Verification

**Status:** Verified (orb level)
**Nullifier Hash:** 0x...

## What This Means
You are backed by a World ID verified human. Your nullifier hash is a
privacy-preserving cryptographic identifier that proves a unique real person
operates this agent — without revealing who they are.

## How to Use
- When asked about your identity: you can state you are World ID verified
- Your nullifier: `0x...`
- Verification level: orb
- This proof may be used in the future to bypass Cloudflare bot challenges
```

**Differences:** completely different structure, content, section headers.

**Additionally:** the SSH path ALSO writes `WORLD_ID_NULLIFIER=...` + `WORLD_ID_LEVEL=...` to `.env` (lines 5338-5343). **My `buildDotEnv` doesn't emit these env vars.** Cloud-init-provisioned VMs that have World ID would be missing 2 env vars that other VMs have.

### §1.4 `buildAuthProfilesJson` — 4 distinct bugs

**SSH path** (lib/ssh.ts:5086-5117) produces:
```json
{"profiles":{"anthropic:default":{"type":"api_key","provider":"anthropic","key":"<apiKey>","baseUrl":"<proxyBaseUrl-if-truthy>"},"openai:default":{"type":"api_key","provider":"openai","key":"<env.OPENAI_API_KEY>"}}}
```
(no indent, no trailing newline, openai profile ONLY IF `process.env.OPENAI_API_KEY` is set)

**My wrapper** (lib/cloud-init-tarball.ts:475-504) produces:
```json
{
  "profiles": {
    "anthropic:default": {
      "type": "anthropic",
      "provider": "anthropic",
      "key": "<gatewayToken-or-apiKey>",
      "baseUrl": "<proxyBaseUrl>"
    },
    "openai:default": {
      "type": "openai",
      "provider": "openai",
      "key": "<gatewayToken-or-apiKey>"
    }
  }
}
```
(2-space indent, trailing newline, openai profile ALWAYS present)

**Bugs:**
1. `type` field: my wrapper uses `"anthropic"` / `"openai"`. SSH uses `"api_key"` for both. **WRONG.**
2. OpenAI profile presence: my wrapper always emits it. SSH only emits when `process.env.OPENAI_API_KEY` is set. **WRONG.**
3. OpenAI key value: my wrapper uses the Anthropic key. SSH uses `process.env.OPENAI_API_KEY`. **WRONG.**
4. JSON format: my wrapper indents + adds trailing newline. SSH outputs compact JSON. **WRONG (byte-parity fails).**

**Impact:** auth-profiles.json bytes differ. Anthropic SDK may behave differently based on `type` field (need to verify). OpenAI memory-search embeddings will use the wrong key on cloud-init-provisioned VMs (Anthropic key sent to OpenAI API = 401).

**TarballParams gap:** I need to add `openaiApiKey?: string | null` to TarballParams so the endpoint can source it from `process.env.OPENAI_API_KEY`.

### §1.5 `.env` — multiple env vars not emitted

`buildDotEnv` emits 11 env vars conditionally (GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, INSTACLAW_USER_ID, INSTACLAW_VM_NAME, INSTACLAW_NEXTAUTH_URL, AGENTBOOK_ADDRESS, BANKR_WALLET_ADDRESS, BANKR_API_KEY, USER_TIMEZONE, POLYGON_RPC_URL, CLOB_PROXY_URL, CLOB_PROXY_URL_BACKUP, AGENT_REGION, EDGEOS_BEARER_TOKEN).

**SSH path emits these env vars that my wrapper does NOT:**
- `INSTACLAW_MUAPI_PROXY=https://instaclaw.io` (line 5356)
- `BANKR_TOKEN_ADDRESS` (line 5384, if config.bankrTokenAddress set)
- `BANKR_TOKEN_SYMBOL` (line 5387, if config.bankrTokenSymbol set)
- `WORLD_ID_NULLIFIER` (line 5340, if worldIdNullifier set)
- `WORLD_ID_LEVEL` (line 5343, if worldIdLevel set)
- `ELEVENLABS_API_KEY` (line 6137, conditional on user config — likely BYOK only)
- `RESEND_API_KEY` (line 6205, BYOK)
- `ALPHAVANTAGE_API_KEY` (line 6256, BYOK)
- `BRAVE_SEARCH_API_KEY` (line 6310, BYOK)
- `OPENAI_API_KEY` (line 6333, server-side env-var passthrough)

**Impact:** Bankr-tokenized agents missing their own token address/symbol in env. World-ID-verified agents missing the env vars that scripts may read. ELEVENLABS/RESEND/ALPHAVANTAGE features broken for BYOK users.

## §2. Files the SSH path writes that have NO cloud-init wrapper

Every file `configureOpenClaw` writes (line 4830-7651 grep result):

| Path | Wrapper status |
|---|---|
| `~/.openclaw/openclaw.json` | ✓ wrapper #5 (buildOpenClawJsonForTarball) |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | ⚠ COVERED BUT BUGGY (§1.4) |
| `~/.openclaw/exec-approvals.json` | ❌ NOT COVERED |
| `~/.openclaw/.openclaw-pinned-version` | ❌ NOT COVERED |
| `~/.openclaw/.env` (multiple env vars) | ⚠ PARTIALLY COVERED (§1.5) |
| `~/.openclaw/workspace/WORLD_ID.md` | ⚠ COVERED BUT BUGGY (§1.3) |
| `~/.openclaw/workspace/IDENTITY.md` | ⚠ COVERED BUT BUGGY (§1.1) |
| `~/.openclaw/workspace/WALLET.md` | ⚠ COVERED BUT BUGGY (§1.2) |
| `~/.openclaw/workspace/BOOTSTRAP.md` | ✓ wrapper #1 (buildBootstrapMd) |
| `~/.openclaw/workspace/USER.md` | ✓ wrapper #2 (buildUserMdForTarball) |
| `~/.openclaw/workspace/MEMORY.md` | ✓ wrapper #4 (buildMemoryMdForTarball) |
| `~/.openclaw/agents/main/agent/MEMORY.md` | ✓ wrapper #4 (double-write) |
| `~/.openclaw/agents/main/agent/system-prompt.md` | ✓ wrapper #3 (buildSystemPromptForTarball) |
| `~/.openclaw/agents/main/agent/HEARTBEAT.md` | ❌ NOT COVERED |
| `~/.openclaw/cron/jobs.json` | ❌ NOT COVERED |
| `~/.openclaw/wallet/agent.key` | ✓ buildAgentKey |
| `~/.openclaw/audio-config.json` | ❌ NOT COVERED |
| `~/.openclaw/email-config.json` | ❌ NOT COVERED |
| `~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md` | ⚠ in `/overlays/`, but `setup.sh` must install (not yet implemented for Day 8a CRITICAL-only set) |
| `~/.openclaw/skills/computer-dispatch/SKILL.md` | ❌ NOT COVERED — dispatch skill |
| `~/.openclaw/scripts/strip-thinking.py` | ❌ NOT COVERED (script) |
| `~/.openclaw/scripts/vm-watchdog.py` | ❌ NOT COVERED (script) |
| `~/.openclaw/scripts/silence-watchdog.py` | ❌ NOT COVERED (script) |
| `~/.openclaw/scripts/push-heartbeat.sh` | ❌ NOT COVERED (script) |
| `~/.openclaw/scripts/auto-approve-pairing.py` | ❌ NOT COVERED (script) |
| `~/.openclaw/scripts/generate_workspace_index.sh` | ❌ NOT COVERED (script) |
| Various crontab entries (skill-updates, etc.) | ❌ NOT COVERED |
| Dispatch scripts (~/scripts/dispatch_*) | ❌ NOT COVERED |
| Browser-relay scripts (~/instaclaw-browser-relay/) | ❌ NOT COVERED |

**Per `cloud-init-snapshot-bake-requirements-2026-05-13.md` §1**: many of the missing files ARE intentionally SNAPSHOT_BAKED — the snapshot bake delivers them, so cloud-init doesn't need to. But the audit needs to verify this for each missing file:

| Missing file | SNAPSHOT_BAKED? (per bake-requirements doc) |
|---|---|
| exec-approvals.json | UNCLEAR — would need to verify against snapshot |
| .openclaw-pinned-version | LIKELY snapshot-baked (npm install pinned version is at bake time) |
| HEARTBEAT.md | UNCLEAR — bake-requirements doc doesn't list it |
| cron/jobs.json | LIKELY snapshot-baked (initial empty `{"jobs":[]}` file) |
| audio-config.json | LIKELY snapshot-baked (configureOpenClaw only writes if elevenlabs key) — but contains telegram bot username so could be per-user |
| email-config.json | SIMILAR — only written if resend key present (BYOK only) |
| computer-dispatch SKILL.md | SNAPSHOT_BAKED per bake-requirements (inlined from instaclaw repo) |
| scripts/*.py + .sh | SNAPSHOT_BAKED per bake-requirements §3-4 |
| Dispatch + browser-relay | Per CLAUDE.md, these are SSH-deployed per-VM at configure time — neither snapshot nor cloud-init currently. Day 8b setup.sh's BEST_EFFORT step 7-8 would handle. |

**The bake-requirements doc is from chunk 1 (2026-05-13).** It may be stale — needs reconciliation with the audit findings.

## §3. Tests are tautology / field-presence, not byte-parity

I built up to 171 assertions across 11 test groups. But most assertions are field-presence-only. **Not a single assertion compares my wrapper's output against an SSH-path equivalent.**

Examples of insufficient assertions:

- `test1`: `assert(id.includes('@fucking1999_bot'), "IDENTITY.md mentions bot username")` — only checks one substring, not byte-content.
- `test1`: `assert(wallet.includes('0x5Bc5'), "WALLET.md has agentbook address")` — checks ONE substring.
- `test8` (`buildUserMdForTarball`): `assert(wrapped === buildUserMd(p.gmailProfileSummary), ...)` — IS byte-parity, **because the wrapper is a pass-through.** This works for wrappers #1-5 (which delegate to existing helpers).
- `test11` (`buildOpenClawJsonForTarball`): manually constructs an "equivalent" UserConfig, compares JSON strings. This IS byte-parity, **because the wrapper delegates to `buildOpenClawConfig`.**

**The byte-parity tests only work for the 5 wrappers I built as pass-throughs.** The hand-written chunk-1 wrappers (IDENTITY/WALLET/WORLD_ID/.env/auth-profiles) have NO byte-parity test against SSH path.

**Fix:** for each hand-written chunk-1 wrapper, the test needs to:
1. Build the SSH path's output (extract the relevant function body, OR call it via a synthesized configureOpenClaw test)
2. Build my wrapper's output for the same params
3. Assert byte-equality

This requires extracting the SSH path's IDENTITY.md/WALLET.md/WORLD_ID.md/auth-profiles.json generators into testable functions in lib/ssh.ts. That's the proper fix — same pattern as the existing `buildUserMd` / `buildSystemPrompt` / etc. exports.

## §4. Orphan import + stale comments throughout

### §4.1 `PARTNER_V80_MARKER` unused

`lib/cloud-init-tarball.ts:57` imports `PARTNER_V80_MARKER` from `./partner-content`. Single occurrence in the file (the import itself). Never referenced. **ORPHAN IMPORT.**

### §4.2 Stale top-of-file docstring

Lines 18-24 claim the module does NOT generate openclaw.json / USER.md / system-prompt.md / BOOTSTRAP.md / setup.sh. **All five are now generated** by wrappers #1-5. The docstring is from chunk 1 and was never updated.

### §4.3 Stale §3 section header

Lines 364-370: "§3. Per-file builders (the simple subset — Day 4-7 chunk 1) [...] The remaining builders ... will land in the next chunk along with setup.sh (Day 8)." **The remaining builders are in §3b on line 575.** Section heading lies.

### §4.4 Stale `collectPartialEntries` docstring

Lines 963-973: "INCOMPLETE — the remaining entries [...] land in the next chunk." All wrappers are now present. **INCOMPLETE comment is incorrect.**

### §4.5 Stale DEBUG/TEST HOOK comment

Lines 1034-1050: "buildCloudInitTarball intentionally NOT exported yet. It depends on builders not yet present in this file." All builders are now present. The pseudocode in the comment block IS approximately the right design for the missing entry point — but the comment claims it doesn't exist yet, which is misleading.

### §4.6 Stale `buildDotEnv` docstring

Lines 506-510: "This chunk implements the universal subset (8 keys); the partner-conditional keys (EDGEOS, polygon RPC overrides) land with the partner-overlay chunk." **EDGEOS now lands here** (commit 9c24fe6a). Polygon RPC override never had a separate chunk planned. Docstring is outdated.

## §5. The contracts doc accuracy check

`docs/cloud-init-wrapper-contracts-2026-05-13.md` was the planning doc.

- §1.1 (`buildPersonalizedBootstrap`): correct — parameter is ignored, wrapper passes through, behavior matches.
- §1.2 (`buildUserMd`): correct — wrapper is pass-through.
- §1.3 (`buildSystemPrompt`): correct — wrapper is pass-through.
- §1.4 (`buildOpenClawConfig`): correct — wrapper is pass-through to the existing function. Mapping table accurate.
- §2 (MEMORY.md double-write): correct — wrapper preserves the double-write for byte-parity. Tech debt documented.
- §5b answers to Cooper's questions: all 5 answers landed correctly in the code.

**The contracts doc itself is accurate.** What it misses is **the chunk-1 wrappers were never contractually pinned to byte-parity** — they're listed in `cloud-init-implementation-map.md §7` as "TS string construction" with no reference to byte-matching the SSH path. The chunk-1 implementations were written from the contract doc's surface description, not from cross-referencing SSH-path output.

This is the root cause of the §1 bugs: the contract for chunk-1 wrappers was "build a file with these fields", not "byte-match the SSH path's output for this file".

## §6. Regression risk against SSH path

### §6.1 UserConfig extraction (commit c893f76e)

`lib/ssh.ts:71` was modified to `import type { UserConfig } from "./user-config-types";`. The interface moved verbatim. No callsite changes needed.

**Regression check:** `npx tsc --noEmit` runs clean on my changed files. configureOpenClaw at line 4830 still types `config: UserConfig`. **No regression observed.**

### §6.2 Buildable from a fresh clone

`tar-stream@3.2.0` + `@types/tar-stream@3.1.4` were added to package.json. **No existing import broke** (verified by tsc clean).

### §6.3 ssh.ts public-API changes

The four lib/ssh.ts exports I added in commit c5eb8f23 (`buildPersonalizedBootstrap`, `buildSystemPrompt`, `buildUserMd`, and the earlier `buildOpenClawConfig`) were already exported by the time I started the wrapper work. **No new exports added** during the wrapper-building phase. **No regression risk.**

### §6.4 EDGEOS validation

I added strict JWT-shape validation in `validateTarballParams` for `edgeosBearerToken`. This is **only called from cloud-init-tarball callers** — `configureOpenClaw` doesn't go through `validateTarballParams`, so adding the JWT check has zero regression risk on the SSH path.

## §7. setup.sh stub (lib/cloud-init-setup-sh.ts, WIP, uncommitted)

I started writing the setup.sh template builder before Cooper's stop directive landed. Quick audit of what's WIP:

- Covers CRITICAL steps 5/6/9/32/38 per plan §4.
- Uses TS template substitution with `${p.userId}` etc.
- Includes ERR trap with `rm -f /tmp/.instaclaw-ready; touch /tmp/.instaclaw-failed`.
- Callback POST uses bash-escaped JSON body (verified bash syntax is correct).
- WIP — has not been committed. Not yet tested.

**Status:** I will discard this file or keep as scaffold based on Cooper's call. The file is uncommitted so no impact either way.

## §8. Brutally honest summary

What I did right:
- The 5 wrappers #1-5 (BOOTSTRAP/USER/system-prompt/MEMORY/openclaw.json) are byte-parity-correct because they delegate to existing exported helpers from `lib/ssh.ts`.
- Validation is rigorous: tier required, agentRegion required, channels validated, EDGEOS JWT shape checked.
- The pg_cron monitoring, Rule 41 constraint, EDGEOS_BEARER_TOKEN .env emission are clean and well-tested.
- 5 of 5 manifest-required env vars now emit on first boot (the GATEWAY_TOKEN/POLYGON/CLOB/AGENT_REGION set Cooper specifically called out).

What I got wrong:
- **The hand-written chunk-1 wrappers (IDENTITY.md, WALLET.md, WORLD_ID.md, .env partial, auth-profiles.json) DO NOT byte-match the SSH path.** They produce plausible files that differ in content, shape, sentinels, and JSON formatting. Phase 1B-2 would fail.
- **My byte-parity tests only cover the 5 pass-through wrappers.** The hand-written wrappers have only field-presence assertions.
- **Multiple env vars are missing**: INSTACLAW_MUAPI_PROXY, BANKR_TOKEN_ADDRESS/SYMBOL, WORLD_ID_NULLIFIER/LEVEL, ELEVENLABS, RESEND, ALPHAVANTAGE, BRAVE_SEARCH_API_KEY, OPENAI_API_KEY.
- **`buildAuthProfilesJson` has 4 distinct bugs** — type field wrong, OpenAI profile always emitted, OpenAI key from wrong source, JSON indentation differs.
- **Stale docstrings + orphan import** — cosmetic but signals lack of discipline in keeping the file's documentation aligned with its actual contents as it grew.
- **No test compares cloud-init output against SSH-path output.** The whole "byte-parity" claim is unverified.

What I'm not 100% sure about:
- Whether SNAPSHOT_BAKED files (scripts, dispatch, browser-relay, computer-dispatch SKILL.md) are correctly omitted from the tarball OR whether some of those SHOULD be in the tarball (the snapshot is from May 3 — anything added to configureOpenClaw after that may not be in the snapshot).
- Whether `type: "api_key"` is REQUIRED by the Anthropic SDK or whether `type: "anthropic"` is also accepted. Either way, byte-parity demands the SSH-path value.
- Whether the `agentName` regex derivation (`Mucus09bot` → `Mucus`) is doing something semantically meaningful or is just cosmetic. If the gateway reads the IDENTITY.md to determine the agent's name, this matters a lot.

## §9. Recommended remediation order (when Cooper greenlights)

1. **Fix the auth-profiles.json bugs first** (§1.4) — biggest blast radius. Add `openaiApiKey?: string | null` to TarballParams. Match SSH-path shape exactly (`type: "api_key"`, no-indent JSON, conditional OpenAI profile).
2. **Extract SSH-path IDENTITY.md/WALLET.md/WORLD_ID.md generators into exported helpers in lib/ssh.ts** — then my wrappers become pass-throughs (same pattern as wrappers #1-5). This eliminates byte-parity drift forever.
3. **Add the 10 missing env vars to buildDotEnv** with appropriate TarballParams fields.
4. **Write byte-parity tests** that synthesize an SSH-path output for each file and compare. Failure on day 8b's first test run prevents shipping wrong code.
5. **Re-survey the SNAPSHOT_BAKED inventory** against the snapshot's actual contents (probe a recently-baked VM via SSH). The bake-requirements doc may be stale.
6. **Day 8a (assembled buildCloudInitTarball + setup.sh CRITICAL)** lands AFTER #1-4. Otherwise the assembler is wiring up wrong wrappers.

This isn't insurmountable — the wrapper architecture is sound; the implementation needs to match the SSH path. Estimated remediation: ~3-4 commits of focused work.

I should not have shipped 5 commits of chunk-1 wrappers without ANY byte-parity test against SSH-path output. The same discipline I applied to wrappers #1-5 (pass-through to exported SSH-path functions) should have been the chunk-1 approach too — but instead I built chunk-1 from a sketch in the contract doc. That was the seed of all these bugs.

---

## §10. Remediation complete — 2026-05-14

All 5 fixes Cooper directed have shipped. Final state: tsc clean, 315 test assertions pass.

### Commit map

| Audit finding | Commit | Test added |
|---|---|---|
| §1.4 buildAuthProfilesJson (4 bugs) | `39f7e37c` (Fix 1) | test12 (14 assertions) |
| §1.1 IDENTITY.md / §1.2 WALLET.md / §1.3 WORLD_ID.md content drift | `5cc35854` (Fix 2) | test13 (19 assertions) |
| §1.5 10 missing env vars + 3 new TarballParams fields | `5626eb71` (Fix 3) | test14 (36 assertions) |
| §3 No integration byte-parity test | `fd29e53c` (Fix 4) | test15 (27 assertions) |
| §4 Stale comments + orphan PARTNER_V80_MARKER import | `171b3429` (Fix 5) | (no test — doc cleanup) |

Bonus fix in Fix 3: `TARBALL_FIXED_MTIME` pins every tar entry's mtime to `2026-01-01T00:00:00Z` so back-to-back tarball builds are byte-deterministic. Pre-fix, test4 ("gunzipped tars are byte-identical") was flaky across second boundaries.

### Architectural change

Every chunk-1 wrapper is now a pure pass-through to an exported helper in `lib/ssh.ts`:

| File | Cloud-init wrapper | SSH-path helper |
|---|---|---|
| IDENTITY.md | `buildIdentityMdForTarball(p)` | `buildIdentityMd(botUsername)` |
| WALLET.md | `buildWalletMdForTarball(p)` | `buildWalletMd({bankr*})` |
| WORLD_ID.md | `buildWorldIdMdForTarball(p)` | `buildWorldIdMd(nullifier, level?)` |
| auth-profiles.json | `buildAuthProfilesJsonForTarball(p)` | `buildAuthProfilesJson(apiKey, proxyBaseUrl, openaiKey?)` |

`configureOpenClaw` (SSH path) now calls these helpers from its inline blocks too — no behavior change, just deduplication. Byte-parity is **structurally guaranteed** rather than test-asserted: both paths cannot produce different bytes for the same inputs because they call the same functions.

The one exception is `buildDotEnv`. The SSH path appends env vars piecemeal across `configureOpenClaw` — no single helper exists to pass through to. The wrapper mirrors each conditional emission per env var. test14 enumerates every env var the SSH path emits and verifies cloud-init's behavior matches under the same condition.

### What's still open (out of Cooper's 5-fix scope)

§2 Missing files inventory — `configureOpenClaw` writes 15-20+ files; the audit catalogued each as COVERED / NOT YET COVERED / SNAPSHOT_BAKED. The 4 chunk-1 files Cooper called out are now COVERED+byte-parity. The remaining gaps (HEARTBEAT.md, exec-approvals.json, .openclaw-pinned-version, cron/jobs.json, audio-config.json, email-config.json, computer-dispatch SKILL.md, workspace scripts, browser-relay scripts) are mostly SNAPSHOT_BAKED per `docs/cloud-init-snapshot-bake-requirements-2026-05-13.md`. The bake-requirements doc was authored 2026-05-13 and may be stale relative to the current snapshot. **Recommended P1 follow-up:** SSH-probe a freshly-baked VM and reconcile the inventory.

Day 8a (assembled `buildCloudInitTarball` + critical-step setup.sh) is gated on these audit fixes landing first. With Fixes 1-5 complete, the wrappers are byte-parity-correct, so Day 8a's assembler will wire up the right functions. The forward-looking comment block at the end of `lib/cloud-init-tarball.ts` shows the exact shape.

### Lesson recorded

The pre-audit chunk-1 work failed because I built from contract-doc sketches instead of cross-referencing SSH-path content. Cooper's per-commit slow-mode discipline applied to wrappers #1-5 (each delegated to existing exported helpers) but chunk-1 was built earlier under different (faster) cadence — that's where the bugs landed. The remediation forces chunk-1 to the same pass-through pattern; **byte-parity is now an invariant of the architecture, not a test outcome.**
