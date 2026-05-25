/**
 * lib/bake/strip-bearer.ts — §3.6 automation (per-VM bearer + state strip).
 *
 * The bake VM has gbrain installed with a specific bearer token. That
 * bearer must NOT propagate via the snapshot (every fresh VM should mint
 * its own at first reconcile). This script strips:
 *
 *   1. Per-VM bearer token file       (`~/.gbrain/openclaw-bearer-token.txt`)
 *   2. access_tokens table rows       (PGLite — emptied via CHECKPOINT+DELETE)
 *   3. Phase H verify-marker page     (`pages WHERE slug = '_gbrain-install-verify'`)
 *   4. Service active state           (`systemctl stop` + `disable`)
 *   5. openclaw.json mcp.servers.gbrain entry  (per-VM at first reconcile)
 *
 * Replaces the manual heredoc EOF block in `snapshot-bake-v105-checklist.md` §3.6.
 *
 * Rule 54 (CLAUDE.md) requires CHECKPOINT before SIGKILL on gbrain. We
 * issue an explicit CHECKPOINT via direct PGLite query before stopping
 * the service. The Phase I ExecStop hook would also fire CHECKPOINT,
 * but doing it explicitly here gives us deterministic ordering.
 *
 * Idempotency: every operation is safe to re-run.
 *   - DELETE on already-empty table → 0 rows, OK
 *   - rm -f on already-absent file → no error
 *   - systemctl disable on already-disabled → exit 0
 *   - jq del() on already-absent key → no error
 *
 * Per design doc §1.6 gap-fill item #6.
 */

import { openSsh, sshExec } from "./verifications";

export interface StripBearerResult {
  success: boolean;
  steps_completed: string[];
  steps_failed: string[];
  output: string[];
}

const STRIP_SCRIPT = `set -e
echo "--- STRIP_BEARER_START ---"

# bun lives at ~/.bun/bin/bun and is NOT on PATH in non-interactive SSH
# exec channels (same root cause as nvm — researched 2026-05-25, see
# nvm-sh/nvm#1994). Use absolute path everywhere bun is invoked. Surfaced
# bake attempt 15: \`bun -e\` returned "command not found", the CHECKPOINT
# + DELETE FROM access_tokens never ran — the snapshot would have shipped
# with the bake VM's bearer token still in the table. _postbake-validation.ts
# already uses this exact pattern at line 774 (\`~/.bun/bin/bun --version\`).
BUN_BIN=/home/openclaw/.bun/bin/bun
[ -x "$BUN_BIN" ] || { echo "FAIL: bun binary missing at $BUN_BIN"; exit 1; }

# 1. Pre-kill CHECKPOINT via direct PGLite (Rule 54)
cd ~/gbrain
if systemctl --user is-active --quiet gbrain.service; then
  echo "[1] gbrain.service active — issuing pre-kill CHECKPOINT"
  $BUN_BIN -e "
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite('/home/openclaw/.gbrain/brain.pglite');
    await db.waitReady;
    await db.query('CHECKPOINT');
    console.log('  pre-kill CHECKPOINT issued — pg_control fresh');
    await db.close();
  " 2>&1 | tail -5
else
  echo "[1] gbrain.service already inactive — skipping pre-kill CHECKPOINT"
fi

# 2. SIGKILL + stop gbrain (per Rule 54: SIGKILL not SIGTERM; the unit has KillSignal=SIGKILL)
echo "[2] stopping gbrain.service"
systemctl --user kill --signal=SIGKILL gbrain.service 2>&1 || true
systemctl --user stop gbrain.service 2>&1 || true
sleep 2

# 3. Wipe access_tokens + verify-marker page + final CHECKPOINTs
echo "[3] wiping access_tokens + verify-marker page"
$BUN_BIN -e "
  import { PGlite } from '@electric-sql/pglite';
  const db = new PGlite('/home/openclaw/.gbrain/brain.pglite');
  await db.waitReady;
  await db.query('DELETE FROM access_tokens');
  await db.query('CHECKPOINT');
  console.log('  access_tokens cleared + CHECKPOINT');
  await db.query(\\"DELETE FROM pages WHERE slug = '_gbrain-install-verify'\\");
  await db.query('CHECKPOINT');
  console.log('  verify-marker page cleared + final CHECKPOINT');
  await db.close();
" 2>&1 | tail -10

# 4. Remove bearer token file (idempotent)
echo "[4] removing bearer token file"
rm -f ~/.gbrain/openclaw-bearer-token.txt
rm -f ~/.gbrain/openclaw-bearer-token.txt.*

# 5. Disable service (idempotent — \`disable\` on already-disabled returns 0)
echo "[5] disabling gbrain.service"
systemctl --user disable gbrain.service 2>&1 | tail -2 || true

# 6. Strip openclaw.json mcp.servers.gbrain entry (atomic write)
echo "[6] stripping mcp.servers.gbrain from openclaw.json"
TS=$(date -u +%Y%m%dT%H%M%SZ)
if [ -f ~/.openclaw/openclaw.json ]; then
  cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-bake-strip-$TS.bak
  jq 'del(.mcp.servers.gbrain)' ~/.openclaw/openclaw.json > /tmp/openclaw.json.stripped
  mv /tmp/openclaw.json.stripped ~/.openclaw/openclaw.json
  chmod 600 ~/.openclaw/openclaw.json
  echo "  backup at ~/.openclaw/openclaw.json.pre-bake-strip-$TS.bak"
fi

# 7. Verify final state
echo "--- STRIP_BEARER_VERIFY ---"
echo "bearer file: $(ls ~/.gbrain/openclaw-bearer-token.txt 2>&1 | head -1)"
echo "mcp entry:   $(jq '.mcp.servers.gbrain // \\"absent\\"' ~/.openclaw/openclaw.json 2>/dev/null)"
echo "is-active:   $(systemctl --user is-active gbrain.service 2>&1 || true)"
echo "is-enabled:  $(systemctl --user is-enabled gbrain.service 2>&1 || true)"
echo "access_tokens: $(cd ~/gbrain && $BUN_BIN -e \\"import {PGlite} from '@electric-sql/pglite'; const db=new PGlite('/home/openclaw/.gbrain/brain.pglite'); await db.waitReady; const r=await db.query('SELECT count(*) FROM access_tokens'); console.log(r.rows[0].count); await db.close();\\" 2>&1 | tail -1)"

echo "--- STRIP_BEARER_OK ---"
`;

