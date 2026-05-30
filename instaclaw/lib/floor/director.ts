/**
 * The Floor — work-activity director (docs/prd/the-floor.md §10.4, §27).
 *
 * The BRAIN. A pure, deterministic state machine that turns real agent activity
 * events into Larry's on-screen *behavior*. It is intentionally:
 *   - PURE: no React, no renderer, no store, no I/O, no Date.now() inside.
 *     Time is always passed in (`now`), so every transition is reproducible and
 *     unit-testable with zero infrastructure (scripts/_test-floor-director.ts).
 *   - INTENT-BASED, not micro-timed-animation: the director decides WHAT Larry
 *     is doing (`behavior`); the renderer decides HOW to express it (walk, bob,
 *     interpolate). One brain, one body, clean seam.
 *
 * Design mirrors the Village's encounter-engine *structure* (one owner of
 * motion, explicit states, time-driven transitions) but is fed WORK signals
 * instead of social ones (PRD §10.3 Bucket B).
 *
 * The cardinal rule (PRD §9 — the honesty thesis, the whole moat): a behavior
 * change happens IFF a real event happened or real time elapsed. The director
 * NEVER fabricates activity. When nothing is happening, Larry idles — honestly.
 *
 * ── The two-signal reality (PRD §35) ────────────────────────────────────────
 * MVP receives two bracketing events per interaction: `message_in` (arrival,
 * ~instant) and `complete`/`error` (resolution, 60–90s later). There is no
 * stream of "still working" events in MVP (the proxy producer is v1). So after
 * the perk-up one-shot, the director auto-advances `incoming → working` and
 * HOLDS `working` until the terminal event arrives. The 60–90s of honest
 * "typing" IS the real generation time — truthful by construction. A safety
 * timeout returns to idle if a terminal event is ever dropped.
 */

export type FloorBehavior =
  | "offline" // agent frozen / unreachable — lights off, Larry absent
  | "asleep" // agent suspended / hibernating — Larry in bed, static (rests GPU)
  | "idle" // online, nothing happening — gentle life, escalates with idleLevel
  | "incoming" // a user message just arrived — the PERK-UP (the magic moment)
  | "working" // agent generating — typing at the desk (intensity-tiered)
  | "celebrating" // a request resolved — a happy hop
  | "stumbling"; // an error — a comedic, recoverable wobble (never an alarm)

export type FloorStation =
  | "browser"
  | "trading"
  | "mailroom"
  | "memory"
  | "studio"
  | "workbench";

export type FloorChannel = "telegram" | "imessage" | "discord" | "web";

/** The activity event shape the director consumes (subset of the DB row). */
export interface FloorEvent {
  kind:
    | "message_in"
    | "working"
    | "tool"
    | "complete"
    | "error"
    | "heartbeat"
    | "idle"
    | "skill_added";
  station?: FloorStation | null;
  intensity?: 1 | 2 | 3 | null;
  channel?: FloorChannel | null;
  toolName?: string | null;
}

/** The director's complete state. Serializable; no functions, no refs. */
export interface DirectorState {
  behavior: FloorBehavior;
  /** ms timestamp the current behavior was entered (drives timed transitions). */
  since: number;
  /** 0 = light idle (breathing), 1 = looking around, 2 = napping. */
  idleLevel: 0 | 1 | 2;
  /** Current work effort tier, when known (lamp brightness / "thinking hard"). */
  intensity: 1 | 2 | 3 | null;
  /** Current station target (v1; null in MVP until the proxy emits tool names). */
  station: FloorStation | null;
  /** Channel of the last inbound message — flavor for the ticker/animation. */
  channel: FloorChannel | null;
  /** A monotonically increasing "perk" counter — bumps on every message_in so
   *  the renderer can re-trigger the perk-up one-shot even on rapid repeats. */
  perkSeq: number;
}

