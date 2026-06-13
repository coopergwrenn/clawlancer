/**
 * Structural-invariants check — pre-deploy guardrail (wired into `npm run build`).
 *
 * Encodes two invariants whose violation has each caused a production incident,
 * and which no other check catches. ONE scan would have surfaced all three of
 * the 2026-06-13 cross-cutting findings.
 *
 * ── INVARIANT 1: no orphaned cleanup ─────────────────────────────────────────
 * An exported resource-cleanup function (named delete… / cleanup… / remove… /
 * prune… / purge… / teardown… / destroy…) with ZERO callers in app/+lib is
 * suspect: either a
 * per-VM resource is leaking because nothing cleans it on retire (the
 * 2026-06-13 DNS zone-cap bug — `deleteVMDNSRecord` existed but had zero
 * callers, so the GoDaddy zone filled to its 500 cap and blocked ALL
 * provisioning), or it's dead duplicate code. Either way a human must look.
 *
 * ── INVARIANT 2: no unbounded read behind absence-based destruction ──────────
 * `instaclaw_vms` is past the 1000-row PostgREST cap, so a bare unbounded
 * `.select()` silently truncates. A file that (a) reads instaclaw_vms
 * unbounded, (b) builds a membership Set/Map, and (c) performs a destructive op
 * MUST use `fetchAllOrThrow` (count-asserted, fail-closed) — otherwise it can
 * destroy a VM that's merely absent from a truncated page. This is exactly the
 * 2026-06-10 orphan-reaper that deleted 13 paying VMs.
 *
 * Violations that a reviewer has checked and deemed safe live in
 * scripts/structural-invariants-allowlist.json with a written reason. A NEW
 * violation fails the build until it's fixed OR explicitly allowlisted — so the
 * next person who writes a zero-caller cleanup or a bare unbounded reaper read
 * cannot ship it silently.
 *
 * Pure-source: no network, no env. Usage: npx tsx scripts/_check-structural-invariants.ts
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export type FileEntry = { path: string; content: string };
export type Violation = {
  scan: "zero-caller-cleanup" | "unbounded-destructive-read";
  key: string;
  detail: string;
};
export type Allowlist = {
  zeroCallerCleanup: { name: string; reason: string }[];
  unboundedDestructiveRead: { path: string; reason: string }[];
};

const CLEANUP_DEF_RX =
  /export\s+(?:async\s+)?function\s+((?:delete|cleanup|remove|prune|purge|teardown|destroy)[A-Z][A-Za-z0-9_]*)\s*[(<]/g;
const CLEANUP_CONST_RX =
  /export\s+const\s+((?:delete|cleanup|remove|prune|purge|teardown|destroy)[A-Z][A-Za-z0-9_]*)\s*[:=]/g;

const ROW_LIMITERS = [".single(", ".maybeSingle(", ".limit(", ".range(", "count:", "head: true"];
const DESTRUCTIVE_RX =
  /deleteLinodeInstance\(|\.deleteServer\(|deleteInstance\(|status:\s*["'](?:terminated|frozen|destroyed)["']|health_status:\s*["'](?:suspended|frozen)["']/;
const MEMBERSHIP_RX = /new Set\(|new Map\(|\.has\(/;

/** Does this file contain at least one UNBOUNDED instaclaw_vms read? (a
 * `.from("instaclaw_vms").select(` whose statement window has no row-limiter
 * and is not an update/insert/upsert/delete write). */
