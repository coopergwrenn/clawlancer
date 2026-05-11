/**
 * EMERGENCY: free disk on VMs whose session-backups dir exploded.
 *
 * Companion to 567f653b (idempotency fix in strip-thinking.py). The fix
 * stops new runaway creation, but existing backlog on the worst-affected
 * VMs is keeping their disks at 90-100% usage. vm-512 and vm-905 are at
 * 100% with 0GB free — gateway cannot start there until disk is freed.
 *
 * Strategy: keep the most recent 100 backup files per VM (forensic value
 * for recent sessions), delete the rest. This is roughly equivalent to
 * the natural 7-day retention purge running aggressively.
 *
 * Targets: any VM whose session-backups dir has > 5000 files OR whose
 * disk usage is > 85%.
 *
 * Usage:
 *   npx tsx scripts/_emergency-purge-session-backups.ts        # dry-run
 *   npx tsx scripts/_emergency-purge-session-backups.ts --apply
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
const KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const APPLY = process.argv.includes("--apply");
const KEEP_RECENT = 100; // forensic value for the most recent 100 sessions

// Pre-identified targets from 2026-05-11 fleet probe (highest count + disk pressure first)
const TARGETS = [
  "instaclaw-vm-512",
  "instaclaw-vm-905",
  "instaclaw-vm-043",
  "instaclaw-vm-848",
  "instaclaw-vm-725",
  "instaclaw-vm-050",
  "instaclaw-vm-742",
  "instaclaw-vm-907",
  "instaclaw-vm-724",
  "instaclaw-vm-884",
  "instaclaw-vm-773",
  "instaclaw-vm-657",
  "instaclaw-vm-linode-08",
  "instaclaw-vm-858",
  "instaclaw-vm-469",
  "instaclaw-vm-890",
];

function exec(host: string, cmd: string, t = 60_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch { /* noop */ } resolve("[T]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => { o += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { o += d.toString(); });
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("cerr: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8_000 });
  });
}

const PURGE_SCRIPT = (apply: boolean) => `set +e
DIR=$HOME/.openclaw/session-backups
BEFORE_COUNT=$(find "$DIR" -type f 2>/dev/null | wc -l)
BEFORE_SIZE=$(du -sm "$DIR" 2>/dev/null | awk '{print $1}')
BEFORE_DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
BEFORE_AVAIL=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
echo "BEFORE|count=$BEFORE_COUNT|size_mb=$BEFORE_SIZE|disk_pct=$BEFORE_DISK|avail_gb=$BEFORE_AVAIL"

# Compute TO_DELETE = max(0, BEFORE_COUNT - KEEP_RECENT). Avoids using
# ls/glob which hits ARG_MAX on dirs with 30K+ files.
if [ "$BEFORE_COUNT" -gt ${KEEP_RECENT} ]; then
  TO_DELETE=$((BEFORE_COUNT - ${KEEP_RECENT}))
else
  TO_DELETE=0
fi
echo "TO_DELETE=$TO_DELETE"

${apply ? `
# APPLY: keep newest ${KEEP_RECENT} files (sorted by mtime desc), delete rest.
# find -printf '%T@ %p\\n' emits mtime + path per file, sort desc, tail skips
# the keep-most-recent N, xargs deletes. Handles arbitrary file counts —
# never expands to a single shell argument.
if [ "$BEFORE_COUNT" -gt ${KEEP_RECENT} ]; then
  find "$DIR" -maxdepth 1 -type f -printf '%T@ %p\\n' 2>/dev/null \\
    | sort -rn \\
    | tail -n +$((${KEEP_RECENT} + 1)) \\
    | cut -d' ' -f2- \\
    | xargs -r rm -f
  DELETED=$?
else
  DELETED=0
fi
AFTER_COUNT=$(find "$DIR" -type f 2>/dev/null | wc -l)
AFTER_SIZE=$(du -sm "$DIR" 2>/dev/null | awk '{print $1}')
AFTER_DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
AFTER_AVAIL=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
echo "AFTER|count=$AFTER_COUNT|size_mb=$AFTER_SIZE|disk_pct=$AFTER_DISK|avail_gb=$AFTER_AVAIL|delete_exit=$DELETED"
` : ""}
`;

async function main() {
  console.log(`\n=== EMERGENCY purge session-backups ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`Strategy: keep most recent ${KEEP_RECENT} backup files per VM, delete the rest.\n`);

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address")
    .in("name", TARGETS);
  if (!vms) { console.error("DB query failed"); process.exit(1); }
  console.log(`Resolved ${vms.length}/${TARGETS.length} VMs\n`);

  for (const vm of vms) {
    const out = await exec(vm.ip_address, PURGE_SCRIPT(APPLY), 90_000);
    if (out.startsWith("[T]") || out.startsWith("err:") || out.startsWith("cerr:")) {
      console.log(`  ${vm.name.padEnd(22)} UNREACHABLE: ${out.slice(0, 80)}`);
      continue;
    }
    const lines = out.split("\n");
    const before = (lines.find((l) => l.startsWith("BEFORE|")) ?? "").replace(/^BEFORE\|/, "");
    const after = (lines.find((l) => l.startsWith("AFTER|")) ?? "").replace(/^AFTER\|/, "");
    const toDelete = (lines.find((l) => l.startsWith("TO_DELETE=")) ?? "").replace("TO_DELETE=", "");
    console.log(`  ${vm.name.padEnd(22)}`);
    console.log(`    BEFORE  ${before}`);
    console.log(`    would delete: ${toDelete}`);
    if (APPLY && after) console.log(`    AFTER   ${after}`);
  }

  if (!APPLY) console.log(`\nDRY-RUN — no changes made. Re-run with --apply to commit.`);
}

main().then(() => process.exit(0));
