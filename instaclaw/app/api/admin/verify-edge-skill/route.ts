import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, VMRecord } from "@/lib/ssh";
import { validateAdminKey } from "@/lib/security";

/**
 * Temporary admin endpoint to verify Edge City skill installation on a VM.
 * DELETE THIS after verification is complete.
 *
 * POST /api/admin/verify-edge-skill
 * Headers: X-Admin-Key
 * Body: { vmId: string }
 */
export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vmId } = await req.json();
  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, partner")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  const ssh = await connectSSH(vm as VMRecord, { skipDuplicateIPCheck: true });
  try {
    const checks = {
      skillMdExists: false,
      referencesExist: false,
      soulMdHasEdgeSection: false,
      vmPartner: vm.partner,
      cronInstalled: false,
      extraDirsRegistered: false,
      referenceFileList: "",
      soulMdSnippet: "",
      cronOutput: "",
      extraDirsOutput: "",
    };

    // 3a: SKILL.md exists
    const skillCheck = await ssh.execCommand('test -f ~/.openclaw/skills/edge-esmeralda/SKILL.md && echo "EXISTS" || echo "MISSING"');
    checks.skillMdExists = skillCheck.stdout.trim() === "EXISTS";

    // 3b: references/ has markdown files
    const refCheck = await ssh.execCommand('ls ~/.openclaw/skills/edge-esmeralda/references/*.md 2>/dev/null | wc -l');
    const refCount = parseInt(refCheck.stdout.trim(), 10);
    checks.referencesExist = refCount > 0;
    const refList = await ssh.execCommand('ls -la ~/.openclaw/skills/edge-esmeralda/references/ 2>/dev/null');
    checks.referenceFileList = refList.stdout.trim();

    // 3c: SOUL.md has Edge Esmeralda section
    const soulCheck = await ssh.execCommand('grep -c "Edge Esmeralda 2026" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"');
    checks.soulMdHasEdgeSection = parseInt(soulCheck.stdout.trim(), 10) > 0;
    const soulSnippet = await ssh.execCommand('grep -A 3 "Edge Esmeralda 2026" ~/.openclaw/workspace/SOUL.md 2>/dev/null | head -5');
    checks.soulMdSnippet = soulSnippet.stdout.trim();

    // 3e: 30-min git pull cron
    const cronCheck = await ssh.execCommand('crontab -l 2>/dev/null | grep "edge-agent-skill"');
    checks.cronInstalled = cronCheck.stdout.trim().length > 0;
    checks.cronOutput = cronCheck.stdout.trim();

    // 3f: edge-esmeralda in openclaw.json extraDirs
    const extraDirsCheck = await ssh.execCommand('python3 -c "import json; cfg=json.load(open(\'/home/openclaw/.openclaw/openclaw.json\')); print(cfg.get(\'skills\',{}).get(\'load\',{}).get(\'extraDirs\',[]))" 2>/dev/null');
    checks.extraDirsOutput = extraDirsCheck.stdout.trim();
    checks.extraDirsRegistered = extraDirsCheck.stdout.includes("/home/openclaw/.openclaw/skills");

    return NextResponse.json({
      vm: vm.name,
      results: {
        "3a_skill_md_exists": { pass: checks.skillMdExists, detail: checks.skillMdExists ? "SKILL.md found" : "SKILL.md MISSING" },
        "3b_references_exist": { pass: checks.referencesExist, detail: checks.referenceFileList },
        "3c_soul_md_edge_section": { pass: checks.soulMdHasEdgeSection, detail: checks.soulMdSnippet },
        "3d_vm_partner_field": { pass: checks.vmPartner === "edge_city", detail: `partner=${checks.vmPartner}` },
        "3e_cron_installed": { pass: checks.cronInstalled, detail: checks.cronOutput || "NO CRON FOUND" },
        "3f_extra_dirs": { pass: checks.extraDirsRegistered, detail: checks.extraDirsOutput },
      },
      allPass: checks.skillMdExists && checks.referencesExist && checks.soulMdHasEdgeSection && checks.vmPartner === "edge_city" && checks.cronInstalled && checks.extraDirsRegistered,
    });
  } finally {
    ssh.dispose();
  }
}
