/**
 * Phase 2: Fleet-wide skill integrity audit.
 *
 * Scans every healthy assigned VM. For each skill dir under ~/.openclaw/skills
 * AND the sibling ~/dgclaw-skill, captures: has SKILL.md, has .git, git
 * status clean, file count, directory mtime. Aggregates per-VM and per-skill.
 *
 * Categorizes each skill against the known taxonomy:
 *   - GIT_CLONED: bankr, edge-esmeralda, consensus-2026 → require .git/ + SKILL.md
 *   - STATIC: 24 skills → require SKILL.md only (NO .git/ expected)
 *   - SIBLING: ~/dgclaw-skill/ → require .git/ + scripts/dgclaw.sh
 *
 * Output: TSV of per-VM-per-skill, plus aggregate summary.
 */
import { readFileSync, writeFileSync } from "fs";
import { connectSSH, type VMRecord } from "../lib/ssh";
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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Taxonomy from instaclaw/skills/ + lib/ssh.ts install patterns
const GIT_CLONED = new Set(["bankr", "edge-esmeralda", "consensus-2026"]);
const STATIC_SKILLS = new Set([
  "agentbook", "brand-design", "code-execution", "competitive-intelligence",
  "computer-dispatch", "dgclaw", "ecommerce-marketplace", "email-outreach",
  "financial-analysis", "higgsfield-video", "instagram-automation",
  "language-teacher", "marketplace-earning", "motion-graphics", "newsworthy",
  "prediction-markets", "shared", "sjinn-video", "social-media-content",
  "solana-defi", "voice-audio-production", "web-search-browser",
  "x-twitter-search", "xmtp-agent",
]);
// edge-esmeralda is partner-gated (edge_city) — absence is normal on non-partner VMs
const PARTNER_GATED = new Set(["edge-esmeralda"]);

const PROBE = `set +e
echo "===VM_META==="
hostname
date -u +%FT%TZ
echo "===SKILLS_DIR==="
ls -1 ~/.openclaw/skills 2>/dev/null
echo "===PER_SKILL==="
for d in ~/.openclaw/skills/*/; do
  name=$(basename "$d")
  has_skill_md=$([ -f "$d/SKILL.md" ] && echo Y || echo N)
  has_git=$([ -d "$d/.git" ] && echo Y || echo N)
  git_status="-"
  git_remote="-"
  git_last_commit="-"
  if [ -d "$d/.git" ]; then
    git_status=$(cd "$d" && git status --porcelain 2>&1 | head -c 200 | tr '\\n\\t' '  ')
    [ -z "$git_status" ] && git_status="clean"
    git_remote=$(cd "$d" && git remote get-url origin 2>/dev/null | head -c 80)
    [ -z "$git_remote" ] && git_remote="-"
    git_last_commit=$(cd "$d" && git log -1 --format='%ai' 2>/dev/null | head -c 30)
    [ -z "$git_last_commit" ] && git_last_commit="-"
  fi
  file_count=$(find "$d" -maxdepth 3 -type f 2>/dev/null | wc -l | tr -d ' ')
  dir_mtime=$(stat -c '%y' "$d" 2>/dev/null | cut -d. -f1)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$has_skill_md" "$has_git" "$git_status" "$git_remote" "$git_last_commit" "$file_count" "$dir_mtime"
done
echo "===SIBLING_DGCLAW==="
if [ -d ~/dgclaw-skill ]; then
  has_git=$([ -d ~/dgclaw-skill/.git ] && echo Y || echo N)
  has_script=$([ -f ~/dgclaw-skill/scripts/dgclaw.sh ] && echo Y || echo N)
  git_status="-"
  if [ -d ~/dgclaw-skill/.git ]; then
    git_status=$(cd ~/dgclaw-skill && git status --porcelain 2>&1 | head -c 200 | tr '\\n\\t' '  ')
    [ -z "$git_status" ] && git_status="clean"
  fi
  printf 'dgclaw-sibling\\t%s\\t%s\\t%s\\n' "$has_git" "$has_script" "$git_status"
else
  echo "dgclaw-sibling\\tABSENT"
fi
echo "===END==="
`;

