import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name")
    .eq("status", "assigned")
    .not("assigned_to", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ backed_up: 0, message: "No VMs to back up" });
  }

  const s3Endpoint = process.env.HETZNER_S3_ENDPOINT;
  const s3Bucket = process.env.HETZNER_S3_BUCKET;

  if (!s3Endpoint || !s3Bucket) {
    return NextResponse.json({
      backed_up: 0,
      message: "Backup storage not configured (HETZNER_S3_ENDPOINT, HETZNER_S3_BUCKET)",
    });
  }

  let backed_up = 0;
  const errors: string[] = [];

  for (const vm of vms) {
    try {
      const { NodeSSH } = await import("node-ssh");
      const ssh = new NodeSSH();
      await ssh.connect({
        host: vm.ip_address,
        port: vm.ssh_port,
        username: vm.ssh_user,
        privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      });

      const timestamp = new Date().toISOString().split("T")[0];
      // Sanitize VM name/id — only allow safe characters for filenames
      const safeVmName = (vm.name ?? vm.id).replace(/[^A-Za-z0-9_.\-]/g, "_");
      const backupName = `${safeVmName}-${timestamp}.tar.gz`;
      const backupPath = `/tmp/${backupName}`;
      const s3Path = `s3://${s3Bucket}/backups/${backupName}`;

      // Validate S3 endpoint — only allow valid hostname characters
      if (!/^[A-Za-z0-9.\-:]+$/.test(s3Endpoint)) {
        errors.push(`${vm.name}: invalid S3 endpoint`);
        ssh.dispose();
        continue;
      }

      // Create tar of ~/.openclaw/
      const tarResult = await ssh.execCommand(
        `tar -czf '${backupPath}' -C $HOME .openclaw/ 2>/dev/null`
      );

      if (tarResult.code !== 0) {
        errors.push(`${vm.name}: tar failed`);
        ssh.dispose();
        continue;
      }

      // Get file size
      const sizeResult = await ssh.execCommand(`stat -c '%s' '${backupPath}' 2>/dev/null || echo 0`);
      const sizeBytes = parseInt(sizeResult.stdout.trim()) || 0;

      // Upload to S3-compatible storage (if s3cmd is available)
      const uploadResult = await ssh.execCommand(
        `s3cmd put '${backupPath}' '${s3Path}' --host='${s3Endpoint}' 2>/dev/null || ` +
        `aws s3 cp '${backupPath}' '${s3Path}' --endpoint-url='https://${s3Endpoint}' 2>/dev/null || true`
      );

      // Clean up local backup
      await ssh.execCommand(`rm -f '${backupPath}'`);
      ssh.dispose();

      // Record backup in DB
      await supabase.from("instaclaw_vm_backups").insert({
        vm_id: vm.id,
        backup_path: s3Path,
        size_bytes: sizeBytes,
      });

      // Clean up old backups (keep last 7) — delete S3 objects AND DB rows
      const { data: oldBackups } = await supabase
        .from("instaclaw_vm_backups")
        .select("id, backup_path")
        .eq("vm_id", vm.id)
        .order("created_at", { ascending: false })
        .range(7, 999);

      if (oldBackups?.length) {
        // Delete old S3 objects
        for (const old of oldBackups) {
          if (old.backup_path) {
            try {
              const delSsh = new NodeSSH();
              await delSsh.connect({
                host: vm.ip_address,
                port: vm.ssh_port,
                username: vm.ssh_user,
                privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
              });
              await delSsh.execCommand(
                `s3cmd del '${old.backup_path}' --host='${s3Endpoint}' 2>/dev/null || ` +
                `aws s3 rm '${old.backup_path}' --endpoint-url='https://${s3Endpoint}' 2>/dev/null || true`
              );
              delSsh.dispose();
            } catch {
              // Non-fatal: old object cleanup is best-effort
            }
          }
        }

        // Delete old DB rows
        await supabase
          .from("instaclaw_vm_backups")
          .delete()
          .in(
            "id",
            oldBackups.map((b) => b.id)
          );
      }

      if (uploadResult.code === 0 || sizeBytes > 0) {
        backed_up++;
      }
    } catch (err) {
      const errMsg = `${vm.name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(errMsg);
      logger.error("Backup failed for VM", { error: errMsg, route: "cron/backup", vmId: vm.id });
    }
  }

  // Alert admin on backup failures
  if (errors.length > 0) {
    try {
      await sendAdminAlertEmail(
        "Backup Failures",
        `${errors.length} VM backup(s) failed:\n\n${errors.join("\n")}`
      );
    } catch {
      // Non-fatal
    }
  }

  // ========================================================================
  // Recycle expired invites: reset waitlist entries so they get re-invited
  // in the next batch. Without this, users whose 7-day invite expired
  // sit in limbo — marked as "invited" but with a dead code.
  // ========================================================================
  let recycled = 0;
  try {
    const now = new Date().toISOString();

    // Find all expired, unused invites
    const { data: expiredInvites } = await supabase
      .from("instaclaw_invites")
      .select("code, email, expires_at")
      .eq("times_used", 0)
      .eq("is_active", true)
      .lt("expires_at", now);

    if (expiredInvites?.length) {
      for (const inv of expiredInvites) {
        // Skip if they already signed up
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("id")
          .ilike("email", inv.email)
          .limit(1);
        if (user?.length) continue;

        // Skip if they have a different active invite
        const { data: activeInv } = await supabase
          .from("instaclaw_invites")
          .select("code")
          .eq("email", inv.email)
          .eq("is_active", true)
          .gt("expires_at", now)
          .neq("code", inv.code)
          .limit(1);
        if (activeInv?.length) continue;

        // Reset their waitlist entry so batch script picks them up again
        const { data: wl } = await supabase
          .from("instaclaw_waitlist")
          .select("id, invite_sent_at")
          .ilike("email", inv.email)
          .not("invite_sent_at", "is", null)
          .limit(1);

        if (wl?.length) {
          await supabase
            .from("instaclaw_waitlist")
            .update({ invite_sent_at: null, invite_code: null })
            .eq("id", wl[0].id);
          recycled++;
        }

        // Deactivate the expired invite
        await supabase
          .from("instaclaw_invites")
          .update({ is_active: false })
          .eq("code", inv.code);
      }
    }

    if (recycled > 0) {
      logger.info("Recycled expired invite waitlist entries", {
        route: "cron/backup",
        recycled,
        totalExpired: expiredInvites?.length ?? 0,
      });
    }
  } catch (err) {
    logger.error("Expired invite recycling failed", {
      route: "cron/backup",
      error: String(err),
    });
  }

  return NextResponse.json({
    backed_up,
    total: vms.length,
    errors: errors.length ? errors : undefined,
    recycled_expired_invites: recycled,
  });
}
