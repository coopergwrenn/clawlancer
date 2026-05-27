/**
 * cron/probe-base-skills-registry — hourly probe for Base skill registry API
 * and upstream URL drift.
 *
 * Two responsibilities, both stateless and read-only:
 *
 *   1. Watch for a Base-native skill registry API to appear at any of
 *      several guessed endpoints. The moment one returns 200 + JSON with
 *      a registry-shaped body, alert (24h dedup) so an operator can plan
 *      flipping BASE_SKILLS_SOURCE_MODE to "registry-api". Per Rule 64
 *      we never auto-flip — Cooper approves the mode change after
 *      testing on vm-1019.
 *
 *   2. HEAD-probe every BASE_SKILL_CATALOG entry's upstreamUrl to detect
 *      drift / 404 / unexpected redirect. Surfaces partner-side URL
 *      changes BEFORE they cause live-fetch fallback noise in production.
 *      Alerts 24h-deduped per entry.
 *
 * Schedule: hourly via vercel.json cron entry.
 *
 * Per Rule 39: this cron never blocks anything fleet-side. It's pure
 * monitoring. Probe failures are EXPECTED today (no Base registry API
 * exists yet); the only loud signal is "an endpoint started returning
 * a registry-shaped response."
 *
 * See PRD §4.6, addendum §1.2 (upstream change vector D + H + I).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { BASE_SKILL_CATALOG, type BaseSkillEntry } from "@/lib/base-skills-registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5000;
const ALERT_COOLDOWN_HOURS = 24;

/**
 * Guessed Base skill registry API endpoints. When Base ships one, the
 * canonical URL appears here. Extend this list as Base publishes hints
 * in docs / blog / changelogs.
 *
 * Add new candidates to the FRONT (most-likely-to-fire first; the loop
 * short-circuits on the first hit to keep latency bounded).
 */
const REGISTRY_API_CANDIDATES: ReadonlyArray<string> = [
  "https://api.base.org/registry/skills",
  "https://api.base.org/v1/skills",
  "https://docs.base.org/api/ai-agents/skills",
  "https://skills.sh/api/v1/skills?source=base",
  "https://skills.sh/api/skills?registry=base",
  "https://mcp.base.org/api/skills",
];

// Conservative shape check — the response should be JSON with one of these
// recognizable top-level shapes. If a probe URL returns 200 + JSON but the
// shape doesn't match, we DON'T alert (it might be a different unrelated
// endpoint). Only matching shape triggers the alert.
function looksLikeRegistryResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  // Common API shapes: { skills: [...] }, { plugins: [...] }, { data: [...] }
  // with at least one entry that has a recognizable skill-plugin field.
  for (const key of ["skills", "plugins", "items", "data", "results"]) {
    const arr = obj[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as Record<string, unknown>;
      if (
        typeof first?.name === "string" ||
        typeof first?.id === "string" ||
        typeof first?.slug === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry-API probe
// ─────────────────────────────────────────────────────────────────────────────

interface RegistryProbeResult {
  url: string;
  status: "ok-and-registry-shaped" | "ok-not-registry" | "non-2xx" | "fetch-failed";
  http_code: number;
  sample?: string;
  error?: string;
}

async function probeOneRegistryEndpoint(url: string): Promise<RegistryProbeResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "instaclaw-base-skills-probe/1 (+https://instaclaw.io)",
      },
    });
    clearTimeout(t);
    if (!res.ok) {
      return { url, status: "non-2xx", http_code: res.status };
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        url,
        status: "ok-not-registry",
        http_code: res.status,
        error: "response body is not JSON",
      };
    }
    if (looksLikeRegistryResponse(body)) {
      return {
        url,
        status: "ok-and-registry-shaped",
        http_code: res.status,
        sample: text.slice(0, 400),
      };
    }
    return {
      url,
      status: "ok-not-registry",
      http_code: res.status,
      sample: text.slice(0, 400),
    };
  } catch (e: unknown) {
    clearTimeout(t);
    const msg = e instanceof Error ? e.message : String(e);
    return { url, status: "fetch-failed", http_code: 0, error: msg.slice(0, 200) };
  }
}

