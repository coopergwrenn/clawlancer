/**
 * One-shot extractor: pulls the agent-status and clawlancer SKILL.md
 * heredoc bodies out of lib/cloud-init.ts's evaluated bash script and
 * writes them to instaclaw/skills/{agent-status,clawlancer}/SKILL.md.
 *
 * Rationale: BE-8 lifts these two skills from v1-inline-heredocs
 * (lib/cloud-init.ts) into the v2 manifest's skillsFromRepo path
 * (instaclaw/skills/). The reconciler's stepSkills walk picks them up,
 * heals every existing VM to the canonical content, and new cloud-init
 * provisions get them via the manifest deploy path. Same pattern as
 * frontier (commit dba50f49).
 *
 * Source-of-truth: the TS-evaluated bash script (NOT the raw .ts
 * source) — that ensures backslash-backticks and any other TS-template
 * escape sequences resolve to their intended bash-file bytes.
 *
 * Run: npx tsx scripts/_extract-skill-md-from-cloud-init.ts
 * Then: review the diff and commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getInstallOpenClawUserData } from "../lib/cloud-init";

const bashScript = getInstallOpenClawUserData();

// Extract the heredoc body between `<<'<DELIMITER>'\n` and `\n<DELIMITER>`.
function extractHeredoc(script: string, delimiter: string): string {
  const startMarker = `<<'${delimiter}'\n`;
  const endMarker = `\n${delimiter}\n`;
  const startIdx = script.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`heredoc start not found: ${delimiter}`);
  const bodyStart = startIdx + startMarker.length;
  const endIdx = script.indexOf(endMarker, bodyStart);
  if (endIdx < 0) throw new Error(`heredoc end not found: ${delimiter}`);
  // Include the trailing newline (matches what `cat > file <<EOF` writes:
  // each line in the heredoc body ends with \n; the body has a final \n
  // before the closing delimiter, which represents the file's terminal
  // newline).
  return script.slice(bodyStart, endIdx) + "\n";
}

const clawlancerBody = extractHeredoc(bashScript, "SKILLEOF");
const agentStatusBody = extractHeredoc(bashScript, "STATUSEOF");

// Sanity-check shapes BEFORE writing.
function assertContains(body: string, needles: string[], label: string): void {
  for (const n of needles) {
    if (!body.includes(n)) {
      throw new Error(`${label} body missing expected fragment: ${JSON.stringify(n)}`);
    }
  }
}
assertContains(clawlancerBody, ["name: clawlancer", "mcporter call clawlancer.get_my_profile", "register_agent"], "clawlancer");
assertContains(agentStatusBody, ["name: agent-status", "Agent Status — Self-Diagnostic"], "agent-status");

// Sanity-check NO TS-escape residue. If the extraction is correct,
// the bytes should match what bash writes to disk (no `\` in front of
// backticks, no `\${...}` template-escape residue).
function assertNoTsResidue(body: string, label: string): void {
  // \` would only appear if we'd grabbed the .ts source instead of the
  // evaluated template — the evaluated bash has plain `.
  if (body.includes("\\`")) {
    throw new Error(`${label} body has TS-escape residue \\\`. Extraction is wrong.`);
  }
  // Similarly \${...} would mean we picked up the .ts source.
  if (body.includes("\\$")) {
    throw new Error(`${label} body has TS-escape residue \\$. Extraction is wrong.`);
  }
}
assertNoTsResidue(clawlancerBody, "clawlancer");
assertNoTsResidue(agentStatusBody, "agent-status");

const repoRoot = path.resolve(__dirname, "..");
const clawlancerDir = path.join(repoRoot, "skills", "clawlancer");
const agentStatusDir = path.join(repoRoot, "skills", "agent-status");
mkdirSync(clawlancerDir, { recursive: true });
mkdirSync(agentStatusDir, { recursive: true });
const clawlancerPath = path.join(clawlancerDir, "SKILL.md");
const agentStatusPath = path.join(agentStatusDir, "SKILL.md");
writeFileSync(clawlancerPath, clawlancerBody, "utf-8");
writeFileSync(agentStatusPath, agentStatusBody, "utf-8");

console.log(`wrote ${clawlancerPath} (${clawlancerBody.length} bytes)`);
console.log(`wrote ${agentStatusPath} (${agentStatusBody.length} bytes)`);
console.log("");
console.log("First 5 lines of each (sanity check):");
console.log("--- clawlancer ---");
console.log(clawlancerBody.split("\n").slice(0, 5).join("\n"));
console.log("--- agent-status ---");
console.log(agentStatusBody.split("\n").slice(0, 5).join("\n"));
