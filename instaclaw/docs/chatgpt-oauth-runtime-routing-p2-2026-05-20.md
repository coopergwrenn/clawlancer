# ChatGPT OAuth Runtime Routing — P2 Investigation

**Status**: paused on vm-780 as of 2026-05-20 21:19 UTC. OAuth tokens + profile preserved. model.primary reverted to anthropic/claude-sonnet-4-6 to keep Cooper's agent serving. Resume when post-launch bandwidth allows.

## Net summary

The ChatGPT OAuth feature shipped Days 1–18 is **production-ready end-to-end at the infrastructure layer**. The remaining gap is a single runtime-routing failure: pi-ai's auth-store resolver silently rejects the openai-codex profile even when the on-disk shape exactly matches `hasUsableOAuthCredential$1`'s spec. The agent falls back to Claude (cascade verified working — Cooper got a real reply via Claude Sonnet 4.6 on the failed test). Tokens, encryption, refresh cron, reconciler push are all behaving correctly.

## What's confirmed working

| Layer | Status | Evidence |
|---|---|---|
| Device-code OAuth flow | ✓ | Cooper's dashboard shows "Connected — ChatGPT Plus" |
| AES-256-GCM token storage | ✓ | `instaclaw_users` row decrypts cleanly with versioned key id (v1) and AAD = userId |
| `openai_token_version` bump on connect | ✓ | DB shows version=1 after successful poll |
| Refresh cron auth + per-user lock | ✓ | All Day 16-18 unit tests pass; cron currently noop (no users in 24h window) |
| Reconciler step (`stepChatGPTOAuthToken`) | ✓ | Two reconcile cycles both completed `chatgpt-oauth: pushed token v1` with zero errors |
| **Profile shape (post-fix `195b276f`)** | ✓ | On-disk profile: `{type:"oauth", provider:"openai-codex", access:<JWT>, expires:<ms>, accountId:<uuid>}` — verified byte-for-byte against `hasUsableOAuthCredential$1`'s required fields |
| stepAuthProfiles preservation of openai-codex entry | ✓ | Confirmed `anthropic:default` rebuild during gateway-token rotation does NOT wipe the openai-codex entry |
| Verify-after-write (`access` prefix + `expires` numeric) | ✓ | Both fields confirmed re-read from disk after every push |
| Gateway restart triggered on model.primary flip | ✓ | First reconcile cycle restarted the gateway successfully when flipping claude→openai-codex |
| DB↔disk sync (api_mode, default_model, synced_version) | ✓ | All three columns updated atomically per push |

## What's broken — the actual gap

**Symptom**: agent receives "what model are you running?" → 16-second wait → `Missing API key for provider 'openai-codex'`. Cascade falls back to Claude (which works in the most recent test — Cooper got "hello?" reply via Sonnet 4.6).

**Gateway journal (vm-780, 21:13:39 UTC)**:
```
[diagnostic] lane task error: error="FailoverError: No API key found for provider \"openai-codex\".
  Auth store: /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json
  (agentDir: /home/openclaw/.openclaw/agents/main/agent).
  Configure auth for this agent (openclaw agents add <id>) or copy auth-profiles.json from the main agentDir."
[model-fallback/decision] decision=candidate_failed requested=openai-codex/gpt-5.5
  candidate=openai-codex/gpt-5.5 reason=auth next=anthropic/claude-haiku-4-5-20251001
```

**What we've ruled out**:
- Profile shape wrong (was the original 2026-05-20 root cause — fixed in `195b276f`). Now matches `hasUsableOAuthCredential$1` exactly.
- File permissions (`-rw------- openclaw openclaw 2613` — gateway runs as `openclaw`, can read).
- File path mismatch (resolver names the same path we write: `/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json`).
- Token expired (9.9 days remaining; JWT `exp` claim valid; `iss=https://auth.openai.com`).
- OpenClaw version too old (`OpenClaw 2026.4.26 (be8c246)`; supports openai-codex per `dist/extensions/openai/openai-codex-catalog-NS7RbvVw.js`).
- Stale gateway memory cache (restarted manually at 21:16:27 UTC after profile push — still rejected on retest).
- Account-mismatch / identity-rotation rejection (only one openai-codex profile in store; no shouldMirror checks would trigger).