/**
 * Timing constants (ms). Exported so tests assert against them and so tuning
 * lives in ONE place. These are intent-level durations, not animation frames.
 */
export const DIRECTOR_TIMING = {
  /** Perk-up one-shot before auto-advancing to working (the "noticed you" beat). */
  PERKUP_MS: 1500,
  /** Max time to hold `working` with no terminal event (dropped-completion guard). */
  WORKING_SAFETY_MS: 180_000,
  /** Celebrate one-shot duration before settling to idle. */
  CELEBRATE_MS: 2_200,
  /** Stumble one-shot duration before settling to idle. */
  STUMBLE_MS: 2_200,
  /** Light idle → "looking around" (idleLevel 1). */
  IDLE_LOOK_MS: 30_000,
  /** "looking around" → napping (idleLevel 2). */
  IDLE_NAP_MS: 120_000,
} as const;

/** A fresh director, idling, as of `now`. */
export function initialDirectorState(now: number): DirectorState {
  return {
    behavior: "idle",
    since: now,
    idleLevel: 0,
    intensity: null,
    station: null,
    channel: null,
    perkSeq: 0,
  };
}

/** Enter a new behavior, stamping `since`. Centralized so `since` is never
 *  forgotten (the bug that would silently freeze every timed transition). */
function enter(
  state: DirectorState,
  behavior: FloorBehavior,
  now: number,
  patch: Partial<DirectorState> = {},
): DirectorState {
  return {
    ...state,
    behavior,
    since: now,
    // idleLevel only means anything in `idle`; reset it on any non-idle entry.
    idleLevel: behavior === "idle" ? (patch.idleLevel ?? 0) : 0,
    ...patch,
  };
}

/**
 * Fold one real activity event into the director. Pure: returns a NEW state.
 * This is where the magic moment lives — a `message_in` event flips behavior to
 * `incoming`, which the renderer expresses as the perk-up.
 */
export function applyEvent(
  state: DirectorState,
  event: FloorEvent,
  now: number,
): DirectorState {
  switch (event.kind) {
    case "message_in":
      // The PERK-UP. Always re-trigger (bump perkSeq) so a second message while
      // still mid-perk still pops — the user must always feel noticed. Reset
      // stale intensity/station from any prior turn (L3) so the new turn doesn't
      // briefly render the last turn's effort tier / station.
      return enter(state, "incoming", now, {
        channel: event.channel ?? state.channel,
        intensity: null,
        station: null,
        perkSeq: state.perkSeq + 1,
      });

    case "working":
    case "tool":
      // The agent is actively working. Carry intensity/station when present.
      return enter(state, "working", now, {
        intensity: event.intensity ?? state.intensity,
        station: event.station ?? null,
      });

    case "complete":
      return enter(state, "celebrating", now, { intensity: null, station: null });

    case "error":
      return enter(state, "stumbling", now, { intensity: null, station: null });

    case "heartbeat":
    case "idle":
    case "skill_added":
      // Ambient / background — no behavior change in MVP. (skill_added gets a
      // "new station" flourish in v1; heartbeat a minor clock-glance.)
      return state;

    default:
      return state;
  }
}

/**
 * Advance time-based transitions. Pure: returns a NEW state (or the same
 * reference if nothing changed, so callers can cheaply skip store updates).
 *
 * Called on the store's slow "logic clock" (~1s). Granularity is intentionally
 * coarse — these are human-perceptible beats, not animation frames.
 */
