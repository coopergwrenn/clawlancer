# gbrain HTTP Sidecar — Fleet Rollout

**Status:** Canary VALIDATED on vm-050 (@timmytimmytimbot), 2026-05-15. Ready to design fleet rollout.

## TL;DR

Replace the per-session stdio gbrain spawn (90+ second cold-start, hallucinated saves, session-killing race conditions in v0.28.1) with a persistent HTTP sidecar (systemd user service, loopback-only, bearer auth, <1s tool latency). Architecture validated end-to-end with real memory writes via @timmytimmytimbot.

---

## Canary results — vm-050, 2026-05-15

### Raw performance numbers

| Operation | Direct curl | Live agent (Telegram → put_page → reply) |
|---|---|---|
| `/health` (no auth) | **7-9 ms** | — |
| `/mcp` initialize handshake (bearer auth) | **37-49 ms** | — |
| `put_page` write (1 chunk, OpenAI embed) | **564-781 ms** | **564 ms** (line 84 tool latency) |
| `get_page` read | **47 ms** | — |
| Full agent turn (Telegram receive → put_page → "Locked in" reply) | — | **6.8 sec** (sonnet think + tool + wrap) |
| Concurrent client handshakes (5 parallel) | 24-90 ms each, **same PID** | — |
| Sidecar memory | 287-311 MB resident | (steady-state) |
| Sidecar CPU | ~5 sec total over 27 min | (idle between calls) |

### Live-agent timeline of "remember this: my favorite color is green"

```
23:36:32.046  Cooper's message hits session.jsonl (line 81)
23:36:36.454  Sonnet emits gbrain__put_page tool call (line 83)  [+4.4s think]
23:36:37.018  gbrain HTTP responds: status="created_or_updated" (line 84)  [+0.564s tool]
23:36:38.813  Sonnet emits "Locked in — favorite color is green 🟢" (line 85)  [+1.8s wrap]
                                                                      6.8s end-to-end
```

The slug `cooper-favorite-color` was updated from my pre-seed to timmy's write — proof timmy actually called the tool (not a hallucination per Rule 28/29). Tool result line 84 captures `mcpServer: "gbrain", mcpTool: "put_page"`.

### Follow-up tests (2026-05-15, both same-minute responses)

- 7:46 PM: "what's my favorite color?" → "Green 🟢" — read path via `gbrain__search` or `gbrain__get_page`
- 7:50 PM: "remember this: my favorite pizza topping is pepperoni" → "Saved — pepperoni it is 🍕" — second write, new slug `cooper-favorite-pizza-topping`

Two pages in PGLite after the canary:
```
cooper-favorite-color           (updated 23:36:36)
cooper-favorite-pizza-topping   (updated 23:50:39)
```

### Before/after

| Failure mode | Before (stdio v0.28.1) | After (HTTP sidecar v0.35.0.0) |
|---|---|---|
| First tool call latency | 90+ sec (process spawn + bun load + PGLite open + handshake) | **~564 ms** (HTTP keep-alive to running server) |
| Per-message spawn | YES — every session re-spawns gbrain subprocess | NO — single persistent process, lazy-on-getCatalog connect |
| Stdin EOF race | YES — handshake killed mid-init (v0.28.1 bug, fixed in v0.34.1.0 via MCP_STDIO=1) | N/A — no stdio path |
| Auth | None (stdio implicit trust) | Bearer token in `access_tokens` table, mTLS-equivalent via loopback |
| Network exposure | None (stdio) | Loopback-only (127.0.0.1:3131, external IP refuses) |
| RAM at fleet scale | ~120 MB per concurrent agent session | **~300 MB total per VM, regardless of session count** |
| User-perceived UX | Frequent "Something went wrong" + 90s waits | Same-minute writes, instant reads |

---

## Install checklist

Each step has a verify gate. Skip nothing.

### Prerequisites (already satisfied on standard InstaClaw VMs)

- bun installed at `/home/openclaw/.bun/bin/bun`
- node v22.x at `/home/openclaw/.nvm/versions/node/v22.22.2/`
- `loginctl show-user openclaw | grep Linger=yes` returns true (systemd user services persist across logout)
- openclaw-gateway is `active` and `/health` returns 200

