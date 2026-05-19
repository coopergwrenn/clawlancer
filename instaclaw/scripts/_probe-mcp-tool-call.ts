/**
 * Probe whether our per-user MCP keys actually have permission to CALL
 * tools (not just list them). Tests:
 *   1. tools/list on each of 3 cohort VMs — does it work for all?
 *   2. read_intents (a read-only tool) on each
 *   3. create_intent (a write tool) on one
 *
 * Hypothesis: the user-issued apiKey via /signup has READ permissions by
 * default; WRITE actions (create_intent etc.) require a separate
 * grant_agent_permission(action='manage:intents') step.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { callIndexMcpTool } from "../lib/index-mcp-client";

async function probe(label: string, apiKey: string, toolName: string, args: Record<string, unknown>) {
  const r = await callIndexMcpTool({ apiKey, toolName, toolArgs: args });
  if (r.ok) {
    const content = (r.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    const prefix = content.slice(0, 250);
    console.log(`  ${label.padEnd(35)} ✓ ok — ${prefix.replace(/\n/g, " ").slice(0, 200)}`);
  } else {
    console.log(`  ${label.padEnd(35)} ✗ ${r.error}: ${(r.detail ?? "").slice(0, 200)}`);
  }
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name, index_api_key")
    .eq("partner", "edge_city")
    .not("index_api_key", "is", null)
    .in("name", ["instaclaw-vm-050", "instaclaw-vm-917", "instaclaw-vm-859"]);

  if (!vms) {
    console.error("✗ query failed");
    process.exit(1);
  }

  console.log("=== Step 1: tools/list on each (should work everywhere) ===");
  for (const vm of vms) {
    // tools/list doesn't go through callIndexMcpTool which calls tools/call;
    // we'll instead test a known read-only call as proxy.
    console.log(`\n  ${vm.name} key=${(vm.index_api_key as string).slice(0, 8)}…`);
  }

  console.log("\n=== Step 2: read_intents on each (read-only call) ===");
  for (const vm of vms) {
    await probe(`${vm.name}: read_intents`, vm.index_api_key as string, "read_intents", {});
  }

  console.log("\n=== Step 3: list_opportunities on each (read-only call) ===");
  for (const vm of vms) {
    await probe(
      `${vm.name}: list_opportunities`,
      vm.index_api_key as string,
      "list_opportunities",
      { networkId: "fee18edc-1e60-4b13-b8c8-20e6f6ed1acb" },
    );
  }

  console.log("\n=== Step 4: read_networks on each (read-only call) ===");
  for (const vm of vms) {
    await probe(
      `${vm.name}: read_networks`,
      vm.index_api_key as string,
      "read_networks",
      {},
    );
  }

  console.log("\n=== Step 5: create_intent on vm-050 ===");
  const vm050 = vms.find((v) => v.name === "instaclaw-vm-050");
  if (vm050) {
    await probe(
      `${vm050.name}: create_intent`,
      vm050.index_api_key as string,
      "create_intent",
      {
        description: "[SMOKE TEST 2026-05-19] curious about MCP tool permission semantics",
        networkId: "fee18edc-1e60-4b13-b8c8-20e6f6ed1acb",
      },
    );
  }
}

main().catch((e) => {
  console.error("✗ probe threw:", e);
  process.exit(99);
});
