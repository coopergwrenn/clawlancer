/**
 * _apply-gbrain-path-a.ts — wire GBRAIN_ANTHROPIC_API_KEY into vm-050 and vm-576
 * and run the put/query verification gate.
 *
 * Why this exists
 * ---------------
 * vm-050 and vm-576 already have gbrain installed via the Phase 1 canary, but
 * with the broken MCP env block (GBRAIN_EMBEDDING_DIMENSIONS=1024 caused dim
 * mismatch; no ANTHROPIC_API_KEY caused silent expansion-disabled regression
 * documented in gbrain's gateway.ts:304).
 *
 * Path A choice (Anthropic for expansion + chat, per Gary's defaults) requires:
 *   1. GBRAIN_ANTHROPIC_API_KEY landed on the VM (in ~/.openclaw/.env)
 *   2. MCP config rewritten to include ANTHROPIC_API_KEY env, drop the bad dim
 *   3. End-to-end put/query verification — proves the whole stack works
 *
 * This script does all three, serially, with backup + rollback on failure.
 *
 * Run order: vm-050 first (proven baseline), vm-576 second (after vm-050 OK).
 *
 * Inputs (all sourced automatically):
 *   GBRAIN_ANTHROPIC_API_KEY — read from instaclaw/.env.local. NOT logged.
 *   SSH_PRIVATE_KEY_B64       — from .env.ssh-key.
 *
 * Output:
 *   Per-VM: streaming step logs from the remote bash script.
 *   Final:  summary table + verify result line.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const ANTHROPIC_KEY = process.env.GBRAIN_ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY || ANTHROPIC_KEY.length < 20) {
  console.error("FATAL: GBRAIN_ANTHROPIC_API_KEY missing in .env.local (need length >= 20)");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// SSH plumbing —————————————————————————————————————————————————————————

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });
  });
}

function uploadFile(c: Client, content: string | Buffer, remote: string, mode = 0o755): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((e, sftp) => {
      if (e) return reject(e);
      const w = sftp.createWriteStream(remote, { mode });
      w.on("close", () => resolve());
      w.on("error", reject);
      w.end(typeof content === "string" ? Buffer.from(content) : content);
    });
  });
}

function execWithStdin(c: Client, cmd: string, stdinData: string, timeoutMs: number):
    Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let resolved = false;
    const tt = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ stdout: stdout + "\n[TIMEOUT]", stderr, code: -1 }); }
    }, timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) {
        if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr: String(err), code: -2 }); }
        return;
      }
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      let exitCode = -1;
      stream.on("exit", (c: number) => { exitCode = c; });
      stream.on("close", () => {
        if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr, code: exitCode }); }
      });
      // Pipe stdin once the channel is open
      stream.stdin.write(stdinData);
      stream.stdin.end();
    });
  });
}

// Per-VM apply ————————————————————————————————————————————————————————————

interface ApplyResult {
  vm: string;
  ip: string;
  ok: boolean;
  resultLine?: string;
  stepsOk: string[];
  fatal?: string;
  raw: string;
  errorTail?: string;
}

async function applyOne(vmName: string, ipAddress: string): Promise<ApplyResult> {
  const res: ApplyResult = { vm: vmName, ip: ipAddress, ok: false, stepsOk: [], raw: "" };
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`${vmName}  (${ipAddress})`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  let c: Client | null = null;
  try {
    c = await ssh(ipAddress);
    console.log(`  [ssh]      connected`);

    // 1. Upload verify-gbrain-mcp.py (canonical source for the runtime gate)
    const verifyPy = readFileSync(
      "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/verify-gbrain-mcp.py",
      "utf-8",
    );
    await uploadFile(c, verifyPy, "/tmp/verify-gbrain-mcp.py", 0o755);
    console.log(`  [upload]   verify-gbrain-mcp.py  (${verifyPy.length} bytes)`);

    // 2. Upload apply-gbrain-path-a.sh (from /tmp local — the orchestrator wrote it)
    const applySh = readFileSync("/tmp/apply-gbrain-path-a.sh", "utf-8");
    await uploadFile(c, applySh, "/tmp/apply-gbrain-path-a.sh", 0o755);
    console.log(`  [upload]   apply-gbrain-path-a.sh  (${applySh.length} bytes)`);

    // 3. Execute with the Anthropic key piped via stdin (avoids ps-listing exposure)
    console.log(`  [exec]     bash /tmp/apply-gbrain-path-a.sh  (key via stdin)`);
    const t0 = Date.now();
    const { stdout, stderr, code } = await execWithStdin(
      c,
      "bash /tmp/apply-gbrain-path-a.sh",
      `${ANTHROPIC_KEY}\n`,
      300_000, // 5 min — embedding + query both make network calls
    );
    const elapsed = Math.round((Date.now() - t0) / 1000);
    res.raw = stdout;
    res.errorTail = stderr.slice(-500);

    // Stream the remote output verbatim for live visibility
    console.log(stdout.split("\n").map((l) => "  | " + l).join("\n"));
    if (stderr.trim().length > 0) {
      console.log(`  [stderr]   ${stderr.trim().slice(-400).replace(/\n/g, "\n             ")}`);
    }

    // Parse for STEP_*_OK lines + FATAL_*
    const stepRe = /^STEP_\d+_[A-Z_]+_OK/gm;
    const fatalRe = /^FATAL_[A-Z_]+/m;
    res.stepsOk = (stdout.match(stepRe) ?? []).map((s) => s.split(" ")[0]);
    const fatalMatch = stdout.match(fatalRe);
    if (fatalMatch) res.fatal = fatalMatch[0];

    // Parse the RESULT_OK / RESULT_FAIL line from verify-gbrain-mcp.py.
    // The bash apply script echoes it with leading whitespace ("  $RESULT_LINE"),
    // so anchoring to ^ doesn't work — use a free-floating match and trim.
    const resultMatch = stdout.match(/RESULT_(OK|FAIL)[^\n]*/);
    if (resultMatch) res.resultLine = resultMatch[0].trim();

    res.ok = code === 0 && stdout.includes("PATH_A_APPLY_COMPLETE") && !!res.resultLine?.startsWith("RESULT_OK");
    console.log(`  [verdict]  ${res.ok ? "✓ OK" : "✗ FAIL"}  elapsed=${elapsed}s  steps=[${res.stepsOk.length}]  result=${res.resultLine ?? "(none)"}`);
  } catch (e: any) {
    res.fatal = `SSH_OR_RUNTIME_ERROR: ${e?.message ?? e}`;
    console.log(`  [error]    ${res.fatal}`);
  } finally {
    if (c) c.end();
  }
  return res;
}