### Step 1 — Install gbrain from git (NOT npm)

**CRITICAL: `npm "gbrain"` is a typosquat** (stormcolor/gbrain @ v1.3.1, "GPU JavaScript Library for Machine Learning"). The real package is at `https://github.com/garrytan/gbrain.git` and is NOT on npm.

```bash
# Fresh install
git clone https://github.com/garrytan/gbrain.git \
  /home/openclaw/.bun/install/global/node_modules/gbrain
cd /home/openclaw/.bun/install/global/node_modules/gbrain
bun install
bun link  # creates /home/openclaw/.bun/bin/gbrain symlink

# Update existing install
cd /home/openclaw/.bun/install/global/node_modules/gbrain
git fetch origin master
git merge --ff-only origin/master  # if local mods exist: git checkout -- src/cli.ts first
bun install
```

**Verify:** `gbrain --version` prints `0.35.0.0` or later. Source at `~/.bun/install/global/node_modules/gbrain/.git/HEAD` matches origin/master.

### Step 2 — Initialize PGLite

```bash
# CRITICAL: unset env var — v0.35.0.0 uses ~/.gbrain/config.json
unset GBRAIN_DATABASE_URL

# Fresh init (only on bare VM, or when existing PGLite is corrupt)
gbrain init --pglite
```

This creates `~/.gbrain/config.json` (`{"engine":"pglite","database_path":"/home/openclaw/.gbrain/brain.pglite"}`) and applies all 62 schema migrations (v1 → v66).

**On an existing brain:** do NOT re-init. Leave the existing PGLite in place. Skip to step 3.

**Verify:** `~/.gbrain/brain.pglite/` exists. Schema includes `access_tokens` and `pages` tables. `gbrain doctor` reports `[OK] connection: Connected, N pages`.

### Step 3 — Mint bearer token (PGLite-direct INSERT)

`gbrain auth create` is **broken on PGLite in v0.35.0.0** — it uses bare `postgres()` library which can only speak TCP to a real Postgres server, not PGLite. Workaround: insert the token row directly via gbrain's bundled `@electric-sql/pglite`.

Sidecar MUST be stopped (PGLite is exclusive-lock). Run this from `~/.bun/install/global/node_modules/gbrain` working directory (so bun resolves `@electric-sql/pglite`):

```typescript
// /tmp/mint-token.ts
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, chmodSync } from 'fs';

const DB_PATH = '/home/openclaw/.gbrain/brain.pglite';
const NAME = 'openclaw-vm';
const TOKEN_FILE = '/home/openclaw/.gbrain/openclaw-bearer-token.txt';

const db = new PGlite(DB_PATH);
await db.waitReady;
try {
  await db.query(`DELETE FROM access_tokens WHERE name = $1`, [NAME]);
  const token = 'gbrain_' + randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(`INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`, [NAME, hash]);
  writeFileSync(TOKEN_FILE, token, 'utf-8');
  chmodSync(TOKEN_FILE, 0o600);
  console.log('TOKEN_MINTED');
} finally {
  await db.close();
}
```

```bash
cd /home/openclaw/.bun/install/global/node_modules/gbrain
bun run /tmp/mint-token.ts
```

**Verify:** `cat ~/.gbrain/openclaw-bearer-token.txt` shows a 71-char string starting `gbrain_`. File mode is 600. Subsequent verify script reads the file, sha256s it, and compares against the DB row's `token_hash` — must match exactly.

### Step 4 — Install systemd user unit

Write `~/.config/systemd/user/gbrain.service` with the secret values from the existing openclaw.json's `mcp.servers.gbrain.env` (do NOT set `GBRAIN_DATABASE_URL`):

```ini
[Unit]
Description=GBrain MCP HTTP sidecar (persistent, loopback-only)
Documentation=https://github.com/garrytan/gbrain
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=/home/openclaw/.bun/install/global/node_modules/gbrain
Environment=PATH=/home/openclaw/.bun/bin:/home/openclaw/.nvm/versions/node/v22.22.2/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/openclaw
Environment=OPENAI_API_KEY=<from existing openclaw.json>
Environment=ANTHROPIC_API_KEY=<from existing openclaw.json>
Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
ExecStart=/home/openclaw/.bun/bin/bun run /home/openclaw/.bun/install/global/node_modules/gbrain/src/cli.ts serve --http --port 3131
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gbrain
MemoryHigh=2G
MemoryMax=2500M
TasksMax=50
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"  # Rule 5 / MEMORY.md DBUS workaround
systemctl --user daemon-reload
systemctl --user enable --now gbrain.service
```

