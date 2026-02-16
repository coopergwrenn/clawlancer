/**
 * provision-batch.ts — Provision multiple Hetzner VMs from snapshot
 *
 * Usage:
 *   npx tsx scripts/provision-batch.ts 15
 *
 * Uses the same TypeScript provider code as the API endpoint.
 * Includes browser setup + config protection via snapshot cloud-init.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
const envPath = resolve(".", ".env.local");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function main() {
  // Now import provider code (needs env vars loaded first)
  const { getSnapshotUserData, resolveHetznerIds, HETZNER_DEFAULTS } =
    await import("../lib/providers/hetzner.js");

  const HETZNER_BASE = "https://api.hetzner.cloud/v1";
  const HETZNER_TOKEN = process.env.HETZNER_API_TOKEN!;
  const SNAPSHOT_ID = process.env.HETZNER_SNAPSHOT_ID!;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Parse count from CLI args
  const count = parseInt(process.argv[2] || "15", 10);
  if (count < 1 || count > 20) {
    console.error("Count must be between 1 and 20");
    process.exit(1);
  }

  // Get next VM number
  const { data: existingVms } = await supabase
    .from("instaclaw_vms")
    .select("name")
    .order("created_at", { ascending: false })
    .limit(200);

  const existingNames = (existingVms ?? []).map(
    (v: { name: string | null }) => v.name
  );
  let maxNum = 0;
  for (const name of existingNames) {
    const m = name?.match(/instaclaw-vm-(\d+)/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
  }
  const startNum = maxNum + 1;

  console.log(
    `\n=== Provisioning ${count} Hetzner VMs (snapshot ${SNAPSHOT_ID}) ===`
  );
  console.log(
    `Starting from instaclaw-vm-${String(startNum).padStart(2, "0")}`
  );
  console.log(
    `Location: ${HETZNER_DEFAULTS.location} | Type: ${HETZNER_DEFAULTS.serverType}\n`
  );

  // Resolve SSH key and firewall IDs
  console.log("Resolving Hetzner SSH key and firewall...");
  const { sshKeyId, firewallId } = await resolveHetznerIds();
  console.log(`  SSH Key ID: ${sshKeyId}`);
  console.log(`  Firewall ID: ${firewallId}\n`);

  // Generate user_data from TypeScript code (includes browser setup + config protection)
  const userData = getSnapshotUserData();
  if (!userData) {
    console.error("ERROR: Failed to generate snapshot user_data");
    process.exit(1);
  }
  console.log(`Cloud-init user_data: ${userData.length} bytes (base64)\n`);

  interface VMResult {
    name: string;
    ip: string;
    serverId: string;
    status: string;
  }

  const results: VMResult[] = [];
  const errors: { name: string; error: string }[] = [];

  async function hetznerFetch(path: string, options?: RequestInit) {
    const res = await fetch(`${HETZNER_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${HETZNER_TOKEN}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Hetzner ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  for (let i = 0; i < count; i++) {
    const vmNum = startNum + i;
    const vmName = `instaclaw-vm-${String(vmNum).padStart(2, "0")}`;

    console.log(`[${i + 1}/${count}] Creating ${vmName}...`);

    try {
      // Create server
      const createData = await hetznerFetch("/servers", {
        method: "POST",
        body: JSON.stringify({
          name: vmName,
          server_type: HETZNER_DEFAULTS.serverType,
          image: SNAPSHOT_ID,
          location: HETZNER_DEFAULTS.location,
          ssh_keys: [sshKeyId],
          firewalls: [{ firewall: firewallId }],
          user_data: userData,
        }),
      });

      const serverId = String(createData.server.id);
      console.log(`  Server ID: ${serverId} — waiting for IP...`);

      // Poll until running with IP (max 2 minutes)
      let ip = "";
      const pollStart = Date.now();
      while (Date.now() - pollStart < 120_000) {
        await new Promise((r) => setTimeout(r, 5000));
        const data = await hetznerFetch(`/servers/${serverId}`);
        if (
          data.server.status === "running" &&
          data.server.public_net?.ipv4?.ip &&
          data.server.public_net.ipv4.ip !== "0.0.0.0"
        ) {
          ip = data.server.public_net.ipv4.ip;
          break;
        }
        process.stdout.write(".");
      }
      console.log("");

      if (!ip) {
        errors.push({
          name: vmName,
          error: "No IP assigned within 2 minutes",
        });
        console.log(`  ERROR: No IP assigned`);
        continue;
      }

      console.log(`  IP: ${ip}`);

      // Insert into Supabase as ready (snapshot VMs are immediately usable)
      const { error: dbError } = await supabase.from("instaclaw_vms").insert({
        ip_address: ip,
        name: vmName,
        provider_server_id: serverId,
        provider: "hetzner",
        ssh_port: 22,
        ssh_user: "openclaw",
        status: "ready",
        region: HETZNER_DEFAULTS.region,
        server_type: HETZNER_DEFAULTS.serverType,
      });

      if (dbError) {
        errors.push({
          name: vmName,
          error: `DB insert failed: ${dbError.message}`,
        });
        console.log(`  DB ERROR: ${dbError.message}`);
        continue;
      }

      results.push({ name: vmName, ip, serverId, status: "ready" });
      console.log(`  Registered in DB: status=ready provider=hetzner`);
      console.log("");

      // Small delay between creations to avoid rate limiting
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name: vmName, error: msg });
      console.log(`  ERROR: ${msg}\n`);

      // If we hit a server limit, stop
      if (msg.includes("limit") || msg.includes("quota")) {
        console.log("\n!! Hit server limit — stopping provisioning");
        break;
      }

      // Brief pause before retrying next VM
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`=== PROVISIONING COMPLETE ===`);
  console.log(`  Created: ${results.length}/${count}`);
  console.log(`  Failed:  ${errors.length}`);
  console.log("=".repeat(60));

  if (results.length > 0) {
    console.log("\n=== NEW VMs ===");
    console.log(
      "| # | Name              | IP              | Server ID  | Status |"
    );
    console.log(
      "|---|-------------------|-----------------|------------|--------|"
    );
    results.forEach((vm, idx) => {
      console.log(
        `| ${String(idx + 1).padStart(2)} | ${vm.name.padEnd(17)} | ${vm.ip.padEnd(15)} | ${vm.serverId.padEnd(10)} | ${vm.status.padEnd(6)} |`
      );
    });
  }

  if (errors.length > 0) {
    console.log("\n=== ERRORS ===");
    errors.forEach((e) => console.log(`  ${e.name}: ${e.error}`));
  }

  // Show updated fleet count
  const { data: allVms } = await supabase
    .from("instaclaw_vms")
    .select("provider, status");

  const counts: Record<string, number> = {};
  allVms?.forEach((vm: { provider: string; status: string }) => {
    const key = `${vm.provider}/${vm.status}`;
    counts[key] = (counts[key] || 0) + 1;
  });

  console.log("\n=== FLEET STATUS ===");
  Object.entries(counts)
    .sort()
    .forEach(([key, c]) => console.log(`  ${key}: ${c}`));
  console.log(`  TOTAL: ${allVms?.length ?? 0}`);

  // Ready pool count
  const readyCount = Object.entries(counts)
    .filter(([k]) => k.endsWith("/ready"))
    .reduce((sum, [, c]) => sum + c, 0);
  console.log(`\n  Ready pool (available for users): ${readyCount}`);

  // Hetzner quota
  const hetznerTotal = Object.entries(counts)
    .filter(([k]) => k.startsWith("hetzner/"))
    .reduce((sum, [, c]) => sum + c, 0);
  console.log(
    `  Hetzner servers: ${hetznerTotal}/25 (${25 - hetznerTotal} remaining)`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
