/**
 * Coverage query for the Base ecosystem skill plugins.
 *
 * Per CLAUDE.md Rule 27 — every fleet-wide resource needs a 10-second
 * visibility query. Confirms that each healthy + assigned VM has all
 * BASE_SKILL_CATALOG entries deployed on disk at the expected SHA.
 *
 * Mechanism:
 *   - Resolve expected content (and SHA) for each catalog entry via
 *     lib/base-skills-registry.ts in vendored mode (purely local; no
 *     network).
 *   - Random-sample N healthy + assigned VMs (default 5; --all for full
 *     fleet).
 *   - For each VM, run ONE composite SSH command that sha256sums every
 *     expected skill file in a single round-trip.
 *   - Compare each per-entry result to the expected SHA.
 *
 * Per-entry outcomes:
 *   - PASS                 sha matches expected
 *   - FAIL-DRIFT           file exists but sha differs (live-fetch wrote
 *                          something newer/different, or content drifted)
 *   - FAIL-MISSING         file doesn't exist (stepBaseSkills hasn't run
 *                          successfully on this VM yet)
 *
 * Exit codes:
 *   0  all sampled VMs have all skills at the expected SHA
 *   1  at least one PASS but some FAILs — investigate
 *   2  all probes errored (env / SSH-key misconfig)
 *
 * Run: `npx tsx scripts/_coverage-base-skills.ts`
 *   --sample N  : override sample size (default 5)
 *   --all       : check every healthy + assigned VM (slow; for full audit)
 *   --verbose   : per-skill per-VM breakdown (default: aggregate summary)
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import {
  BASE_SKILL_CATALOG,
  getBaseSkillContent,
  type BaseSkillEntry,
} from "../lib/base-skills-registry";

// ─── env loading (.env.local + .env.ssh-key — both required) ─────────

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* optional */
  }
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(2);
}
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64;
if (!SSH_KEY_B64) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 not set; load .env.ssh-key");
  process.exit(2);
}
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const argv = process.argv.slice(2);
const sampleArg = argv.find((a) => a.startsWith("--sample="));
const SAMPLE = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 5;
const ALL = argv.includes("--all");
const VERBOSE = argv.includes("--verbose");

// ─── pre-compute expected catalog SHAs (local, no SSH) ───────────────

interface ExpectedEntry {
  entry: BaseSkillEntry;
  onVmPath: string;
  expectedSha: string;
}

async function loadExpected(): Promise<ExpectedEntry[]> {
  // Resolve via vendored mode — purely local file reads.
  process.env.BASE_SKILLS_SOURCE_MODE = "vendored";
  const expected: ExpectedEntry[] = [];
  for (const entry of BASE_SKILL_CATALOG) {
    const content = await getBaseSkillContent(entry, "vendored");
    expected.push({
      entry,
      onVmPath: `/home/openclaw/.openclaw/skills/${entry.vendoredPath}/SKILL.md`,
      expectedSha: content.sha256,
    });
  }
  return expected;
}

// ─── probe ───────────────────────────────────────────────────────────

type PerSkillStatus = "PASS" | "FAIL-DRIFT" | "FAIL-MISSING";

interface VmResult {
  name: string;
  ip: string;
  connectError?: string;
  perSkill: Record<string, { status: PerSkillStatus; sha?: string }>;
}

