/**
 * One-shot install of the Consensus 2026 skill on a single VM, no DB writes.
 *
 * Mirrors the ssh.ts install block (clone-if-missing + 30-min cron) and adds
 * the SOUL.md append-with-marker that ssh.ts only does on first configure.
 *
 * Use cases:
 *   1. Cooper's @edgecitybot canary — install on his existing edge_city VM
 *      (vm-780) without touching his partner tag.
 *   2. Bulk follow-up: run across all edge_city-tagged VMs to back-fill the
 *      consensus skill before the launch tweet.
 *
 * Idempotent: re-running is a no-op if everything is already in place.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { NodeSSH } from "node-ssh";

const REPO = "https://github.com/coopergwrenn/consensus-2026-skill.git";
const SKILL_DIR = "$HOME/.openclaw/skills/consensus-2026";
const SOUL_PATH = "$HOME/.openclaw/workspace/SOUL.md";
const SOUL_MARKER = "## Consensus 2026 Miami";
const SOUL_BLOCK = `

## Consensus 2026 Miami

You are an agent at Consensus 2026 (Miami Beach Convention Center, May 5–7). Your human is attending. The consensus-2026 skill at ~/.openclaw/skills/consensus-2026/SKILL.md teaches how to query 326 sessions, 219 side events, 451 speakers. Read it on first Consensus question. AI is the dominant topic. Surface free+food events proactively. On first message ask: days attending, top topics, who to meet — store in MEMORY.md.
`;

const args = process.argv.slice(2);
const TARGET_IP = args.find((a) => a.startsWith("--ip="))?.slice(5);
const RUN_QUERIES = !args.includes("--skip-queries");

if (!TARGET_IP) {
  console.error("Usage: _install-consensus-skill.ts --ip=<addr> [--skip-queries]");
  process.exit(1);
}

async function main(): Promise<void> {
  const sshKeyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!sshKeyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set — check .env.ssh-key");
  const sshKey = Buffer.from(sshKeyB64, "base64").toString("utf-8");

  const ssh = new NodeSSH();
  console.log(`[ssh] connecting to ${TARGET_IP} as openclaw…`);
  try {
    await ssh.connect({ host: TARGET_IP!, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });
  } catch (e) {
    console.log(`[ssh] openclaw failed: ${(e as Error).message} — trying root…`);
    await ssh.connect({ host: TARGET_IP!, username: "root", privateKey: sshKey, readyTimeout: 15_000 });
  }

  // ── Install ─────────────────────────────────────────────────────────────
  const soulB64 = Buffer.from(SOUL_BLOCK, "utf-8").toString("base64");
  // Note: every backslash-dollar in the heredoc is for JS string escape, then
  // for shell variable preservation. Tested against ssh.execCommand semantics.
  const installScript = `
set -eu

# 1. Clone (idempotent — refresh if exists)
if [ ! -d ${SKILL_DIR} ]; then
  echo "[install] cloning ${REPO}"
  git clone --depth 1 ${REPO} ${SKILL_DIR}
else
  echo "[install] skill dir exists — refreshing with git pull"
  ( cd ${SKILL_DIR} && git pull --ff-only -q 2>/dev/null ) || echo "[install] pull failed (non-fatal)"
fi

# 2. 30-min refresh cron (dedup-protected: strip any prior consensus lines first)
( crontab -l 2>/dev/null | grep -v "consensus-2026-skill" | grep -v "skills/consensus-2026" ; \\
  echo '*/30 * * * * cd \\$HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null' ) | crontab -
echo "[install] cron installed"

# 3. SOUL.md append-with-marker
if [ ! -f ${SOUL_PATH} ]; then
  echo "[install] WARN: ${SOUL_PATH} not found — skipping append"
else
  if grep -q "${SOUL_MARKER}" ${SOUL_PATH}; then
    echo "[install] SOUL marker already present — no append"
  else
    echo "${soulB64}" | base64 -d >> ${SOUL_PATH}
    echo "[install] SOUL section appended"
  fi
