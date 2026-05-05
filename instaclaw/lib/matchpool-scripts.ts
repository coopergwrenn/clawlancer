/**
 * Lazy registration of the matchpool VM-side Python scripts.
 *
 * The actual scripts live at:
 *   instaclaw/scripts/consensus_match_pipeline.py    (Component 9 orchestrator)
 *   instaclaw/scripts/consensus_match_rerank.py      (Component 7 — Layer 2)
 *   instaclaw/scripts/consensus_match_deliberate.py  (Component 8 — Layer 3)
 *   instaclaw/scripts/consensus_match_consent.py     (Component 10 helper)
 *
 * Why lazy: Turbopack's "Collecting page data" pass evaluates server
 * modules with __dirname resolving to a phantom path where the .py
 * files don't exist (same issue as lib/privacy-bridge-script.ts).
 * Top-level fs.readFileSync would crash the build. Lazy reads defer
 * the actual file load to the first reconciler call, by which point
 * we're in real serverless runtime with outputFileTracingIncludes
 * (next.config.ts) ensuring the files are present.
 *
 * The reconciler's getTemplateContent() falls back to LAZY_RESOLVERS
 * if a key isn't in TEMPLATE_REGISTRY, so we register the lazy
 * resolvers at module load time without doing any I/O.
 *
 * Imported by lib/ssh.ts adjacent to its other registerTemplate calls
 * (STRIP_THINKING_SCRIPT, etc.) — the import is what triggers
 * registration. See vm-manifest.ts files[] for the consumer entries.
 */
import * as fs from "fs";
import * as path from "path";
import { registerLazyTemplate } from "./vm-manifest";

const cache: Record<string, string> = {};

function lazyLoad(filename: string): string {
  if (!cache[filename]) {
    cache[filename] = fs.readFileSync(
      path.resolve(__dirname, "..", "scripts", filename),
      "utf-8",
    );
  }
  return cache[filename];
}

registerLazyTemplate("CONSENSUS_MATCH_PIPELINE_PY", () =>
  lazyLoad("consensus_match_pipeline.py"),
);
registerLazyTemplate("CONSENSUS_MATCH_RERANK_PY", () =>
  lazyLoad("consensus_match_rerank.py"),
);
registerLazyTemplate("CONSENSUS_MATCH_DELIBERATE_PY", () =>
  lazyLoad("consensus_match_deliberate.py"),
);
registerLazyTemplate("CONSENSUS_MATCH_CONSENT_PY", () =>
  lazyLoad("consensus_match_consent.py"),
);
// Component 4 scripts. Previously only deployed to vm-780 by hand; without
// these in the manifest the rest of the fleet has no way to populate
// matchpool_profiles. Both gate on the consensus-2026 skill state via
// /api/match/v1/consent (so non-attending users incur zero Haiku cost).
registerLazyTemplate("CONSENSUS_INTENT_SYNC_PY", () =>
  lazyLoad("consensus_intent_sync.py"),
);
registerLazyTemplate("CONSENSUS_INTENT_EXTRACT_PY", () =>
  lazyLoad("consensus_intent_extract.py"),
);
