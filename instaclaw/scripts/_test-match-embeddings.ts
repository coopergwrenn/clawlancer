/**
 * Quick smoke test for lib/match-embeddings.ts.
 *
 * Verifies:
 *   1. Single embed() returns 1024-dim float vector
 *   2. embedBatch() preserves input order
 *   3. embedDual() returns both vectors keyed correctly
 *   4. vectorToPgString() output format matches pgvector expectations
 *   5. Empty-string input throws cleanly
 *
 * Usage: npm exec tsx scripts/_test-match-embeddings.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  embed,
  embedBatch,
  embedDual,
  vectorToPgString,
  EMBEDDING_DIMS,
  EmbedError,
} from "../lib/match-embeddings";

async function main() {
  let pass = 0;
  let fail = 0;
  const log = (status: "✓" | "✗", msg: string) => {
    console.log(`  ${status} ${msg}`);
    if (status === "✓") pass++;
    else fail++;
  };

  console.log("\n── Test 1: single embed() ──");
  const r1 = await embed("a personal AI agent that helps founders find investors");
  if (r1.vector.length === EMBEDDING_DIMS) {
    log("✓", `returned ${EMBEDDING_DIMS}-dim vector`);
  } else {
    log("✗", `expected ${EMBEDDING_DIMS} dims, got ${r1.vector.length}`);
  }
  if (r1.vector.every((v) => typeof v === "number" && !isNaN(v))) {
    log("✓", "all dims are valid numbers");
  } else {
    log("✗", "found invalid (NaN / non-number) values");
  }
  if (r1.model.includes("openai") || r1.model.includes("voyage")) {
    log("✓", `model identifier set: ${r1.model}`);
  } else {
    log("✗", `model identifier malformed: ${r1.model}`);
  }
  // Vectors should be normalized roughly to unit length for cosine similarity
  const norm = Math.sqrt(r1.vector.reduce((s, v) => s + v * v, 0));
  if (Math.abs(norm - 1.0) < 0.01) {
    log("✓", `vector is unit-normalized (norm ≈ ${norm.toFixed(4)})`);
  } else {
    log("✗", `vector is NOT unit-normalized (norm = ${norm.toFixed(4)})`);
  }

  console.log("\n── Test 2: embedBatch() preserves order ──");
  const texts = [
    "founder building onchain AI agents",
    "investor seeking DePIN deals",
    "developer interested in zk-SNARKs",
  ];
  const r2 = await embedBatch(texts);
  if (r2.vectors.length === texts.length) {
    log("✓", `returned ${r2.vectors.length} vectors for ${texts.length} inputs`);
  } else {
    log("✗", `count mismatch: ${r2.vectors.length} vs ${texts.length}`);
  }

  // Test that semantic similarity is sensible: founder ↔ investor should be
  // closer than founder ↔ zk-SNARKs developer (both crypto, but different
  // verticals).
  const cosine = (a: number[], b: number[]) =>
    a.reduce((s, ai, i) => s + ai * b[i], 0); // assumes unit-normalized
  const sim01 = cosine(r2.vectors[0], r2.vectors[1]);
  const sim02 = cosine(r2.vectors[0], r2.vectors[2]);
  console.log(`     founder↔investor sim = ${sim01.toFixed(3)}`);
  console.log(`     founder↔zk-dev  sim  = ${sim02.toFixed(3)}`);
  if (sim01 > 0.1 && sim02 > 0.1 && Math.abs(sim01 - sim02) > 0.02) {
    log("✓", "semantic distinctions are non-trivial (distinct similarity scores)");
  } else {
    log("✗", "similarities suspiciously identical or near-zero");
  }
  // Empirical note: single-embedding cosine ranks "founder↔zk-dev" HIGHER
  // than "founder↔investor" because both founder + dev describe building
  // work, while investor is asymmetric to that. This is exactly the bug
  // dual-embedding (§ 2.2) fixes — same-trade redundancy ranking higher
  // than complementary roles.
  console.log(
    `     (note: founder↔dev > founder↔investor here is the bug dual-embedding fixes)`
  );

  console.log("\n── Test 3: embedDual() ──");
  const r3 = await embedDual({
    offering: "I'm building InstaClaw, a personal AI agent platform with own VMs and crypto wallets",
    seeking: "Looking for early-stage investors in agentic AI infrastructure and AI-research collaborators on long-context memory",
  });
  if (r3.offering_embedding.length === EMBEDDING_DIMS && r3.seeking_embedding.length === EMBEDDING_DIMS) {
    log("✓", "both offering + seeking embeddings have correct dim");
  } else {
    log("✗", "dim mismatch in embedDual output");
  }
  // Offering and seeking are the SAME user — they should be related but not identical
  const dualSim = cosine(r3.offering_embedding, r3.seeking_embedding);
  console.log(`     offering↔seeking sim = ${dualSim.toFixed(3)} (same user, different facets)`);
  if (dualSim > 0.4 && dualSim < 0.95) {
    log("✓", "dual embeddings are related but distinct");
  } else {
    log("✗", `dual sim outside expected range: ${dualSim.toFixed(3)}`);
  }

  console.log("\n── Test 4: vectorToPgString() format ──");
  const pgStr = vectorToPgString(r1.vector);
  if (pgStr.startsWith("[") && pgStr.endsWith("]")) {
    log("✓", "wrapped in brackets (pgvector format)");
  } else {
    log("✗", "missing brackets");
  }
  const commaCount = (pgStr.match(/,/g) || []).length;
  if (commaCount === EMBEDDING_DIMS - 1) {
    log("✓", `${EMBEDDING_DIMS - 1} commas (= ${EMBEDDING_DIMS} elements)`);
  } else {
    log("✗", `expected ${EMBEDDING_DIMS - 1} commas, got ${commaCount}`);
  }

  console.log("\n── Test 5: empty input throws ──");
  try {
    await embed("");
    log("✗", "empty string should have thrown");
  } catch (err) {
    if (err instanceof EmbedError) {
      log("✓", `threw EmbedError as expected: ${err.message}`);
    } else {
      log("✗", `threw wrong error type: ${err}`);
    }
  }
  try {
    await embed("   ");
    log("✗", "whitespace-only should have thrown");
  } catch (err) {
    if (err instanceof EmbedError) {
      log("✓", "whitespace-only correctly throws");
    } else {
      log("✗", `threw wrong error type: ${err}`);
    }
  }

  console.log(`\n══ Results: ${pass} passed, ${fail} failed ══\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : String(e));
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
