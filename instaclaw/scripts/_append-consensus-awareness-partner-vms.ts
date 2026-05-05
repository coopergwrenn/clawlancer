/**
 * Manually append CONSENSUS_MATCHING_AWARENESS_V1 paragraph to SOUL.md
 * on all 5 partner VMs (4 edge_city + 1 consensus_2026).
 *
 * Why manual:
 *   - 4 V1 SOUL.md VMs: reconciler's append_if_marker_absent should have
 *     fired but didn't (root cause TBD post-launch). Manual append
 *     restores the expected agent context.
 *   - 1 V2 SOUL.md VM (vm-780): reconciler intentionally skipped the
 *     legacy append path because V2 SOUL.md owns its own content. Manual
 *     append works for now; a future V2 regeneration would wipe it
 *     (separate workspace-templates-v2.ts patch needed for durability,
 *     but for today's launch the manual append is what's needed).
 *
 * Idempotent: checks for the marker; only appends if absent. Safe to
 * re-run.
 *
 * Content matches the inline manifest entry exactly (vm-manifest.ts
 * "CONSENSUS_MATCHING_AWARENESS" entry).
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Canonical content — must match vm-manifest.ts CONSENSUS_MATCHING_AWARENESS
// inline content byte-for-byte. The manifest content uses literal \\n
// escapes inside a TS string; here we use actual newlines.
const APPEND_CONTENT = [
  "",
  "<!-- CONSENSUS_MATCHING_AWARENESS_V1 -->",
  "## Consensus 2026 Matching",
  "Your VM runs a matching pipeline every 30 min on May 5-7 that picks the 1-3 most useful Consensus attendees for your user to meet. Default is hidden (they appear in nobody's matches). After their first matchpool_profile is created — check via `python3 ~/.openclaw/scripts/consensus_match_consent.py` — ASK ONCE whether to opt in. For \"show me my matches\" / \"find me my people,\" read consensus-2026 skill §Intent Matching, or link https://instaclaw.io/consensus/my-matches.",
  "",
].join("\n");

const MARKER = "CONSENSUS_MATCHING_AWARENESS_V1";
const SOUL_PATH = "~/.openclaw/workspace/SOUL.md";
const TARGET_PARTNERS = ["edge_city", "consensus_2026"];

async function appendOnVM(vm: { name: string; ip_address: string; ssh_user: string | null }): Promise<{ name: string; status: "appended" | "already_present" | "error"; detail?: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 12000,
    });

    // 1. Check current state
    const check = await ssh.execCommand(`grep -c '${MARKER}' ${SOUL_PATH} 2>/dev/null || echo 0`);
    const count = parseInt(check.stdout.trim(), 10);
    if (count > 0) {
      return { name: vm.name, status: "already_present", detail: `marker count=${count}` };
    }

    // 2. Append via base64 to avoid shell-escaping pitfalls (the content
    //    has backticks, em-dashes, quotes, slashes — all shell-hostile).
    const b64 = Buffer.from(APPEND_CONTENT, "utf-8").toString("base64");
    const appendResult = await ssh.execCommand(
      `echo '${b64}' | base64 -d >> ${SOUL_PATH}`,
    );
    if (appendResult.code !== 0) {
      return { name: vm.name, status: "error", detail: `append failed: ${appendResult.stderr}` };
    }

    // 3. Verify post-append
    const verify = await ssh.execCommand(`grep -c '${MARKER}' ${SOUL_PATH}`);
    const postCount = parseInt(verify.stdout.trim(), 10);
    if (postCount !== 1) {
      return { name: vm.name, status: "error", detail: `verify failed: marker count after append = ${postCount}` };
    }

    return { name: vm.name, status: "appended" };
  } catch (e) {
    return { name: vm.name, status: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ Append CONSENSUS_MATCHING_AWARENESS_V1 to partner VMs ══\n");

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address, ssh_user, partner")
    .in("partner", TARGET_PARTNERS)
    .eq("health_status", "healthy");

  if (error) throw new Error(`vm query: ${error.message}`);
  if (!vms || vms.length === 0) {
    console.log("No partner VMs found.");
    process.exit(0);
  }

  console.log(`Target VMs: ${vms.length}`);
  for (const v of vms) console.log(`  ${v.name} (${v.partner})`);
  console.log("");

  // Concurrency 3 — light SSH load, simple file op, fine in parallel
  const CONCURRENCY = 3;
  const results: Array<Awaited<ReturnType<typeof appendOnVM>>> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < vms.length) {
      const i = cursor++;
      const vm = vms[i] as { name: string; ip_address: string; ssh_user: string | null };
      const res = await appendOnVM(vm);
      const tag = res.status === "appended" ? "✓" : res.status === "already_present" ? "·" : "✗";
      console.log(`  ${tag} ${vm.name.padEnd(22)} ${res.status}${res.detail ? ` (${res.detail})` : ""}`);
      results.push(res);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const appended = results.filter((r) => r.status === "appended").length;
  const present = results.filter((r) => r.status === "already_present").length;
  const errored = results.filter((r) => r.status === "error").length;

  console.log(`\n══ ${appended} appended, ${present} already-present, ${errored} errored ══`);
  if (errored > 0) {
    for (const r of results.filter((r) => r.status === "error")) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