**What's still in the suspect list**:

1. **`resolveApiKeyForProfile` is throwing or returning null** for our profile, and the catch block at `model-auth-Bic7ggHC.js:314` silently logs to `log.debug?.(...)` which isn't visible at our log level. The error message we see is the downstream "no candidates matched" fallback, NOT the underlying rejection reason. **Next debug step**: instrument the resolver to enable debug logging OR add a custom journalctl filter that captures the catch-block output. Could also write a small Node script on the VM that imports `@mariozechner/pi-ai` directly and calls the resolver with our profile to see the real error.

2. **`resolveAuthProfileOrder` may not include `openai-codex:default`** — `listProfilesForProvider` calls `resolveProviderIdForAuth("openai-codex")` and compares against `resolveProviderIdForAuth(cred.provider)`. If a plugin manifest defines an alias map that resolves the request's "openai-codex" to one canonical form and the profile's stored "openai-codex" to a different form, they wouldn't match. **Next debug step**: log the output of `resolveProviderAuthAliasMap()` on the VM to see what aliases are registered.

3. **A separate `cfg.auth.profiles` (config-side) check** that takes precedence over the file-store check, and our profile isn't represented there. From `doctor-auth-h77CJ52R.js`:
   ```js
   function hasConfiguredCodexOAuthProfile(cfg) {
       return Object.values(cfg.auth?.profiles ?? {}).some(
           (profile) => profile.provider === CODEX_PROVIDER_ID && profile.mode === "oauth"
       );
   }
   ```
   Note: config check uses `profile.mode === "oauth"` (different field name than store's `profile.type`). If pi-ai is reading from `openclaw.json:auth.profiles` instead of `auth-profiles.json`, our write went to the wrong store entirely.

4. **A plugin-system gate** that's flagging our profile as un-trusted. From `provider-auth-aliases-DNk_M8am.js:isWorkspacePluginAllowedByConfig` — workspace plugins go through a trust check. The openai-codex plugin might be bundled (origin=bundled) which is auto-trusted, but if our reconciler-written profile isn't recognized as belonging to that plugin, lookup could skip it.

5. **`shouldDeferSyntheticProfileAuth` is deferring our profile and the deferred result is then nulled**. This branch in `model-auth-Bic7ggHC.js:309` defers OAuth profiles in some cases. If the deferred result is supposed to be reset later by a synthetic provider check that isn't firing, the resolver falls through.

The 1-hour debug budget would be: SSH into vm-780, write a tiny Node script that imports pi-ai's `resolveModelAuth` directly with our profile object, log the full resolution path. The error WILL surface clearly there (no silent catch).

## Re-flip risk — needs operator decision

**Problem**: the reconcile-fleet cron (`*/3 * * * *`) will, on its next cycle that picks vm-780 in its batch, run `stepChatGPTOAuthToken`, see that `vm.assigned_to`'s user has tokens AND `model.primary != openai-codex/gpt-5.5`, and **re-flip model.primary back** to the broken setting + restart Cooper's gateway. Effect: Cooper's agent goes broken every ~hour (probabilistic — depends on when vm-780 is selected by the cron's `BATCH_SIZE=3` from ~240 stale VMs).

**Options to prevent**:

1. **Per-VM env-var pause** (recommended): add `CHATGPT_ROUTING_PAUSED_VM_IDS=<uuid-list>` to Vercel prod env. Code change at top of `stepChatGPTOAuthToken`: if `process.env.CHATGPT_ROUTING_PAUSED_VM_IDS` contains `vm.id`, push to `result.warnings` and return. No migration. ~10 LOC. To resume routing: clear the env var, next reconcile re-pushes.

2. **NULL the user's `openai_oauth_access_token`** (would force re-OAuth on resume; Cooper said NO — preserve tokens).

3. **New `instaclaw_vms.chatgpt_routing_paused_at` column** + migration + code check. Cleaner but heavier. ~30 min.

