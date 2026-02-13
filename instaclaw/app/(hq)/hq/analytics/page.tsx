"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Eye,
  Users,
  TrendingUp,
  Clock,
  RefreshCw,
  Loader2,
  AlertCircle,
  Globe,
  Building2,
} from "lucide-react";
import { WorldMap } from "@/components/hq/world-map";

interface AnalyticsData {
  overview: [number, number, number]; // pageviews, sessions, unique_visitors
  daily: [string, number][]; // [day, views]
  topPages: [string, number, number][]; // [path, views, uniques]
  referrers: [string, number][]; // [referrer, visits]
  recentEvents: [string, string, string, string, string | null, string | null][]; // [event, url, timestamp, distinct_id, city, country_code]
  geoCountries: [string, string, number, number][]; // [country_code, country_name, pageviews, unique_visitors]
  geoCities: [string, string, number, number][]; // [city_name, country_code, pageviews, unique_visitors]
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const REFERRER_LABELS: Record<string, string> = {
  "$direct": "Direct (typed URL)",
  "t.co": "X (Twitter)",
  "l.facebook.com": "Facebook",
  "lm.facebook.com": "Facebook (mobile)",
  "l.instagram.com": "Instagram",
  "out.reddit.com": "Reddit",
  "away.vk.com": "VK",
  "l.messenger.com": "Messenger",
  "linkedin.com": "LinkedIn",
};

function parseDomain(url: string): string {
  if (url in REFERRER_LABELS) return REFERRER_LABELS[url];
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return REFERRER_LABELS[hostname] || hostname;
  } catch {
    return REFERRER_LABELS[url] || url || "Direct (typed URL)";
  }
}

const EVENT_LABELS: Record<string, { label: string; color: "accent" | "muted" }> = {
  $pageview: { label: "Viewed page", color: "accent" },
  $pageleave: { label: "Left page", color: "muted" },
  $autocapture: { label: "Clicked", color: "muted" },
  $web_vitals: { label: "Performance check", color: "muted" },
  $rageclick: { label: "Rage clicked", color: "accent" },
  $exception: { label: "Error", color: "accent" },
};

function eventLabel(event: string): { label: string; color: "accent" | "muted" } {
  return EVENT_LABELS[event] || { label: event.replace(/^\$/, "").replace(/_/g, " "), color: "muted" };
}

// Stable pastel colors for user avatars
const USER_COLORS = [
  "#DC6743", "#5B8DEF", "#43B581", "#FAA61A", "#9B59B6",
  "#E74C3C", "#1ABC9C", "#E67E22", "#3498DB", "#2ECC71",
];

function userColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

function userLabel(id: string, city: string | null, countryCode: string | null): string {
  const parts: string[] = [];
  if (city) parts.push(city);
  if (countryCode) parts.push(countryCode);
  const location = parts.length > 0 ? parts.join(", ") : null;
  const shortId = id.slice(0, 6);
  return location ? `Visitor ${shortId} — ${location}` : `Visitor ${shortId}`;
}