type SkillRow = {
  name: string;
  has_skill_md: "Y" | "N";
  has_git: "Y" | "N";
  git_status: string;
  git_remote: string;
  git_last_commit: string;
  file_count: number;
  dir_mtime: string;
};
type VMResult = {
  vm_id: string;
  name: string;
  partner: string | null;
  skills: SkillRow[];
  sibling_dgclaw_present: boolean;
  sibling_dgclaw_has_git: boolean;
  sibling_dgclaw_has_script: boolean;
  sibling_dgclaw_git_status: string;
  ssh_error?: string;
};

async function probeVM(vm: VMRecord & { partner?: string | null; name?: string | null }): Promise<VMResult> {
  const result: VMResult = {
    vm_id: vm.id,
    name: vm.name ?? "?",
    partner: vm.partner ?? null,
    skills: [],
    sibling_dgclaw_present: false,
    sibling_dgclaw_has_git: false,
    sibling_dgclaw_has_script: false,
    sibling_dgclaw_git_status: "-",
  };
  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (e) {
    result.ssh_error = e instanceof Error ? e.message : String(e);
    return result;
  }
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    const out = r.stdout;
    const perSkillBlock = out.split("===PER_SKILL===")[1]?.split("===SIBLING_DGCLAW===")[0] ?? "";
    const siblingBlock = out.split("===SIBLING_DGCLAW===")[1]?.split("===END===")[0] ?? "";
    for (const line of perSkillBlock.split("\n")) {
      const cols = line.split("\t");
      if (cols.length < 8) continue;
      result.skills.push({
        name: cols[0]!.trim(),
        has_skill_md: cols[1] as "Y" | "N",
        has_git: cols[2] as "Y" | "N",
        git_status: cols[3]!.trim(),
        git_remote: cols[4]!.trim(),
        git_last_commit: cols[5]!.trim(),
        file_count: parseInt(cols[6] ?? "0", 10) || 0,
        dir_mtime: cols[7]!.trim(),
      });
    }
    for (const line of siblingBlock.split("\n")) {
      if (line.startsWith("dgclaw-sibling\t")) {
        const cols = line.split("\t");
        if (cols[1] === "ABSENT") {
          result.sibling_dgclaw_present = false;
        } else {
          result.sibling_dgclaw_present = true;
          result.sibling_dgclaw_has_git = cols[1] === "Y";
          result.sibling_dgclaw_has_script = cols[2] === "Y";
          result.sibling_dgclaw_git_status = (cols[3] ?? "-").trim();
        }
      }
    }
  } finally {
    ssh.dispose();
  }
  return result;
}

