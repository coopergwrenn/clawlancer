/**
 * Fleet identity audit — calls /api/admin/audit-identity on production
 * and prints a summary of any mismatches.
 *
 * Usage: npx tsx scripts/_audit-vm-identity.ts
 */

const PROD_URL = process.env.NEXTAUTH_URL ?? "https://instaclaw.io";
const ADMIN_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_KEY) {
  console.error("ADMIN_API_KEY not set");
  process.exit(1);
}

async function main() {
  console.log(`Auditing fleet identity via ${PROD_URL}/api/admin/audit-identity ...`);

  const res = await fetch(`${PROD_URL}/api/admin/audit-identity`, {
    headers: { "X-Admin-Key": ADMIN_KEY! },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();

  console.log(`\nTotal VMs audited: ${data.total}`);
  console.log(`Matches: ${data.matches}`);
  console.log(`Mismatches: ${data.mismatches}`);
  console.log(`Errors: ${data.errors}`);

  if (data.mismatchDetails?.length > 0) {
    console.log("\n=== MISMATCHES (CRITICAL) ===");
    for (const m of data.mismatchDetails) {
      console.log(`  VM ${m.vmId} (${m.vmName})`);
      console.log(`    DB user: ${m.assignedEmail} (${m.assignedTo})`);
      console.log(`    VM user: ${m.configuredUser}`);
    }
  }

  if (data.errorDetails?.length > 0) {
    console.log("\n=== ERRORS ===");
    for (const e of data.errorDetails) {
      console.log(`  VM ${e.vmId} (${e.vmName}): ${e.error}`);
    }
  }

  if (data.mismatches > 0) {
    process.exit(2); // Non-zero exit for CI/alerting
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
