/**
 * Fleet patch: surgical SOUL.md + CAPABILITIES.md row replacement for v67.
 *
 * Why: The reconciler's manifest entries for SOUL.md are all
 * `append_if_marker_absent` / `insert_before_marker` — none use overwrite.
 * The v67 change replaced an EXISTING row in the routing table (in-place),
 * which no manifest mode supports. Without this script, the v67 content
 * never reaches existing VMs.
 *
 * What it does (idempotent, atomic, per VM):
 *   1. Reads ~/.openclaw/workspace/SOUL.md and CAPABILITIES.md
 *   2. If v67 marker already present → already-patched, skip
 *   3. If old v66 row not found → old-not-found, skip (probably newer template)
 *   4. Otherwise: str.replace() the exact old row with the v67 two-row block,
 *      verify the marker is now present, write atomically via tmp + rename.
 *   5. On full success (both files patched or already-patched), bumps
 *      instaclaw_vms.config_version to VM_MANIFEST.version (67).
 *
 * Concurrency=5 (overridable via --concurrency=N). Safe — each VM is an
 * independent SSH session writing only to its own filesystem.
 *
 * Usage:
 *   npx tsx scripts/_fleet-patch-v67-soul.ts                  # dry-run
 *   npx tsx scripts/_fleet-patch-v67-soul.ts --execute        # live
 *   npx tsx scripts/_fleet-patch-v67-soul.ts --execute --concurrency=10
 *   npx tsx scripts/_fleet-patch-v67-soul.ts --execute --max=5
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { VM_MANIFEST } from "../lib/vm-manifest";

const argv = process.argv.slice(2);
const isExecute = argv.includes("--execute");
const concurrencyArg = argv.find(a => a.startsWith("--concurrency="))?.split("=")[1];
const concurrency = Math.max(1, concurrencyArg ? parseInt(concurrencyArg, 10) : 5);
const maxArg = argv.find(a => a.startsWith("--max="))?.split("=")[1];
const maxCount = maxArg ? parseInt(maxArg, 10) : Infinity;

const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// ── Exact strings (from commit 9dfe894) ───────────────────────────────────
// Strings constructed in code (no template-literal escape hell).
const SOUL_OLD = "| bankr, bankr wallet, bankr balance, bankr swap, token launch | Use the **bankr skill**. Check WALLET.md for your Bankr address. |";

const SOUL_NEW_LINE_1 = "| launch a token, deploy a token, create a token, mint a token | **Token launches deploy on Base mainnet via `bankr launch` (CLI in bankr skill). NEVER Solana, NEVER Clanker — Bankr's general docs mention those, but this VM is configured for Base only.** Read bankr/SKILL.md for the launch flow. |";
const SOUL_NEW_LINE_2 = "| bankr, bankr wallet, bankr balance, bankr swap | Use the **bankr skill**. Check WALLET.md for your Bankr address. |";
const SOUL_NEW = `${SOUL_NEW_LINE_1}\n${SOUL_NEW_LINE_2}`;

const CAPS_OLD = "| Crypto trading, swaps, token launches | **Bankr Wallet** | bankr skill (reads BANKR_API_KEY from env) |";
const CAPS_NEW_LINE_1 = "| Crypto trading, swaps, transfers, fee claims (EVM) | **Bankr Wallet** | bankr skill (reads BANKR_API_KEY from env) |";
const CAPS_NEW_LINE_2 = "| Token launches (Base mainnet only) | **Bankr Wallet** | `bankr launch` CLI via bankr skill — never Solana, never Clanker |";
const CAPS_NEW = `${CAPS_NEW_LINE_1}\n${CAPS_NEW_LINE_2}`;

const SOUL_V67_MARKER = "Token launches deploy on Base mainnet";
const CAPS_V67_MARKER = "Token launches (Base mainnet only)";

// ── Python patch script (run on remote) ──────────────────────────────────
// Reads files, idempotent str.replace, atomic write via tmp+rename.
// Reads inputs from JSON on stdin so there's zero shell-escaping in transit.
const PATCH_PY = `import json, os, sys

cfg = json.loads(sys.stdin.read())

def patch(path, old, new, marker):
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        return "missing"
    with open(path, "r") as f:
        content = f.read()
    if marker in content:
        return "already-patched"
    if old not in content:
        return "old-not-found"
    new_content = content.replace(old, new, 1)
    tmp = path + ".v67patch.tmp"
    with open(tmp, "w") as f:
        f.write(new_content)
    os.rename(tmp, path)
    with open(path, "r") as f:
        check = f.read()
    if marker not in check:
        return "verify-failed"
    return "patched"

soul = patch(cfg["soul_path"], cfg["soul_old"], cfg["soul_new"], cfg["soul_marker"])
caps = patch(cfg["caps_path"], cfg["caps_old"], cfg["caps_new"], cfg["caps_marker"])
print(f"SOUL:{soul}")
print(f"CAPS:{caps}")
`;

interface VMRow {
  id: string;
  name: string | null;
  ip_address: string;
  ssh_port: number | null;
  ssh_user: string | null;
  config_version: number | null;
}

interface PatchResult {
  vm: VMRow;
  soul: string;
  caps: string;
  ok: boolean;
  err?: string;
  durMs: number;
}

async function patchOne(vm: VMRow): Promise<PatchResult> {
  const t0 = Date.now();
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port || 22,
      username: vm.ssh_user || "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 12_000,
    });

    const cfg = JSON.stringify({
      soul_path: "~/.openclaw/workspace/SOUL.md",
      caps_path: "~/.openclaw/workspace/CAPABILITIES.md",
      soul_old: SOUL_OLD,
      soul_new: SOUL_NEW,
      caps_old: CAPS_OLD,
      caps_new: CAPS_NEW,
      soul_marker: SOUL_V67_MARKER,
      caps_marker: CAPS_V67_MARKER,
    });
    // base64-encode the python script + base64-encode the json config so
    // neither shell-quoting nor newlines can corrupt them in transit.
    const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
    const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
    const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

    const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
    const durMs = Date.now() - t0;

    if (r.code !== 0) {
      return { vm, soul: "?", caps: "?", ok: false, err: `python rc=${r.code} ${(r.stderr || r.stdout).slice(0, 200)}`, durMs };
    }
    const lines: Record<string, string> = {};
    for (const ln of r.stdout.split("\n")) {
      const idx = ln.indexOf(":");
      if (idx > 0) lines[ln.slice(0, idx)] = ln.slice(idx + 1).trim();
    }
    const soul = lines.SOUL ?? "no-output";
    const caps = lines.CAPS ?? "no-output";
    const okStates = new Set(["patched", "already-patched"]);
    const ok = okStates.has(soul) && okStates.has(caps);
    return { vm, soul, caps, ok, durMs, err: ok ? undefined : `bad state` };
  } catch (err) {
    return { vm, soul: "?", caps: "?", ok: false, err: (err instanceof Error ? err.message : String(err)).slice(0, 200), durMs: Date.now() - t0 };
  } finally {
    try { ssh.dispose(); } catch { /* noop */ }
  }
}