(async () => {
  const { data: pool } = await sb.from("instaclaw_vms")
    .select("id,name,ip_address,ssh_port,ssh_user,partner,assigned_to")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("gateway_url", "is", null)
    .not("assigned_to", "is", null)
    .order("name");

  const targets = pool ?? [];
  console.log(`Probing ${targets.length} healthy assigned VMs (concurrency=10)...\n`);

  const results: VMResult[] = new Array(targets.length);
  let cur = 0;
  let done = 0;
  async function worker() {
    while (cur < targets.length) {
      const i = cur++;
      const v = targets[i];
      try {
        results[i] = await probeVM({
          id: v.id, ip_address: v.ip_address, ssh_port: v.ssh_port, ssh_user: v.ssh_user,
          partner: v.partner, name: v.name,
        } as any);
      } catch (e) {
        results[i] = {
          vm_id: v.id, name: v.name ?? "?", partner: v.partner ?? null,
          skills: [], sibling_dgclaw_present: false, sibling_dgclaw_has_git: false,
          sibling_dgclaw_has_script: false, sibling_dgclaw_git_status: "-",
          ssh_error: e instanceof Error ? e.message : String(e),
        };
      }
      done++;
      if (done % 10 === 0) console.log(`  progress ${done}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));

  // Persist raw results
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const rawPath = `/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/_fleet-skills-audit-${ts}.json`;
  writeFileSync(rawPath, JSON.stringify({ generated_at: new Date().toISOString(), count: results.length, results }, null, 2));
  console.log(`\nRaw results: ${rawPath}\n`);

  const okResults = results.filter(r => !r.ssh_error);
  const sshFailed = results.filter(r => r.ssh_error);

  // Per-skill defect classification
  type Defect = { vm_name: string; partner: string | null; skill: string; defect: string; mtime?: string; remote?: string };
  const defects: Defect[] = [];
  // Per-skill-name presence/health stats
  const skillStats: Record<string, { present_on: number; missing_skill_md: number; broken_git: number; bad_remote: number }> = {};
  for (const r of okResults) {
    const seenSkills = new Set<string>();
    for (const s of r.skills) {
      seenSkills.add(s.name);
      if (!skillStats[s.name]) skillStats[s.name] = { present_on: 0, missing_skill_md: 0, broken_git: 0, bad_remote: 0 };
      skillStats[s.name].present_on++;

      // Every skill must have SKILL.md (both static and git-cloned)
      if (s.has_skill_md === "N") {
        skillStats[s.name].missing_skill_md++;
        defects.push({ vm_name: r.name, partner: r.partner, skill: s.name, defect: "MISSING_SKILL_MD", mtime: s.dir_mtime });
      }
      // Git-cloned skills must have .git AND clean git status AND correct remote
      if (GIT_CLONED.has(s.name)) {
        if (s.has_git === "N") {
          skillStats[s.name].broken_git++;
          defects.push({ vm_name: r.name, partner: r.partner, skill: s.name, defect: "MISSING_DOTGIT", mtime: s.dir_mtime });
        } else if (s.git_status !== "clean" && s.git_status !== "-") {
          // dirty status — could be local mods or corrupted
          if (/fatal|corrupt|broken|bad object|loose object/i.test(s.git_status)) {
            skillStats[s.name].broken_git++;
            defects.push({ vm_name: r.name, partner: r.partner, skill: s.name, defect: `CORRUPT_GIT: ${s.git_status.slice(0, 80)}`, mtime: s.dir_mtime });
          }
        }
        // remote check
        const expectedRemoteFrag: Record<string, string> = {
          "bankr": "BankrBot/skills",
          "edge-esmeralda": "edge-agent-skill",
          "consensus-2026": "consensus-2026-skill",
        };
        const expected = expectedRemoteFrag[s.name];
        if (expected && s.has_git === "Y" && !s.git_remote.includes(expected)) {
          skillStats[s.name].bad_remote++;
          defects.push({ vm_name: r.name, partner: r.partner, skill: s.name, defect: `BAD_REMOTE: ${s.git_remote}`, mtime: s.dir_mtime });
        }
      }
      // Static skills: a stray .git/ would be unusual but not necessarily broken
      if (STATIC_SKILLS.has(s.name) && s.has_git === "Y") {
        defects.push({ vm_name: r.name, partner: r.partner, skill: s.name, defect: "UNEXPECTED_DOTGIT (static skill has .git/)", mtime: s.dir_mtime });
      }
    }
    // Missing entire required skills?
    for (const required of STATIC_SKILLS) {
      // Skip "shared" — it's not a real skill, it's a shared assets dir
      if (required === "shared") continue;
      // Skip computer-dispatch — only installed when dispatch mode toggled on
      if (required === "computer-dispatch") continue;
      // Skip newsworthy — partner-conditional
      if (required === "newsworthy") continue;
      // Skip xmtp-agent / instagram-automation — may be conditional/disabled
      if (required === "xmtp-agent" || required === "instagram-automation") continue;
      // Skip higgsfield-video / solana-defi — known disabled-by-default in some VMs
      if (required === "higgsfield-video" || required === "solana-defi") continue;
      if (!seenSkills.has(required)) {
        defects.push({ vm_name: r.name, partner: r.partner, skill: required, defect: "SKILL_DIR_ABSENT" });
      }
    }
    // Git-cloned skills: required only if not partner-gated or matching partner
    for (const required of GIT_CLONED) {
      if (PARTNER_GATED.has(required) && r.partner !== "edge_city") continue;
      // consensus-2026 currently only installed on consensus opted-in VMs — skip required-presence check for now
      if (required === "consensus-2026") continue;
      if (!seenSkills.has(required)) {
        defects.push({ vm_name: r.name, partner: r.partner, skill: required, defect: "GIT_SKILL_ABSENT" });
      }
    }
  }

  // Aggregate sibling dgclaw
  const dgclawSiblingMissing = okResults.filter(r => !r.sibling_dgclaw_present);
  const dgclawSiblingNoGit = okResults.filter(r => r.sibling_dgclaw_present && !r.sibling_dgclaw_has_git);
  const dgclawSiblingNoScript = okResults.filter(r => r.sibling_dgclaw_present && !r.sibling_dgclaw_has_script);

  // Per-VM defect summary
  const vmDefects = new Map<string, Defect[]>();
  for (const d of defects) {
    if (!vmDefects.has(d.vm_name)) vmDefects.set(d.vm_name, []);
    vmDefects.get(d.vm_name)!.push(d);
  }

  // ── Report ──
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  FLEET SKILL AUDIT RESULTS`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  VMs probed:           ${results.length}`);
  console.log(`  Successful probes:    ${okResults.length}`);
  console.log(`  SSH failures:         ${sshFailed.length}`);
  console.log(`  Total defects:        ${defects.length}`);
  console.log(`  VMs with defects:     ${vmDefects.size}`);
  console.log("");

  // SSH failures — relevant to know if audit coverage is complete
  if (sshFailed.length > 0) {
    console.log(`── SSH-unreachable VMs (excluded from defect counts) ──`);
    for (const r of sshFailed.slice(0, 10)) {
      console.log(`  ${r.name.padEnd(22)} ${(r.ssh_error ?? "").slice(0, 80)}`);
    }
    if (sshFailed.length > 10) console.log(`  ... ${sshFailed.length - 10} more`);
    console.log("");
  }

  // Per-skill stats
  console.log(`── Per-skill presence & health (across ${okResults.length} VMs) ──`);
  console.log(`${"skill".padEnd(28)} ${"present_on".padEnd(11)} ${"no_skill_md".padEnd(12)} ${"broken_git".padEnd(11)} bad_remote`);
  for (const [skill, st] of Object.entries(skillStats).sort((a,b) => b[1].present_on - a[1].present_on)) {
    const tag = GIT_CLONED.has(skill) ? "[git]" : STATIC_SKILLS.has(skill) ? "[stc]" : "[?  ]";
    console.log(`  ${tag} ${skill.padEnd(22)} ${String(st.present_on).padEnd(11)} ${String(st.missing_skill_md).padEnd(12)} ${String(st.broken_git).padEnd(11)} ${st.bad_remote}`);
  }
  console.log("");

  // Defect summary by category
  const defectByCategory: Record<string, number> = {};
  for (const d of defects) {
    const cat = d.defect.split(":")[0]!;
    defectByCategory[cat] = (defectByCategory[cat] ?? 0) + 1;
  }
  console.log(`── Defects by category ──`);
  for (const [cat, n] of Object.entries(defectByCategory).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${cat.padEnd(40)} ${n}`);
  }
  console.log("");

  // Sibling dgclaw
  console.log(`── ~/dgclaw-skill (sibling clone) ──`);
  console.log(`  Present:                  ${okResults.length - dgclawSiblingMissing.length}/${okResults.length}`);
  console.log(`  Present-but-no-.git:      ${dgclawSiblingNoGit.length}`);
  console.log(`  Present-but-no-script:    ${dgclawSiblingNoScript.length}`);
  if (dgclawSiblingNoScript.length > 0) {
    console.log(`  VMs with broken sibling dgclaw (no scripts/dgclaw.sh):`);
    for (const v of dgclawSiblingNoScript.slice(0, 20)) {
      console.log(`    ${v.name.padEnd(22)} (partner=${v.partner ?? "-"}, git_status=${v.sibling_dgclaw_git_status.slice(0, 60)})`);
    }
    if (dgclawSiblingNoScript.length > 20) console.log(`    ... ${dgclawSiblingNoScript.length - 20} more`);
  }
  console.log("");

  // Top broken VMs (most defects)
  if (vmDefects.size > 0) {
    const sorted = Array.from(vmDefects.entries()).sort((a,b) => b[1].length - a[1].length);
    console.log(`── Top 20 VMs by defect count ──`);
    for (const [name, ds] of sorted.slice(0, 20)) {
      const dStr = ds.slice(0, 5).map(d => `${d.skill}:${d.defect.split(":")[0]}`).join(", ");
      console.log(`  ${name.padEnd(22)} ${String(ds.length).padStart(3)}d  ${dStr}${ds.length > 5 ? ` (+${ds.length - 5})` : ""}`);
    }
    if (sorted.length > 20) console.log(`  ... ${sorted.length - 20} more VMs with defects`);
  }
  console.log("");

  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`Raw JSON written to: ${rawPath}`);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