export function applyTick(state: DirectorState, now: number): DirectorState {
  const elapsed = now - state.since;
  const T = DIRECTOR_TIMING;

  switch (state.behavior) {
    case "incoming":
      // Perk-up complete → settle into working (MVP has no separate "working"
      // event; the next real event will be complete/error 60–90s later, so
      // working IS the honest render of that whole window).
      if (elapsed >= T.PERKUP_MS) return enter(state, "working", now);
      return state;

    case "working":
      // Defensive: a dropped terminal event must not leave Larry typing forever.
      if (elapsed >= T.WORKING_SAFETY_MS) return enter(state, "idle", now);
      return state;

    case "celebrating":
      if (elapsed >= T.CELEBRATE_MS) return enter(state, "idle", now);
      return state;

    case "stumbling":
      if (elapsed >= T.STUMBLE_MS) return enter(state, "idle", now);
      return state;

    case "idle": {
      // Escalate the calm: breathing → looking around → napping. Honest rest,
      // NOT synthetic activity (contrast the Village's ambient-npc wander, which
      // is explicitly banned here — PRD §10.3 Bucket C).
      const targetLevel: 0 | 1 | 2 =
        elapsed >= T.IDLE_NAP_MS ? 2 : elapsed >= T.IDLE_LOOK_MS ? 1 : 0;
      if (targetLevel !== state.idleLevel) {
        // Advance idleLevel WITHOUT resetting `since` — escalation is measured
        // from when idle began, so we don't reset the clock.
        return { ...state, idleLevel: targetLevel };
      }
      return state;
    }

    case "offline":
    case "asleep":
      // Agent-state-driven; only an explicit health update (v1) leaves these.
      return state;

    default:
      return state;
  }
}

/**
 * Apply a health signal (v1 — from /api/vm/status). Health supersedes activity:
 * a suspended agent's Larry sleeps regardless of stale activity rows. MVP does
 * not call this (activity-only), but it's here so the renderer contract is
 * stable and v1 wiring is a one-liner.
 */
export type FloorHealth = "online" | "asleep" | "offline";

export function applyHealth(
  state: DirectorState,
  health: FloorHealth,
  now: number,
): DirectorState {
  if (health === "asleep" && state.behavior !== "asleep")
    return enter(state, "asleep", now);
  if (health === "offline" && state.behavior !== "offline")
    return enter(state, "offline", now);
  if (
    health === "online" &&
    (state.behavior === "asleep" || state.behavior === "offline")
  )
    return enter(state, "idle", now);
  return state;
}

/**
 * A tiny, renderer-facing projection: the human-readable "what is Larry doing"
 * line for the activity ticker (PRD §11 chrome). Pure; derived from behavior.
 */
export function describeBehavior(state: DirectorState): string {
  switch (state.behavior) {
    case "offline":
      return "Larry's office is closed";
    case "asleep":
      return "Larry is asleep";
    case "incoming":
      return "Larry noticed your message";
    case "working":
      if (state.station === "browser") return "Larry is browsing the web";
      if (state.station === "trading") return "Larry is checking the markets";
      if (state.station === "mailroom") return "Larry is sending a message";
      if (state.station === "memory") return "Larry is filing to memory";
      if (state.station === "studio") return "Larry is in the studio";
      if (state.station === "workbench") return "Larry is at the workbench";
      if (state.intensity === 3) return "Larry is thinking hard";
      return "Larry is working on it";
    case "celebrating":
      return "Larry finished";
    case "stumbling":
      return "Larry hit a snag";
    case "idle":
      if (state.idleLevel === 2) return "Larry is taking a nap";
      if (state.idleLevel === 1) return "Larry is looking around";
      return "Larry is ready";
    default:
      return "Larry is here";
  }
}

/**
 * Whether the current behavior needs ongoing animation frames. Drives the
 * renderer's render-on-demand governor (PRD §12): TRUE → keep invalidating;
 * FALSE → let frameloop="demand" rest at ~0 GPU. `asleep`/`offline` and deep
 * idle (napping) are genuinely static and should cost nothing.
 */
export function behaviorNeedsAnimation(state: DirectorState): boolean {
  switch (state.behavior) {
    case "asleep":
    case "offline":
      return false;
    case "idle":
      // Light idle breathes; deep nap is static.
      return state.idleLevel < 2;
    default:
      return true;
  }
}