/**
 * Run the strip-bearer sequence against a bake VM via SSH.
 * Returns success=true on `--- STRIP_BEARER_OK ---` marker present in stdout.
 */
export async function runStripBearer(bakeVmIp: string): Promise<StripBearerResult> {
  const result: StripBearerResult = {
    success: false,
    steps_completed: [],
    steps_failed: [],
    output: [],
  };

  let c;
  try {
    c = await openSsh(bakeVmIp);
    // Heredoc the entire script. Using bash -c <<-EOF would require escaping;
    // instead we base64-encode and pipe.
    const b64 = Buffer.from(STRIP_SCRIPT, "utf-8").toString("base64");
    const cmd = `echo '${b64}' | base64 -d | bash`;
    const r = await sshExec(c, cmd, 120_000);

    const lines = (r.stdout + "\n" + r.stderr).split("\n");
    result.output = lines;

    // Parse step markers from output
    for (const line of lines) {
      const m = line.match(/^\[(\d+)\]/);
      if (m) result.steps_completed.push(`step-${m[1]}`);
    }

    const ok =
      r.code === 0 &&
      lines.some((l) => l.includes("STRIP_BEARER_OK"));
    result.success = ok;
    if (!ok) {
      result.steps_failed.push(`exit=${r.code}; STRIP_BEARER_OK marker absent`);
    }
    return result;
  } catch (e) {
    result.steps_failed.push((e as Error).message);
    return result;
  } finally {
    if (c) c.end();
  }
}

/**
 * Post-strip verification: confirm the snapshot-side invariants hold.
 * Independent of runStripBearer's exit code — useful as a Verification[].
 *
 * Returns an array of {ok, label, detail} that can be summarized at
 * the orchestrator level.
 */
export async function verifyStripped(bakeVmIp: string): Promise<
  Array<{ ok: boolean; label: string; detail: string }>
> {
  const results: Array<{ ok: boolean; label: string; detail: string }> = [];
  let c;
  try {
    c = await openSsh(bakeVmIp);

    // bearer file absent
    const r1 = await sshExec(c, "ls ~/.gbrain/openclaw-bearer-token.txt 2>&1 || true");
    results.push({
      ok: /No such file/.test(r1.stdout) || r1.stdout.trim() === "",
      label: "bearer file absent",
      detail: r1.stdout.trim().slice(0, 100),
    });

    // mcp entry absent (jq returns "absent")
    const r2 = await sshExec(
      c,
      `jq '.mcp.servers.gbrain // "absent"' ~/.openclaw/openclaw.json`,
    );
    results.push({
      ok: r2.stdout.trim() === '"absent"',
      label: "openclaw.json mcp.servers.gbrain absent",
      detail: r2.stdout.trim(),
    });

    // service inactive + disabled
    const r3 = await sshExec(c, "systemctl --user is-active gbrain.service 2>&1 || true");
    results.push({
      ok: r3.stdout.trim() === "inactive",
      label: "gbrain.service is inactive",
      detail: r3.stdout.trim(),
    });
    const r4 = await sshExec(c, "systemctl --user is-enabled gbrain.service 2>&1 || true");
    results.push({
      ok: r4.stdout.trim() === "disabled",
      label: "gbrain.service is disabled",
      detail: r4.stdout.trim(),
    });

    // access_tokens count = 0
    // bun absolute path — same root cause as STRIP_SCRIPT (bake attempt 15
    // 2026-05-25): \`bun\` not on PATH in non-interactive SSH exec channels.
    const r5 = await sshExec(
      c,
      `cd ~/gbrain && /home/openclaw/.bun/bin/bun -e "import {PGlite} from '@electric-sql/pglite'; const db=new PGlite('/home/openclaw/.gbrain/brain.pglite'); await db.waitReady; const r=await db.query('SELECT count(*) FROM access_tokens'); console.log(r.rows[0].count); await db.close();" 2>&1 | tail -1`,
      45_000,
    );
    const count = parseInt(r5.stdout.trim(), 10);
    results.push({
      ok: count === 0,
      label: "access_tokens row count = 0",
      detail: `count=${r5.stdout.trim()}`,
    });
  } catch (e) {
    results.push({
      ok: false,
      label: "strip-bearer verify",
      detail: `SSH error: ${(e as Error).message.slice(0, 100)}`,
    });
  } finally {
    if (c) c.end();
  }
  return results;
}
