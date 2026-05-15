/**
 * Block /api/cron/reconcile-fleet for 2 hours by taking its cron lock.
 *
 * URGENT 2026-05-15: the live Vercel deployment still has the
 * consensus_match_pipeline.py cron entry in vm-manifest.ts (my local
 * comment-out hasn't been deployed yet). The reconciler runs every 3 min
 * and would re-install the cron on every VM, undoing the fleet script.
 *
 * Takes the lock for 2h so Cooper has time to (a) push the manifest
 * comment-out to main + deploy, or (b) decide otherwise. After 2h the
 * lock expires automatically — if the manifest hasn't been deployed by
 * then, the reconciler will resume and re-install the cron.
 *
 * Usage:
 *   npx tsx scripts/_block-reconciler-2h.ts        # acquire
 *   npx tsx scripts/_block-reconciler-2h.ts --release  # early release
 */
import { readFileSync } from "fs";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";

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

async function main() {
  if (process.argv.includes("--release")) {
    await releaseCronLock("reconcile-fleet");
    console.log("released reconcile-fleet lock");
    return;
  }
  const got = await tryAcquireCronLock(
    "reconcile-fleet",
    2 * 60 * 60, // 2h TTL
    "stop-timour-spam-2026-05-15",
  );
  console.log(`acquire reconcile-fleet lock: ${got ? "OK (held 2h)" : "FAILED (someone else holds it)"}`);
  if (!got) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