async function probeRegistryEndpoints(): Promise<RegistryProbeResult[]> {
  // Sequential to keep total runtime bounded even if multiple time out.
  // List is short (~6 entries) so 6 × 5s worst case = 30s.
  const results: RegistryProbeResult[] = [];
  for (const url of REGISTRY_API_CANDIDATES) {
    results.push(await probeOneRegistryEndpoint(url));
  }
  return results;
}

async function dispatchRegistryAlertIfNeeded(hit: RegistryProbeResult): Promise<void> {
  const supabase = getSupabase();
  const urlHash = simpleHash(hit.url);
  const dedupKey = `base_skills_registry_api:${urlHash}`;
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", dedupKey)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) return;

  const subject = `[P1] Base skills registry API detected at ${hit.url}`;
  const body =
    `cron/probe-base-skills-registry detected a registry-shaped JSON response.\n\n` +
    `URL:        ${hit.url}\n` +
    `HTTP code:  ${hit.http_code}\n\n` +
    `Sample response body (first 400 bytes):\n${hit.sample ?? "<unavailable>"}\n\n` +
    `Recommended next steps:\n` +
    `  1. Inspect the full response — confirm it's the canonical Base skills registry.\n` +
    `  2. Implement fetchFromRegistryApi() + fetchCatalogFromRegistryApi() in\n` +
    `     lib/base-skills-registry.ts against this URL.\n` +
    `  3. Test the new mode on vm-1019: BASE_SKILLS_SOURCE_MODE=registry-api\n` +
    `     npx tsx scripts/_canary-base-skills-mode.ts vm-1019\n` +
    `  4. After Cooper approval (Rule 64): printf 'registry-api' | npx vercel \\\n` +
    `     env add BASE_SKILLS_SOURCE_MODE production\n` +
    `  5. Vercel redeploys; file-drift cron picks up the new mode within ~5 min.\n\n` +
    `Next alert in this category will be suppressed for ${ALERT_COOLDOWN_HOURS}h.`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: dedupKey,
    vm_count: 0,
    details: `url=${hit.url} http=${hit.http_code}`,
  });
  await sendAdminAlertEmail(subject, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream URL drift probe (per catalog entry)
// ─────────────────────────────────────────────────────────────────────────────

interface UpstreamProbeResult {
  entry: string;
  url: string;
  status: "ok" | "not-found" | "forbidden" | "server-error" | "redirected" | "fetch-failed";
  http_code: number;
  error?: string;
}

async function probeOneUpstream(entry: BaseSkillEntry): Promise<UpstreamProbeResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // Use GET (not HEAD) — many static hosts don't implement HEAD properly
    // for raw markdown content. The body is tiny so the cost is acceptable.
    const res = await fetch(entry.upstreamUrl, {
      signal: ctrl.signal,
      headers: {
        accept: "text/markdown, text/plain",
        "user-agent": "instaclaw-base-skills-probe/1 (+https://instaclaw.io)",
      },
      redirect: "manual",
    });
    clearTimeout(t);
    // 3xx = followed-to-different-host could indicate the source moved
    if (res.status >= 300 && res.status < 400) {
      return {
        entry: entry.name,
        url: entry.upstreamUrl,
        status: "redirected",
        http_code: res.status,
      };
    }
    if (res.status === 404) {
      return {
        entry: entry.name,
        url: entry.upstreamUrl,
        status: "not-found",
        http_code: 404,
      };
    }
    if (res.status === 403) {
      return {
        entry: entry.name,
        url: entry.upstreamUrl,
        status: "forbidden",
        http_code: 403,
      };
    }
    if (res.status >= 500) {
      return {
        entry: entry.name,
        url: entry.upstreamUrl,
        status: "server-error",
        http_code: res.status,
      };
    }
    if (res.status >= 200 && res.status < 300) {
      return {
        entry: entry.name,
        url: entry.upstreamUrl,
        status: "ok",
        http_code: res.status,
      };
    }
    return {
      entry: entry.name,
      url: entry.upstreamUrl,
      status: "fetch-failed",
      http_code: res.status,
    };
  } catch (e: unknown) {
    clearTimeout(t);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      entry: entry.name,
      url: entry.upstreamUrl,
      status: "fetch-failed",
      http_code: 0,
      error: msg.slice(0, 200),
    };
  }
}

