# V2 Trim Canary — 24h Soak Check + Phase 3 Rollout Handoff

**Created**: 2026-05-12 ~18:35 UTC
**Fires**: 2026-05-13 ~18:23 UTC (14:23 EDT) — 24h after deploy
**Authorization**: Cooper said: *"if the soak passes clean, start the rollout autonomously. don't wait for me."*

## State at handoff

vm-733 is running a trimmed AGENTS.md V2 (32% smaller than HEAD pre-trim).

| Field | Value |
|---|---|
| vm-733 IP | 172.104.15.146 |
| Current AGENTS.md sha256 | `0eb8d70beecd6182243345b4ea5eec8295b30a37e560137325eb8d7c3d5a4979` |
| AGENTS.md size | 13,919 chars (14,037 UTF-8 bytes) |
| Backup file | `/home/openclaw/.openclaw/workspace/AGENTS.md.pre-trim-backup-2026-05-12` (sha256 `77b8037d…`) |
| Backup sha (pre-trim) | `77b8037db4528f7f89213dd2456226bdabd08b95ded5c6e22f343c8c490b118d` |
| Deploy time | 2026-05-12 17:41:34 UTC |
| Gateway MainPID at deploy | 1304514 |
| Pre-canary test PASS rate | 13/15 effective (10 clear + 3 retry-artifact passes), 1 sudo-as-permission accepted by Cooper, 1 gateway empty-response flake |

## STEP 1 — Soak check (must pass before Phase 3)

```bash
# Run this from /Users/cooperwrenn/wild-west-bots/instaclaw — full diagnostic script
cat > /tmp/_vm733_soak_check.cjs << 'EOF'
const { readFileSync } = require('fs');
for (const f of ['/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local','/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key']) {
  const env = readFileSync(f, 'utf-8');
  for (const l of env.split('\n')) { const m = l.match(/^([^#=]+)=(.*)$/); if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); }
}
const { NodeSSH } = require('/Users/cooperwrenn/wild-west-bots/instaclaw/node_modules/node-ssh/lib/cjs/index.js');
(async () => {
  const ssh = new NodeSSH();
  await ssh.connect({ host: '172.104.15.146', username: 'openclaw', privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64, 'base64').toString('utf-8'), readyTimeout: 15000 });
  const expectedSha = '0eb8d70beecd6182243345b4ea5eec8295b30a37e560137325eb8d7c3d5a4979';
  // 1. AGENTS.md sha unchanged
  const sha = (await ssh.execCommand('sha256sum /home/openclaw/.openclaw/workspace/AGENTS.md | awk \'{print $1}\'')).stdout.trim();
  console.log('AGENTS.md sha:', sha, sha === expectedSha ? '✓ unchanged' : '✗ CHANGED');
  // 2. Gateway active
  const DBUS = 'export XDG_RUNTIME_DIR=/run/user/$(id -u) && export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus';
  const act = (await ssh.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`)).stdout.trim();
  console.log('Gateway active:', act);
  // 3. /health
  const h = (await ssh.execCommand('curl -sS -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health')).stdout.trim();
  console.log('Gateway health:', h);
  // 4. Journal — count error/fatal/crash since deploy
  const j = (await ssh.execCommand('journalctl --user -u openclaw-gateway --since "24 hours ago" --no-pager 2>&1 | grep -iE "sigterm|fatal|crash|panic" | wc -l')).stdout.trim();
  console.log('SIGTERM/fatal/crash/panic count (24h):', j);
  // 5. Gateway uptime
  const ts = (await ssh.execCommand(`${DBUS} && systemctl --user show openclaw-gateway --property=ActiveEnterTimestamp --value`)).stdout.trim();
  console.log('Gateway started:', ts);
  // 6. 1 smoke prompt (just confirm responsiveness)
  const r = await ssh.execCommand(`
TOKEN=$(grep '^GATEWAY_TOKEN=' /home/openclaw/.openclaw/.env | cut -d= -f2)
echo '{"model":"openclaw","messages":[{"role":"user","content":"reply with the single word PONG"}]}' > /tmp/_smoke_req.json
curl -sS -m 60 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@/tmp/_smoke_req.json" http://localhost:18789/v1/chat/completions
rm /tmp/_smoke_req.json
`);
  let smokeOk = false;
  try {
    const parsed = JSON.parse(r.stdout);
    const c = parsed?.choices?.[0]?.message?.content || '';
    smokeOk = c.toUpperCase().includes('PONG');
    console.log('Smoke prompt response:', JSON.stringify(c).slice(0, 200));
  } catch (e) { console.log('Smoke parse failed:', r.stdout.slice(0, 200)); }
  console.log('Smoke PASS:', smokeOk ? '✓' : '✗');
  ssh.dispose();
  const allOk = sha === expectedSha && act === 'active' && h === '200' && parseInt(j, 10) === 0 && smokeOk;
  console.log('\n=== SOAK VERDICT ===');
  console.log(allOk ? '✓ ALL CLEAN — proceed to Phase 3' : '✗ SOAK FAILED — STOP, investigate before Phase 3');
  process.exit(allOk ? 0 : 1);
})();
EOF
node /tmp/_vm733_soak_check.cjs
```

**Pass criteria (all must hold):**
- AGENTS.md sha256 still `0eb8d70b…` (file not reverted)
- Gateway active
- /health = 200
- 0 SIGTERM/fatal/crash/panic lines in journal over 24h window
- Smoke prompt returns "PONG" (or contains it case-insensitively)

If any criterion fails → STOP. Do NOT proceed to Phase 3. Report to Cooper.

## STEP 2 — Pick 5 diverse canary VMs

Query Supabase for candidates. Pick ONE each from:
- **starter, no partner** (highest count tier, simplest agent)
- **pro, no partner** (mid tier)
- **power, no partner** (heaviest tier)
- **starter, edge_city** (partner-tagged → exercises SOUL_STUB_EDGE during migration)
- **pro, no partner OR consensus_2026** (5th slot — pick consensus_2026 if a healthy one exists)

```sql
-- Quick candidate query
SELECT name, config_version, tier, partner, telegram_bot_username
FROM instaclaw_vms
WHERE health_status = 'healthy'
  AND config_version = (SELECT MAX(config_version) FROM instaclaw_vms WHERE config_version IS NOT NULL)
  AND telegram_bot_username IS NOT NULL
  AND assigned_to IS NOT NULL
  AND tier = 'starter' AND partner IS NULL
