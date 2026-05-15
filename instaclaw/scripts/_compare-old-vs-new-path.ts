/**
 * _compare-old-vs-new-path.ts — SSH-based byte-comparison of two live VMs.
 *
 * Plan §14 deliverable. Phase 1A Day 13 (this PR). Phase 1B-2 runtime tool.
 *
 * Compares a cloud-init-provisioned VM against an SSH-configure-provisioned
 * VM and reports byte-divergences classified as:
 *   - EXPECTED  per-user content that should differ (e.g., MEMORY.md)
 *   - WARNING   acceptable variance (skill-pull commit SHA within 2 of each other)
 *   - BUG       should be byte-identical (Rule 23 sentinels, manifest files, scripts)
 *
 * Exit code: 0 if BUGS=0, 1 otherwise. Cooper personally reviews the
 * EXPECTED/WARNING lists; ANY BUG is a Phase 1A patch + re-run of 1B-1+1B-2.
 *
 * Usage:
 *   npx tsx scripts/_compare-old-vs-new-path.ts \
 *     --new <new-vm-name> \
 *     --old <old-vm-name> \
 *     [--report path/to/output.md]
 *
 * Loads .env.local + .env.ssh-key per CLAUDE.md Rule 18. Read-only SSH
 * operations on both VMs. No production-state changes.
 *
 * ── Section scope for Day 13 ──
 * A, B           — JSON-aware + line-aware diffs with per-key whitelists  (full)
 * C, D           — workspace + agent-dir, byte-match files only           (focused)
 *                  (SOUL.md partial-match defers to a follow-up)
 * E, F, H, I, J, K — pure byte-match via md5sum                            (full)
 * G              — skill SKILL.md byte-match + git-clone SHA proximity    (focused)
 * L              — service is-active + /health probe                      (focused)
 *                  (5-prompt chat-completion behavior comparison deferred)
 *
 * Deferred sections are clearly marked with `// DEFERRED:` so future PRs
 * can extend without reverse-engineering the contract.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

// ── Env loading (CLAUDE.md Rule 18) ──
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// §1. Types
// ════════════════════════════════════════════════════════════════════════

type Classification = "expected" | "warning" | "bug";

interface Divergence {
  artifact: string;
  classification: Classification;
  reason: string;
  newDetail?: string;
  oldDetail?: string;
}

interface SectionResult {
  letter: string;          // "A" .. "L"
  name: string;
  comparedCount: number;
  byteMatchCount: number;
  divergences: Divergence[];
}

interface VmContext {
  name: string;
  row: VmRow;
  ssh: NodeSSH;
}

interface VmRow {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number | null;
  ssh_user: string | null;
  status: string;
  health_status: string | null;
  tier: string | null;
  partner: string | null;
  created_via: string | null;
}

// ════════════════════════════════════════════════════════════════════════
// §2. CLI args
// ════════════════════════════════════════════════════════════════════════

interface Args {
  newVm: string;
  oldVm: string;
  reportPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args = { newVm: "", oldVm: "", reportPath: null as string | null };
  for (const a of argv) {
    if (a.startsWith("--new=")) args.newVm = a.slice(6);
    else if (a.startsWith("--old=")) args.oldVm = a.slice(6);
    else if (a.startsWith("--report=")) args.reportPath = a.slice(9);
  }
  if (!args.newVm || !args.oldVm) {
    console.error(
      "usage: npx tsx scripts/_compare-old-vs-new-path.ts --new=<vm-name> --old=<vm-name> [--report=<path>]",
    );
    process.exit(2);
  }
  return args;
}

// ════════════════════════════════════════════════════════════════════════
// §3. VM loader (Supabase + SSH)
// ════════════════════════════════════════════════════════════════════════

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64!;

async function loadVm(name: string): Promise<VmContext> {
  const { data: row, error } = await sb
    .from("instaclaw_vms")
    .select("id,name,ip_address,ssh_port,ssh_user,status,health_status,tier,partner,created_via")
    .eq("name", name)
    .single();
  if (error || !row) {
    console.error(`FATAL: VM "${name}" lookup failed: ${error?.message ?? "no row"}`);
    process.exit(2);
  }
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: row.ip_address,
      port: row.ssh_port ?? 22,
      username: row.ssh_user ?? "openclaw",
      privateKey: Buffer.from(SSH_KEY_B64, "base64").toString("utf-8"),
      readyTimeout: 10_000,
    });
  } catch (e) {
    console.error(`FATAL: SSH connect to "${name}" (${row.ip_address}) failed: ${(e as Error).message}`);
    process.exit(2);
  }
  return { name, row: row as VmRow, ssh };
}

// ════════════════════════════════════════════════════════════════════════
// §4. SSH helper utilities
// ════════════════════════════════════════════════════════════════════════

/** Read a file's contents via cat. Returns null when file is absent. */
async function sshReadFile(ssh: NodeSSH, path: string): Promise<string | null> {
  const r = await ssh.execCommand(`test -f ${path} && cat ${path} || echo __ABSENT__`);
  const s = r.stdout;
  if (s === "__ABSENT__" || s.endsWith("__ABSENT__")) return null;
  return s;
}

/** md5sum a file via shell. Returns null when file is absent. */
async function sshMd5(ssh: NodeSSH, path: string): Promise<string | null> {
  const r = await ssh.execCommand(`md5sum ${path} 2>/dev/null | awk '{print $1}'`);
  const s = r.stdout.trim();
  return s.length === 32 ? s : null;
}

