/**
 * Canary the cross-session memory fix on vm-780 only.
 * NO fleet deploy — this is the test-on-one-VM step before any rollout.
 *
 * Deploys, in order:
 *   1. New STRIP_THINKING_SCRIPT (with PERIODIC_SUMMARY_V1, PRE_ARCHIVE_SUMMARY_V1)
 *      via the existing _deploy-strip-thinking-hotfix.ts pattern (atomic
 *      with backup, sentinel-checked).
 *   2. agents.defaults.bootstrapMaxChars: 30000 → 35000 (so MEMORY_FILING
 *      section becomes visible in agent's bootstrap context).
 *   3. Restart gateway to pick up new bootstrapMaxChars.
 *
 * Verifies, in order:
 *   - All 5 sentinels present in the deployed script
 *   - openclaw.json has bootstrapMaxChars=35000 (int)
 *   - Gateway returns /health 200 (with proper 60-90s patience)
 *   - SOUL.md fully visible — no "truncating in injected context" log
 *   - Manually triggers run_periodic_summary_hook by running the script
 *     once with a stub state file forcing the throttle to expire; checks
 *     for "PERIODIC_SUMMARY_V1: ..." log line and session-log.md growth
 *
 * Note: SOUL.md content reorder ships only on next configureOpenClaw
 * (newly-provisioned VMs).  For existing VMs, the bootstrapMaxChars bump
 * alone makes MEMORY_FILING visible.  A separate one-shot fleet patch
 * for the reorder is a follow-up if we want it applied retroactively.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const TARGET = "104.237.151.95";
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const REMOTE = "/home/openclaw/.openclaw/scripts/strip-thinking.py";

async function main(): Promise<void> {
  // Sentinel sanity (matches the deploy script + manifest)
  const sentinels = [
    "def trim_failed_turns",
    "SESSION TRIMMED:",
    "def run_periodic_summary_hook",
    "PERIODIC_SUMMARY_V1",
    "PRE_ARCHIVE_SUMMARY_V1",
  ];
  for (const s of sentinels) {
    if (!STRIP_THINKING_SCRIPT.includes(s)) {
      throw new Error(`STRIP_THINKING_SCRIPT missing sentinel "${s}"`);
    }
  }
  console.log(`[hotfix] script size: ${STRIP_THINKING_SCRIPT.length} chars; all 5 sentinels OK`);

  const ssh = new NodeSSH();
  await ssh.connect({ host: TARGET, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // ── Phase 1: deploy strip-thinking.py via SFTP ──
  console.log("\n── Phase 1: deploy new strip-thinking.py ──");
  const tmpLocal = `/tmp/strip-thinking-canary-${ts}.py`;
  require("fs").writeFileSync(tmpLocal, STRIP_THINKING_SCRIPT, "utf-8");
  try {
    await ssh.putFile(tmpLocal, `${REMOTE}.tmp`);
  } finally {
    require("fs").unlinkSync(tmpLocal);
  }
  const install = await ssh.execCommand(`
set -eu
[ -f ${REMOTE} ] && cp -p ${REMOTE} ${REMOTE}.bak-${ts} || true
python3 -m py_compile ${REMOTE}.tmp
grep -q 'def trim_failed_turns' ${REMOTE}.tmp
grep -q 'SESSION TRIMMED:' ${REMOTE}.tmp
grep -q 'def run_periodic_summary_hook' ${REMOTE}.tmp
grep -q 'PERIODIC_SUMMARY_V1' ${REMOTE}.tmp
grep -q 'PRE_ARCHIVE_SUMMARY_V1' ${REMOTE}.tmp
chmod +x ${REMOTE}.tmp
mv ${REMOTE}.tmp ${REMOTE}
echo "INSTALL_OK lines=$(wc -l < ${REMOTE}) sentinels=$(grep -cE 'def trim_failed_turns|SESSION TRIMMED:|def run_periodic_summary_hook|PERIODIC_SUMMARY_V1|PRE_ARCHIVE_SUMMARY_V1' ${REMOTE})"
`);
  console.log(`  ${install.stdout.trim()}`);
  if (install.code !== 0) throw new Error(`install failed: ${install.stderr}`);

  // ── Phase 2: bump bootstrapMaxChars ──
  console.log("\n── Phase 2: bootstrapMaxChars 30000 → 35000 ──");
  const cfg = await ssh.execCommand(`
source ~/.nvm/nvm.sh 2>/dev/null
echo "before:"
openclaw config get agents.defaults.bootstrapMaxChars 2>&1 || echo "(unset)"
openclaw config set agents.defaults.bootstrapMaxChars 35000 2>&1
echo "after:"
openclaw config get agents.defaults.bootstrapMaxChars 2>&1
`);
  console.log(`  ${cfg.stdout.trim().split("\n").join("\n  ")}`);

  // ── Phase 3: restart gateway, wait properly ──
  console.log("\n── Phase 3: restart gateway, poll /health up to 120s ──");
  const restart = await ssh.execCommand(`
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart openclaw-gateway
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 10
  CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo 000)
  echo "  +$((i*10))s: HTTP $CODE"
  [ "$CODE" = "200" ] && exit 0
done
exit 1
`);
  console.log(restart.stdout.trim().split("\n").map((l) => "  " + l).join("\n"));
  if (restart.code !== 0) {
    console.log("  ⚠️ gateway didn't reach /health 200 in 120s");
  }

  // ── Phase 4: trigger periodic summary manually for canary verification ──
  // Force the throttle to expire by setting last_periodic_summary_ts to 0,
  // then run strip-thinking.py once.  Watch for the PERIODIC_SUMMARY_V1
  // log line and session-log.md growth.
  console.log("\n── Phase 4: manual trigger of periodic summary ──");
  const trigger = await ssh.execCommand(`
set -e
SLOG=$HOME/.openclaw/workspace/memory/session-log.md
MMD=$HOME/.openclaw/workspace/MEMORY.md
STATE=$HOME/.openclaw/.session-summary-state.json

echo "[before] session-log.md size: $(wc -c < "$SLOG" 2>/dev/null || echo 0)"
echo "[before] MEMORY.md size:      $(wc -c < "$MMD" 2>/dev/null || echo 0)"
echo "[before] state file:          $(cat "$STATE" 2>/dev/null || echo '(absent)')"

# Force throttle to expire — the new code reads last_periodic_summary_ts.
# We zero it so the next run will fire immediately if there are >=3 messages
# since baseline.  Also zero last_msg_count so the diff calc considers all
# messages "new".
python3 -c "
import json, os
p = os.path.expanduser('$STATE')
try:
    with open(p) as f: s = json.load(f)
except Exception:
    s = {}
s['last_periodic_summary_ts'] = 0
s['last_periodic_msg_count'] = 0
with open(p + '.tmp', 'w') as f: json.dump(s, f)
os.replace(p + '.tmp', p)
print('forced throttle expiry')
"

# Run strip-thinking.py manually — captures stdout/stderr.
# This invokes run_periodic_summary_hook() if there are enough messages.
echo "[run] python3 $HOME/.openclaw/scripts/strip-thinking.py:"
python3 $HOME/.openclaw/scripts/strip-thinking.py 2>&1 | grep -E 'PERIODIC_SUMMARY_V1|PRE_ARCHIVE_SUMMARY_V1|SESSION TRIMMED|session-end-hook|wrote summary' || echo '  (no relevant log lines emitted this run)'

echo "[after]  session-log.md size: $(wc -c < "$SLOG" 2>/dev/null || echo 0)"
echo "[after]  MEMORY.md size:      $(wc -c < "$MMD" 2>/dev/null || echo 0)"
echo "[after]  USER_FACTS section in MEMORY.md:"
grep -c "INSTACLAW:LATEST_USER_FACTS" "$MMD" 2>/dev/null || echo "  (not present)"
`);
  console.log(trigger.stdout.trim().split("\n").map((l) => "  " + l).join("\n"));
  if (trigger.stderr) console.log(`  stderr: ${trigger.stderr.trim().slice(0, 300)}`);

  // ── Phase 5: confirm bootstrap-truncation status ──
  console.log("\n── Phase 5: confirm bootstrap is no longer truncating SOUL.md ──");
  const truncCheck = await ssh.execCommand(`
SOUL=$HOME/.openclaw/workspace/SOUL.md
echo "SOUL.md size: $(wc -c < $SOUL)"
# Check the most recent journalctl for the truncating log line — if it doesn't
# appear in the last 5 min after the restart, we're winning.
journalctl --user -u openclaw-gateway --since '5 min ago' --no-pager 2>&1 | grep -i 'truncating in injected context' | tail -3 || echo "  (no truncation log lines in last 5 min — likely resolved)"
`);
  console.log(truncCheck.stdout.trim().split("\n").map((l) => "  " + l).join("\n"));

  ssh.dispose();
  console.log(`\n${"=".repeat(60)}\nCanary complete on ${TARGET}.\n${"=".repeat(60)}`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
