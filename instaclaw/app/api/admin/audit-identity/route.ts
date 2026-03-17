import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { validateAdminKey } from "@/lib/security";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const maxDuration = 300;

const CONCURRENCY = 10;
const SSH_TIMEOUT = 8_000;

interface AuditResult {
  vmId: string;
  vmName: string | null;
  assignedTo: string;
  assignedEmail: string | null;
  configuredUser: string | null;
  match: boolean;
  error?: string;
}

export async function GET(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned, healthy VMs with their user info
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, health_status")
    .not("assigned_to", "is", null)
    .in("health_status", ["healthy", "degraded"]);

  if (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  if (!vms || vms.length === 0) {
    return NextResponse.json({ total: 0, mismatches: [], results: [] });
  }

  // Batch-fetch user emails
  const userIds = [...new Set(vms.map((v) => v.assigned_to).filter(Boolean))];
  const { data: users } = await supabase
    .from("instaclaw_users")
    .select("id, email")
    .in("id", userIds);

  const userMap = new Map(users?.map((u) => [u.id, u.email]) ?? []);

  // Audit VMs in parallel with concurrency limit
  const results: AuditResult[] = [];
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (vm): Promise<AuditResult> => {
        const assignedEmail = userMap.get(vm.assigned_to) ?? null;
        try {
          const ssh = await connectSSH(vm, { skipDuplicateIPCheck: true });
          try {
            const result = await ssh.execCommand("cat ~/workspace/USER.md 2>/dev/null || echo '__NO_USER_MD__'", {
              execOptions: { timeout: SSH_TIMEOUT },
            });
            const content = result.stdout?.trim() ?? "";

            if (content === "__NO_USER_MD__" || !content) {
              return {
                vmId: vm.id,
                vmName: vm.name,
                assignedTo: vm.assigned_to,
                assignedEmail,
                configuredUser: null,
                match: false,
                error: "USER.md not found",
              };
            }

            // Extract name/email from USER.md content
            // Typical format: "# Name\nEmail: user@example.com" or similar
            const emailMatch = content.match(/[\w.+-]+@[\w.-]+\.\w+/);
            const configuredEmail = emailMatch?.[0] ?? null;

            // Check if the configured email matches the assigned user's email
            const isMatch = configuredEmail != null && assignedEmail != null
              && configuredEmail.toLowerCase() === assignedEmail.toLowerCase();

            return {
              vmId: vm.id,
              vmName: vm.name,
              assignedTo: vm.assigned_to,
              assignedEmail,
              configuredUser: configuredEmail,
              match: isMatch,
            };
          } finally {
            ssh.dispose();
          }
        } catch (err) {
          return {
            vmId: vm.id,
            vmName: vm.name,
            assignedTo: vm.assigned_to,
            assignedEmail,
            configuredUser: null,
            match: false,
            error: `SSH failed: ${String(err).slice(0, 200)}`,
          };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      }
    }
  }

  const mismatches = results.filter((r) => !r.match && !r.error);
  const errors = results.filter((r) => !!r.error);

  // Alert admin if mismatches found
  if (mismatches.length > 0) {
    const detail = mismatches
      .map((m) => `- VM ${m.vmId} (${m.vmName}): DB=${m.assignedEmail}, VM=${m.configuredUser}`)
      .join("\n");

    logger.error("IDENTITY MISMATCH DETECTED", {
      route: "admin/audit-identity",
      count: mismatches.length,
      mismatches: mismatches.map((m) => m.vmId),
    });

    sendAdminAlertEmail(
      `CRITICAL: ${mismatches.length} VM Identity Mismatch(es) Detected`,
      `The fleet identity audit found VMs where the configured user does not match the DB assignment.\n\n${detail}\n\nImmediate investigation required.`
    ).catch(() => {});
  }

  return NextResponse.json({
    total: results.length,
    matches: results.filter((r) => r.match).length,
    mismatches: mismatches.length,
    errors: errors.length,
    mismatchDetails: mismatches,
    errorDetails: errors,
  });
}