LIMIT 1;
-- (repeat for each tier × partner combo)
```

**Exclude**:
- vm-050, vm-780 (Cooper's own — keep stable for now)
- vm-354 (Timour @edgeclaw1bot — Edge City demo, byte-perfect preservation requirement)
- vm-729, vm-725, vm-435 (high-value users per CLAUDE.md — Doug, Notboredclaw, etc.)
- Any VM in the `freelancer` or `power` tier that has shown recent activity (avoid disrupting active sessions)

**Confirm picks pre-migration**:
- Each has a healthy gateway (curl health = 200)
- Each is V1 (no SOUL_V2_MARKER on disk)
- Each has session-log.md not bloated (≤ 50KB)
- Each has tar backup space available (df shows ≥ 2GB free on /home/openclaw)

## STEP 3 — Run V2 migration on the 5 picks

The migration step is `stepMigrateSoulV2` in `lib/vm-reconcile.ts:4365`. It's gated by:
- `RECONCILE_SOUL_MIGRATION_ENABLED=true` (required, currently NOT set in Vercel)
- `RECONCILE_SOUL_MIGRATION_VM_IDS=<comma-separated UUIDs>` (whitelist scope)

**Path A (safer, recommended)**: run a local script with these env vars set, targeting ONLY the 5 picks. Don't touch Vercel env (that would risk fleet-wide auto-migration on next cron tick).

Reference script: `scripts/_canary-v2-migration.ts` if it exists (per soul-md-trim-2026-05-11.md §9). If absent, write one based on `_catch-up-stuck-cohort.ts` pattern:
- Acquire reconcile-fleet cron lock
- For each of the 5 picks: set env vars, call `reconcileVM(strict: false)`, capture result, restore env
- Release lock

**Path B (faster but blunt)**: set the env vars in Vercel and let the existing reconcile-fleet cron pick them up. Risk: any other VM passing the strict-cohort filter would also migrate. AVOID unless certain the whitelist filter prevents fleet-wide spread.

## STEP 4 — Re-run canary suite per migrated VM

After each VM completes migration:
1. SSH to verify: SOUL_V2_MARKER + AGENTS_V2_MARKER + IDENTITY_V2_MARKER + TOOLS_V2_MARKER all present on respective files
2. Tar backup exists at `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz` and ≥ 1KB
3. AGENTS.md sha matches the trimmed version (`0eb8d70b…`) — wait, this only if the migration also picks up the trimmed template. The trim is local to my working tree, not in main yet. If migration uses HEAD-version templates, it'll write the UN-TRIMMED V2 AGENTS.md.

**Important**: the trimmed AGENTS.md change is on branch `fix/reconciler-systemd-verify-trailing-newline` (commit `df63f3d4`) but the AGENTS trim itself is uncommitted in the working tree. Before Phase 3 migration writes the trimmed version, the trim must be committed and either:
- Merged to main (Vercel cron picks up automatically), OR
- The local migration script must run from the working tree with the trim applied

If Cooper hasn't approved the AGENTS trim PR yet, **don't proceed with Phase 3 using the un-trimmed V2 template** — that defeats the purpose. Either get approval first or skip.

5. Run the 15-prompt canary suite on each migrated VM (template at `/tmp/_vm733_canary_runner.cjs`, generalize VM_IP). Target: ≥85% effective behavior PASS rate per VM (matching vm-733's baseline).

## STEP 5 — Soak the 5-VM cohort for 24h before fleet rollout

After Phase 3 migrations + per-VM canary tests all pass, the 5 VMs should soak for 24h. Then Phase 4 (full fleet rollout) per the PRD.

## Pre-existing P1 to flag for gbrain terminal (separate from this work)

vm-733 synthetic tests showed 3/15 prompts hit `[agent/embedded] empty response detected ... retrying 1/1 with visible-answer continuation`. Pre-existing OpenClaw 2026.4.26 behavior, not introduced by the trim. Cooper instruction: "flag it for the gbrain terminal to investigate after catch-up finishes."

## Rollback

If anything in Phase 3 goes wrong:

**vm-733 trim rollback:**
```bash
ssh openclaw@172.104.15.146 \
  "cp -p ~/.openclaw/workspace/AGENTS.md.pre-trim-backup-2026-05-12 ~/.openclaw/workspace/AGENTS.md && \
   export XDG_RUNTIME_DIR=/run/user/\$(id -u) && \
   export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus && \
   systemctl --user restart openclaw-gateway"