/** Test whether a path exists (file or dir). */
async function sshExists(ssh: NodeSSH, path: string): Promise<boolean> {
  const r = await ssh.execCommand(`test -e ${path} && echo Y || echo N`);
  return r.stdout.trim() === "Y";
}

/** Run an arbitrary command, return stdout (trimmed). */
async function sshExec(ssh: NodeSSH, cmd: string): Promise<string> {
  const r = await ssh.execCommand(cmd);
  return r.stdout.trim();
}

// ════════════════════════════════════════════════════════════════════════
// §5. Diff helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Recursively compare two JSON objects ignoring whitelisted keys. Returns
 * a list of human-readable path strings where the values differ.
 */
function jsonDiffIgnoring(
  newObj: unknown,
  oldObj: unknown,
  whitelist: Set<string>,
  pathPrefix = "",
): string[] {
  const diffs: string[] = [];
  if (typeof newObj !== typeof oldObj) {
    return [`${pathPrefix || "(root)"}: type ${typeof newObj} vs ${typeof oldObj}`];
  }
  if (newObj === null || oldObj === null || typeof newObj !== "object") {
    if (newObj !== oldObj) {
      diffs.push(`${pathPrefix || "(root)"}: ${JSON.stringify(newObj)} vs ${JSON.stringify(oldObj)}`);
    }
    return diffs;
  }
  const newKeys = new Set(Object.keys(newObj as object));
  const oldKeys = new Set(Object.keys(oldObj as object));
  const allKeys = new Set([...newKeys, ...oldKeys]);
  for (const k of allKeys) {
    const subPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (whitelist.has(subPath) || whitelist.has(k)) continue;
    if (!newKeys.has(k)) {
      diffs.push(`${subPath}: MISSING on new, present on old`);
      continue;
    }
    if (!oldKeys.has(k)) {
      diffs.push(`${subPath}: present on new, MISSING on old`);
      continue;
    }
    diffs.push(
      ...jsonDiffIgnoring(
        (newObj as Record<string, unknown>)[k],
        (oldObj as Record<string, unknown>)[k],
        whitelist,
        subPath,
      ),
    );
  }
  return diffs;
}

/**
 * Line-aware diff for .env files: parse each as a map of KEY → value, then
 * compare keys + values, ignoring whitelisted KEY names.
 */
function envDiffIgnoring(newBody: string, oldBody: string, whitelist: Set<string>): string[] {
  const parse = (b: string): Record<string, string> => {
    const r: Record<string, string> = {};
    for (const line of b.split("\n")) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) r[m[1]] = m[2];
    }
    return r;
  };
  const newEnv = parse(newBody);
  const oldEnv = parse(oldBody);
  const allKeys = new Set([...Object.keys(newEnv), ...Object.keys(oldEnv)]);
  const diffs: string[] = [];
  for (const k of allKeys) {
    if (whitelist.has(k)) continue;
    if (!(k in newEnv)) {
      diffs.push(`${k}: MISSING on new, present on old`);
      continue;
    }
    if (!(k in oldEnv)) {
      diffs.push(`${k}: present on new, MISSING on old`);
      continue;
    }
    if (newEnv[k] !== oldEnv[k]) {
      diffs.push(`${k}: "${newEnv[k]}" vs "${oldEnv[k]}"`);
    }
  }
  return diffs;
}

/** Md5-based byte-match for a list of paths. Each path → a Divergence row or no entry. */
async function compareByMd5(
  newCtx: VmContext,
  oldCtx: VmContext,
  paths: string[],
): Promise<{ matchCount: number; divergences: Divergence[] }> {
  let matchCount = 0;
  const divergences: Divergence[] = [];
  for (const p of paths) {
    const [newHash, oldHash] = await Promise.all([
      sshMd5(newCtx.ssh, p),
      sshMd5(oldCtx.ssh, p),
    ]);
    if (newHash === null && oldHash === null) {
      divergences.push({
        artifact: p,
        classification: "warning",
        reason: "absent on BOTH VMs (expected present per the manifest/snapshot)",
      });
      continue;
    }
    if (newHash === null) {
      divergences.push({
        artifact: p,
        classification: "bug",
        reason: "present on old, MISSING on new",
        oldDetail: `md5=${oldHash}`,
      });
      continue;
    }
    if (oldHash === null) {
      divergences.push({
        artifact: p,
        classification: "bug",
        reason: "present on new, MISSING on old",
        newDetail: `md5=${newHash}`,
      });
      continue;
    }
    if (newHash !== oldHash) {
      divergences.push({
        artifact: p,
        classification: "bug",
        reason: "md5 differs (should be byte-identical per snapshot/manifest contract)",
        newDetail: `md5=${newHash}`,
        oldDetail: `md5=${oldHash}`,
      });
      continue;
    }
    matchCount++;
  }
  return { matchCount, divergences };
}

// ════════════════════════════════════════════════════════════════════════
// §6. Section runners (A through L)
// ════════════════════════════════════════════════════════════════════════

