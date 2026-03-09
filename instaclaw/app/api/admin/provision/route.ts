import { NextRequest, NextResponse } from "next/server";
import { validateAdminKey } from "@/lib/security";
import { getSupabase } from "@/lib/supabase";
import {
  getNextVmNumber,
  formatVmName,
  getSnapshotUserData,
  HETZNER_DEFAULTS,
} from "@/lib/hetzner";
import {
  getProvider,
  getAvailableProvider,
  getAllProviders,
} from "@/lib/providers";
import type { CloudProvider } from "@/lib/providers";
import { checkDuplicateIP } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count, provider: requestedProvider } = await req.json();
  if (!count || typeof count !== "number" || count < 1 || count > 10) {
    return NextResponse.json(
      { error: "count must be a number between 1 and 10" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // Get existing VM names for numbering
  const { data: existingVms } = await supabase
    .from("instaclaw_vms")
    .select("name")
    .order("created_at", { ascending: false })
    .limit(200);

  const existingNames = (existingVms ?? []).map(
    (v: { name: string | null }) => v.name
  );
  const startNum = getNextVmNumber(existingNames);

  // Resolve provider
  let provider: CloudProvider;
  try {
    provider = requestedProvider
      ? getProvider(requestedProvider)
      : getAvailableProvider();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Provider unavailable" },
      { status: 400 }
    );
  }

  const isSnapshot =
    (provider.name === "hetzner" && !!process.env.HETZNER_SNAPSHOT_ID) ||
    (provider.name === "linode" && !!process.env.LINODE_SNAPSHOT_ID);

  const results: {
    id: string;
    name: string;
    ip: string;
    provider_server_id: string;
    provider: string;
    status: string;
  }[] = [];
  const errors: { name: string; error: string }[] = [];

  for (let i = 0; i < count; i++) {
    const vmName = formatVmName(startNum + i);

    try {
      const created = await provider.createServer({ name: vmName });

      // Wait for IP
      const ready = await provider.waitForServer(created.providerId);

      // Guard: check for duplicate IP before inserting (Linode recycles IPs)
      const { duplicates } = await checkDuplicateIP(ready.ip);
      if (duplicates.length > 0) {
        const desc = duplicates.map((d: { name: string | null; id: string; status: string }) => `${d.name ?? d.id} (${d.status})`).join(", ");
        errors.push({ name: vmName, error: `DUPLICATE_IP: ${ready.ip} already used by ${desc}` });
        logger.error("DUPLICATE_IP: skipping insert", { route: "admin/provision", vmName, ip: ready.ip, existingVms: desc });
        continue;
      }

      // Insert into Supabase
      const vmStatus = isSnapshot ? "ready" : "provisioning";
      const { data: vm, error } = await supabase
        .from("instaclaw_vms")
        .insert({
          ip_address: ready.ip,
          name: vmName,
          provider_server_id: ready.providerId,
          provider: provider.name,
          ssh_port: 22,
          ssh_user: "openclaw",
          status: vmStatus,
          region: ready.region,
          server_type: ready.serverType,
        })
        .select()
        .single();

      if (error) {
        errors.push({ name: vmName, error: error.message });
        continue;
      }

      results.push({
        id: vm.id,
        name: vmName,
        ip: ready.ip,
        provider_server_id: ready.providerId,
        provider: provider.name,
        status: vmStatus,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error("Failed to create VM", { error: msg, route: "admin/provision", vmName, provider: provider.name });

      // Auto-fallback: if primary provider fails with limit error, try other configured providers
      if (msg.includes("limit") && !requestedProvider) {
        const allProviders = getAllProviders();
        let fallbackSucceeded = false;

        for (const fallback of allProviders) {
          if (fallback.name === provider.name) continue;

          try {
            logger.info(`Falling back to ${fallback.name}`, { route: "admin/provision", vmName });

            const created = await fallback.createServer({ name: vmName });
            const ready = await fallback.waitForServer(created.providerId);

            // Guard: duplicate IP check on fallback path too
            const { duplicates: fbDupes } = await checkDuplicateIP(ready.ip);
            if (fbDupes.length > 0) {
              logger.error("DUPLICATE_IP on fallback", { route: "admin/provision", vmName, ip: ready.ip });
              continue;
            }

            const { data: vm, error } = await supabase
              .from("instaclaw_vms")
              .insert({
                ip_address: ready.ip,
                name: vmName,
                provider_server_id: ready.providerId,
                provider: fallback.name,
                ssh_port: 22,
                ssh_user: "openclaw",
                status: "provisioning",
                region: ready.region,
                server_type: ready.serverType,
              })
              .select()
              .single();

            if (!error && vm) {
              results.push({
                id: vm.id,
                name: vmName,
                ip: ready.ip,
                provider_server_id: ready.providerId,
                provider: fallback.name,
                status: "provisioning",
              });
              // Switch provider for remaining iterations
              provider = fallback;
              fallbackSucceeded = true;
              break;
            }
          } catch (fallbackErr) {
            logger.error(`${fallback.name} fallback also failed`, {
              error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
              route: "admin/provision",
              vmName,
            });
          }
        }

        if (fallbackSucceeded) continue;
      }

      errors.push({ name: vmName, error: msg });
    }
  }

  return NextResponse.json({
    provisioned: results,
    errors: errors.length > 0 ? errors : undefined,
    provider: provider.name,
    mode: isSnapshot ? "snapshot" : "fresh",
    note: isSnapshot
      ? "VMs created from snapshot with cloud-init personalization. Status: ready."
      : 'VMs are in "provisioning" status. Cloud-init is installing OpenClaw — the cloud-init-poll cron will flip to "ready" when done.',
  });
}
