"use client";

/**
 * ModelBrowserModal - the model picker as a moment (D1 step c).
 *
 * Honest-by-construction. apiMode gates the content; every visible choice is a
 * model the user actually gets:
 *   - CREDIT (all_inclusive | null | loading): "Automatic" (the router picks the
 *     best of Fast/Balanced/Most capable per task) + "Fable 5" (the one sticky
 *     override, real 38-credit cost). The three auto-tiers are SHOWN inside
 *     Automatic as what the router spans, never as four false sticky picks
 *     (contained D1(B): only Fable is honored for credit users).
 *   - BYOK: the full capability ladder, every pick sticky (BYOK is direct to
 *     Anthropic, no router), legacy collapsed under family, forgiving search.
 *
 * Material + motion match the composer's considered hand: Raycast glass
 * (var(--card) + the 3-layer shadow), spring open, lit-pill selected state,
 * the Claude sunburst coral-on-select (#D97757, the brand mark's own color).
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Search, Check, X, ChevronDown, Zap, Scale, Gem, Sparkles } from "lucide-react";
import { ClaudeLogo } from "@/components/icons/claude-logo";
import { SELECTABLE_MODELS, getRegistryCreditWeight, type ModelEntry } from "@/lib/model-registry";

type ApiMode = "byok" | "all_inclusive" | null;

const GLASS_SHADOW =
  "0 1px 2px rgba(0,0,0,0.04), 0 16px 48px -12px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.05)";
const SELECTED_BG = "linear-gradient(180deg, rgba(220,103,67,0.07), rgba(220,103,67,0.15))";
const SELECTED_SHADOW =
  "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(220,103,67,0.12), 0 1px 3px -1px rgba(220,103,67,0.20)";

const FAMILY_META: Record<
  ModelEntry["family"],
  { tier: string; glyph: typeof Zap; blurb: string }
> = {
  haiku: { tier: "Fast", glyph: Zap, blurb: "Quick questions and rapid back-and-forth" },
  sonnet: { tier: "Balanced", glyph: Scale, blurb: "The everyday default for writing, coding, and analysis" },
  opus: { tier: "Most capable", glyph: Gem, blurb: "Hardest reasoning and complex multi-step work" },
  fable: { tier: "Premium", glyph: Sparkles, blurb: "The most powerful model, for your hardest work" },
};

const FAMILY_ORDER: ModelEntry["family"][] = ["haiku", "sonnet", "opus", "fable"];
const FAMILY_SYNONYMS: Record<ModelEntry["family"], string[]> = {
  haiku: ["fast", "cheap", "quick", "cheapest"],
  sonnet: ["balanced", "default", "everyday", "recommended"],
  opus: ["capable", "smart", "powerful", "best", "newest", "latest"],
  fable: ["powerful", "max", "strongest", "premium", "best"],
};

function searchableText(m: ModelEntry): string {
  return [m.displayName, m.displayNameWithVendor, m.family, FAMILY_META[m.family].tier, "anthropic", "claude", ...FAMILY_SYNONYMS[m.family]]
    .join(" ")
    .toLowerCase();
}

export interface ModelBrowserModalProps {
  open: boolean;
  onClose: () => void;
  apiMode: ApiMode;
  /** The current selection. For credit (all_inclusive): the pinned model id, or
   *  "automatic" when nothing is pinned. For BYOK: the default_model id. */
  currentModel: string;
  /** apiMode still resolving from /api/vm/status - fail closed to the credit choices. */
  loading?: boolean;
  onSelect: (modelId: string) => void;
}

