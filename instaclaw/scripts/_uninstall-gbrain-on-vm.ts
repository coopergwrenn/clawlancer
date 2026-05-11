/**
 * Per-VM gbrain remover.
 *
 * Usage:
 *   npx tsx scripts/_uninstall-gbrain-on-vm.ts <vm-name>
 *   npx tsx scripts/_uninstall-gbrain-on-vm.ts <vm-name> --purge
 *
 * Mirror of _install-gbrain-on-vm.ts. Per Phase 1 design doc §10, this
 * is the Phase 1 rollback companion.
 *
 * Steps:
 *   1. DB lookup (status, ip)
 *   2. SSH connect
 *   3. SFTP-upload uninstall-gbrain.sh
 *   4. Execute with optional --purge flag
 *   5. Parse output (PHASE_X_OK / FATAL_* / UNINSTALL_COMPLETE / ALREADY_REMOVED)
 *   6. Verify post-uninstall via openclaw mcp show
 *
 * Safety:
 *   - Default mode (no --purge) only removes the MCP entry (hot reload).
 *     gbrain repo, PGLite database, brain repo all stay on disk.
 *   - --purge additionally deletes ~/gbrain ~/.gbrain ~/brain. PGLite
 *     data is tar.gz-backed-up to ~/.openclaw/session-backups before
 *     deletion (Rule 22).
 *   - Auto-rolls back openclaw.json from /tmp backup if gateway becomes
 *     unhealthy post hot-reload.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

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
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

type SshClient = Client;

function ssh(host: string): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => reject(e));
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });
  });
}

function exec(c: SshClient, cmd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", code = -1;
    const tt = setTimeout(() => resolve({ code: -1, stdout: stdout + "\n[TIMEOUT]", stderr }), timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(tt); return resolve({ code: -2, stdout, stderr: String(err) }); }
      stream.on("data", (d: Buffer) => stdout += d.toString());
      stream.stderr.on("data", (d: Buffer) => stderr += d.toString());
      stream.on("exit", (c: number) => { code = c; });
      stream.on("close", () => { clearTimeout(tt); resolve({ code, stdout, stderr }); });
    });
  });
}

function uploadFile(c: SshClient, content: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const w = sftp.createWriteStream(remotePath);
      w.on("close", () => resolve());
      w.on("error", reject);
      w.end(content);
    });
  });
}

(async () => {
  const args = process.argv.slice(2);
  const vmName = args.find((a) => !a.startsWith("--"));
  const purge = args.includes("--purge");
  if (!vmName) {
    console.error("usage: npx tsx scripts/_uninstall-gbrain-on-vm.ts <vm-name> [--purge]");
    process.exit(2);
  }

  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`gbrain uninstall on ${vmName}${purge ? "  (PURGE — will delete data)" : "  (safe — MCP entry only)"}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  // 1. DB lookup
  console.log("[1/4] DB lookup…");
  const { data: vm } = await sb.from("instaclaw_vms")
    .select("ip_address,health_status,tier,partner,assigned_to")
    .eq("name", vmName).single();
  if (!vm) { console.error(`❌ VM ${vmName} not found in DB`); process.exit(3); }
  const v = vm as any;
  console.log(`  ip=${v.ip_address} tier=${v.tier} health=${v.health_status} partner=${v.partner ?? "-"}`);
  if (v.health_status !== "healthy") {
    console.log(`  ⚠️  health_status=${v.health_status} — proceeding but be aware`);
  }

  // 2. SSH connect
  console.log("\n[2/4] SSH connect…");
  const c = await ssh(v.ip_address);
  console.log(`  ✓ connected`);

  // 3. SFTP-upload + execute
  console.log("\n[3/4] SFTP-upload uninstall-gbrain.sh…");
  const scriptPath = path.resolve(__dirname, "uninstall-gbrain.sh");
  const scriptContent = readFileSync(scriptPath, "utf-8");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const remotePath = `/tmp/uninstall-gbrain.${ts}.sh`;
  await uploadFile(c, scriptContent, remotePath);
  await exec(c, `chmod +x ${remotePath}`, 5_000);
  console.log(`  ✓ uploaded to ${remotePath}`);

  console.log("\n[4/4] Executing uninstall script…");
  const cmd = `bash ${remotePath} ${purge ? "--purge" : ""}`;
  const t0 = Date.now();
  const result = await exec(c, cmd, 120_000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  exit_code=${result.code}  elapsed=${elapsed}s\n`);

  const phasesOk = (result.stdout.match(/PHASE_[A-D]_OK/g) ?? []);
  const fatals = (result.stdout.match(/FATAL_[A-Z_]+/g) ?? []);
  const completed = result.stdout.includes("UNINSTALL_COMPLETE");
  const alreadyRemoved = result.stdout.includes("ALREADY_REMOVED");
  console.log(`  phases passed: ${phasesOk.join(", ") || "(none)"}`);
  console.log(`  fatals:        ${fatals.join(", ") || "(none)"}`);
  console.log(`  status:        ${completed ? "UNINSTALL_COMPLETE" : alreadyRemoved ? "ALREADY_REMOVED" : "INCOMPLETE"}`);
  console.log("\n  ─ raw output ─");
  console.log(result.stdout.split("\n").map((l) => `  | ${l}`).join("\n"));

  c.end();

  if (!completed && !alreadyRemoved) {
    console.error(`\n❌ uninstall did not complete cleanly`);
    process.exit(5);
  }
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`✅ ${vmName} uninstall ${alreadyRemoved ? "skipped (already absent)" : "complete"}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
})().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(99);
});
