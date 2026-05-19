/**
 * Phase 1 per-VM gbrain installer.
 *
 * Usage:  npx tsx scripts/_install-gbrain-on-vm.ts <vm-name>
 *
 * Steps:
 *   1. DB pre-flight (status, health, cv >= 88)
 *   2. SSH 6-point pre-flight (TasksMax=120, gcc, prctl-subreaper artifacts)
 *   3. SFTP-upload install-gbrain.sh
 *   4. Execute with GBRAIN_PINNED_* env vars, timeout 600s
 *   5. Parse output (PHASE_X_OK / FATAL_* / INSTALL_COMPLETE / ALREADY_INSTALLED)
 *   6. Post-install: re-run 6-point + send chat completion to verify gbrain__ tools land in agent toolset
 *   7. Print structured report
 *
 * Read-only on failure (no changes attempted post-failure).
 * Designed for Phase 1 (3-VM canary) — used per-VM with 48h soaks between.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

// ── Pinned versions (single source of truth) ──
// HTTP sidecar architecture (Rule 35, 2026-05-16). MUST stay in sync with
// lib/vm-reconcile.ts:GBRAIN_PINNED_{COMMIT,VERSION}. The wrapper duplicates
// these here rather than importing from lib/ because scripts/ runs outside
// Next.js bundle context.
// 2026-05-19: bumped to v0.36.3.0 (1d5f69f) after vm-050 in-place upgrade canary.
// v0.36.x requires GBRAIN_EMBEDDING_DIMENSIONS=1536 env var alongside the existing
// GBRAIN_EMBEDDING_MODEL — without it, gateway.ts falls back to DEFAULT 1280-dim
// (ZE zembed-1) which mismatches our 1536-dim PGLite column. Phase E5 main unit
// + a 30-embedding-dimensions.conf drop-in (Phase J upgrade-mode) handle both
// fresh install and existing-VM upgrade paths.
// History: stdio v0.28.1 (2ea5b71) → HTTP v0.35.0.0 (baf1a47) → v0.36.3.0 (1d5f69f).
const GBRAIN_PINNED_COMMIT = "1d5f69f";
const GBRAIN_PINNED_VERSION = "0.36.3.0";

// ── Env loading ──
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

async function preflight6Point(c: SshClient): Promise<{ pass: boolean; details: string }> {
  const probe = `set +e
source ~/.nvm/nvm.sh 2>/dev/null
echo "tasks_max=$(systemctl --user show -p TasksMax --value openclaw-gateway 2>&1)"
echo "gcc=$(which gcc 2>&1)"
echo "prctl_pkg=$(npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep -oE 'prctl-subreaper@[0-9]+\\.[0-9]+\\.[0-9]+')"
echo "prctl_dropin=$(test -f $HOME/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf && echo PRESENT || echo MISSING)"
echo "gw_active=$(systemctl --user is-active openclaw-gateway 2>&1)"
echo "gw_health=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null)"`;
  const { stdout } = await exec(c, probe, 30_000);
  const m: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const mm = line.match(/^([a-z_]+)=(.*)$/);
    if (mm) m[mm[1]] = mm[2].trim();
  }
  const checks = {
    tasks_max_120: m.tasks_max === "120",
    gcc_present: m.gcc.startsWith("/"),
    prctl_pkg_present: !!m.prctl_pkg,
    prctl_dropin_present: m.prctl_dropin === "PRESENT",
    gw_active: m.gw_active === "active",
    gw_healthy: m.gw_health === "200",
  };
  const pass = Object.values(checks).every(Boolean);
  const details = Object.entries(checks).map(([k, v]) => `${v ? "✓" : "✗"} ${k}=${(m as Record<string, string>)[k.replace(/_(120|present)$/, "")] ?? "?"}`).join("  ");
  return { pass, details: `${details}  raw: ${JSON.stringify(m)}` };
}

async function postInstallToolListProbe(c: SshClient): Promise<{ pass: boolean; gbrainCount: number; preview: string }> {
  // Send a chat completion that asks the agent to enumerate gbrain__ tools.
  // Cold-start can take 30-180s on first call; budget 280s under the agent's
  // own 300s timeoutSeconds (per audit on vm-050).
  const cmd = `set +e
source ~/.nvm/nvm.sh
GATEWAY_TOKEN=$(grep "^GATEWAY_TOKEN=" $HOME/.openclaw/.env | head -1 | cut -d= -f2- | tr -d '"')
python3 > /tmp/probe-payload.json <<'PYEOF'
import json
print(json.dumps({
    "model": "openclaw",
    "max_tokens": 800,
    "messages": [{
        "role": "user",
        "content": "Admin diagnostic, no creative interpretation: enumerate every tool in your toolset whose name starts with the prefix g-b-r-a-i-n (concatenated). Output ONLY the names, comma separated. If none, say NONE."
    }]
}))
PYEOF
curl -s -m 280 -X POST -H "Authorization: Bearer $GATEWAY_TOKEN" -H "Content-Type: application/json" -d @/tmp/probe-payload.json http://localhost:18789/v1/chat/completions`;
  const { stdout } = await exec(c, cmd, 320_000);
  const matches = (stdout.match(/gbrain__[a-z_]+/g) ?? []);
  const unique = new Set(matches);
  return {
    pass: unique.size >= 30, // sanity: should be ~43
    gbrainCount: unique.size,
    preview: stdout.slice(0, 800),
  };
}

(async () => {
  const vmName = process.argv[2];
  if (!vmName) { console.error("usage: npx tsx scripts/_install-gbrain-on-vm.ts <vm-name>"); process.exit(2); }

  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`gbrain Phase 1 install on ${vmName}`);
  console.log(`pinned: commit=${GBRAIN_PINNED_COMMIT} version=${GBRAIN_PINNED_VERSION}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  // ── 1. DB pre-flight ──
  console.log("[1/6] DB pre-flight…");
  const { data: vm } = await sb.from("instaclaw_vms")
    .select("ip_address,health_status,health_fail_count,config_version,tier,partner,assigned_to")
    .eq("name", vmName).single();
  if (!vm) { console.error(`❌ VM ${vmName} not found in DB`); process.exit(3); }
  const v = vm as any;
  console.log(`  ip=${v.ip_address} tier=${v.tier} cv=${v.config_version} health=${v.health_status} fail_count=${v.health_fail_count} partner=${v.partner ?? "-"}`);
  if (v.health_status !== "healthy") { console.error(`❌ health_status=${v.health_status} (must be healthy)`); process.exit(3); }
  if (v.health_fail_count !== 0) { console.error(`❌ health_fail_count=${v.health_fail_count} (must be 0)`); process.exit(3); }
  if (v.config_version < 88) { console.error(`❌ config_version=${v.config_version} (must be >= 88)`); process.exit(3); }
  console.log("  ✓ DB pre-flight pass\n");

  // ── 2. SSH connect + 6-point pre-flight ──
  console.log("[2/6] SSH connect + 6-point pre-flight…");
  const c = await ssh(v.ip_address);
  const pre = await preflight6Point(c);
  if (!pre.pass) {
    console.error(`❌ 6-point pre-flight FAIL`);
    console.error(`  ${pre.details}`);
    c.end();
    process.exit(4);
  }
  console.log(`  ✓ ${pre.details}\n`);

  // ── 3. SFTP-upload install script + verification helper ──
  // Two files must be present on the VM before exec:
  //   • install-gbrain.sh — the installer body (uploaded to a TS-suffixed path
  //     so concurrent install attempts don't collide).
  //   • verify-gbrain-mcp.py — the canonical put_page/query verification
  //     harness used by Phase H. install-gbrain.sh expects this at the
  //     stable path /tmp/verify-gbrain-mcp.py (NOT TS-suffixed) so its
  //     candidate-path resolver finds it first. If we forget to upload it,
  //     Phase H fails fast with FATAL_VERIFY_PY_MISSING (which is a feature
  //     — refuses to silently skip the gate).
  console.log("[3/6] SFTP-upload install-gbrain.sh + verify-gbrain-mcp.py…");
  const scriptPath = path.resolve(__dirname, "install-gbrain.sh");
  const verifyPyPath = path.resolve(__dirname, "verify-gbrain-mcp.py");
  const scriptContent = readFileSync(scriptPath, "utf-8");
  const verifyPyContent = readFileSync(verifyPyPath, "utf-8");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 15) + "Z";
  const remotePath = `/tmp/install-gbrain.${ts}.sh`;
  const remoteVerifyPath = `/tmp/verify-gbrain-mcp.py`;
  await uploadFile(c, scriptContent, remotePath);
  await uploadFile(c, verifyPyContent, remoteVerifyPath);
  await exec(c, `chmod +x ${remotePath} ${remoteVerifyPath}`, 5_000);
  console.log(`  ✓ install-gbrain.sh    → ${remotePath} (${scriptContent.length} bytes)`);
  console.log(`  ✓ verify-gbrain-mcp.py → ${remoteVerifyPath} (${verifyPyContent.length} bytes)\n`);

  // ── 4. Execute with pinned env vars, capture output ──
  console.log("[4/6] Executing install script (timeout 600s)…");
  const cmd = `GBRAIN_PINNED_COMMIT=${GBRAIN_PINNED_COMMIT} GBRAIN_PINNED_VERSION=${GBRAIN_PINNED_VERSION} bash ${remotePath}`;
  const t0 = Date.now();
  const result = await exec(c, cmd, 600_000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  exit_code=${result.code}  elapsed=${elapsed}s\n`);

  // Parse phase markers
  // Phases extended A-H (Phase H = put_page/query verification gate, added 2026-05-12)
  const phasesOk = (result.stdout.match(/PHASE_[A-H]_OK/g) ?? []);
  const fatals = (result.stdout.match(/FATAL_[A-Z_]+/g) ?? []);
  const completed = result.stdout.includes("INSTALL_COMPLETE");
  const alreadyInstalled = result.stdout.includes("ALREADY_INSTALLED");
  console.log(`  phases passed: ${phasesOk.join(", ") || "(none)"}`);
  console.log(`  fatals:        ${fatals.join(", ") || "(none)"}`);
  console.log(`  status:        ${completed ? "INSTALL_COMPLETE" : alreadyInstalled ? "ALREADY_INSTALLED" : "INCOMPLETE"}`);

  if (!completed && !alreadyInstalled) {
    console.error(`\n❌ install did not complete. full output:\n${result.stdout}\n${result.stderr}`);
    c.end();
    process.exit(5);
  }
  console.log("");

  // ── 5. Post-install 6-point re-verify ──
  console.log("[5/6] Post-install 6-point re-verify…");
  const post = await preflight6Point(c);
  if (!post.pass) {
    console.error(`❌ POST 6-point FAIL — install may have regressed something`);
    console.error(`  ${post.details}`);
    c.end();
    process.exit(6);
  }
  console.log(`  ✓ ${post.details}\n`);

  // ── 6. Post-install chat completion: confirm 43 gbrain__ tools land ──
  console.log("[6/6] Post-install chat completion (cold-start can take 30-180s)…");
  const t1 = Date.now();
  const probe = await postInstallToolListProbe(c);
  const probeElapsed = Math.round((Date.now() - t1) / 1000);
  c.end();

  console.log(`  chat completion elapsed: ${probeElapsed}s`);
  console.log(`  unique gbrain__ tool names in agent response: ${probe.gbrainCount}`);
  if (!probe.pass) {
    console.error(`\n❌ tool list probe FAIL — agent saw fewer than 30 gbrain__ tools (expected ~43)`);
    console.error(`response preview:\n${probe.preview}`);
    process.exit(7);
  }
  console.log(`  ✓ agent toolset includes gbrain__ tools\n`);

  // ── Summary ──
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`✅ ${vmName} Phase 1 install COMPLETE`);
  console.log(`  install elapsed:    ${elapsed}s`);
  console.log(`  chat probe elapsed: ${probeElapsed}s`);
  console.log(`  gbrain tools live:  ${probe.gbrainCount}`);
  console.log(`  next:               48h soak per Rule 17 before VM #3`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
})().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(99);
});