fi
echo "[install] done"
`;

  console.log("\n── Install ─────────────────────────────────────────");
  const installRes = await ssh.execCommand(installScript);
  if (installRes.stdout) console.log(installRes.stdout.split("\n").map((l) => "  " + l).join("\n"));
  if (installRes.stderr) console.error(installRes.stderr.split("\n").map((l) => " ERR: " + l).join("\n"));
  if (installRes.code !== 0) {
    ssh.dispose();
    throw new Error(`Install exited ${installRes.code}`);
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  console.log("\n── Verify ─────────────────────────────────────────");
  const checks = [
    { label: "skill dir present", cmd: `test -d ${SKILL_DIR} && echo OK || echo MISSING` },
    { label: "SKILL.md present", cmd: `test -f ${SKILL_DIR}/SKILL.md && wc -c < ${SKILL_DIR}/SKILL.md || echo MISSING` },
    { label: "sessions.json records", cmd: `jq '.records | length' ${SKILL_DIR}/data/sessions.json` },
    { label: "events.json records", cmd: `jq '.records | length' ${SKILL_DIR}/data/events.json` },
    { label: "speakers.json records", cmd: `jq '.records | length' ${SKILL_DIR}/data/speakers.json` },
    { label: "MANIFEST baked_at", cmd: `jq -r '.generated_at' ${SKILL_DIR}/data/MANIFEST.json` },
    { label: "git pull cron count", cmd: `crontab -l 2>/dev/null | grep -c "consensus-2026" || true` },
    { label: "SOUL.md Consensus marker", cmd: `grep -c "${SOUL_MARKER}" ${SOUL_PATH} 2>/dev/null || echo 0` },
    { label: "SOUL.md byte size", cmd: `wc -c < ${SOUL_PATH}` },
    { label: "SOUL.md Edge marker (preserved)", cmd: `grep -c "## Edge Esmeralda 2026" ${SOUL_PATH} 2>/dev/null || echo 0` },
  ];
  for (const c of checks) {
    const r = await ssh.execCommand(c.cmd);
    const out = (r.stdout || r.stderr || "").trim();
    console.log(`  ${c.label.padEnd(40)} ${out}`);
  }

  // ── Live demo queries ───────────────────────────────────────────────────
  if (RUN_QUERIES) {
    console.log("\n── Demo queries (jq on the actually-installed JSON) ─────────────");
    const queries = [
      {
        label: "Q1 free+food Tue (top 5)",
        cmd: `jq -c '.records | map(select(.date == "2026-05-05" and .is_free and .has_food)) | sort_by(.start_time) | .[:5] | .[] | { time: .start_time, organizer, name }' ${SKILL_DIR}/data/events.json`,
      },
      {
        label: "Q2 AI sessions count by day",
        cmd: `jq '.records | map(select((.tags | index("AI")) or (.tags | index("Agentic Commerce")) or (.title | test("\\\\bAI\\\\b|agent"; "i")))) | group_by(.date) | map({date: .[0].date, n: length})' ${SKILL_DIR}/data/sessions.json`,
      },
      {
        label: "Q3 Saylor",
        cmd: `jq -c '.records[] | select(.name | test("Saylor"; "i"))' ${SKILL_DIR}/data/speakers.json`,
      },
      {
        label: "Q4 Wed 14:00–15:30 Mainstage+Frontier",
        cmd: `jq -c '.records | map(select(.date == "2026-05-06" and .start_time >= "14:00" and .start_time < "15:30" and (.venue_slug == "mainstage" or .venue_slug == "frontier-stage"))) | sort_by(.start_iso) | map({venue: .venue_slug, time: .start_time, title})' ${SKILL_DIR}/data/sessions.json`,
      },
    ];
    for (const q of queries) {
      const r = await ssh.execCommand(q.cmd);
      const out = (r.stdout || r.stderr || "").trim();
      console.log(`\n  ${q.label}:`);
      const lines = out.split("\n");
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          console.log(JSON.stringify(obj, null, 2).split("\n").map((l) => "    " + l).join("\n"));
        } catch {
          console.log("    " + line);
        }
      }
    }
  }

  ssh.dispose();
  console.log(`\n${"=".repeat(60)}\nInstall complete on ${TARGET_IP}.\n${"=".repeat(60)}`);
}

main().catch((e) => {
  console.error(`\nFATAL: ${(e as Error).message}`);
  process.exit(1);
});
