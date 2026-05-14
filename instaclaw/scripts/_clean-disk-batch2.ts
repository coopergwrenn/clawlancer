/**
 * Disk cleanup batch 2 — 8 VMs surfaced by prometh-terminal audit 2026-05-14.
 *
 * P0 (paying customers, healthy state in DB, 100% disk — next config-set will ENOSPC):
 *  - vm-902 (172.104.24.91) — also re-filled since first cleanup ~30 min ago
 *  - vm-912 (173.255.227.194)
 *
 * Lower priority (not customer-facing right now but will bite on wake):
 *  - vm-748, vm-911 (unhealthy)
 *  - vm-908 (hibernating)
 *  - vm-881, vm-886, vm-629 (suspended)
 *
 * Strategy (same as _clean-disk-aggressive.ts):
 *  1) Delete session-backups >24h old
 *  2) If still ≥90%, keep only 1000 newest backups (purge older)
 *  3) If still ≥85%, also clean ~/.npm/_cacache, /tmp/openclaw, ~/.openclaw/logs >24h
 *  4) Also rm openclaw.json.*.tmp leftovers from ENOSPC retries (Rule 38)
 *  5) Reset-failed + restart gateway for P0 VMs only (lower priority can wait
 *     for next cron). Suspended/hibernating VMs we don't restart at all.
 *  6) Print disk usage breakdown BEFORE for diagnostic — helps see if the
 *     primary consumer is session-backups (Rule 45) or something else.
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
    if (m && !process.env[m[1].trim()])
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const NVM = "source ~/.nvm/nvm.sh 2>/dev/null";
const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Target = { name: string; priority: "P0" | "P1"; restart: boolean };

const TARGETS: Target[] = [
  { name: "instaclaw-vm-902", priority: "P0", restart: true },
  { name: "instaclaw-vm-912", priority: "P0", restart: true },
  { name: "instaclaw-vm-748", priority: "P1", restart: false },
  { name: "instaclaw-vm-911", priority: "P1", restart: false },
  { name: "instaclaw-vm-908", priority: "P1", restart: false },
  { name: "instaclaw-vm-881", priority: "P1", restart: false },
  { name: "instaclaw-vm-886", priority: "P1", restart: false },
  { name: "instaclaw-vm-629", priority: "P1", restart: false },
];

async function cleanup(t: Target): Promise<{ ok: boolean; finalDisk: string }> {
  const { data: vm } = await sb
    .from("instaclaw_vms")
    .select("ip_address,health_status,assigned_to,config_version")
    .eq("name", t.name)
    .single();
  if (!vm) return { ok: false, finalDisk: "no-vm-row" };

  const { data: user } = vm.assigned_to
    ? await sb.from("instaclaw_users").select("email").eq("id", vm.assigned_to).single()
    : { data: null };

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`${t.priority} ${t.name} (${vm.ip_address}) health=${vm.health_status} cv=${vm.config_version}`);
  if ((user as any)?.email) console.log(`  user: ${(user as any).email}`);
  console.log(`══════════════════════════════════════════════════════════════`);

  const c = new Client();
  try {
    await new Promise<void>((r, j) => {
      c.on("ready", () => r());
      c.on("error", j);
      c.connect({
        host: vm.ip_address,
        port: 22,
        username: "openclaw",
        privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
        readyTimeout: 15000,
      });
    });
  } catch (e: any) {
    console.error(`  ✗ SSH connect failed: ${e.message?.slice(0, 200)}`);
    return { ok: false, finalDisk: "ssh-fail" };
  }

  const exec = (cmd: string, timeoutMs = 60000): Promise<{ stdout: string; code: number }> =>
    new Promise((r) => {
      let o = "";
      const tm = setTimeout(() => r({ stdout: o + "\n[TIMEOUT]", code: -1 }), timeoutMs);
      c.exec(cmd, (e, s) => {
        if (e) {
          clearTimeout(tm);
          return r({ stdout: "err", code: -1 });
        }
        s.on("data", (d: Buffer) => (o += d.toString()));
        s.stderr.on("data", (d: Buffer) => (o += d.toString()));
        s.on("close", (code: number) => {
          clearTimeout(tm);
          r({ stdout: o, code });
        });
      });
    });

  // BEFORE diagnostic — see what's actually consuming the disk
  console.log("\n[1] BEFORE:");
  console.log("    " + (await exec(`df -h / | tail -1`)).stdout.trim());
  const before = (await exec(`df / | tail -1 | awk '{print $5}' | tr -d '%'`)).stdout.trim();
  console.log("    biggest dirs in ~/.openclaw:");
  console.log(
    (await exec(`du -sh ~/.openclaw/* 2>/dev/null | sort -hr | head -8`)).stdout
      .split("\n")
      .map((l) => "      " + l)
      .join("\n"),
  );
  console.log(
    "    session-backups count: " +
      (await exec(`ls ~/.openclaw/session-backups/ 2>/dev/null | wc -l`)).stdout.trim(),
  );
  console.log(
    "    tmp leftovers: " +
      (await exec(`find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" 2>/dev/null | wc -l`))
        .stdout.trim(),
  );

  // Strategy 1: delete session-backups >24h old (mtime +1440 min)
  console.log("\n[2] Strategy 1: rm session-backups >24h old");
  await exec(
    `find ~/.openclaw/session-backups/ -type f -mmin +1440 -name "*.jsonl" -delete 2>&1 | head -3; echo DONE`,
    600000,
  );
  let disk = (await exec(`df / | tail -1 | awk '{print $5}' | tr -d '%'`)).stdout.trim();
  console.log(`    after S1: ${disk}%`);

  // Strategy 2: still ≥90%, keep only 1000 newest
  if (parseInt(disk, 10) >= 90) {
    console.log("\n[3] Strategy 2: still ≥90% — keep only 1000 newest session-backups");
    await exec(
      `cd ~/.openclaw/session-backups && ls -t 2>/dev/null | tail -n +1001 | xargs rm -f 2>&1; echo DONE`,
      600000,
    );
    disk = (await exec(`df / | tail -1 | awk '{print $5}' | tr -d '%'`)).stdout.trim();
    console.log(`    after S2: ${disk}%`);
    console.log(
      "    session-backups remaining: " +
        (await exec(`ls ~/.openclaw/session-backups/ 2>/dev/null | wc -l`)).stdout.trim(),
    );
  }

  // Strategy 3: still ≥85%, clean other accumulating caches
  if (parseInt(disk, 10) >= 85) {
    console.log("\n[4] Strategy 3: still ≥85% — clean other caches");
    await exec(
      `rm -rf ~/.npm/_cacache 2>&1; rm -rf /tmp/openclaw 2>&1; find ~/.openclaw/logs -mmin +1440 -delete 2>&1; echo DONE`,
      120000,
    );
    disk = (await exec(`df / | tail -1 | awk '{print $5}' | tr -d '%'`)).stdout.trim();
    console.log(`    after S3: ${disk}%`);
  }

  // Always: rm openclaw.json.*.tmp leftovers (Rule 38)
  console.log("\n[5] Cleanup ENOSPC .tmp leftovers (Rule 38)");
  await exec(
    `find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" -delete 2>&1; echo DONE`,
    30000,
  );

  console.log("\n[6] AFTER:");
  console.log("    " + (await exec(`df -h / | tail -1`)).stdout.trim());
  console.log(
    "    session-backups: " +
      (await exec(`du -sh ~/.openclaw/session-backups 2>/dev/null`)).stdout.trim(),
  );

  // Rule 45 propagation spot-check: does the new strip-thinking.py have SESSION_BACKUP_COOLDOWN_SEC?
  const stCheck = await exec(
    `grep -c 'SESSION_BACKUP_COOLDOWN_SEC' ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo 0`,
    10000,
  );
  const stHits = parseInt(stCheck.stdout.trim(), 10);
  console.log(
    `\n[7] Rule 45 propagation: SESSION_BACKUP_COOLDOWN_SEC hits in strip-thinking.py: ${stHits}` +
      (stHits === 0 ? "  ✗ STILL OLD VERSION" : "  ✓ new version present"),
  );

  // Restart only P0 VMs (and only if explicitly flagged)
  if (t.restart) {
    console.log("\n[8] Reset-failed + restart gateway (P0 only)");
    await exec(`${NVM} && ${DBUS} && systemctl --user reset-failed openclaw-gateway 2>&1`);
    await exec(`${NVM} && ${DBUS} && systemctl --user restart openclaw-gateway 2>&1`);

    let healthy = false;
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const active = (
        await exec(`${NVM} && ${DBUS} && systemctl --user is-active openclaw-gateway`)
      ).stdout.trim();
      const health = (
        await exec(`curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health`)
      ).stdout.trim();
      if (active === "active" && health === "200") {
        console.log(`    ✓ healthy at attempt ${i + 1} (${(i + 1) * 5}s)`);
        healthy = true;
        break;
      }
      if (i === 35) console.log(`    ✗ not healthy after 180s: is-active=${active} /health=${health}`);
    }
    c.end();
    const finalDisk = (await exec(`df / | tail -1 | awk '{print $5}' | tr -d '%'`)).stdout.trim();
    console.log(`\n${healthy ? "✅" : "✗"} ${t.name}: ${healthy ? "RECOVERED" : "STILL BROKEN"} disk=${finalDisk}%`);
    return { ok: healthy, finalDisk };
  }

  c.end();
  console.log(`\n✅ ${t.name}: cleanup complete (no restart — ${vm.health_status} state)`);
  return { ok: true, finalDisk: disk };
}

(async () => {
  const results: { target: Target; ok: boolean; finalDisk: string }[] = [];
  for (const t of TARGETS) {
    try {
      const r = await cleanup(t);
      results.push({ target: t, ok: r.ok, finalDisk: r.finalDisk });
    } catch (e: any) {
      console.error(`✗ ${t.name}: ${e.message?.slice(0, 200)}`);
      results.push({ target: t, ok: false, finalDisk: "exception" });
    }
  }
  console.log("\n\n══ Summary ══");
  for (const r of results) {
    console.log(
      `  ${r.ok ? "✓" : "✗"} ${r.target.priority} ${r.target.name}  disk=${r.finalDisk}%`,
    );
  }
})();