4. **Do nothing, accept the re-flip cadence, manually re-roll model.primary as needed**. Acceptable if "post-launch investigation" happens within a day or two.

If you want option 1 shipped, give the word and I'll do it in <15 min.

## Resume-debug procedure (when picking back up)

1. **SSH to vm-780**: `ssh -i /tmp/ic_ssh_key openclaw@104.237.151.95`
2. **Confirm OAuth state still intact**:
   ```bash
   cat ~/.openclaw/agents/main/agent/auth-profiles.json | jq '.profiles."openai-codex:default" | {type, provider, access_len: (.access | length), expires, accountId}'
   ```
   Expected: `type=oauth, provider=openai-codex, access_len=1888, expires=<future-ms>, accountId=67d52e32-...`
3. **Re-enable routing on vm-780**: `openclaw config set agents.defaults.model.primary openai-codex/gpt-5.5 && systemctl --user restart openclaw-gateway`
4. **If access token has expired by then** (>10 days from 2026-05-20): trigger refresh-cron manually OR re-OAuth via the dashboard. Confirm `instaclaw_users.openai_oauth_expires_at` is still in the future BEFORE the resume.
5. **Run the diagnostic Node script** described in the "suspect list" item 1 — get the real rejection reason.
6. **Iterate fix** based on the actual error path.

## Files changed in this incident

| Commit | What |
|---|---|
| `195b276f` | `lib/vm-reconcile.ts` — flipped profile shape from `{key, metadata: {accountId}}` to `{access, expires, accountId}`; added `extractCodexJwtExpMs` JWT-decode helper; verify-after-write now reads both `.access` prefix and `.expires` numeric. Tests updated; 55/55 pass. |
| (operator-only) | `vm-780`: `openclaw config set agents.defaults.model.primary anthropic/claude-sonnet-4-6` + `systemctl --user restart openclaw-gateway` (2026-05-20 21:19 UTC). NO DB writes, NO profile-file mutation. |

## DB state preserved

- `instaclaw_users.0a102415...openai_oauth_access_token`: encrypted (v1 key, AAD=userId) — decrypts cleanly
- `instaclaw_users.0a102415...openai_oauth_refresh_token`: encrypted — preserved for refresh
- `instaclaw_users.0a102415...openai_oauth_expires_at`: `2026-05-30T18:29:54Z` (~10 days from now)
- `instaclaw_users.0a102415...chatgpt_plan_type`: `plus`
- `instaclaw_users.0a102415...openai_oauth_account_id`: `67d52e32-bfb5-4b41-aa00-613007889913`
- `instaclaw_vms.a44e8773...api_mode`: `chatgpt_oauth` (NOT reverted — leaves the DB-side state pointing at ChatGPT for the eventual resume)
- `instaclaw_vms.a44e8773...default_model`: `openai-codex/gpt-5.5` (NOT reverted — same reason)
- `instaclaw_vms.a44e8773...openai_token_version_synced`: `1` (matches user.openai_token_version=1)

Cooper can re-test in Telegram any time post-resume. Token refresh cron will keep `access` fresh until 2026-06-04 even if untouched (~30-day base TTL minus 5-day refresh window).

## Related code references

- Resolver: `node_modules/openclaw/dist/model-auth-Bic7ggHC.js:287` (line 287 is `deferredAuthProfileResult = null` — start of the loop that's failing)
- Profile lookup: `node_modules/openclaw/dist/profile-list-zV5Cv5VC.js:listProfilesForProvider`
- Required shape: `node_modules/openclaw/dist/store-D-8DaAtv.js:hasUsableOAuthCredential$1` (line 384 in the dist)
- Identity mirror logic: `node_modules/openclaw/dist/oauth-BMVacBS0.js:shouldMirrorRefreshedOAuthCredential`
- Doctor check: `node_modules/openclaw/dist/doctor-auth-h77CJ52R.js:hasStoredCodexOAuthProfile`
- Our reconciler push: `lib/vm-reconcile.ts:applyConnectedState` (lines ~8897+ post-fix `195b276f`)
- Our JWT-exp helper: `lib/vm-reconcile.ts:extractCodexJwtExpMs`