// ── A: Configuration files (JSON-aware diff with whitelists) ──
async function sectionA_ConfigFiles(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const div: Divergence[] = [];
  let comparedCount = 0;
  let byteMatchCount = 0;

  // openclaw.json — per-key whitelist
  comparedCount++;
  const [newOcRaw, oldOcRaw] = await Promise.all([
    sshReadFile(newCtx.ssh, "~/.openclaw/openclaw.json"),
    sshReadFile(oldCtx.ssh, "~/.openclaw/openclaw.json"),
  ]);
  if (!newOcRaw || !oldOcRaw) {
    div.push({
      artifact: "~/.openclaw/openclaw.json",
      classification: "bug",
      reason: `missing on ${!newOcRaw ? "new" : "old"}`,
    });
  } else {
    try {
      const newOc = JSON.parse(newOcRaw);
      const oldOc = JSON.parse(oldOcRaw);
      const whitelist = new Set([
        "gateway.auth.token",
        "channels.telegram.botToken",
        "channels.discord.botToken",
        // wizard.lastRunAt: timestamp differs naturally per-VM
        "wizard.lastRunAt",
      ]);
      const diffs = jsonDiffIgnoring(newOc, oldOc, whitelist);
      if (diffs.length === 0) {
        byteMatchCount++;
      } else {
        for (const d of diffs) {
          div.push({
            artifact: `~/.openclaw/openclaw.json :: ${d}`,
            classification: "bug",
            reason: "JSON value differs (non-whitelisted key)",
          });
        }
      }
    } catch (e) {
      div.push({
        artifact: "~/.openclaw/openclaw.json",
        classification: "bug",
        reason: `JSON parse failed: ${(e as Error).message}`,
      });
    }
  }

  // auth-profiles.json — per-key whitelist
  comparedCount++;
  const [newApRaw, oldApRaw] = await Promise.all([
    sshReadFile(newCtx.ssh, "~/.openclaw/agents/main/agent/auth-profiles.json"),
    sshReadFile(oldCtx.ssh, "~/.openclaw/agents/main/agent/auth-profiles.json"),
  ]);
  if (!newApRaw || !oldApRaw) {
    div.push({
      artifact: "~/.openclaw/agents/main/agent/auth-profiles.json",
      classification: "bug",
      reason: `missing on ${!newApRaw ? "new" : "old"}`,
    });
  } else {
    try {
      const newAp = JSON.parse(newApRaw);
      const oldAp = JSON.parse(oldApRaw);
      const whitelist = new Set([
        "profiles.anthropic:default.key",
        "profiles.openai:default.key",
      ]);
      const diffs = jsonDiffIgnoring(newAp, oldAp, whitelist);
      if (diffs.length === 0) byteMatchCount++;
      else for (const d of diffs) div.push({
        artifact: `auth-profiles.json :: ${d}`,
        classification: "bug",
        reason: "non-whitelisted key differs",
      });
    } catch (e) {
      div.push({ artifact: "auth-profiles.json", classification: "bug", reason: `parse: ${(e as Error).message}` });
    }
  }

  // exec-approvals.json — exact byte-match
  comparedCount++;
  const r1 = await compareByMd5(newCtx, oldCtx, ["~/.openclaw/exec-approvals.json"]);
  byteMatchCount += r1.matchCount;
  div.push(...r1.divergences);

  // .openclaw-pinned-version — exact byte-match
  comparedCount++;
  const r2 = await compareByMd5(newCtx, oldCtx, ["~/.openclaw/.openclaw-pinned-version"]);
  byteMatchCount += r2.matchCount;
  div.push(...r2.divergences);

  return { letter: "A", name: "Configuration files (JSON whitelist)", comparedCount, byteMatchCount, divergences: div };
}

// ── B: .env file with per-key whitelist ──
async function sectionB_EnvFile(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const div: Divergence[] = [];
  let comparedCount = 1;
  let byteMatchCount = 0;

  const [newEnv, oldEnv] = await Promise.all([
    sshReadFile(newCtx.ssh, "~/.openclaw/.env"),
    sshReadFile(oldCtx.ssh, "~/.openclaw/.env"),
  ]);
  if (!newEnv || !oldEnv) {
    div.push({
      artifact: "~/.openclaw/.env",
      classification: "bug",
      reason: `missing on ${!newEnv ? "new" : "old"}`,
    });
  } else {
    const whitelist = new Set([
      "GATEWAY_TOKEN",
      "BANKR_API_KEY",
      "BANKR_WALLET_ADDRESS",
      "BANKR_TOKEN_ADDRESS",
      "BANKR_TOKEN_SYMBOL",
      "WORLD_ID_NULLIFIER",
      "WORLD_ID_LEVEL",
      "AGENT_REGION",
      "INSTACLAW_USER_ID",
      "INSTACLAW_VM_NAME",
      "TELEGRAM_BOT_TOKEN",
      "AGENTBOOK_ADDRESS",
      "USER_TIMEZONE",
    ]);
    const diffs = envDiffIgnoring(newEnv, oldEnv, whitelist);
    if (diffs.length === 0) byteMatchCount++;
    else for (const d of diffs) div.push({
      artifact: `~/.openclaw/.env :: ${d}`,
      classification: "bug",
      reason: "non-whitelisted env var differs",
    });
  }
  return { letter: "B", name: ".env (with per-VM whitelist)", comparedCount, byteMatchCount, divergences: div };
}

