/**
 * Lazy registration of the matchpool VM-side Python scripts.
 *
 * The actual scripts live at:
 *   instaclaw/scripts/consensus_match_pipeline.py    (Component 9 orchestrator)
 *   instaclaw/scripts/consensus_match_rerank.py      (Component 7 — Layer 2)
 *   instaclaw/scripts/consensus_match_deliberate.py  (Component 8 — Layer 3)
 *   instaclaw/scripts/consensus_match_consent.py     (Component 10 helper)
 *   instaclaw/scripts/consensus_intent_sync.py       (Component 4)
 *   instaclaw/scripts/consensus_intent_extract.py    (Component 4)
 *   instaclaw/scripts/consensus_match_skill_toggle.py (Path 2 §Organic Activation)
 *
 * 2026-05-05: switched from runtime fs.readFileSync to build-time embedded
 * content. The previous approach used `path.resolve(__dirname, "..", "scripts", filename)`
 * + Next.js `outputFileTracingIncludes` to bundle the .py files into the
 * serverless function output. No glob shape worked on Vercel — local
 * `next build` traced the files correctly into route.js.nft.json, but
 * the deploy bundle didn't actually copy them, so the reconciler threw
 * `ENOENT '/ROOT/instaclaw/scripts/consensus_match_pipeline.py'` for every
 * cv=82 VM that survived long enough to reach stepFiles, holding the
 * entire 86-VM cohort behind that one error. Likely a Vercel-monorepo /
 * @vercel/nft asymmetry with Next 16's tracing — not worth debugging
 * further when embedding eliminates the dependency entirely.
 *
 * Now: scripts/_generate-matchpool-content.ts reads each .py file at
 * build time and writes lib/matchpool-scripts-content.ts with the
 * contents as base64 → utf-8 string exports. This file imports those
 * constants and registers them. Next.js compiles the strings into the
 * JS bundle through the normal import graph — no fs reads, no
 * outputFileTracingIncludes, no Vercel-specific bundling magic.
 *
 * The generator runs as `npm run prebuild` (see package.json). Editing
 * a .py file invalidates the build; the generator picks it up on the
 * next build.
 */
import { registerLazyTemplate } from "./vm-manifest";
import {
  CONSENSUS_MATCH_PIPELINE_PY,
  CONSENSUS_MATCH_RERANK_PY,
  CONSENSUS_MATCH_DELIBERATE_PY,
  CONSENSUS_MATCH_CONSENT_PY,
  CONSENSUS_INTENT_SYNC_PY,
  CONSENSUS_INTENT_EXTRACT_PY,
  CONSENSUS_MATCH_SKILL_TOGGLE_PY,
} from "./matchpool-scripts-content";

registerLazyTemplate("CONSENSUS_MATCH_PIPELINE_PY", () => CONSENSUS_MATCH_PIPELINE_PY);
registerLazyTemplate("CONSENSUS_MATCH_RERANK_PY", () => CONSENSUS_MATCH_RERANK_PY);
registerLazyTemplate("CONSENSUS_MATCH_DELIBERATE_PY", () => CONSENSUS_MATCH_DELIBERATE_PY);
registerLazyTemplate("CONSENSUS_MATCH_CONSENT_PY", () => CONSENSUS_MATCH_CONSENT_PY);
registerLazyTemplate("CONSENSUS_INTENT_SYNC_PY", () => CONSENSUS_INTENT_SYNC_PY);
registerLazyTemplate("CONSENSUS_INTENT_EXTRACT_PY", () => CONSENSUS_INTENT_EXTRACT_PY);
registerLazyTemplate("CONSENSUS_MATCH_SKILL_TOGGLE_PY", () => CONSENSUS_MATCH_SKILL_TOGGLE_PY);