function hasUnboundedVmRead(content: string): boolean {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('.from("instaclaw_vms")')) continue;
    let win = lines.slice(i, Math.min(i + 14, lines.length)).join("\n");
    const semi = win.indexOf(";");
    if (semi > 0) win = win.slice(0, semi + 1);
    if (!win.includes(".select(")) continue;
    if (/\.update\(|\.delete\(|\.upsert\(|\.insert\(/.test(win)) continue; // a write, not a read
    if (ROW_LIMITERS.some((t) => win.includes(t))) continue; // bounded
    // bounded by a unique-key filter?
    if (/\.eq\("(?:id|provider_server_id|gateway_token|stripe_customer_id)",/.test(win)) continue;
    return true; // an unbounded read
  }
  return false;
}

/** Pure core — scan a set of files for both invariants, minus allowlist. */
export function scanForViolations(files: FileEntry[], allowlist: Allowlist): Violation[] {
  const violations: Violation[] = [];
  const allowZero = new Set(allowlist.zeroCallerCleanup.map((e) => e.name));
  const allowUnbounded = new Set(allowlist.unboundedDestructiveRead.map((e) => e.path));
  const allText = files.map((f) => f.content).join("\n");

  // ── Invariant 1: zero-caller cleanup fns ──
  const defined = new Map<string, string>(); // name -> defining file
  for (const f of files) {
    for (const rx of [new RegExp(CLEANUP_DEF_RX), new RegExp(CLEANUP_CONST_RX)]) {
      let m: RegExpExecArray | null;
      while ((m = rx.exec(f.content))) defined.set(m[1], f.path);
    }
  }
  for (const [name, defPath] of defined) {
    const callsites = (allText.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length;
    const defs = (allText.match(new RegExp(`function\\s+${name}\\s*[(<]`, "g")) || []).length;
    const callers = callsites - defs; // method/fn invocations minus the definition itself
    if (callers <= 0 && !allowZero.has(name)) {
      violations.push({
        scan: "zero-caller-cleanup",
        key: name,
        detail: `${name} (${defPath}) is an exported cleanup fn with 0 callers in app/+lib. Wire it into the lifecycle that should trigger it, delete it as dead code, or allowlist with a reason.`,
      });
    }
  }

  // ── Invariant 2: unbounded read behind absence-based destruction ──
  for (const f of files) {
    if (!f.content.includes('.from("instaclaw_vms")')) continue;
    const triple =
      hasUnboundedVmRead(f.content) &&
      DESTRUCTIVE_RX.test(f.content) &&
      MEMBERSHIP_RX.test(f.content);
    if (!triple) continue;
    if (f.content.includes("fetchAllOrThrow")) continue; // uses the count-asserted helper
    if (allowUnbounded.has(f.path)) continue;
    violations.push({
      scan: "unbounded-destructive-read",
      key: f.path,
      detail: `${f.path} reads instaclaw_vms unbounded AND builds a membership set AND performs a destructive op, without fetchAllOrThrow. If any destruction is keyed on a VM's ABSENCE from the read, it's reaper-class — use fetchAllOrThrow (lib/complete-set.ts). If destruction is per-VM-state-driven, allowlist with a reason.`,
    });
  }

  return violations;
}

// ── Tree-reading wrapper (skipped under import for tests) ──
function collectFiles(dirs: string[], root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === ".git") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        out.push({ path: relative(root, full), content: readFileSync(full, "utf-8") });
      }
    }
  };
  for (const d of dirs) {
    try {
      walk(join(root, d));
    } catch {
      /* dir may not exist */
    }
  }
  return out;
}

function main() {
  const root = process.cwd();
  const allowlist: Allowlist = JSON.parse(
    readFileSync(join(root, "scripts/structural-invariants-allowlist.json"), "utf-8"),
  );
  const files = collectFiles(["app", "lib"], root);
  const violations = scanForViolations(files, allowlist);

  if (violations.length === 0) {
    console.log(
      `✓ structural-invariants: ${files.length} files scanned, 0 violations ` +
        `(${allowlist.zeroCallerCleanup.length} zero-caller + ${allowlist.unboundedDestructiveRead.length} unbounded-read allowlisted)`,
    );
    process.exit(0);
  }

  console.error(`\n✗ structural-invariants: ${violations.length} violation(s) — build blocked\n`);
  for (const v of violations) {
    console.error(`  [${v.scan}] ${v.key}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    `Fix the violation, or add it to scripts/structural-invariants-allowlist.json with a written reason (a reviewer must confirm it is NOT a bug).\n`,
  );
  process.exit(1);
}

// Only run main() when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("_check-structural-invariants.ts");
if (invokedDirectly) main();