// ── C: Workspace files (byte-match files only — Day 13 focused scope) ──
async function sectionC_Workspace(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  // Per plan §14.2 C: byte-match expected for CAPABILITIES.md, QUICK-REFERENCE.md,
  // TOOLS.md, EARN.md, AGENTS.md (V2 only). Per-user EXPECTED divergence
  // for MEMORY.md, USER.md, IDENTITY.md, WALLET.md, WORLD_ID.md, BOOTSTRAP.md,
  // memory/*.md. SOUL.md is partial (base byte-match, partner stubs match
  // if same partner) — DEFERRED for Day 13.
  const byteMatchFiles = [
    "~/.openclaw/workspace/CAPABILITIES.md",
    "~/.openclaw/workspace/QUICK-REFERENCE.md",
    "~/.openclaw/workspace/TOOLS.md",
    "~/.openclaw/workspace/EARN.md",
    "~/.openclaw/workspace/AGENTS.md",
  ];
  const r = await compareByMd5(newCtx, oldCtx, byteMatchFiles);
  const div: Divergence[] = [...r.divergences];

  // DEFERRED: SOUL.md partial-match logic (base byte-match, partner stubs).
  // Add a single warning row to surface the deferral in the report rather
  // than silently skip — a future PR replaces this with the real diff.
  div.push({
    artifact: "~/.openclaw/workspace/SOUL.md",
    classification: "warning",
    reason: "DEFERRED — partial-match logic (base byte-match + partner stub match if same partner) not yet implemented in compare script. Operator should manually `diff` until the follow-up PR lands.",
  });

  // Per-user EXPECTED divergences (informational; not compared)
  for (const f of [
    "~/.openclaw/workspace/MEMORY.md",
    "~/.openclaw/workspace/USER.md",
    "~/.openclaw/workspace/IDENTITY.md",
    "~/.openclaw/workspace/WALLET.md",
    "~/.openclaw/workspace/WORLD_ID.md",
    "~/.openclaw/workspace/BOOTSTRAP.md",
    "~/.openclaw/workspace/memory/session-log.md",
    "~/.openclaw/workspace/memory/active-tasks.md",
  ]) {
    const [a, b] = await Promise.all([sshExists(newCtx.ssh, f), sshExists(oldCtx.ssh, f)]);
    div.push({
      artifact: f,
      classification: "expected",
      reason: a && b ? "per-user content (presence on both ✓; content divergence ignored)"
            : !a && !b ? "absent on both (per-user content; no divergence)"
            : `present on ${a ? "new only" : "old only"} (acceptable per-user variance)`,
    });
  }

  return {
    letter: "C",
    name: "Workspace files",
    comparedCount: byteMatchFiles.length + 1 /* SOUL.md note */ + 8 /* per-user */,
    byteMatchCount: r.matchCount,
    divergences: div,
  };
}

// ── D: Agent dir — byte-match HEARTBEAT.md only (Day 13 focused scope) ──
async function sectionD_AgentDir(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  // system-prompt.md and MEMORY.md (agent-dir mirror) are per-user EXPECTED.
  // HEARTBEAT.md should be byte-match (snapshot-delivered identical).
  const r = await compareByMd5(newCtx, oldCtx, ["~/.openclaw/agents/main/agent/HEARTBEAT.md"]);
  const div: Divergence[] = [...r.divergences];

  for (const f of [
    "~/.openclaw/agents/main/agent/system-prompt.md",
    "~/.openclaw/agents/main/agent/MEMORY.md",
  ]) {
    const [a, b] = await Promise.all([sshExists(newCtx.ssh, f), sshExists(oldCtx.ssh, f)]);
    div.push({
      artifact: f,
      classification: "expected",
      reason: a && b ? "per-user content (presence on both ✓)" : `presence on new=${a} old=${b}`,
    });
  }
  return { letter: "D", name: "Agent dir", comparedCount: 3, byteMatchCount: r.matchCount, divergences: div };
}

// ── E: ~/.openclaw/scripts/ — byte-match per plan §14.2 ──
async function sectionE_OpenclawScripts(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  // Per plan: 9 scripts in this section, plus 5 matchpool + 2 intent if both
  // VMs are matchpool-enrolled (we conservatively check presence-on-both
  // and only diff when both exist).
  const universalScripts = [
    "~/.openclaw/scripts/strip-thinking.py",
    "~/.openclaw/scripts/vm-watchdog.py",
    "~/.openclaw/scripts/silence-watchdog.py",
    "~/.openclaw/scripts/auto-approve-pairing.py",
    "~/.openclaw/scripts/push-heartbeat.sh",
    "~/.openclaw/scripts/skill-integrity-check.sh",
    "~/.openclaw/scripts/ack-watchdog.py",
    "~/.openclaw/scripts/memory-snapshot.sh",
    "~/.openclaw/scripts/generate_workspace_index.sh",
  ];
  const optionalScripts = [
    "~/.openclaw/scripts/consensus_match_pipeline.py",
    "~/.openclaw/scripts/consensus_match_rerank.py",
    "~/.openclaw/scripts/consensus_match_deliberate.py",
    "~/.openclaw/scripts/consensus_match_consent.py",
    "~/.openclaw/scripts/consensus_match_skill_toggle.py",
    "~/.openclaw/scripts/consensus_intent_sync.py",
    "~/.openclaw/scripts/consensus_intent_extract.py",
    "~/.openclaw/scripts/privacy-bridge.sh",
  ];

  const div: Divergence[] = [];
  let byteMatchCount = 0;

  const r1 = await compareByMd5(newCtx, oldCtx, universalScripts);
  byteMatchCount += r1.matchCount;
  div.push(...r1.divergences);

  // For optional scripts: only count as bug if present on one VM but not
  // the other (presence asymmetry is the regression signal).
  for (const p of optionalScripts) {
    const [a, b] = await Promise.all([sshExists(newCtx.ssh, p), sshExists(oldCtx.ssh, p)]);
    if (a && b) {
      const [h1, h2] = await Promise.all([sshMd5(newCtx.ssh, p), sshMd5(oldCtx.ssh, p)]);
      if (h1 === h2) byteMatchCount++;
      else div.push({
        artifact: p,
        classification: "bug",
        reason: "present on both, md5 differs",
        newDetail: `md5=${h1}`,
        oldDetail: `md5=${h2}`,
      });
    } else if (a !== b) {
      div.push({
        artifact: p,
        classification: "bug",
        reason: `presence asymmetry: new=${a} old=${b}`,
      });
    }
    // Absent on both: silently skip (optional, not required).
  }

  return {
    letter: "E",
    name: "~/.openclaw/scripts/",
    comparedCount: universalScripts.length + optionalScripts.length,
    byteMatchCount,
    divergences: div,
  };
}

