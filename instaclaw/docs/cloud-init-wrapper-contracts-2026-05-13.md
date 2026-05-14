# Cloud-init Tarball — Wrapper Contracts for `lib/ssh.ts` Helpers

**Author:** Claude (Opus 4.7) for Cooper Wrenn
**Date:** 2026-05-13
**Status:** Investigation-complete. Pre-code review document — written after Cooper's "slow down, ultrathink each function, tests alongside" directive. Lists every contract that must be true for the cloud-init-tarball wrappers to match `configureOpenClaw`'s SSH-shipped behavior byte-for-byte.

## §0. Why this document exists

The cloud-init-tarball module wraps four existing helpers in `lib/ssh.ts`:

- `buildPersonalizedBootstrap(profileContent)` at line 4221
- `buildUserMd(profileContent)` at line 9085
- `buildSystemPrompt(memoryContent)` at line 8995 — NOT the homonymous function in `lib/system-prompt.ts`
- `buildOpenClawConfig(config, gatewayToken, proxyBaseUrl, openclawModel, braveKey?)` at line 4303

Writing thin wrappers around these without reading their bodies + every caller is exactly the failure mode that produced the semver-regex bug + the null-byte-in-regex bug earlier today. Cooper's directive: "if you're unsure about how an existing function works, read it fully. don't assume from the name."

This doc records the semantic contracts established by reading each function's body AND every call site in `configureOpenClaw` (the only consumer that matters for byte-for-byte parity). Two non-obvious findings up front:

1. **`buildPersonalizedBootstrap` ignores its parameter.** Vestigial. The wrapper must NOT depend on profileContent flowing through.
2. **`buildSystemPrompt`-produced file is documented dead weight.** Its own closing HTML comment says `<!-- WARNING: This file is NOT read by OpenClaw. Agent instructions now live in SOUL.md (behavioral rules) and CAPABILITIES.md (tool routing). This file exists for debugging/reference only. -->`. We still ship it for byte-parity with `configureOpenClaw`, but it does not affect runtime behavior.

There are also two structural findings that have to be addressed before wrappers compile:

- `UserConfig` interface at line 71 is NOT exported. The wrapper either needs an export-only diff to `lib/ssh.ts`, or it has to construct an inline-typed object. Recommend export.
- `WORKSPACE_BOOTSTRAP_SHORT` at line 4160 IS exported. Use it for the no-Gmail BOOTSTRAP.md path.

## §1. Helper-by-helper contract

### §1.1 `buildPersonalizedBootstrap(profileContent: string): string`

**Definition:** `lib/ssh.ts:4221-4296`.

**Return:** Static ~3KB BOOTSTRAP.md template instructing the agent on its "first message" awakening + 4-section structure + DO/DON'T examples. Trailing newline-free.

**Parameter usage:** **`profileContent` is never substituted into the output.** Inspected the entire 75-line return — the parameter name appears zero times in the template body. The output is a constant.

The semantic intent at the call sites (`config.gmailProfileSummary` passed in at line 5793) is "the caller is in the Gmail-present branch; emit the personalized bootstrap that points the agent at USER.md and MEMORY.md (both of which DO contain the profile content)." The parameter functions as a signal to read the file, not a payload to embed.

**Determinism:** input-invariant constant output. Equal for any input.

**Callsites in configureOpenClaw:**

- `lib/ssh.ts:5793` — Gmail-present branch only. Called once. Result written to `workspace/BOOTSTRAP.md`.
- `lib/ssh.ts:8961` — a different code path (updateBootstrap probably). Not in our scope.

**Gmail-absent branch instead writes `WORKSPACE_BOOTSTRAP_SHORT`** (lib/ssh.ts:5814). So the Gmail-present-vs-absent decision determines WHICH constant the file gets — not WHAT data is embedded in either.

**Wrapper contract for `lib/cloud-init-tarball.ts`:**

