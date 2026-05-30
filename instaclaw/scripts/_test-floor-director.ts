/**
 * Contract test for The Floor's work-activity director (lib/floor/director.ts).
 *
 * The director is the BRAIN of the activity→animation pipeline, so it's tested
 * exhaustively with NO renderer and NO store — pure (state, event|tick, now) in,
 * new state out. The headline scenario is the MAGIC MOMENT (PRD §24): a
 * message_in event must flip behavior to `incoming` (perk-up) deterministically,
 * then flow incoming → working → celebrating → idle as real events + time arrive.
 *
 * Run: npx tsx scripts/_test-floor-director.ts
 */

import {
  initialDirectorState,
  applyEvent,
  applyTick,
  applyHealth,
  describeBehavior,
  behaviorNeedsAnimation,
  DIRECTOR_TIMING,
  type DirectorState,
} from "../lib/floor/director";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const T = DIRECTOR_TIMING;
const t0 = 1_000_000; // arbitrary fixed epoch — purity means the value is irrelevant

console.log("\n=== The Floor — director state machine ===\n");

// ── 1. THE MAGIC MOMENT: message_in → perk-up, instantly ────────────────────
console.log("The magic moment (message_in → incoming):");
{
  const idle = initialDirectorState(t0);
  check("starts idle", idle.behavior === "idle");
  const incoming = applyEvent(idle, { kind: "message_in", channel: "telegram" }, t0 + 5);
  check("message_in → incoming", incoming.behavior === "incoming");
  check("perkSeq bumped (renderer re-triggers perk-up)", incoming.perkSeq === 1);
  check("channel captured", incoming.channel === "telegram");
  check("since stamped at event time", incoming.since === t0 + 5);
  check("purity: original idle untouched", idle.behavior === "idle" && idle.perkSeq === 0);

  // L3: a message_in must clear stale intensity/station from a prior turn so the
  // new perk-up doesn't briefly render the last turn's effort tier / station.
  const stale = applyEvent(
    applyEvent(idle, { kind: "tool", station: "trading", intensity: 3 }, t0),
    { kind: "message_in", channel: "telegram" },
    t0 + 1,
  );
  check("L3: message_in resets stale intensity to null", stale.intensity === null);
  check("L3: message_in resets stale station to null", stale.station === null);
}

// ── 2. THE FULL HAPPY PATH: incoming → working → celebrating → idle ─────────
console.log("\nHappy path (incoming → working → celebrating → idle):");
{
  let s: DirectorState = initialDirectorState(t0);
  s = applyEvent(s, { kind: "message_in", channel: "imessage" }, t0);
  check("at incoming", s.behavior === "incoming");

  // Tick before perk-up finishes → still incoming.
  s = applyTick(s, t0 + T.PERKUP_MS - 1);
  check("mid perk-up still incoming", s.behavior === "incoming");

  // Tick after perk-up → auto-advance to working (no separate working event in MVP).
  s = applyTick(s, t0 + T.PERKUP_MS + 1);
  check("perk-up complete → working", s.behavior === "working");

  // Working holds across a long generation window (60–90s) with no events.
  s = applyTick(s, t0 + 60_000);
  check("holds working through generation window", s.behavior === "working");

  // Terminal event arrives → celebrate.
  s = applyEvent(s, { kind: "complete" }, t0 + 75_000);
  check("complete → celebrating", s.behavior === "celebrating");

  // Celebrate one-shot expires → idle.
  s = applyTick(s, t0 + 75_000 + T.CELEBRATE_MS + 1);
  check("celebrate expires → idle", s.behavior === "idle");
  check("returns to light idle (level 0)", s.idleLevel === 0);
}

// ── 3. ERROR PATH: incoming → working → error(stumble) → idle ───────────────
console.log("\nError path (→ stumbling → idle):");
{
  let s = initialDirectorState(t0);
  s = applyEvent(s, { kind: "message_in" }, t0);
  s = applyTick(s, t0 + T.PERKUP_MS + 1); // → working
  s = applyEvent(s, { kind: "error" }, t0 + 10_000);
  check("error → stumbling", s.behavior === "stumbling");
  s = applyTick(s, t0 + 10_000 + T.STUMBLE_MS + 1);
  check("stumble expires → idle", s.behavior === "idle");
}