// ── F: ~/scripts/ — byte-match per plan §14.2 ──
async function sectionF_OuterScripts(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  // Per plan: a list of outer scripts that should byte-match. We include
  // the small canonical set (deliver_file, notify_user, browser-relay-server,
  // check-skill-updates) explicitly; for the larger DISPATCH_SCRIPTS set
  // and skill assets we fall back to `find ~/scripts -type f | xargs md5sum`
  // and compare the full filename→md5 map (any missing-on-one or md5-diff
  // is a Divergence).
  const div: Divergence[] = [];
  const explicit = [
    "~/scripts/deliver_file.sh",
    "~/scripts/notify_user.sh",
    "~/scripts/browser-relay-server.js",
    "~/scripts/check-skill-updates.sh",
    "~/scripts/package.json",
  ];
  const r = await compareByMd5(newCtx, oldCtx, explicit);
  let byteMatchCount = r.matchCount;
  div.push(...r.divergences);

  // Full directory walk for the rest. Build {path → md5} maps on both VMs
  // and diff. Limit depth to avoid pulling in node_modules subtrees.
  const buildMap = async (ssh: NodeSSH): Promise<Record<string, string>> => {
    const out = await sshExec(
      ssh,
      `find ~/scripts -maxdepth 3 -type f -name '*.sh' -o -name '*.js' -o -name '*.py' 2>/dev/null | head -200 | xargs md5sum 2>/dev/null`,
    );
    const m: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const mm = line.trim().match(/^([a-f0-9]{32})\s+(.+)$/);
      if (mm) m[mm[2]] = mm[1];
    }
    return m;
  };
  const [newMap, oldMap] = await Promise.all([buildMap(newCtx.ssh), buildMap(oldCtx.ssh)]);
  const allPaths = new Set([...Object.keys(newMap), ...Object.keys(oldMap)]);
  let walkComparedCount = 0;
  for (const p of allPaths) {
    // Skip ones already covered by `explicit`
    if (explicit.some((e) => e.replace("~/", "/home/openclaw/") === p)) continue;
    walkComparedCount++;
    if (!(p in newMap)) {
      div.push({ artifact: p, classification: "bug", reason: "present on old, absent on new" });
      continue;
    }
    if (!(p in oldMap)) {
      div.push({ artifact: p, classification: "bug", reason: "present on new, absent on old" });
      continue;
    }
    if (newMap[p] !== oldMap[p]) {
      div.push({
        artifact: p,
        classification: "bug",
        reason: "md5 differs",
        newDetail: `md5=${newMap[p]}`,
        oldDetail: `md5=${oldMap[p]}`,
      });
      continue;
    }
    byteMatchCount++;
  }
  return {
    letter: "F",
    name: "~/scripts/ (outer scripts)",
    comparedCount: explicit.length + walkComparedCount,
    byteMatchCount,
    divergences: div,
  };
}

// ── G: Skill directories (SKILL.md byte-match + git SHA proximity) ──
async function sectionG_Skills(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  // Per plan: 18 inline skills + 3 manifest-only + 3 git-cloned. We walk
  // ~/.openclaw/skills/*/SKILL.md and compare. For git-cloned dirs (those
  // with a .git/), compare the HEAD commit SHA — equal = byte-match,
  // within ~2 commits of each other = WARNING, further = BUG.
  const div: Divergence[] = [];
  let byteMatchCount = 0;

  // SKILL.md walk
  const skillsList = await sshExec(newCtx.ssh, "ls ~/.openclaw/skills/ 2>/dev/null");
  const skills = skillsList.split("\n").filter((s) => s.length > 0 && !s.endsWith(".disabled"));
  let compared = 0;
  for (const s of skills) {
    const skillMdPath = `~/.openclaw/skills/${s}/SKILL.md`;
    compared++;
    const [h1, h2] = await Promise.all([sshMd5(newCtx.ssh, skillMdPath), sshMd5(oldCtx.ssh, skillMdPath)]);
    if (h1 === null && h2 === null) {
      // Both absent — multi-skill repo (e.g., bankr); SKILL.md lives at subdirs.
      div.push({
        artifact: skillMdPath,
        classification: "warning",
        reason: "absent on both (likely multi-skill repo with sub-SKILL.md files; not directly comparable)",
      });
      continue;
    }
    if (h1 === null || h2 === null) {
      div.push({
        artifact: skillMdPath,
        classification: "bug",
        reason: `presence asymmetry: new=${h1 != null} old=${h2 != null}`,
      });
      continue;
    }
    if (h1 === h2) byteMatchCount++;
    else div.push({
      artifact: skillMdPath,
      classification: "bug",
      reason: "SKILL.md md5 differs (Rule 24 + Rule 47 contract requires byte-identical)",
      newDetail: `md5=${h1}`,
      oldDetail: `md5=${h2}`,
    });
  }

  // Git-cloned commit SHA proximity (bankr, edge-esmeralda, consensus-2026)
  const gitClonedSkills = ["bankr", "edge-esmeralda", "consensus-2026"];
  for (const s of gitClonedSkills) {
    const gitHeadPath = `~/.openclaw/skills/${s}/.git/HEAD`;
    const [exists1, exists2] = await Promise.all([
      sshExists(newCtx.ssh, gitHeadPath),
      sshExists(oldCtx.ssh, gitHeadPath),
    ]);
    if (!exists1 && !exists2) continue; // skill not git-cloned on either
    compared++;
    if (!exists1 || !exists2) {
      div.push({
        artifact: `~/.openclaw/skills/${s} (.git/)`,
        classification: "bug",
        reason: `git-cloned skill presence asymmetry: new=${exists1} old=${exists2}`,
      });
      continue;
    }
    const sha1 = await sshExec(newCtx.ssh, `cd ~/.openclaw/skills/${s} && git rev-parse HEAD 2>/dev/null`);
    const sha2 = await sshExec(oldCtx.ssh, `cd ~/.openclaw/skills/${s} && git rev-parse HEAD 2>/dev/null`);
    if (sha1 === sha2) byteMatchCount++;
    else {
      // Same upstream — check if commits are within 2 of each other
      const distance = await sshExec(
        newCtx.ssh,
        `cd ~/.openclaw/skills/${s} && git rev-list --count ${sha2}..${sha1} 2>/dev/null || echo unknown`,
      );
      const d = parseInt(distance, 10);
      if (!isNaN(d) && d <= 2) {
        div.push({
          artifact: `~/.openclaw/skills/${s} (git SHA)`,
          classification: "warning",
          reason: `commits ${d} apart (within drift tolerance — auto-pull cron variance)`,
          newDetail: sha1,
          oldDetail: sha2,
        });
      } else {
        div.push({
          artifact: `~/.openclaw/skills/${s} (git SHA)`,
          classification: "bug",
          reason: "commits differ by >2 (auto-pull cron drift or stale clone)",
          newDetail: sha1,
          oldDetail: sha2,
        });
      }
    }
  }
  return { letter: "G", name: "Skill directories", comparedCount: compared, byteMatchCount, divergences: div };
}