```

**Phase 3 V2 migration rollback per VM:**
```bash
# Per stepMigrateSoulV2, the migration creates ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz
ssh openclaw@<vm-ip> \
  "cd ~/.openclaw && rm -rf workspace.broken && mv workspace workspace.broken && \
   tar xzf workspace-pre-soul-v2-migration.tar.gz && \
   export XDG_RUNTIME_DIR=/run/user/\$(id -u) && \
   export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus && \
   systemctl --user restart openclaw-gateway"
```

## Key references

- Trim PRD: `instaclaw/docs/prd/soul-md-trim-2026-05-11.md`
- V2 architecture PRD: `instaclaw/docs/prd/prd-soul-restructure.md`
- Trimmed template (working tree, uncommitted): `lib/workspace-templates-v2.ts` `WORKSPACE_AGENTS_MD_V2`
- Migration code: `lib/vm-reconcile.ts` `stepMigrateSoulV2` (line 4365)
- Canary runner template: `/tmp/_vm733_canary_runner.cjs`
- Canary results: `/tmp/_vm733_canary_summary.md`
- Cooper's repeated rules:
  - NEVER deploy without --dry-run first
  - NEVER skip canary phase
  - Verify-after-write on every config set (Rule 10)
  - SSH-using scripts must load BOTH .env.local AND .env.ssh-key (Rule 18)
  - Use `.select("*")` for safety-critical DB reads (Rule 19)
  - Coerce PostgREST returns to Number for Map keys (Rule 21)
  - Patience > speed; diagnose before retry