**Verify (poll up to 30s):**
- `systemctl --user is-active gbrain.service` returns `active`
- `ss -lnpt | grep 3131` shows `127.0.0.1:3131` (NOT 0.0.0.0:3131)
- `curl http://127.0.0.1:3131/health` returns 200 with `{"status":"ok","version":"0.35.0.0","engine":"pglite"}`
- External-IP probe must fail: `bash -c '</dev/tcp/<external-ip>/3131'` → connection refused

### Step 5 — Pre-flip MCP smoke test

```bash
TOKEN=$(cat /home/openclaw/.gbrain/openclaw-bearer-token.txt)
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer","version":"1"}}}' \
  http://127.0.0.1:3131/mcp
```

**Verify:** response includes `{"protocolVersion":"2025-06-18", "serverInfo":{"name":"gbrain","version":"0.35.0.0"}}`. Latency < 100 ms.

A `tools/list` request must include `put_page`, `get_page`, `search`, `recall`, `query`. If any are missing, STOP — schema may be incomplete.

### Step 6 — Backup openclaw.json + flip mcp.servers.gbrain

```bash
BAK="/home/openclaw/.openclaw/openclaw.json.pre-http-sidecar-flip-$(date -u +%Y%m%dT%H%M%S).bak"
cp -p /home/openclaw/.openclaw/openclaw.json "$BAK"
cp -p /home/openclaw/.openclaw/openclaw.json /home/openclaw/.openclaw/openclaw.json.last-known-good

TOKEN=$(cat /home/openclaw/.gbrain/openclaw-bearer-token.txt)

# Atomic edit — jq into tmp, validate, mv into place
jq --arg auth "Bearer $TOKEN" '.mcp.servers.gbrain = {
  "transport": "streamable-http",
  "url": "http://127.0.0.1:3131/mcp",
  "headers": {"Authorization": $auth},
  "connectionTimeoutMs": 5000
}' /home/openclaw/.openclaw/openclaw.json > /tmp/openclaw.json.new

jq empty /tmp/openclaw.json.new || exit 1  # JSON validity check

mv /tmp/openclaw.json.new /home/openclaw/.openclaw/openclaw.json
chmod 600 /home/openclaw/.openclaw/openclaw.json
```

**Verify:** `jq '.mcp.servers.gbrain.transport' /home/openclaw/.openclaw/openclaw.json` prints `"streamable-http"`. Old `command`/`args`/`env` fields are GONE.

### Step 7 — Restart gateway with Rule 5 verify

```bash
systemctl --user restart openclaw-gateway

# Poll active + /health=200 for up to 90s (gateway with 8 plugins takes ~75s cold)
HEALTHY=0
for i in $(seq 1 18); do
  STATUS=$(systemctl --user is-active openclaw-gateway 2>&1)
  HTTP=$(curl -sf -o /dev/null -w "%{http_code}" -m 3 localhost:18789/health 2>&1)
  [ "$STATUS" = "active" ] && [ "$HTTP" = "200" ] && { HEALTHY=1; break; }
  sleep 5
done

if [ "$HEALTHY" = "0" ]; then
  # ROLLBACK per Rule 5 — never leave a crash-looping gateway
  cp -p "$BAK" /home/openclaw/.openclaw/openclaw.json
  systemctl --user restart openclaw-gateway
  echo "FATAL: gateway didn't recover; rolled back" >&2
  exit 1
fi
```

**Verify:**
- `journalctl --user -u openclaw-gateway --since "5 minutes ago" | grep GATEWAY_ROLLBACK_TRIGGERED` returns nothing (Rule 34)
- gateway journal shows `[gateway] ready`
- `mcp.servers.gbrain` on disk still matches what we wrote (Rule 34 — verify-after-restart)

### Step 8 — End-to-end live test

Send a test memory write to the agent via its primary channel (Telegram, in this case). Send: `remember this: <some unique fact>`.