export function ModelBrowserModal({
  open,
  onClose,
  apiMode,
  currentModel,
  loading = false,
  onSelect,
}: ModelBrowserModalProps) {
  const isByok = apiMode === "byok" && !loading;
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState<Record<string, boolean>>({});

  // Family groups: current models per family + legacy collapsed. Shared by the
  // BYOK ladder and the credit pinnable ladder (same data, different row chrome).
  // For credit the search box never renders, so `query` stays "" = the full set.
  const byokGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FAMILY_ORDER.map((family) => {
      const all = SELECTABLE_MODELS.filter((m) => m.family === family);
      const match = (m: ModelEntry) => (q ? searchableText(m).includes(q) : true);
      const current = all.filter((m) => !m.legacy && match(m)).sort((a, b) => b.displayName.localeCompare(a.displayName));
      const legacy = all.filter((m) => m.legacy && match(m)).sort((a, b) => b.displayName.localeCompare(a.displayName));
      return { family, current, legacy };
    }).filter((g) => g.current.length > 0 || g.legacy.length > 0);
  }, [query]);

  const byokHasResults = byokGroups.length > 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[100]"
            style={{ background: "rgba(0,0,0,0.42)", backdropFilter: "blur(3px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.13, ease: "easeIn" } }}
            onClick={onClose}
          />

          {/* Positioner: flex-centers on desktop, pins to bottom (sheet) on mobile.
              Centering via flex (not translate) so it never fights framer's transform. */}
          <div className="fixed inset-0 z-[101] flex items-end justify-center sm:items-center pointer-events-none">
          <motion.div
            className="pointer-events-auto w-full sm:w-[424px] flex flex-col rounded-t-[28px] sm:rounded-[28px] overflow-hidden"
            style={{ background: "var(--card)", boxShadow: GLASS_SHADOW, maxHeight: "min(82vh, 660px)" }}
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 500, damping: 34 } }}
            exit={{ opacity: 0, y: 18, scale: 0.98, transition: { duration: 0.14, ease: "easeIn" } }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
              <div>
                <h2 className="text-[15px] font-semibold" style={{ color: "var(--foreground)" }}>
                  {isByok ? "Choose a model" : "How your agent picks"}
                </h2>
                {isByok && (
                  <p className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                    Billed to your Anthropic key
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer transition-colors hover:opacity-70"
                style={{ color: "var(--muted)" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* BYOK search */}
            {isByok && (
              <div className="px-4 pb-2 shrink-0">
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-xl"
                  style={{ background: "rgba(0,0,0,0.04)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.05)" }}
                >
                  <Search className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models"
                    className="bg-transparent outline-none text-[13px] w-full"
                    style={{ color: "var(--foreground)" }}
                  />
                  {query && (
                    <button onClick={() => setQuery("")} aria-label="Clear search" className="cursor-pointer" style={{ color: "var(--muted)" }}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Body */}
            <div className="overflow-y-auto px-3 pb-3 flex flex-col gap-1">
              {!isByok ? (
                <CreditBody
                  loading={loading}
                  groups={byokGroups}
                  currentModel={currentModel}
                  showLegacy={showLegacy}
                  setShowLegacy={setShowLegacy}
                  onSelect={onSelect}
                  onClose={onClose}
                />
              ) : byokHasResults ? (
                <ByokBody
                  groups={byokGroups}
                  currentModel={currentModel}
                  showLegacy={showLegacy}
                  setShowLegacy={setShowLegacy}
                  onSelect={onSelect}
                  onClose={onClose}
                />
              ) : (
                <EmptySearch query={query} onClear={() => setQuery("")} />
              )}
            </div>
          </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ── Credit state: Automatic + the pinnable ladder ───────────────────────── */

function CreditBody({
  loading,
  groups,
  currentModel,
  showLegacy,
  setShowLegacy,
  onSelect,
  onClose,
}: {
  loading: boolean;
  groups: { family: ModelEntry["family"]; current: ModelEntry[]; legacy: ModelEntry[] }[];
  currentModel: string;
  showLegacy: Record<string, boolean>;
  setShowLegacy: (v: Record<string, boolean>) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const pick = (id: string) => { onSelect(id); onClose(); };
  const autoSelected = currentModel === "automatic";

  return (
    <>
      {/* Automatic — the recommended default, on top with dignity. The one row
          that chooses per message; everything below is a flat lock. */}
      <motion.button
        whileTap={{ scale: 0.985 }}
        transition={{ type: "spring", stiffness: 500, damping: 20, mass: 0.85 }}
        onClick={() => pick("automatic")}
        className="text-left rounded-2xl p-3.5 cursor-pointer transition-colors"
        style={{
          background: autoSelected ? SELECTED_BG : "rgba(0,0,0,0.025)",
          boxShadow: autoSelected ? SELECTED_SHADOW : "inset 0 0 0 1px rgba(0,0,0,0.05)",
          opacity: loading ? 0.6 : 1,
        }}
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: autoSelected ? "rgba(220,103,67,0.14)" : "rgba(0,0,0,0.05)" }}>
              <Sparkles className="w-4 h-4" style={{ color: autoSelected ? "var(--accent)" : "var(--muted)" }} />
            </span>
            <span className="flex items-center gap-2">
              <span className="text-[14px] font-semibold" style={{ color: autoSelected ? "var(--accent)" : "var(--foreground)" }}>Automatic</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: "rgba(220,103,67,0.12)", color: "var(--accent)" }}>Recommended</span>
            </span>
          </span>
          {autoSelected && <Check className="w-4 h-4" style={{ color: "var(--accent)" }} />}
        </div>
        <p className="text-[12px] mt-2 leading-relaxed" style={{ color: "var(--foreground)", opacity: 0.78 }}>
          We pick the best model for each message.
        </p>
        <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
          1 to 19 credits per message, matched to what you ask.
        </p>
      </motion.button>

      {/* Lock-one-model section. The flat / every-message / no-switching framing
          lives HERE once — the honest counterpoint to Automatic — so each row
          below stays a clean name + price. */}
      <div className="px-1.5 pt-3.5 pb-0.5">
        <p className="text-[10px] font-semibold tracking-wide uppercase" style={{ color: "var(--muted)" }}>
          Or lock one model
        </p>
        <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--muted)", opacity: 0.85 }}>
          Runs every message at a flat rate. No automatic switching.
        </p>
      </div>

      {/* Capability-first groups: one headline model per tier, older versions
          tucked under disclosure (curate-and-disclose — stays clean as more
          models land). */}
      {groups.map(({ family, current, legacy }) => {
        const headline = current[0];
        const older = [...current.slice(1), ...legacy];
        if (!headline) return null;
        return (
          <div key={family} className="flex flex-col">
            <p className="text-[10px] font-semibold tracking-wide uppercase px-1.5 pt-2 pb-1" style={{ color: "var(--muted)" }}>
              {FAMILY_META[family].tier}
            </p>
            <CreditTierRow m={headline} selected={headline.id === currentModel} onPick={pick} />
            {older.length > 0 && (
              <>
                <button
                  onClick={() => setShowLegacy({ ...showLegacy, [family]: !showLegacy[family] })}
                  className="flex items-center gap-1 px-2 py-1.5 text-[11px] cursor-pointer transition-opacity hover:opacity-70"
                  style={{ color: "var(--muted)" }}
                >
                  <ChevronDown className="w-3 h-3 transition-transform" style={{ transform: showLegacy[family] ? "rotate(180deg)" : "none" }} />
                  older versions
                </button>
                {showLegacy[family] && older.map((m) => (
                  <CreditTierRow key={m.id} m={m} selected={m.id === currentModel} onPick={pick} />
                ))}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function CreditTierRow({ m, selected, onPick }: { m: ModelEntry; selected: boolean; onPick: (id: string) => void }) {
  const weight = getRegistryCreditWeight(m.id);
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 18, mass: 0.85 }}
      onClick={() => onPick(m.id)}
      className="w-full rounded-xl px-2 py-2 cursor-pointer transition-colors flex items-center justify-between text-left"
      style={{
        background: selected ? SELECTED_BG : "transparent",
        boxShadow: selected ? SELECTED_SHADOW : "none",
        color: selected ? "var(--accent)" : "var(--foreground)",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? SELECTED_BG : "transparent"; }}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: selected ? "rgba(220,103,67,0.14)" : "rgba(0,0,0,0.05)" }}>
          <ClaudeLogo className="w-4 h-4" style={{ color: selected ? "#D97757" : "var(--muted)" }} />
        </span>
        <span className="text-[13px] font-medium truncate">{m.displayName}</span>
      </span>
      <span className="flex items-center gap-2 shrink-0 pl-2">
        <span className="text-[12px] tabular-nums" style={{ color: selected ? "var(--accent)" : "var(--muted)" }}>
          <span className="font-semibold">{weight}</span>
          <span style={{ opacity: 0.7 }}> {weight === 1 ? "credit" : "credits"}/msg</span>
        </span>
        {selected && <Check className="w-3.5 h-3.5" />}
      </span>
    </motion.button>
  );
}

/* ── BYOK state: full capability ladder ──────────────────────────────────── */

function ByokBody({
  groups,
  currentModel,
  showLegacy,
  setShowLegacy,
  onSelect,
  onClose,
}: {
  groups: { family: ModelEntry["family"]; current: ModelEntry[]; legacy: ModelEntry[] }[];
  currentModel: string;
  showLegacy: Record<string, boolean>;
  setShowLegacy: (v: Record<string, boolean>) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const pick = (id: string) => { onSelect(id); onClose(); };
  return (
    <>
      {groups.map(({ family, current, legacy }) => (
        <div key={family} className="flex flex-col">
          <p className="text-[10px] font-semibold tracking-wide uppercase px-1.5 pt-2 pb-1" style={{ color: "var(--muted)" }}>
            {FAMILY_META[family].tier}
          </p>
          {current.map((m, i) => (
            <ModelRow
              key={m.id}
              m={m}
              selected={m.id === currentModel}
              // Version qualifier only where there's more than one version to
              // disambiguate (Opus). Blurb shown ONCE per family (the primary
              // row) - the group header already names the capability, so
              // repeating it on every version is noise.
              qualifier={family === "opus" ? (["Latest", "Previous", "Prior"][i] ?? null) : null}
              showBlurb={i === 0}
              onPick={pick}
            />
          ))}
          {legacy.length > 0 && (
            <>
              <button
                onClick={() => setShowLegacy({ ...showLegacy, [family]: !showLegacy[family] })}
                className="flex items-center gap-1 px-2 py-1.5 text-[11px] cursor-pointer transition-opacity hover:opacity-70"
                style={{ color: "var(--muted)" }}
              >
                <ChevronDown className="w-3 h-3 transition-transform" style={{ transform: showLegacy[family] ? "rotate(180deg)" : "none" }} />
                older versions
              </button>
              {showLegacy[family] && legacy.map((m) => (
                <ModelRow key={m.id} m={m} selected={m.id === currentModel} qualifier="Older" showBlurb={false} onPick={pick} />
              ))}
            </>
          )}
        </div>
      ))}
    </>
  );
}

function ModelRow({ m, selected, qualifier, showBlurb, onPick }: { m: ModelEntry; selected: boolean; qualifier: string | null; showBlurb: boolean; onPick: (id: string) => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 18, mass: 0.85 }}
      onClick={() => onPick(m.id)}
      className="w-full rounded-xl px-2 py-2 cursor-pointer transition-colors flex items-center justify-between text-left"
      style={{
        background: selected ? SELECTED_BG : "transparent",
        boxShadow: selected ? SELECTED_SHADOW : "none",
        color: selected ? "var(--accent)" : "var(--foreground)",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? SELECTED_BG : "transparent"; }}
    >
      <span className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: selected ? "rgba(220,103,67,0.14)" : "rgba(0,0,0,0.05)" }}>
          <ClaudeLogo className="w-4 h-4" style={{ color: selected ? "#D97757" : "var(--muted)" }} />
        </span>
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium">{m.displayName}</span>
            {qualifier && (
              <span
                className="text-[9px] px-1 py-0.5 rounded-full font-medium"
                style={
                  qualifier === "Latest"
                    ? { background: "rgba(220,103,67,0.12)", color: "var(--accent)" }
                    : { background: "rgba(0,0,0,0.05)", color: "var(--muted)" }
                }
              >
                {qualifier}
              </span>
            )}
          </span>
          {showBlurb && (
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>{FAMILY_META[m.family].blurb}</span>
          )}
        </span>
      </span>
      {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
    </motion.button>
  );
}

/* ── Empty search (BYOK, no match) ───────────────────────────────────────── */

function EmptySearch({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6 gap-2">
      <ClaudeLogo className="w-8 h-8" style={{ color: "var(--muted)", opacity: 0.35 }} />
      <p className="text-[13px]" style={{ color: "var(--foreground)", opacity: 0.8 }}>
        No models match &ldquo;{query}&rdquo;
      </p>
      <button onClick={onClear} className="text-[12px] font-medium cursor-pointer transition-opacity hover:opacity-70" style={{ color: "var(--accent)" }}>
        Clear search
      </button>
    </div>
  );
}
