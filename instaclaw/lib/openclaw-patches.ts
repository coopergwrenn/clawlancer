/**
 * openclaw-patches.ts — THE single source of truth for every custom patch
 * InstaClaw applies to OpenClaw's vendored dist files.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS  (read before touching anything)
 * ─────────────────────────────────────────────────────────────────────────
 * OpenClaw is installed globally on every fleet VM via `npm install -g
 * openclaw@<version>`. Every such install WIPES the package's `dist/` tree
 * (and its nested `node_modules`). Any custom modification we make to those
 * bundled files disappears the instant the package is reinstalled — which
 * happens on SIX code paths (configureOpenClaw, stepNpmPinDrift,
 * upgradeOpenClaw, fleet-upgrade-openclaw.sh, snapshot bake, and an implicit
 * cloud-init inherit). Historically each patch was wired into a DIFFERENT
 * subset of those paths, so patches silently regressed on the paths they
 * weren't wired into. The 2026-05-23 v118 typing-keepalive incident (CLAUDE.md
 * Rule 63 / 64) is the canonical example: the patch lived ONLY in
 * configureOpenClaw, so re-enabling the feature fleet-wide assumed a patch
 * that wasn't there.
 *
 * The cure (modeled on Debian quilt + the gold-standard `stepPiAiReasoningPatch`):
 *   1. Patches are DATA in this registry — one declarative descriptor each.
 *   2. Apply is ONE shared engine (`applyOpenClawPatches`) that reproduces the
 *      gold-standard discipline (sentinel-skip → anchor-check → transform →
 *      pre-write verify → backup → atomic write → verify-after-write →
 *      node --check → rollback). No per-patch discipline duplication.
 *   3. File discovery is CONTENT-ANCHORED, never by hashed filename. OpenClaw's
 *      bundle filenames carry a Rollup content hash (`bot-msflwCEW.js`,
 *      `queue-XXXX.js`) that changes between versions; we locate the file by a
 *      unique code substring instead, so a version bump that only renames the
 *      chunk does not break discovery.
 *   4. Every wipe site calls the engine. Idempotency (sentinel-skip) makes
 *      calling it "too often" free.
 *   5. Drift (anchors no longer match → upstream changed the file shape) and
 *      native-fixes (upstream now does this itself) are surfaced LOUDLY by the
 *      verify engine, never swallowed — so an upgrade can't silently disable a
 *      patch the way the 4.26→5.22 bump risks doing to the reasoning router.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A PATCH
 * ─────────────────────────────────────────────────────────────────────────
 *   - Append an OpenClawPatch descriptor to PATCHES below.
 *   - `anchors` are byte-for-byte substrings that MUST exist in the pristine
 *     (un-patched) file. If any is absent, the engine refuses to apply and
 *     reports `anchor-drift` (upstream changed the file → re-anchor needed).
 *   - `transform` is the ONLY per-patch code: a pure (src) => patchedSrc. It
 *     MUST embed the `sentinel` at least `minSentinelCount` times so
 *     idempotency + verification work.
 *   - `detectNativeFix` (optional, for `kind: "bugfix"` only) returns true when
 *     the upstream file already implements the fix — so the verify engine can
 *     tell you to DELETE the patch.
 *   - Set `rollout`: "parked" (never auto-applied), "canary" (CLI/explicit
 *     only), or "fleet" (eligible for the reconciler step). Promotion to
 *     "fleet" is a Rule-64 decision (test on vm-1019, get Cooper's approval).
 *   - Add a local fixture to scripts/_test-openclaw-patches.ts (Rule 31).
 *
 * See instaclaw/docs/openclaw-upgrade-runbook.md for the upgrade procedure
 * and CLAUDE.md Rule 71 for the governing discipline.
 */