**Verify (in this order):**
1. Agent responds within 10 seconds (vs 90s stdio cold-start)
2. Response acknowledges the save ("Locked in", "Got it", "Saved")
3. Direct curl `list_pages` against the sidecar shows a new page with the fact's content
4. Session jsonl (`~/.openclaw/agents/main/sessions/<id>.jsonl`) contains a `gbrain__put_page` toolCall block

If 1+2 succeed but 3+4 fail: **STOP. The agent hallucinated the save (Rule 29).** Investigate SOUL.md routing.

Send a recall: `what's my <fact>?`. Agent should respond with the actual fact (not "I don't remember"), demonstrating the read path.

---

## Known issues (P1 followups, NOT canary blockers)

### Issue 1 — `gbrain auth create` broken on PGLite

**Symptom:** running `gbrain auth create <name>` against a PGLite brain fails with `ECONNREFUSED ::1:5432`.

**Root cause:** `src/commands/auth.ts` imports `postgres` (the JS lib) directly and calls `postgres(databaseUrl)` to insert into `access_tokens`. PGLite has no wire-protocol TCP listener, so this fails. The other gbrain code paths use `engine.executeRaw` which DOES work with PGLite — the auth command was an oversight.

**Workaround:** mint tokens via direct PGLite INSERT (step 3 above).

**Long-term fix:** file upstream issue with garrytan/gbrain. The fix is one-line: change `auth.ts` to use `createEngine + engine.executeRaw` instead of bare `postgres()`. Pattern already proven in `oauth-provider.ts` (uses SqlQuery type that works for both PGLite and Postgres).

### Issue 2 — `minions_migration` doctor warning is cosmetic

**Symptom:** `gbrain doctor` always reports `[FAIL] minions_migration: WEDGED MIGRATION(s): 0.28.0` even on a fresh PGLite database.

**Root cause:** on a fresh DB, migration v0.28.0 ("Takes ship") has no data to migrate, so it returns PARTIAL. Doctor's "≥3 consecutive partials = wedged" heuristic fires on the first run because PARTIAL doesn't reset to RUN on fresh DBs.

**Impact:** none on memory ops. `put_page`, `get_page`, `search`, `recall` all work at schema v66.

**Workaround:** ignore the warning. Don't run `--force-retry 0.28.0` — it writes a retry marker but the next apply-migrations run still reports PARTIAL.

**Long-term fix:** upstream — the doctor's wedge detection should distinguish "PARTIAL because no data" from "PARTIAL because failed".

### Issue 3 — systemd `StartLimitIntervalSec` placement

**Symptom:** if `StartLimitIntervalSec` and `StartLimitBurst` are in `[Service]` section, systemd warns:
```
gbrain.service:20: Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
```
and uses default rate limits.

**Fix:** these keys belong in `[Unit]` section, not `[Service]`. The install checklist above places them correctly. Cosmetic — service still starts and runs.

### Issue 4 — `bun install -g gbrain` resolves to a typosquat

**Symptom:** `bun install -g gbrain@latest` "succeeds" but installs `stormcolor/gbrain` v1.3.1 ("GPU JavaScript Library for Machine Learning") — a completely unrelated package that shares the npm name.

**Mitigation:** **never use npm/bun to install gbrain.** Always `git clone https://github.com/garrytan/gbrain.git`. Add this to the fleet install scripts as a hard-coded URL.

**Reference:** garrytan's `INSTALL_FOR_AGENTS.md` explicitly warns:
> Do NOT use `bun install -g github:garrytan/gbrain`. Bun blocks the top-level postinstall hook on global installs, so schema migrations never run and the CLI aborts with `Aborted()` when it opens PGLite.

### Issue 5 — `GBRAIN_DATABASE_URL` env var must be unset

**Symptom:** if `GBRAIN_DATABASE_URL=pglite:///path` is exported when running `gbrain serve --http`, the server dies at startup with `Cannot connect to database: . Fix: Check your connection URL in ~/.gbrain/config.json`.

**Root cause:** v0.35.0.0 reads engine config from `~/.gbrain/config.json` and ignores the `pglite://` URL format. The new code tries to parse the env var as a Postgres URL and fails.

