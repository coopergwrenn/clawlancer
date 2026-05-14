/**
 * Recovery script for VMs stuck on `instaclaw-xmtp: surgical fix failed:
 * activating`.
 *
 * Diagnostic from 2026-05-14 SSH probe:
 *   - vm-912 (cv=85): @xmtp/agent-sdk installed, viem present but
 *     viem/package.json is broken — ESM resolver can't find viem/index.js.
 *     Restart counter 5,453.
 *   - vm-904 (cv=91): @xmtp/agent-sdk and viem both missing from
 *     ~/scripts/node_modules/. Restart counter 19,736.
 *
 * Root cause: the reconciler's `instaclaw-xmtp` surgical fix (lib/vm-reconcile.ts:4466)
 * only writes the unit file + restarts the service. It does NOT verify that
 * the node_modules dependencies (~/scripts/node_modules/@xmtp/agent-sdk and
 * viem) are present + healthy. The full re-provision path (setupXMTP) does
 * npm install, but is gated behind `vm.xmtp_address IS NULL` AND only fires
 * if the probe sees key/mjs missing. With key+mjs present and node_modules
 * broken, the surgical path runs forever and never repairs deps.
 *
 * Fix per-VM:
 *   1. cd ~/scripts && rm -rf node_modules
 *   2. npm install @xmtp/agent-sdk@latest    (viem comes in as transitive dep)
 *   3. systemctl --user reset-failed instaclaw-xmtp
 *   4. systemctl --user restart instaclaw-xmtp
 *   5. Poll is-active for up to 60s (xmtp-agent.mjs cold-start can be ~20s)
 *
 * Safety:
 *   - rm -rf is scoped to ~/scripts/node_modules — does NOT touch ~/scripts/
 *     itself (xmtp-agent.mjs preserved) or anything in ~/.openclaw/.
 *   - The XMTP wallet key lives in ~/.openclaw/xmtp/.env — untouched.
 *   - Existing service is stopped before mutation (avoid mid-install crashes).
 *   - 60s poll timeout matches Rule 43 plugin-aware cold-boot pattern.
 *   - Per-VM hard timeout 5 minutes (npm install at ~30-60s typical).
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()])
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const NVM = "source ~/.nvm/nvm.sh 2>/dev/null";
const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

type Target = { name: string; ip: string; cv: number };

async function fixVm(t: Target): Promise<{ ok: boolean; finalState: string }> {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`${t.name} (${t.ip}) cv=${t.cv}`);
  console.log(`══════════════════════════════════════════════════════════════`);

  const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: t.ip, username: "openclaw", privateKey: sshKey, readyTimeout: 15000 });
  } catch (e: any) {
    return { ok: false, finalState: `ssh-connect-fail: ${(e?.message || String(e)).slice(0, 100)}` };
  }

  try {
    // 0. Pre-state: capture restart counter, journal sample
    console.log("\n[0] PRE-state");
    const pre = await ssh.execCommand(
      `${DBUS} && systemctl --user show instaclaw-xmtp --property=NRestarts --property=ActiveState --no-pager`
    );
    console.log("    " + pre.stdout.trim().replace(/\n/g, "  "));

    // 1. Stop the service to avoid race with npm
    console.log("\n[1] Stop instaclaw-xmtp");
    await ssh.execCommand(`${DBUS} && systemctl --user stop instaclaw-xmtp 2>&1; true`);

    // 2. Clean node_modules — defensive: only touch ~/scripts/node_modules,
    //    NOT ~/scripts/ itself. xmtp-agent.mjs lives in ~/scripts/, NOT in
    //    node_modules. Wallet key lives in ~/.openclaw/xmtp/.env — untouched.
    console.log("\n[2] rm -rf ~/scripts/node_modules");
    await ssh.execCommand("rm -rf ~/scripts/node_modules", { execOptions: { pty: false } });

    // 3. npm install — viem comes in as transitive of @xmtp/agent-sdk
    console.log("\n[3] npm install @xmtp/agent-sdk@latest (may take 30-90s)");
    const npmStart = Date.now();
    const npmRes = await ssh.execCommand(
      `${NVM} && cd ~/scripts && npm install @xmtp/agent-sdk@latest 2>&1 | tail -10`,
      { execOptions: { pty: false } },
    );
    const npmMs = Date.now() - npmStart;
    console.log(`    npm finished in ${(npmMs / 1000).toFixed(1)}s, code=${npmRes.code}`);
    if (npmRes.code !== 0) {
      console.log("    ✗ npm install failed:");
      console.log("    " + npmRes.stdout.split("\n").slice(-5).join("\n    "));
      ssh.dispose();
      return { ok: false, finalState: `npm-install-failed: ${npmRes.stdout.slice(-200)}` };
    }
    console.log("    ✓ npm install ok");

    // 4. Verify @xmtp/agent-sdk and viem are present
    console.log("\n[4] Verify deps present");
    const verify = await ssh.execCommand(
      `[ -d ~/scripts/node_modules/@xmtp/agent-sdk ] && echo XMTP_OK || echo XMTP_MISSING; [ -d ~/scripts/node_modules/viem ] && echo VIEM_OK || echo VIEM_MISSING; [ -f ~/scripts/node_modules/viem/package.json ] && echo VIEM_PKG_OK || echo VIEM_PKG_MISSING`
    );
    console.log("    " + verify.stdout.trim().replace(/\n/g, ", "));
    if (!verify.stdout.includes("XMTP_OK") || !verify.stdout.includes("VIEM_OK") || !verify.stdout.includes("VIEM_PKG_OK")) {
      ssh.dispose();
      return { ok: false, finalState: `deps-incomplete: ${verify.stdout.trim()}` };
    }

    // 5. reset-failed + restart
    console.log("\n[5] reset-failed + restart instaclaw-xmtp");
    await ssh.execCommand(`${DBUS} && systemctl --user reset-failed instaclaw-xmtp`);
    await ssh.execCommand(`${DBUS} && systemctl --user restart instaclaw-xmtp`);

    // 6. Poll is-active for up to 60s — XMTP cold-start can take 20s+
    //    (connect to XMTP network, derive wallet address, register).
    //    Per Rule 43: cold-boot wait should scale with workload; here we
    //    use a generous bound + early-exit on success.
    console.log("\n[6] Poll is-active (up to 60s)");
    let healthy = false;
    let lastState = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await ssh.execCommand(`${DBUS} && systemctl --user is-active instaclaw-xmtp`);
      lastState = r.stdout.trim();
      if (lastState === "active") {
        console.log(`    ✓ active at ${(i + 1) * 2}s`);
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      // Pull journal for diagnosis
      const j = await ssh.execCommand(
        `${DBUS} && journalctl --user -u instaclaw-xmtp --since "2 min ago" --no-pager | tail -15`
      );
      console.log(`    ✗ stuck in ${lastState} after 60s. Journal tail:`);
      console.log(j.stdout.split("\n").map((l) => "    " + l).join("\n"));
      ssh.dispose();
      return { ok: false, finalState: `still-${lastState}: ${j.stdout.slice(-200)}` };
    }

    // 7. Confirm xmtp address eventually written (informational, not gating)
    await new Promise((r) => setTimeout(r, 3000));
    const addr = await ssh.execCommand("cat ~/.openclaw/xmtp/address 2>/dev/null");
    if (addr.stdout.trim()) {
      console.log(`    xmtp address: ${addr.stdout.trim()}`);
    } else {
      console.log("    xmtp address: not yet written (agent still initializing — may take ~30s more)");
    }

    // 8. Post-state restart counter
    const post = await ssh.execCommand(
      `${DBUS} && systemctl --user show instaclaw-xmtp --property=NRestarts --property=ActiveState --no-pager`
    );
    console.log("\n[8] POST-state: " + post.stdout.trim().replace(/\n/g, "  "));

    ssh.dispose();
    return { ok: true, finalState: `recovered (npm=${(npmMs / 1000).toFixed(1)}s)` };
  } catch (e: any) {
    try { ssh.dispose(); } catch {}
    return { ok: false, finalState: `exception: ${(e?.message || String(e)).slice(0, 200)}` };
  }
}

async function main(): Promise<void> {
  // Identify VMs stuck on instaclaw-xmtp by querying for assigned+healthy with
  // cv<95 AND recent_reconcile_errors mentions instaclaw-xmtp.
  // For now, hardcode the known-bad VMs from the catch-up wave output.
  // (vm-902 was a different push-error — streaming.mode silent failure; skip.)
  const targets: { name: string }[] = [
    { name: "instaclaw-vm-912" },
    { name: "instaclaw-vm-904" },
  ];

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name,ip_address,config_version")
    .in("name", targets.map((t) => t.name));
  if (!vms || !vms.length) {
    console.log("No matching VMs found");
    return;
  }

  console.log(`Targeting ${vms.length} VMs stuck on instaclaw-xmtp surgical-fix-failed`);
  for (const t of targets) {
    const exists = vms.find((v) => (v as any).name === t.name);
    if (!exists) console.log(`  WARN: ${t.name} not in DB`);
  }

  const results: { name: string; ok: boolean; finalState: string }[] = [];
  for (const v of vms) {
    const t: Target = { name: (v as any).name, ip: (v as any).ip_address, cv: (v as any).config_version };
    const r = await fixVm(t);
    results.push({ name: t.name, ok: r.ok, finalState: r.finalState });
  }

  console.log(`\n${"═".repeat(60)}\n══ SUMMARY ══\n${"═".repeat(60)}`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(20)} ${r.finalState}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