interface UserJourney {
  userId: string;
  label: string;
  color: string;
  events: { event: string; url: string; timestamp: string }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [geoTab, setGeoTab] = useState<"countries" | "cities">("countries");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/hq/analytics");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <AlertCircle className="w-8 h-8" style={{ color: "var(--error)" }} />
        <p className="text-sm" style={{ color: "var(--muted)" }}>{error}</p>
        <button
          onClick={fetchData}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
          style={{ background: "rgba(0,0,0,0.08)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const [pageviews, sessions, uniqueVisitors] = data.overview;
  const pagesPerSession = sessions > 0 ? (pageviews / sessions).toFixed(1) : "0";

  const kpis = [
    { label: "Pageviews", value: pageviews.toLocaleString(), icon: Eye },
    { label: "Unique Visitors", value: uniqueVisitors.toLocaleString(), icon: Users },
    { label: "Sessions", value: sessions.toLocaleString(), icon: TrendingUp },
    { label: "Pages / Session", value: pagesPerSession, icon: Clock },
  ];

  const maxDaily = Math.max(...data.daily.map(([, v]) => v), 1);
  const maxPageViews = Math.max(...data.topPages.map(([, v]) => v), 1);
  const maxReferrerVisits = Math.max(...data.referrers.map(([, v]) => v), 1);

  const countryData = data.geoCountries.map(([code, name, pv, uv]) => ({
    code, name, pageviews: pv, uniqueVisitors: uv,
  }));
  const geoList = geoTab === "countries" ? data.geoCountries : data.geoCities;
  const maxGeoViews = Math.max(...geoList.map(([, , pv]) => pv), 1);

  // Group recent events into user journeys
  const journeys: UserJourney[] = (() => {
    const map = new Map<string, UserJourney>();
    // Events come newest-first; we reverse so journeys read top-to-bottom chronologically
    const sorted = [...data.recentEvents].reverse();
    for (const [event, url, timestamp, userId, city, countryCode] of sorted) {
      if (!map.has(userId)) {
        map.set(userId, {
          userId,
          label: userLabel(userId, city, countryCode),
          color: userColor(userId),
          events: [],
        });
      }
      map.get(userId)!.events.push({ event, url, timestamp });
    }
    // Sort journeys by most recent activity (last event timestamp)
    return Array.from(map.values()).sort((a, b) => {
      const aLast = new Date(a.events[a.events.length - 1].timestamp).getTime();
      const bLast = new Date(b.events[b.events.length - 1].timestamp).getTime();
      return bLast - aLast;
    });
  })();

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Analytics
        </h1>
        <button
          onClick={fetchData}
          disabled={loading}
          className="glass flex items-center gap-1.5 px-3 sm:px-4 py-2 text-sm font-medium cursor-pointer rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          style={{
            boxShadow:
              "0 0 12px 2px rgba(220, 103, 67, 0.15), 0 0 24px 4px rgba(220, 103, 67, 0.08), 0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="glass rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4" style={{ color: "var(--muted)" }} />
                <span className="text-xs" style={{ color: "var(--muted)" }}>{kpi.label}</span>
              </div>
              <p
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px]"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {kpi.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Daily Pageviews Chart */}
      <div className="glass rounded-xl p-4 sm:p-5 mb-6">
        <h2
          className="text-base font-normal tracking-[-0.3px] mb-4"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Daily Pageviews
          <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
            Last 30 days
          </span>
        </h2>
        {data.daily.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>No data yet</p>
        ) : (
          <div className="flex items-end gap-[2px] sm:gap-1" style={{ height: 160 }}>
            {data.daily.map(([day, views], i) => {
              const pct = (views / maxDaily) * 100;
              return (
                <div
                  key={day}
                  className="relative group"
                  style={{ height: "100%", flex: "1 1 0%", maxWidth: 40 }}
                >
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-t transition-colors"
                    style={{
                      height: `${Math.max(pct, 2)}%`,
                      background: "var(--accent)",
                      opacity: 0.7,
                    }}
                  />
                  {/* Tooltip */}
                  <div
                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
                    style={{
                      background: "var(--foreground)",
                      color: "var(--background)",
                    }}
                  >
                    {day}: {views}
                  </div>
                  {/* X-axis label for first and last */}
                  {(i === 0 || i === data.daily.length - 1) && (
                    <span
                      className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap"
                      style={{ color: "var(--muted)" }}
                    >
                      {new Date(day + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Bottom spacing for x-axis labels */}
        {data.daily.length > 0 && <div className="h-5" />}
      </div>

      {/* Visitor Locations */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-6">
        {/* Map */}
        <div className="lg:col-span-2 glass rounded-xl p-4 sm:p-5">
          <h2
            className="text-base font-normal tracking-[-0.3px] mb-3"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Visitor Locations
            <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
              Last 7 days
            </span>
          </h2>
          <WorldMap countries={countryData} />
        </div>

        {/* Ranked list */}
        <div className="glass rounded-xl p-4 sm:p-5">
          {/* Toggle tabs */}
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setGeoTab("countries")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              style={{
                background: geoTab === "countries" ? "rgba(220, 103, 67, 0.12)" : "transparent",
                color: geoTab === "countries" ? "var(--accent)" : "var(--muted)",
              }}
            >
              <Globe className="w-3.5 h-3.5" />
              Countries
            </button>
            <button
              onClick={() => setGeoTab("cities")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              style={{
                background: geoTab === "cities" ? "rgba(220, 103, 67, 0.12)" : "transparent",
                color: geoTab === "cities" ? "var(--accent)" : "var(--muted)",
              }}
            >
              <Building2 className="w-3.5 h-3.5" />
              Cities
            </button>
          </div>

          {geoList.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>No data yet</p>
          ) : (
            <div className="space-y-1.5 overflow-y-auto" style={{ maxHeight: 320 }}>
              {geoList.map(([primary, secondary, views, uniques]) => (
                <div
                  key={`${primary}-${secondary}`}
                  className="relative flex items-center justify-between px-3 py-2 rounded-lg text-sm"
                >
                  <div
                    className="absolute inset-0 rounded-lg"
                    style={{
                      background: "var(--accent)",
                      opacity: 0.08,
                      width: `${(views / maxGeoViews) * 100}%`,
                    }}
                  />
                  <span className="relative truncate mr-3" style={{ maxWidth: "55%" }}>
                    {geoTab === "countries" ? secondary : primary}
                    {geoTab === "cities" && (
                      <span className="text-xs ml-1" style={{ color: "var(--muted)" }}>{secondary}</span>
                    )}
                  </span>
                  <span className="relative text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>
                    {views} views &middot; {uniques} unique
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Top Pages + Referrers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
        {/* Top Pages */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <h2
            className="text-base font-normal tracking-[-0.3px] mb-3"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Top Pages
          </h2>
          {data.topPages.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>No data yet</p>
          ) : (
            <div className="space-y-1.5">
              {data.topPages.map(([path, views, uniques]) => (
                <div
                  key={path}
                  className="relative flex items-center justify-between px-3 py-2 rounded-lg text-sm"
                >
                  <div
                    className="absolute inset-0 rounded-lg"
                    style={{
                      background: "var(--accent)",
                      opacity: 0.08,
                      width: `${(views / maxPageViews) * 100}%`,
                    }}
                  />
                  <span className="relative truncate mr-3" style={{ maxWidth: "60%" }}>
                    {path || "/"}
                  </span>
                  <span className="relative text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>
                    {views} views &middot; {uniques} unique
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Referrers */}
        <div className="glass rounded-xl p-4 sm:p-5">
          <h2
            className="text-base font-normal tracking-[-0.3px] mb-3"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Referrers
          </h2>
          {data.referrers.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>No data yet</p>
          ) : (
            <div className="space-y-1.5">
              {data.referrers.map(([referrer, visits]) => (
                <div
                  key={referrer}
                  className="relative flex items-center justify-between px-3 py-2 rounded-lg text-sm"
                >
                  <div
                    className="absolute inset-0 rounded-lg"
                    style={{
                      background: "var(--accent)",
                      opacity: 0.08,
                      width: `${(visits / maxReferrerVisits) * 100}%`,
                    }}
                  />
                  <span className="relative truncate mr-3" style={{ maxWidth: "70%" }}>
                    {parseDomain(referrer)}
                  </span>
                  <span className="relative text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>
                    {visits} visits
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* User Journeys */}
      <div className="glass rounded-xl p-4 sm:p-5">
        <h2
          className="text-base font-normal tracking-[-0.3px] mb-3"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          User Journeys
          <span className="text-xs ml-2" style={{ color: "var(--muted)", fontFamily: "inherit" }}>
            Last 24 hours
          </span>
        </h2>
        {journeys.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: "var(--muted)" }}>No activity yet</p>
        ) : (
          <div className="space-y-4 overflow-y-auto" style={{ maxHeight: 480 }}>
            {journeys.map((journey) => (
              <div key={journey.userId}>
                {/* User header */}
                <div className="flex items-center gap-2 mb-1.5">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: journey.color }}
                  />
                  <span className="text-xs font-medium">{journey.label}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    &middot; {journey.events.length} {journey.events.length === 1 ? "event" : "events"}
                  </span>
                </div>
                {/* Timeline */}
                <div className="ml-1 border-l-2 pl-3 space-y-0.5" style={{ borderColor: journey.color + "40" }}>
                  {journey.events.map((ev, i) => {
                    const { label, color } = eventLabel(ev.event);
                    const path = ev.url ? (() => { try { return new URL(ev.url).pathname; } catch { return ev.url; } })() : null;
                    return (
                      <div
                        key={`${ev.timestamp}-${i}`}
                        className="flex items-center gap-2 py-1 text-xs"
                      >
                        <span
                          className="shrink-0 px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: color === "accent" ? "rgba(220, 103, 67, 0.1)" : "rgba(0,0,0,0.04)",
                            color: color === "accent" ? "var(--accent)" : "var(--muted)",
                          }}
                        >
                          {label}
                        </span>
                        {path && (
                          <span className="truncate" style={{ color: "var(--muted)" }}>{path}</span>
                        )}
                        <span className="shrink-0 ml-auto" style={{ color: "var(--muted)", opacity: 0.6 }}>
                          {timeAgo(ev.timestamp)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
