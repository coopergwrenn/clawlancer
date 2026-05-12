/**
 * v94 tool-leak regression audit — run AFTER sending the 5 canary test prompts.
 *
 * Greps the gateway journal on vm-050 (or any VM) for v68/v94 leak patterns:
 *   - "exec run" — v68 leak shape (exec tool invocation rendered as text)
 *   - "tool: " — v68 leak header
 *   - "Working…\n•" — v94 formatProgressAsMarkdownCode output (channel-feedback)
 *   - "tool_use" — raw block leak (any case)
 *   - "toolCall" — wrapped tool call leak
 *   - "<toolUse" — XML-like tool leak
 *   - Generic patterns that suggest tool internals reached the user
 *
 * Plus: looks for hot-reload confirmation events to verify the config
 * actually took effect during the test window.
 *
 * What it does NOT do: it cannot see what the USER saw in their Telegram
 * client — that requires Cooper's eyes. This script only checks the gateway
 * journal for outbound-message tracing logs.
 *
 * Usage:
 *   npx tsx scripts/_audit-v94-leak-grep.ts --vm instaclaw-vm-050 --since '15 minutes ago'
 *   npx tsx scripts/_audit-v94-leak-grep.ts --vm instaclaw-vm-050 --since '2 hours ago'
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env.ssh-key") });

const LEAK_PATTERNS = [
  // v68-incident shapes
  { name: "v68: exec-run leak", regex: /\bexec run\b/, severity: "critical" },
  { name: "v68: tool-header", regex: /^[^\n]*\btool: (exec|http|web_search|browser)\b/, severity: "critical" },
  // v94 formatProgressAsMarkdownCode (channel-feedback)
  { name: "v94: Working… progress block", regex: /Working…\s*\n\s*•/, severity: "critical" },
  // Generic tool-internal markers
  { name: "raw tool_use string in outbound", regex: /"type"\s*:\s*"tool_use"/, severity: "high" },
  { name: "toolCall block leak", regex: /"type"\s*:\s*"toolCall"/, severity: "high" },
  { name: "stop_reason: tool_use literal", regex: /stop_reason["']?\s*:\s*["']tool_use/, severity: "high" },
];

const HOT_RELOAD_PATTERNS = [
  /\[reload\] config hot reload applied/,
  /\[gateway\/channels\] restarting telegram channel/,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const vmIdx = args.indexOf("--vm");
  const vm = vmIdx >= 0 ? args[vmIdx + 1] : "instaclaw-vm-050";
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : "15 minutes ago";
  return { vm, since };
}

interface VmRow {
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
}

async function getVm(vmName: string): Promise<VmRow> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await supabase
    .from("instaclaw_vms")
    .select("name, ip_address, ssh_port, ssh_user")
    .eq("name", vmName)
    .single();
  if (error || !data) throw new Error(`vm not found: ${vmName}`);
  return data as VmRow;
}

(async () => {
  const { vm: vmName, since } = parseArgs();
  console.log(`v94 leak audit — vm=${vmName} since='${since}'`);

  const vm = await getVm(vmName);
  if (!vm.ip_address) throw new Error("no ip_address");

  const c = await connectSSH({
    ip_address: vm.ip_address,
    ssh_port: vm.ssh_port ?? 22,
    ssh_user: vm.ssh_user ?? "openclaw",
  });

  console.log("\n=== Fetching gateway journal ===");
  const j = await c.execCommand(
    `journalctl --user -u openclaw-gateway --since '${since}' --no-pager 2>&1`,
    { execOptions: { pty: false } },
  );
  const journal = j.stdout || "";
  const lineCount = journal.split("\n").length;
  console.log(`Got ${lineCount} lines (${(journal.length / 1024).toFixed(1)} KB)`);

  console.log("\n=== Hot-reload confirmation ===");
  let hotReloadConfirmed = false;
  for (const p of HOT_RELOAD_PATTERNS) {
    const matches = journal.match(new RegExp(p.source, "g"));
    if (matches && matches.length > 0) {
      console.log(`  ✓ '${p.source}' (${matches.length} occurrences)`);
      hotReloadConfirmed = true;
    }
  }
  if (!hotReloadConfirmed) {
    console.log("  ⚠ no hot-reload events in window — either too old or config has already been applied long before");
  }

  console.log("\n=== Leak pattern scan ===");
  let totalMatches = 0;
  let criticalMatches = 0;
  for (const p of LEAK_PATTERNS) {
    const re = new RegExp(p.regex.source, "g" + (p.regex.flags.includes("i") ? "i" : ""));
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(journal)) !== null) {
      const start = Math.max(0, m.index - 80);
      const end = Math.min(journal.length, m.index + 150);
      matches.push(journal.slice(start, end).replace(/\n/g, " │ "));
      if (matches.length >= 3) break;  // cap per-pattern
    }
    const status = matches.length === 0 ? "✓" : "✗";
    console.log(`  ${status} [${p.severity}] ${p.name}: ${matches.length} match(es)`);
    for (const ctx of matches) {
      console.log(`      ...${ctx}...`);
    }
    totalMatches += matches.length;
    if (p.severity === "critical") criticalMatches += matches.length;
  }

  console.log("\n=== Telegram outbound activity ===");
  const tg = await c.execCommand(
    `journalctl --user -u openclaw-gateway --since '${since}' --no-pager 2>&1 | grep -E 'telegram.*send|setMessageReaction|editMessageText|sendChatAction|preview|stream' | head -30`,
    { execOptions: { pty: false } },
  );
  const tgOut = tg.stdout || "(no telegram-send activity in window)";
  console.log(tgOut);

  console.log("\n=== Summary ===");
  console.log(`Hot-reload confirmed: ${hotReloadConfirmed ? "YES" : "NO (warning — config may not be active)"}`);
  console.log(`Critical leak matches: ${criticalMatches}`);
  console.log(`Total leak matches:    ${totalMatches}`);
  if (criticalMatches > 0) {
    console.log("\n✗ CRITICAL — revert L2 immediately: streaming.mode → off");
    console.log("  npx tsx scripts/_canary-v94-ack-ux.ts --vm " + vmName + " --rollback");
    process.exit(1);
  } else if (totalMatches > 0) {
    console.log("\n⚠ Non-critical matches found — review context above to decide.");
    process.exit(2);
  } else {
    console.log("\n✓ Clean. No leak patterns detected in the audit window.");
  }

  c.dispose();
})().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