// Main —————————————————————————————————————————————————————————————————————

(async () => {
  const TARGETS = ["instaclaw-vm-050", "instaclaw-vm-576"];
  const { data: vms, error } = await sb.from("instaclaw_vms")
    .select("name,ip_address,health_status").in("name", TARGETS);
  if (error || !vms) {
    console.error("FATAL DB lookup failed:", error);
    process.exit(1);
  }
  const byName = new Map((vms as any[]).map((v) => [v.name, v]));

  console.log("Path A apply: GBRAIN_ANTHROPIC_API_KEY + dim-fix + verification gate");
  console.log(`Key length: ${ANTHROPIC_KEY!.length} chars (sk-ant-api03-... prefix expected)`);
  console.log(`Targets in order: ${TARGETS.join(", ")}\n`);

  const results: ApplyResult[] = [];
  for (const name of TARGETS) {
    const vm = byName.get(name);
    if (!vm) {
      console.log(`[skip] ${name} — not in DB`);
      continue;
    }
    const r = await applyOne(name, vm.ip_address);
    results.push(r);
    if (!r.ok && name === "instaclaw-vm-050") {
      console.log("\n⛔ vm-050 failed Path A — STOPPING (do not propagate to vm-576).");
      break;
    }
  }

  // Final summary
  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("PATH A APPLY SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════");
  for (const r of results) {
    const status = r.ok ? "✓ OK" : `✗ FAIL (${r.fatal ?? "no fatal"})`;
    console.log(`  ${r.vm.padEnd(22)} ${status}`);
    if (r.resultLine) console.log(`    ${r.resultLine}`);
  }
  const allOk = results.length === TARGETS.length && results.every((r) => r.ok);
  console.log("\n" + (allOk
    ? "✅ All target VMs at Path A. gbrain wired with Anthropic for expansion + chat."
    : "⚠️  One or more VMs did NOT reach Path A — inspect output above."));

  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