> If `p.gmailProfileSummary` is non-empty, write `BOOTSTRAP.md = buildPersonalizedBootstrap("")`. The empty string is fine because the parameter is ignored. If `p.gmailProfileSummary` is empty/null, write `BOOTSTRAP.md = WORKSPACE_BOOTSTRAP_SHORT`. Mode 0o644.

**Risk to test against:**

- `buildPersonalizedBootstrap` ever starts using profileContent in the future (silent contract change) — wrapper test must verify the produced bytes match a known-good fixture, so a future change fails the test.

### §1.2 `buildUserMd(profileContent: string): string`

**Definition:** `lib/ssh.ts:9085-9104`.

**Return:** USER.md body with name extraction + profileContent embedded in Context section.

**Parameter usage:** USED. Three substitutions:

1. Regex extracts a first name with the pattern `/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(?:is|works|lives)/m`. Matches "John is...", "John Smith is...", "John works...", "John lives...".
2. `fullName` falls back to `"User"` if no match.
3. `profileContent` itself is embedded under `## Context`.

**Determinism:** deterministic.

**Known pre-existing bugs (out of scope to fix here, document in case wrapper trips them):**

- **Cyrillic / non-ASCII names** (e.g., "Андрей" / khomenko89's name) do not match the regex → fall back to "User". The Gmail-derived profileContent could still mention the user's name in the Context section, but the name field at the top says "User".
- **Names with no verb-prefix** ("Sarah, a designer..." with a comma) fall back to "User".
- **Empty profileContent** → fullName="User", Context section is empty. Doesn't throw; produces a near-empty USER.md.

**Callsites in configureOpenClaw:**

- `lib/ssh.ts:5796` — Gmail-present branch only.
- `lib/ssh.ts:8953` — different code path (updateBootstrap-equivalent). Not in our scope.

**Gmail-absent branch never writes USER.md at all** (line 5812-5826 has no buildUserMd call).

**Wrapper contract:**

> If `p.gmailProfileSummary` is non-empty, write `USER.md = buildUserMd(p.gmailProfileSummary)`. If empty/null, OMIT the entry from the tarball entirely — `setup.sh`'s `[ -f /tmp/instaclaw-config/.../USER.md ] && install ...` pattern handles the conditional placement. Mode 0o644.

**Risk to test against:**

- Empty-string profileContent produces a valid USER.md (no throw). Pin this in the smoke test.
- Cyrillic profileContent produces fullName="User" (matches existing prod behavior — don't accidentally "fix" it inside the wrapper).

### §1.3 `buildSystemPrompt(memoryContent: string): string` (the one in `lib/ssh.ts:8995`)

**Definition:** `lib/ssh.ts:8995-9082`. Returns system-prompt.md body. Approximately 5KB.

**NOTE:** there is ALSO a `buildSystemPrompt` in `lib/system-prompt.ts` used by 4 task routes + chat-send + recurring-executor. Different signature, different purpose (runtime LLM prompts). The wrappers MUST import from `@/lib/ssh`, not `@/lib/system-prompt`.

**Parameter usage:** USED. Branches on `memoryContent.trim()`:

- **Non-empty branch:** emits `## Your Owner\n\n${memoryContent}\n\n## Session Continuity — CRITICAL\n...` (the anti-amnesia block that handles user complaints about the agent forgetting them).
- **Empty branch:** emits short placeholder: `## Your Owner\n\nYour owner hasn't connected their profile yet. When they first message you, introduce yourself warmly...`

The two branches diverge for ~30 lines after the Owner section. The trailing sections (Ongoing Behavior, Tool Awareness, Web Search, Browser Automation, etc.) are identical regardless of input.

**CRITICAL FINDING:** the function's own closing HTML comment at line 9079-9081:

```
<!-- WARNING: This file is NOT read by OpenClaw. Agent instructions now live in
     SOUL.md (behavioral rules) and CAPABILITIES.md (tool routing).
     This file exists for debugging/reference only. -->
```

So `system-prompt.md` does NOT affect agent behavior at runtime. SOUL.md and CAPABILITIES.md (both SNAPSHOT_BAKED, not per-user) are what the agent actually reads. We ship `system-prompt.md` only for byte-parity with `configureOpenClaw` — if it accidentally goes missing from a cloud-init-provisioned VM, the agent still works, but the byte-for-byte parity check in `_compare-old-vs-new-path.ts` (Phase 1B-2 deliverable) would fail.

**Determinism:** deterministic.

**Callsites in configureOpenClaw:**

- `lib/ssh.ts:5798` — Gmail-present branch, called with `config.gmailProfileSummary` (non-empty by definition of that branch).
- `lib/ssh.ts:5815` — Gmail-absent branch, called with `''` (empty string) → produces the placeholder Owner section.

**Wrapper contract:**

> Always write `system-prompt.md = buildSystemPrompt(p.gmailProfileSummary ?? "")`. The function handles both branches correctly. File is debug-only; ship it for byte-parity. Path: `home/openclaw/.openclaw/agents/main/agent/system-prompt.md`. Mode 0o644.

**Risk to test against:**

- Future change drops the `<!-- WARNING -->` footer that signals dead-weight status — wrapper test should pin the byte hash so the wrapper itself doesn't drift.
- Pass empty string explicitly — must produce a valid prompt (placeholder branch), not throw.

### §1.4 `buildOpenClawConfig(config, gatewayToken, proxyBaseUrl, openclawModel, braveKey?)`

**Definition:** `lib/ssh.ts:4303-4545`.

**Return:** A plain JavaScript object (NOT a JSON string). The caller is responsible for `JSON.stringify(result, null, 2)`. Roughly 5KB stringified.

**Parameters:**

- `config: UserConfig` (line 71-108, NOT EXPORTED — see §3 below).
- `gatewayToken: string` — appears as `gateway.auth.token`. The actual ID token the gateway accepts.
- `proxyBaseUrl: string` — appears as `models.providers.anthropic.baseUrl` IF truthy, else `anthropic: {}`. For all-inclusive this points at `${nextauthUrl}/api/gateway`; for BYOK passing empty string is safe.
- `openclawModel: string` — appears as `agents.defaults.model.primary`. E.g., `"anthropic/claude-sonnet-4-6"`.
- `braveKey?: string` — optional. If present, configures `plugins.brave.config.webSearch.apiKey` AND adds `tools.web.search` block.

**Conditional behavior (read the body carefully):**

- `config.channels?.includes("telegram") && config.telegramBotToken` → adds `channels.telegram` block + enables `plugins.telegram`.
- `config.channels?.includes("discord") && config.discordBotToken` → adds `channels.discord` block + enables `plugins.discord`.
- `braveKey` truthy → adds `tools.web` block + `plugins.brave` block.
- Always sets `tools.media`, `tools.links`, `tools.exec`.

**Throws:** if any browser profile has neither `cdpPort` nor `cdpUrl`. The hardcoded `openclaw` profile has `cdpPort: 18800`, so this never trips in practice — but the validation runs on every call.

**Known pre-existing quirks (not in scope to fix):**

- Line 4460: `streaming: "partial"` is set as a STRING. The manifest's `channels.telegram.streaming.mode` configSetting is an OBJECT shape (`{ mode: "partial" }`). On first boot the on-disk shape is the legacy string; the reconciler then overwrites with the object via `openclaw config set` on the next tick. Brief drift window. Pre-existing.
- `config.tier` is declared REQUIRED in `UserConfig` but is NEVER referenced in the `buildOpenClawConfig` body. The parameter exists but is unused. Wrapper can pass any string.

**Callsite in configureOpenClaw:**

- `lib/ssh.ts:5074` — `buildOpenClawConfig(config, gatewayToken, proxyBaseUrl, openclawModel, braveKey)`. Result is `JSON.stringify(ocConfig, null, 2)` shortly after.

**Wrapper contract:**

> Map `TarballParams` → `UserConfig`:
>
> | UserConfig field | Source in TarballParams |
> |---|---|
> | telegramBotToken | `p.telegramBotToken` |
> | apiMode | `p.apiMode` |
> | apiKey | `p.apiKey ?? undefined` |
> | tier | `p.tier ?? "starter"` (unused in function body; any string ok) |
> | model | `p.defaultModel` |
> | discordBotToken | `undefined` (TarballParams doesn't carry discord — add when needed) |
> | channels | `["telegram"]` (matches `vm-918`'s `channels_enabled`) |
> | braveApiKey | currently `undefined` from TarballParams — would need new field if we want first-boot Brave search |
> | gmailProfileSummary | `p.gmailProfileSummary ?? undefined` (function doesn't actually read this) |
> | userName | `p.userName ?? undefined` |
> | userEmail | `p.userEmail ?? undefined` |
> | botUsername | `p.telegramBotUsername` |
> | userTimezone | `p.userTimezone ?? undefined` |
> | worldIdNullifier | `p.worldIdNullifier ?? undefined` |
> | worldIdLevel | `p.worldIdLevel ?? undefined` |
> | bankrApiKey | `p.bankrApiKey ?? undefined` |
> | bankrEvmAddress | `p.bankrEvmAddress ?? undefined` |
> | bankrTokenAddress | `p.bankrTokenAddress ?? undefined` |
> | bankrTokenSymbol | `p.bankrTokenSymbol ?? undefined` |
> | partner | `p.partner ?? undefined` |
>
> Other arguments:
> - `gatewayToken = p.gatewayToken`
> - `proxyBaseUrl = ${p.nextauthUrl}/api/gateway` for `all_inclusive`, `""` for BYOK
> - `openclawModel = p.defaultModel`
> - `braveKey = undefined` (cloud-init doesn't carry Brave key today — add when Brave is wired into provisioning)
>
> `JSON.stringify(result, null, 2)` and ship as `home/openclaw/.openclaw/openclaw.json`. Mode 0o600.

**Risks to test against:**

- All four conditional branches (telegram on/off, discord on/off, brave on/off, BYOK vs all_inclusive). Smoke test must cover at minimum: telegram+all_inclusive (the vm-918 shape), telegram+byok, no-channels-no-brave (degenerate).
- Schema-validation guard: hand a `TarballParams` with a busted browser profile (impossible today because `buildOpenClawConfig` hardcodes the profile) — but document the invariant.
- JSON-stringify producing valid JSON: parse it back in the test, assert key paths exist.

## §2. MEMORY.md handling (related — not a separate helper)

`MEMORY.md` is NOT generated by a helper function — `configureOpenClaw` at line 5795 writes the raw `config.gmailProfileSummary` directly into `workspace/MEMORY.md` AND `agents/main/agent/MEMORY.md`. The Gmail-absent branch (line 5812-5826) does NOT write MEMORY.md; a defensive block at line 5831+ creates a default template if missing.

**Wrapper contract:**

> If `p.gmailProfileSummary` is non-empty, write TWO tarball entries:
> - `home/openclaw/.openclaw/workspace/MEMORY.md = p.gmailProfileSummary`
> - `home/openclaw/.openclaw/agents/main/agent/MEMORY.md = p.gmailProfileSummary`
>
> If empty/null, OMIT both — `setup.sh` already has the defensive heredoc block (per plan §4) that creates a default template when the file is missing.

## §3. Required pre-wrapper diffs to lib/ssh.ts

Two diffs are needed before the wrappers can compile or function correctly. Both are minimal additions — no behavior change to existing code:

**§3.1 Export `UserConfig`.**

```diff
- interface UserConfig {
+ export interface UserConfig {
```

`UserConfig` at line 71 is currently module-private. The cloud-init-tarball wrapper imports it to type the parameter for `buildOpenClawConfig`. No existing code expects it to remain private.

**§3.2 `WORKSPACE_BOOTSTRAP_SHORT` is already exported.** Verified at line 4160. No diff needed.

## §4. Wrapper module layout

The wrappers live alongside the existing builders in `lib/cloud-init-tarball.ts`. Adding (in order of dependency):

```
// §X. lib/ssh.ts wrappers
function buildOpenClawJsonForTarball(p: TarballParams): string
function buildBootstrapMd(p: TarballParams): string
function buildUserMdForTarball(p: TarballParams): string | null  // null when no Gmail
function buildSystemPromptForTarball(p: TarballParams): string
function buildMemoryMdForTarball(p: TarballParams): string | null  // null when no Gmail
```

`collectCoreEntries(p)` (new) returns the tarball entries for these five files (six if MEMORY.md splits across workspace + agent dirs). Combined with `collectPartialEntries(p)` (existing in chunk 1) + the setup.sh entry (Day 8), this forms the complete `buildCloudInitTarball`.

## §5. Failure-mode test cases per wrapper

Each wrapper gets at least these assertions in `scripts/_test-cloud-init-tarball.ts`:

**`buildBootstrapMd`:**

- Gmail present → output ≡ `buildPersonalizedBootstrap("")` byte-for-byte (proves we're matching the SSH path).
- Gmail empty → output ≡ `WORKSPACE_BOOTSTRAP_SHORT` byte-for-byte.
- Gmail null → output ≡ `WORKSPACE_BOOTSTRAP_SHORT` byte-for-byte.

**`buildUserMdForTarball`:**

- Gmail present (ASCII first-name first) → output contains "Andrew" in fullName slot (regex matches).
- Gmail present (Cyrillic profile) → output contains "User" in fullName slot (regex falls back; pre-existing bug pinned).
- Gmail empty/null → returns `null` (caller omits the entry).

**`buildSystemPromptForTarball`:**

- Gmail present → output contains `## Session Continuity — CRITICAL` (non-empty branch fires).
- Gmail empty/null → output contains `hasn't connected their profile yet` (empty branch fires).
- Output always ends with the `<!-- WARNING: This file is NOT read by OpenClaw -->` footer (proves we got the dead-weight version).

**`buildOpenClawJsonForTarball`:**

- All-inclusive + telegram → `gateway.auth.token === p.gatewayToken`, `channels.telegram.botToken === p.telegramBotToken`, `models.providers.anthropic.baseUrl === ${nextauthUrl}/api/gateway`, `plugins.entries.telegram.enabled === true`.
- BYOK + telegram → `models.providers.anthropic` has no baseUrl (or proxyBaseUrl empty).
- No telegram → `channels.telegram` undefined, `plugins.entries.telegram` undefined.
- Output parses as JSON without throwing.
- All four critical schema keys present: `agents.defaults.compaction.mode === "safeguard"`, `tools.exec.security === "full"`, `session.reset.mode === "idle"`, `commands.useAccessGroups === false`.

**`buildMemoryMdForTarball`:**

- Gmail present → output ≡ `p.gmailProfileSummary` byte-for-byte (it's a pass-through).
- Gmail empty/null → returns `null` (caller omits the entry).

## §5b. Answers to §6 open questions (Cooper, 2026-05-13)

DB investigation (`scripts/_audit-brave-discord-coverage.ts` against production, 2026-05-13):

| Field | Assigned VMs with field set | Notes |
|---|---|---|
| `instaclaw_vms.brave_api_key` | 0 of 239 | All current VMs rely on fleet-wide `process.env.BRAVE_SEARCH_API_KEY` (lib/ssh.ts:5073 fallback). |
| `instaclaw_vms.discord_bot_token` | 0 of 239 | Discord channel is unused in current production. |
| `'discord' in channels_enabled` | 0 of 239 | Same — no current user has wired Discord. |

**(a) Brave:** Include `braveApiKey?: string | null` in `TarballParams`. The endpoint (Day 9-10) resolves `vm.brave_api_key ?? process.env.BRAVE_SEARCH_API_KEY` and passes the result. Wrapper is purely functional — no env reads inside it. Web search works on first boot for every new VM provisioned via cloud-init.

**(b) Discord:** Include `discordBotToken?: string | null` in `TarballParams`. Field is currently always absent (0/239 production users), so most invocations omit it. `buildOpenClawConfig` already guards the Discord block on `config.channels?.includes("discord") && config.telegramBotToken`-equivalent — no special handling needed. Discord-equipped future users get a working channel on first boot.

**(c) tier:** Required, no default. `validateTarballParams` throws on missing/null. A signup flow that landed a user with `tier=NULL` is a bug — surface it loudly at the tarball boundary rather than silently labeling them "starter."

**(d) UserConfig sharing — architectural decision:**

Considered five options:

1. **Export `UserConfig` from `lib/ssh.ts`.** Zero refactor. Turns ssh.ts into an accidental types hub. Cooper flagged "don't blindly export."
2. **Duplicate `UserConfig` in cloud-init-tarball.ts.** Drift risk. Anti-pattern. Reject.
3. **Shared types file (`lib/user-config-types.ts`).** Matches existing pattern at `lib/negotiation-types.ts`. New file is small (~40 lines for one interface) but establishes the canonical home so future additions don't pile up in ssh.ts.
4. **No type import; inline object literal.** Works via TypeScript structural typing but loses documentation value at the call site.
5. **Local type alias mirroring UserConfig.** Same drift risk as option 2 with comments saying "kept in sync manually."

**Picking option 3** — `lib/user-config-types.ts`. Reasoning:

- The codebase already uses the `lib/<feature>-types.ts` pattern (`lib/negotiation-types.ts`). Matching existing convention is preferable to inventing a new one.
- ssh.ts is 9000+ lines. Reducing its surface (by ~40 lines + the moved type definition) is good hygiene.
- Future engineers grepping for `UserConfig` find both the type and its home file naturally.
- cloud-init-tarball.ts importing from `@/lib/ssh` just for a TYPE creates a code-path that says "the cloud-init module needs SSH operations" — false. The shared-types file decouples cloud-init from ssh except for the actual function calls.
- Senior-engineer test: this is what you'd see in any production codebase with > 3 modules that share configuration shapes. Option 1 only feels OK when there's one consumer; we now have two (configureOpenClaw + cloud-init-tarball) and likely a third in the future (Day 9-10 endpoint may want UserConfig).

Concrete diff plan:
1. Create `lib/user-config-types.ts` with `export interface UserConfig { ... }` (moved verbatim from ssh.ts:71-108, comments preserved).
2. Update `lib/ssh.ts:71` to `import type { UserConfig } from "./user-config-types";`.
3. `lib/cloud-init-tarball.ts` will import the same.
4. No re-export from ssh.ts (UserConfig was never exported there in the first place).

**(e) MEMORY.md double-write — ultrathink + finding:**

Investigated all readers and writers of both paths in `lib/ssh.ts` + the embedded `strip-thinking.py` script:

**`workspace/MEMORY.md`:**
- Writers: `configureOpenClaw` (line 5803), `strip-thinking.py` session-end hook (lines 1273, 1339-1340, 1449), agent itself via SOUL.md "memory filing system" workflow.
- Readers: gateway bootstrap loads this for the agent's session memory; strip-thinking.py's staleness check; "bootstrap-loaded" annotation at line 1273 confirms.

**`agents/main/agent/MEMORY.md`:**
- Writers: `configureOpenClaw` ONLY (line 5809). Written once at provision time.
- Readers: NONE found in `lib/ssh.ts` or `strip-thinking.py`. The only reference outside the writer is `lib/ssh.ts:9835` — a delete-loop in a "wipe and reset" script that defensively removes both paths.

**Verdict: the agent-dir MEMORY.md is legacy tech debt.**

Written once during provision, never updated, never read at runtime. The workspace version is the live source of truth; the agent-dir copy fossilizes at provision-time content and drifts stale within hours of the user's first conversation. The delete-loop at 9835 exists to clean up the dead copy during wipe operations — which only makes sense if the copy is dead weight (otherwise, you'd want to PRESERVE it across wipes).

**Decision for cloud-init wrapper:** preserve the double-write today for byte-parity with `configureOpenClaw` (the Phase 1B-2 compare script flags any divergence). Document the debt for a future cleanup PR.

**P1 follow-up (post-cutover):** in a separate PR, remove the line 5809 write from `configureOpenClaw` AND drop the agent-dir entry from the cloud-init tarball. Keep the delete-loop at line 9835 — it's defensive cleanup that doesn't hurt to leave. After both writers are gone, the agent-dir file simply ceases to exist on new VMs; existing VMs' fossilized copies get cleaned up on the next wipe/reset.

## §6 (original). Open questions for Cooper before code (RESOLVED — see §5b)

These are non-obvious decisions I need confirmation on before writing wrappers:

1. **Brave API key support.** `buildOpenClawConfig` takes a `braveKey` parameter. The SSH-configure path reads it from `vm.brave_api_key` (DB column). `TarballParams` doesn't currently carry it. Two options:
   - (a) Add `braveApiKey?: string` to `TarballParams`. Adds one more field to the endpoint's row-to-params mapping.
   - (b) Hardcode `braveKey = undefined` in the wrapper for now. New users provisioned via cloud-init won't have first-boot Brave search; the reconciler may pick it up on a later tick.
   
   I lean (a) — first-boot completeness is the whole point of cloud-init. Cooper to confirm.

2. **Discord channel support.** Same shape as Brave — `TarballParams` doesn't carry `discordBotToken` because no current InstaClaw user uses Discord. Confirm: leave Discord out of cloud-init entirely until/unless we onboard a Discord user?

3. **`tier` field default.** `UserConfig.tier` is REQUIRED in type but unused in function body. Plan to pass `p.tier ?? "starter"`. Safe per inspection — but if someone adds a `config.tier` reference to `buildOpenClawConfig` later, our default could mislabel paying customers. Acceptable risk?

4. **`UserConfig` export.** The §3.1 diff makes `UserConfig` public to anyone who imports `@/lib/ssh`. Confirm OK — it's the natural module boundary.

5. **MEMORY.md double-write.** The SSH-configure path writes MEMORY.md to BOTH `workspace/MEMORY.md` AND `agents/main/agent/MEMORY.md`. Confirm the cloud-init path should do the same — i.e., emit two tarball entries with identical content?

## §7. Next steps (in order, only after Cooper's review)

1. Cooper reviews this doc.
2. Land the `UserConfig` export-only diff (§3.1).
3. Write `buildBootstrapMd` wrapper + smoke test for it (simplest case; no parameter use; static-output verification).
4. Write `buildUserMdForTarball` wrapper + smoke test.
5. Write `buildSystemPromptForTarball` wrapper + smoke test.
6. Write `buildMemoryMdForTarball` wrapper + smoke test (trivial — pass-through).
7. Write `buildOpenClawJsonForTarball` wrapper + smoke test (most complex; all four branches covered).
8. Add `collectCoreEntries(p)` aggregating the five wrappers + `collectPartialEntries` (existing) + `setupShTemplate(p)` placeholder (Day 8 lands the real setup.sh).
9. Export `buildCloudInitTarball(p)` from `lib/cloud-init-tarball.ts`.

Steps 3-7 each commit independently with their tests so a regression in one wrapper doesn't block the others. Pace: per-commit smoke-test pass is the gate.