// ── H: Crontab line-by-line ──
async function sectionH_Crontab(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const [a, b] = await Promise.all([sshExec(newCtx.ssh, "crontab -l"), sshExec(oldCtx.ssh, "crontab -l")]);
  // Order-independent set compare with line normalization (strip leading
  // whitespace + comments).
  const normalize = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const l of s.split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      out.add(t);
    }
    return out;
  };
  const setA = normalize(a);
  const setB = normalize(b);
  const div: Divergence[] = [];
  for (const line of setA) if (!setB.has(line)) div.push({ artifact: `crontab line: ${line.slice(0, 80)}`, classification: "bug", reason: "present on new, absent on old" });
  for (const line of setB) if (!setA.has(line)) div.push({ artifact: `crontab line: ${line.slice(0, 80)}`, classification: "bug", reason: "present on old, absent on new" });
  const matched = [...setA].filter((l) => setB.has(l)).length;
  return { letter: "H", name: "Crontab", comparedCount: Math.max(setA.size, setB.size), byteMatchCount: matched, divergences: div };
}

// ── I: Systemd units (byte-match) ──
async function sectionI_Systemd(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const units = [
    "~/.config/systemd/user/openclaw-gateway.service",
    "~/.config/systemd/user/openclaw-gateway.service.d/override.conf",
    "~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf",
    "~/.config/systemd/user/dispatch-server.service",
    "~/.config/systemd/user/browser-relay-server.service",
    "/etc/systemd/system/xvfb.service",
    "/etc/systemd/system/x11vnc.service",
    "/etc/systemd/system/websockify.service",
    "/etc/systemd/system/ssh.service.d/oom-protect.conf",
  ];
  const r = await compareByMd5(newCtx, oldCtx, units);
  return {
    letter: "I",
    name: "Systemd units",
    comparedCount: units.length,
    byteMatchCount: r.matchCount,
    divergences: r.divergences,
  };
}

// ── J: npm globals filtered ──
async function sectionJ_NpmGlobals(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const targets = ["openclaw", "@bankr/cli", "@worldcoin/agentkit-cli", "prctl-subreaper", "usecomputer", "mcporter"];
  const fetch = async (ssh: NodeSSH): Promise<Record<string, string>> => {
    const out = await sshExec(
      ssh,
      `bash -lc 'source ~/.nvm/nvm.sh 2>/dev/null; npm list -g --depth=0 2>/dev/null'`,
    );
    const m: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const mm = line.match(/[├└]── ([^@]+)@(.+)$/);
      if (mm) m[mm[1].trim()] = mm[2].trim();
    }
    return m;
  };
  const [newMap, oldMap] = await Promise.all([fetch(newCtx.ssh), fetch(oldCtx.ssh)]);
  const div: Divergence[] = [];
  let matched = 0;
  for (const t of targets) {
    const v1 = newMap[t];
    const v2 = oldMap[t];
    if (v1 === undefined && v2 === undefined) {
      div.push({ artifact: `npm:${t}`, classification: "warning", reason: "not installed on either VM" });
      continue;
    }
    if (v1 === undefined || v2 === undefined) {
      div.push({
        artifact: `npm:${t}`,
        classification: "bug",
        reason: `presence asymmetry: new=${v1 ?? "absent"} old=${v2 ?? "absent"}`,
      });
      continue;
    }
    if (v1 === v2) matched++;
    else div.push({
      artifact: `npm:${t}`,
      classification: "bug",
      reason: "version differs",
      newDetail: `v${v1}`,
      oldDetail: `v${v2}`,
    });
  }
  return { letter: "J", name: "npm globals", comparedCount: targets.length, byteMatchCount: matched, divergences: div };
}

