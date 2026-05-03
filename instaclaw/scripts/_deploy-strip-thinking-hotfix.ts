/**
 * Hotfix deploy: push the freshly-edited strip-thinking.py (with the
 * trim-instead-of-nuke empty_responses path) to a target VM.
 *
 * Imports STRIP_THINKING_SCRIPT from lib/ssh.ts so the canonical codebase is
 * the single source of truth — no inline duplication.
 *
 * Usage:
 *   npx tsx scripts/_deploy-strip-thinking-hotfix.ts --ip=<addr>
 *   npx tsx scripts/_deploy-strip-thinking-hotfix.ts --ip=<addr> --dry-run
 *
 * Behavior:
 *   1. Read STRIP_THINKING_SCRIPT from the codebase (template literals already
 *      evaluated at module load).
 *   2. SSH to target, `python3 -c "compile(open(...).read(),'',c)"` the new
 *      script content as a syntax check before installing.
 *   3. Backup current ~/.openclaw/scripts/strip-thinking.py to .bak-<ts>.
 *   4. Atomic-write new version (tmp + mv).
 *   5. Verify it runs (smoke: `python3 -m py_compile`).
 *   6. Quick assertion that the new code path is present.
 *
 * Idempotent.  Failed deploys leave the .bak in place for manual restore.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

const REMOTE_PATH = "$HOME/.openclaw/scripts/strip-thinking.py";

const args = process.argv.slice(2);
const TARGET_IP = args.find((a) => a.startsWith("--ip="))?.slice(5);
const DRY_RUN = args.includes("--dry-run");
if (!TARGET_IP) {
  console.error("Usage: _deploy-strip-thinking-hotfix.ts --ip=<addr> [--dry-run]");
  process.exit(1);
}

async function main(): Promise<void> {
  // Sanity: confirm the new code path is in the script.  If lib/ssh.ts wasn't
  // saved, abort before SSH.
  // Sentinels match vm-manifest.ts STRIP_THINKING_SCRIPT requiredSentinels.
  // Both function-signature AND log-line markers — a refactor that renames
  // one would still trip the other.  Each pair represents one load-bearing
  // fix; missing either suggests stale module cache (Rule 23).
  const sentinels = [
    "def trim_failed_turns", "SESSION TRIMMED:",         // 2026-05-02 trim-not-nuke
    "def run_periodic_summary_hook", "PERIODIC_SUMMARY_V1", // 2026-05-03 periodic memory
    "PRE_ARCHIVE_SUMMARY_V1",                              // 2026-05-03 pre-archive safety net
  ];
  for (const s of sentinels) {
    if (!STRIP_THINKING_SCRIPT.includes(s)) {
      throw new Error(`STRIP_THINKING_SCRIPT is missing sentinel "${s}" — did you save lib/ssh.ts?`);
    }
  }
  console.log(`[hotfix] script size: ${STRIP_THINKING_SCRIPT.length} chars`);
  console.log(`[hotfix] sentinels present: ${sentinels.join(", ")}`);

  if (DRY_RUN) {
    console.log("[hotfix] --dry-run set; not connecting. Exiting clean.");
    return;
  }

  const sshKeyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!sshKeyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set");
  const sshKey = Buffer.from(sshKeyB64, "base64").toString("utf-8");

  const ssh = new NodeSSH();
  console.log(`[ssh] connecting to ${TARGET_IP}…`);
  try {
    await ssh.connect({ host: TARGET_IP!, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });
  } catch {
    await ssh.connect({ host: TARGET_IP!, username: "root", privateKey: sshKey, readyTimeout: 15_000 });
  }

  // Encode + ship via base64 to avoid shell quoting hazards on the python triple-quoted strings.
  const b64 = Buffer.from(STRIP_THINKING_SCRIPT, "utf-8").toString("base64");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const cmd = `
set -eu

# 1. Backup current
if [ -f ${REMOTE_PATH} ]; then
  cp -p ${REMOTE_PATH} ${REMOTE_PATH}.bak-${ts}
  echo "[deploy] backed up to ${REMOTE_PATH}.bak-${ts}"
fi

# 2. Write new version to tmp + py_compile syntax check
TMP=$(mktemp /tmp/strip-thinking-XXXXXX.py)
echo '${b64}' | base64 -d > "$TMP"
python3 -m py_compile "$TMP"
echo "[deploy] syntax OK ($(wc -c < $TMP) bytes)"

# 3. Sentinel grep — fail loudly if expected text isn't there
grep -q 'def trim_failed_turns' "$TMP"
grep -q 'SESSION TRIMMED:' "$TMP"
grep -q 'def run_periodic_summary_hook' "$TMP"
grep -q 'PERIODIC_SUMMARY_V1' "$TMP"
grep -q 'PRE_ARCHIVE_SUMMARY_V1' "$TMP"
echo "[deploy] sentinels present (all 5)"

# 4. Atomic install
chmod +x "$TMP"
mv "$TMP" ${REMOTE_PATH}
echo "[deploy] installed to ${REMOTE_PATH}"

# 5. Show diff summary vs backup
if [ -f ${REMOTE_PATH}.bak-${ts} ]; then
  OLD_LINES=$(wc -l < ${REMOTE_PATH}.bak-${ts})
  NEW_LINES=$(wc -l < ${REMOTE_PATH})
  echo "[deploy] line count: $OLD_LINES → $NEW_LINES"
  diff -q ${REMOTE_PATH}.bak-${ts} ${REMOTE_PATH} > /dev/null && echo "[deploy] WARNING: no actual changes" || echo "[deploy] script content changed (as expected)"
fi
`;

  const r = await ssh.execCommand(cmd);
  if (r.stdout) console.log(r.stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (r.stderr) {
    const e = r.stderr.split("\n").filter(Boolean);
    if (e.length) console.error(e.map((l) => "  ERR: " + l).join("\n"));
  }
  if (r.code !== 0) {
    ssh.dispose();
    throw new Error(`Deploy script exited ${r.code}`);
  }

  // 6. Force a manual cron run on the new script as a smoke test (just runs once;
  // the per-minute cron will still tick normally afterwards). We capture stdout
  // to confirm there are no Python errors.
  console.log("\n[smoke] running strip-thinking.py once manually…");
  const smoke = await ssh.execCommand(
    `source $HOME/.nvm/nvm.sh 2>/dev/null; python3 ${REMOTE_PATH} 2>&1 | tail -20`,
  );
  if (smoke.stdout) console.log(smoke.stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (smoke.stderr) console.log(smoke.stderr.split("\n").map((l) => "  " + l).join("\n"));
  console.log(`[smoke] exit=${smoke.code}`);

  ssh.dispose();
  console.log(`\n${"=".repeat(60)}\nHotfix deployed to ${TARGET_IP}.\n${"=".repeat(60)}`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