async function probeUpstreams(): Promise<UpstreamProbeResult[]> {
  // Run all upstreams in parallel — they're independent + small.
  return Promise.all(BASE_SKILL_CATALOG.map((e) => probeOneUpstream(e)));
}

async function dispatchUpstreamDriftAlertIfNeeded(
  drift: UpstreamProbeResult,
): Promise<void> {
  const supabase = getSupabase();
  const dedupKey = `base_skills_upstream_drift:${drift.entry}`;
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", dedupKey)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) return;

  const severity = drift.status === "not-found" || drift.status === "forbidden" ? "P2" : "P3";
  const subject = `[${severity}] Base skill upstream changed for "${drift.entry}" (${drift.status})`;
  const body =
    `cron/probe-base-skills-registry detected upstream drift.\n\n` +
    `Skill:      ${drift.entry}\n` +
    `URL:        ${drift.url}\n` +
    `Status:     ${drift.status}\n` +
    `HTTP code:  ${drift.http_code}\n` +
    `Error:      ${drift.error ?? "<none>"}\n\n` +
    `The vendored copy on every VM is intact and serves the agent as normal\n` +
    `(per Rule 39, this is a warning not an error). The concern is that\n` +
    `BASE_SKILLS_SOURCE_MODE=live-fetch (when we eventually flip) would fall\n` +
    `back to the vendored copy every time for this entry until the upstream\n` +
    `is fixed.\n\n` +
    `Recommended next steps:\n` +
    `  1. curl '${drift.url}' — manually verify the failure.\n` +
    `  2. If the canonical URL moved: update BASE_SKILL_CATALOG[<entry>].upstreamUrl\n` +
    `     in lib/base-skills-registry.ts. Then run\n` +
    `     'npx tsx scripts/_fetch-base-skills.ts --check' to confirm.\n` +
    `  3. If the upstream is permanently gone: keep the vendored copy as the\n` +
    `     canonical version + drop the upstreamUrl (set to '' or our own raw).\n\n` +
    `Next alert for this entry will be suppressed for ${ALERT_COOLDOWN_HOURS}h.`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: dedupKey,
    vm_count: 0,
    details: `entry=${drift.entry} status=${drift.status} http=${drift.http_code}`,
  });
  await sendAdminAlertEmail(subject, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Stable short hash of a URL for dedup-key uniqueness. */
function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const [registryResults, upstreamResults] = await Promise.all([
    probeRegistryEndpoints(),
    probeUpstreams(),
  ]);
  const wallMs = Date.now() - start;

  // Registry hit detection — if any endpoint returned a registry-shaped
  // response, fire the alert (deduped 24h).
  const registryHits = registryResults.filter(
    (r) => r.status === "ok-and-registry-shaped",
  );
  if (registryHits.length > 0) {
    logger.warn("probe-base-skills-registry: REGISTRY API DETECTED", {
      route: "cron/probe-base-skills-registry",
      hits: registryHits.map((h) => h.url),
    });
    // Fire-and-forget (we want to return promptly)
    for (const hit of registryHits) {
      void dispatchRegistryAlertIfNeeded(hit).catch((err) => {
        logger.error("probe-base-skills-registry: registry alert dispatch failed", {
          url: hit.url,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // Upstream drift detection — alert for any entry whose URL is not 2xx.
  const upstreamDrifts = upstreamResults.filter((r) => r.status !== "ok");
  for (const drift of upstreamDrifts) {
    void dispatchUpstreamDriftAlertIfNeeded(drift).catch((err) => {
      logger.error("probe-base-skills-registry: drift alert dispatch failed", {
        entry: drift.entry,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info("probe-base-skills-registry: completed", {
    route: "cron/probe-base-skills-registry",
    registry_endpoints_probed: registryResults.length,
    registry_hits: registryHits.length,
    upstream_entries_probed: upstreamResults.length,
    upstream_drifts: upstreamDrifts.length,
    wall_ms: wallMs,
  });

  return NextResponse.json({
    ok: true,
    registry: {
      probed: registryResults.length,
      hits: registryHits.length,
      results: registryResults.map((r) => ({
        url: r.url,
        status: r.status,
        http_code: r.http_code,
      })),
    },
    upstream: {
      probed: upstreamResults.length,
      drifts: upstreamDrifts.length,
      results: upstreamResults,
    },
    wall_ms: wallMs,
  });
}
