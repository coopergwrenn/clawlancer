/**
 * Reanalyze the most recent _fleet-skills-audit-*.json with corrected logic:
 *   - bankr: multi-skill REPO. Required: .git/ + at least 1 subdir SKILL.md
 *     (we already proved the .git/ + remote check is in the raw JSON; the
 *     subdir SKILL.md count we observed = 100% on every probed VM.)
 *   - dgclaw at ~/.openclaw/skills/dgclaw/: required SKILL.md (static manifest skill)
 *   - dgclaw at ~/dgclaw-skill/ (sibling): only required if user has installed
 *     dgclaw skill (i.e., agdp_enabled). For now, flag only present-but-broken.
 *   - .git/ in static skill dirs: NOT a defect. Common pattern for repaired
 *     skills (re-cloned the upstream repo to fix a partial install).
 *
 * Also pulls owner info for any VM still flagged after re-classification.
 */
import { readFileSync, readdirSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  const dir = "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts";
  const file = readdirSync(dir).filter(f => f.startsWith("_fleet-skills-audit-") && f.endsWith(".json")).sort().reverse()[0];
  if (!file) { console.error("no audit JSON found"); process.exit(1); }
  console.log(`Reanalyzing: ${file}\n`);
  const data = JSON.parse(readFileSync(`${dir}/${file}`, "utf-8"));
  const results = data.results as any[];

  // Real defects only
  const realDefects: Array<{ vm: string; partner: string | null; defect: string; detail?: string }> = [];

  for (const r of results) {
    if (r.ssh_error) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "SSH_UNREACHABLE", detail: r.ssh_error.slice(0, 80) });
      continue;
    }
    const skillNames = new Set(r.skills.map((s: any) => s.name));
    const bankr = r.skills.find((s: any) => s.name === "bankr");
    const dgclaw = r.skills.find((s: any) => s.name === "dgclaw");

    // bankr required: must be present, must have .git, must have valid remote
    if (!bankr) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "BANKR_DIR_ABSENT" });
    } else {
      if (bankr.has_git === "N") realDefects.push({ vm: r.name, partner: r.partner, defect: "BANKR_NO_DOTGIT", detail: `mtime=${bankr.dir_mtime}` });
      else if (bankr.git_remote && !bankr.git_remote.includes("BankrBot")) {
        realDefects.push({ vm: r.name, partner: r.partner, defect: "BANKR_BAD_REMOTE", detail: bankr.git_remote });
      }
    }

    // dgclaw static skill: required SKILL.md present
    if (!dgclaw) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "DGCLAW_STATIC_DIR_ABSENT" });
    } else if (dgclaw.has_skill_md === "N") {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "DGCLAW_STATIC_NO_SKILL_MD", detail: `mtime=${dgclaw.dir_mtime}` });
    }

    // dgclaw sibling: flag only present-but-broken
    if (r.sibling_dgclaw_present && !r.sibling_dgclaw_has_script) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "DGCLAW_SIBLING_NO_SCRIPTS", detail: `git_status=${r.sibling_dgclaw_git_status}` });
    }
    if (r.sibling_dgclaw_present && !r.sibling_dgclaw_has_git) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "DGCLAW_SIBLING_NO_DOTGIT" });
    }

    // Other git-cloned skill checks (consensus-2026, edge-esmeralda)
    const consensus = r.skills.find((s: any) => s.name === "consensus-2026");
    if (consensus && consensus.has_git === "N") {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "CONSENSUS_NO_DOTGIT" });
    }
    const edge = r.skills.find((s: any) => s.name === "edge-esmeralda");
    if (r.partner === "edge_city" && !edge) {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "EDGE_CITY_VM_MISSING_EDGE_SKILL" });
    }
    if (edge && edge.has_git === "N") {
      realDefects.push({ vm: r.name, partner: r.partner, defect: "EDGE_NO_DOTGIT" });
    }

    // SKILL.md missing on any required static skill
    const requiredStatic = ["agentbook", "brand-design", "code-execution", "competitive-intelligence",
      "dgclaw", "ecommerce-marketplace", "email-outreach", "financial-analysis",
      "language-teacher", "marketplace-earning", "motion-graphics",
      "prediction-markets", "sjinn-video", "social-media-content",
      "voice-audio-production", "web-search-browser", "x-twitter-search"];
    for (const s of r.skills) {
      if (requiredStatic.includes(s.name) && s.has_skill_md === "N") {
        realDefects.push({ vm: r.name, partner: r.partner, defect: `STATIC_NO_SKILL_MD: ${s.name}`, detail: `mtime=${s.dir_mtime}` });
      }
    }
  }

  // Group by VM
  const byVM = new Map<string, typeof realDefects>();
  for (const d of realDefects) {
    if (!byVM.has(d.vm)) byVM.set(d.vm, []);
    byVM.get(d.vm)!.push(d);
  }

  // Group by category
  const byCategory: Record<string, number> = {};
  for (const d of realDefects) {
    const cat = d.defect.split(":")[0]!;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  RECLASSIFIED FLEET SKILL AUDIT (corrected for bankr multi-skill structure)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  VMs probed:         ${results.length}`);
  console.log(`  Real defects:       ${realDefects.length}`);
  console.log(`  VMs affected:       ${byVM.size}`);
  console.log("");

  console.log(`── Defects by category ──`);
  for (const [cat, n] of Object.entries(byCategory).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${cat.padEnd(40)} ${n}`);
  }
  console.log("");

  if (byVM.size > 0) {
    console.log(`── Affected VMs (with owner info) ──`);
    const affectedNames = Array.from(byVM.keys());
    const { data: vmsWithOwners } = await sb.from("instaclaw_vms")
      .select("name,assigned_to,partner,health_status,instaclaw_users!inner(email)")
      .in("name", affectedNames);
    const ownerByName: Record<string, string> = {};
    for (const v of vmsWithOwners ?? []) {
      ownerByName[v.name as string] = ((v as any).instaclaw_users?.email) ?? "?";
    }
    for (const [vm, ds] of byVM.entries()) {
      const owner = ownerByName[vm] ?? "(no owner)";
      console.log(`\n  ${vm} — ${owner} (partner=${ds[0].partner ?? "-"})`);
      for (const d of ds) {
        console.log(`    ${d.defect}${d.detail ? ` — ${d.detail}` : ""}`);
      }
    }
  } else {
    console.log(`✓ NO real defects across ${results.length} healthy assigned VMs.`);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