// ─────────────────────────────────────────────────────────────────────────
// Minimal SSH surface. Both `node-ssh`'s NodeSSH and the reconciler's
// SSHConnection wrapper satisfy this structurally, so the engine works from a
// standalone tsx script AND (if ever unified) from inside the reconciler.
// ─────────────────────────────────────────────────────────────────────────
export interface PatchSSH {
  execCommand(
    command: string,
    options?: { execOptions?: { timeout?: number } },
  ): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export type RolloutStage =
  | "fleet" // eligible for the reconciler auto-apply step
  | "canary" // applied only via the CLI / explicit opt-in
  | "parked"; // documented but never applied (suspended or natively fixed)

export type PatchKind =
  | "bugfix" // works around an upstream bug; deletable once upstream fixes it
  | "feature"; // adds custom behavior with no upstream equivalent; deletable only by choice

/**
 * Discovery describes how to locate the target file on disk, RELATIVE to the
 * OpenClaw global package root (`$(npm root -g)/openclaw`).
 *
 * - "fixedPath": the file lives at a stable relative path (e.g. a nested
 *   dependency's source file that is not content-hash-renamed).
 * - "contentGlob": the file is a content-hash-named bundle chunk whose name
 *   changes between versions. We grep `searchDirRel` for `discriminator` (a
 *   substring guaranteed unique to this chunk) and take the single match.
 */
export type PatchDiscovery =
  | { mode: "fixedPath"; relPath: string }
  | { mode: "contentGlob"; searchDirRel: string; discriminator: string };

export interface OpenClawPatch {
  /** kebab-case stable id, used in logs + CLI selection. */
  id: string;
  /** Unique marker the transform embeds; idempotency + verify key on it. */
  sentinel: string;
  /** Minimum sentinel occurrences expected in a correctly-patched file. */
  minSentinelCount: number;
  kind: PatchKind;
  rollout: RolloutStage;
  /**
   * Who actually applies this in production today.
   *  - "engine": this module's applyOpenClawPatches is the apply path.
   *  - "stepPiAiReasoningPatch": a dedicated legacy reconciler step owns apply;
   *    the engine VERIFIES it but does not re-apply (avoids divergence while
   *    the working step stays untouched — see runbook "Unification" section).
   */
  managedBy: "engine" | "stepPiAiReasoningPatch";
  discovery: PatchDiscovery;
  /** Byte-for-byte substrings that must exist in the pristine file. */
  anchors: string[];
  /**
   * Pure transform: pristine source → patched source. Embeds the sentinel.
   * Undefined for a patch whose body has not been captured into the repo yet
   * (e.g. the queue patch that currently lives only on vm-1028/1043). A
   * descriptor with no transform is verify-only and will refuse to apply.
   */
  transform?: (src: string) => string;
  /**
   * Returns true if the pristine file already implements this behavior
   * (upstream shipped the fix). Only meaningful for kind: "bugfix".
   */
  detectNativeFix?: (src: string) => boolean;
  /** Whether applying requires a gateway restart (Node caches module imports). */
  restartNeeded: boolean;
  /** One-paragraph rationale + the incident that motivated it. */
  why: string;
  /** Pointer to CLAUDE.md rule / doc / commit. */
  ref?: string;
  /**
   * For descriptors without a transform: exactly how to capture the patch
   * body into the repo so a future engineer can complete it.
   */
  captureInstructions?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH 1 — pi-ai reasoning-router  (the gold standard; managed by a dedicated
// reconciler step today, mirrored here as the single documented source of
// truth + for verify + native-fix detection).
//
// The anchors + injects below are copied VERBATIM from
// lib/vm-reconcile.ts:stepPiAiReasoningPatch. Keep them in sync until the
// unification step in the runbook migrates the live apply onto this engine.
// ═══════════════════════════════════════════════════════════════════════════

const REASONING_ROUTER_SENTINEL = "INSTACLAW_REASONING_ROUTER_V1";

const REASONING_ROUTER_ANCHOR_AFTER_IMPORTS =
  'const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";';

// 2026-05-29 re-anchor for OpenClaw 2026.5.22: pi-ai package renamed from
// @mariozechner to @earendil-works AND upstream rewrote this block. The OLD
// 4.26 shape used `clampReasoningEffort(model.id, effort)` (a static helper);
// the NEW 5.22 shape inlines the clamping via `model.thinkingLevelMap` lookup
// with explicit "none" → `thinkingLevelMap?.off ?? "none"` handling and an
// `if (effort !== null)` skip-when-null gate.
//
// Anchor bytes captured live from vm-036's
// node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js
// lines 283-293 (verified via `sed -n 283,293p | cat -A`).
const REASONING_ROUTER_ANCHOR_REASONING_BLOCK = [
  "    if (options?.reasoningEffort !== undefined) {",
  '        const effort = options.reasoningEffort === "none"',
  '            ? (model.thinkingLevelMap?.off ?? "none")',
  "            : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);",
  "        if (effort !== null) {",
  "            body.reasoning = {",
  "                effort,",
  '                summary: options.reasoningSummary ?? "auto",',
  "            };",
  "        }",
  "    }",
].join("\n");

const REASONING_ROUTER_INJECT_TOP = [
  "",
  `// ${REASONING_ROUTER_SENTINEL} — load router from canonical script path.`,
  "// Falls back silently if absent. Router decides effort when options doesn't set one.",
  'import { createRequire as _instaclawCreateRequire } from "node:module";',
  "let _instaclawRouter = null;",
  "try {",
  "    const _ir = _instaclawCreateRequire(import.meta.url);",
  '    _instaclawRouter = _ir("/home/openclaw/.openclaw/scripts/reasoning-router.js");',
  "} catch (_e) { _instaclawRouter = null; }",
  "",
].join("\n");

// Mirrors the 2026.5.22 model.thinkingLevelMap pattern in BOTH branches:
//   - If caller passed reasoningEffort, use upstream's clamping logic.
//   - Else if our router has an opinion, classify and apply the SAME clamping
//     logic to the router's decision (so a router decision of "low" against a
//     model whose thinkingLevelMap.low === null is correctly suppressed).
// Brace-balanced (11 opens, 11 closes — verified by manual count); embeds the
// REASONING_ROUTER_SENTINEL once (the load-time comment in INJECT_TOP embeds
// it a second time → total 2, meets minSentinelCount=2). The catch swallows
// router failures so the request never blocks on patch infrastructure.
const REASONING_ROUTER_INJECT_REASONING_REPLACEMENT = [
  "    if (options?.reasoningEffort !== undefined) {",
  '        const effort = options.reasoningEffort === "none"',
  '            ? (model.thinkingLevelMap?.off ?? "none")',
  "            : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);",
  "        if (effort !== null) {",
  "            body.reasoning = {",
  "                effort,",
  '                summary: options.reasoningSummary ?? "auto",',
  "            };",
  "        }",
  '    } else if (_instaclawRouter && typeof _instaclawRouter.classifyMessage === "function") {',
  `        // ${REASONING_ROUTER_SENTINEL} — route reasoning effort by message content.`,
  "        try {",
  "            const _userMsg = _instaclawRouter.extractLatestUserMessage(context?.input);",
  "            if (_userMsg) {",
  "                const _decision = _instaclawRouter.classifyMessage(_userMsg, {",
  "                    modelId: model.id,",
  "                    sessionId: options?.sessionId,",
  "                });",
  "                if (_decision && _decision.effort) {",
  '                    const _effort = _decision.effort === "none"',
  '                        ? (model.thinkingLevelMap?.off ?? "none")',
  "                        : (model.thinkingLevelMap?.[_decision.effort] ?? _decision.effort);",
  "                    if (_effort !== null) {",
  "                        body.reasoning = {",
  "                            effort: _effort,",
  '                            summary: options?.reasoningSummary ?? "auto",',
  "                        };",
  "                    }",
  "                }",
  "            }",
  "        } catch (_e) { /* router failure must never block the request */ }",
  "    }",
].join("\n");

function reasoningRouterTransform(src: string): string {
  let patched = src.replace(
    REASONING_ROUTER_ANCHOR_AFTER_IMPORTS,
    REASONING_ROUTER_ANCHOR_AFTER_IMPORTS + REASONING_ROUTER_INJECT_TOP,
  );
  patched = patched.replace(
    REASONING_ROUTER_ANCHOR_REASONING_BLOCK,
    REASONING_ROUTER_INJECT_REASONING_REPLACEMENT,
  );
  return patched;
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH 2 — typing-keepalive  (PARKED; likely natively fixed in 2026.5.x).
//
// Body reconstructed from the v118 patch (commit 554cc581, reverted in v119).
// It is PARKED: never auto-applied. Its value here is (a) documentation, and
// (b) detectNativeFix — the verify engine reports whether the running OpenClaw
// version already keeps the Telegram typing indicator alive natively, so we
// know whether the patch is needed at all. As of 2026.4.26 the upstream
// `createTypingKeepaliveLoop` (3s) already exists; 2026.5.x added event-loop
// fixes (#73428/#75656/#75984) that make the native loop fire on schedule.
// ═══════════════════════════════════════════════════════════════════════════

const TYPING_KEEPALIVE_SENTINEL = "INSTACLAW v118 typing-keepalive shim";

const TYPING_KEEPALIVE_ANCHOR_SENDTYPING =
  'sendChatActionHandler.sendChatAction(chatId, "typing", buildTypingThreadParams(replyThreadId))';

const TYPING_KEEPALIVE_ANCHOR_FINAL =
  'if (info.kind === "final") await enqueueDraftLaneEvent(async () => {});';

/**
 * Reconstructed v118 transform. NOT auto-applied (rollout "parked"). Present
 * so that if Cooper ever un-parks it the body is in source control, and so the
 * local test can exercise it. Embeds the sentinel twice.
 */
function typingKeepaliveTransform(src: string): string {
  const shim = [
    "",
    `\t// ${TYPING_KEEPALIVE_SENTINEL} — keep Telegram typing alive past its 5s TTL.`,
    "\tlet __instaclawTKInterval = null;",
    "\tlet __instaclawTKTimeout = null;",
    "\tconst __instaclawTKStart = (refreshFn) => {",
    "\t\tif (__instaclawTKInterval) { try { clearInterval(__instaclawTKInterval); } catch (_) {} }",
    "\t\tif (__instaclawTKTimeout) { try { clearTimeout(__instaclawTKTimeout); } catch (_) {} }",
    "\t\t__instaclawTKInterval = setInterval(() => { try { refreshFn().catch(() => {}); } catch (_) {} }, 4000);",
    "\t\t__instaclawTKTimeout = setTimeout(() => { __instaclawTKStop(); }, 90000);",
    "\t};",
    "\tconst __instaclawTKStop = () => {",
    "\t\tif (__instaclawTKInterval) { try { clearInterval(__instaclawTKInterval); } catch (_) {} __instaclawTKInterval = null; }",
    "\t\tif (__instaclawTKTimeout) { try { clearTimeout(__instaclawTKTimeout); } catch (_) {} __instaclawTKTimeout = null; }",
    "\t};",
    "",
  ].join("\n");

  // Insert the shim just before the sendTyping invocation and start the loop
  // right after the first typing action fires.
  let patched = src.replace(
    TYPING_KEEPALIVE_ANCHOR_SENDTYPING,
    `${TYPING_KEEPALIVE_ANCHOR_SENDTYPING};\n${shim}\t\t__instaclawTKStart(() => ${TYPING_KEEPALIVE_ANCHOR_SENDTYPING})`,
  );
  // Stop the keepalive on final delivery.
  patched = patched.replace(
    TYPING_KEEPALIVE_ANCHOR_FINAL,
    `if (info.kind === "final") { try { __instaclawTKStop(); } catch (_) {} await enqueueDraftLaneEvent(async () => {}); }`,
  );
  return patched;
}

/**
 * Native-fix detector for typing: the upstream channel-side keepalive lives in
 * a `typing-*.js` chunk and calls `createTypingKeepaliveLoop` with a
 * `keepaliveIntervalMs` default. If the telegram bundle (or a sibling typing
 * chunk) references that machinery, upstream keeps typing alive itself and our
 * patch is redundant. (We detect against the telegram bundle for simplicity;
 * the import chain reaches the typing chunk.)
 */
function typingDetectNativeFix(src: string): boolean {
  return (
    src.includes("createTypingKeepaliveLoop") ||
    src.includes("createTypingCallbacks") ||
    src.includes("keepaliveIntervalMs")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RETIRED — queue-collect-batch  (was sentinel INSTACLAW_PATCH_QCB_V1).
// Removed from PATCHES 2026-06-14 per the runbook §7 deletion convention
// ("remove its descriptor from PATCHES, remove its fixture, note the deletion
// + obsoleting version in git history / CLAUDE.md"). This comment IS that note.
//
// What it was: removed an over-broad `currentInboundContext` check in
// hasRuntimeOnlyFollowupMetadata (the queue-*.js chunk) so collect-mode batched
// Telegram DMs correctly. Applied ONLY on vm-1028/vm-1043 via manual SSH; never
// committed to git.
//
// Why retired — all three proven 2026-06-14 (read-only investigation):
//   1. WIPED: a routine reinstall to OpenClaw 2026.5.22 (vm-1028's manual
//      `.pre-qcb-v1` backup is dated 2026-05-29) restored pristine
//      queue-DskPlua9.js on BOTH vm-1028 and vm-1043 — sentinel absent.
//   2. UNRECOVERABLE: the body was never in source control (only the stub
//      descriptor was, commit d3c0d9fc). The surviving `.bak` is the PRE-patch
//      pristine, not the patch. No copy of the patched body exists anywhere.
//   3. MOOT: the paired collect-mode config (messages.queue.mode/debounceMs/
//      byChannel.telegram) is UNSET on vm-1028 — collect-mode isn't active, so
//      the patch had nothing to do. The "landmine" already detonated, harmlessly.
//
// NOT reconstructed on purpose: re-deriving a fleet-bound behavior change from a
// one-line description, for a feature that isn't even enabled, is inventing code
// on a guess (Rule 71 + prove-don't-invent). If collect-mode is ever re-enabled,
// re-derive deliberately from pristine source + the original intent (ideally the
// original author / upstream PR), add a transform + sentinel + a
// _test-openclaw-patches.ts fixture, and re-register it THEN — not before.
// See CLAUDE.md Rule 71.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

export const PATCHES: OpenClawPatch[] = [
  {
    id: "pi-ai-reasoning-router",
    sentinel: REASONING_ROUTER_SENTINEL,
    minSentinelCount: 2,
    kind: "feature",
    rollout: "fleet",
    managedBy: "stepPiAiReasoningPatch",
    discovery: {
      mode: "fixedPath",
      // 2026-05-29: package renamed @mariozechner/pi-ai → @earendil-works/pi-ai
      // in OpenClaw 2026.5.22. File path within the package is unchanged.
      // Anchors + transform also re-anchored above for the new block shape.
      relPath:
        "node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js",
    },
    anchors: [
      REASONING_ROUTER_ANCHOR_AFTER_IMPORTS,
      REASONING_ROUTER_ANCHOR_REASONING_BLOCK,
    ],
    transform: reasoningRouterTransform,
    // It's a custom feature, not a bug workaround — upstream will never ship it.
    detectNativeFix: undefined,
    restartNeeded: true,
    why:
      "Routes reasoning effort by message content when the caller leaves " +
      "options.reasoningEffort undefined. Without it, codex requests bill the " +
      "wrong effort tier. Live fleet-wide via stepPiAiReasoningPatch since v112. " +
      "Re-anchored 2026-05-29 for OpenClaw 2026.5.22 (package rename + block shape).",
    ref: "lib/vm-reconcile.ts:stepPiAiReasoningPatch; CLAUDE.md Rule 71",
  },
  {
    id: "typing-keepalive",
    // The v118 patch embeds the sentinel once (in the shim comment); Rule 63's
    // verify uses `grep -c … → 1`. The __instaclawTKStart/Stop identifiers
    // recur, but the human-readable sentinel string appears once.
    sentinel: TYPING_KEEPALIVE_SENTINEL,
    minSentinelCount: 1,
    kind: "bugfix",
    rollout: "parked",
    managedBy: "engine",
    discovery: {
      mode: "contentGlob",
      searchDirRel: "dist/extensions/telegram",
      // Unique to the telegram bot bundle chunk regardless of hash rename.
      discriminator:
        'sendChatActionHandler.sendChatAction(chatId, "typing"',
    },
    anchors: [
      TYPING_KEEPALIVE_ANCHOR_SENDTYPING,
      TYPING_KEEPALIVE_ANCHOR_FINAL,
    ],
    transform: typingKeepaliveTransform,
    detectNativeFix: typingDetectNativeFix,
    restartNeeded: true,
    why:
      "Kept the Telegram typing indicator alive past its ~5s TTL during long " +
      "LLM calls. PARKED after the v118 fleet incident (Rule 63/64). Likely " +
      "obsolete on 2026.5.x where upstream event-loop fixes make the native " +
      "createTypingKeepaliveLoop fire on schedule — run verify --native to confirm.",
    ref: "CLAUDE.md Rule 63 (PARKED), Rule 64; commit 554cc581 (reverted in v119)",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const NVM_PREAMBLE =
  'export LD_LIBRARY_PATH="$HOME/local-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" && ' +
  'export NVM_DIR="$HOME/.nvm" && ' +
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && ' +
  'export PATH="$HOME/.nvm/versions/node/$(ls -1v "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"';

export type PatchStatus =
  | "applied" // sentinel present at expected count — patch is live
  | "missing" // pristine, anchors present — patch CAN be (re)applied
  | "anchor-drift" // anchors absent — upstream changed the file; re-anchor needed
  | "native-fixed" // upstream now implements this; patch unnecessary
  | "target-missing" // the file could not be located on disk
  | "no-transform" // descriptor has no body captured yet (apply only)
  | "ssh-fail"
  | "applied-now" // apply path: was missing, now applied this run
  | "verify-failed" // apply path: write/syntax/verify failed (rolled back)
  | "skipped-rollout" // apply path: filtered out by rollout stage
  | "dry-run";

export interface PatchResult {
  id: string;
  status: PatchStatus;
  detail: string;
  /** absolute on-disk path resolved for this patch (when found). */
  targetPath?: string;
  restartNeeded?: boolean;
}

async function resolveOpenclawRoot(ssh: PatchSSH): Promise<string | null> {
  // $(npm root -g)/openclaw is node-version-independent (no hardcoded v22.22.2).
  const r = await ssh.execCommand(
    `${NVM_PREAMBLE} && echo "$(npm root -g)/openclaw"`,
  );
  const root = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!root || r.code !== 0) return null;
  // Confirm it exists.
  const exists = await ssh.execCommand(
    `[ -d "${root}" ] && echo YES || echo NO`,
  );
  return exists.stdout.includes("YES") ? root : null;
}

async function discoverTarget(
  ssh: PatchSSH,
  root: string,
  discovery: PatchDiscovery,
): Promise<string | null> {
  if (discovery.mode === "fixedPath") {
    const p = `${root}/${discovery.relPath}`;
    const exists = await ssh.execCommand(`[ -f "${p}" ] && echo YES || echo NO`);
    return exists.stdout.includes("YES") ? p : null;
  }
  // contentGlob: locate the (possibly hash-renamed) chunk by unique content.
  // Single-quote-safe: the discriminator is embedded in a grep -F pattern via a
  // heredoc-free fixed-string match to avoid shell-escaping the JS substring.
  const b64 = Buffer.from(discovery.discriminator, "utf-8").toString("base64");
  const dir = `${root}/${discovery.searchDirRel}`;
  const r = await ssh.execCommand(
    `PAT="$(echo '${b64}' | base64 -d)"; ` +
      `grep -rlF "$PAT" "${dir}" --include='*.js' 2>/dev/null | head -5`,
  );
  const matches = r.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // Ambiguous discriminator — refuse rather than patch the wrong file.
    // Caller surfaces this as a drift-class failure.
    return `__AMBIGUOUS__:${matches.join(",")}`;
  }
  return matches[0];
}

async function readFile(ssh: PatchSSH, path: string): Promise<string | null> {
  const r = await ssh.execCommand(`cat "${path}"`);
  if (r.code !== 0) return null;
  return r.stdout;
}

/**
 * VERIFY (read-only). For each selected patch, report its on-disk status.
 * This is the headline mechanism that catches a patch silently disabled by an
 * upgrade (anchor-drift) or made redundant by an upgrade (native-fixed).
 */
export async function verifyOpenClawPatches(
  ssh: PatchSSH,
  opts: { ids?: string[] } = {},
): Promise<PatchResult[]> {
  const root = await resolveOpenclawRoot(ssh);
  if (!root) {
    return selectPatches(opts.ids).map((p) => ({
      id: p.id,
      status: "ssh-fail" as PatchStatus,
      detail: "could not resolve $(npm root -g)/openclaw",
    }));
  }
  const out: PatchResult[] = [];
  for (const patch of selectPatches(opts.ids)) {
    out.push(await verifyOne(ssh, root, patch));
  }
  return out;
}

async function verifyOne(
  ssh: PatchSSH,
  root: string,
  patch: OpenClawPatch,
): Promise<PatchResult> {
  const target = await discoverTarget(ssh, root, patch.discovery);
  if (!target) {
    return {
      id: patch.id,
      status: "target-missing",
      detail: `no file matched discovery (${describeDiscovery(patch.discovery)})`,
    };
  }
  if (target.startsWith("__AMBIGUOUS__:")) {
    return {
      id: patch.id,
      status: "anchor-drift",
      detail: `discriminator matched multiple files: ${target.slice("__AMBIGUOUS__:".length)}`,
    };
  }
  const src = await readFile(ssh, target);
  if (src == null) {
    return { id: patch.id, status: "ssh-fail", detail: `cat failed: ${target}`, targetPath: target };
  }

  const sentinelCount = countOccurrences(src, patch.sentinel);
  if (sentinelCount >= patch.minSentinelCount) {
    return {
      id: patch.id,
      status: "applied",
      detail: `sentinel x${sentinelCount} (>= ${patch.minSentinelCount})`,
      targetPath: target,
    };
  }

  // Not applied. Distinguish native-fixed vs anchor-drift vs cleanly-missing.
  if (patch.kind === "bugfix" && patch.detectNativeFix?.(src)) {
    return {
      id: patch.id,
      status: "native-fixed",
      detail: "upstream now implements this — patch unnecessary; safe to keep parked/delete",
      targetPath: target,
    };
  }
  const anchorsPresent = patch.anchors.every((a) => src.includes(a));
  if (!anchorsPresent) {
    const missing = patch.anchors.filter((a) => !src.includes(a)).length;
    return {
      id: patch.id,
      status: "anchor-drift",
      detail: `${missing}/${patch.anchors.length} anchor(s) absent — upstream changed the file shape; re-anchor needed`,
      targetPath: target,
    };
  }
  return {
    id: patch.id,
    status: "missing",
    detail: "pristine; anchors present; patch can be (re)applied",
    targetPath: target,
  };
}

export interface ApplyOptions {
  /** Apply patches at these rollout stages. Default: ["fleet"]. */
  rollouts?: RolloutStage[];
  /** Restrict to these patch ids. */
  ids?: string[];
  dryRun?: boolean;
}

/**
 * APPLY. Reproduces the gold-standard discipline for each selected patch:
 * sentinel-skip → discover → anchor-check → transform → pre-write verify
 * (sentinel count + brace balance) → backup → atomic base64 write →
 * verify-after-write → node --check → rollback-on-failure.
 *
 * Idempotent: an already-applied patch returns "applied" and writes nothing.
 */
export async function applyOpenClawPatches(
  ssh: PatchSSH,
  opts: ApplyOptions = {},
): Promise<PatchResult[]> {
  const rollouts = opts.rollouts ?? ["fleet"];
  const root = await resolveOpenclawRoot(ssh);
  if (!root) {
    return selectPatches(opts.ids).map((p) => ({
      id: p.id,
      status: "ssh-fail" as PatchStatus,
      detail: "could not resolve $(npm root -g)/openclaw",
    }));
  }
  const out: PatchResult[] = [];
  for (const patch of selectPatches(opts.ids)) {
    if (!rollouts.includes(patch.rollout)) {
      out.push({
        id: patch.id,
        status: "skipped-rollout",
        detail: `rollout="${patch.rollout}" not in [${rollouts.join(",")}]`,
      });
      continue;
    }
    out.push(await applyOne(ssh, root, patch, opts.dryRun ?? false));
  }
  return out;
}

async function applyOne(
  ssh: PatchSSH,
  root: string,
  patch: OpenClawPatch,
  dryRun: boolean,
): Promise<PatchResult> {
  if (!patch.transform) {
    return {
      id: patch.id,
      status: "no-transform",
      detail:
        "patch body not captured into the repo — cannot apply. " +
        (patch.captureInstructions ? `\n${patch.captureInstructions}` : ""),
    };
  }

  const target = await discoverTarget(ssh, root, patch.discovery);
  if (!target) {
    return {
      id: patch.id,
      status: "target-missing",
      detail: `no file matched discovery (${describeDiscovery(patch.discovery)})`,
    };
  }
  if (target.startsWith("__AMBIGUOUS__:")) {
    return {
      id: patch.id,
      status: "anchor-drift",
      detail: `discriminator matched multiple files: ${target.slice("__AMBIGUOUS__:".length)}`,
    };
  }

  const src = await readFile(ssh, target);
  if (src == null) {
    return { id: patch.id, status: "ssh-fail", detail: `cat failed: ${target}`, targetPath: target };
  }

  // Idempotency: already applied?
  if (countOccurrences(src, patch.sentinel) >= patch.minSentinelCount) {
    return { id: patch.id, status: "applied", detail: "sentinel already present", targetPath: target };
  }

  // Native-fixed? Don't apply a patch the upstream already implements.
  if (patch.kind === "bugfix" && patch.detectNativeFix?.(src)) {
    return {
      id: patch.id,
      status: "native-fixed",
      detail: "upstream implements this natively — refusing to apply",
      targetPath: target,
    };
  }

  // Anchors must be present in pristine source.
  const missingAnchors = patch.anchors.filter((a) => !src.includes(a));
  if (missingAnchors.length > 0) {
    return {
      id: patch.id,
      status: "anchor-drift",
      detail: `${missingAnchors.length}/${patch.anchors.length} anchor(s) absent — re-anchor before applying`,
      targetPath: target,
    };
  }

  if (dryRun) {
    return { id: patch.id, status: "dry-run", detail: `would apply to ${target}`, targetPath: target };
  }

  // Transform (pure, in-process).
  const patched = patch.transform(src);

  // Pre-write verify: sentinel count + brace balance.
  const sc = countOccurrences(patched, patch.sentinel);
  if (sc < patch.minSentinelCount) {
    return {
      id: patch.id,
      status: "verify-failed",
      detail: `post-transform sentinel count ${sc} < ${patch.minSentinelCount} (transform didn't take — anchor likely matched 0 sites)`,
      targetPath: target,
    };
  }
  const open = countOccurrences(patched, "{");
  const close = countOccurrences(patched, "}");
  if (open !== close) {
    return {
      id: patch.id,
      status: "verify-failed",
      detail: `post-transform brace imbalance (${open} vs ${close})`,
      targetPath: target,
    };
  }

  // Backup + atomic write via base64 (avoids shell-escaping the JS body).
  const bak = `${target}.pre-${patch.id}.bak`;
  const b64 = Buffer.from(patched, "utf-8").toString("base64");
  const write = await ssh.execCommand(
    `cp "${target}" "${bak}" 2>/dev/null || true; ` +
      `printf '%s' '${b64}' | base64 -d > "${target}.tmp" && mv "${target}.tmp" "${target}"`,
  );
  if (write.code !== 0) {
    return {
      id: patch.id,
      status: "verify-failed",
      detail: `write failed: ${(write.stderr || write.stdout).slice(0, 200)}`,
      targetPath: target,
    };
  }

  // Verify-after-write (Rule 10).
  const verify = await ssh.execCommand(
    `grep -c "${shellEscapeForGrep(patch.sentinel)}" "${target}" 2>/dev/null || echo 0`,
  );
  if (parseInt(verify.stdout.trim() || "0", 10) < patch.minSentinelCount) {
    await ssh.execCommand(`cp "${bak}" "${target}" 2>/dev/null || true`);
    return {
      id: patch.id,
      status: "verify-failed",
      detail: "post-write sentinel count too low; rolled back from backup",
      targetPath: target,
    };
  }

  // node --check, rollback on failure (Rule 22 — never leave it broken).
  const syntax = await ssh.execCommand(`${NVM_PREAMBLE} && node --check "${target}" 2>&1`);
  if (syntax.code !== 0) {
    await ssh.execCommand(`cp "${bak}" "${target}" 2>/dev/null || true`);
    return {
      id: patch.id,
      status: "verify-failed",
      detail: `node --check failed, rolled back: ${syntax.stdout.slice(0, 200)}`,
      targetPath: target,
    };
  }

  return {
    id: patch.id,
    status: "applied-now",
    detail: `applied + verified (backup at ${bak})`,
    targetPath: target,
    restartNeeded: patch.restartNeeded,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function selectPatches(ids?: string[]): OpenClawPatch[] {
  if (!ids || ids.length === 0) return PATCHES;
  return PATCHES.filter((p) => ids.includes(p.id));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

function describeDiscovery(d: PatchDiscovery): string {
  return d.mode === "fixedPath"
    ? `fixedPath ${d.relPath}`
    : `contentGlob ${d.searchDirRel} ~ "${d.discriminator.slice(0, 40)}…"`;
}

/** grep -c needs the pattern escaped; sentinels are plain strings but may
 * contain regex metachars — escape the common ones. */
function shellEscapeForGrep(s: string): string {
  return s.replace(/[.[\]*^$\\]/g, "\\$&").replace(/"/g, '\\"');
}