// ── K: pip packages filtered ──
async function sectionK_PipPackages(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const targets = ["openai", "crawlee", "web3", "py-clob-client", "eth-account", "solders", "base58", "websockets", "cryptography"];
  const fetch = async (ssh: NodeSSH): Promise<Record<string, string>> => {
    const out = await sshExec(ssh, "pip3 list 2>/dev/null");
    const m: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const mm = line.match(/^([a-zA-Z0-9_-]+)\s+([\d.a-z+-]+)/);
      if (mm) m[mm[1].toLowerCase()] = mm[2];
    }
    return m;
  };
  const [newMap, oldMap] = await Promise.all([fetch(newCtx.ssh), fetch(oldCtx.ssh)]);
  const div: Divergence[] = [];
  let matched = 0;
  for (const t of targets) {
    const key = t.toLowerCase();
    const v1 = newMap[key];
    const v2 = oldMap[key];
    if (v1 === undefined && v2 === undefined) {
      div.push({ artifact: `pip:${t}`, classification: "warning", reason: "not installed on either VM" });
      continue;
    }
    if (v1 === undefined || v2 === undefined) {
      div.push({
        artifact: `pip:${t}`,
        classification: "bug",
        reason: `presence asymmetry: new=${v1 ?? "absent"} old=${v2 ?? "absent"}`,
      });
      continue;
    }
    if (v1 === v2) matched++;
    else {
      // Same major-version drift is a warning, not bug
      const major1 = v1.split(".")[0];
      const major2 = v2.split(".")[0];
      div.push({
        artifact: `pip:${t}`,
        classification: major1 === major2 ? "warning" : "bug",
        reason: major1 === major2 ? "same-major version drift" : "major-version mismatch",
        newDetail: v1,
        oldDetail: v2,
      });
    }
  }
  return { letter: "K", name: "Pip packages", comparedCount: targets.length, byteMatchCount: matched, divergences: div };
}

// ── L: Service health (services + /health probe; chat-completion deferred) ──
async function sectionL_ServiceHealth(newCtx: VmContext, oldCtx: VmContext): Promise<SectionResult> {
  const services = ["openclaw-gateway", "dispatch-server", "browser-relay-server"];
  const sysServices = ["xvfb", "x11vnc", "websockify"];
  const div: Divergence[] = [];
  let matched = 0;
  let comparedCount = 0;

  // User services via systemctl --user is-active
  for (const s of services) {
    comparedCount++;
    const [a, b] = await Promise.all([
      sshExec(newCtx.ssh, `systemctl --user is-active ${s} 2>&1`),
      sshExec(oldCtx.ssh, `systemctl --user is-active ${s} 2>&1`),
    ]);
    if (a === b && a === "active") matched++;
    else div.push({
      artifact: `service:${s}`,
      classification: "bug",
      reason: a === b ? `both: ${a} (expected active)` : "is-active state differs",
      newDetail: a,
      oldDetail: b,
    });
  }
  // System services via systemctl is-active
  for (const s of sysServices) {
    comparedCount++;
    const [a, b] = await Promise.all([
      sshExec(newCtx.ssh, `systemctl is-active ${s} 2>&1`),
      sshExec(oldCtx.ssh, `systemctl is-active ${s} 2>&1`),
    ]);
    if (a === b && a === "active") matched++;
    else div.push({
      artifact: `service:${s}`,
      classification: "bug",
      reason: a === b ? `both: ${a} (expected active)` : "is-active state differs",
      newDetail: a,
      oldDetail: b,
    });
  }
  // /health endpoint probe (just status code on each, not body diff —
  // body has per-VM counters/timestamps).
  comparedCount++;
  const [h1, h2] = await Promise.all([
    sshExec(newCtx.ssh, "curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health -m 5"),
    sshExec(oldCtx.ssh, "curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health -m 5"),
  ]);
  if (h1 === "200" && h2 === "200") matched++;
  else div.push({
    artifact: "/health",
    classification: "bug",
    reason: "HTTP status differs or non-200",
    newDetail: h1,
    oldDetail: h2,
  });

  // DEFERRED — 5-prompt chat-completion behavior comparison per plan §14.2-L.
  // Different methodology (involves token budgets, LLM non-determinism,
  // explicit prompt set, tool-use parse). Tracked as a Phase 1B-2-spec
  // follow-up.
  div.push({
    artifact: "chat-completions (5-prompt behavior)",
    classification: "warning",
    reason: "DEFERRED — Day 13 ships services + /health only. Chat-completion behavior diff is plan §14.2-L item 2; needs separate methodology design.",
  });

  return { letter: "L", name: "Service health (chat-completions deferred)", comparedCount, byteMatchCount: matched, divergences: div };
}

// ════════════════════════════════════════════════════════════════════════
// §7. Report generator
// ════════════════════════════════════════════════════════════════════════

