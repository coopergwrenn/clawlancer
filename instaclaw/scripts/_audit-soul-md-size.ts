/**
 * Audit the current SOUL.md size for partner-tagged VMs vs the bootstrap budget.
 * Quantifies how much headroom we have to add new partners before silent truncation.
 *
 * Read-only; runs locally; no SSH.
 */
import {
  WORKSPACE_CAPABILITIES_MD,
  WORKSPACE_QUICK_REFERENCE_MD,
  WORKSPACE_TOOLS_MD_TEMPLATE,
  SOUL_MD_LEARNED_PREFERENCES,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT,
  SOUL_MD_OPERATING_PRINCIPLES,
  SOUL_MD_MEMORY_FILING_SYSTEM,
} from "../lib/agent-intelligence";
import { WORKSPACE_EARN_MD } from "../lib/earn-md-template";
import { WORKSPACE_SOUL_MD } from "../lib/ssh";
import { BOOTSTRAP_MAX_CHARS } from "../lib/vm-manifest";
import { SOUL_STUB_EDGE, SOUL_STUB_CONSENSUS } from "../lib/partner-content";

// v92 partner stubs (current). Pre-v92 sections preserved as comments below.
const EDGE_CITY_SECTION = SOUL_STUB_EDGE;
const CONSENSUS_SECTION = SOUL_STUB_CONSENSUS;

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

console.log("=== SOUL.md size audit ===");
console.log(`Bootstrap budget (BOOTSTRAP_MAX_CHARS): ${fmt(BOOTSTRAP_MAX_CHARS)} chars\n`);

// Base SOUL.md
const base = {
  WORKSPACE_SOUL_MD: WORKSPACE_SOUL_MD.length,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT: SOUL_MD_INTELLIGENCE_SUPPLEMENT.length,
  SOUL_MD_LEARNED_PREFERENCES: SOUL_MD_LEARNED_PREFERENCES.length,
  SOUL_MD_OPERATING_PRINCIPLES: SOUL_MD_OPERATING_PRINCIPLES.length,
  SOUL_MD_MEMORY_FILING_SYSTEM: SOUL_MD_MEMORY_FILING_SYSTEM.length,
};
const baseTotal = Object.values(base).reduce((a, b) => a + b, 2); // +2 for the "\n\n"

console.log("--- Base SOUL.md components ---");
for (const [k, v] of Object.entries(base)) {
  console.log(`  ${k.padEnd(35)} ${fmt(v).padStart(8)} chars  (${pct(v, BOOTSTRAP_MAX_CHARS)})`);
}
console.log(`  ${"BASE TOTAL".padEnd(35)} ${fmt(baseTotal).padStart(8)} chars  (${pct(baseTotal, BOOTSTRAP_MAX_CHARS)})`);

console.log("\n--- Partner sections ---");
console.log(`  ${"edge_city section".padEnd(35)} ${fmt(EDGE_CITY_SECTION.length).padStart(8)} chars  (${pct(EDGE_CITY_SECTION.length, BOOTSTRAP_MAX_CHARS)})`);
console.log(`  ${"consensus_2026 section".padEnd(35)} ${fmt(CONSENSUS_SECTION.length).padStart(8)} chars  (${pct(CONSENSUS_SECTION.length, BOOTSTRAP_MAX_CHARS)})`);

// Scenarios
console.log("\n--- Scenarios (does it fit in BOOTSTRAP_MAX_CHARS?) ---");
const scenarios = [
  { name: "Untagged VM (no partner)", soul: baseTotal },
  { name: "consensus_2026 only", soul: baseTotal + CONSENSUS_SECTION.length },
  { name: "edge_city (gets both sections)", soul: baseTotal + EDGE_CITY_SECTION.length + CONSENSUS_SECTION.length },
];
for (const s of scenarios) {
  const headroom = BOOTSTRAP_MAX_CHARS - s.soul;
  const over = s.soul > BOOTSTRAP_MAX_CHARS;
  const status = over
    ? `❌ OVER by ${fmt(s.soul - BOOTSTRAP_MAX_CHARS)}`
    : `✓ ${fmt(headroom)} chars headroom`;
  console.log(`  ${s.name.padEnd(40)} ${fmt(s.soul).padStart(8)} chars  ${status}`);
}

// Other workspace files (loaded alongside SOUL.md)
console.log("\n--- Other workspace files (read by agent on demand, NOT in bootstrap) ---");
const other = {
  CAPABILITIES_MD: WORKSPACE_CAPABILITIES_MD.length,
  QUICK_REFERENCE_MD: WORKSPACE_QUICK_REFERENCE_MD.length,
  TOOLS_MD: WORKSPACE_TOOLS_MD_TEMPLATE.length,
  EARN_MD: WORKSPACE_EARN_MD.length,
};
for (const [k, v] of Object.entries(other)) {
  console.log(`  ${k.padEnd(35)} ${fmt(v).padStart(8)} chars`);
}

// How much headroom for FUTURE partners?
console.log("\n--- Future-partner capacity (edge_city + consensus_2026 baseline) ---");
const currentMax = baseTotal + EDGE_CITY_SECTION.length + CONSENSUS_SECTION.length;
const remaining = BOOTSTRAP_MAX_CHARS - currentMax;
console.log(`  Current max VM (edge+consensus):       ${fmt(currentMax)} chars`);
console.log(`  Remaining for future partners:         ${fmt(remaining)} chars`);
console.log(`  At ~700 chars/partner: room for ${Math.floor(remaining / 700)} more partner sections at current shape`);
console.log(`  At ~200 chars/partner (stub-only):     room for ${Math.floor(remaining / 200)} more partner stubs`);

// What it would look like with stub-only partner sections
console.log("\n--- Hypothetical: partner content moved to SKILL.md, SOUL.md gets a stub ---");
const PROPOSED_STUB_EDGE_LEN = 240;
const PROPOSED_STUB_CONSENSUS_LEN = 200;
const stubbedSoul = baseTotal + PROPOSED_STUB_EDGE_LEN + PROPOSED_STUB_CONSENSUS_LEN;
console.log(`  edge_city + consensus_2026 (stubbed):  ${fmt(stubbedSoul)} chars`);
console.log(`  Headroom recovered:                    ${fmt(currentMax - stubbedSoul)} chars (${pct(currentMax - stubbedSoul, currentMax)} reduction)`);
console.log(`  Future partner capacity at 240 chars/stub: ${Math.floor((BOOTSTRAP_MAX_CHARS - stubbedSoul) / 240)} additional partners`);
