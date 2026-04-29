import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env.ssh-key") });
import { connectSSH } from "../lib/ssh";

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  const { data: vm } = await s.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-780").single();
  if (!vm) return;
  const ssh = await connectSSH(vm);
  try {
    const r1 = await ssh.execCommand(`grep -niE "solana" $HOME/.openclaw/skills/bankr/bankr/SKILL.md 2>/dev/null | head -40`);
    console.log("=== Solana mentions in bankr/SKILL.md ===");
    console.log(r1.stdout || "(none)");
    console.log("\nstderr:", r1.stderr);

    const r2 = await ssh.execCommand(`ls -la $HOME/.openclaw/skills/bankr/`);
    console.log("\n=== skills/bankr/ contents ===");
    console.log(r2.stdout);

    const r3 = await ssh.execCommand(`wc -l $HOME/.openclaw/skills/bankr/bankr/SKILL.md && head -5 $HOME/.openclaw/skills/bankr/bankr/SKILL.md`);
    console.log("\n=== SKILL.md size + first 5 lines ===");
    console.log(r3.stdout);

    const r4 = await ssh.execCommand(`sed -n '525,560p' $HOME/.openclaw/skills/bankr/bankr/SKILL.md`);
    console.log("\n=== Lines 525-560 (Solana SPL deploy section) ===");
    console.log(r4.stdout);

    const r5 = await ssh.execCommand(`sed -n '820,860p' $HOME/.openclaw/skills/bankr/bankr/SKILL.md`);
    console.log("\n=== Lines 820-860 (Solana LaunchLab examples) ===");
    console.log(r5.stdout);
  } finally {
    ssh.dispose();
  }
})();