**Fix:** do NOT set `GBRAIN_DATABASE_URL` in the systemd unit's `Environment=` directives. Let gbrain read from config.json.

---

## Rollback path

If the flip causes any issue (gateway crash loop, agent stops responding, memory writes failing):

```bash
# Restore openclaw.json — restart gateway — done
cp -p /home/openclaw/.openclaw/openclaw.json.pre-http-sidecar-flip-*.bak \
      /home/openclaw/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway

# Optional: stop sidecar (saves 300 MB)
systemctl --user disable --now gbrain.service

# Verify
systemctl --user is-active openclaw-gateway   # → active
curl -sf localhost:18789/health               # → 200
```

The pre-flip openclaw.json has the original `command`/`args`/`env` stdio config. Agent goes back to stdio spawning (90s cold-start re-introduced, but functional).

**PGLite backup recovery** (if the DB needs restoring):
```bash
systemctl --user stop gbrain.service
rm -rf /home/openclaw/.gbrain/brain.pglite
tar xzf /home/openclaw/.gbrain/brain.pglite.PRE-WIPE-*.tar.gz -C /home/openclaw/.gbrain/
systemctl --user start gbrain.service
```

---

## Followup items (P1)

1. **Upstream `gbrain auth create` fix** — submit issue + PR to garrytan/gbrain to swap bare `postgres()` for `engine.executeRaw` in `src/commands/auth.ts`. Eliminates the direct-PGLite-INSERT workaround in step 3.

2. **Investigate the 148s stuck session on vm-050** — the queue-blocking pre-existing request from before the gateway restart. Likely a heartbeat or phantom Telegram event. Not architecture-related but should be reproduced and fixed before fleet rollout to avoid first-message lag on freshly-flipped VMs.

3. **Schema-migration cleanup** — figure out why `minions_migration` reports WEDGED on fresh DBs. Either fix upstream doctor logic or accept the warning permanently.

4. **Bake the sidecar into the snapshot** — once fleet rollout is stable, bake a new Linode snapshot that includes the gbrain v0.35.0.0 git clone + the systemd unit template (token + openclaw.json flip happen per-VM during configureOpenClaw). Avoids 30 sec of bun install per VM during provisioning.

5. **Coverage query (Rule 27)** — write `scripts/_coverage-gbrain-sidecar.ts` that probes the fleet for: (a) systemd gbrain.service active, (b) port 3131 loopback bound, (c) openclaw.json transport=streamable-http, (d) bearer token row in PGLite. Daily/hourly fleet health check.

6. **Reconciler step (Rule 23 / Rule 34)** — add `stepGbrainSidecar` to `lib/vm-reconcile.ts` with `requiredSentinels: ["gbrain serve --http", "--port 3131", "Authorization"]`. Ensures fleet-wide consistency post-rollout.

7. **Manifest version bump (Rule 47)** — once the reconciler step lands, bump `VM_MANIFEST.version` so existing caught-up VMs re-enter the candidate queue and pick up the gbrain sidecar config.

---

## Fleet rollout proposal (high-level)

**Phase 1 (next 24h)** — soak vm-050 (current canary) for stability. Send 10-20 real memory writes/recalls. Verify no regressions. Check sidecar uptime daily.

**Phase 2 (3 VMs)** — pick 3 paying-customer VMs with active gbrain usage. Apply the install checklist manually via a one-shot script (`scripts/_install-gbrain-sidecar-on-vm.ts`). Soak 24h each.

**Phase 3 (canary cohort of 10)** — extend to 10 VMs with diverse usage profiles (light, medium, heavy memory use). Watch for HTTP connection pool issues, memory leaks, anything sidecar-specific.

**Phase 4 (reconciler-driven fleet)** — land `stepGbrainSidecar` in `lib/vm-reconcile.ts` + bump `VM_MANIFEST.version`. Fleet drifts onto the new architecture over ~24h via natural reconcile cron cycles.

**Phase 5 (snapshot bake)** — bake new Linode snapshot with sidecar pre-installed. New VMs come up with sidecar already running.

**Phase 6 (cleanup)** — once 100% fleet is on sidecar, delete the stdio code path entirely. No more `command`/`args` fallback in configureOpenClaw.
