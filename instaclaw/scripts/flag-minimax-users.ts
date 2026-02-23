/**
 * Flag all existing MiniMax M2.5 users for follow-up.
 *
 * Queries all assigned VMs running minimax-m2.5, looks up the assigned
 * user's email/name, and prints a CSV for outreach. Does NOT auto-switch
 * anyone — just identifies who to contact.
 *
 * Usage: npx tsx scripts/flag-minimax-users.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local.full") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log("=== MiniMax M2.5 Users — Flagged for Upgrade Outreach ===\n");

  // Get all assigned VMs on MiniMax
  const { data: vms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, assigned_to, default_model, health_status, created_at")
    .eq("status", "assigned")
    .eq("default_model", "minimax-m2.5")
    .order("created_at", { ascending: true });

  if (vmErr) {
    console.error("Failed to query VMs:", vmErr.message);
    return;
  }

  if (!vms || vms.length === 0) {
    console.log("No MiniMax users found.");
    return;
  }

  // Look up user details for each VM
  const userIds = vms.map((v) => v.assigned_to).filter(Boolean);
  const { data: users } = await supabase
    .from("instaclaw_users")
    .select("id, name, email")
    .in("id", userIds);

  const userMap = new Map<string, { name: string | null; email: string | null }>();
  for (const u of users || []) {
    userMap.set(u.id, { name: u.name, email: u.email });
  }

  // Print summary
  console.log(`Found ${vms.length} users on MiniMax M2.5:\n`);
  console.log("VM Name,User Email,User Name,Health,Assigned Date");

  for (const vm of vms) {
    const user = userMap.get(vm.assigned_to) || { name: null, email: null };
    const assignedDate = vm.created_at ? new Date(vm.created_at).toISOString().split("T")[0] : "unknown";
    console.log(
      `${vm.name},${user.email || "unknown"},${user.name || "unknown"},${vm.health_status},${assignedDate}`
    );
  }

  console.log(`\n--- Total: ${vms.length} MiniMax users to contact ---`);
  console.log("\nSuggested outreach message:");
  console.log("---");
  console.log("Subject: Upgrade your InstaClaw agent to Claude Haiku — better tools, memory, and reliability");
  console.log("");
  console.log("Hey [name],");
  console.log("");
  console.log("We've been improving agent quality and noticed your agent is running on MiniMax M2.5.");
  console.log("Based on our testing, Claude Haiku 4.5 delivers significantly better results for:");
  console.log("  - Multi-step tasks and tool use (web search, browser, file ops)");
  console.log("  - Following your custom instructions and preferences");
  console.log("  - Memory persistence between conversations");
  console.log("");
  console.log("Would you like us to switch your default model to Claude Haiku? It uses 1 unit/message");
  console.log("instead of 0.2, but the quality difference is substantial. You can always switch back.");
  console.log("");
  console.log("Just reply to this email and we'll make the change.");
  console.log("---");
}

main().catch(console.error);