async function probe(
  name: string,
  ip: string,
  expected: ExpectedEntry[],
): Promise<VmResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip,
      username: "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 8000,
      tryKeyboard: false,
    });
    // Composite command: emit one line per skill, format:
    //   "<name>:<sha-or-MISSING>"
    const lines = expected
      .map(
        (e) =>
          `printf '%s:%s\\n' '${e.entry.name}' "$([ -f ${e.onVmPath} ] && sha256sum ${e.onVmPath} | awk '{print $1}' || echo MISSING)"`,
      )
      .join("; ");
    const r = await ssh.execCommand(`bash -c '${lines.replace(/'/g, "'\\''")}'`);
    ssh.dispose();

    const perSkill: VmResult["perSkill"] = {};
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^([^:]+):(.+)$/);
      if (!m) continue;
      const [, sname, sha] = m;
      const exp = expected.find((e) => e.entry.name === sname);
      if (!exp) continue;
      if (sha === "MISSING") {
        perSkill[sname] = { status: "FAIL-MISSING" };
      } else if (sha === exp.expectedSha) {
        perSkill[sname] = { status: "PASS", sha };
      } else {
        perSkill[sname] = { status: "FAIL-DRIFT", sha };
      }
    }
    return { name, ip, perSkill };
  } catch (err) {
    try {
      ssh.dispose();
    } catch {
      /* noop */
    }
    return {
      name,
      ip,
      connectError: String(err).slice(0, 160),
      perSkill: {},
    };
  }
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== base-skills coverage — ${new Date().toISOString()} ===\n`);

  const expected = await loadExpected();
  console.log(
    `Catalog: ${expected.length} entries (${expected.map((e) => e.entry.name).join(", ")})\n`,
  );

  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("name,ip_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (error) {
    console.error(`Supabase error: ${error.message}`);
    process.exit(2);
  }
  const candidates = (data ?? []).filter((v): v is { name: string; ip_address: string } =>
    Boolean(v.ip_address),
  );
  if (candidates.length === 0) {
    console.log("No healthy + assigned VMs with ip_address. Nothing to sample.");
    process.exit(0);
  }

  let picks: typeof candidates;
  if (ALL) {
    picks = candidates;
  } else {
    const n = Math.min(SAMPLE, candidates.length);
    picks = [...candidates].sort(() => Math.random() - 0.5).slice(0, n);
  }
  console.log(
    `Population: ${candidates.length} healthy+assigned VMs. ` +
      `Probing ${picks.length} (${ALL ? "ALL" : `random sample of ${SAMPLE}`}).\n`,
  );

  const results = await Promise.all(picks.map((v) => probe(v.name, v.ip_address, expected)));
  results.sort((a, b) => a.name.localeCompare(b.name));

  // Aggregate counts per skill
  const perSkillAgg: Record<string, { pass: number; drift: number; missing: number }> = {};
  for (const e of expected) {
    perSkillAgg[e.entry.name] = { pass: 0, drift: 0, missing: 0 };
  }
  let connectErrors = 0;

  for (const r of results) {
    if (r.connectError) {
      connectErrors++;
      continue;
    }
    for (const e of expected) {
      const s = r.perSkill[e.entry.name]?.status ?? "FAIL-MISSING";
      if (s === "PASS") perSkillAgg[e.entry.name].pass++;
      else if (s === "FAIL-DRIFT") perSkillAgg[e.entry.name].drift++;
      else perSkillAgg[e.entry.name].missing++;
    }
  }

  if (VERBOSE) {
    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    console.log(pad("VM", 24) + expected.map((e) => pad(e.entry.name, 12)).join(""));
    console.log("-".repeat(24 + 12 * expected.length));
    for (const r of results) {
      if (r.connectError) {
        console.log(pad(r.name, 24) + `ERROR: ${r.connectError}`);
        continue;
      }
      const cells = expected.map((e) => {
        const s = r.perSkill[e.entry.name]?.status ?? "FAIL-MISSING";
        const sym = s === "PASS" ? "✓" : s === "FAIL-DRIFT" ? "△" : "✗";
        return pad(sym + " " + s, 12);
      });
      console.log(pad(r.name, 24) + cells.join(""));
    }
    console.log();
  }

  // Summary
  const okVms = results.filter(
    (r) => !r.connectError && expected.every((e) => r.perSkill[e.entry.name]?.status === "PASS"),
  ).length;
  console.log(
    `Summary: ${okVms} / ${picks.length} VMs have all ${expected.length} skills at expected SHA`,
  );
  for (const e of expected) {
    const a = perSkillAgg[e.entry.name];
    const total = a.pass + a.drift + a.missing;
    const symbol = a.drift === 0 && a.missing === 0 ? "✓" : "✗";
    console.log(
      `  ${symbol} ${e.entry.name.padEnd(12)} pass=${a.pass}/${total}  drift=${a.drift}  missing=${a.missing}`,
    );
  }
  if (connectErrors > 0) {
    console.log(`\n${connectErrors} VM(s) unreachable (SSH connect failed)`);
  }

  const totalDrift = Object.values(perSkillAgg).reduce((s, a) => s + a.drift, 0);
  const totalMissing = Object.values(perSkillAgg).reduce((s, a) => s + a.missing, 0);

  if (totalDrift + totalMissing > 0) {
    console.error(
      `\n✗ Drift/missing detected. The stepBaseSkills reconciler step (in vm-reconcile.ts) ` +
        `runs via cron/file-drift every 15 min and via cron/reconcile-fleet on next cv-stale ` +
        `cycle — wait one cycle and re-check before escalating.`,
    );
    process.exit(1);
  }
  if (connectErrors === picks.length) {
    console.error("\n✗ All probes errored — likely env/SSH-key misconfig.");
    process.exit(2);
  }
  console.log("\n✓ All sampled VMs are clean.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