(async () => {
  console.log("═".repeat(80));
  console.log(`FLEET PATCH v67 — SOUL.md + CAPABILITIES.md routing/wallet rows`);
  console.log("═".repeat(80));
  console.log(`mode:        ${isExecute ? "EXECUTE" : "DRY-RUN"}`);
  console.log(`concurrency: ${concurrency}`);
  console.log(`manifest:    v${VM_MANIFEST.version}`);
  console.log("");

  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, config_version")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (error) { console.error(error); process.exit(1); }

  let pool = (vms ?? []) as VMRow[];
  if (maxCount !== Infinity) pool = pool.slice(0, maxCount);
  console.log(`candidates: ${pool.length} VMs (assigned + healthy + linode)`);
  console.log("");

  if (!isExecute) {
    console.log("DRY-RUN. Re-run with --execute to apply.");
    process.exit(0);
  }

  const totalStart = Date.now();
  let next = 0;
  let done = 0;
  const results: PatchResult[] = [];

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= pool.length) return;
      const vm = pool[i];
      const r = await patchOne(vm);
      results.push(r);
      done++;
      const tag = r.ok ? "✓" : "✗";
      const detail = r.ok ? `SOUL:${r.soul} CAPS:${r.caps}` : `SOUL:${r.soul} CAPS:${r.caps} err=${r.err}`;
      console.log(`  ${tag} [${done.toString().padStart(3)}/${pool.length}] ${(vm.name ?? vm.id).padEnd(20)} ${vm.ip_address.padEnd(16)} (${Math.round(r.durMs / 1000)}s)  ${detail}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Bump config_version to manifest.version on successful VMs whose current
  // value is below manifest.version. (skip already-at or above to avoid no-op
  // updates / accidental downgrades.)
  const successIds = results.filter(r => r.ok && (r.vm.config_version ?? 0) < VM_MANIFEST.version).map(r => r.vm.id);
  let bumped = 0;
  if (successIds.length > 0) {
    const { error: updateErr, count } = await supabase
      .from("instaclaw_vms")
      .update({ config_version: VM_MANIFEST.version }, { count: "exact" })
      .in("id", successIds)
      .lt("config_version", VM_MANIFEST.version);
    if (updateErr) console.error(`config_version bump failed: ${updateErr.message}`);
    else bumped = count ?? 0;
  }

  // Summary
  const totalSec = Math.round((Date.now() - totalStart) / 1000);
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  const counts: Record<string, number> = {};
  for (const r of results) {
    const k = `SOUL=${r.soul} CAPS=${r.caps}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  console.log("");
  console.log("═".repeat(80));
  console.log(`DONE in ${totalSec}s — ok=${ok} fail=${fail} bumped=${bumped}/${ok}`);
  console.log("breakdown:");
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${v.toString().padStart(4)}  ${k}`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ${r.vm.name ?? r.vm.id}  ${r.vm.ip_address}  SOUL=${r.soul} CAPS=${r.caps}  err=${r.err ?? ""}`);
    }
  }
  console.log("═".repeat(80));
  process.exit(fail > 0 ? 2 : 0);
})();