function generateReport(
  newCtx: VmContext,
  oldCtx: VmContext,
  sections: SectionResult[],
): { markdown: string; bugCount: number } {
  let totalCompared = 0;
  let totalMatched = 0;
  const allBugs: Divergence[] = [];
  const allWarnings: Divergence[] = [];
  const allExpected: Divergence[] = [];
  for (const s of sections) {
    totalCompared += s.comparedCount;
    totalMatched += s.byteMatchCount;
    for (const d of s.divergences) {
      if (d.classification === "bug") allBugs.push({ ...d, artifact: `[${s.letter}] ${d.artifact}` });
      else if (d.classification === "warning") allWarnings.push({ ...d, artifact: `[${s.letter}] ${d.artifact}` });
      else allExpected.push({ ...d, artifact: `[${s.letter}] ${d.artifact}` });
    }
  }
  const tierMatch = newCtx.row.tier === oldCtx.row.tier;
  const partnerMatch = (newCtx.row.partner ?? null) === (oldCtx.row.partner ?? null);
  const lines: string[] = [];
  lines.push(`# old-vs-new-path comparison: ${newCtx.name} vs ${oldCtx.name}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Tier match: ${tierMatch ? "✓" : "✗"} (new=${newCtx.row.tier ?? "(null)"} old=${oldCtx.row.tier ?? "(null)"})`);
  lines.push(`Partner match: ${partnerMatch ? "✓" : "✗"} (new=${newCtx.row.partner ?? "(null)"} old=${oldCtx.row.partner ?? "(null)"})`);
  if (!tierMatch || !partnerMatch) {
    lines.push(``);
    lines.push(`> ⚠ Tier or partner mismatch — some divergences may be expected. Re-run against matched VMs for canonical results.`);
  }
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- Total artifacts compared: ${totalCompared}`);
  lines.push(`- Byte-match: ${totalMatched} ✓`);
  lines.push(`- Expected divergence (per-user): ${allExpected.length} ✓`);
  lines.push(`- Warnings: ${allWarnings.length}`);
  lines.push(`- BUGS: ${allBugs.length} ${allBugs.length === 0 ? "✓" : "✗"}`);
  lines.push(``);
  lines.push(allBugs.length === 0 ? `**PASS — no bugs found**` : `**FAIL — fix ${allBugs.length} bug${allBugs.length === 1 ? "" : "s"} before Phase 1C**`);
  lines.push(``);
  if (allBugs.length > 0) {
    lines.push(`## Bugs (${allBugs.length})`);
    for (let i = 0; i < allBugs.length; i++) {
      const b = allBugs[i];
      lines.push(`### BUG-${i + 1}: ${b.artifact}`);
      lines.push(`- Reason: ${b.reason}`);
      if (b.newDetail) lines.push(`- new: ${b.newDetail}`);
      if (b.oldDetail) lines.push(`- old: ${b.oldDetail}`);
      lines.push(``);
    }
  }
  if (allWarnings.length > 0) {
    lines.push(`## Warnings (${allWarnings.length})`);
    for (const w of allWarnings) {
      lines.push(`- ${w.artifact}: ${w.reason}` + (w.newDetail ? ` (new: ${w.newDetail})` : "") + (w.oldDetail ? ` (old: ${w.oldDetail})` : ""));
    }
    lines.push(``);
  }
  // Per-section detail
  for (const s of sections) {
    lines.push(`## Section ${s.letter}: ${s.name}`);
    lines.push(`- Compared: ${s.comparedCount}, byte-match: ${s.byteMatchCount}`);
    if (s.divergences.length > 0) {
      lines.push(``);
      for (const d of s.divergences) {
        const tag = d.classification === "bug" ? "✗ BUG" : d.classification === "warning" ? "⚠ WARN" : "✓ EXPECTED";
        lines.push(`  - ${tag} ${d.artifact} — ${d.reason}`);
      }
    }
    lines.push(``);
  }
  if (allExpected.length > 0) {
    lines.push(`## Expected per-user divergences (${allExpected.length})`);
    for (const e of allExpected) {
      lines.push(`- ${e.artifact}: ${e.reason}`);
    }
    lines.push(``);
  }
  return { markdown: lines.join("\n"), bugCount: allBugs.length };
}

// ════════════════════════════════════════════════════════════════════════
// §8. main()
// ════════════════════════════════════════════════════════════════════════

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Loading VMs: new=${args.newVm} old=${args.oldVm}`);
  const [newCtx, oldCtx] = await Promise.all([loadVm(args.newVm), loadVm(args.oldVm)]);
  try {
    console.log("Running sections A-L...");
    const sections: SectionResult[] = [];
    sections.push(await sectionA_ConfigFiles(newCtx, oldCtx));
    sections.push(await sectionB_EnvFile(newCtx, oldCtx));
    sections.push(await sectionC_Workspace(newCtx, oldCtx));
    sections.push(await sectionD_AgentDir(newCtx, oldCtx));
    sections.push(await sectionE_OpenclawScripts(newCtx, oldCtx));
    sections.push(await sectionF_OuterScripts(newCtx, oldCtx));
    sections.push(await sectionG_Skills(newCtx, oldCtx));
    sections.push(await sectionH_Crontab(newCtx, oldCtx));
    sections.push(await sectionI_Systemd(newCtx, oldCtx));
    sections.push(await sectionJ_NpmGlobals(newCtx, oldCtx));
    sections.push(await sectionK_PipPackages(newCtx, oldCtx));
    sections.push(await sectionL_ServiceHealth(newCtx, oldCtx));
    const { markdown, bugCount } = generateReport(newCtx, oldCtx, sections);
    if (args.reportPath) {
      writeFileSync(args.reportPath, markdown, "utf-8");
      console.log(`Report written to ${args.reportPath}`);
    } else {
      console.log("\n" + markdown);
    }
    return bugCount === 0 ? 0 : 1;
  } finally {
    newCtx.ssh.dispose();
    oldCtx.ssh.dispose();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(2);
  });
