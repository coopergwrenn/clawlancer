/**
 * Out-of-band deploy of the agent-to-agent XMTP intro flow to the 5
 * Consensus 2026 partner VMs (4 edge_city + 1 consensus_2026 = vm-780).
 *
 * Why out-of-band:
 *   Cooper's call: ship to partner VMs ONLY for the Consensus launch.
 *   Don't bump the manifest until post-conference (otherwise a manifest
 *   bump triggers reconciler runs across the whole 200+ VM fleet, which
 *   we don't want until this has soaked on the partner cohort).
 *
 * Deploys (per VM):
 *   1. ~/.openclaw/scripts/consensus_agent_outreach.py   (NEW)
 *   2. ~/.openclaw/scripts/consensus_match_pipeline.py   (UPDATED — outreach hook)
 *   3. ~/scripts/xmtp-agent.mjs                          (UPDATED — listener + intro handler)
 *   4. systemctl --user restart instaclaw-xmtp           (load new mjs)
 *
 * Per CLAUDE.md Rule 23: sentinel-grep each file post-write before
 * declaring success. If a sentinel is missing, push to errors and skip
 * the VM. Sentinels chosen to be unique to the post-fix code:
 *   xmtp-agent.mjs   → "[INSTACLAW_AGENT_INTRO_V1]" + "startLocalSendServer"
 *   pipeline         → "maybe_send_agent_outreach" + "OUTREACH_SCRIPT"
 *   outreach script  → "build_envelope" + "INSTACLAW_AGENT_INTRO_V1"
 *
 * Per CLAUDE.md Rule 18: load both .env.local and .env.ssh-key so
 * SSH_PRIVATE_KEY_B64 is available.
 *
 * Per CLAUDE.md Rule 23 (race fix): tmp paths salted with vm.id.
 *
 * Idempotent — running again with already-deployed VMs is a no-op (the
 * SFTP overwrite is content-equivalent and the systemctl restart is
 * cheap). Safe to re-run after partial failures.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
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

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PROJECT_ROOT = "/Users/cooperwrenn/wild-west-bots/instaclaw";
const TARGET_PARTNERS = ["edge_city", "consensus_2026"];

// File map: { localPath, remotePath, sentinels }
// Sentinels are exact substrings that MUST be present in the post-write
// remote file (Rule 23). Both must be present or the deploy fails.
const FILES = [
  {
    localPath: `${PROJECT_ROOT}/skills/xmtp-agent/scripts/xmtp-agent.mjs`,
    remotePath: "/home/openclaw/scripts/xmtp-agent.mjs",
    // Sentinels: marker constant, listener bootstrap, dynamic-token
    // resolver (from the rotation-drift fix), pending-intros recovery
    // (so chat_id-null receivers don't drop intros), and the XMTP-user
    // channel fallback (key for the partner-VM cohort whose users live
    // on World Chat, not Telegram).
    sentinels: [
      "[INSTACLAW_AGENT_INTRO_V1]",
      "startLocalSendServer",
      "getGatewayToken",
      "appendPendingIntro",
      "xmtp_user",
    ],
  },
  {
    localPath: `${PROJECT_ROOT}/scripts/consensus_match_pipeline.py`,
    remotePath: "/home/openclaw/.openclaw/scripts/consensus_match_pipeline.py",
    sentinels: ["maybe_send_agent_outreach", "OUTREACH_SCRIPT"],
  },
  {
    localPath: `${PROJECT_ROOT}/scripts/consensus_agent_outreach.py`,
    remotePath: "/home/openclaw/.openclaw/scripts/consensus_agent_outreach.py",
    sentinels: ["build_envelope", "INSTACLAW_AGENT_INTRO_V1"],
  },
];

interface VM {
  id: string;
  name: string;
  ip_address: string;
  ssh_user: string | null;
  partner: string;
}

interface FileResult {
  remote: string;
  status: "deployed" | "sentinel_missing" | "error";
  detail?: string;
}

interface VMResult {
  name: string;
  partner: string;
  files: FileResult[];
  service_restart: "ok" | "failed" | "skipped";
  port_listen: "ok" | "failed" | "skipped";
  detail?: string;
}

async function deployToVM(vm: VM): Promise<VMResult> {
  const result: VMResult = {
    name: vm.name,
    partner: vm.partner,
    files: [],
    service_restart: "skipped",
    port_listen: "skipped",
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 12000,
    });

    for (const file of FILES) {
      const localContent = readFileSync(file.localPath, "utf-8");

      // Pre-write sentinel check on local content. If we built a stale
      // module, halt before touching any VM (Rule 23).
      const missingLocal = file.sentinels.filter((s) => !localContent.includes(s));
      if (missingLocal.length > 0) {
        result.files.push({
          remote: file.remotePath,
          status: "sentinel_missing",
          detail: `local missing: ${missingLocal.join(", ")}`,
        });
        return result;
      }

      const tmp = `/tmp/xmtp-deploy-${vm.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.remotePath.split("/").pop()}`;
      const put = await ssh.putFile(file.localPath, tmp);
      if (put === false) {
        result.files.push({ remote: file.remotePath, status: "error", detail: "putFile failed" });
        continue;
      }

      // Verify sentinel via grep on the just-uploaded tmp file. If
      // either sentinel is missing, abort and clean up — never overwrite
      // the canonical path with stale content.
      let sentinelOk = true;
      for (const s of file.sentinels) {
        // grep -F: literal string (not regex). Use base64 to avoid
        // shell-escaping headaches with brackets / quotes in markers.
        const enc = Buffer.from(s, "utf-8").toString("base64");
        const check = await ssh.execCommand(
          `pattern=$(echo '${enc}' | base64 -d) && grep -Fq "$pattern" "${tmp}" && echo OK || echo MISS`,
        );
        if (!check.stdout.includes("OK")) {
          sentinelOk = false;
          await ssh.execCommand(`rm -f "${tmp}"`);
          result.files.push({
            remote: file.remotePath,
            status: "sentinel_missing",
            detail: `remote tmp missing sentinel: ${s.slice(0, 30)}`,
          });
          break;
        }
      }
      if (!sentinelOk) continue;

      // Atomic move to canonical path. Backup first (Rule 22) so we can
      // revert on a regression report.
      const backupCmd = `if [ -f "${file.remotePath}" ]; then cp "${file.remotePath}" "${file.remotePath}.bak.$(date +%s)" 2>/dev/null || true; fi`;
      await ssh.execCommand(backupCmd);
      const moveResult = await ssh.execCommand(
        `chmod 0644 "${tmp}" && mv -f "${tmp}" "${file.remotePath}"`,
      );
      if (moveResult.code !== 0) {
        result.files.push({
          remote: file.remotePath,
          status: "error",
          detail: `mv failed: ${moveResult.stderr.slice(0, 100)}`,
        });
        continue;
      }
      // For .py files, ensure executable bit.
      if (file.remotePath.endsWith(".py")) {
        await ssh.execCommand(`chmod +x "${file.remotePath}"`);
      }
      result.files.push({ remote: file.remotePath, status: "deployed" });
    }

    // If any file failed, skip the service restart — running stale
    // pipeline against new mjs (or vice versa) is worse than running
    // entirely-old code.
    const anyFailure = result.files.some((f) => f.status !== "deployed");
    if (anyFailure) {
      result.service_restart = "skipped";
      return result;
    }

    // Restart instaclaw-xmtp service. systemd --user requires
    // XDG_RUNTIME_DIR for SSH sessions (per the standard DBUS workaround).
    const restart = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart instaclaw-xmtp 2>&1',
    );
    if (restart.code !== 0) {
      result.service_restart = "failed";
      result.detail = `restart stderr: ${restart.stderr.slice(0, 200)}`;
      return result;
    }
    result.service_restart = "ok";

    // Wait up to 12s for service active + local send port up.
    let portUp = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const portCheck = await ssh.execCommand(
        "ss -tlnp 2>/dev/null | grep ':18790' || echo MISS",
      );
      if (!portCheck.stdout.includes("MISS")) {
        portUp = true;
        break;
      }
    }
    result.port_listen = portUp ? "ok" : "failed";

    if (!portUp) {
      // Pull a few lines of journal to surface why
      const journal = await ssh.execCommand(
        'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && journalctl --user -u instaclaw-xmtp --no-pager -n 12 2>/dev/null | tail -12',
      );
      result.detail = `port 18790 never opened. journal tail: ${journal.stdout.slice(0, 400)}`;
    }
    return result;
  } catch (e) {
    result.detail = e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ Deploy XMTP intro flow to partner VMs ══\n");

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user, partner")
    .in("partner", TARGET_PARTNERS)
    .eq("health_status", "healthy");

  if (error) throw new Error(`vm query: ${error.message}`);
  if (!vms || vms.length === 0) {
    console.log("No partner VMs found.");
    process.exit(0);
  }

  console.log(`Target VMs: ${vms.length}`);
  for (const v of vms) console.log(`  ${v.name} (${v.partner})`);
  console.log("");

  // Concurrency 2 — light load, but each VM does 3 SFTPs + grep + restart.
  // Higher concurrency risks systemctl racing on user-bus.
  const CONCURRENCY = 2;
  const results: VMResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < vms.length) {
      const i = cursor++;
      const vm = vms[i] as VM;
      const r = await deployToVM(vm);
      const ok = r.files.every((f) => f.status === "deployed") && r.service_restart === "ok" && r.port_listen === "ok";
      const tag = ok ? "✓" : "✗";
      console.log(`  ${tag} ${vm.name.padEnd(24)} files=${r.files.filter((f) => f.status === "deployed").length}/${FILES.length} restart=${r.service_restart} port=${r.port_listen}${r.detail ? ` (${r.detail.slice(0, 80)})` : ""}`);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const fullOk = results.filter((r) => r.files.every((f) => f.status === "deployed") && r.service_restart === "ok" && r.port_listen === "ok");
  const anyIssue = results.length - fullOk.length;

  console.log(`\n══ ${fullOk.length}/${results.length} fully deployed ══`);
  if (anyIssue > 0) {
    console.log("\nIssues:");
    for (const r of results.filter((rr) => !(rr.files.every((f) => f.status === "deployed") && rr.service_restart === "ok" && rr.port_listen === "ok"))) {
      console.log(`  ${r.name}:`);
      for (const f of r.files) {
        if (f.status !== "deployed") console.log(`    file ${f.remote}: ${f.status}${f.detail ? ` — ${f.detail}` : ""}`);
      }
      if (r.service_restart !== "ok") console.log(`    restart: ${r.service_restart}`);
      if (r.port_listen !== "ok") console.log(`    port 18790: ${r.port_listen}`);
      if (r.detail) console.log(`    detail: ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