// ── 4. INTENSITY + STATION carried by working/tool events ───────────────────
console.log("\nWork intensity + station:");
{
  let s = initialDirectorState(t0);
  s = applyEvent(s, { kind: "working", intensity: 3 }, t0);
  check("working event sets behavior", s.behavior === "working");
  check("intensity captured", s.intensity === 3);
  check("describe reflects deep work", describeBehavior(s) === "Larry is thinking hard");

  s = applyEvent(s, { kind: "tool", station: "trading" }, t0 + 1000);
  check("tool event sets station", s.station === "trading");
  check("describe reflects station", describeBehavior(s) === "Larry is checking the markets");

  // Terminal event clears intensity + station.
  s = applyEvent(s, { kind: "complete" }, t0 + 2000);
  check("complete clears intensity", s.intensity === null);
  check("complete clears station", s.station === null);
}

// ── 5. IDLE ESCALATION (honest rest, not fabricated activity) ───────────────
console.log("\nIdle escalation (breathing → looking → napping):");
{
  let s = initialDirectorState(t0);
  check("starts at idleLevel 0", s.idleLevel === 0);

  s = applyTick(s, t0 + T.IDLE_LOOK_MS - 1);
  check("before LOOK threshold still level 0", s.idleLevel === 0);

  s = applyTick(s, t0 + T.IDLE_LOOK_MS + 1);
  check("crosses LOOK → level 1", s.idleLevel === 1);
  check("escalation does NOT reset since (measured from idle start)", s.since === t0);

  s = applyTick(s, t0 + T.IDLE_NAP_MS + 1);
  check("crosses NAP → level 2", s.idleLevel === 2);
  check("describe says napping", describeBehavior(s) === "Larry is taking a nap");
}

// ── 6. RAPID REPEAT: a second message while mid-perk still pops ──────────────
console.log("\nRapid repeat message_in:");
{
  let s = initialDirectorState(t0);
  s = applyEvent(s, { kind: "message_in" }, t0);
  const firstSeq = s.perkSeq;
  s = applyEvent(s, { kind: "message_in" }, t0 + 200); // before perk-up finishes
  check("still incoming", s.behavior === "incoming");
  check("perkSeq increments again (re-pops)", s.perkSeq === firstSeq + 1);
  check("since re-stamped to latest message", s.since === t0 + 200);
}

// ── 7. WORKING SAFETY TIMEOUT (dropped terminal event) ──────────────────────
console.log("\nWorking safety timeout (dropped completion):");
{
  let s = initialDirectorState(t0);
  s = applyEvent(s, { kind: "working" }, t0);
  s = applyTick(s, t0 + T.WORKING_SAFETY_MS - 1);
  check("before safety timeout still working", s.behavior === "working");
  s = applyTick(s, t0 + T.WORKING_SAFETY_MS + 1);
  check("safety timeout → idle (never stuck typing)", s.behavior === "idle");
}

// ── 8. HEALTH OVERRIDE (v1 contract; asleep/offline supersede) ──────────────
console.log("\nHealth override:");
{
  let s = initialDirectorState(t0);
  s = applyHealth(s, "asleep", t0 + 1000);
  check("health asleep → asleep", s.behavior === "asleep");
  check("asleep needs no animation (GPU rests)", behaviorNeedsAnimation(s) === false);
  // An activity event while asleep still records, but health is re-asserted by
  // the store each tick in v1; here we just verify online wakes it.
  s = applyHealth(s, "online", t0 + 2000);
  check("health online → idle", s.behavior === "idle");
}

// ── 9. RENDER GOVERNOR (behaviorNeedsAnimation) ─────────────────────────────
console.log("\nRender-on-demand governor:");
{
  const work = applyEvent(initialDirectorState(t0), { kind: "working" }, t0);
  check("working needs animation", behaviorNeedsAnimation(work) === true);

  let lightIdle = initialDirectorState(t0);
  check("light idle breathes (needs anim)", behaviorNeedsAnimation(lightIdle) === true);

  let napping = applyTick(lightIdle, t0 + T.IDLE_NAP_MS + 1);
  check("napping is static (no anim → GPU rests)", behaviorNeedsAnimation(napping) === false);
}

// ── 10. PURITY / referential-skip on no-op tick ─────────────────────────────
console.log("\nPurity (no-op tick returns same reference):");
{
  const s = initialDirectorState(t0);
  const same = applyTick(s, t0 + 1); // nothing crosses a threshold
  check("no-op tick returns identical reference (cheap skip)", same === s);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
