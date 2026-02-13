import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";

const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

async function hogql(query: string, apiKey: string) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/@current/query/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: { kind: "HogQLQuery", query },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PostHog query failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "POSTHOG_PERSONAL_API_KEY is not set. Generate one at PostHog → Settings → Personal API Keys." },
      { status: 500 }
    );
  }

  try {
    const [overview, daily, topPages, referrers, recentEvents, geoCountries, geoCities] = await Promise.all([
      // Overview KPIs — last 7 days
      hogql(
        `SELECT
          count() as pageviews,
          count(DISTINCT properties.$session_id) as sessions,
          count(DISTINCT distinct_id) as unique_visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day`,
        apiKey
      ),
      // Daily trend — last 30 days
      hogql(
        `SELECT
          toDate(timestamp) as day,
          count() as views
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 30 day
        GROUP BY day
        ORDER BY day`,
        apiKey
      ),
      // Top pages — last 7 days
      hogql(
        `SELECT
          properties.$pathname as path,
          count() as views,
          count(DISTINCT distinct_id) as unique_visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day
        GROUP BY path
        ORDER BY views DESC
        LIMIT 10`,
        apiKey
      ),
      // Referrers — last 7 days
      hogql(
        `SELECT
          properties.$referrer as referrer,
          count() as visits
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day
          AND properties.$referrer IS NOT NULL
          AND properties.$referrer != ''
        GROUP BY referrer
        ORDER BY visits DESC
        LIMIT 10`,
        apiKey
      ),
      // Recent events — last 24 hours (with user + geo for journey grouping)
      hogql(
        `SELECT
          event,
          properties.$current_url as url,
          timestamp,
          distinct_id,
          properties.$geoip_city_name as city,
          properties.$geoip_country_code as country_code
        FROM events
        WHERE timestamp >= now() - interval 24 hour
        ORDER BY timestamp DESC
        LIMIT 100`,
        apiKey
      ),
      // Country-level geo — last 7 days
      hogql(
        `SELECT
          properties.$geoip_country_code as country_code,
          properties.$geoip_country_name as country_name,
          count() as pageviews,
          count(DISTINCT distinct_id) as unique_visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day
          AND properties.$geoip_country_code IS NOT NULL
        GROUP BY country_code, country_name
        ORDER BY pageviews DESC
        LIMIT 50`,
        apiKey
      ),
      // City-level geo — last 7 days
      hogql(
        `SELECT
          properties.$geoip_city_name as city_name,
          properties.$geoip_country_code as country_code,
          count() as pageviews,
          count(DISTINCT distinct_id) as unique_visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day
          AND properties.$geoip_city_name IS NOT NULL
        GROUP BY city_name, country_code
        ORDER BY pageviews DESC
        LIMIT 15`,
        apiKey
      ),
    ]);

    return NextResponse.json({
      overview: overview.results?.[0] || [0, 0, 0],
      daily: daily.results || [],
      topPages: topPages.results || [],
      referrers: referrers.results || [],
      recentEvents: recentEvents.results || [],
      geoCountries: geoCountries.results || [],
      geoCities: geoCities.results || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
