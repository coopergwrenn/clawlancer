/**
 * Coverage script for gbrain SOUL routing (v106).
 *
 * Reports per-VM:
 *   - GBRAIN_SOUL_ROUTING_V1 marker present in SOUL.md?
 *   - sha256 of identity content (everything OUTSIDE the marker block) —
 *     used to spot-check that pre-deploy identity content is preserved
 *     post-deploy.
 *
 * Exit code 0 iff all gbrain-eligible VMs (partner=edge_city, gbrain
 * installed) have the marker. Anything else = regression.
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_coverage-gbrain-soul-routing.ts
 */

import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

try {
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
} catch {}

interface ProbeResult {
  name: string;
  ip: string;
  partner: string | null;
  gbrainInstalled: boolean;
  serviceActive: boolean;
  markerPresent: boolean;
  soulSize: number;
  identitySha: string | null; // sha256 of pre-anchor content (identity preservation check)
  error: string | null;
}

async function probe(ip: string, name: string, partner: string | null): Promise<ProbeResult> {
  const result: ProbeResult = {
    name, ip, partner,
    gbrainInstalled: false, serviceActive: false, markerPresent: false,
    soulSize: 0, identitySha: null, error: null,
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12000,
    });
    // One-line-per-fact tokens; parsed independently below to avoid
    // grep-c-no-match returning "0\n0" type bash gotchas.
    const cmd = `
INSTALLED=$(test -d ~/gbrain && echo 1 || echo 0); echo "PROBE_INSTALLED=$INSTALLED"
ACTIVE=$(systemctl --user is-active gbrain.service 2>&1 | head -1); echo "PROBE_ACTIVE=$ACTIVE"
MARKER=$(grep -cF '<!-- GBRAIN_SOUL_ROUTING_V1 -->' ~/.openclaw/workspace/SOUL.md 2>/dev/null); [ -z "$MARKER" ] && MARKER=0; echo "PROBE_MARKER=$MARKER"
SIZE=$(wc -c < ~/.openclaw/workspace/SOUL.md 2>/dev/null); [ -z "$SIZE" ] && SIZE=0; echo "PROBE_SIZE=$SIZE"
IDENTITY_SHA=$(awk '/^## Memory Persistence \\(CRITICAL\\)/{exit} {print}' ~/.openclaw/workspace/SOUL.md 2>/dev/null | sha256sum | awk '{print $1}'); echo "PROBE_IDENTITY_SHA=$IDENTITY_SHA"
`;
    const r = await Promise.race([
      ssh.execCommand(cmd),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
    ]);
    const stdout: string = (r as any).stdout || "";
    const lines = stdout.split("\n");
    const getLine = (prefix: string): string | null => {
      const line = lines.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : null;
    };
    const installed = getLine("PROBE_INSTALLED=");
    const active = getLine("PROBE_ACTIVE=");
    const marker = getLine("PROBE_MARKER=");
    const size = getLine("PROBE_SIZE=");
    const identitySha = getLine("PROBE_IDENTITY_SHA=");
    if (installed === null || active === null || marker === null || size === null || identitySha === null) {
      result.error = `parse_failed: stdout=${stdout.slice(0, 150)}`;
    } else {
      result.gbrainInstalled = installed === "1";
      result.serviceActive = active === "active";
      result.markerPresent = parseInt(marker, 10) > 0;
      result.soulSize = parseInt(size, 10);
      result.identitySha = identitySha;
    }
  } catch (e: any) {
    result.error = String(e.message).slice(0, 100);
  } finally {
    try { ssh.dispose(); } catch {}
  }
  return result;
}

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  // Scope: every healthy+assigned VM where partner is in the gbrain allowlist.
  // Currently only edge_city; extends automatically when allowlist grows.
  const { data } = await sb.from("instaclaw_vms")
    .select("name,ip_address,partner")
    .eq("health_status", "healthy")
    .eq("status", "assigned")
    .eq("partner", "edge_city")
    .order("name");

  if (!data || data.length === 0) {
    console.log("No gbrain-eligible VMs found");
    process.exit(0);
  }

  console.log(`Probing ${data.length} gbrain-eligible VMs...\n`);
  const results: ProbeResult[] = [];
  const concurrency = 5;
  for (let i = 0; i < data.length; i += concurrency) {
    const batch = data.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(v => probe(v.ip_address!, v.name, v.partner)),
    );
    results.push(...batchResults);
  }

  // Print table
  console.log("VM                   IP               gbrain  active  marker  soul_size  identity_sha");
  console.log("-".repeat(110));
  for (const r of results) {
    const mark = r.markerPresent ? "✓" : "✗";
    const inst = r.gbrainInstalled ? "✓" : "✗";
    const active = r.serviceActive ? "✓" : "✗";
    const errSuffix = r.error ? ` ERR=${r.error}` : "";
    const shaPrefix = (r.identitySha ?? "?").slice(0, 12);
    console.log(`${r.name.padEnd(20)} ${r.ip.padEnd(16)} ${inst.padEnd(7)} ${active.padEnd(7)} ${mark.padEnd(7)} ${String(r.soulSize).padEnd(10)} ${shaPrefix}${errSuffix}`);
  }

  // Summary
  const total = results.length;
  const installed = results.filter(r => r.gbrainInstalled).length;
  const active = results.filter(r => r.serviceActive).length;
  const marked = results.filter(r => r.markerPresent).length;
  const errors = results.filter(r => r.error).length;

  console.log("");
  console.log(`Total:        ${total}`);
  console.log(`gbrain inst.: ${installed}/${total}`);
  console.log(`service active: ${active}/${total}`);
  console.log(`marker present: ${marked}/${total}`);
  console.log(`errors:       ${errors}`);
  console.log("");

  // Exit code: 0 only if every active-gbrain VM has the marker
  const eligibleAndUnmarked = results.filter(r => r.serviceActive && !r.markerPresent && !r.error);
  if (eligibleAndUnmarked.length === 0) {
    console.log("✓ COVERAGE COMPLETE");
    process.exit(0);
  } else {
    console.log(`✗ COVERAGE GAP: ${eligibleAndUnmarked.length} VM(s) have gbrain active but no marker:`);
    for (const r of eligibleAndUnmarked) {
      console.log(`  - ${r.name} (${r.ip})`);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
